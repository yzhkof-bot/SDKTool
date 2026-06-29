/**
 * Workbench 主页 HTML。
 *
 * 设计原则：
 *  - 整体只有这一个文件就能渲染整个工作台 UI（HTML+CSS+JS 全内联），方便 server.ts 直接输出
 *  - 不打 IIFE bundle、不依赖 viewer/sections，行为简单（fetch + 拉表 + DOM 增删）
 *  - 文件选择走"服务端目录浏览器" modal，**零拷贝**：浏览器只是渲染目录列表，
 *    点选时把绝对路径回传 API，server 直接 analyzePackage(absPath)，hap 不会被复制
 *  - 可选深度分析（extras）：SSR 时渲染默认平台 (HarmonyOS) 的 extras 列表；切换平台时
 *    通过 GET /api/extras?platform= 拉新列表客户端渲染替换
 *  - 多平台：顶部 Platform Segment 切换 harmony/android/ios，POST 时带 platform 字段；
 *    一期 android/ios 仅注册但 disabled，等 analyzer 落地后解锁
 */

import { getExtraAnalyzerMeta } from '../../core/analyzers/index.js';
import { DEFAULT_PLATFORM, type Platform } from '../../shared/schema.js';

import type { ExtraAnalyzerMeta } from '../../core/analyzers/meta.js';

/**
 * Platform UI 元数据：决定 segment 文案 / 可用性 / 文件类型 filter / 输入框 placeholder。
 *
 * 一期约定：仅 harmony 启用；android / ios 占位但 disabled，鼠标 hover 显示 tooltip。
 * 解锁 android 只需要把 enabled 改成 true + 把对应 analyzer 实现挂上（参见 todo #7）。
 */
interface PlatformUIDef {
  id: Platform;
  label: string;
  enabled: boolean;
  /** disabled 状态下的 tooltip 文案 */
  tooltip?: string;
  /** 文件选择器 filter（picker / drag fallback 都用） */
  fileFilter: string;
  /** 单输入框 placeholder（analyze 单包 + compare 两侧通用） */
  placeholder: string;
}

const PLATFORM_DEFS: ReadonlyArray<PlatformUIDef> = [
  {
    id: 'harmony',
    label: 'HarmonyOS',
    enabled: true,
    fileFilter: '.hap,.json',
    placeholder: '/abs/path/to/your.hap 或 D:\\path\\your.hap',
  },
  {
    id: 'android',
    label: 'Android',
    enabled: true,
    fileFilter: '.apk,.aab,.json',
    placeholder: '/abs/path/to/your.apk 或 D:\\path\\your.apk',
  },
  {
    id: 'ios',
    label: 'iOS',
    enabled: false,
    tooltip: '后续支持',
    fileFilter: '.ipa,.json',
    placeholder: '/abs/path/to/your.ipa 或 D:\\path\\your.ipa',
  },
];

export function renderWorkbenchPage(cacheDir: string, devopsOnly = false): string {
  return PAGE_HTML(getExtraAnalyzerMeta(DEFAULT_PLATFORM), cacheDir, devopsOnly);
}

function PAGE_HTML(extras: ExtraAnalyzerMeta[], cacheDir: string, devopsOnly: boolean): string {
  const extrasAnalyze = renderExtrasBlock(extras, 'analyze');
  const extrasCompare = renderExtrasBlock(extras, 'compare');
  const cacheDirEsc = escHtml(cacheDir);
  const platformSegment = renderPlatformSegment();
  const platformFilter = renderPlatformHistoryFilter();
  const defaultPlatform = DEFAULT_PLATFORM;
  const defaultDef = PLATFORM_DEFS.find((p) => p.id === defaultPlatform) ?? PLATFORM_DEFS[0]!;
  const defaultFilter = escAttr(defaultDef.fileFilter);
  const defaultPlaceholder = escAttr(defaultDef.placeholder);
  const platformDefsJson = JSON.stringify(PLATFORM_DEFS);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KingSDK Hap Workbench</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="topbar">
    <h1>KingSDK Workbench</h1>
    <div class="topbar-sub">本地工作台 · 监听 127.0.0.1 · 零拷贝（不复制原始包）</div>
    <div class="topbar-storage">
      <span class="topbar-storage-label">历史记录目录</span>
      <code class="topbar-storage-path" id="cache-dir-path">${cacheDirEsc}</code>
      <button class="btn-icon-sm" id="btn-copy-cache-dir" title="复制路径">⎘</button>
      <button class="btn-icon-sm" id="btn-open-cache-dir" title="在文件管理器中打开">📂</button>
      <span class="topbar-storage-msg" id="cache-dir-msg"></span>
    </div>
  </div>

  <div class="layout">
    ${renderDevopsSidebar()}
    <div class="container" id="container" data-platform="${escAttr(defaultPlatform)}">
    ${platformSegment}

    <div class="tabs">
      <button class="tab active" data-tab="analyze">分析单个包</button>
      <button class="tab" data-tab="compare">对比两个包</button>
      <button class="tab" data-tab="wework">企业微信机器人</button>
    </div>

    <section class="panel" data-section="analyze">
      <h2 class="panel-title">分析</h2>
      <p class="hint">三种方式选包：<b>拖到下方虚线框</b>（按 name+size 反查 Downloads/Desktop/Documents/cwd 下文件）、点<b>浏览…</b>、或直接<b>粘贴绝对路径</b>。文件不会被上传或复制。</p>
      <div class="drop-row" data-input-id="analyze-path">
        <div class="drop-row-tag" data-pkg-tag>包</div>
        <div class="drop-row-main">
          <div class="path-row">
            <label>包路径</label>
            <input type="text" id="analyze-path" data-dropinput placeholder="${defaultPlaceholder}" />
            <button class="btn-secondary" data-browse-target="analyze-path" data-filter="${defaultFilter}">浏览…</button>
          </div>
          <div class="row-status" data-status-for="analyze-path"></div>
        </div>
        <div class="drop-row-hint">拖到这里</div>
      </div>
      <div data-extras-host="analyze">${extrasAnalyze}</div>
      <div class="actions">
        <button class="btn-primary" id="btn-analyze">开始分析</button>
      </div>
      <div id="analyze-error" class="error" hidden></div>
    </section>

    <section class="panel" data-section="compare" hidden>
      <h2 class="panel-title">对比</h2>
      <p class="hint">两侧各是独立拖拽区——把<b>旧版包</b>拖到<b>左边</b>，<b>新版包</b>拖到<b>右边</b>。两侧需要是同一平台；也支持已生成的 .json 报告。文件不会被复制。</p>
      <div class="drop-row" data-input-id="compare-left">
        <div class="drop-row-tag tag-left">Baseline (左·旧)</div>
        <div class="drop-row-main">
          <div class="path-row">
            <label>路径</label>
            <input type="text" id="compare-left" data-dropinput placeholder="较早的包 / 报告 JSON" />
            <button class="btn-secondary" data-browse-target="compare-left" data-filter="${defaultFilter}">浏览…</button>
          </div>
          <div class="row-status" data-status-for="compare-left"></div>
        </div>
        <div class="drop-row-hint">拖到这里 · 左</div>
      </div>
      <div class="drop-row" data-input-id="compare-right">
        <div class="drop-row-tag tag-right">Candidate (右·新)</div>
        <div class="drop-row-main">
          <div class="path-row">
            <label>路径</label>
            <input type="text" id="compare-right" data-dropinput placeholder="较新的包 / 报告 JSON" />
            <button class="btn-secondary" data-browse-target="compare-right" data-filter="${defaultFilter}">浏览…</button>
          </div>
          <div class="row-status" data-status-for="compare-right"></div>
        </div>
        <div class="drop-row-hint">拖到这里 · 右</div>
      </div>
      <div data-extras-host="compare">${extrasCompare}</div>
      <div class="actions">
        <button class="btn-primary" id="btn-compare">开始对比</button>
      </div>
      <div id="compare-error" class="error" hidden></div>
    </section>

    <section class="panel" data-section="wework" hidden>
      <h2 class="panel-title">企业微信机器人 · 长连接测试 <span class="muted">(基于 @wecom/aibot-node-sdk WebSocket)</span></h2>
      <p class="hint">用 <b>pipelines.config.json</b> 的 <code>wework</code> 段里配置的 BotID / Secret 建立长连接，验证收发是否打通。此页<b>不接入</b>分析/对比功能，仅做连通性测试。在企业微信里给机器人发消息即可在下方实时日志看到回调。</p>

      <div class="ww-card">
        <div class="ww-status-row">
          <span class="ww-dot" id="ww-dot"></span>
          <span class="ww-state-text" id="ww-state-text">加载中…</span>
        </div>
        <div class="ww-meta" id="ww-meta"></div>
      </div>

      <div class="actions">
        <button class="btn-primary" id="ww-connect">连接</button>
        <button class="btn-secondary" id="ww-disconnect">断开</button>
        <label class="ww-toggle"><input type="checkbox" id="ww-autoreply" /> 收到文本消息自动 echo 回复</label>
      </div>
      <div id="ww-error" class="error" hidden></div>

      <div class="ww-send">
        <div class="ww-send-title">主动推送测试 <span class="muted">(需该用户先在会话里给机器人发过消息)</span></div>
        <div class="path-row ww-send-row">
          <label>chatid</label>
          <input type="text" id="ww-chatid" placeholder="单聊填用户 userid / 群聊填 chatid" />
          <button class="btn-secondary" id="ww-use-last" title="填入最近一次会话的 chatid">最近会话</button>
        </div>
        <textarea id="ww-content" class="ww-textarea" placeholder="支持 markdown，例如：**加粗** 与 [链接](https://work.weixin.qq.com)"></textarea>
        <div class="actions">
          <button class="btn-primary" id="ww-send">主动发送</button>
        </div>
      </div>

      <div class="ww-log-head">
        <span class="ww-log-title">实时日志</span>
        <span class="ww-stats" id="ww-stats"></span>
        <button class="btn-icon-sm" id="ww-clear" title="清空日志">清空</button>
      </div>
      <div id="ww-log" class="ww-log"></div>
    </section>

    <section class="panel" id="history-panel">
      <h2 class="panel-title">历史记录 <span class="muted">(自动刷新，最近 50 条；点每行右侧 × 删单条)</span></h2>
      ${platformFilter}
      <div id="jobs"></div>
    </section>
    </div>
  </div>

  <!-- 文件选择 modal：实际就是服务端目录浏览器 -->
  <div class="modal" id="picker" hidden>
    <div class="modal-card">
      <div class="modal-header">
        <strong id="picker-title">选择 Hap / Report</strong>
        <button class="btn-icon" id="picker-close" title="关闭">×</button>
      </div>
      <div class="modal-toolbar">
        <button class="btn-icon" id="picker-up" title="上一级">↑</button>
        <button class="btn-icon" id="picker-home" title="Home">⌂</button>
        <button class="btn-icon" id="picker-root" title="根 / 盘符列表">/</button>
        <input type="text" id="picker-cwd" placeholder="键入路径直接跳转，按 Enter" />
      </div>
      <div class="modal-body">
        <div id="picker-list" class="picker-list"></div>
      </div>
      <div class="modal-footer">
        <span class="muted" id="picker-status">加载中…</span>
        <button class="btn-primary" id="picker-pick-dir" hidden>选择当前目录</button>
      </div>
    </div>
  </div>

  <!-- 构建制品列表 modal -->
  <div class="modal" id="art-modal" hidden>
    <div class="modal-card">
      <div class="modal-header">
        <strong id="art-title">制品列表</strong>
        <button class="btn-icon" id="art-close" title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div id="art-actions"></div>
        <div id="art-list" class="art-list"></div>
      </div>
      <div class="modal-footer">
        <span class="muted" id="art-status">加载中…</span>
      </div>
    </div>
  </div>

  <!-- 配置本地工程进度 modal -->
  <div class="modal" id="lp-modal" hidden>
    <div class="modal-card">
      <div class="modal-header">
        <strong>配置本地工程</strong>
        <button class="btn-icon" id="lp-close" title="关闭" disabled>×</button>
      </div>
      <div class="modal-body">
        <div class="lp-meta" id="lp-meta"></div>
        <div class="lp-steps" id="lp-steps"></div>
        <div class="error lp-modal-error" id="lp-error" hidden></div>
        <div class="lp-result" id="lp-result" hidden></div>
      </div>
      <div class="modal-footer">
        <span class="muted" id="lp-status">准备中…</span>
      </div>
    </div>
  </div>

  <script>
    window.__KINGSDK__ = {
      defaultPlatform: ${JSON.stringify(defaultPlatform)},
      platforms: ${platformDefsJson},
      devopsOnly: ${JSON.stringify(devopsOnly)},
    };
  </script>
  <script>${SCRIPT}</script>
</body>
</html>`;
}

/**
 * 左侧栏：蓝盾流水线构建列表。
 * 骨架由 server 渲染，构建数据由客户端 JS 调 /api/devops/builds 拉取后填充；
 * 每行点击展开该构建的制品列表（/api/devops/artifacts）。
 */
function renderDevopsSidebar(): string {
  const statusOptions = [
    ['', '全部状态'],
    ['SUCCEED', '成功'],
    ['FAILED', '失败'],
    ['RUNNING', '运行中'],
    ['CANCELED', '已取消'],
    ['QUEUE', '排队中'],
    ['STAGE_SUCCESS', '阶段成功'],
  ]
    .map(([v, label]) => `<option value="${escAttr(v!)}">${escHtml(label!)}</option>`)
    .join('');
  return `<aside class="sidebar" id="devops-sidebar">
    <div class="sidebar-head">
      <div class="sidebar-title">流水线构建</div>
      <div class="sidebar-sub" id="devops-sub">加载流水线…</div>
    </div>
    <div class="sidebar-toolbar">
      <select id="devops-pipeline" class="devops-select" title="选择流水线" hidden></select>
    </div>
    <div class="sidebar-toolbar">
      <select id="devops-status" class="devops-select" title="按构建状态过滤">${statusOptions}</select>
      <button class="btn-icon-sm" id="devops-refresh" title="刷新">↻</button>
    </div>
    <div id="devops-list" class="devops-list"></div>
    <div class="sidebar-foot">
      <button class="btn-secondary devops-page-btn" id="devops-prev" disabled>← 上一页</button>
      <span class="devops-page-info" id="devops-page-info">—</span>
      <button class="btn-secondary devops-page-btn" id="devops-next" disabled>下一页 →</button>
    </div>
  </aside>`;
}

/**
 * Platform segment：顶部一组 chip，点击切换当前平台。
 * 一期仅 harmony 可点击；android / ios 渲染为 disabled，hover 显示 tooltip。
 */
function renderPlatformSegment(): string {
  const items = PLATFORM_DEFS.map((p) => {
    const cls = ['platform-chip'];
    if (p.id === DEFAULT_PLATFORM) cls.push('active');
    if (!p.enabled) cls.push('disabled');
    const title = p.enabled ? '' : ` title="${escAttr(p.tooltip ?? '即将上线')}"`;
    return `<button type="button" class="${cls.join(' ')}" data-platform="${escAttr(p.id)}"${p.enabled ? '' : ' disabled'}${title}>${escHtml(p.label)}</button>`;
  }).join('');
  return `<div class="platform-segment" role="tablist" aria-label="选择平台">
    <span class="platform-segment-label">平台</span>
    <div class="platform-segment-chips">${items}</div>
  </div>`;
}

/**
 * 历史记录区顶部的"按平台过滤"开关。
 * "全部" + 启用平台 + （disabled 平台不进过滤项，避免出现一个永远没结果的选项）
 */
function renderPlatformHistoryFilter(): string {
  const items: string[] = [
    `<button type="button" class="hist-filter-chip active" data-hist-filter="all">全部</button>`,
  ];
  for (const p of PLATFORM_DEFS) {
    items.push(
      `<button type="button" class="hist-filter-chip" data-hist-filter="${escAttr(p.id)}">${escHtml(p.label)}</button>`,
    );
  }
  return `<div class="hist-filter">
    <span class="hist-filter-label">筛选</span>
    <div class="hist-filter-chips">${items.join('')}</div>
  </div>`;
}

/**
 * 渲染"可选深度分析"复选框区域。kind 用来给 checkbox name + form 加前缀，
 * 这样 analyze / compare 两组 checkbox 状态独立。
 */
function renderExtrasBlock(extras: ExtraAnalyzerMeta[], kind: 'analyze' | 'compare'): string {
  if (extras.length === 0) return '';
  const items = extras
    .map((e) => {
      const id = `extra-${kind}-${escAttr(e.id)}`;
      return `<label class="extras-item" for="${id}">
        <input type="checkbox" id="${id}" data-extra-${kind}="${escAttr(e.id)}" checked />
        <div class="extras-item-text">
          <div class="extras-item-name">${escHtml(e.name)} <code>${escHtml(e.id)}</code></div>
          <div class="extras-item-desc">${escHtml(e.description)}</div>
        </div>
      </label>`;
    })
    .join('');
  return `<div class="extras-block" data-extras-block="${kind}">
    <div class="extras-title">可选深度分析（多选 · 默认开启，取消勾选可加速本次任务）</div>
    <div class="extras-list">${items}</div>
  </div>`;
}

function escHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c] as string);
}
function escAttr(s: string): string {
  return escHtml(s).replace(/`/g, '&#96;');
}

