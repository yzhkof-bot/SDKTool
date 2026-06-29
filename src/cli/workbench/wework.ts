/**
 * 企业微信智能机器人长连接管理器（封装官方 SDK @wecom/aibot-node-sdk）。
 *
 * 定位：仅供 workbench「企业微信机器人」测试界面使用，验证 BotID/Secret 能否建立长连接、
 * 收发消息是否打通。**不接入项目任何分析/对比功能**，是一个独立的连通性测试器。
 *
 * 设计：
 *  - 进程内单例（一个 botId 同一时刻只能有一个有效长连接，SDK 内部已含心跳/重连）
 *  - 维护一个环形日志缓冲（连接/认证/收消息/回消息/事件/错误），前端按 seq 增量轮询
 *  - 收到文本消息可选自动 echo 回复（autoReply），快速验证「用户发 → 机器人收 → 回复」闭环
 *  - 收到进入会话事件自动回欢迎语（5 秒内）
 *  - 暴露主动推送（sendMessage）供测试主动发消息
 *
 * 注意：所有 SDK 调用都包了 try/catch，单条失败只记日志，不影响长连接本身。
 */

import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type {
  WsFrame,
  BaseMessage,
  TextMessage,
  EventMessage,
} from '@wecom/aibot-node-sdk';

import type { WeworkConfig } from './devopsConfig.js';

/** 连接状态机。 */
export type WeworkStatus =
  | 'idle' // 未连接（初始 / 主动断开后）
  | 'connecting' // 正在建连 / 认证 / 重连中
  | 'connected' // 已认证，可收发
  | 'closed' // 连接断开（可能在重连）
  | 'error'; // 配置缺失或致命错误

/** 一条日志的方向/级别。 */
export type WeworkLogDir = 'system' | 'in' | 'out' | 'error';

/** 环形日志缓冲里的一条记录。 */
export interface WeworkLogEntry {
  /** 自增序号，前端据此做增量轮询 */
  seq: number;
  /** epoch 毫秒 */
  ts: number;
  dir: WeworkLogDir;
  /** WebSocket 命令（aibot_msg_callback / aibot_respond_msg / ping 等），可空 */
  cmd?: string;
  /** 人类可读摘要（前端主显示） */
  text: string;
  /** 原始结构（点开可查看，已尽量裁剪体积） */
  detail?: unknown;
}

/** 最近一次会话上下文，方便测试界面「回到最近会话主动发消息」。 */
export interface WeworkLastChat {
  chatid?: string;
  chattype?: string;
  userid?: string;
}

/** 给前端的状态快照（含增量日志）。 */
export interface WeworkState {
  /** botId/secret 是否都已配置 */
  configured: boolean;
  /** 脱敏后的 botId（前 6 + … + 后 4），未配置为空串 */
  botIdMasked: string;
  wsUrl: string;
  status: WeworkStatus;
  connected: boolean;
  autoReply: boolean;
  lastChat: WeworkLastChat | null;
  stats: { received: number; replied: number; sent: number };
  /** 自请求的 sinceSeq 之后的新日志（升序） */
  logs: WeworkLogEntry[];
  /** 当前缓冲里的最大 seq（首屏 / 增量基准） */
  latestSeq: number;
}

const MAX_LOG_ENTRIES = 1000;

