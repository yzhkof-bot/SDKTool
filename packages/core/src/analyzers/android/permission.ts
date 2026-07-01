import type {
  Analyzer,
  AnalyzerContext,
  AndroidPermissionLevel,
  PackagePermission,
  PackageReport,
} from '@kingsdk/shared/schema.js';
import {
  ANDROID_PERMISSION_LEVELS,
  ANDROID_SENSITIVE_PERMISSIONS,
} from '@kingsdk/shared/constants.js';

import { parseAxml } from './axml.js';
import { extractAndroidManifest } from './manifestExtract.js';

/**
 * Android：权限分析。
 *
 * 数据流：AndroidManifest.xml → AXML parser → manifestExtract → usesPermissions[]
 * → PackagePermission[]（每条带 level + sensitive 标记）
 *
 * 与 manifest analyzer 的关系：
 *   - manifest analyzer 负责输出 androidManifest 数据结构 + 派生 basic
 *   - permission analyzer 独立解析一次 AndroidManifest.xml（约 10ms），
 *     专门负责输出 PackagePermission[]
 *   两个 analyzer 互不依赖、各自可选，符合本工具的 plugin-based 架构。
 *   AndroidManifest.xml 是文件级单一来源，跑两遍 AXML 解析的开销在可接受范围。
 *
 * 排序规则：
 *   sensitive(dangerous) 优先 → 然后按 level 危险度（dangerous > signature > unknown > normal）
 *   → 同 level 内按权限名字典序。这样 viewer permissions section 头部就是敏感项。
 *
 * 失败处理：AndroidManifest.xml 缺失 / AXML 损坏 → permissions=[] + warning（与 manifest
 * analyzer 各自独立报警，不影响其它 analyzer）。
 */
export const androidPermissionAnalyzer: Analyzer = {
  id: 'androidPermission',
  name: 'Android Permission',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const entry = ctx.hap.entries.find(
      (e) => !e.isDirectory && e.path === 'AndroidManifest.xml',
    );
    if (!entry) {
      // manifest analyzer 已经报 ANDROID_MANIFEST_MISSING（error 级），这里不重复报
      return { permissions: [] };
    }

    let buf: Buffer;
    try {
      buf = await ctx.hap.readFile('AndroidManifest.xml');
    } catch (err) {
      ctx.addWarning({
        code: 'ANDROID_PERM_READ_FAILED',
        level: 'warn',
        message: `读取 AndroidManifest.xml 失败: ${(err as Error).message}`,
      });
      return { permissions: [] };
    }

    let usesPermissions: string[];
    try {
      const { root } = parseAxml(buf);
      const info = extractAndroidManifest(root);
      usesPermissions = info.usesPermissions ?? [];
    } catch (err) {
      ctx.addWarning({
        code: 'ANDROID_PERM_AXML_FAILED',
        level: 'warn',
        message: `AXML 解析失败: ${(err as Error).message}`,
      });
      return { permissions: [] };
    }

    const permissions = derivePermissions(usesPermissions);
    return { permissions };
  },
};

/* ------------------------------------------------------------------ */
/* derivation                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把 manifest usesPermissions 字符串列表派生成 PackagePermission[]，
 * 含 level + sensitive 标记，按"敏感优先 + level 等级 + 名称字典序"排序。
 */
export function derivePermissions(names: readonly string[]): PackagePermission[] {
  const seen = new Set<string>();
  const out: PackagePermission[] = [];

  for (const name of names) {
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const level = lookupLevel(name);
    out.push({
      name,
      sensitive: ANDROID_SENSITIVE_PERMISSIONS.has(name),
      level,
    });
  }

  out.sort((a, b) => {
    if (a.sensitive !== b.sensitive) return a.sensitive ? -1 : 1;
    const da = levelRank(a.level);
    const db = levelRank(b.level);
    if (da !== db) return db - da;
    return a.name.localeCompare(b.name);
  });

  return out;
}

function lookupLevel(name: string): AndroidPermissionLevel {
  const hit = ANDROID_PERMISSION_LEVELS[name];
  return hit ?? 'unknown';
}

/**
 * 排序时的等级权重（数字越大越靠前）。
 *   dangerous(4) > signature(3) > signatureOrSystem(2) > unknown(1) > normal(0)
 *
 * sensitive 标记已先排在前面，这里只是 sensitive 相同时的二级序。
 */
function levelRank(level?: AndroidPermissionLevel): number {
  switch (level) {
    case 'dangerous':
      return 4;
    case 'signature':
      return 3;
    case 'signatureOrSystem':
      return 2;
    case 'unknown':
      return 1;
    case 'normal':
    default:
      return 0;
  }
}
