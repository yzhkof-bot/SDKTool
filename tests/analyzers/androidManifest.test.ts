import { describe, expect, it } from 'vitest';

import { parseAxml } from '@kingsdk/core/analyzers/android/axml.js';
import { extractAndroidManifest } from '@kingsdk/core/analyzers/android/manifestExtract.js';
import { buildAxml } from '../helpers/fixtureAxml.js';

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

/**
 * 一个比较有代表性的 manifest：
 *   - manifest package + versionCode/versionName
 *   - uses-sdk 三件
 *   - 两个 uses-permission（验证去重）
 *   - application label/icon/debuggable
 *   - 四种组件各一个，验证 ".XXX" → packageName.XXX 的 FQCN 解析
 */
function makeFullManifestBuffer() {
  return buildAxml({
    namespaces: [{ prefix: 'android', uri: ANDROID_NS }],
    root: {
      name: 'manifest',
      attributes: [
        { name: 'package', value: { kind: 'string', value: 'com.example.test' } },
        { ns: ANDROID_NS, name: 'versionCode', value: { kind: 'int', value: 42 } },
        { ns: ANDROID_NS, name: 'versionName', value: { kind: 'string', value: '1.2.3' } },
      ],
      children: [
        {
          name: 'uses-sdk',
          attributes: [
            { ns: ANDROID_NS, name: 'minSdkVersion', value: { kind: 'int', value: 21 } },
            { ns: ANDROID_NS, name: 'targetSdkVersion', value: { kind: 'int', value: 33 } },
          ],
        },
        {
          name: 'uses-permission',
          attributes: [
            { ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: 'android.permission.INTERNET' } },
          ],
        },
        {
          name: 'uses-permission',
          attributes: [
            { ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: 'android.permission.CAMERA' } },
          ],
        },
        // 重复一次：应该被 extractor 去重
        {
          name: 'uses-permission',
          attributes: [
            { ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: 'android.permission.INTERNET' } },
          ],
        },
        {
          name: 'application',
          attributes: [
            { ns: ANDROID_NS, name: 'label', value: { kind: 'string', value: 'Demo' } },
            { ns: ANDROID_NS, name: 'icon', value: { kind: 'string', value: '@mipmap/ic_launcher' } },
            { ns: ANDROID_NS, name: 'debuggable', value: { kind: 'boolean', value: true } },
          ],
          children: [
            {
              name: 'activity',
              attributes: [
                { ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: '.MainActivity' } },
              ],
            },
            {
              name: 'service',
              attributes: [
                { ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: 'com.example.test.MyService' } },
              ],
            },
            {
              name: 'receiver',
              attributes: [
                { ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: 'BootReceiver' } },
              ],
            },
            {
              name: 'provider',
              attributes: [
                { ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: '.MyProvider' } },
              ],
            },
          ],
        },
      ],
    },
  });
}

describe('parseAxml - 低层 AXML 解析', () => {
  it('能解析最简单的 <manifest> 文件并恢复出 element 树', () => {
    const buf = makeFullManifestBuffer();
    const { root, warnings } = parseAxml(buf);
    expect(warnings).toEqual([]);
    expect(root).not.toBeNull();
    expect(root!.name).toBe('manifest');
    expect(root!.children.length).toBe(5);
    expect(root!.children.map((c) => c.name)).toEqual([
      'uses-sdk',
      'uses-permission',
      'uses-permission',
      'uses-permission',
      'application',
    ]);
  });

  it('解析的 attribute 能携带 namespace + name + typed value', () => {
    const buf = makeFullManifestBuffer();
    const { root } = parseAxml(buf);
    const pkg = root!.attributes.find((a) => a.name === 'package');
    expect(pkg).toBeDefined();
    expect(pkg!.namespace).toBeNull();
    expect(pkg!.value).toBe('com.example.test');

    const versionCode = root!.attributes.find((a) => a.name === 'versionCode');
    expect(versionCode).toBeDefined();
    expect(versionCode!.namespace).toBe(ANDROID_NS);
    // versionCode 是 INT_DEC=0x10
    expect(versionCode!.typedValue.dataType).toBe(0x10);
    expect(versionCode!.typedValue.data).toBe(42);
    expect(versionCode!.value).toBe('42');
  });

  it('非法 chunk type 不会让整文件崩溃，而是 warning + 跳过', () => {
    const baseBuf = makeFullManifestBuffer();
    // 在文件尾部追加一个声明 type=0xDEAD 的伪 chunk
    const garbage = Buffer.alloc(16);
    garbage.writeUInt16LE(0xdead, 0);
    garbage.writeUInt16LE(8, 2);
    garbage.writeUInt32LE(16, 4);
    const total = Buffer.concat([baseBuf, garbage]);
    // 同时回填文件头 size 让 parser 走完到 garbage chunk
    total.writeUInt32LE(total.length, 4);
    const { root, warnings } = parseAxml(total);
    expect(root).not.toBeNull();
    expect(warnings.some((w) => w.includes('0xdead'))).toBe(true);
  });

  it('文件头错误（非 RES_XML_TYPE）抛 Error', () => {
    const bad = Buffer.alloc(8);
    bad.writeUInt16LE(0x0001, 0); // string pool 而不是 xml
    bad.writeUInt16LE(8, 2);
    bad.writeUInt32LE(8, 4);
    expect(() => parseAxml(bad)).toThrow(/Not an AXML file/);
  });
});

