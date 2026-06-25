/**
 * 蓝盾（BlueShield / BK-CI）制品接口的服务端代理组件。
 *
 * 为什么要后端代理而不是浏览器直连：
 *  - 接口需要 `X-Bkapi-Authorization` 鉴权头，access_token 不能暴露给前端 JS；
 *  - devops.apigw.o.woa.com 不会给本地页面发 CORS 头，浏览器 fetch 会被拦。
 * 所以页面只调本地 /api/devops/*，由本模块带着 token 去请求上游。
 *
 * 多流水线支持：
 *  - `DevopsClient` 为「单条流水线」的客户端，所有上游参数（projectId/pipelineId/
 *    token/bkrepo 凭据）由构造时传入的 PipelineConfig 决定，不再有模块级硬编码。
 *  - `DevopsRegistry` 按 key 管理多条流水线的 client，供路由层按需取用。
 *  - 流水线清单来自 `pipelines.config.json`（见 devopsConfig.ts）。
 *
 * 参考实现：artifact_client.py（list-builds 走 v4，list-artifacts 走 v3）。
 */

import {
  loadDevopsConfig,
  type BkRepoCreds,
  type DevopsConfig,
  type LocalProjectRule,
  type PipelineConfig,
} from './devopsConfig.js';

/** v4：构建历史接口 */
const BASE_URL_V4 = 'https://devops.apigw.o.woa.com/prod/v4/apigw-user';
/** v3：制品相关接口 */
const BASE_URL_V3 = 'https://devops.apigw.o.woa.com/prod/v3/apigw-user';
/** BkRepo 制品库直链前缀 */
const BKREPO_DL_BASE = 'https://dl.bkrepo.woa.com/generic';

const REQUEST_TIMEOUT_MS = 30_000;
/** 单页拉取上限。蓝盾网关不传 pageSize 时默认每页 20，会截断列表，所以必须显式传大值。 */
const ARTIFACT_PAGE_SIZE = 1000;
/** 翻页兜底上限，防止上游 totalPages 异常导致死循环。 */
const ARTIFACT_MAX_PAGES = 50;

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

