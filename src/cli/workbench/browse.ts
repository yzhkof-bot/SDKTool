import { promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * 服务端目录浏览。所有路径都是用户本机的真实绝对路径，浏览器只是渲染列表，
 * 选中后回传绝对路径给 analyze/compare API —— **零拷贝**，不会把 hap 复制到 server。
 *
 * 安全考量：这是本地工具且只监听 127.0.0.1，不做额外路径白名单/沙箱，
 * 用户在自己机器上对自己的文件有完全控制权。
 */

export interface BrowseEntry {
  name: string;
  /** 完整绝对路径（点击 entry 时前端把它送回 API） */
  path: string;
  isDir: boolean;
  /** 文件大小（仅文件），目录恒为 undefined */
  size?: number;
  /** 修改时间 ISO-8601；目录可有可无 */
  mtime?: string;
  /** 文件扩展名小写（含点），无扩展名为 ''；目录恒为 undefined */
  ext?: string;
}

export interface BrowseResult {
  /** 当前目录绝对路径；根目录列表时为 'ROOT' 占位（不是真实路径） */
  cwd: string;
  /** 父目录绝对路径；已经是根则为 null */
  parent: string | null;
  /** 是否在虚拟"根列表"层（Windows 多盘符场景） */
  isRootList: boolean;
  /** 平台 'win32' | 'darwin' | 'linux'（前端用来决定路径分隔符） */
  platform: NodeJS.Platform;
  /** 用户 HOME 目录绝对路径，便于前端"去 Home"快捷键 */
  home: string;
  entries: BrowseEntry[];
}

/**
 * 列出目录或根。
 *
 * @param input  目标目录绝对路径；undefined / 空串 → 返回根列表（Windows 列出所有盘符；其它平台直接列 '/'）
 */
export async function browseDirectory(input?: string): Promise<BrowseResult> {
  const isWindows = platform() === 'win32';
  const home = homedir();

  // ROOT 列表（Windows 多盘符）
  if (!input || input === 'ROOT' || input.trim() === '') {
    if (isWindows) {
      const drives = await listWindowsDrives();
      return {
        cwd: 'ROOT',
        parent: null,
        isRootList: true,
        platform: process.platform,
        home,
        entries: drives.map((d) => ({
          name: d,
          path: d,
          isDir: true,
        })),
      };
    }
    // 非 Windows 直接展示 '/'
    return readDir('/', home);
  }

  if (!isAbsolute(input)) {
    throw new BrowseError(`必须是绝对路径，收到: ${input}`);
  }

  return readDir(resolve(input), home);
}

async function readDir(dir: string, home: string): Promise<BrowseResult> {
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch (e) {
    throw new BrowseError(`无法访问目录: ${dir} - ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  if (!stat.isDirectory()) {
    throw new BrowseError(`不是目录: ${dir}`);
  }

  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw new BrowseError(`读取目录失败: ${dir} - ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }

  const entries: BrowseEntry[] = [];
  for (const d of dirents) {
    // 跳过明显垃圾：以 ~ 开头的临时锁文件 / Windows 系统文件
    if (d.name.startsWith('$') || d.name === 'System Volume Information') continue;
    const full = join(dir, d.name);
    const isDir = d.isDirectory();
    const ent: BrowseEntry = {
      name: d.name,
      path: full,
      isDir,
    };
    if (!isDir) {
      try {
        const s = await fs.stat(full);
        ent.size = s.size;
        ent.mtime = s.mtime.toISOString();
      } catch {
        // 软链接坏掉、权限不足等，忽略尺寸
      }
      const dotIdx = d.name.lastIndexOf('.');
      ent.ext = dotIdx > 0 ? d.name.slice(dotIdx).toLowerCase() : '';
    }
    entries.push(ent);
  }

  // 排序：目录在前，再按 name 大小写不敏感
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const parent = computeParent(dir);
  return {
    cwd: dir,
    parent,
    isRootList: false,
    platform: process.platform,
    home,
    entries,
  };
}

/**
 * 计算父目录。
 * - Unix: '/' 的父是 null
 * - Windows: 'C:\\' 的父是虚拟 'ROOT'（前端拿去回到根列表）
 */
function computeParent(dir: string): string | null {
  const parent = dirname(dir);
  if (parent === dir) {
    // dirname 不变 → 已到根。Windows 上是 'C:\\'，应跳到虚拟 ROOT
    return platform() === 'win32' ? 'ROOT' : null;
  }
  return parent;
}

async function listWindowsDrives(): Promise<string[]> {
  // 枚举 A-Z，stat 试探。比 wmic / fsutil 快且零依赖。
  const checks: Promise<string | null>[] = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:${sep}`;
    checks.push(
      fs.access(root).then(() => root).catch(() => null),
    );
  }
  const results = await Promise.all(checks);
  return results.filter((x): x is string => x !== null);
}

export class BrowseError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BrowseError';
  }
}
