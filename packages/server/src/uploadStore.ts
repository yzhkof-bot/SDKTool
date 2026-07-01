/**
 * 上传制品临时存储。
 *
 * 分析/对比的「本地文件」来源统一走上传：浏览器把文件字节 PUT/POST 到
 * `/api/uploads`，server 边收边写盘到 `<cacheDir>/uploads/<uploadId><ext>`，
 * 返回 uploadId；随后 analyze/compare 用 `{ kind:'upload', uploadId }` 引用它。
 *
 * 设计要点：
 *  - 流式落盘：请求体直接 pipe 到磁盘，绝不整包读进内存（包可达数百 MB）。
 *  - 一次性消费：runner 解析成本地路径分析后，release() 删除临时文件。
 *  - 启动即清空 uploads/：上次进程遗留的半截上传/未消费文件都是垃圾，无恢复价值
 *    （与 JobStore 会恢复历史不同——上传件是瞬时中间产物）。
 *  - 与 web/desktop 模式无关：两端都用同一套上传流（同机 localhost 上传同样零风险）。
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { pipeline } from 'node:stream/promises';

/** 单个上传文件大小上限：512 MiB（远超常见 hap/apk，兜底防磁盘被写爆）。 */
export const DEFAULT_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

export interface UploadRecord {
  uploadId: string;
  /** 原始文件名（仅展示 / 推断后缀用；不参与磁盘路径拼接以外的逻辑） */
  name: string;
  /** 落盘绝对路径 */
  path: string;
  /** 实际写入字节数 */
  size: number;
}

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export class UploadStore {
  readonly dir: string;

  constructor(
    cacheDir: string,
    private readonly maxBytes: number = DEFAULT_UPLOAD_MAX_BYTES,
  ) {
    this.dir = join(cacheDir, 'uploads');
    // 启动清空：遗留的临时上传件无恢复价值
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* 删不动就算了，下面重建目录即可复用 */
    }
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 从请求体流式落盘一个上传文件。
   *
   * 保留原始文件后缀（analyze/compare 靠后缀区分 .hap/.apk/.json 等），文件名主体
   * 用随机 uploadId，避免路径穿越与重名覆盖。超过 maxBytes 立即中断并删残留。
   */
  async saveFromRequest(req: IncomingMessage, name: string): Promise<UploadRecord> {
    const uploadId = randomBytes(8).toString('hex');
    const ext = safeExt(name);
    const path = join(this.dir, `${uploadId}${ext}`);

    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > this.maxBytes && !tooLarge) {
        tooLarge = true;
        req.destroy(new UploadError(`上传文件超过 ${(this.maxBytes / (1024 * 1024)).toFixed(0)} MiB 上限`, 413));
      }
    });

    try {
      await pipeline(req, createWriteStream(path));
    } catch (e) {
      // 落盘失败 / 超限中断：清残留，转成可读错误
      await rm(path, { force: true }).catch(() => {});
      if (e instanceof UploadError) throw e;
      throw new UploadError(`上传写入失败：${(e as Error).message}`, 400);
    }

    if (received === 0) {
      await rm(path, { force: true }).catch(() => {});
      throw new UploadError('上传内容为空', 400);
    }

    return { uploadId, name, path, size: received };
  }

  /**
   * 把 uploadId 解析成本地路径，返回 { path, release }。
   * release() 删除临时文件（分析结束后由 runner 调用，一次性消费）。
   * uploadId 不存在（已消费 / 从未上传 / 进程重启丢失）→ UploadError 404。
   */
  acquire(uploadId: string): { path: string; release: () => void } {
    if (!/^[0-9a-f]{16}$/.test(uploadId)) {
      throw new UploadError('uploadId 非法', 400);
    }
    // 后缀未知，扫目录找以该 id 开头的文件
    const path = this.findByPrefix(uploadId);
    if (!path) throw new UploadError(`上传文件不存在或已被消费：${uploadId}`, 404);
    return {
      path,
      release: () => {
        try {
          rmSync(path, { force: true });
        } catch {
          /* 删不动容忍，启动清理会兜底 */
        }
      },
    };
  }

  private findByPrefix(uploadId: string): string | null {
    // 常见后缀直接命中，避免 readdir；未命中再兜底 readdir。
    for (const ext of ['.hap', '.apk', '.aab', '.ipa', '.json', '']) {
      const p = join(this.dir, `${uploadId}${ext}`);
      if (existsSync(p)) return p;
    }
    return null;
  }
}

/**
 * 从原始文件名提取「安全后缀」：只取最后一段 .xxx，长度 ≤10、纯字母数字，
 * 否则返回空串。杜绝 `../` 或超长/含分隔符的后缀污染磁盘路径。
 */
function safeExt(name: string): string {
  const ext = extname(name || '').toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(ext)) return ext;
  return '';
}
