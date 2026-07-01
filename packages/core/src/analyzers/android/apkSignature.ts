import { open as fsOpen, stat as fsStat } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';

import type {
  Analyzer,
  AnalyzerContext,
  ApkSignatureBlockEntry,
  ApkSignatureVersions,
  PackageEntry,
  PackageReport,
  PackageSignatureInfo,
} from '@kingsdk/shared/schema.js';

import { parseApkSigningBlock } from './_apkSignature.js';

/**
 * Android：APK 签名（v1/v2/v3/v3.1）分析。默认开。
 *
 * 与 HarmonyOS signatureAnalyzer 关系：
 *  - HarmonyOS hap 只有 v1 JAR Signing（META-INF/*.RSA + .SF + .MF）
 *  - Android APK 在 v1 之上还可能叠 v2/v3/v3.1（APK Signing Block）
 *  - 两者输出都是 `PackageSignatureInfo`，但 Android 多填 `versions` 和 `signingBlock` 两个可选字段
 *
 * 实现要点：
 *  1) v1 检测：枚举 zip entry，按 harmony 同款 META-INF 规则识别
 *  2) v2/v3 检测：用 fs 直接读 APK 末尾窗口（最大 5 MB，足够覆盖 EOCD + signing block），
 *     调用 `parseApkSigningBlock` 拿到 pair 列表，按 ID 标记 v2/v3/v3.1
 *  3) 证书提取：优先从 META-INF/*.RSA/.EC/.DSA 容器抽 X.509（与 harmony 同套 ASN.1 扫描），
 *     成功填 subject/issuer/notBefore/notAfter
 *
 * 失败处理：
 *  - 读 APK 文件失败（in-memory VirtualPackage 没有真实磁盘路径）→ warning，跳过 v2/v3 检测，
 *    仍能输出 v1 + signature 基础信息
 *  - signing block magic 不匹配 → versions.v2/v3/v31 全 false，但不报警告（正常未签 v2 的情况）
 *  - signing block 损坏 → warning，仍输出 versions（按已识别 v1 算）
 */
export const androidApkSignatureAnalyzer: Analyzer = {
  id: 'androidApkSignature',
  name: 'Android APK Signature',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const v1Entries = collectV1Entries(ctx.hap.entries);
    const hasV1 = v1Entries.containers.length > 0 || v1Entries.sfFiles.length > 0;

    // v2/v3 检测：读 APK 末尾窗口
    const versions: ApkSignatureVersions = { v1: hasV1, v2: false, v3: false, v31: false };
    let signingBlock: PackageSignatureInfo['signingBlock'];

    try {
      const tailBuf = await readApkTail(ctx.hap.filePath);
      const parsed = parseApkSigningBlock(tailBuf);
      for (const w of parsed.warnings) {
        ctx.addWarning({
          code: 'APK_SIG_BLOCK_WARN',
          level: 'warn',
          message: w,
        });
      }
      if (parsed.signingBlock) {
        signingBlock = parsed.signingBlock;
        markVersionsByPairs(versions, parsed.signingBlock.entries);
      }
    } catch (err) {
      ctx.addWarning({
        code: 'APK_SIG_TAIL_READ_FAILED',
        level: 'warn',
        message: `读取 APK 末尾用于 signing block 解析失败: ${(err as Error).message ?? String(err)}（仅 v2/v3 检测被跳过；v1 不受影响）`,
      });
    }

    // 证书：从 v1 容器抽 X.509
    const out: PackageSignatureInfo = { present: hasV1 || versions.v2 || versions.v3 || versions.v31 };
    out.versions = versions;
    if (signingBlock) out.signingBlock = signingBlock;

    for (const entry of v1Entries.containers) {
      try {
        const buf = await ctx.hap.readFile(entry.path);
        const cert = findFirstX509(buf);
        if (cert) {
          out.subject = cert.subject;
          out.issuer = cert.issuer;
          out.notBefore = cert.validFrom;
          out.notAfter = cert.validTo;
          break;
        }
      } catch (err) {
        ctx.addWarning({
          code: 'APK_SIG_CERT_READ_FAILED',
          level: 'warn',
          message: `读取 ${entry.path} 失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (out.present && !out.subject) {
      ctx.addWarning({
        code: 'APK_SIG_CERT_NOT_EXTRACTED',
        level: 'info',
        message:
          '检测到签名（v1 或 v2+），但未能从 META-INF 容器抽取 X.509 证书；仅输出 versions + signingBlock 结构信息',
      });
    }

    return { signature: out };
  },
};

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

const V1_ENTRY_RE = /^META-INF\/.+\.(rsa|ec|dsa|sf|mf|p7b)$/i;
const CONTAINER_RE = /\.(rsa|ec|dsa|p7b)$/i;

function collectV1Entries(entries: PackageEntry[]): {
  containers: PackageEntry[];
  sfFiles: PackageEntry[];
} {
  const containers: PackageEntry[] = [];
  const sfFiles: PackageEntry[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (!V1_ENTRY_RE.test(e.path)) continue;
    if (CONTAINER_RE.test(e.path)) containers.push(e);
    else if (/\.sf$/i.test(e.path)) sfFiles.push(e);
  }
  return { containers, sfFiles };
}

/** APK 末尾读窗口大小：5 MB 足够覆盖 EOCD(22) + signing block（通常 < 100 KB） */
const APK_TAIL_WINDOW = 5 * 1024 * 1024;

async function readApkTail(filePath: string): Promise<Buffer> {
  const st = await fsStat(filePath);
  if (!st.isFile()) {
    throw new Error(`not a regular file: ${filePath}`);
  }
  const size = st.size;
  const winSize = Math.min(size, APK_TAIL_WINDOW);
  const offset = size - winSize;
  const buf = Buffer.alloc(winSize);
  const fh = await fsOpen(filePath, 'r');
  try {
    await fh.read(buf, 0, winSize, offset);
  } finally {
    await fh.close();
  }
  return buf;
}

const SIG_ID_V2 = '0x7109871a';
const SIG_ID_V3 = '0xf05368c0';
const SIG_ID_V31 = '0x1b93ad61';

function markVersionsByPairs(versions: ApkSignatureVersions, entries: ApkSignatureBlockEntry[]): void {
  for (const e of entries) {
    if (e.idHex === SIG_ID_V2) versions.v2 = true;
    else if (e.idHex === SIG_ID_V3) versions.v3 = true;
    else if (e.idHex === SIG_ID_V31) versions.v31 = true;
  }
}

/**
 * 在 buffer 中扫描 ASN.1 SEQUENCE，依次尝试解析为 X.509。
 *
 * 与 harmony/signature.ts 中同名函数同实现；不抽到公共 helper 是为了让两个平台
 * 的 analyzer 各自独立（避免双向 import / 平台耦合）。
 */
function findFirstX509(buf: Buffer): X509Certificate | undefined {
  for (let i = 0; i < buf.length - 4; i += 1) {
    if (buf[i] !== 0x30 || buf[i + 1] !== 0x82) continue;
    const len = buf.readUInt16BE(i + 2);
    const total = 4 + len;
    if (i + total > buf.length) continue;
    try {
      const slice = buf.subarray(i, i + total);
      const cert = new X509Certificate(slice);
      if (cert.subject) return cert;
    } catch {
      // not a valid X.509 here, keep scanning
    }
  }
  return undefined;
}
