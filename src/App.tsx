import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Editor, type EditorHandle } from "./components/Editor";
import { Preview, type PreviewHandle } from "./components/Preview";
import { FileTree, type ContextTarget } from "./components/FileTree";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { OutlinePanel, findActiveHeading } from "./components/OutlinePanel";
import { countWords, extractOutline } from "./outline";
import {
  buildExportHtml,
  renderMarkdown,
  type DiagramTheme,
} from "./renderer";
import {
  askConfirm,
  baseName,
  clipboardHasFiles,
  clipboardSetFiles,
  closeWindow,
  createEntry,
  deleteEntry,
  exportHtml,
  fileStem,
  formatTime,
  listDir,
  normalizePath,
  notify,
  openInExplorer,
  pasteEntries,
  pathExists,
  pathInfo,
  pickFile,
  pickFolder,
  readFile,
  renameEntry,
  safeFileName,
  setWorkspaceRoot,
  writeFile,
} from "./fs";

type Theme = "light" | "dark";

interface Status {
  kind: "info" | "ok" | "warn" | "error";
  text: string;
}

const EXTERNAL_POLL = 3000;
const DEFAULT_FOLDER = "C:/Projects/Markdown编辑器/sample";
const FONT_MIN = 12;
const FONT_MAX = 24;
const LS_THEME = "mde.theme";
const LS_SCROLL_SYNC = "mde.scrollSync";
const LS_PREVIEW = "mde.showPreview";
const LS_SIDEBAR = "mde.sidebar";
const LS_FONT = "mde.fontSize";

/**
 * 模块级状态镜像。
 * 供「窗口关闭请求」等 React 之外的回调读取当前文档状态，
 * 由 App 在每次渲染后同步。
 */
const appRefs: {
  path: string | null;
  content: string;
  saved: string;
  folder: string | null;
} = { path: null, content: "", saved: "", folder: null };

/** 当前文档是否有未保存的改动 */
function hasUnsavedChanges(): boolean {
  return appRefs.path !== null && appRefs.content !== appRefs.saved;
}

