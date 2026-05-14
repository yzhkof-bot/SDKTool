import type { Analyzer } from '../../shared/schema.js';

import { abcAnalyzer } from './abc.js';
import { abcDetailsAnalyzer } from './abcDetails.js';
import { basicInfoAnalyzer } from './basicInfo.js';
import { dependencyAnalyzer } from './dependency.js';
import { filesAnalyzer } from './files.js';
import { il2cppMetadataAnalyzer } from './il2cppMetadata.js';
import { nativeLibAnalyzer } from './nativeLib.js';
import { nativeSymbolsAnalyzer } from './nativeSymbols.js';
import { permissionAnalyzer } from './permission.js';
import { rawfileAnalyzer } from './rawfile.js';
import { resourceAnalyzer } from './resource.js';
import { signatureAnalyzer } from './signature.js';
import { sizeAnalyzer } from './size.js';

/**
 * 内置 analyzer 注册表。
 *
 * CLI 与 pipeline 都从这里取默认列表；外部调用者可以传 analyzers 参数完全替代。
 * 顺序仅影响 only 列表 / 报告字段呈现顺序，不影响 pipeline 并发语义。
 *
 * `enabledByDefault: false` 的项是"可选深度分析"，需要用 `--extras` (CLI) 或 workbench 多选启用。
 */
export const builtinAnalyzers: Analyzer[] = [
  basicInfoAnalyzer,
  sizeAnalyzer,
  filesAnalyzer,
  permissionAnalyzer,
  resourceAnalyzer,
  rawfileAnalyzer,
  nativeLibAnalyzer,
  abcAnalyzer,
  signatureAnalyzer,
  dependencyAnalyzer,
  // ↓ 可选深度分析（默认关闭）
  nativeSymbolsAnalyzer,
  abcDetailsAnalyzer,
  il2cppMetadataAnalyzer,
];

/**
 * 可选深度分析 analyzer 元信息（供 CLI / workbench UI 渲染多选项使用）。
 */
export interface ExtraAnalyzerMeta {
  id: string;
  name: string;
  description: string;
}

export const EXTRA_ANALYZERS: ExtraAnalyzerMeta[] = [
  {
    id: 'nativeSymbols',
    name: 'Native 深度分析 (.so)',
    description:
      '逐 so 解剖 ELF：符号表 / 节区分布 / DT_NEEDED 依赖 / 安全编译选项 (NX/RELRO/PIE/Canary/FORTIFY) / 符号版本需求 (GLIBC 等) / build-id + 编译器 / .rodata 字符串池',
  },
  {
    id: 'abcDetails',
    name: 'ABC 内部细节 (.abc)',
    description: '解析每个 .abc 的 PANDA 头（magic / version / file_size / num_classes）+ SHA-256，便于发现 size 不变但内容已变的 abc',
  },
  {
    id: 'il2cppMetadata',
    name: 'IL2CPP 元数据 (Unity 游戏)',
    description:
      '解析 global-metadata.dat：Unity 版本指纹 / Assembly 列表 / 类名+方法名+字段名全集 / C# 字符串字面量池。仅对 Unity 游戏 hap 有意义',
  },
];

export {
  abcAnalyzer,
  abcDetailsAnalyzer,
  basicInfoAnalyzer,
  dependencyAnalyzer,
  filesAnalyzer,
  il2cppMetadataAnalyzer,
  nativeLibAnalyzer,
  nativeSymbolsAnalyzer,
  permissionAnalyzer,
  rawfileAnalyzer,
  resourceAnalyzer,
  signatureAnalyzer,
  sizeAnalyzer,
};
