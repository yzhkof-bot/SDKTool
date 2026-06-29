/**
 * 蓝盾流水线配置的加载与校验。
 *
 * 配置来源（按优先级）：
 *  1. 环境变量 SDKTOOL_PIPELINES_CONFIG 指定的文件路径
 *  2. 进程 cwd 下的 pipelines.config.json
 *  3. 内置默认配置（与历史硬编码的 smoba 出档流水线一致，保证零配置也能跑）
 *
 * 文件用 JSON5 解析，允许注释/尾逗号，方便人工维护。
 * bkrepo 凭据可被环境变量 BKREPO_USER / BKREPO_TOKEN 覆盖。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import JSON5 from 'json5';

import { defaultArtifactCacheDir } from './artifactCache.js';

/** 制品库下载用的 Basic Auth 凭据（所有流水线共用）。 */
export interface BkRepoCreds {
  user: string;
  token: string;
}

/** 蓝盾制品本地下载缓存的配置。 */
export interface ArtifactCacheConfig {
  /** 缓存目录绝对路径 */
  dir: string;
  /** 缓存上限（字节）；超出按下载先后清理最老的 */
  maxBytes: number;
}

/** 缓存上限默认 20 GiB。 */
const DEFAULT_CACHE_MAX_GIB = 20;
const GiB = 1024 * 1024 * 1024;

/**
 * "配置本地工程"规则：仅当流水线配置了这一块时，前端制品弹窗才出现该按钮。
 * 不同流水线的产物命名/工程结构不同，所以这些都做成可配置项。
 */
export interface LocalProjectRule {
  /** 安装包文件名后缀（小写 endsWith 匹配），如 `il2cpp.shell.hap` */
  hapSuffix: string;
  /** 资源包文件名后缀（小写 endsWith 匹配），如 `il2cpp.zips` */
  zipsSuffix: string;
  /** hap(zip) 内要提取覆盖的目录前缀，如 `resources/rawfile/Data/` */
  hapDataPrefix: string;
  /** 解压后工程内被覆盖的相对目录 */
  projectDataRel: string;
}

/** 单条流水线配置。 */
export interface PipelineConfig {
  /** 唯一标识（接口/前端用） */
  key: string;
  /** 侧栏主标题 */
  label: string;
  /** 侧栏副标题（可选） */
  sublabel?: string;
  projectId: string;
  pipelineId: string;
  /** 该流水线的 bk-ci access_token */
  accessToken: string;
  /** 可选：配置后启用"配置本地工程"能力 */
  localProject?: LocalProjectRule;
}

/** 企业微信智能机器人长连接配置（基于 @wecom/aibot-node-sdk）。 */
export interface WeworkConfig {
  /** 机器人 BotID；为空表示未配置（测试界面会提示去 pipelines.config.json 填）。 */
  botId: string;
  /** 长连接专用 Secret；为空表示未配置。 */
  secret: string;
  /** WebSocket 连接地址，默认公有云 wss://openws.work.weixin.qq.com（私有部署需改）。 */
  wsUrl: string;
  /** 收到文本消息时是否自动 echo 回复（仅供测试界面快速验证收发闭环），默认 true。 */
  autoReply: boolean;
}

/** AI 助手（sagent-sdk → Claude 代理）配置。 */
export interface AiConfig {
  /** Claude 代理 API Key；为空表示未配置（AI 功能不可用）。 */
  apiKey: string;
  /** 接口基础地址（适配器自动拼 /v1/messages）。 */
  baseUrl: string;
  /** 默认模型。 */
  model: string;
  /** 可选：设置后开启扩展思考（budget_tokens，≥1024）。 */
  thinkingBudget?: number;
  /** 上下文自动压缩：模型窗口（token），默认 200000。 */
  contextWindow: number;
  /** 占用超过 contextWindow*threshold 触发压缩，默认 0.8。 */
  compactThreshold: number;
  /** 压缩后保留最近原文占窗口的比例，默认 0.3。 */
  keepRecentRatio: number;
}

export interface DevopsConfig {
  bkrepo: BkRepoCreds;
  /** 制品下载缓存（与流水线配置写在同一文件） */
  artifactCache: ArtifactCacheConfig;
  pipelines: PipelineConfig[];
  /** AI 助手配置（写在同一文件的 ai 段） */
  ai: AiConfig;
  /** 企业微信智能机器人长连接配置（写在同一文件的 wework 段） */
  wework: WeworkConfig;
}

/** AI 配置默认值（apiKey 默认空 → 必须在 pipelines.config.json 的 ai 段里填）。 */
const DEFAULT_AI_BASE_URL = 'http://api.timiai.woa.com/ai_api_manage/llmproxy';
const DEFAULT_AI_MODEL = 'claude-sonnet-4.6';