export interface ArtifactDownload {
  url: string;
  headers: Record<string, string>;
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

/* -------------------------------------------------------------------------- */
/* 通用工具                                                                    */
/* -------------------------------------------------------------------------- */

/** 带超时的 fetch，返回已解析的 JSON；上游非 2xx / 非 JSON 都转成 DevopsError。 */
async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: ctrl.signal });
  } catch (e) {
    const reason =
      e instanceof Error && e.name === 'AbortError'
        ? '上游请求超时'
        : String((e as Error)?.message ?? e);
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

/* -------------------------------------------------------------------------- */
/* 单条流水线客户端                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 单条蓝盾流水线的客户端：封装该流水线的构建历史、制品列表、制品下载直链构造，
 * 以及（可选的）"配置本地工程"产物匹配。所有上游参数来自构造传入的 PipelineConfig。
 */
export class DevopsClient {
  private readonly authHeader: string;

  constructor(
    readonly pipeline: PipelineConfig,
    private readonly bkrepo: BkRepoCreds,
  ) {
    this.authHeader = JSON.stringify({ access_token: pipeline.accessToken });
  }

  get key(): string {
    return this.pipeline.key;
  }

  /** 拉构建历史（v4）。token 放 X-Bkapi-Authorization header。 */
  async listBuilds(opts: {
    page?: number;
    pageSize?: number;
    status?: DevopsBuildStatus;
  }): Promise<DevopsBuildsResult> {
    const page = opts.page && opts.page > 0 ? Math.floor(opts.page) : 1;
    const pageSize =
      opts.pageSize && opts.pageSize > 0 ? Math.min(Math.floor(opts.pageSize), 100) : 20;
    const params = new URLSearchParams({
      pipelineId: this.pipeline.pipelineId,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (opts.status) params.set('status', opts.status);
    const url = `${BASE_URL_V4}/projects/${this.pipeline.projectId}/build_histories?${params.toString()}`;

    const result = asRecord(await fetchJson(url, { 'X-Bkapi-Authorization': this.authHeader }));
    if (toNumberOrNull(result.status) !== 0) {
      throw new DevopsError(
        `蓝盾接口业务错误：${toStr(result.message, JSON.stringify(result).slice(0, 200))}`,
        502,
      );
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
   * 拉某次构建的制品列表（v3）。token 放 query string。
   *
   * 全量返回：上游默认每页 20 条（即便文档写"不传默认全部返回"），不翻页会丢产物——
   * 例如 `*il2cpp.zips` 排在第 50+ 位时会被截断。这里按 totalPages 翻页拉全，
   * 符合项目"analyzer/接口默认输出全量、不截断"的约定。
   */
  async listArtifacts(buildId: string): Promise<DevopsArtifact[]> {
    const id = buildId.trim();
    if (!id) throw new DevopsError('缺少 buildId', 400);

    const out: DevopsArtifact[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const params = new URLSearchParams({
        access_token: this.pipeline.accessToken,
        pipelineId: this.pipeline.pipelineId,
        buildId: id,
        page: String(page),
        pageSize: String(ARTIFACT_PAGE_SIZE),
      });
      const url = `${BASE_URL_V3}/projects/${this.pipeline.projectId}/artifactories?${params.toString()}`;

      const result = asRecord(await fetchJson(url));
      if (toNumberOrNull(result.status) !== 0) {
        throw new DevopsError(
          `蓝盾接口业务错误：${toStr(result.message, JSON.stringify(result).slice(0, 200))}`,
          502,
        );
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

  /**
   * 构造制品的 BkRepo 直链 + 鉴权头（不发起网络请求）。
   *
   * 关键点（踩坑记录）：
   *  - apigw 的 `userDownloadUrl` 返回 `devops.woa.com/bkrepo/...`，但它走网页 SSO，
   *    CLI/服务端无登录态会被 302 到 passport，只能拿到登录页 HTML，不是文件。
   *  - 正确做法：直连 `dl.bkrepo.woa.com/generic/{project}/{pipeline|custom}/{path}`，
   *    用 Basic Auth（用户名 : BKREPO_TOKEN）+ `X-BKREPO-ACCESS-FROM: api` 头。
   *  - BKREPO_TOKEN 与 bk-ci 的 access_token 是两套东西（前者在制品库个人中心申请）。
   *
   * artifact.path 形如 `/p-xxx/b-xxx/<file>`；repo 由 artifactoryType 映射
   * （CUSTOM_DIR→custom，其它→pipeline）。
   */
  getArtifactDownload(
    artifact: Pick<DevopsArtifact, 'path' | 'artifactoryType'>,
  ): ArtifactDownload {
    const p = (artifact.path ?? '').trim();
    if (!p) throw new DevopsError('缺少制品 path', 400);
    const repo = artifact.artifactoryType === 'CUSTOM_DIR' ? 'custom' : 'pipeline';
    // 去掉开头斜杠后逐段编码（保留 /），稳妥处理空格等特殊字符
    const fullPath = p
      .replace(/^\/+/, '')
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const url = `${BKREPO_DL_BASE}/${this.pipeline.projectId}/${repo}/${fullPath}`;
    const basic = Buffer.from(`${this.bkrepo.user}:${this.bkrepo.token}`).toString('base64');
    return {
      url,
      headers: {
        Authorization: `Basic ${basic}`,
        'X-BKREPO-ACCESS-FROM': 'api',
      },
    };
  }

  /** 该流水线的"配置本地工程"规则；未配置返回 undefined。 */
  get localProjectRule(): LocalProjectRule | undefined {
    return this.pipeline.localProject;
  }

  /**
   * 按本流水线的 localProject 规则，从一组制品里精确挑出"配置本地工程"需要的两个产物：
   *  - hap：文件名以 rule.hapSuffix 结尾
   *  - zips：文件名以 rule.zipsSuffix 结尾
   *
   * 用 endsWith 而非 includes：各种变体后缀（_tg / _Test_tg / .symbols.zip 等）都加在
   * 基础名之后，endsWith 能稳定区分出"无额外后缀"的基础产物。未配置 localProject 时返回空。
   */
  selectLocalProjectArtifacts(artifacts: DevopsArtifact[]): {
    hap?: DevopsArtifact;
    zips?: DevopsArtifact;
  } {
    const rule = this.pipeline.localProject;
    if (!rule) return {};
    const hapSuffix = rule.hapSuffix.toLowerCase();
    const zipsSuffix = rule.zipsSuffix.toLowerCase();
    const hap = artifacts.find((a) => a.name.toLowerCase().endsWith(hapSuffix));
    const zips = artifacts.find((a) => a.name.toLowerCase().endsWith(zipsSuffix));
    return { hap, zips };
  }
}

/* -------------------------------------------------------------------------- */
/* 多流水线注册表                                                              */
/* -------------------------------------------------------------------------- */

/** 给前端的流水线摘要（不含 token 等敏感信息）。 */
export interface PipelineSummary {
  key: string;
  label: string;
  sublabel?: string;
  /** 是否支持"配置本地工程" */
  hasLocalProject: boolean;
  /** 支持时给出产物匹配后缀，前端据此识别/展示要下载的产物名 */
  localProject?: { hapSuffix: string; zipsSuffix: string };
}

/**
 * 多流水线注册表：从配置构建一组 DevopsClient，按 key 取用。
 * 第一条流水线为默认（前端未指定 pipeline 时使用）。
 */
export class DevopsRegistry {
  private readonly clients = new Map<string, DevopsClient>();
  readonly defaultKey: string;

  constructor(config: DevopsConfig) {
    for (const p of config.pipelines) {
      this.clients.set(p.key, new DevopsClient(p, config.bkrepo));
    }
    this.defaultKey = config.pipelines[0]!.key;
  }

  /** 前端列表用：流水线摘要（不暴露 token）。 */
  listPipelines(): PipelineSummary[] {
    return [...this.clients.values()].map((c) => {
      const lp = c.pipeline.localProject;
      return {
        key: c.pipeline.key,
        label: c.pipeline.label,
        sublabel: c.pipeline.sublabel,
        hasLocalProject: !!lp,
        localProject: lp ? { hapSuffix: lp.hapSuffix, zipsSuffix: lp.zipsSuffix } : undefined,
      };
    });
  }

  /** 取指定 key 的 client；key 为空用默认；找不到抛 404 DevopsError。 */
  getClient(key?: string | null): DevopsClient {
    const k = key && key.trim() ? key.trim() : this.defaultKey;
    const c = this.clients.get(k);
    if (!c) throw new DevopsError(`未知流水线：${k}`, 404);
    return c;
  }
}

/** 加载配置并构建注册表（配置本身在 devopsConfig 内缓存）。 */
export function loadDevopsRegistry(): DevopsRegistry {
  return new DevopsRegistry(loadDevopsConfig());
}
