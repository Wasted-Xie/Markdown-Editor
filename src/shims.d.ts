//! 模块类型补充声明。
//! 部分第三方包未随包发布类型定义，这里做最小声明以免 `tsc --noEmit` 报错。

declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";

  interface TaskListsOptions {
    /** 是否启用（默认 true） */
    enabled?: boolean;
    /** 是否生成 <label> 包裹（默认 true） */
    label?: boolean;
    /** label 是否放在 input 之后（默认 false） */
    labelAfter?: boolean;
  }

  const plugin: MarkdownIt.PluginWithOptions<TaskListsOptions>;
  export default plugin;
}