/** 企业微信长连接默认 WebSocket 地址（公有云）。 */
const DEFAULT_WEWORK_WS_URL = 'wss://openws.work.weixin.qq.com';
const DEFAULT_AI_CONTEXT_WINDOW = 200_000;
const DEFAULT_AI_COMPACT_THRESHOLD = 0.8;
const DEFAULT_AI_KEEP_RECENT_RATIO = 0.3;

/** 内置默认配置（无配置文件时使用）。与历史硬编码值保持一致。 */
const BUILTIN_CONFIG: DevopsConfig = {
  bkrepo: { user: 'windye', token: 'c4c01586a5998023da781f42d963209a' },
  artifactCache: { dir: defaultArtifactCacheDir(), maxBytes: DEFAULT_CACHE_MAX_GIB * GiB },
  ai: {
    apiKey: '',
    baseUrl: DEFAULT_AI_BASE_URL,
    model: DEFAULT_AI_MODEL,
    contextWindow: DEFAULT_AI_CONTEXT_WINDOW,
    compactThreshold: DEFAULT_AI_COMPACT_THRESHOLD,
    keepRecentRatio: DEFAULT_AI_KEEP_RECENT_RATIO,
  },
  wework: { botId: '', secret: '', wsUrl: DEFAULT_WEWORK_WS_URL, autoReply: true },
  pipelines: [
    {
      key: 'smoba-oh',
      label: 'OpenHarmony 出档',
      sublabel: 'smoba',
      projectId: 'smoba',
      pipelineId: 'p-814da33753ef4ef3a960488412a3f44e',
      accessToken: 'gvsgjjTb9qWRfw36bYQDykUgTl3CdH',
      localProject: {
        hapSuffix: 'il2cpp.shell.hap',
        zipsSuffix: 'il2cpp.zips',
        hapDataPrefix: 'resources/rawfile/Data/',
        projectDataRel:
          'Project/TargetOpenHarmony/DevEcoProj/entry/src/main/resources/rawfile/Data',
      },
    },
  ],
};

/** 配置文件解析/校验失败时抛出，便于启动时给出清晰报错。 */
export class DevopsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevopsConfigError';
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function reqStr(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new DevopsConfigError(`${where}.${key} 必须是非空字符串`);
  }
  return v;
}

function optStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function parseLocalProject(raw: unknown, where: string): LocalProjectRule | undefined {
  if (raw == null) return undefined;
  const o = asRecord(raw);
  return {
    hapSuffix: reqStr(o, 'hapSuffix', where),
    zipsSuffix: reqStr(o, 'zipsSuffix', where),
    hapDataPrefix: reqStr(o, 'hapDataPrefix', where),
    projectDataRel: reqStr(o, 'projectDataRel', where),
  };
}

/** 展开 `~` / `~/...` 为用户主目录（配置文件里手写路径常用 ~）。 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * 解析 artifactCache 配置块（整块可省略，缺字段各自取默认）。
 *  - dir：默认 ~/.kingsdk/artifact-cache；可被环境变量 SDKTOOL_ARTIFACT_CACHE_DIR 覆盖
 *  - maxGiB：默认 20；可被环境变量 SDKTOOL_ARTIFACT_CACHE_MAX_GIB 覆盖；非正数回退默认
 */
function parseArtifactCache(raw: unknown): ArtifactCacheConfig {
  const o = asRecord(raw);

  const envDir = process.env.SDKTOOL_ARTIFACT_CACHE_DIR;
  const dirRaw =
    envDir && envDir.trim()
      ? envDir.trim()
      : typeof o.dir === 'string' && o.dir.trim()
        ? o.dir.trim()
        : '';
  const dir = dirRaw ? resolvePath(expandHome(dirRaw)) : defaultArtifactCacheDir();

  const envMax = process.env.SDKTOOL_ARTIFACT_CACHE_MAX_GIB;
  const maxGiBRaw =
    envMax && envMax.trim()
      ? Number(envMax)
      : typeof o.maxGiB === 'number'
        ? o.maxGiB
        : DEFAULT_CACHE_MAX_GIB;
  const maxGiB = Number.isFinite(maxGiBRaw) && maxGiBRaw > 0 ? maxGiBRaw : DEFAULT_CACHE_MAX_GIB;

  return { dir, maxBytes: Math.floor(maxGiB * GiB) };
}

/** 取正数配置项，非法/缺省时回退默认。 */
function numOr(o: Record<string, unknown>, key: string, fallback: number, min = 0): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) && v > min ? v : fallback;
}

