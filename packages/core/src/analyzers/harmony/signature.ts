import { X509Certificate } from 'node:crypto';

import type {
  Analyzer,
  AnalyzerContext,
  PackageEntry,
  PackageReport,
  PackageSignatureInfo,
} from '@kingsdk/shared/schema.js';

/**
 * 签名信息分析（仅读不验证）。
 *
 * HarmonyOS hap 的签名块通常位于 META-INF/ 下：
 *  - META-INF/CERT.RSA  / CERT.EC / CERT.DSA   PKCS#7 签名容器
 *  - META-INF/CERT.SF                           签名摘要文件
 *  - META-INF/MANIFEST.MF                       清单
 *  - 偶见 .p7b 形式
 *
 * 我们不做完整 PKCS#7 解析（避免引入 node-forge），改用一个启发式扫描：
 *   在 PKCS#7 容器字节流中寻找形如 0x30 0x82 XX XX 的 ASN.1 SEQUENCE，
 *   依次喂给 Node 内置的 X509Certificate，第一个能解析成功的当作叶子证书。
 *
 * 这对绝大多数标准 hap 签名都能拿到 subject / issuer / notBefore / notAfter；
 * 解析失败时仍输出 present=true，其它字段缺省。
 */
export const signatureAnalyzer: Analyzer = {
  id: 'signature',
  name: 'Signature',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const sigEntries = findSignatureEntries(ctx.hap.entries);
    if (sigEntries.length === 0) {
      const signature: PackageSignatureInfo = { present: false };
      return { signature };
    }

    const out: PackageSignatureInfo = { present: true };

    // 优先解析 PKCS#7 容器（.RSA/.EC/.DSA/.p7b）
    const containers = sigEntries.filter((e) => CONTAINER_RE.test(e.path));
    for (const entry of containers) {
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
          code: 'SIGNATURE_PARSE_FAILED',
          level: 'warn',
          message: `读取 ${entry.path} 失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (out.subject === undefined) {
      ctx.addWarning({
        code: 'CERT_DECODE_SKIPPED',
        level: 'info',
        message:
          '签名文件存在但未能从 PKCS#7 容器中提取 X.509 证书，仅返回 present=true（不做完整 PKCS#7 解析）',
      });
    }

    return { signature: out };
  },
};

/* ------------------------------------------------------------------ */

const SIGNATURE_RE = /^META-INF\/.+\.(rsa|ec|dsa|sf|mf|p7b)$/i;
const CONTAINER_RE = /\.(rsa|ec|dsa|p7b)$/i;

function findSignatureEntries(entries: PackageEntry[]): PackageEntry[] {
  return entries.filter((e) => !e.isDirectory && SIGNATURE_RE.test(e.path));
}

/**
 * 在 buffer 中扫描 ASN.1 SEQUENCE，依次尝试解析为 X.509。
 *
 * X.509 证书 DER 通常以 0x30 0x82 LL LL 开头，长度紧跟其后；
 * 我们在每个候选起点切片后交给 X509Certificate，捕获异常继续扫。
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
      // 至少要能取到 subject 才认为是叶子证书
      if (cert.subject) return cert;
    } catch {
      // not a valid X.509 here, keep scanning
    }
  }
  return undefined;
}
