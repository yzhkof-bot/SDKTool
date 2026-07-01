/**
 * 企业微信智能机器人长连接管理器（封装官方 SDK @wecom/aibot-node-sdk）。
 *
 * 定位：仅供 workbench「企业微信机器人」测试界面使用，把文档里的各种消息形式都做成可一键尝试：
 *  - 流式回复（aibot_respond_msg，stream 两段刷新）
 *  - Markdown 富文本回复
 *  - 模板卡片回复（button_interaction，点按钮 → 自动 updateTemplateCard 更新卡片）
 *  - 流式 + 模板卡片组合回复
 *  - 进入会话欢迎语
 *  - 主动推送（markdown / 模板卡片 / 媒体）
 *  - 临时素材上传（分片）+ 媒体消息发送
 *  - 收到图片/文件/视频自动下载并 AES 解密落盘
 *
 * **不接入项目任何分析/对比功能**，是一个独立的连通性 / 协议验证器。
 * 所有 SDK 调用都包了 try/catch，单条失败只记日志，不影响长连接本身。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type {
  WsFrame,
  BaseMessage,
  TextMessage,
  EventMessage,
  TemplateCard,
  WeComMediaType,
} from '@wecom/aibot-node-sdk';

import type { WeworkConfig } from './devopsConfig.js';

/** 连接状态机。 */
export type WeworkStatus =
  | 'idle' // 未连接（初始 / 主动断开后）
  | 'connecting' // 正在建连 / 认证 / 重连中
  | 'connected' // 已认证，可收发
  | 'closed' // 连接断开（可能在重连）
  | 'error'; // 配置缺失或致命错误

/** 收到文本消息时的自动回复行为。 */
export type WeworkReplyMode =
  | 'off' // 不自动回复
  | 'stream' // 流式 echo（两段刷新，演示流式）
  | 'markdown' // 一段 markdown 富文本回复
  | 'card' // 按钮交互模板卡片（点按钮会触发 template_card_event）
  | 'stream_card'; // 流式 + 模板卡片组合

export const WEWORK_REPLY_MODES: WeworkReplyMode[] = [
  'off',
  'stream',
  'markdown',
  'card',
  'stream_card',
];

/** 一条日志的方向/级别。 */
export type WeworkLogDir = 'system' | 'in' | 'out' | 'error';

/** 环形日志缓冲里的一条记录。 */
export interface WeworkLogEntry {
  seq: number;
  ts: number;
  dir: WeworkLogDir;
  cmd?: string;
  text: string;
  detail?: unknown;
}

/** 最近一次会话上下文。 */
export interface WeworkLastChat {
  chatid?: string;
  chattype?: string;
  userid?: string;
}

/** 最近上传的临时素材记录。 */
export interface WeworkMediaItem {
  mediaId: string;
  type: WeComMediaType;
  filename: string;
  size: number;
  at: number;
}

/** 给前端的状态快照（含增量日志）。 */
export interface WeworkState {
  configured: boolean;
  botIdMasked: string;
  wsUrl: string;
  status: WeworkStatus;
  connected: boolean;
  autoReply: boolean;
  replyMode: WeworkReplyMode;
  lastChat: WeworkLastChat | null;
  stats: { received: number; replied: number; sent: number };
  recentMedia: WeworkMediaItem[];
  mediaDir: string;
  logs: WeworkLogEntry[];
  latestSeq: number;
}

/** 主动发送 / 媒体发送的入参。 */
export type WeworkSendRequest =
  | { kind: 'markdown'; chatid: string; content: string }
  | { kind: 'card'; chatid: string }
  | {
      kind: 'media';
      chatid: string;
      mediaType: WeComMediaType;
      mediaId: string;
      title?: string;
      description?: string;
    };

const MAX_LOG_ENTRIES = 1000;
const MAX_RECENT_MEDIA = 20;

