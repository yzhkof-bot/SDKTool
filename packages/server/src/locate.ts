import { promises as fs, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 按 (name, size) 在用户主目录下的"常见入口目录"递归反查文件绝对路径。
 *
 * 用途：浏览器拖拽场景下，浏览器只能给出 File.name + File.size（拿不到绝对路径，
 * W3C 安全限制）。把这两个元信息送来 server，server 在用户最可能放 hap 的目录下
 * BFS 找回真实绝对路径，从而在 UI 上自动填入 path 输入框 —— 全程零拷贝。
 *
 * 设计取舍：
 *  - 只比对 (basename, size)，不读文件内容，几乎瞬时
 *  - 限深度 / 限耗时 / 限文件数，避免拖一个命中失败的拖拽就把整个磁盘扫一遍
 *  - 跳过 `.git` `node_modules` `Library` `AppData` 等明显不放交付物的目录
 *  - 找到多个匹配也都返回，让前端决定是自动填还是让用户挑
 */

export interface LocateOptions {
  /** 文件名，必须精确匹配 basename */
  name: string;
  /** 字节数，必须精确匹配 */
  size: number;
  /** 候选 root；不传则用 defaultLocateRoots() */
  roots?: string[];
  /** 总耗时上限（ms），默认 1500 */
  timeoutMs?: number;
  /** 单个 root 最大遍历深度，默认 4 */
  maxDepth?: number;
  /** 全过程最多 readdir 多少次，避免遍历到天荒地老 */
  maxDirsPerRun?: number;
  /** 命中多少个就停 */
  maxMatches?: number;
}

export interface LocateResult {
  matches: string[];
  /** 实际遍历的目录数（diagnostic） */
  scanned: number;
  /** 是否因 timeout / maxDirs 提前结束 */
  truncated: boolean;
  /** 实际使用的 roots */
  roots: string[];
}

/** 名字含这些（不区分大小写）的目录全部跳过 */
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '.npm', '.yarn', '.pnpm-store',
  'AppData', 'Library', 'OneDrive', 'iCloudDrive',
  'System Volume Information', '$RECYCLE.BIN',
  'Windows', 'ProgramData', 'Program Files', 'Program Files (x86)',
]);

/** Windows 上以 `$` 开头一律跳过（系统隐藏文件夹） */
function shouldSkip(name: string): boolean {
  if (!name) return true;
  if (name.startsWith('.') && name.length > 1) return true;
  if (name.startsWith('$')) return true;
  return SKIP_DIR_NAMES.has(name);
}

export function defaultLocateRoots(): string[] {
  const home = homedir();
  const cwd = process.cwd();
  const candidates = [
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    cwd,
  ];
  // 去重并保持顺序
  const seen = new Set<string>();
  return candidates.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

export async function locateByMeta(options: LocateOptions): Promise<LocateResult> {
  const name = options.name;
  const size = options.size;
  const roots = options.roots ?? defaultLocateRoots();
  const timeoutMs = options.timeoutMs ?? 1500;
  const maxDepth = options.maxDepth ?? 4;
  const maxDirsPerRun = options.maxDirsPerRun ?? 800;
  const maxMatches = options.maxMatches ?? 5;

  const matches: string[] = [];
  const matchedSet = new Set<string>();
  let scanned = 0;
  let truncated = false;
  const start = Date.now();

  for (const root of roots) {
    if (matches.length >= maxMatches || truncated) break;
    let exists = true;
    try {
      const s = await fs.stat(root);
      if (!s.isDirectory()) exists = false;
    } catch {
      exists = false;
    }
    if (!exists) continue;

    // 单 root 内 BFS
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
      if (matches.length >= maxMatches) break;
      if (Date.now() - start > timeoutMs) {
        truncated = true;
        break;
      }
      if (scanned >= maxDirsPerRun) {
        truncated = true;
        break;
      }

      const { dir, depth } = queue.shift()!;
      scanned++;

      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const d of dirents) {
        if (matches.length >= maxMatches) break;
        if (d.isDirectory()) {
          if (depth >= maxDepth) continue;
          if (shouldSkip(d.name)) continue;
          queue.push({ dir: join(dir, d.name), depth: depth + 1 });
        } else if (d.isFile() && d.name === name) {
          const full = join(dir, d.name);
          if (matchedSet.has(full)) continue;
          try {
            const st = await fs.stat(full);
            if (st.size === size) {
              matchedSet.add(full);
              matches.push(full);
            }
          } catch {
            // 软链接坏掉等忽略
          }
        }
      }
    }
  }

  return { matches, scanned, truncated, roots };
}
