/**
 * Diff viewer 的"AI 分析"抽屉面板。
 *
 * 行为：
 *  - 顶部按钮触发 toggle()
 *  - 仅在 workbench 模式下（window.__KINGSDK_AI__.jobId 存在）启用
 *  - 启用后启动时调 /api/ai/health 决定按钮的最终态
 *  - 首次发送时创建 conversation；后续走 /api/ai/conversations/:id/messages SSE
 *  - 输入框默认填充 "帮我总结分析这个 diff 的内容"，可改可清
 *  - 多轮对话：会话上下文保留在服务端（SDK Session），前端只记 conversationId + 已渲染消息
 *
 * UI：极简、单文件 IIFE，不引第三方。
 */

import { h } from '../helpers.js';

interface AiBootstrap {
  jobId: string;
  apiBase: string;
}

interface AiHealth {
  available: boolean;
  provider: string;
  model?: string;
  reason?: string;
}

interface MessageState {
  role: 'user' | 'assistant';
  /** 完整渲染后的 DOM；对 assistant 来说在 stream 过程中会持续 append */
  node: HTMLElement;
  /** assistant 当前正在写入的 text 容器，便于增量 append */
  textEl?: HTMLElement;
  /** assistant 当前正在写入的 thinking 容器，便于把 thinking_delta 累积到同一块 */
  thinkingBodyEl?: HTMLElement;
  /** assistant 正在执行的工具气泡按 id 维护 */
  toolsById?: Map<string, { node: HTMLElement; resultEl?: HTMLElement }>;
}

const DEFAULT_PROMPT = '帮我总结分析这个 diff 的内容';

