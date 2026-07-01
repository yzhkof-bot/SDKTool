import { cac } from 'cac';

import { runAnalyzeCommand } from './commands/analyze.js';
import { runCompareCommand } from './commands/compare.js';
import { runViewCommand } from './commands/view.js';
import { runWorkbenchCommand } from './commands/workbench.js';
import {
  EXIT_OK,
  EXIT_RUNTIME_ERROR,
  EXIT_USAGE_ERROR,
  UsageError,
  buildErrorPayload,
} from './errors.js';
import { readToolVersion } from './version.js';

/**
 * CLI 主入口。
 *
 * 设计要点：
 *  - stdout 仅承载 "正经数据"（JSON 报告 / 简短确认信息），便于 AI/CI 管道
 *  - stderr 承载错误，错误以结构化 JSON 写出
 *  - 退出码语义清晰：见 errors.ts
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  const toolVersion = readToolVersion();
  const cli = cac('kingsdk');

  cli.help();
  cli.version(toolVersion);

  cli
    .command('analyze <hap>', '分析单个 .hap 文件，输出标准化 JSON 报告')
    .option('-o, --output <file>', '把 JSON 报告写到文件而不是 stdout')
    .option('--pretty', '美化 JSON 输出（缩进 2 空格）')
    .option('--only <ids>', '仅运行指定 analyzer，逗号分隔，例如 basic,size')
    .option(
      '--extras <ids>',
      '在默认 analyzer 集合外，额外开启可选深度分析（逗号分隔），可选值: nativeSymbols, abcDetails',
    )
    .option('--top-files <n>', 'Size analyzer 的 Top N 文件数量', { default: 20 })
    .option('--html <file>', '同时产出可双击打开的单文件 HTML 报告')
    .action(async (hap: string, options: Record<string, unknown>) => {
      await runAnalyzeCommand(
        hap,
        {
          output: typeof options.output === 'string' ? options.output : undefined,
          pretty: options.pretty === true,
          only: typeof options.only === 'string' ? options.only : undefined,
          extras: typeof options.extras === 'string' ? options.extras : undefined,
          topFiles: typeof options.topFiles === 'number' ? options.topFiles : undefined,
          html: typeof options.html === 'string' ? options.html : undefined,
        },
        {
          toolVersion,
          writeStdout: (text) => process.stdout.write(text),
        },
      );
    });

  cli
    .command('compare <a> <b>', '对比两份 hap 或两份 report.json，输出 PackageDiffReport')
    .option('-o, --output <file>', '把 diff JSON 写到文件而不是 stdout')
    .option('--pretty', '美化 JSON 输出（缩进 2 空格）')
    .option('--only <ids>', '仅运行指定 analyzer（仅当输入是 .hap 时生效）')
    .option(
      '--extras <ids>',
      '额外开启可选深度分析（仅当输入是 .hap 时生效），可选值: nativeSymbols, abcDetails',
    )
    .option('--top-files <n>', 'Size analyzer 的 Top N 文件数量', { default: 20 })
    .option('--html <file>', '同时产出可双击打开的 HTML diff 报告')
    .action(async (a: string, b: string, options: Record<string, unknown>) => {
      await runCompareCommand(
        a,
        b,
        {
          output: typeof options.output === 'string' ? options.output : undefined,
          pretty: options.pretty === true,
          only: typeof options.only === 'string' ? options.only : undefined,
          extras: typeof options.extras === 'string' ? options.extras : undefined,
          topFiles: typeof options.topFiles === 'number' ? options.topFiles : undefined,
          html: typeof options.html === 'string' ? options.html : undefined,
        },
        {
          toolVersion,
          writeStdout: (text) => process.stdout.write(text),
          writeStderr: (text) => process.stderr.write(text),
        },
      );
    });

  cli
    .command('view <report>', '启动本地 HTTP 服务浏览 PackageReport JSON')
    .option('--port <port>', '监听端口', { default: 7788 })
    .option('--host <host>', '监听地址', { default: '127.0.0.1' })
    .option('--no-open', '不自动打开浏览器')
    .action(async (report: string, options: Record<string, unknown>) => {
      await runViewCommand(
        report,
        {
          port: typeof options.port === 'number' ? options.port : undefined,
          host: typeof options.host === 'string' ? options.host : undefined,
          open: options.open !== false,
        },
        { writeStdout: (text) => process.stdout.write(text) },
      );
    });

  cli
    .command('workbench', '启动本地图形工作台：在浏览器里选 hap → 分析 / 对比（零拷贝）')
    .option('--port <port>', '监听端口', { default: 7790 })
    .option('--host <host>', '监听地址', { default: '127.0.0.1' })
    .option('--no-open', '不自动打开浏览器')
    .action(async (options: Record<string, unknown>) => {
      await runWorkbenchCommand(
        {
          port: typeof options.port === 'number' ? options.port : undefined,
          host: typeof options.host === 'string' ? options.host : undefined,
          open: options.open !== false,
        },
        {
          toolVersion,
          writeStdout: (text) => process.stdout.write(text),
        },
      );
    });

  try {
    cli.parse(argv, { run: false });
    await cli.runMatchedCommand();
    return EXIT_OK;
  } catch (err) {
    const isUsage = err instanceof UsageError;
    const payload = buildErrorPayload(err, isUsage ? 'USAGE_ERROR' : 'RUNTIME_ERROR');
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return isUsage ? EXIT_USAGE_ERROR : EXIT_RUNTIME_ERROR;
  }
}

// 入口立即执行：CLI 文件只会被 bin shebang 或 npm run cli 触发，不会被 import。
main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err) => {
    process.stderr.write(`${String(err?.stack ?? err)}\n`);
    process.exit(1);
  },
);
