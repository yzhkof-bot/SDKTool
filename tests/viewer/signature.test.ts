/**
 * Viewer signature section 渲染回归。
 *
 * 关注点：
 *  - Android 多版本签名 scheme 的 badge 渲染
 *  - APK Signing Block 的 ID-value 表格
 *  - HarmonyOS 报告（只有 present + 证书）渲染不被破坏
 */

import { describe, expect, it } from 'vitest';

import type { PackageReport, PackageSignatureInfo } from '../../src/shared/schema.js';
import { renderSignature } from '../../src/viewer/sections/signature.js';

function reportWithSignature(
  platform: 'harmony' | 'android',
  sig: PackageSignatureInfo,
): PackageReport {
  return {
    schemaVersion: '1.0',
    platform,
    meta: {
      file: '/tmp/x',
      fileSize: 1,
      sha256: 'a'.repeat(64),
      analyzedAt: '2026-01-01T00:00:00.000Z',
      toolVersion: 'test',
    },
    warnings: [],
    signature: sig,
  };
}

describe('viewer/sections/signature', () => {
  it('HarmonyOS 已签 + 证书：渲染 Subject/Issuer/有效期，不显示 Android 块', () => {
    const el = renderSignature(
      reportWithSignature('harmony', {
        present: true,
        subject: 'CN=King',
        issuer: 'CN=Root',
        notBefore: '2024-01-01T00:00:00Z',
        notAfter: '2030-01-01T00:00:00Z',
      }),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('已签名');
    expect(text).toContain('CN=King');
    expect(text).toContain('CN=Root');
    expect(text).not.toContain('Android 签名方案');
    expect(text).not.toContain('APK Signing Block');
  });

  it('Android v1+v2+v3：渲染 4 个 scheme 标签，命中的标 success', () => {
    const el = renderSignature(
      reportWithSignature('android', {
        present: true,
        versions: { v1: true, v2: true, v3: true, v31: false },
        signingBlock: {
          totalBytes: 1024,
          offset: 4096,
          entries: [
            { idHex: '0x7109871a', name: 'V2 Signature', sizeBytes: 256 },
            { idHex: '0xf05368c0', name: 'V3 Signature', sizeBytes: 384 },
            { idHex: '0x504b4453', name: 'Padding', sizeBytes: 16 },
          ],
        },
      }),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('Android 签名方案');
    expect(text).toContain('v1 (META-INF)');
    expect(text).toContain('v2');
    expect(text).toContain('v3');
    expect(text).toContain('v3.1');
    expect(text).toContain('APK Signing Block');
    expect(text).toContain('V2 Signature');
    expect(text).toContain('V3 Signature');
    expect(text).toContain('Padding');
    expect(text).toContain('0x7109871a');
  });

  it('未签名 + Android versions：仍渲染"未签"提示 + scheme 概览', () => {
    const el = renderSignature(
      reportWithSignature('android', {
        present: false,
        versions: { v1: false, v2: false, v3: false, v31: false },
      }),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('未签名');
    expect(text).toContain('Android 签名方案');
  });

  it('signature 字段缺失：友好 emptyState', () => {
    const el = renderSignature({
      schemaVersion: '1.0',
      platform: 'android',
      meta: {
        file: '/tmp/x',
        fileSize: 1,
        sha256: 'a'.repeat(64),
        analyzedAt: '2026-01-01T00:00:00.000Z',
        toolVersion: 'test',
      },
      warnings: [],
    });
    expect(el.textContent ?? '').toContain('无 signature 数据');
  });
});