/* -------------------------------------------------------------------------- */
/* CSS                                                                         */
/* -------------------------------------------------------------------------- */

const STYLE = `
:root {
  --color-bg: #f5f7fb;
  --color-surface: #ffffff;
  --color-surface-elev: #fbfcff;
  --color-border: #e2e6ef;
  --color-text: #1f2937;
  --color-muted: #6b7280;
  --color-primary: #5b8cff;
  --color-primary-bg: rgba(91, 140, 255, 0.12);
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-danger: #ef4444;
  --color-code-bg: #f1f3f9;
  --radius: 8px;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #0d1117;
    --color-surface: #161b22;
    --color-surface-elev: #1c232c;
    --color-border: #30363d;
    --color-text: #e6edf3;
    --color-muted: #8b949e;
    --color-primary: #79a4ff;
    --color-primary-bg: rgba(121, 164, 255, 0.18);
    --color-code-bg: #1a1f27;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--color-bg); color: var(--color-text); font-family: var(--font-sans); font-size: 14px; line-height: 1.6; }
.topbar { background: var(--color-surface); border-bottom: 1px solid var(--color-border); padding: 16px 32px; }
.topbar h1 { margin: 0; font-size: 18px; font-weight: 600; }
.topbar-sub { font-size: 12px; color: var(--color-muted); margin-top: 2px; }
.topbar-storage { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 6px 10px; background: var(--color-surface-elev); border: 1px solid var(--color-border); border-radius: 6px; max-width: 100%; overflow: hidden; }
.topbar-storage-label { font-size: 11px; font-weight: 500; color: var(--color-muted); white-space: nowrap; }
.topbar-storage-path { font-family: var(--font-mono); font-size: 12px; color: var(--color-text); background: var(--color-code-bg); padding: 2px 8px; border-radius: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 600px; flex-shrink: 1; }
.topbar-storage-msg { font-size: 11px; color: var(--color-success); min-width: 48px; transition: opacity 0.3s; }
.btn-icon-sm { background: transparent; border: 1px solid var(--color-border); border-radius: 4px; padding: 2px 7px; font-size: 13px; cursor: pointer; color: var(--color-muted); white-space: nowrap; flex-shrink: 0; }
.btn-icon-sm:hover { background: var(--color-primary-bg); border-color: var(--color-primary); color: var(--color-primary); }
.container { flex: 1; min-width: 0; max-width: 1100px; margin: 0 auto; padding: 24px 32px; }

/* 整体左右布局：左侧蓝盾构建栏 + 右侧主工作台 */
.layout { display: flex; align-items: flex-start; gap: 0; }

/* 左侧栏：蓝盾流水线构建列表 */
.sidebar { width: 340px; flex-shrink: 0; align-self: stretch; background: var(--color-surface); border-right: 1px solid var(--color-border); display: flex; flex-direction: column; max-height: calc(100vh - 120px); position: sticky; top: 0; }
.sidebar-head { padding: 14px 16px 10px; border-bottom: 1px solid var(--color-border); }
.sidebar-title { font-size: 14px; font-weight: 600; }
.sidebar-sub { font-size: 11px; color: var(--color-muted); margin-top: 2px; }
.sidebar-toolbar { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--color-border); align-items: center; }
.devops-select { flex: 1; font-size: 12px; padding: 5px 8px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface-elev); color: var(--color-text); }
.devops-select:focus { outline: none; border-color: var(--color-primary); }
.devops-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.sidebar-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--color-border); }
.devops-page-btn { padding: 5px 10px; font-size: 11px; }
.devops-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.devops-page-info { font-size: 11px; color: var(--color-muted); font-family: var(--font-mono); white-space: nowrap; }

/* 构建卡片 */
.build-item { border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface-elev); overflow: hidden; }
.build-row { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; padding: 8px 10px; cursor: pointer; transition: background 0.12s; }
.build-row:hover { background: var(--color-primary-bg); }
.build-num { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--color-primary); white-space: nowrap; }
.build-meta { min-width: 0; }
.build-meta-line { font-size: 11px; color: var(--color-muted); font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.build-meta-user { font-size: 11px; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.build-status { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 500; white-space: nowrap; }
.build-status.SUCCEED, .build-status.STAGE_SUCCESS { background: rgba(16,185,129,0.16); color: var(--color-success); }
.build-status.FAILED { background: rgba(239,68,68,0.16); color: var(--color-danger); }
.build-status.RUNNING, .build-status.QUEUE { background: rgba(91,140,255,0.16); color: var(--color-primary); }
.build-status.CANCELED { background: rgba(107,114,128,0.18); color: var(--color-muted); }
.build-artifacts { border-top: 1px solid var(--color-border); padding: 8px 10px; background: var(--color-surface); display: flex; flex-direction: column; gap: 6px; }
.build-artifacts.loading, .build-artifacts.empty, .build-artifacts.err { font-size: 11px; color: var(--color-muted); }
.build-artifacts.err { color: var(--color-warning); }
.artifact-item { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: baseline; }
.artifact-name { font-family: var(--font-mono); font-size: 11px; word-break: break-all; color: var(--color-text); }
.artifact-size { font-family: var(--font-mono); font-size: 10px; color: var(--color-muted); white-space: nowrap; }
.devops-list .muted, .devops-list .err { padding: 12px; text-align: center; font-size: 12px; }
.devops-list .err { color: var(--color-warning); }

@media (max-width: 920px) {
  .layout { flex-direction: column; }
  .sidebar { width: 100%; max-height: 360px; border-right: none; border-bottom: 1px solid var(--color-border); position: static; }
}

.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--color-border); }
.tab { padding: 8px 18px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--color-muted); cursor: pointer; font-size: 14px; }
.tab.active { color: var(--color-primary); border-bottom-color: var(--color-primary); font-weight: 500; }
.tab:hover { color: var(--color-text); }

/* Platform segment：顶部平台切换 */
.platform-segment { display: flex; align-items: center; gap: 12px; padding: 10px 14px; margin-bottom: 14px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); }
.platform-segment-label { font-size: 12px; color: var(--color-muted); font-weight: 500; }
.platform-segment-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.platform-chip { padding: 5px 14px; border: 1px solid var(--color-border); background: var(--color-surface-elev); border-radius: 999px; color: var(--color-text); font-size: 12px; cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s; }
.platform-chip:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
.platform-chip.active { background: var(--color-primary); border-color: var(--color-primary); color: #fff; font-weight: 500; }
.platform-chip:disabled, .platform-chip.disabled { opacity: 0.45; cursor: not-allowed; }

/* 历史区按平台过滤 */
.hist-filter { display: flex; align-items: center; gap: 10px; margin: 8px 0 14px; flex-wrap: wrap; }
.hist-filter-label { font-size: 11px; color: var(--color-muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
.hist-filter-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.hist-filter-chip { padding: 3px 10px; border: 1px solid var(--color-border); background: var(--color-surface-elev); border-radius: 999px; color: var(--color-muted); font-size: 11px; cursor: pointer; }
.hist-filter-chip:hover { border-color: var(--color-primary); color: var(--color-primary); }
.hist-filter-chip.active { background: var(--color-primary-bg); border-color: var(--color-primary); color: var(--color-primary); font-weight: 500; }

/* Job 卡片状态 + platform badge 容器（竖排） */
.job .badges { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.job .badge.platform { background: rgba(91, 140, 255, 0.10); color: var(--color-primary); border: 1px solid rgba(91, 140, 255, 0.35); }
.job .badge.platform.android { background: rgba(16, 185, 129, 0.10); color: var(--color-success); border-color: rgba(16, 185, 129, 0.35); }
.job .badge.platform.ios { background: rgba(245, 158, 11, 0.10); color: var(--color-warning); border-color: rgba(245, 158, 11, 0.35); }

.panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 18px 22px; margin-bottom: 18px; position: relative; }
.panel-title { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.hint { color: var(--color-muted); margin: 0 0 14px; font-size: 13px; }
.hint b { color: var(--color-text); font-weight: 500; }

/* 行级独立 dropzone：每个输入一行一个，左右物理分开 */
.drop-row { position: relative; display: grid; grid-template-columns: 130px 1fr 110px; gap: 12px; align-items: center; padding: 10px 12px; margin-bottom: 10px; border: 2px dashed var(--color-border); border-radius: 8px; background: var(--color-surface-elev); transition: border-color 0.15s, background 0.15s; }
.drop-row:hover { border-color: var(--color-primary); }
.drop-row.dragover { border-color: var(--color-primary); border-style: solid; background: var(--color-primary-bg); }
.drop-row-tag { font-size: 12px; font-weight: 500; color: var(--color-muted); text-align: center; padding: 4px 8px; border-radius: 4px; background: rgba(107,114,128,0.1); }
.drop-row-tag.tag-left { background: rgba(91, 140, 255, 0.16); color: var(--color-primary); }
.drop-row-tag.tag-right { background: rgba(16, 185, 129, 0.16); color: var(--color-success); }
.drop-row-main { min-width: 0; }
.drop-row-hint { font-size: 11px; color: var(--color-muted); text-align: center; opacity: 0.6; pointer-events: none; }
.drop-row.dragover .drop-row-hint { color: var(--color-primary); opacity: 1; font-weight: 500; }

/* 行内 path-row 在新布局下不再需要按 130px 留 label 列；label 紧跟 input 即可 */
.drop-row .path-row { grid-template-columns: auto 1fr auto; gap: 8px; margin-bottom: 0; }
.drop-row .path-row label { font-size: 12px; }

/* 反查状态 */
.row-status { font-size: 12px; margin: 4px 0 0; min-height: 16px; font-family: var(--font-mono); }
.row-status.ok { color: var(--color-success); }
.row-status.err { color: var(--color-warning); }
.row-status.muted { color: var(--color-muted); }

.path-row { display: grid; grid-template-columns: 120px 1fr auto; gap: 10px; align-items: center; margin-bottom: 10px; }
.path-row label { color: var(--color-muted); font-size: 13px; }
.path-row input { font-family: var(--font-mono); font-size: 12px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface-elev); color: var(--color-text); width: 100%; }
.path-row input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-bg); }
.path-row input.devops-locked { background: var(--color-code-bg); color: var(--color-muted); cursor: not-allowed; }
.path-row input.devops-locked:focus { box-shadow: none; border-color: var(--color-border); }

/* 可选深度分析多选区 */
.extras-block { margin-top: 12px; padding: 12px 14px; background: var(--color-surface-elev); border: 1px solid var(--color-border); border-radius: 6px; }
.extras-title { font-size: 12px; font-weight: 500; color: var(--color-muted); margin-bottom: 8px; }
.extras-list { display: flex; flex-direction: column; gap: 6px; }
.extras-item { display: flex; gap: 10px; padding: 8px 10px; border-radius: 6px; cursor: pointer; align-items: flex-start; transition: background 0.12s; }
.extras-item:hover { background: var(--color-primary-bg); }
.extras-item input[type="checkbox"] { margin-top: 3px; cursor: pointer; }
.extras-item-text { flex: 1; min-width: 0; }
.extras-item-name { font-size: 13px; font-weight: 500; color: var(--color-text); }
.extras-item-name code { font-family: var(--font-mono); font-size: 11px; color: var(--color-muted); margin-left: 6px; padding: 1px 6px; background: var(--color-code-bg); border-radius: 3px; font-weight: 400; }
.extras-item-desc { font-size: 12px; color: var(--color-muted); margin-top: 2px; line-height: 1.4; }

.actions { margin-top: 14px; display: flex; gap: 10px; }
.btn-primary { background: var(--color-primary); color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn-primary:hover { filter: brightness(0.95); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: var(--color-surface-elev); color: var(--color-text); border: 1px solid var(--color-border); padding: 7px 14px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.btn-secondary:hover { background: var(--color-primary-bg); border-color: var(--color-primary); color: var(--color-primary); }
.btn-icon { background: transparent; border: 1px solid var(--color-border); color: var(--color-text); width: 32px; height: 32px; border-radius: 6px; cursor: pointer; font-size: 14px; }
.btn-icon:hover { background: var(--color-primary-bg); border-color: var(--color-primary); }

.error { background: rgba(239, 68, 68, 0.1); border: 1px solid var(--color-danger); color: var(--color-danger); padding: 10px 14px; border-radius: 6px; margin-top: 12px; font-size: 12px; font-family: var(--font-mono); white-space: pre-wrap; word-break: break-all; }

.muted { color: var(--color-muted); font-weight: 400; font-size: 12px; }

/* 历史 jobs 列表 */
#jobs { display: flex; flex-direction: column; gap: 10px; }
.job { background: var(--color-surface-elev); border: 1px solid var(--color-border); border-radius: 6px; padding: 12px 16px; display: grid; grid-template-columns: auto 1fr auto; gap: 14px; align-items: center; }
.job .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
.job .badge.pending { background: rgba(107,114,128,0.18); color: var(--color-muted); }
.job .badge.running { background: rgba(91, 140, 255, 0.16); color: var(--color-primary); }
.job .badge.done { background: rgba(16,185,129,0.16); color: var(--color-success); }
.job .badge.error { background: rgba(239,68,68,0.16); color: var(--color-danger); }
.job .label { font-weight: 500; }
.job .sub { font-size: 12px; color: var(--color-muted); margin-top: 2px; word-break: break-all; font-family: var(--font-mono); }
.job .time-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.time-chip { display: inline-flex; align-items: baseline; gap: 6px; padding: 2px 8px; border-radius: 999px; background: var(--color-code-bg); border: 1px solid var(--color-border); font-family: var(--font-mono); font-size: 11px; line-height: 1.5; }
.time-chip-label { color: var(--color-muted); font-size: 10px; letter-spacing: 0.02em; text-transform: uppercase; }
.time-chip-value { color: var(--color-text); }
.time-chip.done { background: rgba(16,185,129,0.08); border-color: rgba(16,185,129,0.35); }
.time-chip.done .time-chip-label { color: var(--color-success); }
.time-chip.error { background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.35); }
.time-chip.error .time-chip-label { color: var(--color-danger); }
.time-chip.running, .time-chip.pending { background: rgba(91,140,255,0.08); border-color: rgba(91,140,255,0.35); }
.time-chip.running .time-chip-label, .time-chip.pending .time-chip-label { color: var(--color-primary); }
.time-chip.dur .time-chip-value { font-weight: 500; }
.time-chip.dur.running .time-chip-value { color: var(--color-primary); }
.job .links { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.job .link-group { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.job .link-group-label { color: var(--color-muted); font-size: 11px; }
.job .link-group.side-left .link-group-label { color: var(--color-primary); }
.job .link-group.side-right .link-group-label { color: var(--color-success); }
.job .link-group a { color: var(--color-primary); text-decoration: none; }
.job .link-group a:hover { text-decoration: underline; }
.job .err-msg { color: var(--color-danger); font-size: 12px; font-family: var(--font-mono); margin-top: 4px; word-break: break-all; }
.job .job-note { color: var(--color-primary); font-size: 12px; font-family: var(--font-mono); margin-top: 4px; }
.job .actions-col { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.job .btn-delete { background: transparent; border: 1px solid var(--color-border); color: var(--color-muted); width: 28px; height: 28px; border-radius: 6px; cursor: pointer; font-size: 14px; padding: 0; line-height: 1; }
.job .btn-delete:hover { background: rgba(239, 68, 68, 0.1); border-color: var(--color-danger); color: var(--color-danger); }
.job .btn-delete:disabled { opacity: 0.4; cursor: not-allowed; }

/* Modal */
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal[hidden] { display: none; }
.modal-card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); width: 720px; max-width: 92vw; max-height: 80vh; display: flex; flex-direction: column; }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--color-border); }
.modal-toolbar { display: flex; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--color-border); align-items: center; }
.modal-toolbar input { flex: 1; font-family: var(--font-mono); font-size: 12px; padding: 6px 10px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface-elev); color: var(--color-text); }
.modal-body { flex: 1; overflow-y: auto; }
.modal-footer { padding: 8px 14px; border-top: 1px solid var(--color-border); font-size: 12px; }
.picker-list { display: flex; flex-direction: column; }
.picker-item { display: grid; grid-template-columns: 24px 1fr auto auto; gap: 12px; padding: 6px 14px; cursor: pointer; align-items: center; border-bottom: 1px solid transparent; }
.picker-item:hover { background: var(--color-primary-bg); }
.picker-item .icon { font-size: 16px; opacity: 0.85; }
.picker-item .name { font-family: var(--font-mono); font-size: 13px; word-break: break-all; }
.picker-item .size { font-family: var(--font-mono); font-size: 12px; color: var(--color-muted); }
.picker-item.dim .name { color: var(--color-muted); }
.picker-item.match .name { color: var(--color-primary); font-weight: 500; }
.picker-item .mtime { font-family: var(--font-mono); font-size: 11px; color: var(--color-muted); }
.modal-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.modal-footer .btn-primary { padding: 6px 14px; font-size: 12px; white-space: nowrap; }

/* 制品区：配置本地工程入口 */
.artifact-actions { margin-bottom: 4px; padding-bottom: 6px; border-bottom: 1px dashed var(--color-border); }
.btn-config-proj { width: 100%; background: var(--color-primary); color: #fff; border: none; padding: 6px 10px; border-radius: 6px; font-size: 11px; font-weight: 500; cursor: pointer; }
.btn-config-proj:hover { filter: brightness(0.95); }
.btn-config-proj:disabled { opacity: 0.5; cursor: not-allowed; }
.artifact-config-hint { font-size: 10px; color: var(--color-muted); margin-top: 4px; line-height: 1.4; }

/* 制品列表 modal */
#art-actions { padding: 12px 16px 0; }
#art-actions:empty { padding: 0; }
#art-actions .artifact-actions { margin-bottom: 0; }
#art-actions .btn-config-proj { font-size: 13px; padding: 8px 12px; }
#art-actions .artifact-config-hint { font-size: 11px; }
.art-list { display: flex; flex-direction: column; }
.art-list .artifact-item { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 7px 16px; border-bottom: 1px solid var(--color-border); }
.art-list .artifact-item:last-child { border-bottom: none; }
.art-list .artifact-item:hover { background: var(--color-primary-bg); }
.art-list .artifact-name { font-size: 12px; }
.art-list .artifact-size { font-size: 11px; }
.artifact-name-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* 安装包（hap/apk/aab/ipa）高亮：左侧色条 + 文件名加重 + 扩展名徽标 */
.art-list .artifact-item.pkg { background: var(--color-primary-bg); box-shadow: inset 3px 0 0 var(--color-primary); }
.art-list .artifact-item.pkg .artifact-name { color: var(--color-primary); font-weight: 600; }
.artifact-pkg-badge { flex: none; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; padding: 1px 6px; border-radius: 4px; background: var(--color-primary); color: #fff; }
.artifact-add-btns { display: flex; gap: 4px; white-space: nowrap; }
.artifact-add-btn { font-size: 11px; padding: 3px 8px; border: 1px solid var(--color-border); border-radius: 5px; background: var(--color-surface-elev); color: var(--color-text); cursor: pointer; }
.artifact-add-btn:hover { border-color: var(--color-primary); color: var(--color-primary); background: var(--color-primary-bg); }
/* 已加入但未下载的蓝盾制品引用 chip（显示在输入框下方 row-status 区） */
.devops-ref-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; padding: 2px 6px 2px 8px; border-radius: 10px; background: var(--color-primary-bg); color: var(--color-primary); border: 1px solid var(--color-primary); }
.devops-ref-x { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 11px; line-height: 1; padding: 0 2px; }
.devops-ref-x:hover { color: var(--color-danger); }

/* 配置本地工程进度 */
.lp-meta { font-size: 12px; color: var(--color-muted); padding: 12px 16px 4px; font-family: var(--font-mono); word-break: break-all; }
.lp-steps { display: flex; flex-direction: column; gap: 8px; padding: 8px 16px 12px; }
.lp-step { border: 1px solid var(--color-border); border-radius: 6px; padding: 8px 12px; background: var(--color-surface-elev); }
.lp-step-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.lp-step-label { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.lp-step-icon { font-size: 13px; }
.lp-step.pending .lp-step-label { color: var(--color-muted); }
.lp-step.running .lp-step-label { color: var(--color-primary); }
.lp-step.done .lp-step-label { color: var(--color-success); }
.lp-step.error .lp-step-label { color: var(--color-danger); }
.lp-step.skipped .lp-step-label { color: var(--color-muted); opacity: 0.6; }
.lp-step-pct { font-family: var(--font-mono); font-size: 11px; color: var(--color-muted); white-space: nowrap; }
.lp-step-detail { font-size: 11px; color: var(--color-muted); margin-top: 4px; font-family: var(--font-mono); word-break: break-all; }
.lp-bar { height: 4px; border-radius: 999px; background: var(--color-code-bg); margin-top: 6px; overflow: hidden; }
.lp-bar-fill { height: 100%; background: var(--color-primary); width: 0; transition: width 0.3s; }
.lp-step.done .lp-bar-fill { background: var(--color-success); }
.lp-step.error .lp-bar-fill { background: var(--color-danger); }
.lp-result { margin: 4px 16px 14px; padding: 10px 12px; background: rgba(16,185,129,0.1); border: 1px solid var(--color-success); border-radius: 6px; font-size: 12px; color: var(--color-text); font-family: var(--font-mono); word-break: break-all; }
.lp-modal-error { margin: 4px 16px 14px; }

/* 企业微信机器人测试页 */
.ww-card { padding: 12px 14px; background: var(--color-surface-elev); border: 1px solid var(--color-border); border-radius: 8px; margin-bottom: 12px; }
.ww-status-row { display: flex; align-items: center; gap: 10px; }
.ww-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--color-muted); flex-shrink: 0; box-shadow: 0 0 0 3px rgba(107,114,128,0.15); }
.ww-dot.connected { background: var(--color-success); box-shadow: 0 0 0 3px rgba(16,185,129,0.2); }
.ww-dot.connecting { background: var(--color-warning); box-shadow: 0 0 0 3px rgba(245,158,11,0.2); animation: ww-pulse 1.2s ease-in-out infinite; }
.ww-dot.closed, .ww-dot.error { background: var(--color-danger); box-shadow: 0 0 0 3px rgba(239,68,68,0.2); }
@keyframes ww-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
.ww-state-text { font-size: 14px; font-weight: 500; }
.ww-meta { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--color-muted); font-family: var(--font-mono); }
.ww-meta code { background: var(--color-code-bg); padding: 1px 6px; border-radius: 4px; color: var(--color-text); }
.ww-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--color-text); cursor: pointer; }
.ww-toggle input { cursor: pointer; }
.ww-send { margin-top: 14px; padding: 12px 14px; background: var(--color-surface-elev); border: 1px solid var(--color-border); border-radius: 8px; }
.ww-send-title { font-size: 13px; font-weight: 500; margin-bottom: 10px; }
.ww-send-row { margin-bottom: 10px; }
.ww-textarea { width: 100%; min-height: 64px; resize: vertical; font-family: var(--font-mono); font-size: 12px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface); color: var(--color-text); }
.ww-textarea:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-bg); }
.ww-log-head { display: flex; align-items: center; gap: 12px; margin: 16px 0 8px; }
.ww-log-title { font-size: 14px; font-weight: 600; }
.ww-stats { font-size: 12px; color: var(--color-muted); font-family: var(--font-mono); flex: 1; }
.ww-log { border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface-elev); max-height: 420px; overflow-y: auto; display: flex; flex-direction: column; }
.ww-log:empty::after { content: '暂无日志 — 点「连接」后在企业微信里给机器人发条消息试试'; color: var(--color-muted); font-size: 12px; padding: 16px; }
.ww-log-item { padding: 7px 12px; border-bottom: 1px solid var(--color-border); font-size: 12px; display: grid; grid-template-columns: 64px 56px 1fr; gap: 10px; align-items: baseline; }
.ww-log-item:last-child { border-bottom: none; }
.ww-log-time { font-family: var(--font-mono); font-size: 11px; color: var(--color-muted); white-space: nowrap; }
.ww-log-badge { font-size: 10px; font-weight: 600; text-align: center; padding: 1px 0; border-radius: 4px; }
.ww-log-badge.system { background: rgba(107,114,128,0.18); color: var(--color-muted); }
.ww-log-badge.in { background: rgba(91,140,255,0.16); color: var(--color-primary); }
.ww-log-badge.out { background: rgba(16,185,129,0.16); color: var(--color-success); }
.ww-log-badge.error { background: rgba(239,68,68,0.16); color: var(--color-danger); }
.ww-log-main { min-width: 0; }
.ww-log-text { color: var(--color-text); word-break: break-word; white-space: pre-wrap; }
.ww-log-cmd { font-family: var(--font-mono); font-size: 10px; color: var(--color-muted); margin-left: 6px; }
.ww-log-toggle { background: none; border: none; color: var(--color-primary); cursor: pointer; font-size: 11px; padding: 0; margin-top: 2px; }
.ww-log-detail { margin-top: 6px; padding: 8px 10px; background: var(--color-code-bg); border-radius: 6px; font-family: var(--font-mono); font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow: auto; }
`;

