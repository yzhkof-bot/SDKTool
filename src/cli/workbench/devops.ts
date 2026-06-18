/**
 * 蓝盾（BlueShield / BK-CI）制品接口的服务端代理。
 *
 * 为什么要后端代理而不是浏览器直连：
 *  - 接口需要 `X-Bkapi-Authorization` 鉴权头，access_token 不能暴露给前端 JS；
 *  - devops.apigw.o.woa.com 不会给本地页面发 CORS 头，浏览器 fetch 会被拦。
 * 所以页面只调本地 /api/devops/*，由本模块带着 token 去请求上游。
 *
 * 参考实现：artifact_client.py（list-builds 走 v4，list-artifacts 走 v3）。
 */

/** v4：构建历史接口 */
const BASE_URL_V4 = 'https://devops.apigw.o.woa.com/prod/v4/apigw-user';
/** v3：制品相关接口 */
const BASE_URL_V3 = 'https://devops.apigw.o.woa.com/prod/v3/apigw-user';

/**
 * 固定配置：当前只接这一条 OpenHarmony 出档流水线（smoba）。
 * token 直接内联（用户确认硬编码文档里的值）；过期后到
 * https://iwiki.woa.com/p/4009265804 重新获取并替换这里即可。
 */
export const DEVOPS_PROJECT_ID = 'smoba';
export const DEVOPS_PIPELINE_ID = 'p-814da33753ef4ef3a960488412a3f44e';
const DEVOPS_ACCESS_TOKEN = 'gvsgjjTb9qWRfw36bYQDykUgTl3CdH';

const REQUEST_TIMEOUT_MS = 30_000;

/** 上游接口失败时抛出，带 HTTP 状态码方便路由层映射。 */
export class DevopsError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 502,
  ) {
    super(message);
    this.name = 'DevopsError';
  }
}

export interface DevopsBuild {
  buildId: string;
  buildNum: number | null;
  status: string;
  userId: string;
  trigger: string;
  startTime: number | null;
  endTime: number | null;
}

export interface DevopsBuildsResult {
  total: number;
  page: number;
  pageSize: number;
  builds: DevopsBuild[];
}

export interface DevopsArtifact {
  name: string;
  path: string;
  size: number | null;
  artifactoryType: string;
}

/** 合法的构建状态过滤值，与 artifact_client.py 的 choices 对齐。 */
export const DEVOPS_BUILD_STATUSES = [
  'SUCCEED',
  'FAILED',
  'CANCELED',
  'RUNNING',
  'QUEUE',
  'STAGE_SUCCESS',
] as const;
export type DevopsBuildStatus = (typeof DEVOPS_BUILD_STATUSES)[number];

const AUTH_HEADER = JSON.stringify({ access_token: DEVOPS_ACCESS_TOKEN });

/** 带超时的 fetch，返回已解析的 JSON；上游非 2xx / 非 JSON 都转成 DevopsError。 */
async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: ctrl.signal });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'AbortError' ? '上游请求超时' : String((e as Error)?.message ?? e);
    throw new DevopsError(`请求蓝盾接口失败：${reason}`, 504);
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new DevopsError(`蓝盾接口返回 HTTP ${resp.status}：${text.slice(0, 300)}`, 502);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DevopsError(`蓝盾接口返回非 JSON：${text.slice(0, 200)}`, 502);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function toNumberOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

