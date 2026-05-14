import type {
  Analyzer,
  AnalyzerContext,
  HapDependenciesInfo,
  HapReport,
} from '../../shared/schema.js';
import { isRecord } from '../../shared/utils.js';

import { readModuleJson, readPackInfo } from './_shared.js';

/**
 * 依赖分析：识别 hap 引用的 HSP / HAR 模块。
 *
 * HarmonyOS 中 module.json.module.dependencies 形如：
 *   "dependencies": [
 *     { "bundleName": "com.example.lib", "moduleName": "library", "versionCode": 100 }
 *   ]
 *
 * HSP / HAR 类型信息严格说在 pack.info.summary.modules[*].type 里：
 *  - "shared" = HSP（动态共享包，运行时加载）
 *  - "har"    = HAR（静态归档，编译期合入）
 *
 * 单 hap 包通常只能拿到自己的 module.json，没法直接得知依赖项的实际类型；
 * 这种情况下我们把所有依赖归入 hsp，并在 warnings 里标注信息丢失。
 *
 * 当 pack.info 存在（多模块 .app pack）时，按 modules[].type 精确分类。
 */
export const dependencyAnalyzer: Analyzer = {
  id: 'dependency',
  name: 'Dependency',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<HapReport>> {
    const { value: moduleJson } = await readModuleJson(ctx);
    const { value: packInfo } = await readPackInfo(ctx);

    const deps: HapDependenciesInfo = { hsp: [], har: [] };

    if (moduleJson === undefined) {
      return { dependencies: deps };
    }

    const rawDeps = pickDependencies(moduleJson);
    if (rawDeps && rawDeps.length > 0) {
      deps.raw = rawDeps;
    }

    const moduleTypeMap = buildModuleTypeMap(packInfo);
    const hasTypeMap = moduleTypeMap.size > 0;
    let unknownTyped = 0;

    for (const dep of rawDeps ?? []) {
      const id = formatDepId(dep);
      if (!id) continue;
      const moduleName = readDepModuleName(dep);
      const explicitType = moduleName ? moduleTypeMap.get(moduleName) : undefined;
      if (explicitType === 'har') {
        deps.har.push(id);
      } else if (explicitType === 'shared') {
        deps.hsp.push(id);
      } else {
        deps.hsp.push(id);
        if (!hasTypeMap) unknownTyped += 1;
      }
    }

    deps.hsp = unique(deps.hsp).sort();
    deps.har = unique(deps.har).sort();

    if (unknownTyped > 0) {
      ctx.addWarning({
        code: 'DEPENDENCY_TYPE_UNKNOWN',
        level: 'info',
        message: `未读取到 pack.info，无法精确区分 HSP/HAR；已将 ${unknownTyped} 个依赖归入 hsp`,
      });
    }

    return { dependencies: deps };
  },
};

/* ------------------------------------------------------------------ */

function pickDependencies(moduleJson: unknown): unknown[] | undefined {
  if (!isRecord(moduleJson)) return undefined;
  const moduleObj = isRecord(moduleJson.module) ? moduleJson.module : undefined;
  if (!moduleObj) return undefined;
  return Array.isArray(moduleObj.dependencies) ? moduleObj.dependencies : undefined;
}

function readDepModuleName(dep: unknown): string | undefined {
  if (typeof dep === 'string') return dep;
  if (isRecord(dep) && typeof dep.moduleName === 'string') return dep.moduleName;
  return undefined;
}

function formatDepId(dep: unknown): string | undefined {
  if (typeof dep === 'string' && dep.length > 0) return dep;
  if (isRecord(dep)) {
    const moduleName = typeof dep.moduleName === 'string' ? dep.moduleName : undefined;
    const bundleName = typeof dep.bundleName === 'string' ? dep.bundleName : undefined;
    const versionCode = typeof dep.versionCode === 'number' ? dep.versionCode : undefined;
    if (!moduleName) return undefined;
    const left = bundleName ? `${bundleName}/${moduleName}` : moduleName;
    return versionCode !== undefined ? `${left}@${versionCode}` : left;
  }
  return undefined;
}

/** 从 pack.info 构造 moduleName -> type 的映射，便于精确分类 */
function buildModuleTypeMap(packInfo: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!isRecord(packInfo)) return map;
  const summary = isRecord(packInfo.summary) ? packInfo.summary : undefined;
  if (!summary) return map;
  const modules = Array.isArray(summary.modules) ? summary.modules : [];
  for (const m of modules) {
    if (!isRecord(m)) continue;
    const name = typeof m.name === 'string' ? m.name : undefined;
    const type = typeof m.type === 'string' ? m.type : undefined;
    if (name && type) map.set(name, type);
  }
  return map;
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
