// @ts-nocheck
/**
 * @kingsdk/web 工作台前端入口（忠实搬迁自 server 端 page.ts 的内联 SCRIPT）。
 *
 * 与原内联版唯一的行为差异：原来 window.__KINGSDK__ 由 server SSR 注入，
 * 这里改为启动时 fetch /api/config 拿到后再设置，然后运行原逻辑（保持逐字一致）。
 * cacheDir 文本也在此填充（静态 index.html 里留空）。extras 已按默认平台预渲染进
 * 静态 index.html，无需初始重渲染；平台切换仍走原有 loadAndRenderExtras。
 */
import './styles.css';

const DEFAULT_CONFIG = { defaultPlatform: 'harmony', platforms: [], mode: 'desktop', devopsOnly: false, cacheDir: '', extras: [] };

async function boot() {
  let cfg = DEFAULT_CONFIG;
  try {
    const r = await fetch('/api/config');
    if (r.ok) cfg = await r.json();
  } catch (e) {
    // 拉配置失败时用默认值兜底，保证页面仍可渲染（desktop/harmony）
    console.error('[web] /api/config 拉取失败，用默认配置兜底', e);
  }
  window.__KINGSDK__ = {
    defaultPlatform: cfg.defaultPlatform,
    platforms: cfg.platforms,
    mode: cfg.mode,
    devopsOnly: cfg.devopsOnly,
  };
  const cd = document.getElementById('cache-dir-path');
  if (cd && cfg.cacheDir) cd.textContent = cfg.cacheDir;

  runApp();
}

