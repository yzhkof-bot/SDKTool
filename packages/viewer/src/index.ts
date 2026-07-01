/**
 * @kingsdk/viewer 包入口。
 *
 * 对外主要能力是单文件 HTML 注入器（render.ts）；浏览器端渲染代码（app/sections/…）
 * 由 tsup 打成 IIFE bundle 后内联进模板，不走这个 barrel。
 */
export {
  renderReportHtml,
  renderDiffHtml,
  loadDefaultTemplate,
  serializeForHtml,
  DATA_PLACEHOLDER,
  type TemplateKind,
  type RenderHtmlOptions,
} from './render.js';