export interface AiPanelHandle {
  /** 顶部按钮元素，调用方负责挂载到 topbar */
  trigger: HTMLElement;
  /** 抽屉元素，调用方挂到 document.body 末尾 */
  drawer: HTMLElement;
  /** 程序触发打开/关闭 */
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export function createAiPanel(): AiPanelHandle {
  const bootstrap = readBootstrap();

  const trigger = h(
    'button',
    {
      class: 'ai-trigger',
      type: 'button',
      title: bootstrap
        ? '打开 AI 分析助手'
        : '需要在 workbench 模式下打开本页才能使用 AI（双击 HTML 文件不支持）',
    },
    h('span', { class: 'ai-trigger-icon' }, '✦'),
    h('span', null, 'AI 分析'),
  ) as HTMLButtonElement;
  if (!bootstrap) trigger.classList.add('disabled');

  const messagesEl = h('div', { class: 'ai-messages' }) as HTMLElement;
  const inputEl = h('textarea', {
    class: 'ai-input',
    rows: '3',
    placeholder: DEFAULT_PROMPT,
  }) as HTMLTextAreaElement;
  inputEl.value = DEFAULT_PROMPT;

  const sendBtn = h('button', { class: 'ai-send', type: 'button' }, '发送') as HTMLButtonElement;
  const stopBtn = h(
    'button',
    { class: 'ai-stop', type: 'button', hidden: 'true' },
    '中断',
  ) as HTMLButtonElement;
  const closeBtn = h(
    'button',
    { class: 'ai-close', type: 'button', title: '关闭抽屉' },
    '×',
  ) as HTMLButtonElement;

  const statusEl = h('div', { class: 'ai-status' }) as HTMLElement;

  const drawer = h(
    'aside',
    { class: 'ai-drawer' },
    h(
      'div',
      { class: 'ai-drawer-header' },
      h('div', { class: 'ai-drawer-title' }, h('span', { class: 'ai-trigger-icon' }, '✦'), 'AI 分析助手'),
      closeBtn,
    ),
    statusEl,
    messagesEl,
    h(
      'div',
      { class: 'ai-input-row' },
      inputEl,
      h(
        'div',
        { class: 'ai-input-actions' },
        h(
          'div',
          { class: 'ai-input-hint' },
          h('kbd', null, 'Ctrl/Cmd+Enter'),
          ' 发送',
        ),
        h('div', { class: 'ai-input-buttons' }, stopBtn, sendBtn),
      ),
    ),
  ) as HTMLElement;
  // 默认收起
  drawer.classList.add('closed');

  // ---------------- 状态 ----------------
  let conversationId: string | null = null;
  let healthChecked = false;
  let healthOk = false;
  let healthMsg = '';
  let inflight: AbortController | null = null;
  let currentAssistant: MessageState | null = null;

  function setStatus(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
    statusEl.hidden = !text;
  }

  function open(): void {
    if (!bootstrap) {
      setStatus(
        '当前是离线 HTML，AI 功能不可用。请在 workbench 模式下（kingsdk wb 启动后从历史里打开）使用。',
        'error',
      );
      drawer.classList.remove('closed');
      document.body.classList.add('ai-drawer-open');
      return;
    }
    drawer.classList.remove('closed');
    document.body.classList.add('ai-drawer-open');
    if (!healthChecked) void checkHealth();
    setTimeout(() => inputEl.focus(), 50);
  }

  function close(): void {
    drawer.classList.add('closed');
    document.body.classList.remove('ai-drawer-open');
  }

  function toggle(): void {
    if (drawer.classList.contains('closed')) open();
    else close();
  }

  trigger.addEventListener('click', () => {
    if (trigger.classList.contains('disabled') && !bootstrap) {
      // 仍然让抽屉打开，让用户看到原因
      open();
      return;
    }
    toggle();
  });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.classList.contains('closed')) close();
  });

  inputEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void onSend();
    }
  });
  sendBtn.addEventListener('click', () => void onSend());
  stopBtn.addEventListener('click', () => void onStop());

  // ---------------- Health ----------------
  async function checkHealth(): Promise<void> {
    if (!bootstrap) return;
    healthChecked = true;
    setStatus('正在检查 AI 服务状态…');
    try {
      const r = await fetch(`${bootstrap.apiBase}/health`);
      const data = (await r.json()) as AiHealth;
      if (!r.ok || !data.available) {
        healthOk = false;
        healthMsg = data.reason ?? `AI 服务不可用（HTTP ${r.status}）`;
        setStatus(healthMsg, 'error');
        sendBtn.disabled = true;
        return;
      }
      healthOk = true;
      const modelHint = data.model ? `（model: ${data.model}）` : '';
      setStatus(`AI 已就绪 · provider=${data.provider}${modelHint}`, 'ok');
      sendBtn.disabled = false;
    } catch (e) {
      healthOk = false;
      healthMsg = `健康检查失败：${(e as Error).message}`;
      setStatus(healthMsg, 'error');
      sendBtn.disabled = true;
    }
  }

  // ---------------- 创建会话 + 发送 ----------------
  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    if (!bootstrap) throw new Error('未在 workbench 模式下，无法创建会话');
    const r = await fetch(`${bootstrap.apiBase}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: bootstrap.jobId }),
    });
    const data = (await r.json()) as { conversationId?: string; error?: string; message?: string };
    if (!r.ok || !data.conversationId) {
      throw new Error(data.message || data.error || `HTTP ${r.status}`);
    }
    conversationId = data.conversationId;
    return conversationId;
  }

  async function onSend(): Promise<void> {
    if (!bootstrap) {
      setStatus('当前不是 workbench 模式，无法使用 AI。', 'error');
      return;
    }
    if (!healthOk) {
      setStatus(healthMsg || 'AI 服务不可用', 'error');
      return;
    }
    if (inflight) {
      setStatus('上一轮还在进行中', 'error');
      return;
    }
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    autoResize(inputEl);
    appendUserMessage(text);

    sendBtn.disabled = true;
    stopBtn.hidden = false;
    setStatus('AI 思考中…');

    try {
      const cid = await ensureConversation();
      await streamMessage(cid, text);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      appendErrorBubble(msg);
      setStatus(msg, 'error');
    } finally {
      sendBtn.disabled = false;
      stopBtn.hidden = true;
      inflight = null;
      currentAssistant = null;
    }
  }

  async function streamMessage(cid: string, text: string): Promise<void> {
    const ctrl = new AbortController();
    inflight = ctrl;
    const r = await fetch(`${bootstrap!.apiBase}/conversations/${encodeURIComponent(cid)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    if (!r.ok || !r.body) {
      let detail = '';
      try {
        const data = await r.json();
        detail = (data?.message as string) || (data?.error as string) || '';
      } catch {
        /* ignore */
      }
      throw new Error(`HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // SSE 帧以 \n\n 分隔
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSseFrame(frame);
        if (ev) handleSseEvent(ev);
      }
    }
  }

  async function onStop(): Promise<void> {
    if (!conversationId) return;
    try {
      inflight?.abort();
      await fetch(
        `${bootstrap!.apiBase}/conversations/${encodeURIComponent(conversationId)}/interrupt`,
        { method: 'POST' },
      );
      setStatus('已请求中断', 'info');
    } catch (e) {
      setStatus(`中断失败：${(e as Error).message}`, 'error');
    }
  }

  // ---------------- SSE 事件渲染 ----------------
  function handleSseEvent(ev: { type: string; [k: string]: unknown }): void {
    switch (ev.type) {
      case 'turn_start':
        currentAssistant = appendAssistantMessage();
        break;
      case 'text_delta':
        ensureAssistant().appendText(String(ev.text ?? ''));
        break;
      case 'thinking':
        ensureAssistant().appendThinking(String(ev.text ?? ''));
        break;
      case 'tool_use':
        ensureAssistant().appendToolUse(
          String(ev.id),
          String(ev.name),
          ev.input,
        );
        break;
      case 'tool_result':
        ensureAssistant().appendToolResult(
          String(ev.id),
          String(ev.content ?? ''),
          !!ev.isError,
        );
        break;
      case 'turn_end': {
        const success = !!ev.success;
        const dur = Number(ev.durationMs ?? 0);
        const cost = Number(ev.totalCostUsd ?? 0);
        const errs = Array.isArray(ev.errors) ? (ev.errors as string[]).join('; ') : '';
        if (success) {
          setStatus(
            `已完成 · ${fmtDuration(dur)}${cost > 0 ? ` · $${cost.toFixed(4)}` : ''}`,
            'ok',
          );
        } else {
          setStatus(`执行失败${errs ? `：${errs}` : ''}`, 'error');
        }
        break;
      }
      case 'error':
        appendErrorBubble(String(ev.message ?? '未知错误'));
        setStatus(String(ev.message ?? '错误'), 'error');
        break;
      case 'done':
        // 流结束（无论成功失败）
        break;
    }
  }

  function ensureAssistant(): AssistantWriter {
    if (!currentAssistant) {
      currentAssistant = appendAssistantMessage();
    }
    const state = currentAssistant;
    return {
      appendText(t: string): void {
        if (!t) return;
        if (!state.textEl) {
          state.textEl = h('div', { class: 'ai-bubble-text' }) as HTMLElement;
          state.node.appendChild(state.textEl);
        }
        state.textEl.appendChild(document.createTextNode(t));
        scrollToBottom();
      },
      appendThinking(t: string): void {
        if (!t) return;
        if (!state.thinkingBodyEl) {
          const body = h('div', { class: 'ai-thinking-body' }) as HTMLElement;
          const node = h(
            'details',
            { class: 'ai-thinking' },
            h('summary', null, '💭 推理过程'),
            body,
          ) as HTMLElement;
          state.node.appendChild(node);
          state.thinkingBodyEl = body;
        }
        state.thinkingBodyEl.appendChild(document.createTextNode(t));
        scrollToBottom();
      },
      appendToolUse(id: string, name: string, input: unknown): void {
        if (!state.toolsById) state.toolsById = new Map();
        const body = h('div', { class: 'ai-tool-body' }) as HTMLElement;
        const inputBlock = h(
          'pre',
          { class: 'ai-tool-input' },
          stringifyForDisplay(input),
        ) as HTMLElement;
        body.appendChild(inputBlock);
        const node = h(
          'details',
          { class: 'ai-tool', open: 'true' },
          h(
            'summary',
            null,
            h('span', { class: 'ai-tool-label' }, '🔧 ', name),
            h('span', { class: 'ai-tool-status running' }, '运行中…'),
          ),
          body,
        ) as HTMLElement;
        state.node.appendChild(node);
        state.toolsById.set(id, { node, resultEl: undefined });
        scrollToBottom();
        // 新工具开始 → 把当前文本/思考块的引用清掉，工具后续的 text/thinking 会落到新块里
        state.textEl = undefined;
        state.thinkingBodyEl = undefined;
      },
      appendToolResult(id: string, content: string, isError: boolean): void {
        const tool = state.toolsById?.get(id);
        if (!tool) {
          // 找不到对应 tool_use（理论上不该）：作为独立块挂上
          state.node.appendChild(
            h('pre', { class: `ai-tool-result orphan ${isError ? 'error' : ''}` }, content) as HTMLElement,
          );
          scrollToBottom();
          return;
        }
        const summary = tool.node.querySelector('.ai-tool-status');
        if (summary) {
          summary.classList.remove('running');
          summary.classList.add(isError ? 'error' : 'ok');
          summary.textContent = isError ? '失败' : '完成';
        }
        const body = tool.node.querySelector('.ai-tool-body');
        if (body) {
          const resultEl = h(
            'pre',
            { class: `ai-tool-result ${isError ? 'error' : ''}` },
            truncateForDisplay(content),
          ) as HTMLElement;
          body.appendChild(resultEl);
          tool.resultEl = resultEl;
          // 工具结束后默认收起，避免长结果占满屏幕（用户可点开）
          tool.node.removeAttribute('open');
        }
        scrollToBottom();
      },
    };
  }

  // ---------------- 渲染原语 ----------------
  function appendUserMessage(text: string): void {
    const node = h(
      'div',
      { class: 'ai-message user' },
      h('div', { class: 'ai-bubble' }, h('div', { class: 'ai-bubble-text' }, text)),
    ) as HTMLElement;
    messagesEl.appendChild(node);
    scrollToBottom();
  }

  function appendAssistantMessage(): MessageState {
    const bubble = h('div', { class: 'ai-bubble' }) as HTMLElement;
    const node = h('div', { class: 'ai-message assistant' }, bubble) as HTMLElement;
    messagesEl.appendChild(node);
    scrollToBottom();
    return { role: 'assistant', node: bubble };
  }

  function appendErrorBubble(msg: string): void {
    const node = h(
      'div',
      { class: 'ai-message error' },
      h('div', { class: 'ai-bubble error' }, msg),
    ) as HTMLElement;
    messagesEl.appendChild(node);
    scrollToBottom();
  }

  function scrollToBottom(): void {
    // 在下一帧滚，确保 layout 已 finish
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // 自适应高度（最多 8 行）
  inputEl.addEventListener('input', () => autoResize(inputEl));

  return { trigger, drawer, open, close, toggle };
}

/* -------------------------------------------------------------------------- */
/* 辅助                                                                       */
/* -------------------------------------------------------------------------- */

interface AssistantWriter {
  appendText(t: string): void;
  appendThinking(t: string): void;
  appendToolUse(id: string, name: string, input: unknown): void;
  appendToolResult(id: string, content: string, isError: boolean): void;
}

function readBootstrap(): AiBootstrap | null {
  const w = window as unknown as { __KINGSDK_AI__?: AiBootstrap };
  const v = w.__KINGSDK_AI__;
  if (!v || typeof v.jobId !== 'string' || typeof v.apiBase !== 'string') return null;
  return v;
}

function parseSseFrame(frame: string): { type: string; [k: string]: unknown } | null {
  // 一个 SSE 帧 = 多行 "key: value"；同一帧 data 可能多行需拼接
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split('\n')) {
    if (!raw || raw.startsWith(':')) continue;
    const idx = raw.indexOf(':');
    if (idx < 0) continue;
    const key = raw.slice(0, idx);
    const val = raw.slice(idx + 1).replace(/^ /, '');
    if (key === 'event') event = val;
    else if (key === 'data') dataLines.push(val);
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  try {
    const obj = JSON.parse(data) as Record<string, unknown>;
    return { type: event, ...obj };
  } catch {
    return { type: event, raw: data };
  }
}

function stringifyForDisplay(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > 4000 ? `${s.slice(0, 4000)}\n… (${s.length} chars total)` : s;
  } catch {
    return String(v);
  }
}

function truncateForDisplay(s: string, max = 8000): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (truncated, total ${s.length} chars)`;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}

function autoResize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  const max = 200;
  el.style.height = Math.min(max, el.scrollHeight + 2) + 'px';
}
