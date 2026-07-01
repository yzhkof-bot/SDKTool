/**
 * 跨平台 analyzer 集合。
 *
 * 这里的 analyzer 不依赖任何平台特有的清单文件 / 字节码格式，只读 zip entry 元数据或
 * 通用二进制（ELF / IL2CPP global-metadata.dat），HarmonyOS / Android（包括其它任何 zip
 * 容器型应用包）都可以直接挂上。
 *
 * size / nativeLib / nativeSymbols 的"路径前缀分类规则"已经按 platform 化：
 *   - size: shared/constants.ts 中 SIZE_CATEGORY_RULES_BY_PLATFORM
 *   - nativeLib / nativeSymbols: common/nativeLib.ts 中 NATIVE_LIB_PATH_PREFIX
 * 新增平台时只需要在这两张表里加一行。
 */

import type { Analyzer } from '@kingsdk/shared/schema.js';

import { filesAnalyzer } from './files.js';
import { il2cppMetadataAnalyzer } from './il2cppMetadata.js';
import { nativeLibAnalyzer } from './nativeLib.js';
import { nativeSymbolsAnalyzer } from './nativeSymbols.js';
import { sizeAnalyzer } from './size.js';

import type { ExtraAnalyzerMeta } from '../meta.js';

/** 所有平台都默认启用的 analyzer */
export const commonDefaultAnalyzers: Analyzer[] = [
  sizeAnalyzer,
  filesAnalyzer,
  nativeLibAnalyzer,
];

/** 所有平台都可选的深度 analyzer（默认关闭） */
export const commonExtraAnalyzers: Analyzer[] = [
  nativeSymbolsAnalyzer,
  il2cppMetadataAnalyzer,
];

/** 跨平台可选深度 analyzer 元信息 */
export const commonExtraAnalyzerMeta: ExtraAnalyzerMeta[] = [
  {
    id: 'nativeSymbols',
    name: 'Native 深度分析 (.so)',
    description:
      '逐 so 解剖 ELF：符号表 / 节区分布 / DT_NEEDED 依赖 / 安全编译选项 (NX/RELRO/PIE/Canary/FORTIFY) / 符号版本需求 (GLIBC 等) / build-id + 编译器 / .rodata 字符串池',
  },
  {
    id: 'il2cppMetadata',
    name: 'IL2CPP 元数据 (Unity 游戏)',
    description:
      '解析 global-metadata.dat：Unity 版本指纹 / Assembly 列表 / 类名+方法名+字段名全集 / C# 字符串字面量池。仅对 Unity 游戏包有意义',
  },
];

export {
  filesAnalyzer,
  il2cppMetadataAnalyzer,
  nativeLibAnalyzer,
  nativeSymbolsAnalyzer,
  sizeAnalyzer,
};
