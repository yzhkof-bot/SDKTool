#!/usr/bin/env node
/**
 * 一键重启 workbench 服务（跨平台 · Windows / macOS / Linux 通用）。
 *
 * 干啥：
 *   1. 杀掉占用目标端口的旧进程（如果有）
 *   2. 可选：重新 build（默认开启，跳过用 --no-build）
 *   3. 起一个新 workbench 进程到前台（继承 stdio，Ctrl+C 即停）
 *   4. 探活 /healthz 一次，告诉你它真的起来了
 *
 * 用法：
 *   node scripts/restart-workbench.mjs                     # 默认: build + 重启 + 监听 7790
 *   node scripts/restart-workbench.mjs --no-build          # 跳过 build（已编译好或纯重启）
 *   node scripts/restart-workbench.mjs --port 8888         # 换端口
 *   node scripts/restart-workbench.mjs --dev               # 用 tsx 跑 src/ 而不是 dist/（自动忽略 build）
 *   node scripts/restart-workbench.mjs --no-open           # 不自动开浏览器
 *   node scripts/restart-workbench.mjs --kill-only         # 只杀不起
 *
 * 也可以走 npm scripts:
 *   npm run wb           → 等价于 node scripts/restart-workbench.mjs
 *   npm run wb:nobuild   → 等价于 ... --no-build
 *   npm run wb:dev       → 等价于 ... --dev
 *   npm run wb:stop      → 等价于 ... --kill-only
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = parseArgs(process.argv.slice(2));
const port = args.port;
const host = args.host;

await main();

/* ------------------------------------------------------------------ */

async function main() {
  // host 是绑定地址；探活和「打开」展示地址需区别对待：
  //   - 0.0.0.0 / :: 是通配绑定地址，不能直接连，探活回退到 127.0.0.1
  //   - 展示地址优先用局域网 IP，方便其它机器直接访问
  const isWildcard = host === '0.0.0.0' || host === '::' || host === '';
  const healthHost = isWildcard ? '127.0.0.1' : host;
  const displayHost = isWildcard ? lanIp() ?? '127.0.0.1' : host;

  log(`[wb] 目标 ${host}:${port}`);
  if (isWildcard) log(`[wb] 监听所有网卡，其它机器可访问 http://${displayHost}:${port}/`);

  // 1. 杀旧
  const killed = killPort(port);
  if (killed > 0) log(`[wb] 已杀掉 ${killed} 个旧进程`);
  else log('[wb] 端口空闲，无需清理');

  if (args.killOnly) {
    log('[wb] --kill-only 模式，结束');
    return;
  }

  // 2. 可选 build（dev 模式跳过；用户传 --no-build 也跳过）
  if (!args.dev && args.build) {
    log('[wb] 重新 build … （加 --no-build 可跳过）');
    const r = spawnSync(npmCmd(), ['run', 'build'], {
      cwd: root,
      stdio: 'inherit',
      shell: true,
    });
    if (r.status !== 0) {
      err(`[wb] build 失败 exit=${r.status}`);
      process.exit(r.status ?? 1);
    }
  } else if (args.dev) {
    log('[wb] --dev 模式，跳过 build（直接用 tsx 跑源码）');
  } else {
    log('[wb] 跳过 build (--no-build)');
  }

  // 3. 起新进程（前台、继承 stdio）
  const { command, cmdArgs, useShell } = buildLaunchCmd();
  log(`[wb] 启动: ${command} ${cmdArgs.join(' ')}`);

  const child = spawn(command, cmdArgs, {
    cwd: root,
    stdio: 'inherit',
    // shell 只在跑 npx/npm 这种依赖 PATH 解析的命令时打开；直接跑 node.exe 时关掉，
    // 否则 win32 上 process.execPath 含空格会被 shell 切碎导致启动失败
    shell: useShell,
  });

  child.on('exit', (code, signal) => {
    log(`[wb] workbench 退出 code=${code} signal=${signal ?? ''}`);
    process.exit(code ?? 0);
  });

  // 转发 Ctrl+C → 子进程
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        /* ignore */
      }
    });
  }

  // 4. 探活
  await sleep(800);
  await waitHealthz(`http://${healthHost}:${port}/healthz`, 12).then(
    () => log(`[wb] ✓ healthz OK · 打开 http://${displayHost}:${port}/`),
    (e) => err(`[wb] ✗ healthz 探活失败: ${e?.message ?? e}`),
  );
}

/**
 * 返回第一个非内网回环的 IPv4 地址（局域网 IP），找不到返回 undefined。
 * 用于绑定 0.0.0.0 时给出一个其它机器可访问的展示地址。
 */
function lanIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {
    // 默认绑 0.0.0.0（所有网卡），让同网段其它机器也能访问；
    // 只想本机用就传 --host 127.0.0.1
    port: 7790,
    host: '0.0.0.0',
    build: true,
    open: true,
    dev: false,
    killOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = String(argv[++i]);
    else if (a === '--no-build') out.build = false;
    else if (a === '--no-open') out.open = false;
    else if (a === '--dev') out.dev = true;
    else if (a === '--kill-only') out.killOnly = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      err(`[wb] 未知参数: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    err(`[wb] 非法 --port: ${out.port}`);
    process.exit(2);
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/restart-workbench.mjs [options]

Options:
  --port <n>     监听端口 (默认 7790)
  --host <h>     监听地址 (默认 0.0.0.0，所有网卡可访问；只想本机用传 127.0.0.1)
  --no-build     跳过 npm run build
  --no-open      workbench 不自动开浏览器
  --dev          用 tsx 直接跑 src/cli/index.ts（隐含 --no-build）
  --kill-only    只杀掉旧进程，不启动新的
  -h, --help     这条帮助
`);
}

function buildLaunchCmd() {
  const wbArgs = ['workbench', '--port', String(port), '--host', host];
  if (!args.open) wbArgs.push('--no-open');

  if (args.dev) {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      cmdArgs: ['tsx', 'src/cli/index.ts', ...wbArgs],
      useShell: false,
    };
  }
  const dist = join(root, 'dist/cli/index.cjs');
  if (!existsSync(dist)) {
    err(`[wb] 找不到 ${dist}，请先 npm run build；或加 --dev 用源码跑`);
    process.exit(1);
  }
  return { command: process.execPath, cmdArgs: [dist, ...wbArgs], useShell: false };
}

/**
 * 杀掉占用 port 的所有 LISTEN 进程，返回杀掉的进程数。
 * 跨平台：win32 用 PowerShell Get-NetTCPConnection；其它平台用 lsof。
 */
function killPort(p) {
  const pids = listPidsOnPort(p);
  let killed = 0;
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch (e) {
      // 进程已死或权限不足；继续
      err(`[wb] 杀 PID ${pid} 失败: ${e?.message ?? e}`);
    }
  }
  return killed;
}

function listPidsOnPort(p) {
  if (process.platform === 'win32') {
    const cmd = `(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue).OwningProcess`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8',
    });
    if (r.status !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => Number(s))
      .filter((v, i, arr) => arr.indexOf(v) === i);
  }
  // mac / linux
  const r = spawnSync('lsof', ['-t', '-i', `:${p}`, '-s', 'TCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (r.status !== 0 && !r.stdout) return [];
  return r.stdout
    .split(/\s+/)
    .filter((s) => /^\d+$/.test(s))
    .map((s) => Number(s))
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

async function waitHealthz(url, maxAttempts) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok && (await r.text()).trim() === 'ok') return;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(400);
  }
  throw lastErr ?? new Error('健康检查超时');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function err(msg) {
  process.stderr.write(`${msg}\n`);
}
