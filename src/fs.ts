//! 渲染进程 -> Tauri 命令的薄封装。
//! 所有文件读写都经过 Rust 侧，写操作会被限制在当前打开的文件夹内。

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, ask, message } from "@tauri-apps/plugin-dialog";
import type { DirNode, PathInfo } from "./types";

export type { DirNode, PathInfo };

/**
 * 确认对话框。
 *
 * 刻意不用 `window.confirm`：在 WebView2 里它于窗口关闭请求处理期间不可靠
 * ——可能既不弹出又返回真值。Tauri 的 `ask` 走 Rust 侧原生对话框，行为确定。
 *
 * @returns `true` 表示用户选择了「确定」
 */
export async function askConfirm(
  text: string,
  opts: { title?: string; okLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  try {
    return await ask(text, {
      title: opts.title ?? "Markdown 编辑器",
      kind: "warning",
      okLabel: opts.okLabel,
      cancelLabel: opts.cancelLabel,
    });
  } catch {
    // 原生对话框不可用（例如权限未开放）时降级，保证流程不卡死。
    // 返回 false 是更安全的一侧：宁可拦下关闭，也不静默丢内容。
    const suffix = opts.okLabel
      ? `\n\n确定 = ${opts.okLabel} ／ 取消 = ${opts.cancelLabel ?? "取消"}`
      : "";
    try {
      return window.confirm(text + suffix);
    } catch {
      return false;
    }
  }
}

/** 信息提示对话框（同样走原生实现，替代 window.alert） */
export async function notify(text: string, title = "Markdown 编辑器"): Promise<void> {
  try {
    await message(text, { title, kind: "info" });
  } catch {
    try {
      window.alert(text);
    } catch {
      /* 提示失败不影响主流程 */
    }
  }
}

/** 列举目录的一层子节点 */
export function listDir(dir: string): Promise<DirNode[]> {
  return invoke<DirNode[]>("list_dir", { dir });
}

/** 目录的轻量版本信息（只 stat，不列内容） */
export interface DirInfo {
  path: string;
  exists: boolean;
  modifiedMs: number | null;
  size: number | null;
}

/** 一次性查询多个目录的版本信息，用于高频轮询的「是否有变化」判断 */
export function listDirsInfo(dirs: string[]): Promise<DirInfo[]> {
  return invoke<DirInfo[]>("list_dirs_info", { dirs });
}

/**
 * 告诉后端当前工作区根目录。
 * 必须在打开文件夹 / 打开单个文件 / 拖入文件时调用，否则写入会被拒绝。
 */
export function setWorkspaceRoot(root: string): Promise<void> {
  return invoke<void>("set_workspace_root", { root });
}

/** 弹出文件选择对话框，取消时返回 null */
export async function pickFile(): Promise<string | null> {
  const picked = await invoke<string | null>("pick_file");
  return picked ? normalizePath(picked) : null;
}

/** 读取文本文件（容错解码） */
export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

/** 写入文本文件（限制在工作区内） */
export function writeFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_file", { path, contents });
}

/** 路径是否存在 */
export function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

/** 路径元信息（修改时间 / 大小） */
export function pathInfo(path: string): Promise<PathInfo> {
  return invoke<PathInfo>("path_info", { path });
}

/** 弹出文件夹选择对话框，取消时返回 null */
export async function pickFolder(): Promise<string | null> {
  const picked = await openDialog({
    directory: true,
    multiple: false,
    title: "选择 Markdown 文件夹",
  });
  if (typeof picked === "string") return normalizePath(picked);
  return null;
}

/** 弹出「另存为」对话框并写出 HTML，取消时返回 null */
export function exportHtml(
  html: string,
  defaultName: string,
): Promise<string | null> {
  return invoke<string | null>("export_html", { html, defaultName });
}

/** 在系统文件管理器中定位文件 */
export function openInExplorer(path: string): Promise<void> {
  return invoke<void>("open_in_explorer", { path });
}

/** 真正关闭主窗口（用于「关闭前询问保存」流程的最后一步） */
export function closeWindow(): Promise<void> {
  return invoke<void>("close_window");
}

// ---------------------------------------------------------------------------
// 文件管理操作
// ---------------------------------------------------------------------------

/** 新建文件或文件夹，返回新路径 */
export function createEntry(
  dir: string,
  name: string,
  kind: "file" | "dir",
): Promise<string> {
  return invoke<string>("create_entry", { dir, name, kind });
}

/** 重命名，返回新路径 */
export function renameEntry(path: string, newName: string): Promise<string> {
  return invoke<string>("rename_entry", { path, newName });
}

/** 删除文件（或文件夹，需 recursive 为 true） */
export function deleteEntry(path: string, recursive = false): Promise<void> {
  return invoke<void>("delete_entry", { path, recursive });
}

/** 把文件列表写入系统剪贴板 */
export function clipboardSetFiles(paths: string[], cut: boolean): Promise<void> {
  return invoke<void>("clipboard_set_files", { paths, cut });
}

/** 剪贴板里是否有文件 */
export function clipboardHasFiles(): Promise<boolean> {
  return invoke<boolean>("clipboard_has_files");
}

/** 粘贴到目标目录，返回新建的路径列表 */
export function pasteEntries(destDir: string, cut: boolean): Promise<string[]> {
  return invoke<string[]>("paste_entries", { destDir, cut });
}

// ---------------------------------------------------------------------------
// 纯工具函数
// ---------------------------------------------------------------------------

/** 统一路径分隔符为 `/` */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 取路径最后一段 */
export function baseName(path: string): string {
  const norm = normalizePath(path);
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** 取不带扩展名的文件名，用于导出时的默认名 */
export function fileStem(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 生成安全的文件名 */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "document";
}

/** 时间戳 -> 本地时间字符串 */
export function formatTime(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
