import type {
  Analyzer,
  AnalyzerContext,
  PackageBasicInfo,
  PackageReport,
} from '@kingsdk/shared/schema.js';

import { parseAxml } from './axml.js';
import { extractAndroidManifest } from './manifestExtract.js';

/**
 * Android：AndroidManifest.xml 解析。
 *
 * 这个 analyzer 同时负责两件事：
 *   1) 在 report.androidManifest 写入完整 AndroidManifestInfo（packageName /
 *      versionCode/Name / sdk / 四大组件等），给 Android 专属的 manifest section 渲染。
 *   2) 派生 report.basic：让 Android 也有跨平台 basic 信息，viewer 的 overview /
 *      basic section 无需特判。bundleName=packageName，versionCode/versionName 直转，
 *      targetAPIVersion/minAPIVersion 来自 usesSdk。
 *
 * report.permissions 由独立的 androidPermissionAnalyzer 负责（也读 AndroidManifest.xml）；
 * 二者职责拆分但都默认开启，跑两次 axml 解析（共约 20ms）换取插件解耦。
 *
 * 失败处理：AndroidManifest.xml 缺失、AXML 头部损坏等致命错误以 warning（level=error）
 * 形式记录，但 analyzer 本身不抛异常，让 pipeline 内其它 analyzer 继续跑。
 */
export const androidManifestAnalyzer: Analyzer = {
  id: 'androidManifest',
  name: 'Android Manifest',
  enabledByDefault: true,
  async run(ctx: AnalyzerContext): Promise<Partial<PackageReport>> {
    const entry = ctx.hap.entries.find(
      (e) => !e.isDirectory && e.path === 'AndroidManifest.xml',
    );
    if (!entry) {
      ctx.addWarning({
        code: 'ANDROID_MANIFEST_MISSING',
        level: 'error',
        message: 'APK 内未找到 AndroidManifest.xml',
      });
      return {};
    }

    let buf: Buffer;
    try {
      buf = await ctx.hap.readFile('AndroidManifest.xml');
    } catch (err) {
      ctx.addWarning({
        code: 'ANDROID_MANIFEST_READ_FAILED',
        level: 'error',
        message: `读取 AndroidManifest.xml 失败: ${(err as Error).message}`,
      });
      return {};
    }

    let manifestInfo: ReturnType<typeof extractAndroidManifest>;
    try {
      const { root, warnings: parseWarnings } = parseAxml(buf);
      manifestInfo = extractAndroidManifest(root);
      for (const w of parseWarnings) {
        ctx.addWarning({
          code: 'ANDROID_MANIFEST_AXML_WARN',
          level: 'warn',
          message: w,
        });
      }
    } catch (err) {
      ctx.addWarning({
        code: 'ANDROID_MANIFEST_AXML_FAILED',
        level: 'error',
        message: `AXML 解析失败: ${(err as Error).message}`,
      });
      return {};
    }

    const out: Partial<PackageReport> = { androidManifest: manifestInfo };

    // 派生 basic：跨平台 viewer 的 basic section 不需要特判 Android
    const basic = deriveBasic(manifestInfo);
    if (basic) out.basic = basic;

    return out;
  },
};

/**
 * 把 AndroidManifestInfo 投影成跨平台 PackageBasicInfo。
 *
 * 字段映射（manifest 字段 → basic 字段）：
 *   packageName             → bundleName            （HarmonyOS 的 bundleName 即 packageName 等价物）
 *   versionCode             → versionCode
 *   versionName             → versionName
 *   usesSdk.targetSdkVersion → targetAPIVersion     （HarmonyOS 与 Android 的"目标 API 版本"概念对齐）
 *   usesSdk.minSdkVersion   → minAPIVersion
 *
 * HarmonyOS 专属字段（moduleName / moduleType / deviceTypes / abilities）填空值占位，
 * viewer basic section 的渲染逻辑会按字段是否非空决定是否展示。
 */
function deriveBasic(
  info: ReturnType<typeof extractAndroidManifest>,
): PackageBasicInfo | undefined {
  if (!info.packageName && info.versionName === undefined && info.versionCode === undefined) {
    return undefined;
  }
  const basic: PackageBasicInfo = {
    bundleName: info.packageName ?? '',
    versionCode: info.versionCode ?? 0,
    versionName: info.versionName ?? '',
    moduleName: '',
    moduleType: '',
    deviceTypes: [],
    abilities: [],
  };
  if (info.usesSdk?.targetSdkVersion !== undefined) {
    basic.targetAPIVersion = info.usesSdk.targetSdkVersion;
  }
  if (info.usesSdk?.minSdkVersion !== undefined) {
    basic.minAPIVersion = info.usesSdk.minSdkVersion;
  }
  return basic;
}