/** 解析 ai 配置块（整块可省略，缺字段取默认；apiKey 缺省为空表示未配置）。 */
function parseAi(raw: unknown): AiConfig {
  const o = asRecord(raw);
  const budget = typeof o.thinkingBudget === 'number' ? o.thinkingBudget : undefined;
  return {
    apiKey: optStr(o, 'apiKey') ?? '',
    baseUrl: optStr(o, 'baseUrl') ?? DEFAULT_AI_BASE_URL,
    model: optStr(o, 'model') ?? DEFAULT_AI_MODEL,
    ...(budget && Number.isFinite(budget) && budget >= 1024 ? { thinkingBudget: budget } : {}),
    contextWindow: numOr(o, 'contextWindow', DEFAULT_AI_CONTEXT_WINDOW, 0),
    compactThreshold: numOr(o, 'compactThreshold', DEFAULT_AI_COMPACT_THRESHOLD, 0),
    keepRecentRatio: numOr(o, 'keepRecentRatio', DEFAULT_AI_KEEP_RECENT_RATIO, 0),
  };
}

/**
 * 解析 wework 配置块（整块可省略，缺字段取默认）。
 *  - botId / secret 缺省为空，表示未配置（测试界面据此提示）
 *  - wsUrl 缺省公有云地址；可被环境变量 SDKTOOL_WEWORK_WS_URL 覆盖
 *  - botId / secret 也可被环境变量 SDKTOOL_WEWORK_BOT_ID / SDKTOOL_WEWORK_SECRET 覆盖
 *  - autoReply 缺省 true；显式 false 关闭自动 echo 回复
 */
function parseWework(raw: unknown): WeworkConfig {
  const o = asRecord(raw);
  const envBotId = process.env.SDKTOOL_WEWORK_BOT_ID;
  const envSecret = process.env.SDKTOOL_WEWORK_SECRET;
  const envWsUrl = process.env.SDKTOOL_WEWORK_WS_URL;
  return {
    botId: (envBotId && envBotId.trim()) || optStr(o, 'botId') || '',
    secret: (envSecret && envSecret.trim()) || optStr(o, 'secret') || '',
    wsUrl: (envWsUrl && envWsUrl.trim()) || optStr(o, 'wsUrl') || DEFAULT_WEWORK_WS_URL,
    autoReply: typeof o.autoReply === 'boolean' ? o.autoReply : true,
  };
}

function parseConfig(raw: unknown): DevopsConfig {
  const root = asRecord(raw);
  const bkRaw = asRecord(root.bkrepo);
  const bkrepo: BkRepoCreds = {
    user: process.env.BKREPO_USER || reqStr(bkRaw, 'user', 'bkrepo'),
    token: process.env.BKREPO_TOKEN || reqStr(bkRaw, 'token', 'bkrepo'),
  };
  const artifactCache = parseArtifactCache(root.artifactCache);
  const ai = parseAi(root.ai);
  const wework = parseWework(root.wework);

  const list = root.pipelines;
  if (!Array.isArray(list) || list.length === 0) {
    throw new DevopsConfigError('pipelines 必须是非空数组');
  }
  const seen = new Set<string>();
  const pipelines: PipelineConfig[] = list.map((item, i) => {
    const where = `pipelines[${i}]`;
    const o = asRecord(item);
    const key = reqStr(o, 'key', where);
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new DevopsConfigError(`${where}.key 只能含字母数字与 - _：${key}`);
    }
    if (seen.has(key)) throw new DevopsConfigError(`流水线 key 重复：${key}`);
    seen.add(key);
    return {
      key,
      label: reqStr(o, 'label', where),
      sublabel: optStr(o, 'sublabel'),
      projectId: reqStr(o, 'projectId', where),
      pipelineId: reqStr(o, 'pipelineId', where),
      accessToken: reqStr(o, 'accessToken', where),
      localProject: parseLocalProject(o.localProject, `${where}.localProject`),
    };
  });

  return { bkrepo, artifactCache, pipelines, ai, wework };
}

/** 解析配置文件路径：env 覆盖 > cwd/pipelines.config.json。返回 null 表示用内置默认。 */
function resolveConfigPath(): string | null {
  const envPath = process.env.SDKTOOL_PIPELINES_CONFIG;
  if (envPath && envPath.trim()) return resolvePath(envPath.trim());
  const cwdPath = resolvePath(process.cwd(), 'pipelines.config.json');
  return existsSync(cwdPath) ? cwdPath : null;
}

let cached: DevopsConfig | null = null;

/**
 * 加载（并缓存）蓝盾配置。找不到文件时退回内置默认（仍套用 env 覆盖 bkrepo）。
 * 文件存在但解析/校验失败时抛 DevopsConfigError（不静默吞掉，避免配错却以为生效）。
 */
export function loadDevopsConfig(): DevopsConfig {
  if (cached) return cached;
  const path = resolveConfigPath();
  if (!path) {
    cached = parseConfig(BUILTIN_CONFIG);
    return cached;
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new DevopsConfigError(`读取配置文件失败 ${path}：${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON5.parse(text);
  } catch (e) {
    throw new DevopsConfigError(`配置文件不是合法 JSON5 ${path}：${(e as Error).message}`);
  }
  cached = parseConfig(parsed);
  return cached;
}