/** 各媒体类型大小上限（字节，base64 解码后）。 */
const MEDIA_SIZE_LIMIT: Record<WeComMediaType, number> = {
  image: 10 * 1024 * 1024,
  voice: 2 * 1024 * 1024,
  video: 10 * 1024 * 1024,
  file: 20 * 1024 * 1024,
};

function mask(s: string): string {
  if (!s) return '';
  if (s.length <= 12) return s.slice(0, 2) + '***';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export class WeworkBotManager {
  private readonly cfg: WeworkConfig;
  private readonly log: (t: string) => void;
  private readonly mediaDir: string;

  private client: WSClient | null = null;
  private status: WeworkStatus = 'idle';
  private autoReply: boolean;
  private replyMode: WeworkReplyMode;
  private lastChat: WeworkLastChat | null = null;
  private readonly stats = { received: 0, replied: 0, sent: 0 };
  private readonly recentMedia: WeworkMediaItem[] = [];

  private readonly logs: WeworkLogEntry[] = [];
  private seqCounter = 0;

  constructor(cfg: WeworkConfig, log: (t: string) => void, mediaDir: string) {
    this.cfg = cfg;
    this.autoReply = cfg.autoReply;
    // 初始回复模式：autoReply 开 → 流式 echo；关 → off
    this.replyMode = cfg.autoReply ? 'stream' : 'off';
    this.log = log;
    this.mediaDir = mediaDir;
  }

  get configured(): boolean {
    return Boolean(this.cfg.botId && this.cfg.secret);
  }

  /* ----------------------------- 公开操作 ----------------------------- */

  connect(): { ok: boolean; message?: string } {
    if (!this.configured) {
      this.status = 'error';
      this.append('error', '未配置 BotID / Secret，请在 pipelines.config.json 的 wework 段填写');
      return { ok: false, message: 'wework 未配置 botId / secret' };
    }
    this.teardownClient();

    this.status = 'connecting';
    this.append('system', `正在连接 ${this.cfg.wsUrl} …（bot ${mask(this.cfg.botId)}）`);

    let client: WSClient;
    try {
      client = new WSClient({
        botId: this.cfg.botId,
        secret: this.cfg.secret,
        wsUrl: this.cfg.wsUrl,
        maxReconnectAttempts: 5,
        logger: {
          debug: () => {},
          info: (m: string) => this.log(`[wework] ${m}\n`),
          warn: (m: string) => this.log(`[wework][warn] ${m}\n`),
          error: (m: string) => this.log(`[wework][error] ${m}\n`),
        },
      });
    } catch (e) {
      this.status = 'error';
      this.append('error', `创建客户端失败：${errMsg(e)}`);
      return { ok: false, message: errMsg(e) };
    }

    this.client = client;
    this.bindEvents(client);
    try {
      client.connect();
    } catch (e) {
      this.status = 'error';
      this.append('error', `发起连接失败：${errMsg(e)}`);
      return { ok: false, message: errMsg(e) };
    }
    return { ok: true };
  }

  disconnect(): void {
    this.teardownClient();
    this.status = 'idle';
    this.append('system', '已主动断开连接');
  }

  /** 旧开关：等价于 replyMode 在 stream / off 间切换（保留兼容前端 toggle）。 */
  setAutoReply(enabled: boolean): void {
    this.autoReply = enabled;
    this.replyMode = enabled ? (this.replyMode === 'off' ? 'stream' : this.replyMode) : 'off';
    this.append('system', `自动回复已${enabled ? '开启' : '关闭'}（模式：${this.replyMode}）`);
  }

  /** 设置收到文本消息时的回复模式。 */
  setReplyMode(mode: WeworkReplyMode): void {
    this.replyMode = mode;
    this.autoReply = mode !== 'off';
    this.append('system', `回复模式已切换为：${replyModeLabel(mode)}`);
  }

  clearLog(): void {
    this.logs.length = 0;
    this.append('system', '日志已清空');
  }

  /** 主动发送：markdown / 模板卡片 / 媒体。 */
  async send(req: WeworkSendRequest): Promise<{ ok: boolean; message?: string }> {
    if (!this.client || !this.client.isConnected) {
      return { ok: false, message: '长连接未建立，请先连接' };
    }
    const chatid = req.chatid.trim();
    if (!chatid) return { ok: false, message: 'chatid 不能为空' };
    try {
      if (req.kind === 'markdown') {
        if (!req.content.trim()) return { ok: false, message: '消息内容不能为空' };
        await this.client.sendMessage(chatid, { msgtype: 'markdown', markdown: { content: req.content } });
        this.append('out', `主动推送 markdown 到 ${chatid}：${preview(req.content)}`, 'aibot_send_msg', {
          chatid,
          content: req.content,
        });
      } else if (req.kind === 'card') {
        const card = buildSampleCard();
        await this.client.sendMessage(chatid, { msgtype: 'template_card', template_card: card });
        this.append('out', `主动推送模板卡片到 ${chatid}（task_id=${card.task_id}）`, 'aibot_send_msg', card);
      } else {
        if (!req.mediaId.trim()) return { ok: false, message: 'mediaId 不能为空' };
        await this.client.sendMediaMessage(
          chatid,
          req.mediaType,
          req.mediaId.trim(),
          req.mediaType === 'video' ? { title: req.title, description: req.description } : undefined,
        );
        this.append('out', `主动推送 ${req.mediaType} 媒体到 ${chatid}（media_id=${preview(req.mediaId, 24)}）`, 'aibot_send_msg');
      }
      this.stats.sent += 1;
      return { ok: true };
    } catch (e) {
      this.append('error', `主动推送失败：${errMsg(e)}`, 'aibot_send_msg');
      return { ok: false, message: errMsg(e) };
    }
  }

  /** 上传临时素材（base64 → Buffer → SDK 分片上传）。 */
  async uploadMedia(
    type: WeComMediaType,
    filename: string,
    dataBase64: string,
  ): Promise<{ ok: boolean; message?: string; item?: WeworkMediaItem }> {
    if (!this.client || !this.client.isConnected) {
      return { ok: false, message: '长连接未建立，请先连接' };
    }
    if (!filename.trim()) return { ok: false, message: 'filename 不能为空' };
    let buffer: Buffer;
    try {
      buffer = Buffer.from(dataBase64, 'base64');
    } catch {
      return { ok: false, message: 'dataBase64 解码失败' };
    }
    if (buffer.length < 5) return { ok: false, message: '文件过小（至少 5 字节）' };
    const limit = MEDIA_SIZE_LIMIT[type];
    if (buffer.length > limit) {
      return { ok: false, message: `${type} 超过上限 ${(limit / (1024 * 1024)).toFixed(0)}MB` };
    }
    try {
      const result = await this.client.uploadMedia(buffer, { type, filename: filename.trim() });
      const item: WeworkMediaItem = {
        mediaId: result.media_id,
        type: result.type,
        filename: filename.trim(),
        size: buffer.length,
        at: Date.now(),
      };
      this.recentMedia.unshift(item);
      if (this.recentMedia.length > MAX_RECENT_MEDIA) this.recentMedia.length = MAX_RECENT_MEDIA;
      this.append(
        'out',
        `上传素材成功：${item.filename}（${item.type}，${fmtBytes(item.size)}）→ media_id ${preview(item.mediaId, 24)}`,
        'aibot_upload_media_finish',
        { media_id: item.mediaId, type: item.type },
      );
      return { ok: true, item };
    } catch (e) {
      this.append('error', `上传素材失败：${errMsg(e)}`, 'aibot_upload_media_finish');
      return { ok: false, message: errMsg(e) };
    }
  }

  getState(sinceSeq = 0): WeworkState {
    const logs = sinceSeq > 0 ? this.logs.filter((l) => l.seq > sinceSeq) : this.logs.slice();
    return {
      configured: this.configured,
      botIdMasked: mask(this.cfg.botId),
      wsUrl: this.cfg.wsUrl,
      status: this.status,
      connected: Boolean(this.client?.isConnected),
      autoReply: this.autoReply,
      replyMode: this.replyMode,
      lastChat: this.lastChat,
      stats: { ...this.stats },
      recentMedia: this.recentMedia.slice(),
      mediaDir: this.mediaDir,
      logs,
      latestSeq: this.seqCounter,
    };
  }

  dispose(): void {
    this.teardownClient();
  }

  /* ----------------------------- 内部实现 ----------------------------- */

  private teardownClient(): void {
    if (this.client) {
      try {
        this.client.removeAllListeners();
        this.client.disconnect();
      } catch {
        // 忽略关闭异常
      }
      this.client = null;
    }
  }

  private append(dir: WeworkLogDir, text: string, cmd?: string, detail?: unknown): void {
    const entry: WeworkLogEntry = { seq: ++this.seqCounter, ts: Date.now(), dir, text };
    if (cmd) entry.cmd = cmd;
    if (detail !== undefined) entry.detail = detail;
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
  }

  private rememberChat(body: BaseMessage | EventMessage | undefined): void {
    if (!body) return;
    this.lastChat = {
      chatid: body.chatid,
      chattype: (body as BaseMessage).chattype,
      userid: body.from?.userid,
    };
  }

  private bindEvents(client: WSClient): void {
    client.on('connected', () => {
      this.status = 'connecting';
      this.append('system', 'WebSocket 已连接，等待认证…');
    });
    client.on('authenticated', () => {
      this.status = 'connected';
      this.append('system', '✓ 认证成功，长连接已就绪（aibot_subscribe ok）');
    });
    client.on('disconnected', (reason: string) => {
      this.status = 'closed';
      this.append('system', `连接断开：${reason || '未知原因'}`);
    });
    client.on('reconnecting', (attempt: number) => {
      this.status = 'connecting';
      this.append('system', `正在重连…（第 ${attempt} 次）`);
    });
    client.on('error', (err: Error) => {
      this.append('error', `SDK 错误：${err?.message ?? String(err)}`);
    });

    // 所有消息：统一记一条收件日志
    client.on('message', (frame: WsFrame<BaseMessage>) => {
      const body = frame.body;
      this.stats.received += 1;
      this.rememberChat(body);
      this.append(
        'in',
        `收到 ${body?.msgtype ?? '?'} 消息${
          body?.chattype === 'group' ? `（群 ${body?.chatid ?? ''}）` : `（单聊 ${body?.from?.userid ?? ''}）`
        }：${summarizeMessage(body)}`,
        frame.cmd ?? 'aibot_msg_callback',
        slimMessage(body),
      );
    });

    // 文本消息：按 replyMode 自动回复
    client.on('message.text', (frame: WsFrame<TextMessage>) => {
      void this.replyByMode(frame);
    });

    // 媒体消息：自动下载 + AES 解密落盘
    client.on('message.image', (frame: WsFrame<BaseMessage>) => {
      const img = (frame.body as { image?: { url?: string; aeskey?: string } }).image;
      void this.downloadAndSave('image', img?.url, img?.aeskey);
    });
    client.on('message.file', (frame: WsFrame<BaseMessage>) => {
      const f = (frame.body as { file?: { url?: string; aeskey?: string } }).file;
      void this.downloadAndSave('file', f?.url, f?.aeskey);
    });
    client.on('message.video', (frame: WsFrame<BaseMessage>) => {
      const v = (frame.body as { video?: { url?: string; aeskey?: string } }).video;
      void this.downloadAndSave('video', v?.url, v?.aeskey);
    });

    // 事件回调
    client.on('event', (frame: WsFrame<EventMessage>) => {
      const body = frame.body;
      this.rememberChat(body);
      this.append(
        'in',
        `事件回调：${body?.event?.eventtype ?? '?'}`,
        frame.cmd ?? 'aibot_event_callback',
        slimMessage(body),
      );
    });
    client.on('event.enter_chat', (frame: WsFrame<EventMessage>) => {
      void this.welcomeReply(frame);
    });
    client.on('event.template_card_event', (frame: WsFrame<EventMessage>) => {
      void this.updateCardOnClick(frame);
    });
  }

  /** 按 replyMode 回复文本消息。 */
  private async replyByMode(frame: WsFrame<TextMessage>): Promise<void> {
    if (!this.client || this.replyMode === 'off') return;
    const content = frame.body?.text?.content ?? '';
    try {
      if (this.replyMode === 'stream') {
        const streamId = generateReqId('stream');
        await this.client.replyStream(frame, streamId, '正在思考…', false);
        await this.client.replyStream(
          frame,
          streamId,
          `已收到你的消息：\n\n> ${content}\n\n（KingSDK 工作台流式 echo 测试回复）`,
          true,
        );
        this.append('out', `流式 echo 回复：${preview(content)}`, 'aibot_respond_msg', { streamId });
      } else if (this.replyMode === 'markdown') {
        const streamId = generateReqId('stream');
        await this.client.replyStream(frame, streamId, buildMarkdownSample(content), true);
        this.append('out', 'Markdown 富文本回复（含标题/列表/代码/表格）', 'aibot_respond_msg', { streamId });
      } else if (this.replyMode === 'card') {
        const card = buildSampleCard();
        await this.client.replyTemplateCard(frame, card);
        this.append('out', `模板卡片回复（task_id=${card.task_id}，点按钮可触发更新）`, 'aibot_respond_msg', card);
      } else if (this.replyMode === 'stream_card') {
        const streamId = generateReqId('stream');
        const card = buildSampleCard();
        await this.client.replyStreamWithCard(frame, streamId, '正在处理你的请求…', false, {
          templateCard: card,
        });
        await this.client.replyStreamWithCard(frame, streamId, `处理完成 ✅\n\n你说的是：**${content}**`, true);
        this.append('out', `流式 + 模板卡片组合回复（task_id=${card.task_id}）`, 'aibot_respond_msg', card);
      }
      this.stats.replied += 1;
    } catch (e) {
      this.append('error', `回复失败（${this.replyMode}）：${errMsg(e)}`, 'aibot_respond_msg');
    }
  }

  /** 进入会话事件回欢迎语。 */
  private async welcomeReply(frame: WsFrame<EventMessage>): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.replyWelcome(frame, {
        msgtype: 'text',
        text: { content: '您好！我是 KingSDK 工作台接入的测试机器人，长连接已打通～' },
      });
      this.stats.replied += 1;
      this.append('out', '已回复欢迎语', 'aibot_respond_welcome_msg');
    } catch (e) {
      this.append('error', `回复欢迎语失败：${errMsg(e)}`, 'aibot_respond_welcome_msg');
    }
  }

  /** 模板卡片按钮点击 → 更新卡片。 */
  private async updateCardOnClick(frame: WsFrame<EventMessage>): Promise<void> {
    if (!this.client) return;
    const ev = frame.body?.event as { event_key?: string; task_id?: string } | undefined;
    const key = ev?.event_key ?? '';
    const taskId = ev?.task_id;
    const updated: TemplateCard = {
      card_type: 'text_notice',
      main_title: {
        title: key === 'confirm' ? '已确认 ✅' : key === 'cancel' ? '已取消 ❌' : `已点击：${key || '未知'}`,
        desc: '卡片已通过 aibot_respond_update_msg 更新',
      },
      sub_title_text: `事件 key=${key}`,
      ...(taskId ? { task_id: taskId } : {}),
    };
    try {
      await this.client.updateTemplateCard(frame, updated);
      this.stats.replied += 1;
      this.append('out', `卡片已更新（点击 key=${key}）`, 'aibot_respond_update_msg', updated);
    } catch (e) {
      this.append('error', `更新卡片失败：${errMsg(e)}`, 'aibot_respond_update_msg');
    }
  }

  /** 下载并 AES 解密媒体，落盘到 mediaDir。 */
  private async downloadAndSave(
    kind: WeComMediaType,
    url: string | undefined,
    aeskey: string | undefined,
  ): Promise<void> {
    if (!this.client || !url) return;
    try {
      const { buffer, filename } = await this.client.downloadFile(url, aeskey);
      await mkdir(this.mediaDir, { recursive: true });
      const safe = sanitizeName(filename || `${kind}_${Date.now()}`);
      const outPath = join(this.mediaDir, `${Date.now()}_${safe}`);
      await writeFile(outPath, buffer);
      this.append('in', `已下载并解密${kind}：${safe}（${fmtBytes(buffer.length)}）→ ${outPath}`, 'download');
    } catch (e) {
      this.append('error', `下载/解密${kind}失败：${errMsg(e)}`, 'download');
    }
  }
}