/** 当前文档名，用于询问弹窗 */
function currentName(): string {
  const path = appRefs.path;
  if (!path) return "未命名";
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** 右键菜单操作的目标目录：选中文件夹/文件时用其所在目录，空白处用工作区根目录 */
function menuDir(
  menu: ContextTarget | null,
  root: string | null,
): string {
  const node = menu?.node ?? null;
  if (node && node.kind === "dir") return node.path;
  if (node) {
    const idx = node.path.lastIndexOf("/");
    if (idx > 0) return node.path.slice(0, idx);
  }
  return root ?? "";
}

export default function App() {
  // ---- 工作区 ----
  const [folderRoot, setFolderRoot] = useState<string | null>(null);
  const [treeToken, setTreeToken] = useState(0);

  // ---- 当前文档 ----
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");

  // ---- 视图 ----
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(LS_THEME) as Theme | null) ?? "light",
  );
  const [fontSize, setFontSize] = useState<number>(() => {
    const raw = Number(localStorage.getItem(LS_FONT));
    return Number.isFinite(raw) && raw >= FONT_MIN && raw <= FONT_MAX
      ? raw
      : 15;
  });
  const [showPreview, setShowPreview] = useState(
    () => localStorage.getItem(LS_PREVIEW) !== "0",
  );
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem(LS_SIDEBAR) !== "0",
  );
  const [scrollSync, setScrollSync] = useState(
    () => localStorage.getItem(LS_SCROLL_SYNC) !== "0",
  );
  const [cursorLine, setCursorLine] = useState(1);
  const [status, setStatus] = useState<Status>({
    kind: "info",
    text: "未打开文件夹",
  });
  const [busy, setBusy] = useState(false);
  /** 文件树右键菜单；null 表示未打开 */
  const [menu, setMenu] = useState<ContextTarget | null>(null);
  /** 剪贴板里是否有文件，决定「粘贴」是否可用 */
  const [clipboardReady, setClipboardReady] = useState(false);
  /** 上次复制是否为剪切，粘贴时据此决定是否移动原文件 */
  const clipboardCutRef = useRef(false);

  // ---- refs ----
  const editorHandle = useRef<EditorHandle | null>(null);
  const previewHandle = useRef<PreviewHandle | null>(null);
  const lastMeta = useRef<{ modifiedMs: number; size: number } | null>(null);
  const promptOpen = useRef(false);
  const previewScrolling = useRef(false);
  /** 大纲跳转进行中：期间暂停滚动联动，避免两个滚动互相覆盖 */
  const jumpPauseRef = useRef(false);
  /** 正在把磁盘内容填入编辑器（此时磁盘比基线新属正常） */
  const fillingRef = useRef(false);

  // 同步模块级镜像：让窗口关闭回调等 React 之外的代码能读到最新状态
  appRefs.path = currentPath;
  appRefs.content = content;
  appRefs.saved = savedContent;
  appRefs.folder = folderRoot;

  // -------------------------------------------------------------------------
  // 派生数据
  // -------------------------------------------------------------------------

  const rendered = useMemo(() => renderMarkdown(content), [content]);
  const headings = useMemo(() => extractOutline(content), [content]);
  const diagramTheme: DiagramTheme = theme;

  const dirty = content !== savedContent;
  const wordCount = useMemo(() => countWords(content), [content]);
  const lineCount = useMemo(() => content.split(/\r\n|\r|\n/).length, [content]);

  // -------------------------------------------------------------------------
  // 持久化偏好
  // -------------------------------------------------------------------------

  useEffect(() => {
    localStorage.setItem(LS_THEME, theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(LS_FONT, String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    localStorage.setItem(LS_PREVIEW, showPreview ? "1" : "0");
  }, [showPreview]);

  useEffect(() => {
    localStorage.setItem(LS_SIDEBAR, sidebarOpen ? "1" : "0");
  }, [sidebarOpen]);

  useEffect(() => {
    localStorage.setItem(LS_SCROLL_SYNC, scrollSync ? "1" : "0");
  }, [scrollSync]);

  // -------------------------------------------------------------------------
  // 文件操作
  // -------------------------------------------------------------------------

  const refreshTree = useCallback(() => setTreeToken((n) => n + 1), []);

  /** 保存：写盘并记录元信息 */
  const saveCurrent = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<boolean> => {
      const path = appRefs.path;
      if (!path) return false;

      const text = appRefs.content;
      if (text === appRefs.saved && !opts.silent) {
        setStatus({ kind: "info", text: "内容未变化" });
        return true;
      }

      // 写盘前确认文件没有被其它程序改动，避免静默覆盖别人的修改
      const recorded = lastMeta.current;
      if (recorded) {
        const info = await pathInfo(path).catch(() => null);
        const changedExternally =
          info?.exists &&
          (info.modifiedMs !== recorded.modifiedMs ||
            info.size !== recorded.size);

        if (changedExternally) {
          const overwrite = await askConfirm(
            `「${baseName(path)}」已被其它程序修改。\n\n用编辑器里的内容覆盖磁盘文件吗？`,
            { title: "文件冲突", okLabel: "覆盖", cancelLabel: "取消保存" },
          );
          if (!overwrite) {
            setStatus({ kind: "warn", text: "已取消保存（磁盘文件更新）" });
            return false;
          }
        }
      }

      try {
        await writeFile(path, text);
        const info = await pathInfo(path);
        lastMeta.current =
          info.modifiedMs !== null && info.size !== null
            ? { modifiedMs: info.modifiedMs, size: info.size }
            : null;
        setSavedContent(text);
        setStatus({
          kind: "ok",
          text: `已保存 ${baseName(path)} · ${formatTime(Date.now())}`,
        });
        return true;
      } catch (err) {
        setStatus({ kind: "error", text: describeError(err) });
        return false;
      }
    },
    [],
  );

  /**
   * 关闭窗口前的统一处理：有未保存改动则询问。
   * Rust 侧已 prevent_close，只有这里调用 `closeWindow` 才会真正退出。
   */
  const requestCloseWindow = useCallback(async () => {
    if (!hasUnsavedChanges()) {
      await closeWindow().catch(() => undefined);
      return;
    }

    const save = await askConfirm(
      `「${currentName()}」有未保存的修改。`,
      { title: "退出前保存", okLabel: "保存并退出", cancelLabel: "不保存退出" },
    );

    if (save) {
      const ok = await saveCurrent({ silent: true });
      if (!ok) return; // 保存失败时留在窗口里，避免丢内容
    }

    await closeWindow().catch(() => undefined);
  }, [saveCurrent]);

  /**
   * 有未保存改动时询问用户。
   * 返回 `false` 表示用户取消了本次操作（如切换文件）。
   */
  const confirmSaveIfDirty = useCallback(async (): Promise<boolean> => {
    if (!hasUnsavedChanges()) return true;

    const yes = await askConfirm(
      `「${currentName()}」有未保存的修改。`,
      { title: "切换文件前保存", okLabel: "保存", cancelLabel: "放弃修改" },
    );

    if (yes) return saveCurrent({ silent: true });
    return true;
  }, [saveCurrent]);

  /** 打开一个文件（切换前会询问是否保存当前文档） */
  const openFile = useCallback(
    async (path: string, opts: { skipConfirm?: boolean } = {}) => {
      const normalized = normalizePath(path);
      if (normalized === appRefs.path) return;

      // 切换文件前先处理未保存内容，用户取消则中止切换
      if (!opts.skipConfirm) {
        const proceed = await confirmSaveIfDirty();
        if (!proceed) return;
      }

      try {
        fillingRef.current = true;
        const text = await readFile(normalized);
        const info = await pathInfo(normalized);

        setCurrentPath(normalized);
        setContent(text);
        setSavedContent(text);
        setCursorLine(1);
        lastMeta.current =
          info.modifiedMs !== null && info.size !== null
            ? { modifiedMs: info.modifiedMs, size: info.size }
            : null;
        setStatus({
          kind: "ok",
          text: `已打开 ${baseName(normalized)}`,
        });
      } catch (err) {
        setStatus({ kind: "error", text: describeError(err) });
      } finally {
        fillingRef.current = false;
      }
    },
    [confirmSaveIfDirty],
  );

  /** 打开文件夹 */
  const openFolder = useCallback(
    async (root: string, opts: { autoOpenFirst?: boolean } = {}) => {
      const normalized = normalizePath(root);

      // 先通知后端工作区根目录，否则后续写入会被拒绝
      try {
        await setWorkspaceRoot(normalized);
      } catch (err) {
        setStatus({ kind: "error", text: describeError(err) });
        return;
      }

      setFolderRoot(normalized);
      setCurrentPath(null);
      setContent("");
      setSavedContent("");
      lastMeta.current = null;
      refreshTree();
      setStatus({ kind: "info", text: `工作区：${normalized}` });

      if (opts.autoOpenFirst === false) return;

      // 自动展开并打开第一个 Markdown 文件
      try {
        const list = await listDir(normalized);
        const first =
          list.find(
            (n) => n.kind === "file" && /\.(md|markdown)$/i.test(n.name),
          ) ?? list.find((n) => n.kind === "file");
        if (first) await openFile(first.path, { skipConfirm: true });
      } catch {
        /* 空文件夹时忽略 */
      }
    },
    [openFile, refreshTree],
  );

  /** 重命名 */
  const handleRename = useCallback(
    async (path: string) => {
      const old = baseName(path);
      const dot = old.lastIndexOf(".");
      const input = window.prompt("重命名", dot > 0 ? old.slice(0, dot) : old);
      if (input === null) return;

      const name = input.trim();
      if (!name || name === old) return;

      // 只输入了主名时保留原扩展名，避免误改文件类型
      const finalName = dot > 0 && !name.includes(".") ? `${name}${old.slice(dot)}` : name;

      try {
        const next = await renameEntry(path, finalName);
        refreshTree();

        // 正在编辑的就是这个文件时，跟着换到新路径
        if (appRefs.path === path) {
          setCurrentPath(next);
          const info = await pathInfo(next).catch(() => null);
          lastMeta.current =
            info && info.modifiedMs !== null && info.size !== null
              ? { modifiedMs: info.modifiedMs, size: info.size }
              : null;
        }
        setStatus({ kind: "ok", text: `已重命名为 ${finalName}` });
      } catch (err) {
        setStatus({ kind: "error", text: describeError(err) });
      }
    },
    [refreshTree],
  );

  /** 删除文件或文件夹 */
  const handleDelete = useCallback(
    async (path: string, isDir: boolean) => {
      const name = baseName(path);

      // 删除的是当前编辑的文件且还没保存过 -> 先给一次保存机会
      if (!isDir && appRefs.path === path && hasUnsavedChanges()) {
        const keep = await askConfirm(
          `「${name}」有未保存的修改，删除后无法恢复。\n\n仍要删除吗？`,
          { title: "删除确认", okLabel: "仍然删除", cancelLabel: "取消" },
        );
        if (!keep) return;
      } else {
        const ok = await askConfirm(
          isDir
            ? `删除文件夹「${name}」及其全部内容？此操作不可恢复。`
            : `删除文件「${name}」？此操作不可恢复。`,
          {
            title: "删除确认",
            okLabel: "删除",
            cancelLabel: "取消",
          },
        );
        if (!ok) return;
      }

      try {
        await deleteEntry(path, isDir);
        refreshTree();

        // 被删掉的是当前文件：清空编辑器，避免继续对着不存在的路径保存
        if (appRefs.path === path || appRefs.path?.startsWith(`${path}/`)) {
          setCurrentPath(null);
          setContent("");
          setSavedContent("");
          lastMeta.current = null;
        }
        setStatus({ kind: "ok", text: `已删除 ${name}` });
      } catch (err) {
        setStatus({ kind: "error", text: describeError(err) });
      }
    },
    [refreshTree],
  );

  /** 复制 / 剪切到系统剪贴板 */
  const handleClipboard = useCallback(
    async (paths: string[], cut: boolean) => {
      try {
        await clipboardSetFiles(paths, cut);
        const next = await clipboardHasFiles().catch(() => false);
        setClipboardReady(next);
        setStatus({
          kind: "ok",
          text: `已${cut ? "剪切" : "复制"} ${paths.length} 项到剪贴板`,
        });
      } catch (err) {
        setStatus({ kind: "error", text: describeError(err) });
      }
    },
    [],
  );

  /** 粘贴剪贴板里的文件到目标目录 */
  const handlePaste = useCallback(
    async (destDir: string) => {
      setBusy(true);
      try {
        const created = await pasteEntries(destDir, clipboardCutRef.current);
        refreshTree();
        setStatus({ kind: "ok", text: `已粘贴 ${created.length} 项` });
      } catch (err) {
        setStatus({ kind: "error", text: describeError(err) });
      } finally {
        setBusy(false);
      }
    },
    [refreshTree],
  );

  /** 在指定目录新建 Markdown 文件并打开 */
  const createFileIn = useCallback(
    async (dir: string) => {
      let name = "未命名.md";
      let index = 1;
      while (await pathExists(`${dir}/${name}`)) {
        name = `未命名-${index}.md`;
        index += 1;
        if (index > 200) break;
      }

      try {
        const created = await createEntry(dir, name, "file");
        refreshTree();
        setSidebarOpen(true);
        await openFile(created);
        editorHandle.current?.scrollToLine(1);
      } catch (err) {
        setStatus({ kind: "error", text: describeError(err) });
      }
    },
    [openFile, refreshTree],
  );

  /** 在指定目录新建文件夹 */
  const createFolderIn = useCallback(
    async (dir: string) => {
      let name = "新建文件夹";
      let index = 1;
      while (await pathExists(`${dir}/${name}`)) {
        name = `新建文件夹-${index}`;
        index += 1;
        if (index > 200) break;
      }

      try {
        await createEntry(dir, name, "dir");
        refreshTree();
        setStatus({ kind: "ok", text: `已新建文件夹 ${name}` });
      } catch (err) {
        setStatus({ kind: "error", text: describeError(err) });
      }
    },
    [refreshTree],
  );

  /** 打开右键菜单 */
  const handleOpenContextMenu = useCallback((target: ContextTarget) => {
    clipboardHasFiles()
      .then(setClipboardReady)
      .catch(() => setClipboardReady(false));
    setMenu(target);
  }, []);

  /** 菜单动作分发 */
  const handleMenuAction = useCallback(
    (action: string) => {
      const target = menu?.node ?? null;
      setMenu(null);

      if (action === "open" && target && target.kind === "file") {
        void openFile(target.path);
        return;
      }
      if (action === "reveal" && target) {
        void openInExplorer(target.path).catch((err: unknown) =>
          setStatus({ kind: "error", text: describeError(err) }),
        );
        return;
      }
      if (action === "new-file") {
        void createFileIn(menuDir(menu, folderRoot));
        return;
      }
      if (action === "new-folder") {
        void createFolderIn(menuDir(menu, folderRoot));
        return;
      }
      if (action === "rename" && target) {
        void handleRename(target.path);
        return;
      }
      if (action === "delete" && target) {
        void handleDelete(target.path, target.kind === "dir");
        return;
      }
      if (action === "copy" && target) {
        void handleClipboard([target.path], false);
        return;
      }
      if (action === "cut" && target) {
        clipboardCutRef.current = true;
        void handleClipboard([target.path], true);
        return;
      }
      if (action === "paste") {
        void handlePaste(menuDir(menu, folderRoot));
        return;
      }
      if (action === "refresh") {
        refreshTree();
        setStatus({ kind: "info", text: "已刷新文件列表" });
      }
    },
    [
      createFileIn,
      createFolderIn,
      folderRoot,
      handleClipboard,
      handleDelete,
      handlePaste,
      handleRename,
      menu,
      openFile,
    ],
  );

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const node = menu?.node ?? null;
    const sep = (id: string): ContextMenuItem => ({ id, label: "", separator: true });

    return [
      { id: "open", label: "打开", disabled: !node || node.kind !== "file" },
      { id: "reveal", label: "在资源管理器中显示", disabled: !node },
      sep("s0"),
      { id: "new-file", label: "新建 Markdown 文件", disabled: !folderRoot },
      { id: "new-folder", label: "新建文件夹", disabled: !folderRoot },
      { id: "paste", label: "粘贴", disabled: !clipboardReady || !folderRoot },
      sep("s1"),
      { id: "rename", label: "重命名", disabled: !node },
      { id: "delete", label: "删除", danger: true, disabled: !node },
      sep("s2"),
      { id: "copy", label: "复制", disabled: !node },
      { id: "cut", label: "剪切", disabled: !node },
      sep("s3"),
      { id: "refresh", label: "刷新", disabled: !folderRoot },
    ];
  }, [clipboardReady, folderRoot, menu]);

  const handlePickFolder = useCallback(async () => {
    setBusy(true);
    try {
      const picked = await pickFolder();
      if (!picked) return;
      // 主动选文件夹通常是想浏览文件，顺手展开文件面板
      setSidebarOpen(true);
      await openFolder(picked);
    } catch (err) {
      setStatus({ kind: "error", text: describeError(err) });
    } finally {
      setBusy(false);
    }
  }, [openFolder]);

  /** 打开单个文件：以所在目录为工作区，便于继续访问同级文件 */
  const handleOpenFile = useCallback(async () => {
    setBusy(true);
    try {
      const picked = await pickFile();
      if (!picked) return;

      const idx = picked.lastIndexOf("/");
      const dir = idx > 0 ? picked.slice(0, idx) : picked;
      await openFolder(dir, { autoOpenFirst: false });
      await openFile(picked, { skipConfirm: true });
    } catch (err) {
      setStatus({ kind: "error", text: describeError(err) });
    } finally {
      setBusy(false);
    }
  }, [openFile, openFolder]);

  const handleExportHtml = useCallback(async () => {
    if (!content) {
      setStatus({ kind: "warn", text: "当前没有内容可导出" });
      return;
    }
    const title = currentPath ? fileStem(currentPath) : "document";
    setBusy(true);
    setStatus({ kind: "info", text: "正在生成自包含 HTML…" });
    try {
      const html = await buildExportHtml(content, title);
      const saved = await exportHtml(html, `${safeFileName(title)}.html`);
      setStatus(
        saved
          ? { kind: "ok", text: `已导出到 ${saved}` }
          : { kind: "info", text: "已取消导出" },
      );
    } catch (err) {
      setStatus({ kind: "error", text: describeError(err) });
    } finally {
      setBusy(false);
    }
  }, [content, currentPath]);

  const handleExportPdf = useCallback(() => {
    if (!content) {
      setStatus({ kind: "warn", text: "当前没有内容可导出" });
      return;
    }
    setStatus({
      kind: "info",
      text: "在打印对话框中把目标打印机选为「Microsoft Print to PDF」",
    });
    // 交给系统打印对话框，由用户选择「另存为 PDF」
    window.setTimeout(() => window.print(), 120);
  }, [content]);

  // -------------------------------------------------------------------------
  // 窗口关闭：Tauri 在用户点关闭时广播 tauri://close-requested，
  // 这里拦下并由 confirmSaveIfDirty 决定是否保存，最后才真正销毁窗口
  // -------------------------------------------------------------------------

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    getCurrentWindow()
      .onCloseRequested((event) => {
        // 始终先拦下关闭，避免异步询问期间窗口直接消失
        event.preventDefault();
        void requestCloseWindow();
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err: unknown) => {
        setStatus({ kind: "error", text: describeError(err) });
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [requestCloseWindow]);

  // -------------------------------------------------------------------------
  // 外部修改轮询
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!currentPath) return;

    let cancelled = false;

    const timer = window.setInterval(async () => {
      if (promptOpen.current) return;
      const path = appRefs.path;
      if (!path) return;

      // 正在加载文件时磁盘内容本来就比基线新，跳过检测
      if (fillingRef.current) return;

      const info = await pathInfo(path).catch(() => null);
      if (cancelled || !info) return;

      // 文件被删除或重命名
      if (!info.exists) {
        // 清空基线，避免每轮轮询都重复提示
        lastMeta.current = null;
        promptOpen.current = true;
        await notify(
          `文件已不存在：\n${path}\n\n内容仍保留在编辑器中，保存会重新创建该文件。`,
        );
        promptOpen.current = false;
        return;
      }

      const recorded = lastMeta.current;
      if (!recorded) return;
      const changed =
        info.modifiedMs !== recorded.modifiedMs || info.size !== recorded.size;
      if (!changed) return;

      const hasLocalEdits = appRefs.content !== appRefs.saved;
      if (!hasLocalEdits) {
        // 本地无改动，静默重新加载
        try {
          const text = await readFile(path);
          if (cancelled) return;
          setContent(text);
          setSavedContent(text);
          lastMeta.current = {
            modifiedMs: info.modifiedMs ?? 0,
            size: info.size ?? 0,
          };
          setStatus({ kind: "info", text: "检测到外部修改，已重新加载" });
        } catch {
          /* 读取失败时保持现状 */
        }
        return;
      }

      // 本地有改动 -> 询问一次，之后以新基线继续
      promptOpen.current = true;
      const keepLocal = await askConfirm(
        `「${baseName(path)}」已被其它程序修改。\n\n保留编辑器里的内容吗？`,
        {
          title: "检测到外部修改",
          okLabel: "保留编辑器内容",
          cancelLabel: "重新加载磁盘文件",
        },
      );

      // 更新基线，避免每轮轮询重复提示
      lastMeta.current = {
        modifiedMs: info.modifiedMs ?? 0,
        size: info.size ?? 0,
      };

      if (!keepLocal) {
        try {
          const text = await readFile(path);
          if (!cancelled) {
            setContent(text);
            setSavedContent(text);
            setStatus({ kind: "info", text: "已重新加载磁盘上的版本" });
          }
        } catch (err) {
          setStatus({ kind: "error", text: describeError(err) });
        }
      } else {
        setStatus({
          kind: "warn",
          text: "已保留编辑器内容，保存时会询问是否覆盖",
        });
      }
      promptOpen.current = false;
    }, EXTERNAL_POLL);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentPath]);

  // -------------------------------------------------------------------------
  // 拖拽文件 / 文件夹打开
  // -------------------------------------------------------------------------

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        if (paths.length === 0) return;

        const first = normalizePath(paths[0]);
        const info = await pathInfo(first).catch(() => null);
        if (!info?.exists) return;

        if (info.isFile) {
          const dir = first.slice(0, first.lastIndexOf("/")) || first;
          await openFolder(dir, { autoOpenFirst: false });
          await openFile(first, { skipConfirm: true });
        } else {
          await openFolder(first);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openFile, openFolder]);
  // -------------------------------------------------------------------------
  // 滚动联动
  // -------------------------------------------------------------------------

  const handleEditorScroll = useCallback(
    (ratio: number) => {
      if (!scrollSync) return;
      previewHandle.current?.scrollToRatio(ratio);
    },
    [scrollSync],
  );

  const handlePreviewScroll = useCallback(
    (ratio: number) => {
      if (!scrollSync || previewScrolling.current || jumpPauseRef.current) return;
      editorHandle.current?.scrollToRatio(ratio);
    },
    [scrollSync],
  );

  const handleRenderingChange = useCallback((rendering: boolean) => {
    // mermaid 渲染会改变预览高度，期间暂停联动避免位置乱跳
    previewScrolling.current = rendering;
  }, []);

  /**
   * 大纲跳转：编辑器定位到源码行，预览滚动到对应标题。
   *
   * 两个滚动都会派发事件，若期间允许联动，后执行的那个会把先执行的覆盖掉
   * （预览滚动结束时的回传会把编辑器拉走），因此这里显式暂停联动一小段时间。
   */
  const handleOutlineJump = useCallback((id: string, line: number) => {
    editorHandle.current?.scrollToLine(line);
    previewHandle.current?.scrollToId(id);

    jumpPauseRef.current = true;
    window.setTimeout(() => {
      jumpPauseRef.current = false;
    }, 700);
  }, []);

  const activeHeading = useMemo(
    () => findActiveHeading(headings, cursorLine),
    [headings, cursorLine],
  );

  // -------------------------------------------------------------------------
  // 快捷键
  // -------------------------------------------------------------------------

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // CodeMirror 等组件已经处理过的按键不再重复响应
      if (event.defaultPrevented) return;

      const mod = event.ctrlKey || event.metaKey;

      // F5 切换预览
      if (event.key === "F5") {
        event.preventDefault();
        setShowPreview((v) => !v);
        return;
      }

      // F11 导出 PDF（Ctrl+P 会与系统打印冲突，改用 F11）
      if (event.key === "F11") {
        event.preventDefault();
        void handleExportPdf();
        return;
      }

      if (!mod) return;
      const key = event.key.toLowerCase();

      if (key === "s") {
        event.preventDefault();
        void saveCurrent().then((ok) => {
          if (ok) setStatus({ kind: "ok", text: "已保存" });
        });
        return;
      }

      // Ctrl+O 打开文件，Ctrl+Shift+O 打开文件夹
      if (key === "o") {
        event.preventDefault();
        if (event.shiftKey) void handlePickFolder();
        else void handleOpenFile();
        return;
      }

      if (key === "n" && event.shiftKey) {
        event.preventDefault();
        void createFileIn(appRefs.folder ?? "");
        return;
      }

      if (key === "e" && event.shiftKey) {
        event.preventDefault();
        void handleExportHtml();
        return;
      }

      // Ctrl+\ 显示 / 收起文件面板（CodeMirror 未占用该组合）
      if (key === "\\") {
        event.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }

      if (key === "0") {
        event.preventDefault();
        setFontSize(15);
        return;
      }

      if (key === "=" || key === "+") {
        event.preventDefault();
        setFontSize((v) => Math.min(FONT_MAX, v + 1));
        return;
      }

      if (key === "-" || key === "_") {
        event.preventDefault();
        setFontSize((v) => Math.max(FONT_MIN, v - 1));
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    handleExportHtml,
    handleExportPdf,
    createFileIn,
    handleOpenFile,
    handlePickFolder,
    saveCurrent,
  ]);

  // 屏蔽 WebView2 的默认右键菜单；编辑区内保留 CodeMirror 自己的处理
  useEffect(() => {
    const suppressNativeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".cm-editor")) return;
      event.preventDefault();
    };

    window.addEventListener("contextmenu", suppressNativeMenu);
    return () => window.removeEventListener("contextmenu", suppressNativeMenu);
  }, []);

  // 刷新 / 意外卸载时兜底：不静默写盘，只在状态栏留下痕迹（交由用户决定）
  useEffect(() => {
    const handler = () => {
      if (hasUnsavedChanges()) {
        // 浏览器不允许在 unload 里弹窗，只能提示用户下次注意
        // eslint-disable-next-line no-console
        console.warn("存在未保存的修改，未写入磁盘");
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  const fileName = currentPath ? baseName(currentPath) : "未打开文件";

  return (
    <div className="app" data-theme={theme}>
      <header className="toolbar">
        <div className="toolbar-group">
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setSidebarOpen((v) => !v)}
            title="显示 / 收起文件面板（Ctrl+\\）"
          >
            ☰
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleOpenFile()}
            disabled={busy}
            title="Ctrl+O"
          >
            打开文件
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void handlePickFolder()}
            disabled={busy}
            title="Ctrl+Shift+O"
          >
            打开文件夹
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void createFileIn(folderRoot ?? "")}
            disabled={!folderRoot}
            title="Ctrl+Shift+N"
          >
            新建
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void saveCurrent()}
            disabled={!currentPath || !dirty}
            title="Ctrl+S"
          >
            保存
          </button>
        </div>

        <div className="toolbar-group">
          <button
            type="button"
            className="btn"
            onClick={() => void handleExportHtml()}
            disabled={!content}
            title="Ctrl+Shift+E"
          >
            导出 HTML
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void handleExportPdf()}
            disabled={!content}
            title="F11"
          >
            导出 PDF
          </button>
        </div>

        <div className="toolbar-title">
          <span className="file-name">{fileName}</span>
          {dirty && <span className="dirty-dot" title="有未保存的修改" />}
          <span className="title-hint">
            {dirty ? "未保存 · Ctrl+S" : currentPath ? "已保存" : ""}
          </span>
        </div>

        <div className="toolbar-group toolbar-right">
          <button
            type="button"
            className={`btn btn-toggle${scrollSync ? " is-on" : ""}`}
            onClick={() => setScrollSync((v) => !v)}
            title="编辑器与预览滚动联动"
          >
            滚动联动
          </button>
          <button
            type="button"
            className={`btn btn-toggle${showPreview ? " is-on" : ""}`}
            onClick={() => setShowPreview((v) => !v)}
            title="F5"
          >
            预览
          </button>
          <div className="font-size">
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => setFontSize((v) => Math.max(FONT_MIN, v - 1))}
              title="Ctrl+-"
            >
              A-
            </button>
            <span className="font-size-value">{fontSize}</span>
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => setFontSize((v) => Math.min(FONT_MAX, v + 1))}
              title="Ctrl+="
            >
              A+
            </button>
          </div>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            title="切换深色 / 浅色主题"
          >
            {theme === "light" ? "🌙" : "☀"}
          </button>
        </div>
      </header>

      <div
        className="workspace"
        data-preview={showPreview ? "on" : "off"}
        data-sidebar={sidebarOpen ? "on" : "off"}
      >
        {sidebarOpen && (
          <aside className="sidebar">
            <div className="sidebar-head">
              <span>文件</span>
              <span className="sidebar-head-actions">
                {folderRoot && (
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="在资源管理器中打开"
                    onClick={() =>
                      void openInExplorer(folderRoot).catch((err: unknown) =>
                        setStatus({ kind: "error", text: describeError(err) }),
                      )
                    }
                  >
                    ↗
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-icon"
                  title="收起文件面板"
                  onClick={() => setSidebarOpen(false)}
                >
                  «
                </button>
              </span>
            </div>
            <div
              className="sidebar-body"
              onContextMenu={(event) => {
                // 文件树只覆盖有内容的高度，点在下半部分空白时靠这里兜住
                event.preventDefault();
                event.stopPropagation();
                handleOpenContextMenu({
                  node: null,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              {folderRoot ? (
                <FileTree
                  root={folderRoot}
                  activePath={currentPath}
                  onOpenFile={(p) => void openFile(p)}
                  reloadToken={treeToken}
                  onContextMenu={handleOpenContextMenu}
                />
              ) : (
                <div className="panel-empty">
                  还没有打开文件夹
                  <br />
                  <span className="hint">
                    也可以直接把 .md 文件或文件夹拖进窗口
                  </span>
                </div>
              )}
            </div>
          </aside>
        )}

        <main className="editor-area">
          {currentPath ? (
            <Editor
              key={currentPath}
              value={content}
              theme={theme}
              fontSize={fontSize}
              onChange={setContent}
              onCursorLine={setCursorLine}
              onScrollRatio={handleEditorScroll}
              handleRef={editorHandle}
            />
          ) : (
            <div className="editor-placeholder">
              <div className="placeholder-card">
                <h2>Markdown 编辑器</h2>
                <p>打开一个文件夹开始编辑，右侧会实时渲染。</p>
                <div className="placeholder-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleOpenFile()}
                  >
                    打开文件
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handlePickFolder()}
                  >
                    打开文件夹
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setSidebarOpen(true);
                      void openFolder(DEFAULT_FOLDER, {
                        autoOpenFirst: true,
                      }).catch((err: unknown) =>
                        setStatus({ kind: "error", text: describeError(err) }),
                      );
                    }}
                  >
                    打开示例文件夹
                  </button>
                </div>
                <ul className="placeholder-keys">
                  <li>
                    <kbd>Ctrl</kbd>+<kbd>B</kbd> 粗体 · <kbd>Ctrl</kbd>+
                    <kbd>I</kbd> 斜体 · <kbd>Ctrl</kbd>+<kbd>K</kbd> 链接
                  </li>
                  <li>
                    <kbd>Ctrl</kbd>+<kbd>O</kbd> 打开文件 · <kbd>Ctrl</kbd>+
                    <kbd>S</kbd> 保存 · <kbd>F5</kbd> 预览 · <kbd>F11</kbd>{" "}
                    导出 PDF
                  </li>
                </ul>
              </div>
            </div>
          )}
        </main>

        {showPreview && (
          <section className="preview-pane">
            <div className="pane-head">
              <span>预览</span>
              <span className="pane-head-meta">
                {rendered.hasMermaid ? "含图表" : ""}
              </span>
            </div>
            <Preview
              html={rendered.html}
              theme={diagramTheme}
              onScrollRatio={handlePreviewScroll}
              handleRef={previewHandle}
              onRenderingChange={handleRenderingChange}
            />
          </section>
        )}

        <aside className="outline-pane">
          <div className="pane-head">
            <span>大纲</span>
            <span className="pane-head-meta">{headings.length}</span>
          </div>
          <div className="outline-body">
            <OutlinePanel
              headings={headings}
              cursorLine={cursorLine}
              onJump={(h) => handleOutlineJump(h.id, h.line)}
            />
          </div>
          {activeHeading && (
            <div className="outline-current" title={activeHeading.text}>
              当前：{activeHeading.text}
            </div>
          )}
        </aside>
      </div>

      <footer className={`statusbar status-${status.kind}`}>
        <span className="status-text">{status.text}</span>
        <span className="status-meta">
          {currentPath ? `${lineCount} 行 · ${wordCount} 字` : ""}
        </span>
      </footer>

      {menu && (
        <ContextMenu
          key={`${menu.x}:${menu.y}:${menu.node?.path ?? "blank"}`}
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onSelect={handleMenuAction}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