function runApp() {

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

  // ---------- web 模式：禁用一切"碰服务器本机文件系统"的入口 ----------
  // （DEVOPS_ONLY 是 mode==='web' 的别名，见 window.__KINGSDK__ 注入）
  (function applyDevopsOnly() {
    if (!DEVOPS_ONLY) return;
    // 隐藏所有"浏览…"按钮
    $$('button[data-browse-target]').forEach(function(b){ b.hidden = true; });
    // 隐藏"打开缓存目录"按钮（远程 web 下会开在服务器机器上，无意义）
    var openCacheBtn = document.getElementById('btn-open-cache-dir');
    if (openCacheBtn) openCacheBtn.hidden = true;
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
      // 配置本地工程要选本机目录并往磁盘写，web 模式屏蔽（后端也会 403 兜底）
      if (!DEVOPS_ONLY && hapArt && zipsArt) {
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
    var replyModeSel = $('#ww-replymode');
    var chatidInput = $('#ww-chatid');
    var contentInput = $('#ww-content');
    var sendKindSel = $('#ww-sendkind');
    var mediaPick = $('#ww-media-pick');
    var mediaList = $('#ww-media-list');
    var uploadType = $('#ww-upload-type');
    var uploadFile = $('#ww-upload-file');
    if (!logBox) return; // 面板不存在（理论不会）

    var wwSeq = 0;            // 已渲染到的最大日志 seq（增量轮询基准）
    var lastChat = null;      // 最近一次会话上下文
    var replyModeDirty = false; // 用户正在操作下拉时，避免轮询覆盖
    var recentMedia = [];     // 最近上传的素材

    var STATE_TEXT = {
      idle: '未连接', connecting: '连接中…', connected: '已连接（认证成功）',
      closed: '连接已断开', error: '错误',
    };
    var POST_JSON = { method: 'POST', headers: { 'Content-Type': 'application/json' } };

    function showErr(msg) { errBox.hidden = false; errBox.textContent = msg; }
    function clearErr() { errBox.hidden = true; errBox.textContent = ''; }

    // 应用状态（状态/元信息/统计/回复模式/素材），不负责日志
    function applyStatus(s) {
      var st = s.status || 'idle';
      dot.className = 'ww-dot ' + (s.connected ? 'connected' : st);
      stateText.textContent = STATE_TEXT[st] || st;
      meta.innerHTML = '';
      if (!s.configured) {
        meta.appendChild(el('span', { class: 'err' }, '⚠ 未配置 botId / secret，请编辑 pipelines.config.json 的 wework 段'));
      } else {
        meta.appendChild(el('span', null, ['BotID ', el('code', null, s.botIdMasked || '-')]));
        meta.appendChild(el('span', null, ['地址 ', el('code', null, s.wsUrl || '-')]));
        if (s.mediaDir) meta.appendChild(el('span', null, ['媒体落盘 ', el('code', null, s.mediaDir)]));
      }
      if (s.stats) {
        statsEl.textContent = '收 ' + s.stats.received + ' · 回 ' + s.stats.replied + ' · 主动发 ' + s.stats.sent;
      }
      if (!replyModeDirty && s.replyMode) replyModeSel.value = s.replyMode;
      lastChat = s.lastChat || null;
      if (Array.isArray(s.recentMedia)) { recentMedia = s.recentMedia; renderMedia(); }
    }

    function renderMedia() {
      // 主动发送的素材下拉
      var prev = mediaPick.value;
      mediaPick.innerHTML = '';
      if (!recentMedia.length) {
        mediaPick.appendChild(el('option', { value: '' }, '（暂无，请先上传）'));
      } else {
        recentMedia.forEach(function(m) {
          mediaPick.appendChild(el('option', { value: m.mediaId + '|' + m.type }, m.type + ' · ' + m.filename));
        });
        if (prev) mediaPick.value = prev;
      }
      // 素材列表
      mediaList.innerHTML = '';
      recentMedia.forEach(function(m) {
        var copyBtn = el('button', { class: 'ww-media-copy', title: '复制 media_id' }, '复制 id');
        copyBtn.addEventListener('click', function() {
          if (navigator.clipboard) navigator.clipboard.writeText(m.mediaId);
        });
        mediaList.appendChild(el('div', { class: 'ww-media-item' }, [
          el('span', { class: 'ww-media-type' }, m.type),
          el('span', { class: 'ww-media-name', title: m.filename }, m.filename),
          el('span', { class: 'ww-media-id', title: m.mediaId }, fmtBytes(m.size)),
          copyBtn,
        ]));
      });
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
      try { await jsonFetch('/api/wework/connect', Object.assign({ body: '{}' }, POST_JSON)); await poll(); }
      catch (e) { showErr(e.message); }
    });

    $('#ww-disconnect').addEventListener('click', async function() {
      clearErr();
      try { await jsonFetch('/api/wework/disconnect', Object.assign({ body: '{}' }, POST_JSON)); await poll(); }
      catch (e) { showErr(e.message); }
    });

    replyModeSel.addEventListener('change', async function() {
      replyModeDirty = true;
      clearErr();
      try {
        await jsonFetch('/api/wework/reply-mode', Object.assign({ body: JSON.stringify({ mode: replyModeSel.value }) }, POST_JSON));
        await poll();
      } catch (e) { showErr(e.message); }
      finally { replyModeDirty = false; }
    });

    // 主动发送类型切换：显示对应输入区
    function syncSendVariant() {
      var kind = sendKindSel.value;
      $$('.ww-send-variant').forEach(function(v) {
        v.hidden = v.getAttribute('data-variant') !== kind;
      });
    }
    sendKindSel.addEventListener('change', syncSendVariant);
    syncSendVariant();

    $('#ww-use-last').addEventListener('click', function() {
      if (lastChat && lastChat.chatid) { chatidInput.value = lastChat.chatid; }
      else if (lastChat && lastChat.userid) { chatidInput.value = lastChat.userid; }
      else { showErr('还没有最近会话——先让用户在企业微信里给机器人发条消息'); }
    });

    $('#ww-send').addEventListener('click', async function() {
      clearErr();
      var chatid = chatidInput.value.trim();
      if (!chatid) { showErr('请填 chatid'); return; }
      var kind = sendKindSel.value;
      var body = { kind: kind, chatid: chatid };
      if (kind === 'markdown') {
        if (!contentInput.value.trim()) { showErr('请填要发送的 markdown 内容'); return; }
        body.content = contentInput.value;
      } else if (kind === 'media') {
        var picked = mediaPick.value;
        if (!picked) { showErr('请先在下方上传素材，再选择'); return; }
        var parts = picked.split('|');
        body.mediaId = parts[0];
        body.mediaType = parts[1];
      }
      try {
        await jsonFetch('/api/wework/send', Object.assign({ body: JSON.stringify(body) }, POST_JSON));
        if (kind === 'markdown') contentInput.value = '';
        await poll();
      } catch (e) { showErr(e.message); }
    });

    // 素材上传：浏览器读文件 → base64 → POST
    $('#ww-upload-btn').addEventListener('click', async function() {
      clearErr();
      var f = uploadFile.files && uploadFile.files[0];
      if (!f) { showErr('请先选择文件'); return; }
      try {
        var dataUrl = await new Promise(function(resolve, reject) {
          var r = new FileReader();
          r.onload = function() { resolve(String(r.result)); };
          r.onerror = function() { reject(new Error('读取文件失败')); };
          r.readAsDataURL(f);
        });
        var b64 = dataUrl.indexOf(',') >= 0 ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
        await jsonFetch('/api/wework/upload-media', Object.assign({
          body: JSON.stringify({ type: uploadType.value, filename: f.name, dataBase64: b64 }),
        }, POST_JSON));
        uploadFile.value = '';
        await poll();
      } catch (e) { showErr(e.message); }
    });

    $('#ww-clear').addEventListener('click', async function() {
      clearErr();
      try {
        var s = await jsonFetch('/api/wework/clear-log', Object.assign({ body: '{}' }, POST_JSON));
        logBox.innerHTML = '';
        applyStatus(s);
        appendLogs(s.logs);
        wwSeq = s.latestSeq || wwSeq;
      } catch (e) { showErr(e.message); }
    });

    poll();
    setInterval(poll, 1500);
  })();
})();

}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