/* ----------------------------- 工具函数 ----------------------------- */

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function preview(s: string, max = 60): string {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
}

function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(2)} ${u[i]}`;
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file';
}

function replyModeLabel(m: WeworkReplyMode): string {
  return (
    {
      off: '不自动回复',
      stream: '流式 echo',
      markdown: 'Markdown 富文本',
      card: '模板卡片',
      stream_card: '流式 + 卡片',
    } as Record<WeworkReplyMode, string>
  )[m];
}

/** 一段演示常见 markdown 语法的示例回复。 */
function buildMarkdownSample(userContent: string): string {
  return [
    '## 🤖 Markdown 富文本回复',
    '',
    `你刚才说：**${userContent}**`,
    '',
    '---',
    '### 列表',
    '- 无序项 A',
    '- 无序项 B',
    '  - 子项 B1',
    '1. 有序项 1',
    '2. 有序项 2',
    '',
    '> 这是一段引用',
    '',
    '`行内代码` 与代码块：',
    '```',
    'console.log("hello kingsdk");',
    '```',
    '',
    '| 名称 | 值 |',
    '| :-- | --: |',
    '| 流式 | ✅ |',
    '| 卡片 | ✅ |',
  ].join('\n');
}

/** 构造一张按钮交互模板卡片（带确认/取消按钮，可点击触发 template_card_event）。 */
function buildSampleCard(): TemplateCard {
  return {
    card_type: 'button_interaction',
    source: { desc: 'KingSDK 工作台' },
    main_title: { title: 'KingSDK 测试卡片', desc: '点击下方按钮会触发 template_card_event' },
    sub_title_text: '点击后机器人会自动更新这张卡片',
    horizontal_content_list: [
      { keyname: '类型', value: 'button_interaction' },
      { keyname: '用途', value: '连通性测试' },
    ],
    button_list: [
      { text: '确认', key: 'confirm', style: 1 },
      { text: '取消', key: 'cancel', style: 2 },
    ],
    task_id: `task_${Date.now()}`,
  };
}

function summarizeMessage(body: BaseMessage | undefined): string {
  if (!body) return '';
  switch (body.msgtype) {
    case 'text':
      return preview((body as TextMessage).text?.content ?? '');
    case 'image':
      return '[图片]';
    case 'voice':
      return `[语音] ${preview((body as { voice?: { content?: string } }).voice?.content ?? '')}`;
    case 'file':
      return '[文件]';
    case 'video':
      return '[视频]';
    case 'mixed':
      return '[图文混排]';
    default:
      return `[${body.msgtype}]`;
  }
}

/** 裁剪消息体用于日志 detail：截断长 url，隐藏 aeskey。 */
function slimMessage(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  try {
    return JSON.parse(
      JSON.stringify(body, (key, value) => {
        if (key === 'url' && typeof value === 'string' && value.length > 80) {
          return value.slice(0, 80) + '…(truncated)';
        }
        if (key === 'aeskey' && typeof value === 'string') return '***';
        return value;
      }),
    );
  } catch {
    return undefined;
  }
}
