//! Tauri 命令的 TypeScript 类型镜像。
//! 与 `src-tauri/src/commands.rs` 中的结构体保持一一对应。

/** 目录树节点 */
export interface DirNode {
  name: string;
  /** 已统一为 `/` 分隔符的绝对路径 */
  path: string;
  kind: "dir" | "file";
  children: DirNode[];
}

/** 路径元信息 */
export interface PathInfo {
  exists: boolean;
  modifiedMs: number | null;
  size: number | null;
  isFile: boolean;
}