/** 脱敏 botId / secret，避免日志或前端泄露完整凭据。 */
function mask(s: string): string {
  if (!s) return '';
  if (s.length <= 12) return s.slice(0, 2) + '***';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export class WeworkBotManager {
  private readonly cfg: WeworkConfig;
  private readonly log: (t: string) => void;

  private client: WSClient | null = null;
  private status: WeworkStatus = 'idle';
  private autoReply: boolean;
  private lastChat: WeworkLastChat | null = null;
  private readonly stats = { received: 0, replied: 0, sent: 0 };

  private readonly logs: WeworkLogEntry[] = [];
  private seqCounter = 0;

  constructor(cfg: WeworkConfig, log: (t: string) => void) {
    this.cfg = cfg;
    this.autoReply = cfg.autoReply;
    this.log = log;
  }

  get configured(): boolean {
    return Boolean(this.cfg.botId && this.cfg.secret);
  }

  /* ----------------------------- 公开操作 ----------------------------- */

  /** 建立长连接（已连接则先断开重连）。返回是否成功发起。 */
  connect(): { ok: boolean; message?: string } {
    if (!this.configured) {
      this.status = 'error';
      this.append('error', '未配置 BotID / Secret，请在 pipelines.config.json 的 wework 段填写');
      return { ok: false, message: 'wework 未配置 botId / secret' };
    }
    // 已有连接先拆掉，避免同一 bot 多连接互踢
    this.teardownClient();

    this.status = 'connecting';
    this.append('system', `正在连接 ${this.cfg.wsUrl} …（bot ${mask(this.cfg.botId)}）`);

    let client: WSClient;
    try {
      client = new WSClient({
        botId: this.cfg.botId,
        secret: this.cfg.secret,
        wsUrl: this.cfg.wsUrl,
        // 测试场景：有限重连，避免凭据错误时无限重连刷屏
        maxReconnectAttempts: 5,
        // 收敛 SDK 自身日志到 workbench 日志（debug 静默）
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

  /** 主动断开长连接。 */
  disconnect(): void {
    this.teardownClient();
    this.status = 'idle';
    this.append('system', '已主动断开连接');
  }

  /** 切换自动 echo 回复开关。 */
  setAutoReply(enabled: boolean): void {
    this.autoReply = enabled;
    this.append('system', `自动回复已${enabled ? '开启' : '关闭'}`);
  }

  /** 清空日志缓冲（seq 不回退，前端会以新的 latestSeq 为基准）。 */
  clearLog(): void {
    this.logs.length = 0;
    this.append('system', '日志已清空');
  }

  /**
   * 主动推送一条 markdown 消息到指定会话。
   * chatid：单聊填用户 userid，群聊填群 chatid。
   */
  async sendMarkdown(chatid: string, content: string): Promise<{ ok: boolean; message?: string }> {
    if (!this.client || !this.client.isConnected) {
      return { ok: false, message: '长连接未建立，请先连接' };
    }
    if (!chatid.trim()) return { ok: false, message: 'chatid 不能为空' };
    if (!content.trim()) return { ok: false, message: '消息内容不能为空' };
    try {
      await this.client.sendMessage(chatid.trim(), {
        msgtype: 'markdown',
        markdown: { content },
      });
      this.stats.sent += 1;
      this.append('out', `主动推送到 ${chatid.trim()}：${preview(content)}`, 'aibot_send_msg', {
        chatid: chatid.trim(),
        content,
      });
      return { ok: true };
    } catch (e) {
      this.append('error', `主动推送失败：${errMsg(e)}`, 'aibot_send_msg');
      return { ok: false, message: errMsg(e) };
    }
  }

  /** 给前端的状态快照（含 sinceSeq 之后的增量日志）。 */
  getState(sinceSeq = 0): WeworkState {
    const logs = sinceSeq > 0 ? this.logs.filter((l) => l.seq > sinceSeq) : this.logs.slice();
    return {
      configured: this.configured,
      botIdMasked: mask(this.cfg.botId),
      wsUrl: this.cfg.wsUrl,
      status: this.status,
      connected: Boolean(this.client?.isConnected),
      autoReply: this.autoReply,
      lastChat: this.lastChat,
      stats: { ...this.stats },
      logs,
      latestSeq: this.seqCounter,
    };
  }

  /** 进程退出 / server 关闭时调用。 */
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

    // 所有消息（统一记一条收件日志）
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

    // 文本消息：可选自动 echo 回复（流式两段，演示流式刷新）
    client.on('message.text', (frame: WsFrame<TextMessage>) => {
      if (!this.autoReply) return;
      void this.echoReply(frame);
    });

    // 事件回调（统一记一条）
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

    // 进入会话事件：自动回欢迎语（需 5 秒内）
    client.on('event.enter_chat', (frame: WsFrame<EventMessage>) => {
      void this.welcomeReply(frame);
    });
  }

  /** 文本消息 echo 回复（流式：先「思考中」，再回显内容）。 */
  private async echoReply(frame: WsFrame<TextMessage>): Promise<void> {
    if (!this.client) return;
    const content = frame.body?.text?.content ?? '';
    const streamId = generateReqId('stream');
    try {
      await this.client.replyStream(frame, streamId, '正在思考…', false);
      await this.client.replyStream(
        frame,
        streamId,
        `已收到你的消息：\n\n> ${content}\n\n（这是 KingSDK 工作台的连通性测试自动回复）`,
        true,
      );
      this.stats.replied += 1;
      this.append('out', `已 echo 回复：${preview(content)}`, 'aibot_respond_msg', { streamId, content });
    } catch (e) {
      this.append('error', `echo 回复失败：${errMsg(e)}`, 'aibot_respond_msg');
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
}

/* ----------------------------- 工具函数 ----------------------------- */

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 截断长文本用于摘要展示。 */
function preview(s: string, max = 60): string {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
}

/** 不同消息类型的一句话摘要。 */
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

/**
 * 裁剪消息体用于日志 detail：去掉可能很长的 url，保留结构关键字段。
 * 避免把 5 分钟有效的下载直链长期留在内存/前端。
 */
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
