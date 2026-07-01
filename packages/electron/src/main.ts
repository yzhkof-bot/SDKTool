/**
 * Electron 主进程：桌面端外壳。
 *
 * 形态（本机独立进程，非内嵌）：
 *   app.whenReady()
 *     └─ spawn 本机 server 子进程（node dist/server/main.cjs --mode desktop）
 *     └─ 读子进程 stdout 的 KINGSDK_SERVER_READY <url> 拿到实际监听地址
 *        （兜底：轮询 /healthz）
 *     └─ BrowserWindow.loadURL(url)
 *
 * 为什么 spawn 而非在主进程内 startWorkbenchServer()：
 *  - 用户明确要求「不内嵌、也要连 server」——server 是独立进程，但跑在同一台机器（localhost），
 *    所以本地路径/浏览/配置本地工程等 desktop 能力照常可用（零拷贝按路径）。
 *  - server 与 web 部署共用同一份 main.ts 入口，桌面端只是多了个「自动拉起 + 开窗」。
 *
 * 配置定位：给子进程设 SDKTOOL_PIPELINES_CONFIG 指向 userData/pipelines.config.json，
 * 规避 Electron 打包后 process.cwd() 不可靠的问题（devopsConfig 已支持该环境变量覆盖）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow } from 'electron';

/**
 * 就绪标记：必须与 @kingsdk/server 的 main.ts READY_MARKER 保持一致。
 * 这里内联而非 import，避免把整个 server 打进 electron 主进程 bundle
 * （server 作为独立子进程运行，主进程只需认这一个协议字符串）。
 */
const READY_MARKER = 'KINGSDK_SERVER_READY';

/** 主窗口与 server 子进程的进程内单例（退出时清理）。 */
let serverProc: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

/** 打包后 dist 根：dist/electron/main.cjs → dist。 */
function distRoot(): string {
  const here =
    typeof __dirname !== 'undefined'
      ? __dirname
      : (() => {
          try {
            return join(fileURLToPath((Function('return import.meta.url')() as string)), '..');
          } catch {
            return process.cwd();
          }
        })();
  return join(here, '..'); // dist/electron → dist
}

/** server 子进程入口（打包后与 electron bundle 同在 dist/ 下）。 */
function serverEntry(): string {
  const candidates = [
    join(distRoot(), 'server', 'main.cjs'),
    join(process.cwd(), 'dist', 'server', 'main.cjs'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[0]!;
}

/**
 * spawn 本机 server 子进程，resolve 出实际访问 URL。
 * 优先读 stdout 的 READY 标记；标记迟迟不来时靠超时兜底拒绝。
 */
function startServer(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const entry = serverEntry();
    const configPath = join(app.getPath('userData'), 'pipelines.config.json');

    const child = spawn(process.execPath, [entry, '--mode', 'desktop', '--host', '127.0.0.1', '--port', '0'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Electron 打包后 cwd 不可靠 → 显式指向 userData 下的配置（存在才生效）
        ...(existsSync(configPath) ? { SDKTOOL_PIPELINES_CONFIG: configPath } : {}),
        KINGSDK_VERSION: app.getVersion(),
        // 让子进程以纯 node 模式跑（避免继承 ELECTRON_RUN_AS_NODE 之外的干扰）
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
    serverProc = child;

    let settled = false;
    let buf = '';
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('server 子进程 20s 内未就绪'));
      }
    }, 20_000);

    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const idx = buf.indexOf(READY_MARKER);
      if (idx >= 0 && !settled) {
        const line = buf.slice(idx).split('\n')[0] ?? '';
        const url = line.slice(READY_MARKER.length).trim();
        if (url) {
          settled = true;
          clearTimeout(timer);
          resolve(url);
        }
      }
    });
    // server 业务日志走 stderr，转发到主进程控制台便于排查
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d}`));

    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on('exit', (code) => {
      serverProc = null;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`server 子进程提前退出（code=${code}）`));
      }
    });
  });
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'KingSDK Workbench',
    webPreferences: {
      preload: join(distRoot(), 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function killServer(): void {
  if (serverProc && !serverProc.killed) {
    serverProc.kill();
    serverProc = null;
  }
}

app.whenReady().then(async () => {
  try {
    const url = await startServer();
    createWindow(url);
  } catch (e) {
    process.stderr.write(`[electron] 启动失败：${(e as Error).message}\n`);
    app.quit();
    return;
  }

  app.on('activate', () => {
    // macOS：dock 点击且无窗口时重开（server 仍在跑，直接复用）
    if (BrowserWindow.getAllWindows().length === 0 && serverProc) {
      // server 已在跑但没记 URL：简单起见重启一次
      startServer().then(createWindow).catch(() => app.quit());
    }
  });
});

app.on('window-all-closed', () => {
  // 非 macOS：关窗即退出（含杀 server 子进程）
  if (process.platform !== 'darwin') {
    killServer();
    app.quit();
  }
});

app.on('before-quit', killServer);
process.on('exit', killServer);
