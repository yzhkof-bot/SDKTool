import type { HapReport } from '../shared/schema.js';

import { mountApp } from './app.js';

/**
 * Viewer 入口（浏览器端）。
 *
 * 启动流程：
 *   1. 在 <script id="__DATA__" type="application/json"> 中找数据
 *   2. JSON.parse 后 mount 到 #root
 *
 * 单文件 HTML 形态下，CLI render.ts 会把数据写入到那个 script 节点；
 * 本地 view 服务模式下，server 会先把同样的 JSON 写到该节点再 serve。
 *
 * 任何异常都展示为 .error-block，避免白屏。
 */
function bootstrap(): void {
  const root = document.getElementById('root');
  if (!root) {
    document.body.appendChild(buildError('页面缺少 #root 容器，无法挂载 viewer。'));
    return;
  }

  const dataNode = document.getElementById('__DATA__');
  if (!dataNode || !dataNode.textContent) {
    root.appendChild(buildError('未找到 #__DATA__ 节点或其内容为空。'));
    return;
  }

  let report: HapReport;
  try {
    const text = dataNode.textContent.trim();
    if (text === '__DATA_PLACEHOLDER__' || text === '') {
      root.appendChild(buildError('报告数据未注入：__DATA__ 仍是占位符。请通过 CLI 生成。'));
      return;
    }
    report = JSON.parse(text) as HapReport;
  } catch (err) {
    root.appendChild(buildError(`解析报告 JSON 失败: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  if (!report || typeof report !== 'object' || !report.schemaVersion) {
    root.appendChild(buildError('报告 JSON 不符合 HapReport schema（缺少 schemaVersion）。'));
    return;
  }

  try {
    mountApp(root, report);
  } catch (err) {
    root.appendChild(buildError(`渲染失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
  }
}

function buildError(message: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'error-block';
  el.textContent = message;
  return el;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
