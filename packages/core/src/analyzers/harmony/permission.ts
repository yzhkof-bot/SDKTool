import type {
  Analyzer,
  AnalyzerContext,
  PackagePermission,
  PackageReport,
} from '@kingsdk/shared/schema.js';
import { SENSITIVE_PERMISSIONS } from '@kingsdk/shared/constants.js';
import { isRecord } from '@kingsdk/shared/utils.js';

import { readModuleJson } from './_shared.js';

/**
 * 权限分析：
 *  - 输入：module.json 的 module.requestPermissions 字段
 *  - 输出：PackagePermission[]，每条标注 sensitive
 *
 * HarmonyOS module.json 中权限通常长这样：
 * {
 *   "module": {
 *     "requestPermissions": [
 *       { "name": "ohos.permission.LOCATION", "reason": "...", "usedScene": {...} }
 *     ]
 *   }
 * }
 */
export const permissionAnalyzer: Analyzer = {
  id: 'permission',
  name: 'Permission',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const { value: moduleJson } = await readModuleJson(ctx);
    if (moduleJson === undefined) {
      return { permissions: [] };
    }

    const permissions = extractPermissions(moduleJson, ctx);
    return { permissions };
  },
};

/* ------------------------------------------------------------------ */

function extractPermissions(moduleJson: unknown, ctx: AnalyzerContext): PackagePermission[] {
  if (!isRecord(moduleJson)) return [];
  const moduleObj = isRecord(moduleJson.module) ? moduleJson.module : undefined;
  if (!moduleObj) return [];

  // 兼容多种字段名：requestPermissions / reqPermissions（旧 config.json）
  const raw = pickArray(moduleObj.requestPermissions) ?? pickArray(moduleObj.reqPermissions);
  if (!raw) return [];

  const out: PackagePermission[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const name = readPermissionName(item);
    if (!name) {
      ctx.addWarning({
        code: 'INVALID_PERMISSION_ENTRY',
        level: 'warn',
        message: `跳过无 name 的权限项: ${JSON.stringify(item).slice(0, 100)}`,
      });
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);

    const entry: PackagePermission = {
      name,
      sensitive: SENSITIVE_PERMISSIONS.has(name),
    };
    if (isRecord(item)) {
      if (typeof item.reason === 'string') entry.reason = item.reason;
      if (item.usedScene !== undefined) entry.usedScene = item.usedScene;
    }
    out.push(entry);
  }

  // 排序：敏感优先 → 名称字典序，便于 diff 稳定
  out.sort((a, b) => {
    if (a.sensitive !== b.sensitive) return a.sensitive ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return out;
}

function pickArray(input: unknown): unknown[] | undefined {
  return Array.isArray(input) ? input : undefined;
}

function readPermissionName(item: unknown): string | undefined {
  if (typeof item === 'string' && item.length > 0) return item;
  if (isRecord(item) && typeof item.name === 'string' && item.name.length > 0) return item.name;
  return undefined;
}
