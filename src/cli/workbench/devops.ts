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

/** 拉某次构建的制品列表（v3）。token 放 query string。 */
export async function listArtifacts(buildId: string): Promise<DevopsArtifact[]> {
  const id = buildId.trim();
  if (!id) throw new DevopsError('缺少 buildId', 400);
  const params = new URLSearchParams({
    access_token: DEVOPS_ACCESS_TOKEN,
    pipelineId: DEVOPS_PIPELINE_ID,
    buildId: id,
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
  return files.map((raw) => {
    const f = asRecord(raw);
    return {
      name: toStr(f.name ?? f.artifactName, '-'),
      path: toStr(f.path ?? f.artifactPath, '-'),
      size: toNumberOrNull(f.size ?? f.fileSize),
      artifactoryType: toStr(f.artifactoryType ?? f.repoType, 'PIPELINE'),
    };
  });
}
