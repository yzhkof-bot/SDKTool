/**
 * 从 AXML DOM 树抽出 AndroidManifestInfo。
 *
 * 拆成独立文件而不是塞进 axml.ts 是因为这层与 manifest 语义强耦合（理解 <uses-sdk>、
 * <uses-permission>、<application> 内四大组件等 Android 概念），而 axml.ts 仅做
 * 通用 AXML 解析，可被未来的 layout / resources xml 复用。
 */

import type { AndroidManifestInfo } from '@kingsdk/shared/schema.js';
import type { AxmlAttribute, AxmlNode } from './axml.js';

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

/** 从 AXML 根节点抽 AndroidManifestInfo；非致命问题累积到 warnings 数组里。 */
export function extractAndroidManifest(root: AxmlNode | null): AndroidManifestInfo {
  const info: AndroidManifestInfo = {};
  const warnings: string[] = [];

  if (!root) {
    warnings.push('AXML has no root element');
    return { ...info, warnings };
  }
  if (root.name !== 'manifest') {
    warnings.push(`expected root <manifest>, got <${root.name}>`);
    return { ...info, warnings };
  }

  // manifest 自身的属性：package 不在 android: namespace 下（特殊），其余 android:xxx 走 ns
  const pkg = pickAttr(root.attributes, null, 'package');
  if (pkg) info.packageName = pkg.value;

  const versionCode = pickAttr(root.attributes, ANDROID_NS, 'versionCode');
  if (versionCode) {
    const n = parseIntStrict(versionCode);
    if (n !== undefined) info.versionCode = n;
  }
  const versionName = pickAttr(root.attributes, ANDROID_NS, 'versionName');
  if (versionName) info.versionName = versionName.value;

  // 子节点遍历
  const usesPermissions: string[] = [];
  const seenPerms = new Set<string>();
  const components = {
    activities: [] as string[],
    services: [] as string[],
    receivers: [] as string[],
    providers: [] as string[],
  };

  for (const child of root.children) {
    switch (child.name) {
      case 'uses-sdk': {
        const sdk: NonNullable<AndroidManifestInfo['usesSdk']> = {};
        const minA = pickAttr(child.attributes, ANDROID_NS, 'minSdkVersion');
        const tgtA = pickAttr(child.attributes, ANDROID_NS, 'targetSdkVersion');
        const maxA = pickAttr(child.attributes, ANDROID_NS, 'maxSdkVersion');
        const minV = minA ? parseIntStrict(minA) : undefined;
        const tgtV = tgtA ? parseIntStrict(tgtA) : undefined;
        const maxV = maxA ? parseIntStrict(maxA) : undefined;
        if (minV !== undefined) sdk.minSdkVersion = minV;
        if (tgtV !== undefined) sdk.targetSdkVersion = tgtV;
        if (maxV !== undefined) sdk.maxSdkVersion = maxV;
        if (Object.keys(sdk).length > 0) info.usesSdk = sdk;
        break;
      }
      case 'uses-permission':
      case 'uses-permission-sdk-23': {
        const nameAttr = pickAttr(child.attributes, ANDROID_NS, 'name');
        if (nameAttr && nameAttr.value && !seenPerms.has(nameAttr.value)) {
          seenPerms.add(nameAttr.value);
          usesPermissions.push(nameAttr.value);
        }
        break;
      }
      case 'application': {
        const labelA = pickAttr(child.attributes, ANDROID_NS, 'label');
        if (labelA) info.applicationLabel = labelA.value;
        const iconA = pickAttr(child.attributes, ANDROID_NS, 'icon');
        if (iconA) info.applicationIcon = iconA.value;
        const debugA = pickAttr(child.attributes, ANDROID_NS, 'debuggable');
        if (debugA) info.debuggable = parseBoolean(debugA);

        for (const c of child.children) {
          const compName = pickAttr(c.attributes, ANDROID_NS, 'name');
          if (!compName || !compName.value) continue;
          const fqcn = resolveComponentName(info.packageName, compName.value);
          switch (c.name) {
            case 'activity':
            case 'activity-alias':
              components.activities.push(fqcn);
              break;
            case 'service':
              components.services.push(fqcn);
              break;
            case 'receiver':
              components.receivers.push(fqcn);
              break;
            case 'provider':
              components.providers.push(fqcn);
              break;
            default:
              // meta-data / uses-library 等不算组件，忽略
              break;
          }
        }
        break;
      }
      default:
        // <queries> <permission> <permission-group> 等本期不抽
        break;
    }
  }

  if (usesPermissions.length > 0) info.usesPermissions = usesPermissions;
  if (
    components.activities.length +
      components.services.length +
      components.receivers.length +
      components.providers.length >
    0
  ) {
    info.components = components;
  }

  if (warnings.length > 0) info.warnings = warnings;
  return info;
}

/**
 * <activity android:name=".MainActivity"> 这种"省略包名"的写法需要拼上 packageName，
 * Android 平台规则：以 '.' 开头的相对类名按 manifest package 解析为绝对 FQCN。
 *
 * 如果 name 已经是绝对 FQCN（含 '.' 但不以 '.' 开头）或干脆没 packageName，
 * 直接返回原值。
 */
function resolveComponentName(pkg: string | undefined, name: string): string {
  if (!pkg) return name;
  if (name.startsWith('.')) return pkg + name;
  if (!name.includes('.')) return pkg + '.' + name;
  return name;
}

/**
 * 严格解析整数：
 *  - 优先用 typedValue.data（数字类型时 100% 正确，绕过字符串）
 *  - fallback 到字符串 parseInt（兼容 versionCode 写成 "123" 的边角情况）
 */
function parseIntStrict(attr: AxmlAttribute): number | undefined {
  const dt = attr.typedValue.dataType;
  // 0x10 INT_DEC, 0x11 INT_HEX, 0x12 INT_BOOLEAN
  if (dt === 0x10 || dt === 0x11) return attr.typedValue.data | 0;
  if (dt === 0x12) return attr.typedValue.data === 0 ? 0 : 1;
  const s = attr.value.trim();
  if (!s) return undefined;
  const n = s.startsWith('0x') || s.startsWith('0X') ? parseInt(s.slice(2), 16) : parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseBoolean(attr: AxmlAttribute): boolean | undefined {
  if (attr.typedValue.dataType === 0x12) return attr.typedValue.data !== 0;
  const v = attr.value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function pickAttr(
  attrs: AxmlAttribute[],
  namespace: string | null,
  name: string,
): AxmlAttribute | undefined {
  for (const a of attrs) {
    if (a.name === name && (a.namespace ?? null) === namespace) return a;
  }
  return undefined;
}
