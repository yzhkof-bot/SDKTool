/**
 * 可选深度 analyzer 的元信息类型。
 *
 * 单独放在此文件避免 harmony/ 与 common/ 子目录之间产生循环 import（
 * 三个子目录都要 import 这个类型，但子目录之间不应互相 import）。
 */

export interface ExtraAnalyzerMeta {
  id: string;
  name: string;
  description: string;
}
