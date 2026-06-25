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
import { resolve as resolvePath } from 'node:path';

import JSON5 from 'json5';

/** 制品库下载用的 Basic Auth 凭据（所有流水线共用）。 */
export interface BkRepoCreds {
  user: string;
  token: string;
}

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

export interface DevopsConfig {
  bkrepo: BkRepoCreds;
  pipelines: PipelineConfig[];
}

/** 内置默认配置（无配置文件时使用）。与历史硬编码值保持一致。 */
const BUILTIN_CONFIG: DevopsConfig = {
  bkrepo: { user: 'windye', token: 'c4c01586a5998023da781f42d963209a' },
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

function parseConfig(raw: unknown): DevopsConfig {
  const root = asRecord(raw);
  const bkRaw = asRecord(root.bkrepo);
  const bkrepo: BkRepoCreds = {
    user: process.env.BKREPO_USER || reqStr(bkRaw, 'user', 'bkrepo'),
    token: process.env.BKREPO_TOKEN || reqStr(bkRaw, 'token', 'bkrepo'),
  };

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

  return { bkrepo, pipelines };
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
