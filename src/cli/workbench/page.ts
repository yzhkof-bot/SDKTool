/**
 * Workbench 主页 HTML。
 *
 * 设计原则：
 *  - 整体只有这一个文件就能渲染整个工作台 UI（HTML+CSS+JS 全内联），方便 server.ts 直接输出
 *  - 不打 IIFE bundle、不依赖 viewer/sections，行为简单（fetch + 拉表 + DOM 增删）
 *  - 文件选择走"服务端目录浏览器" modal，**零拷贝**：浏览器只是渲染目录列表，
 *    点选时把绝对路径回传 API，server 直接 analyzeHap(absPath)，hap 不会被复制
 *  - 可选深度分析（extras）：渲染时从后端 EXTRA_ANALYZERS 注入，多选 checkbox
 */

import { EXTRA_ANALYZERS, type ExtraAnalyzerMeta } from '../../core/analyzers/index.js';

export function renderWorkbenchPage(): string {
  return PAGE_HTML(EXTRA_ANALYZERS);
}

function PAGE_HTML(extras: ExtraAnalyzerMeta[]): string {
  const extrasAnalyze = renderExtrasBlock(extras, 'analyze');
  const extrasCompare = renderExtrasBlock(extras, 'compare');
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
    <h1>KingSDK Hap Workbench</h1>
    <div class="topbar-sub">本地工作台 · 监听 127.0.0.1 · 零拷贝（不复制 hap）</div>
  </div>

  <div class="container">
    <div class="tabs">
      <button class="tab active" data-tab="analyze">分析单个 Hap</button>
      <button class="tab" data-tab="compare">对比两个 Hap</button>
    </div>

    <section class="panel" data-section="analyze">
      <h2 class="panel-title">分析</h2>
      <p class="hint">三种方式选 hap：<b>拖到下方虚线框</b>（按 name+size 反查 Downloads/Desktop/Documents/cwd 下文件）、点<b>浏览…</b>、或直接<b>粘贴绝对路径</b>。文件不会被上传或复制。</p>
      <div class="drop-row" data-input-id="analyze-path">
        <div class="drop-row-tag">Hap</div>
        <div class="drop-row-main">
          <div class="path-row">
            <label>Hap 路径</label>
            <input type="text" id="analyze-path" data-dropinput placeholder="/abs/path/to/your.hap 或 D:\\\\path\\\\your.hap" />
            <button class="btn-secondary" data-browse-target="analyze-path" data-filter=".hap,.json">浏览…</button>
          </div>
          <div class="row-status" data-status-for="analyze-path"></div>
        </div>
        <div class="drop-row-hint">拖到这里</div>
      </div>
      ${extrasAnalyze}
      <div class="actions">
        <button class="btn-primary" id="btn-analyze">开始分析</button>
      </div>
      <div id="analyze-error" class="error" hidden></div>
    </section>

    <section class="panel" data-section="compare" hidden>
      <h2 class="panel-title">对比</h2>
      <p class="hint">两侧各是独立拖拽区——把<b>旧版 hap</b>拖到<b>左边</b>，<b>新版 hap</b>拖到<b>右边</b>。两侧支持 .hap 或已生成的 .json 报告。文件不会被复制。</p>
      <div class="drop-row" data-input-id="compare-left">
        <div class="drop-row-tag tag-left">Baseline (左·旧)</div>
        <div class="drop-row-main">
          <div class="path-row">
            <label>路径</label>
            <input type="text" id="compare-left" data-dropinput placeholder="较早的 hap / 报告 JSON" />
            <button class="btn-secondary" data-browse-target="compare-left" data-filter=".hap,.json">浏览…</button>
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
            <input type="text" id="compare-right" data-dropinput placeholder="较新的 hap / 报告 JSON" />
            <button class="btn-secondary" data-browse-target="compare-right" data-filter=".hap,.json">浏览…</button>
          </div>
          <div class="row-status" data-status-for="compare-right"></div>
        </div>
        <div class="drop-row-hint">拖到这里 · 右</div>
      </div>
      ${extrasCompare}
      <div class="actions">
        <button class="btn-primary" id="btn-compare">开始对比</button>
      </div>
      <div id="compare-error" class="error" hidden></div>
    </section>

    <section class="panel">
      <h2 class="panel-title">历史记录 <span class="muted">(自动刷新，最近 50 条；点每行右侧 × 删单条)</span></h2>
      <div id="jobs"></div>
    </section>
  </div>

  <!-- 文件选择 modal：实际就是服务端目录浏览器 -->
  <div class="modal" id="picker" hidden>
    <div class="modal-card">
      <div class="modal-header">
        <strong>选择 Hap / Report</strong>
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
      </div>
    </div>
  </div>

  <script>${SCRIPT}</script>
</body>
</html>`;
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
.container { max-width: 1100px; margin: 0 auto; padding: 24px 32px; }

.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--color-border); }
.tab { padding: 8px 18px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--color-muted); cursor: pointer; font-size: 14px; }
.tab.active { color: var(--color-primary); border-bottom-color: var(--color-primary); font-weight: 500; }
.tab:hover { color: var(--color-text); }

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
`;

/* -------------------------------------------------------------------------- */
/* JS                                                                          */
/* -------------------------------------------------------------------------- */

const SCRIPT = `
(function() {
  'use strict';

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

  // ---------- Tab 切换 ----------
  $$('.tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var name = btn.getAttribute('data-tab');
      $$('.tab').forEach(function(b){ b.classList.toggle('active', b === btn); });
      $$('section[data-section]').forEach(function(s){
        s.hidden = s.getAttribute('data-section') !== name;
      });
    });
  });

  // ---------- Extras（可选深度分析多选） ----------
  // 收集当前 kind（'analyze' | 'compare'）下勾选的 analyzer id
  function collectExtras(kind) {
    var attr = 'data-extra-' + kind;
    return $$('input[' + attr + ']').filter(function(b){ return b.checked; }).map(function(b){ return b.getAttribute(attr); });
  }

  // ---------- Analyze / Compare 按钮 ----------
  $('#btn-analyze').addEventListener('click', async function() {
    var path = $('#analyze-path').value.trim();
    var errBox = $('#analyze-error');
    errBox.hidden = true; errBox.textContent = '';
    if (!path) { errBox.hidden = false; errBox.textContent = '请填路径或点"浏览…"选择'; return; }
    var extras = collectExtras('analyze');
    try {
      var body = { path: path };
      if (extras.length > 0) body.extras = extras;
      var r = await jsonFetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      console.log('[workbench] analyze job started', r, 'extras=', extras);
      refreshJobs();
    } catch (e) {
      errBox.hidden = false; errBox.textContent = e.message;
    }
  });

  $('#btn-compare').addEventListener('click', async function() {
    var leftPath = $('#compare-left').value.trim();
    var rightPath = $('#compare-right').value.trim();
    var errBox = $('#compare-error');
    errBox.hidden = true; errBox.textContent = '';
    if (!leftPath || !rightPath) { errBox.hidden = false; errBox.textContent = '两侧路径都需要填'; return; }
    var extras = collectExtras('compare');
    try {
      var body = { leftPath: leftPath, rightPath: rightPath };
      if (extras.length > 0) body.extras = extras;
      var r = await jsonFetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      console.log('[workbench] compare job started', r, 'extras=', extras);
      refreshJobs();
    } catch (e) {
      errBox.hidden = false; errBox.textContent = e.message;
    }
  });

  // ---------- 历史轮询 ----------
  var jobsBox = $('#jobs');
  async function refreshJobs() {
    try {
      var data = await jsonFetch('/api/jobs');
      renderJobs(data.jobs || []);
    } catch (e) {
      jobsBox.innerHTML = '';
      jobsBox.appendChild(el('div', { class: 'error' }, '加载历史失败: ' + e.message));
    }
  }
  function renderJobs(list) {
    jobsBox.innerHTML = '';
    if (list.length === 0) {
      jobsBox.appendChild(el('div', { class: 'muted' }, '暂无任务。试试上面的"开始分析"或"开始对比"按钮。'));
      return;
    }
    list.forEach(function(j) {
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
        j.status === 'error' ? el('div', { class: 'err-msg' }, 'Error: ' + (j.error || 'unknown')) : null,
      ]);

      var isActive = j.status === 'pending' || j.status === 'running';
      var delBtn = el('button', {
        class: 'btn-delete',
        title: isActive ? '任务进行中；想强制删点这里' : '删除该条历史及其磁盘产物',
      }, '×');
      delBtn.addEventListener('click', function() { onDeleteJob(j, delBtn); });

      var card = el('div', { class: 'job' }, [
        el('span', { class: 'badge ' + j.status }, j.status),
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

  function openPicker(targetInputId, filterAttr) {
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
              if (pickerTargetInput) pickerTargetInput.value = ent.path;
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

      var nameLow = (file.name || '').toLowerCase();
      if (!/\\.hap$|\\.json$/.test(nameLow)) {
        setStatus(targetInput, 'err', '只支持 .hap / .json，收到: ' + file.name);
        return;
      }

      setStatus(targetInput, 'muted', '反查 ' + file.name + ' (' + file.size + ' bytes) …');
      try {
        var qs = '?name=' + encodeURIComponent(file.name) + '&size=' + encodeURIComponent(String(file.size));
        var data = await jsonFetch('/api/locate' + qs);
        if (data.matches && data.matches.length > 0) {
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

  // input 内容变化时清状态
  $$('[data-dropinput]').forEach(function(i){
    i.addEventListener('input', function(){ clearStatus(i); });
  });
})();
`;
