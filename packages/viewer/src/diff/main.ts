import type { PackageDiffReport } from '@kingsdk/shared/schema.js';

import { mountDiffApp } from './app.js';

function bootstrap(): void {
  const root = document.getElementById('root');
  if (!root) {
    document.body.appendChild(buildError('页面缺少 #root 容器，无法挂载 diff viewer。'));
    return;
  }

  const dataNode = document.getElementById('__DATA__');
  if (!dataNode || !dataNode.textContent) {
    root.appendChild(buildError('未找到 #__DATA__ 节点或其内容为空。'));
    return;
  }

  let diff: PackageDiffReport;
  try {
    const text = dataNode.textContent.trim();
    if (text === '__DATA_PLACEHOLDER__' || text === '') {
      root.appendChild(
        buildError('对比数据未注入：__DATA__ 仍是占位符。请通过 CLI 生成。'),
      );
      return;
    }
    diff = JSON.parse(text) as PackageDiffReport;
  } catch (err) {
    root.appendChild(
      buildError(`解析 diff JSON 失败: ${err instanceof Error ? err.message : String(err)}`),
    );
    return;
  }

  if (!diff || typeof diff !== 'object' || !diff.schemaVersion) {
    root.appendChild(buildError('对比 JSON 不符合 PackageDiffReport schema（缺少 schemaVersion）。'));
    return;
  }

  try {
    mountDiffApp(root, diff);
  } catch (err) {
    root.appendChild(
      buildError(`渲染失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}`),
    );
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