/** 拉构建历史（v4）。token 放 X-Bkapi-Authorization header。 */
export async function listBuilds(opts: {
  page?: number;
  pageSize?: number;
  status?: DevopsBuildStatus;
}): Promise<DevopsBuildsResult> {
  const page = opts.page && opts.page > 0 ? Math.floor(opts.page) : 1;
  const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.min(Math.floor(opts.pageSize), 100) : 20;
  const params = new URLSearchParams({
    pipelineId: DEVOPS_PIPELINE_ID,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (opts.status) params.set('status', opts.status);
  const url = `${BASE_URL_V4}/projects/${DEVOPS_PROJECT_ID}/build_histories?${params.toString()}`;

  const result = asRecord(await fetchJson(url, { 'X-Bkapi-Authorization': AUTH_HEADER }));
  if (toNumberOrNull(result.status) !== 0) {
    throw new DevopsError(`蓝盾接口业务错误：${toStr(result.message, JSON.stringify(result).slice(0, 200))}`, 502);
  }
  const data = asRecord(result.data);
  const records = Array.isArray(data.records) ? data.records : [];
  const builds: DevopsBuild[] = records.map((raw) => {
    const r = asRecord(raw);
    return {
      buildId: toStr(r.id),
      buildNum: toNumberOrNull(r.buildNum),
      status: toStr(r.status, '-'),
      userId: toStr(r.userId, '-'),
      trigger: toStr(r.trigger, '-'),
      startTime: toNumberOrNull(r.startTime),
      endTime: toNumberOrNull(r.endTime),
    };
  });
  return { total: toNumberOrNull(data.count) ?? builds.length, page, pageSize, builds };
}

/**
 * BkRepo 制品库下载配置。
 *
 * 关键点（踩坑记录）：
 *  - apigw 的 `userDownloadUrl` 返回的是 `devops.woa.com/bkrepo/...` 链接，但它走**网页 SSO**，
 *    CLI/服务端无登录态会被 302 到 passport，只能拿到登录页 HTML（约 2KiB），不是文件。
 *  - 正确做法：直连 `dl.bkrepo.woa.com/generic/{project}/{pipeline|custom}/{path}`，
 *    用 **Basic Auth（用户名 : BKREPO_TOKEN）** + `X-BKREPO-ACCESS-FROM: api` 头。
 *  - BKREPO_TOKEN 与 bk-ci 的 access_token 是两套东西：前者在「蓝盾 → 服务 → 制品库 →
 *    个人中心 → 申请 Token」获取；过期后在那里重新申请并替换这里（或用环境变量覆盖）。
 *
 * 可用环境变量覆盖：BKREPO_USER / BKREPO_TOKEN。
 */
const BKREPO_DL_BASE = 'https://dl.bkrepo.woa.com/generic';
const BKREPO_USER = process.env.BKREPO_USER || 'windye';
const BKREPO_TOKEN = process.env.BKREPO_TOKEN || 'c4c01586a5998023da781f42d963209a';

export interface ArtifactDownload {
  url: string;
  headers: Record<string, string>;
}

/**
 * 构造制品的 BkRepo 直链 + 鉴权头（不发起网络请求）。
 *
 * artifact.path 形如 `/p-xxx/b-xxx/<file>`；project 用固定的 DEVOPS_PROJECT_ID，
 * repo 由 artifactoryType 映射（PIPELINE→pipeline，其它→custom）。
 */
export function getArtifactDownload(artifact: Pick<DevopsArtifact, 'path' | 'artifactoryType'>): ArtifactDownload {
  const p = (artifact.path ?? '').trim();
  if (!p) throw new DevopsError('缺少制品 path', 400);
  const repo = artifact.artifactoryType === 'CUSTOM_DIR' ? 'custom' : 'pipeline';
  // 去掉开头斜杠后逐段编码（保留 /），文件名一般是 ASCII，但稳妥处理空格等特殊字符
  const fullPath = p
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const url = `${BKREPO_DL_BASE}/${DEVOPS_PROJECT_ID}/${repo}/${fullPath}`;
  const basic = Buffer.from(`${BKREPO_USER}:${BKREPO_TOKEN}`).toString('base64');
  return {
    url,
    headers: {
      Authorization: `Basic ${basic}`,
      'X-BKREPO-ACCESS-FROM': 'api',
    },
  };
}

/**
 * 从一组制品里精确挑出"配置本地工程"需要的两个产物：
 *  - shell hap：文件名以 `il2cpp.shell.hap` 结尾（中间版本号动态，排除 `_tg` / `_Test_tg` / `_unsig...` 等变体）
 *  - 资源 zips：文件名以 `il2cpp.zips` 结尾（排除 `il2cppIL2CPP-GameCore.symbols.zip` 这类）
 *
 * 用 endsWith 而非 includes：所有变体后缀（_tg / _Test_tg / _unsig... / .symbols.zip 等）
 * 都加在 `il2cpp` 之后，endsWith 能稳定区分出"无额外后缀"的基础产物。
 */
export function selectIl2cppArtifacts(artifacts: DevopsArtifact[]): {
  hap?: DevopsArtifact;
  zips?: DevopsArtifact;
} {
  const hap = artifacts.find((a) => a.name.toLowerCase().endsWith('il2cpp.shell.hap'));
  const zips = artifacts.find((a) => a.name.toLowerCase().endsWith('il2cpp.zips'));
  return { hap, zips };
}

/** 单页拉取上限。蓝盾网关不传 pageSize 时默认每页 20，会截断列表，所以必须显式传大值。 */
const ARTIFACT_PAGE_SIZE = 1000;
/** 翻页兜底上限，防止上游 totalPages 异常导致死循环。 */
const ARTIFACT_MAX_PAGES = 50;

/**
 * 拉某次构建的制品列表（v3）。token 放 query string。
 *
 * 全量返回：上游默认每页 20 条（即便文档写"不传默认全部返回"），不翻页会丢产物——
 * 例如 `*il2cpp.zips` 排在第 50+ 位时会被截断。这里按 totalPages 翻页拉全，
 * 符合项目"analyzer/接口默认输出全量、不截断"的约定。
 */
export async function listArtifacts(buildId: string): Promise<DevopsArtifact[]> {
  const id = buildId.trim();
  if (!id) throw new DevopsError('缺少 buildId', 400);

  const out: DevopsArtifact[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const params = new URLSearchParams({
      access_token: DEVOPS_ACCESS_TOKEN,
      pipelineId: DEVOPS_PIPELINE_ID,
      buildId: id,
      page: String(page),
      pageSize: String(ARTIFACT_PAGE_SIZE),
    });
    const url = `${BASE_URL_V3}/projects/${DEVOPS_PROJECT_ID}/artifactories?${params.toString()}`;

    const result = asRecord(await fetchJson(url));
    if (toNumberOrNull(result.status) !== 0) {
      throw new DevopsError(`蓝盾接口业务错误：${toStr(result.message, JSON.stringify(result).slice(0, 200))}`, 502);
    }
    const data = result.data;
    const files: unknown[] = Array.isArray(data)
      ? data
      : (() => {
          const d = asRecord(data);
          const list = d.records ?? d.artifactList ?? d.fileList;
          return Array.isArray(list) ? list : [];
        })();
    for (const raw of files) {
      const f = asRecord(raw);
      out.push({
        name: toStr(f.name ?? f.artifactName, '-'),
        path: toStr(f.path ?? f.artifactPath, '-'),
        size: toNumberOrNull(f.size ?? f.fileSize),
        artifactoryType: toStr(f.artifactoryType ?? f.repoType, 'PIPELINE'),
      });
    }

    // 计算总页数：优先用上游 totalPages，否则按 count/pageSize 推算；都没有就停在第一页。
    if (!Array.isArray(data)) {
      const d = asRecord(data);
      const tp = toNumberOrNull(d.totalPages);
      if (tp != null && tp > 0) {
        totalPages = tp;
      } else {
        const count = toNumberOrNull(d.count);
        const ps = toNumberOrNull(d.pageSize) ?? ARTIFACT_PAGE_SIZE;
        totalPages = count != null && ps > 0 ? Math.ceil(count / ps) : 1;
      }
    } else {
      totalPages = 1; // data 直接是数组（无分页元信息）→ 认为已全量
    }
    page++;
  } while (page <= totalPages && page <= ARTIFACT_MAX_PAGES);

  return out;
}