describe('extractAndroidManifest - manifest 抽取', () => {
  it('完整抽取 package / version / sdk / permissions / components', () => {
    const buf = makeFullManifestBuffer();
    const { root, warnings } = parseAxml(buf);
    expect(warnings).toEqual([]);

    const info = extractAndroidManifest(root);

    expect(info.packageName).toBe('com.example.test');
    expect(info.versionCode).toBe(42);
    expect(info.versionName).toBe('1.2.3');
    expect(info.usesSdk).toEqual({ minSdkVersion: 21, targetSdkVersion: 33 });
    expect(info.applicationLabel).toBe('Demo');
    expect(info.applicationIcon).toBe('@mipmap/ic_launcher');
    expect(info.debuggable).toBe(true);
    expect(info.usesPermissions).toEqual([
      'android.permission.INTERNET',
      'android.permission.CAMERA',
    ]);
    expect(info.components).toEqual({
      activities: ['com.example.test.MainActivity'],
      services: ['com.example.test.MyService'],
      receivers: ['com.example.test.BootReceiver'],
      providers: ['com.example.test.MyProvider'],
    });
    expect(info.warnings).toBeUndefined();
  });

  it('根节点非 <manifest> 时给出 warning，但仍返回空 info', () => {
    const buf = buildAxml({
      root: { name: 'application' },
    });
    const { root } = parseAxml(buf);
    const info = extractAndroidManifest(root);
    expect(info.warnings?.[0]).toMatch(/expected root <manifest>/);
    expect(info.packageName).toBeUndefined();
  });

  it('".XXX" 简写组件名按 packageName 解析为 FQCN', () => {
    const buf = buildAxml({
      namespaces: [{ prefix: 'android', uri: ANDROID_NS }],
      root: {
        name: 'manifest',
        attributes: [{ name: 'package', value: { kind: 'string', value: 'com.acme' } }],
        children: [
          {
            name: 'application',
            children: [
              {
                name: 'activity',
                attributes: [{ ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: '.A' } }],
              },
              {
                name: 'activity',
                attributes: [{ ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: 'Sub' } }],
              },
              {
                name: 'activity',
                attributes: [{ ns: ANDROID_NS, name: 'name', value: { kind: 'string', value: 'com.acme.Full' } }],
              },
            ],
          },
        ],
      },
    });
    const info = extractAndroidManifest(parseAxml(buf).root);
    expect(info.components?.activities).toEqual(['com.acme.A', 'com.acme.Sub', 'com.acme.Full']);
  });

  it('没有 namespace 声明的 manifest 也能拿到 package（package 不在 android ns 下）', () => {
    const buf = buildAxml({
      root: {
        name: 'manifest',
        attributes: [{ name: 'package', value: { kind: 'string', value: 'no.namespace.pkg' } }],
      },
    });
    const info = extractAndroidManifest(parseAxml(buf).root);
    expect(info.packageName).toBe('no.namespace.pkg');
  });
});
