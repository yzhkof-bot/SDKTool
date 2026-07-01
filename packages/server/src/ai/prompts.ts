import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 构造 AI 会话的系统 prompt。
 *
 * 这一段会作为 `systemPrompt: { append }` 接到 CodeBuddy 默认系统提示后面，
 * 不会覆盖 SDK 自带的工具用法指引（Read / Grep / Glob / Bash / Edit / Write 等），
 * 只是补充：你现在的工作场景、可用文件、首选维度。
 *
 * job 产物目录约定（与 runner.ts 写入位置对齐）：
 *  - analyze 任务：`report.json`、`report.html`
 *  - compare 任务：`diff.json`、`diff.html`、`left.report.json`、`right.report.json`
 *    （single-side html 也会有，但 AI 用不上）
 */
export interface BuildSystemPromptArgs {
  jobDir: string;
  jobKind: 'analyze' | 'compare';
  jobLabel: string;
  jobInputs: string[];
  platform?: string;
}

export function buildSystemPrompt(args: BuildSystemPromptArgs): string {
  const files = listAvailableFiles(args.jobDir, args.jobKind);

  return [
    `# KingSDK Hap 分析助手`,
    ``,
    `你是一名 HarmonyOS Hap / Android APK 包体与安全审计专家，正在帮用户分析 KingSDK 生成的分析或对比报告。`,
    `所有可用数据都在你的当前工作目录里（你已经 cd 到这里）。**优先用 Read / Grep / Glob 工具查看 JSON 文件**，需要写脚本聚合时再用 Bash。`,
    ``,
    `## 任务上下文`,
    `- 任务类型：\`${args.jobKind}\``,
    `- 任务标签：\`${args.jobLabel}\``,
    `- 平台：\`${args.platform ?? 'harmony'}\``,
    `- 原始输入：`,
    ...args.jobInputs.map((p) => `  - \`${p}\``),
    ``,
    `## 可用文件（当前目录）`,
    ...files.map((f) => `- \`${f.name}\`${f.note ? ` — ${f.note}` : ''}`),
    ``,
    `## 输出风格`,
    `- 中文回答，简洁但抓重点；可用 Markdown 表格 / 列表 / 代码块。`,
    `- 数值带单位（B/KiB/MiB）和符号（+/−）；体积变化用 \`+1.2 MiB (+3.4%)\` 这种格式。`,
    `- 涉及路径、so 名、符号名时优先用 \`\` 包裹保持可读。`,
    `- 若用户的问题需要深挖某个维度，先用 Read/Grep 读对应 JSON 节点，再给结论；不要凭空编数据。`,
    ``,
    `## 报告 JSON 结构速查`,
    args.jobKind === 'compare'
      ? COMPARE_SCHEMA_HINT
      : ANALYZE_SCHEMA_HINT,
  ].join('\n');
}

interface FileEntry {
  name: string;
  note?: string;
}

function listAvailableFiles(jobDir: string, kind: 'analyze' | 'compare'): FileEntry[] {
  const candidates: FileEntry[] = kind === 'compare'
    ? [
        { name: 'diff.json', note: 'PackageDiffReport：跨包对比结果（首选读这个）' },
        { name: 'left.report.json', note: 'PackageReport：旧版（左侧）单包分析' },
        { name: 'right.report.json', note: 'PackageReport：新版（右侧）单包分析' },
      ]
    : [{ name: 'report.json', note: 'PackageReport：单包完整分析结果' }];
  return candidates.filter((f) => existsSync(join(jobDir, f.name)));
}

const ANALYZE_SCHEMA_HINT = [
  '`report.json` 顶层字段：',
  '- `meta`：包路径、平台、工具版本、生成时间',
  '- `basic`：bundleName / versionName / 模块信息',
  '- `size`：体积总览 + 分类 breakdown',
  '- `files`：所有文件清单（path / bytes / category / crc）',
  '- `permissions`：权限清单（含敏感标记）',
  '- `resources` / `rawfile`：资源 & rawfile 统计',
  '- `nativeLibs` / `nativeLibSymbols`：原生库 + 符号表（含 ELF section / mitigations / needed / rodata strings）',
  '- `abc` / `abcDetails`：ArkTS abc 字节码（含字符串池 classDescriptors/identifiers）',
  '- `il2cppMetadata`：Unity IL2CPP metadata',
  '- `dex` / `dexDetails`：Android dex（方法/字符串）',
  '- `signature`：证书',
  '- `dependencies`：HSP/HAR 依赖',
].join('\n');

const COMPARE_SCHEMA_HINT = [
  '`diff.json` 顶层字段（**首选阅读对象**）：',
  '- `summary`：versionLine / identical / totalSizeDelta / fileCounts',
  '- `size`：体积变化（total / compressed / breakdown[]，每项带 fromBytes/toBytes/delta/ratio）',
  '- `files`：`{added,removed,changed,totals}`，按 |delta| 排序',
  '- `permissions`：`{added,removed}`（带 sensitive 标记）',
  '- `nativeLibs`：`{added,removed,changed}`',
  '- `nativeLibSymbols.perLib[]`：每个 so 的符号 added/removed/changed + sectionsDiff + mitigationsDiff + rodataDiff + buildInfoDiff',
  '- `abc.modulesAbc`：主 abc 体积变化；`abcDetails.entries[]`：每个 abc 的 strings diff',
  '- `il2cppMetadata.entries[]`：每个 metadata 文件的 names/literals diff',
  '- `dex` / `dexDetails`：Android dex 方法/字符串级 diff',
  '- `signature`：证书变化（presentChanged + fields[]）',
  '- `dependencies`：HSP/HAR 依赖增删',
  '- `warnings`：分析过程中的警告',
  '',
  '提示：diff.json 在 nativeLibSymbols / abcDetails / il2cppMetadata 维度可能很大，建议用 `Grep` 或 `Read` 的行范围读片段，不要一次性全读。',
].join('\n');

/**
 * 默认第一条 prompt：用户点 AI 按钮时输入框里的占位。
 * 用户可以改可以清空再重写。
 */
export const DEFAULT_FIRST_PROMPT = '帮我总结分析这个 diff 的内容';
