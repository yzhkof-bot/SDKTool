/**
 * HarmonyOS 平台专属 analyzer 集合。
 *
 * 这里的 analyzer 只对 .hap 包有意义：basic 读 module.json5、permission 解析 ohos.permission.*、
 * abc/abcDetails 是 ArkTS PANDA bytecode、rawfile/dependency/signature 都基于 HAP 包结构。
 */

import type { Analyzer } from '@kingsdk/shared/schema.js';

import { abcAnalyzer } from './abc.js';
import { abcDetailsAnalyzer } from './abcDetails.js';
import { basicInfoAnalyzer } from './basicInfo.js';
import { dependencyAnalyzer } from './dependency.js';
import { permissionAnalyzer } from './permission.js';
import { rawfileAnalyzer } from './rawfile.js';
import { resourceAnalyzer } from './resource.js';
import { signatureAnalyzer } from './signature.js';

import type { ExtraAnalyzerMeta } from '../meta.js';

/** HarmonyOS 默认启用 analyzer（按报告字段呈现顺序） */
export const harmonyDefaultAnalyzers: Analyzer[] = [
  basicInfoAnalyzer,
  permissionAnalyzer,
  resourceAnalyzer,
  rawfileAnalyzer,
  abcAnalyzer,
  signatureAnalyzer,
  dependencyAnalyzer,
];

/** HarmonyOS 可选深度 analyzer（默认关闭，UI/CLI 多选启用） */
export const harmonyExtraAnalyzers: Analyzer[] = [
  abcDetailsAnalyzer,
];

/** HarmonyOS 可选深度 analyzer 的元信息（供 UI 渲染多选项） */
export const harmonyExtraAnalyzerMeta: ExtraAnalyzerMeta[] = [
  {
    id: 'abcDetails',
    name: 'ABC 内部细节 (.abc)',
    description:
      '解析每个 .abc 的 PANDA 头（magic / version / file_size / num_classes）+ SHA-256，便于发现 size 不变但内容已变的 abc',
  },
];

export {
  abcAnalyzer,
  abcDetailsAnalyzer,
  basicInfoAnalyzer,
  dependencyAnalyzer,
  permissionAnalyzer,
  rawfileAnalyzer,
  resourceAnalyzer,
  signatureAnalyzer,
};