/* -------------------------------------------------------------------------- */
/* JS                                                                          */
/* -------------------------------------------------------------------------- */

const SCRIPT = `
(function() {
  'use strict';

  // 当前选中的流水线摘要（{ key, label, sublabel, hasLocalProject, localProject }）。
  // 由侧栏的流水线加载逻辑设置，openArtModal / startLocalProject 共享读取。
  var currentPipeline = null;

  // analyze/compare 三个输入位上"已加入但未下载"的蓝盾制品引用。
  // 点"开始"时才把引用发给后端触发下载；null 表示该位用本地路径输入。
  var pendingSources = { 'analyze-path': null, 'compare-left': null, 'compare-right': null };

  // ---------- 工具函数 ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    if (kids) [].concat(kids).forEach(function(k) {
      if (k == null || k === false) return;
      n.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
    });
    return n;
  }
  function fmtBytes(b) {
    if (!isFinite(b) || b < 0) return '0 B';
    var u = ['B','KiB','MiB','GiB','TiB']; var i = 0; var v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v.toFixed(0) : v.toFixed(2)) + ' ' + u[i];
  }

  // ---------- 蓝盾制品引用（加入分析/对比） ----------
  // 把 (构建, 制品) 转成发给后端的制品引用对象（此刻不下载）。
  function devopsRefFor(build, a) {
    return {
      type: 'devops',
      pipeline: currentPipeline ? currentPipeline.key : undefined,
      buildId: build.buildId,
      buildNum: (build.buildNum != null ? build.buildNum : null),
      artifactPath: a.path,
      name: a.name,
      artifactoryType: a.artifactoryType,
      size: (typeof a.size === 'number' ? a.size : null),
    };
  }
  // 在某个输入位的 row-status 里渲染引用 chip（或清掉）。有引用时禁用文本框。
  function renderSourceChip(inputId) {
    var input = document.getElementById(inputId);
    var box = document.querySelector('.row-status[data-status-for="' + inputId + '"]');
    if (!input || !box) return;
    var ref = pendingSources[inputId];
    box.className = 'row-status';
    box.innerHTML = '';
    if (ref) {
      input.value = '';
      input.disabled = true;
      var text = '☁ ' + ref.name
        + (ref.buildNum != null ? (' · #' + ref.buildNum) : '')
        + (ref.size != null ? (' · ' + fmtBytes(ref.size)) : '')
        + ' · 点开始后才下载';
      var x = el('button', { class: 'devops-ref-x', title: '移除引用' }, '✕');
      x.addEventListener('click', function(){ clearDevopsSource(inputId); });
      box.appendChild(el('span', { class: 'devops-ref-chip' }, [text, x]));
    } else {
      input.disabled = false;
    }
  }
  function setDevopsSource(inputId, ref) { pendingSources[inputId] = ref; renderSourceChip(inputId); }
  function clearDevopsSource(inputId) {
    if (pendingSources[inputId]) { pendingSources[inputId] = null; renderSourceChip(inputId); }
  }
  // 程序化切到某个 tab（analyze | compare）。
  function activateTab(name) {
    var tb = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tb) tb.click();
  }
  // 制品行点"加入"：记录引用 + 切 tab + 关弹窗。
  function addArtifactToSlot(slot, build, a) {
    var inputId = slot === 'analyze' ? 'analyze-path' : (slot === 'left' ? 'compare-left' : 'compare-right');
    setDevopsSource(inputId, devopsRefFor(build, a));
    activateTab(slot === 'analyze' ? 'analyze' : 'compare');
    closeArtModal();
  }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var pad = function(n){return String(n).padStart(2,'0');};
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtDuration(ms) {
    if (!isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return ms + ' ms';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 2 : 1) + ' s';
    var m = Math.floor(s / 60);
    var rs = Math.round(s - m * 60);
    if (m < 60) return m + ' m ' + pad2(rs) + ' s';
    var h = Math.floor(m / 60);
    var rm = m - h * 60;
    return h + ' h ' + pad2(rm) + ' m';
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function jobDurationMs(j) {
    if (!j || !j.createdAt) return NaN;
    var start = new Date(j.createdAt).getTime();
    if (!isFinite(start)) return NaN;
    var endIso = j.finishedAt || (j.status === 'pending' || j.status === 'running' ? new Date().toISOString() : null);
    if (!endIso) return NaN;
    var end = new Date(endIso).getTime();
    if (!isFinite(end)) return NaN;
    return Math.max(0, end - start);
  }
  async function jsonFetch(url, opts) {
    var r = await fetch(url, opts);
    var ct = r.headers.get('content-type') || '';
    var data = ct.indexOf('application/json') >= 0 ? await r.json() : await r.text();
    if (!r.ok) {
      var msg = (data && typeof data === 'object' && data.message) ? data.message : ('HTTP ' + r.status);
      var e = new Error(msg); e.data = data; e.status = r.status; throw e;
    }
    return data;
  }

  // ---------- Platform 状态 ----------
  // 注入自 server：window.__KINGSDK__.{defaultPlatform, platforms}
  var KS = (window.__KINGSDK__ || { defaultPlatform: 'harmony', platforms: [] });
  var PLATFORM_DEFS = KS.platforms || [];
  var currentPlatform = KS.defaultPlatform || 'harmony';
  // devops-only：由启动脚本（Linux 部署）设的标记。开启后分析/对比只能用蓝盾制品，
  // 禁用本地路径输入（隐藏浏览/拖拽、路径框只读、文案与校验同步切换）。
  var DEVOPS_ONLY = !!KS.devopsOnly;
  var historyFilter = 'all'; // 'all' | 'harmony' | 'android' | 'ios'
  /** 缓存每个平台 extras 列表（首次拉取后存下，避免 segment 来回切重复网络请求） */
  var extrasCache = Object.create(null);

  function platformDef(id) {
    for (var i = 0; i < PLATFORM_DEFS.length; i++) if (PLATFORM_DEFS[i].id === id) return PLATFORM_DEFS[i];
    return null;
  }
  function platformLabel(id) {
    var d = platformDef(id);
    return d ? d.label : id;
  }

  /**
   * 切换当前平台：
   *  - 更新 segment active class
   *  - 更新 .container 的 data-platform（便于将来 CSS 区分）
   *  - 更新各 [data-browse-target] 按钮的 data-filter
   *  - 更新 analyze 输入框 placeholder
   *  - 清空所有路径输入 + 反查状态（避免拿着 .hap 路径切到 Android 误用）
   *  - 拉新的 extras 列表替换两个 host
   */
  async function setPlatform(next) {
    if (!next || next === currentPlatform) return;
    var def = platformDef(next);
    if (!def || !def.enabled) return;
    currentPlatform = next;

    $$('.platform-chip').forEach(function(c){
      c.classList.toggle('active', c.getAttribute('data-platform') === next);
    });
    var container = $('#container');
    if (container) container.setAttribute('data-platform', next);

    $$('button[data-browse-target]').forEach(function(b){
      b.setAttribute('data-filter', def.fileFilter);
    });
    var analyzeInput = $('#analyze-path');
    if (analyzeInput) {
      analyzeInput.value = '';
      analyzeInput.setAttribute('placeholder', def.placeholder);
    }
    var leftInput = $('#compare-left');
    var rightInput = $('#compare-right');
    if (leftInput) leftInput.value = '';
    if (rightInput) rightInput.value = '';
    // 切平台清掉已加入的蓝盾引用（不同平台包不可混用）
    ['analyze-path','compare-left','compare-right'].forEach(function(id){ pendingSources[id] = null; });
    ['analyze-path','compare-left','compare-right'].forEach(function(id){
      var inp = document.getElementById(id); if (inp) inp.disabled = false;
    });
    $$('.row-status').forEach(function(s){ s.textContent = ''; s.className = 'row-status'; });
    $$('.error').forEach(function(e){ e.hidden = true; e.textContent = ''; });

    await loadAndRenderExtras(next);
  }

  /**
   * 拉取并渲染 extras（两个 host：analyze / compare）。
   * 网络异常时打日志 + 在 host 留个 placeholder 提示，但不阻断主流程。
   */
  async function loadAndRenderExtras(p) {
    try {
      var list = extrasCache[p];
      if (!list) {
        var data = await jsonFetch('/api/extras?platform=' + encodeURIComponent(p));
        list = (data && Array.isArray(data.extras)) ? data.extras : [];
        extrasCache[p] = list;
      }
      ['analyze', 'compare'].forEach(function(kind){
        var host = document.querySelector('[data-extras-host="' + kind + '"]');
        if (!host) return;
        host.innerHTML = renderExtrasBlockClient(list, kind);
      });
    } catch (e) {
      console.warn('[workbench] 拉取 extras 失败:', e);
      ['analyze', 'compare'].forEach(function(kind){
        var host = document.querySelector('[data-extras-host="' + kind + '"]');
        if (host) host.innerHTML = '<div class="extras-block"><div class="extras-title muted">该平台暂无可选深度分析</div></div>';
      });
    }
  }

  /** 客户端版本的 extras 渲染（与 server 端 renderExtrasBlock 输出形态保持一致） */
  function renderExtrasBlockClient(extras, kind) {
    if (!extras || extras.length === 0) return '';
    function esc(s) {
      return String(s).replace(/[&<>"']/g, function(c){
        return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
      });
    }
    var items = extras.map(function(e){
      var id = 'extra-' + kind + '-' + esc(e.id);
      return '<label class="extras-item" for="' + id + '">'
        + '<input type="checkbox" id="' + id + '" data-extra-' + kind + '="' + esc(e.id) + '" checked />'
        + '<div class="extras-item-text">'
        +   '<div class="extras-item-name">' + esc(e.name) + ' <code>' + esc(e.id) + '</code></div>'
        +   '<div class="extras-item-desc">' + esc(e.description) + '</div>'
        + '</div>'
        + '</label>';
    }).join('');
    return '<div class="extras-block" data-extras-block="' + kind + '">'
      + '<div class="extras-title">可选深度分析（多选 · 默认开启，取消勾选可加速本次任务）</div>'
      + '<div class="extras-list">' + items + '</div>'
      + '</div>';
  }

  // 绑定 platform segment 点击
  $$('.platform-chip').forEach(function(c){
    c.addEventListener('click', function(){
      var id = c.getAttribute('data-platform');
      setPlatform(id);
    });
  });

  // 历史过滤 chip
  $$('.hist-filter-chip').forEach(function(c){
    c.addEventListener('click', function(){
      var v = c.getAttribute('data-hist-filter') || 'all';
      historyFilter = v;
      $$('.hist-filter-chip').forEach(function(x){ x.classList.toggle('active', x === c); });
      // 不重新拉，仅用最近一次 list 重渲染
      if (lastJobsList) renderJobs(lastJobsList);
    });
  });

  // ---------- 蓝盾流水线构建列表（左侧栏） ----------
  (function() {
    var listBox = $('#devops-list');
    if (!listBox) return;
    var pipelineSel = $('#devops-pipeline');
    var subEl = $('#devops-sub');
    var statusSel = $('#devops-status');
    var refreshBtn = $('#devops-refresh');
    var prevBtn = $('#devops-prev');
    var nextBtn = $('#devops-next');
    var pageInfo = $('#devops-page-info');

    var page = 1;
    var pageSize = 20;
    var total = 0;
    var loading = false;

    function pipelineSubText(p) {
      if (!p) return '';
      return p.sublabel ? (p.label + ' · ' + p.sublabel) : p.label;
    }

    // 先拉流水线清单填充下拉；成功后再加载默认流水线的构建。
    async function loadPipelines() {
      try {
        var data = await jsonFetch('/api/devops/pipelines');
        var pipelines = data.pipelines || [];
        if (!pipelines.length) {
          subEl.textContent = '未配置流水线';
          listBox.innerHTML = '';
          listBox.appendChild(el('div', { class: 'err' }, '未配置流水线，请编辑 pipelines.config.json'));
          return;
        }
        pipelineSel.innerHTML = '';
        pipelines.forEach(function(p) {
          pipelineSel.appendChild(el('option', { value: p.key }, p.label + (p.sublabel ? (' · ' + p.sublabel) : '')));
        });
        // 多条时才显示下拉；单条直接用副标题展示
        pipelineSel.hidden = pipelines.length < 2;
        var defKey = data.defaultKey || pipelines[0].key;
        pipelineSel.value = defKey;
        currentPipeline = pipelines.filter(function(p){ return p.key === defKey; })[0] || pipelines[0];
        subEl.textContent = pipelineSubText(currentPipeline);
        pipelineSel.addEventListener('change', function() {
          currentPipeline = pipelines.filter(function(p){ return p.key === pipelineSel.value; })[0] || null;
          subEl.textContent = pipelineSubText(currentPipeline);
          page = 1;
          loadBuilds();
        });
        loadBuilds();
      } catch (e) {
        subEl.textContent = '加载流水线失败';
        listBox.innerHTML = '';
        listBox.appendChild(el('div', { class: 'err' }, '加载流水线失败：' + e.message));
      }
    }

    function buildStatusLabel(s) {
      var m = { SUCCEED:'成功', STAGE_SUCCESS:'阶段成功', FAILED:'失败', RUNNING:'运行中', QUEUE:'排队中', CANCELED:'已取消' };
      return m[s] || s || '-';
    }
    function fmtBuildTime(ms) {
      if (!ms) return '-';
      return fmtTime(new Date(ms).toISOString());
    }

    async function loadBuilds() {
      if (loading) return;
      loading = true;
      listBox.innerHTML = '';
      listBox.appendChild(el('div', { class: 'muted' }, '加载中…'));
      prevBtn.disabled = true; nextBtn.disabled = true;
      try {
        var qs = '?page=' + page + '&pageSize=' + pageSize;
        var st = statusSel.value;
        if (st) qs += '&status=' + encodeURIComponent(st);
        if (currentPipeline) qs += '&pipeline=' + encodeURIComponent(currentPipeline.key);
        var data = await jsonFetch('/api/devops/builds' + qs);
        total = data.total || 0;
        renderBuilds(data.builds || []);
      } catch (e) {
        listBox.innerHTML = '';
        listBox.appendChild(el('div', { class: 'err' }, '加载构建失败：' + e.message));
      } finally {
        loading = false;
        updatePager();
      }
    }

    function updatePager() {
      var totalPages = Math.max(1, Math.ceil(total / pageSize));
      pageInfo.textContent = '第 ' + page + '/' + totalPages + ' 页 · 共 ' + total;
      prevBtn.disabled = loading || page <= 1;
      nextBtn.disabled = loading || page >= totalPages;
    }

    function renderBuilds(builds) {
      listBox.innerHTML = '';
      if (!builds.length) {
        listBox.appendChild(el('div', { class: 'muted' }, '该筛选下暂无构建'));
        return;
      }
      builds.forEach(function(b) {
        var num = (b.buildNum != null) ? ('#' + b.buildNum) : '#-';
        var row = el('div', { class: 'build-row' }, [
          el('div', { class: 'build-num' }, num),
          el('div', { class: 'build-meta' }, [
            el('div', { class: 'build-meta-user' }, b.userId || '-'),
            el('div', { class: 'build-meta-line', title: b.buildId }, fmtBuildTime(b.startTime)),
          ]),
          el('span', { class: 'build-status ' + (b.status || ''), title: buildStatusLabel(b.status) }, buildStatusLabel(b.status)),
        ]);
        row.addEventListener('click', function() { openArtModal(b); });
        listBox.appendChild(el('div', { class: 'build-item' }, [row]));
      });
    }

    statusSel.addEventListener('change', function() { page = 1; loadBuilds(); });
    refreshBtn.addEventListener('click', function() { loadBuilds(); });
    prevBtn.addEventListener('click', function() { if (page > 1) { page--; loadBuilds(); } });
    nextBtn.addEventListener('click', function() {
      var totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (page < totalPages) { page++; loadBuilds(); }
    });

    loadPipelines();
  })();

  // ---------- 复制 & 打开历史目录 ----------
  (function() {
    var copyBtn = $('#btn-copy-cache-dir');
    var openBtn = $('#btn-open-cache-dir');
    var msg = $('#cache-dir-msg');
    var path = $('#cache-dir-path').textContent;
    var msgTimer;
    function showMsg(text, ok) {
      msg.textContent = text;
      msg.style.color = ok ? 'var(--color-success)' : 'var(--color-danger)';
      clearTimeout(msgTimer);
      msgTimer = setTimeout(function(){ msg.textContent = ''; }, 2000);
    }
    copyBtn.addEventListener('click', function() {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(path).then(function(){ showMsg('已复制', true); }, function(){ showMsg('复制失败', false); });
      } else {
        try {
          var ta = document.createElement('textarea');
          ta.value = path; document.body.appendChild(ta); ta.select(); document.execCommand('copy');
          document.body.removeChild(ta); showMsg('已复制', true);
        } catch(e) { showMsg('复制失败', false); }
      }
    });
    openBtn.addEventListener('click', async function() {
      try {
        await jsonFetch('/api/open-cache-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        showMsg('已打开', true);
      } catch(e) {
        showMsg(e.message || '打开失败', false);
      }
    });
  })();

  // ---------- Tab 切换 ----------
  $$('.tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var name = btn.getAttribute('data-tab');
      $$('.tab').forEach(function(b){ b.classList.toggle('active', b === btn); });
      $$('section[data-section]').forEach(function(s){
        s.hidden = s.getAttribute('data-section') !== name;
      });
      // 企业微信测试页是独立连通性工具，与「平台 / 包分析历史」无关：进入时隐藏它们，离开时恢复
      var onWework = name === 'wework';
      var seg = document.querySelector('.platform-segment');
      var hist = document.getElementById('history-panel');
      if (seg) seg.hidden = onWework;
      if (hist) hist.hidden = onWework;
    });
  });

  // ---------- devops-only 模式：禁用本地路径输入 ----------
  (function applyDevopsOnly() {
    if (!DEVOPS_ONLY) return;
    // 隐藏所有"浏览…"按钮
    $$('button[data-browse-target]').forEach(function(b){ b.hidden = true; });
    // 路径框只读 + 提示从左侧蓝盾构建加入
    ['analyze-path','compare-left','compare-right'].forEach(function(id){
      var inp = document.getElementById(id);
      if (!inp) return;
      inp.readOnly = true;
      inp.classList.add('devops-locked');
      inp.value = '';
      inp.setAttribute('placeholder', '← 从左侧蓝盾构建选择制品「加入」');
    });
    // 隐藏"拖到这里"提示
    $$('.drop-row-hint').forEach(function(h){ h.hidden = true; });
    // 切换两个面板的说明文案
    var aHint = document.querySelector('section[data-section="analyze"] .hint');
    if (aHint) aHint.innerHTML = '当前为<b>蓝盾包模式</b>：请从左侧流水线构建中选择制品「<b>分析</b>」加入。不支持本地路径输入。';
    var cHint = document.querySelector('section[data-section="compare"] .hint');
    if (cHint) cHint.innerHTML = '当前为<b>蓝盾包模式</b>：请从左侧流水线构建中分别把制品「<b>对比左</b>」「<b>对比右</b>」加入。不支持本地路径输入。';
  })();

  // ---------- Extras（可选深度分析多选） ----------
  // 收集当前 kind（'analyze' | 'compare'）下勾选的 analyzer id
  function collectExtras(kind) {
    var attr = 'data-extra-' + kind;
    return $$('input[' + attr + ']').filter(function(b){ return b.checked; }).map(function(b){ return b.getAttribute(attr); });
  }

  // ---------- Analyze / Compare 按钮 ----------
  $('#btn-analyze').addEventListener('click', async function() {
    var ref = pendingSources['analyze-path'];
    var path = $('#analyze-path').value.trim();
    var errBox = $('#analyze-error');
    errBox.hidden = true; errBox.textContent = '';
    if (!ref && !path) {
      errBox.hidden = false;
      errBox.textContent = DEVOPS_ONLY ? '请从左侧蓝盾构建选择制品「分析」加入' : '请填路径、点"浏览…"，或从蓝盾制品"加入分析"';
      return;
    }
    var extras = collectExtras('analyze');
    try {
      var body = { platform: currentPlatform };
      if (ref) body.source = ref; else body.path = path;
      if (extras.length > 0) body.extras = extras;
      var r = await jsonFetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      console.log('[workbench] analyze job started', r, 'platform=', currentPlatform, 'extras=', extras);
      refreshJobs();
    } catch (e) {
      errBox.hidden = false; errBox.textContent = e.message;
    }
  });

  $('#btn-compare').addEventListener('click', async function() {
    var lref = pendingSources['compare-left'];
    var rref = pendingSources['compare-right'];
    var leftPath = $('#compare-left').value.trim();
    var rightPath = $('#compare-right').value.trim();
    var errBox = $('#compare-error');
    errBox.hidden = true; errBox.textContent = '';
    if ((!lref && !leftPath) || (!rref && !rightPath)) {
      errBox.hidden = false;
      errBox.textContent = DEVOPS_ONLY ? '两侧都需要从左侧蓝盾构建「对比左 / 对比右」加入' : '两侧都需要：本地路径或蓝盾制品引用';
      return;
    }
    var extras = collectExtras('compare');
    try {
      var body = { platform: currentPlatform };
      if (lref) body.left = lref; else body.leftPath = leftPath;
      if (rref) body.right = rref; else body.rightPath = rightPath;
      if (extras.length > 0) body.extras = extras;
      var r = await jsonFetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      console.log('[workbench] compare job started', r, 'platform=', currentPlatform, 'extras=', extras);
      refreshJobs();
    } catch (e) {
      errBox.hidden = false; errBox.textContent = e.message;
    }
  });

  // ---------- 历史轮询 ----------
  var jobsBox = $('#jobs');
  /** 缓存最近一次拉到的 list，供历史 filter chip 切换时本地重渲染 */
  var lastJobsList = null;
  async function refreshJobs() {
    try {
      var data = await jsonFetch('/api/jobs');
      lastJobsList = data.jobs || [];
      renderJobs(lastJobsList);
    } catch (e) {
      jobsBox.innerHTML = '';
      jobsBox.appendChild(el('div', { class: 'error' }, '加载历史失败: ' + e.message));
    }
  }
  function renderJobs(list) {
    jobsBox.innerHTML = '';
    var filtered = (historyFilter === 'all')
      ? list
      : list.filter(function(j){ return (j.platform || 'harmony') === historyFilter; });
    if (filtered.length === 0) {
      var emptyMsg = (historyFilter === 'all')
        ? '暂无任务。试试上面的"开始分析"或"开始对比"按钮。'
        : '当前筛选（' + platformLabel(historyFilter) + '）下暂无任务。';
      jobsBox.appendChild(el('div', { class: 'muted' }, emptyMsg));
      return;
    }
    filtered.forEach(function(j) {
      var sub = j.kind + ' · ' + j.inputs.join('  ←→  ');

      // 时间行：开始 / 完成（或"运行中"）/ 耗时，三段式更醒目
      var timeChips = [];
      timeChips.push(el('span', { class: 'time-chip' }, [
        el('span', { class: 'time-chip-label' }, '开始'),
        el('span', { class: 'time-chip-value' }, fmtTime(j.createdAt) || '—'),
      ]));
      var endLabel = j.status === 'done' ? '完成' : (j.status === 'error' ? '失败' : '运行中');
      var endValue = j.finishedAt ? fmtTime(j.finishedAt) : (j.status === 'pending' || j.status === 'running' ? '…' : '—');
      timeChips.push(el('span', { class: 'time-chip ' + j.status }, [
        el('span', { class: 'time-chip-label' }, endLabel),
        el('span', { class: 'time-chip-value' }, endValue),
      ]));
      var durMs = jobDurationMs(j);
      if (isFinite(durMs)) {
        var durText = fmtDuration(durMs);
        var stillRunning = j.status === 'pending' || j.status === 'running';
        timeChips.push(el('span', { class: 'time-chip dur' + (stillRunning ? ' running' : '') }, [
          el('span', { class: 'time-chip-label' }, '耗时'),
          el('span', { class: 'time-chip-value' }, stillRunning ? (durText + '…') : durText),
        ]));
      }

      var linkGroups = [];
      if (j.status === 'done' && j.outputs) {
        // 主产物：analyze=报告 / compare=diff
        var mainLabel = j.kind === 'compare' ? '对比' : '报告';
        var mainGroup = el('div', { class: 'link-group' }, [
          el('span', { class: 'link-group-label' }, mainLabel + ':'),
          el('a', { href: j.outputs.htmlUrl, target: '_blank', rel: 'noopener' }, 'HTML'),
          el('a', { href: j.outputs.jsonUrl, target: '_blank', rel: 'noopener' }, 'JSON'),
        ]);
        linkGroups.push(mainGroup);

        // compare 才有 sides；老 compare job 升级前没写 left/right.report.*，前端按需展示
        if (j.kind === 'compare' && j.outputs.sides) {
          var sides = j.outputs.sides;
          if (sides.left) {
            linkGroups.push(el('div', { class: 'link-group side-left' }, [
              el('span', { class: 'link-group-label', title: sides.left.sourcePath || '' }, '左·单独分析:'),
              el('a', { href: sides.left.htmlUrl, target: '_blank', rel: 'noopener' }, 'HTML'),
              el('a', { href: sides.left.jsonUrl, target: '_blank', rel: 'noopener' }, 'JSON'),
            ]));
          }
          if (sides.right) {
            linkGroups.push(el('div', { class: 'link-group side-right' }, [
              el('span', { class: 'link-group-label', title: sides.right.sourcePath || '' }, '右·单独分析:'),
              el('a', { href: sides.right.htmlUrl, target: '_blank', rel: 'noopener' }, 'HTML'),
              el('a', { href: sides.right.jsonUrl, target: '_blank', rel: 'noopener' }, 'JSON'),
            ]));
          }
        }
      }
      var middle = el('div', null, [
        el('div', { class: 'label' }, j.label || j.kind),
        el('div', { class: 'sub' }, sub),
        el('div', { class: 'time-row' }, timeChips),
        (j.status === 'running' && j.note) ? el('div', { class: 'job-note' }, j.note) : null,
        j.status === 'error' ? el('div', { class: 'err-msg' }, 'Error: ' + (j.error || 'unknown')) : null,
      ]);

      var isActive = j.status === 'pending' || j.status === 'running';
      var delBtn = el('button', {
        class: 'btn-delete',
        title: isActive ? '任务进行中；想强制删点这里' : '删除该条历史及其磁盘产物',
      }, '×');
      delBtn.addEventListener('click', function() { onDeleteJob(j, delBtn); });

      var jobPlatform = j.platform || 'harmony';
      var card = el('div', { class: 'job' }, [
        el('div', { class: 'badges' }, [
          el('span', { class: 'badge ' + j.status }, j.status),
          el('span', { class: 'badge platform ' + jobPlatform, title: '平台：' + platformLabel(jobPlatform) }, platformLabel(jobPlatform)),
        ]),
        middle,
        el('div', { class: 'actions-col' }, [
          el('div', { class: 'links' }, linkGroups),
          delBtn,
        ]),
      ]);
      jobsBox.appendChild(card);
    });
  }
  refreshJobs();
  setInterval(refreshJobs, 1500);

  // ---------- 删除单条历史 ----------
  async function onDeleteJob(job, btn) {
    var isActive = job.status === 'pending' || job.status === 'running';
    var msg = isActive
      ? '任务还在 ' + job.status + '，确认强制删除？\\n这会立刻删掉它的元信息和已写入的产物。'
      : '确认删除"' + (job.label || job.kind) + '"？这会同时删磁盘上的报告产物。';
    if (!confirm(msg)) return;

    btn.disabled = true;
    try {
      var url = '/api/jobs/' + encodeURIComponent(job.id) + (isActive ? '?force=true' : '');
      await jsonFetch(url, { method: 'DELETE' });
      await refreshJobs();
    } catch (e) {
      // 即便后端返回 409，jsonFetch 也会抛错；展示给用户
      alert('删除失败：' + e.message);
      btn.disabled = false;
    }
  }

  // ---------- Browse modal ----------
  var modal = $('#picker');
  var modalList = $('#picker-list');
  var modalCwd = $('#picker-cwd');
  var modalStatus = $('#picker-status');
  var pickerTargetInput = null;
  var pickerFilters = []; // 例如 ['.hap','.json']
  var pickerMode = 'file'; // 'file' | 'dir'
  var pickerDirCb = null;

  function openPicker(targetInputId, filterAttr) {
    pickerMode = 'file';
    pickerDirCb = null;
    $('#picker-pick-dir').hidden = true;
    $('#picker-title').textContent = '选择 Hap / Report';
    pickerTargetInput = $('#' + targetInputId);
    pickerFilters = (filterAttr || '').split(',').map(function(s){return s.trim().toLowerCase();}).filter(Boolean);
    modal.hidden = false;
    var initial = (pickerTargetInput && pickerTargetInput.value.trim()) || '';
    // 如果已经有路径，尝试以它的父目录开始；否则从 ROOT 开始
    if (initial && /[\\\\\\/]/.test(initial)) {
      var parent = initial.replace(/[\\\\\\/][^\\\\\\/]*$/, '');
      navigate(parent || initial);
    } else {
      navigate('');
    }
  }
  function closePicker() {
    modal.hidden = true;
    pickerTargetInput = null;
    pickerMode = 'file';
    pickerDirCb = null;
    $('#picker-pick-dir').hidden = true;
    $('#picker-title').textContent = '选择 Hap / Report';
  }
  $('#picker-close').addEventListener('click', closePicker);
  modal.addEventListener('click', function(e){ if (e.target === modal) closePicker(); });
  $('#picker-up').addEventListener('click', function() { if (currentResult && currentResult.parent) navigate(currentResult.parent); });
  $('#picker-home').addEventListener('click', function() { if (currentResult && currentResult.home) navigate(currentResult.home); });
  $('#picker-root').addEventListener('click', function() { navigate(''); });
  modalCwd.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); navigate(modalCwd.value.trim()); }
  });

  $$('button[data-browse-target]').forEach(function(b){
    b.addEventListener('click', function() {
      openPicker(b.getAttribute('data-browse-target'), b.getAttribute('data-filter') || '');
    });
  });

  var currentResult = null;
  async function navigate(dir) {
    modalStatus.textContent = '加载中…';
    modalList.innerHTML = '';
    try {
      var qs = dir ? ('?dir=' + encodeURIComponent(dir)) : '';
      var data = await jsonFetch('/api/browse' + qs);
      currentResult = data;
      modalCwd.value = data.isRootList ? '' : data.cwd;
      // 目录选择模式：根列表层不能"选择当前目录"
      $('#picker-pick-dir').disabled = !!data.isRootList;
      var entries = data.entries;
      if (entries.length === 0) {
        modalStatus.textContent = data.isRootList ? '没有可用盘符' : '空目录 · ' + data.cwd;
      } else {
        var matches = 0;
        entries.forEach(function(ent) {
          var matched = !ent.isDir && pickerFilters.length > 0 && pickerFilters.indexOf(ent.ext || '') >= 0;
          var dimmed = !ent.isDir && pickerFilters.length > 0 && !matched;
          if (matched) matches++;
          var item = el('div', { class: 'picker-item' + (dimmed ? ' dim' : (matched ? ' match' : '')) }, [
            el('span', { class: 'icon' }, ent.isDir ? '📁' : (matched ? '📦' : '·')),
            el('span', { class: 'name' }, ent.name),
            el('span', { class: 'size' }, ent.isDir ? '' : (typeof ent.size === 'number' ? fmtBytes(ent.size) : '?')),
            el('span', { class: 'mtime' }, ent.mtime ? fmtTime(ent.mtime) : ''),
          ]);
          item.addEventListener('click', function() {
            if (ent.isDir) {
              navigate(ent.path);
            } else {
              if (pickerMode === 'dir') return; // 目录选择模式下忽略文件点击
              if (pickerTargetInput) { clearDevopsSource(pickerTargetInput.id); pickerTargetInput.value = ent.path; }
              closePicker();
            }
          });
          modalList.appendChild(item);
        });
        modalStatus.textContent = data.cwd + ' · ' + entries.length + ' 项' + (pickerFilters.length ? (' · ' + matches + ' 个匹配 ' + pickerFilters.join('/')) : '');
      }
    } catch (e) {
      modalStatus.textContent = '错误：' + e.message;
    }
  }

  // ESC 关闭 modal
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !modal.hidden) closePicker();
  });

  // ---------- 目录选择模式（配置本地工程用） ----------
  // 复用 picker modal，但只允许选目录：底部"选择当前目录"按钮回传 currentResult.cwd
  function openDirPicker(onPick) {
    pickerMode = 'dir';
    pickerDirCb = onPick;
    pickerTargetInput = null;
    pickerFilters = [];
    $('#picker-title').textContent = '选择本地工程根目录';
    $('#picker-pick-dir').hidden = false;
    $('#picker-pick-dir').disabled = true;
    modal.hidden = false;
    // 从已有结果的目录继续，否则从根开始
    if (currentResult && !currentResult.isRootList && currentResult.cwd) navigate(currentResult.cwd);
    else navigate('');
  }
  $('#picker-pick-dir').addEventListener('click', function() {
    if (pickerMode !== 'dir' || !currentResult || currentResult.isRootList) return;
    var dir = currentResult.cwd;
    var cb = pickerDirCb;
    closePicker();
    if (cb) cb(dir);
  });

  // ---------- 构建制品列表 modal ----------
  var artModal = $('#art-modal');
  var artListBox = $('#art-list');
  var artActions = $('#art-actions');
  var artTitle = $('#art-title');
  var artStatus = $('#art-status');
  var artReqSeq = 0;
  function closeArtModal() { artModal.hidden = true; }
  $('#art-close').addEventListener('click', closeArtModal);
  artModal.addEventListener('click', function(e){ if (e.target === artModal) closeArtModal(); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !artModal.hidden) closeArtModal(); });

  async function openArtModal(build) {
    var seq = ++artReqSeq;
    artTitle.textContent = '制品列表 · #' + (build.buildNum != null ? build.buildNum : '-');
    artActions.innerHTML = '';
    artListBox.innerHTML = '';
    artStatus.textContent = '加载制品…';
    artModal.hidden = false;
    try {
      var artQs = '?buildId=' + encodeURIComponent(build.buildId);
      if (currentPipeline) artQs += '&pipeline=' + encodeURIComponent(currentPipeline.key);
      var data = await jsonFetch('/api/devops/artifacts' + artQs);
      if (seq !== artReqSeq) return; // 期间已切到其它构建
      var arts = data.artifacts || [];
      if (!arts.length) { artStatus.textContent = '该构建暂无制品'; return; }
      // 仅当该流水线配置了 localProject 时才尝试检测产物对（后缀由配置给出，用 endsWith 区分变体）
      var lp = currentPipeline && currentPipeline.localProject;
      var hapArt = lp ? arts.find(function(a){ return (a.name || '').toLowerCase().endsWith(lp.hapSuffix.toLowerCase()); }) : null;
      var zipsArt = lp ? arts.find(function(a){ return (a.name || '').toLowerCase().endsWith(lp.zipsSuffix.toLowerCase()); }) : null;
      if (hapArt && zipsArt) {
        var cfgBtn = el('button', { class: 'btn-config-proj' }, '⚙ 配置本地工程');
        cfgBtn.addEventListener('click', function() {
          closeArtModal();
          openDirPicker(function(dir) {
            startLocalProject(build.buildId, build.buildNum, dir);
          });
        });
        var hint = el('div', { class: 'artifact-config-hint' },
          '选择本地目录后：下载 ' + hapArt.name + ' 与 ' + zipsArt.name + '，解压 .zips 并用 hap 内 Data 覆盖工程');
        artActions.appendChild(el('div', { class: 'artifact-actions' }, [cfgBtn, hint]));
      }
      // 只有当前平台的安装包（.hap / .apk,.aab / .ipa）才能加入分析/对比；
      // .json 报告等其它制品不显示按钮（fileFilter 里去掉 .json）。
      var pkgDef = platformDef(currentPlatform);
      var pkgExts = ((pkgDef && pkgDef.fileFilter) || '')
        .split(',').map(function(s){ return s.trim().toLowerCase(); })
        .filter(function(e){ return e && e !== '.json'; });
      function isAnalyzable(name) {
        var n = (name || '').toLowerCase();
        return pkgExts.some(function(e){ return n.endsWith(e); });
      }
      function pkgExtOf(name) {
        var n = (name || '').toLowerCase();
        for (var i = 0; i < pkgExts.length; i++) {
          if (n.endsWith(pkgExts[i])) return pkgExts[i].replace('.', '').toUpperCase();
        }
        return '';
      }
      arts.forEach(function(a) {
        var pkg = isAnalyzable(a.name);
        var actionsCol;
        if (pkg) {
          var addBtn = el('button', { class: 'artifact-add-btn', title: '加入分析' }, '分析');
          addBtn.addEventListener('click', function(){ addArtifactToSlot('analyze', build, a); });
          var leftBtn = el('button', { class: 'artifact-add-btn', title: '加入对比·左(旧)' }, '对比左');
          leftBtn.addEventListener('click', function(){ addArtifactToSlot('left', build, a); });
          var rightBtn = el('button', { class: 'artifact-add-btn', title: '加入对比·右(新)' }, '对比右');
          rightBtn.addEventListener('click', function(){ addArtifactToSlot('right', build, a); });
          actionsCol = el('span', { class: 'artifact-add-btns' }, [addBtn, leftBtn, rightBtn]);
        } else {
          actionsCol = el('span', { class: 'artifact-add-btns' });
        }
        var nameKids = [];
        if (pkg) nameKids.push(el('span', { class: 'artifact-pkg-badge' }, pkgExtOf(a.name)));
        nameKids.push(el('span', { class: 'artifact-name', title: a.path }, a.name));
        artListBox.appendChild(el('div', { class: 'artifact-item' + (pkg ? ' pkg' : '') }, [
          el('span', { class: 'artifact-name-cell' }, nameKids),
          el('span', { class: 'artifact-size' }, typeof a.size === 'number' ? fmtBytes(a.size) : ''),
          actionsCol,
        ]));
      });
      artStatus.textContent = arts.length + ' 个制品'
        + (pkgExts.length ? ('（可加入分析/对比: ' + pkgExts.join('/') + '）') : '');
    } catch (e) {
      if (seq !== artReqSeq) return;
      artStatus.textContent = '加载制品失败：' + e.message;
    }
  }

  // ---------- 配置本地工程：启动 + 进度轮询 ----------
  var lpModal = $('#lp-modal');
  var lpTimer = null;

  async function startLocalProject(buildId, buildNum, targetDir) {
    openLpModal(buildNum, targetDir);
    try {
      var r = await jsonFetch('/api/local-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipeline: currentPipeline ? currentPipeline.key : undefined,
          buildId: buildId,
          buildNum: buildNum,
          targetDir: targetDir,
        }),
      });
      pollLp(r.jobId);
    } catch (e) {
      lpFail(e.message || '启动失败');
    }
  }

  function openLpModal(buildNum, targetDir) {
    $('#lp-meta').textContent = '构建 ' + (buildNum != null ? ('#' + buildNum) : '-') + '  →  ' + targetDir;
    $('#lp-steps').innerHTML = '';
    $('#lp-error').hidden = true; $('#lp-error').textContent = '';
    $('#lp-result').hidden = true; $('#lp-result').textContent = '';
    $('#lp-status').textContent = '准备中…';
    $('#lp-close').disabled = true;
    lpModal.hidden = false;
  }

  function renderLpSteps(steps) {
    var box = $('#lp-steps');
    box.innerHTML = '';
    var iconMap = { pending: '○', running: '◐', done: '✓', error: '✗', skipped: '–' };
    (steps || []).forEach(function(s) {
      var pctText = (s.percent != null) ? (s.percent + '%') : '';
      var head = el('div', { class: 'lp-step-head' }, [
        el('div', { class: 'lp-step-label' }, [
          el('span', { class: 'lp-step-icon' }, iconMap[s.status] || '○'),
          s.label,
        ]),
        el('span', { class: 'lp-step-pct' }, pctText),
      ]);
      var kids = [head];
      if (s.detail) kids.push(el('div', { class: 'lp-step-detail' }, s.detail));
      var fill = el('div', { class: 'lp-bar-fill' });
      fill.style.width = (s.percent != null ? s.percent : (s.status === 'done' ? 100 : 0)) + '%';
      kids.push(el('div', { class: 'lp-bar' }, fill));
      box.appendChild(el('div', { class: 'lp-step ' + s.status }, kids));
    });
  }

  function pollLp(jobId) {
    clearInterval(lpTimer);
    async function tick() {
      var job;
      try {
        job = await jsonFetch('/api/local-project/' + encodeURIComponent(jobId));
      } catch (e) {
        return; // 偶发轮询失败容忍，下一拍重试
      }
      renderLpSteps(job.steps || []);
      if (job.status === 'pending' || job.status === 'running') {
        $('#lp-status').textContent = '处理中…（GB 级下载，请保持页面打开）';
      } else if (job.status === 'done') {
        clearInterval(lpTimer);
        $('#lp-status').textContent = '完成 ✓';
        $('#lp-close').disabled = false;
        if (job.result) {
          $('#lp-result').hidden = false;
          $('#lp-result').textContent = '✓ 已用 hap 内 Data 覆盖：' + job.result.overlayDir + '（' + job.result.copiedFiles + ' 个文件）';
        }
      } else if (job.status === 'error') {
        lpFail(job.error || '未知错误');
      }
    }
    tick();
    lpTimer = setInterval(tick, 1000);
  }

  function lpFail(msg) {
    clearInterval(lpTimer);
    $('#lp-status').textContent = '失败';
    $('#lp-close').disabled = false;
    $('#lp-error').hidden = false;
    $('#lp-error').textContent = msg;
  }

  $('#lp-close').addEventListener('click', function() {
    if ($('#lp-close').disabled) return;
    clearInterval(lpTimer);
    lpModal.hidden = true;
  });

  // ---------- 拖拽：拖文件进 panel → /api/locate 反查 → 自动填路径 ----------
  // 浏览器从 OS 拖文件进网页时，File 对象只有 name / size / lastModified（W3C 安全限制，
  // 拿不到绝对路径），所以我们把 (name,size) 送给 server，让它在 Downloads / Desktop /
  // Documents / cwd 这几个目录下精确匹配反查。零拷贝、零上传。
  function setStatus(input, kind, text) {
    var box = document.querySelector('.row-status[data-status-for="' + input.id + '"]');
    if (!box) return;
    box.className = 'row-status ' + (kind || 'muted');
    box.textContent = text || '';
  }
  function clearStatus(input) { setStatus(input, '', ''); }

  // 全局阻止默认（否则浏览器会把文件当成导航打开）
  ['dragover','drop'].forEach(function(ev){
    document.addEventListener(ev, function(e){ e.preventDefault(); }, false);
  });

  $$('.drop-row').forEach(function(row){
    var inputId = row.getAttribute('data-input-id');
    var targetInput = inputId ? document.getElementById(inputId) : null;
    if (!targetInput) return;
    // devops-only：不绑定拖拽反查（只允许蓝盾制品来源）
    if (DEVOPS_ONLY) return;

    row.addEventListener('dragenter', function(e){ e.preventDefault(); row.classList.add('dragover'); });
    row.addEventListener('dragover', function(e){ e.preventDefault(); row.classList.add('dragover'); });
    row.addEventListener('dragleave', function(e){
      if (e.target === row || !row.contains(e.relatedTarget)) row.classList.remove('dragover');
    });
    row.addEventListener('drop', async function(e){
      e.preventDefault();
      row.classList.remove('dragover');
      var dt = e.dataTransfer;
      if (!dt || !dt.files || dt.files.length === 0) return;
      var file = dt.files[0];
      clearDevopsSource(targetInput.id); // 拖本地文件 → 覆盖已加入的蓝盾引用

      var nameLow = (file.name || '').toLowerCase();
      // 允许的扩展名跟着 currentPlatform 走，与 picker (data-filter) 保持一致。
      // PLATFORM_DEFS[i].fileFilter 形如 '.hap,.json' / '.apk,.aab,.json' / '.ipa,.json'。
      var def = platformDef(currentPlatform);
      var allowedExts = ((def && def.fileFilter) || '')
        .split(',')
        .map(function(s){ return s.trim().toLowerCase(); })
        .filter(Boolean);
      var extOk = allowedExts.some(function(ext){ return nameLow.endsWith(ext); });
      if (!extOk) {
        var allowDisplay = allowedExts.length > 0 ? allowedExts.join(' / ') : '(未知平台)';
        setStatus(targetInput, 'err', '当前平台（' + platformLabel(currentPlatform) + '）只支持 ' + allowDisplay + '，收到: ' + file.name);
        return;
      }

      setStatus(targetInput, 'muted', '反查 ' + file.name + ' (' + file.size + ' bytes) …');
      try {
        var qs = '?name=' + encodeURIComponent(file.name) + '&size=' + encodeURIComponent(String(file.size));
        var data = await jsonFetch('/api/locate' + qs);
        if (data.matches && data.matches.length > 0) {
          clearDevopsSource(targetInput.id);
          targetInput.value = data.matches[0];
          var hint = '已自动定位';
          if (data.matches.length > 1) hint += '（共 ' + data.matches.length + ' 个候选，已取第一个，请核对）';
          setStatus(targetInput, 'ok', hint + ' · 扫了 ' + data.scanned + ' 个目录');
        } else {
          var rootHint = (data.roots && data.roots.length) ? data.roots.join('  /  ') : '常见目录';
          setStatus(targetInput, 'err', '未在 ' + rootHint + ' 中找到同名同大小文件 — 请改用"浏览…"或粘贴绝对路径');
        }
      } catch (err) {
        setStatus(targetInput, 'err', '反查失败：' + err.message);
      }
    });
  });

  // input 内容变化时清状态 + 清掉蓝盾引用（手动输入优先）
  $$('[data-dropinput]').forEach(function(i){
    i.addEventListener('input', function(){ clearDevopsSource(i.id); clearStatus(i); });
  });

  // ---------- 企业微信机器人长连接测试 ----------
  (function() {
    var dot = $('#ww-dot');
    var stateText = $('#ww-state-text');
    var meta = $('#ww-meta');
    var statsEl = $('#ww-stats');
    var logBox = $('#ww-log');
    var errBox = $('#ww-error');
    var autoReplyCb = $('#ww-autoreply');
    var chatidInput = $('#ww-chatid');
    var contentInput = $('#ww-content');
    if (!logBox) return; // 面板不存在（理论不会）

    var wwSeq = 0;            // 已渲染到的最大日志 seq（增量轮询基准）
    var lastChat = null;      // 最近一次会话上下文
    var autoReplyDirty = false; // 用户正在操作开关时，避免轮询覆盖

    var STATE_TEXT = {
      idle: '未连接', connecting: '连接中…', connected: '已连接（认证成功）',
      closed: '连接已断开', error: '错误',
    };

    function showErr(msg) { errBox.hidden = false; errBox.textContent = msg; }
    function clearErr() { errBox.hidden = true; errBox.textContent = ''; }

    // 应用状态（状态/元信息/统计/开关），不负责日志
    function applyStatus(s) {
      var st = s.status || 'idle';
      dot.className = 'ww-dot ' + (s.connected ? 'connected' : st);
      stateText.textContent = (STATE_TEXT[st] || st) + (s.connected ? '' : '');
      meta.innerHTML = '';
      if (!s.configured) {
        meta.appendChild(el('span', { class: 'err' }, '⚠ 未配置 botId / secret，请编辑 pipelines.config.json 的 wework 段'));
      } else {
        meta.appendChild(el('span', null, ['BotID ', el('code', null, s.botIdMasked || '-')]));
        meta.appendChild(el('span', null, ['地址 ', el('code', null, s.wsUrl || '-')]));
      }
      if (s.stats) {
        statsEl.textContent = '收 ' + s.stats.received + ' · 回 ' + s.stats.replied + ' · 主动发 ' + s.stats.sent;
      }
      if (!autoReplyDirty) autoReplyCb.checked = !!s.autoReply;
      lastChat = s.lastChat || null;
    }

    function dirText(d) { return { system: '系统', in: '收', out: '发', error: '错误' }[d] || d; }

    function appendLogs(logs) {
      (logs || []).forEach(function(ev) {
        var main = el('div', { class: 'ww-log-main' }, [
          el('span', { class: 'ww-log-text' }, ev.text),
          ev.cmd ? el('span', { class: 'ww-log-cmd' }, ev.cmd) : null,
        ]);
        if (ev.detail !== undefined && ev.detail !== null) {
          var pre = el('pre', { class: 'ww-log-detail' }, JSON.stringify(ev.detail, null, 2));
          pre.hidden = true;
          var toggle = el('button', { class: 'ww-log-toggle' }, '▾ 原始数据');
          toggle.addEventListener('click', function() {
            pre.hidden = !pre.hidden;
            toggle.textContent = (pre.hidden ? '▾' : '▴') + ' 原始数据';
          });
          main.appendChild(el('div', null, [toggle]));
          main.appendChild(pre);
        }
        logBox.appendChild(el('div', { class: 'ww-log-item' }, [
          el('span', { class: 'ww-log-time' }, fmtClock(ev.ts)),
          el('span', { class: 'ww-log-badge ' + ev.dir }, dirText(ev.dir)),
          main,
        ]));
      });
      if ((logs || []).length) logBox.scrollTop = logBox.scrollHeight;
    }

    function fmtClock(ts) {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    async function poll() {
      try {
        var s = await jsonFetch('/api/wework/state?since=' + wwSeq);
        applyStatus(s);
        appendLogs(s.logs);
        wwSeq = s.latestSeq || wwSeq;
      } catch (e) { /* 容忍偶发轮询失败 */ }
    }

    $('#ww-connect').addEventListener('click', async function() {
      clearErr();
      try {
        await jsonFetch('/api/wework/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await poll();
      } catch (e) { showErr(e.message); }
    });

    $('#ww-disconnect').addEventListener('click', async function() {
      clearErr();
      try {
        await jsonFetch('/api/wework/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await poll();
      } catch (e) { showErr(e.message); }
    });

    autoReplyCb.addEventListener('change', async function() {
      autoReplyDirty = true;
      clearErr();
      try {
        await jsonFetch('/api/wework/auto-reply', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: autoReplyCb.checked }),
        });
        await poll();
      } catch (e) { showErr(e.message); }
      finally { autoReplyDirty = false; }
    });

    $('#ww-use-last').addEventListener('click', function() {
      if (lastChat && lastChat.chatid) { chatidInput.value = lastChat.chatid; }
      else if (lastChat && lastChat.userid) { chatidInput.value = lastChat.userid; }
      else { showErr('还没有最近会话——先让用户在企业微信里给机器人发条消息'); }
    });

    $('#ww-send').addEventListener('click', async function() {
      clearErr();
      var chatid = chatidInput.value.trim();
      var content = contentInput.value;
      if (!chatid) { showErr('请填 chatid'); return; }
      if (!content.trim()) { showErr('请填要发送的内容'); return; }
      try {
        await jsonFetch('/api/wework/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatid: chatid, content: content }),
        });
        contentInput.value = '';
        await poll();
      } catch (e) { showErr(e.message); }
    });

    $('#ww-clear').addEventListener('click', async function() {
      clearErr();
      try {
        var s = await jsonFetch('/api/wework/clear-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        logBox.innerHTML = '';
        wwSeq = s.latestSeq || wwSeq;
        applyStatus(s);
        appendLogs(s.logs);
        wwSeq = s.latestSeq || wwSeq;
      } catch (e) { showErr(e.message); }
    });

    poll();
    setInterval(poll, 1500);
  })();
})();
`;
