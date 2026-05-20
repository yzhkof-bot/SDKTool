import type {
  Analyzer,
  AnalyzerContext,
  HapBasicInfo,
  HapReport,
} from '../../shared/schema.js';
import { isRecord, toStringArray } from '../../shared/utils.js';

import { readModuleJson, readPackInfo } from './_shared.js';

/**
 * 解析 module.json5 / module.json / config.json + pack.info
 *
 * 容错策略：
 * - 任意字段缺失 → 用安全默认值 + 一条 warn
 * - 配置文件缺失 → 一条 error 级 warning，但不抛异常
 * - 字段类型不匹配 → 退化为默认值 + warn
 */
export const basicInfoAnalyzer: Analyzer = {
  id: 'basic',
  name: 'Basic Info',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<HapReport>> {
    const { value: moduleJson } = await readModuleJson(ctx);
    const { value: packInfo } = await readPackInfo(ctx);

    if (moduleJson === undefined) {
      ctx.addWarning({
        code: 'MODULE_JSON_NOT_FOUND',
        level: 'error',
        message: '未在 hap 内找到 module.json/module.json5/config.json，basic 信息将为空',
      });
      return {};
    }

    const basic = extractBasicInfo(moduleJson, ctx);
    basic.rawModuleJson = moduleJson;
    if (packInfo !== undefined) {
      basic.rawPackInfo = packInfo;
    }
    return { basic };
  },
};

/* ------------------------------------------------------------------ */

function extractBasicInfo(moduleJson: unknown, ctx: AnalyzerContext): HapBasicInfo {
  const root = isRecord(moduleJson) ? moduleJson : {};
  const app = isRecord(root.app) ? root.app : {};
  const moduleObj = isRecord(root.module) ? root.module : {};

  const bundleName = readString(app.bundleName, '');
  const versionCode = readNumber(app.versionCode, 0);
  const versionName = readString(app.versionName, '');
  const bundleType = readOptionalString(app.bundleType);

  const moduleName = readString(moduleObj.name, '');
  const moduleType = readString(moduleObj.type, 'unknown');
  const deviceTypes = toStringArray(moduleObj.deviceTypes);
  const targetAPIVersion = readOptionalNumber(app.targetAPIVersion);
  const minAPIVersion = readOptionalNumber(app.minAPIVersion);

  const abilities = readAbilities(moduleObj.abilities);

  if (!bundleName) {
    ctx.addWarning({
      code: 'MISSING_BUNDLE_NAME',
      level: 'warn',
      message: 'app.bundleName 缺失或非字符串',
    });
  }
  if (!moduleName) {
    ctx.addWarning({
      code: 'MISSING_MODULE_NAME',
      level: 'warn',
      message: 'module.name 缺失或非字符串',
    });
  }

  return {
    bundleName,
    bundleType,
    versionCode,
    versionName,
    moduleName,
    moduleType,
    deviceTypes,
    targetAPIVersion,
    minAPIVersion,
    abilities,
  };
}

function readAbilities(input: unknown): HapBasicInfo['abilities'] {
  if (!Array.isArray(input)) return [];
  const out: HapBasicInfo['abilities'] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const name = readOptionalString(item.name);
    if (!name) continue;
    out.push({
      name,
      type: readOptionalString(item.type),
      visible: typeof item.visible === 'boolean' ? item.visible : undefined,
    });
  }
  return out;
}

function readString(input: unknown, fallback: string): string {
  return typeof input === 'string' ? input : fallback;
}

function readOptionalString(input: unknown): string | undefined {
  return typeof input === 'string' && input.length > 0 ? input : undefined;
}

function readNumber(input: unknown, fallback: number): number {
  return typeof input === 'number' && Number.isFinite(input) ? input : fallback;
}

function readOptionalNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}
