import { memo, useCallback, useEffect, useRef, useState } from "react";
import { listDir, listDirsInfo } from "../fs";
import type { DirNode } from "../types";

/** 右键菜单的触发信息；node 为 null 表示点在空白处 */
export interface ContextTarget {
  node: DirNode | null;
  x: number;
  y: number;
}

interface FileTreeProps {
  root: string;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  /** 重新加载整个树的信号：每次自增触发一次立即同步 */
  reloadToken: number;
  onContextMenu: (target: ContextTarget) => void;
}

/**
 * 轮询间隔。
 *
 * 每次轮询先只做 `list_dirs_info`（对目录本身 stat，不读内容），
 * 只有版本变化时才 `list_dir` 拉完整列表 —— 所以这个间隔可以放得很短。
 */
const POLL_INTERVAL = 500;

/** 用「子项签名」判断目录内容是否变化，避免无意义的重复渲染 */
function dirSignature(nodes: DirNode[]): string {
  return nodes.map((n) => `${n.kind}:${n.path}`).join("|");
}

function sameNodes(a: DirNode[] | undefined, b: DirNode[]): boolean {
  if (!a || a.length !== b.length) return false;
  return dirSignature(a) === dirSignature(b);
}

interface RowProps {
  node: DirNode;
  depth: number;
  activePath: string | null;
  expandedDirs: Set<string>;
  childrenMap: Record<string, DirNode[]>;
  loadingDirs: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (target: ContextTarget) => void;
}

/** 单个节点（目录可展开，文件可点击，支持右键菜单） */
function TreeRow({
  node,
  depth,
  activePath,
  expandedDirs,
  childrenMap,
  loadingDirs,
  onToggle,
  onOpenFile,
  onContextMenu,
}: RowProps) {
  const isDir = node.kind === "dir";
  const isActive = node.path === activePath;
  const expanded = isDir && expandedDirs.has(node.path);
  const children = childrenMap[node.path] ?? [];
  const loading = loadingDirs.has(node.path);
  const indent = 8 + depth * 14;

  const handleClick = useCallback(() => {
    if (isDir) onToggle(node.path);
    else onOpenFile(node.path);
  }, [isDir, node.path, onOpenFile, onToggle]);

  return (
    <div
      className="tree-node"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu({ node, x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        className={`tree-row${isActive ? " is-active" : ""}`}
        style={{ paddingLeft: indent }}
        onClick={handleClick}
        title={node.path}
      >
        <span className="tree-icon">
          {isDir ? (expanded ? "▾" : "▸") : "•"}
        </span>
        <span className="tree-name">{node.name}</span>
        {loading && <span className="tree-loading">…</span>}
      </button>

      {expanded &&
        children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            expandedDirs={expandedDirs}
            childrenMap={childrenMap}
            loadingDirs={loadingDirs}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
          />
        ))}

      {expanded && !loading && children.length === 0 && (
        <div className="tree-empty" style={{ paddingLeft: indent + 14 }}>
          （空）
        </div>
      )}
    </div>
  );
}

export const FileTree = memo(function FileTree({
  root,
  activePath,
  onOpenFile,
  reloadToken,
  onContextMenu,
}: FileTreeProps) {
  const [rootNodes, setRootNodes] = useState<DirNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 展开状态与子目录内容都放在这一层：
  // 这样轮询刷新时只替换数据，不会把用户展开的目录重新收起来
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Record<string, DirNode[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

  /** 目录版本号（mtime / size），用于判断是否值得重新读取内容 */
  const infoMapRef = useRef<Map<string, string>>(new Map());
  /** 轮询回调里要读最新的展开列表，用 ref 避免重建定时器 */
  const expandedRef = useRef(expandedDirs);
  expandedRef.current = expandedDirs;

  const knownDirs = useCallback((): string[] => {
    return [root, ...Array.from(expandedRef.current)];
  }, [root]);

  /** 从后端刷新「目录版本号」，返回是否存在真实变化 */
  const refreshDirInfo = useCallback(
    async (dirs: string[]): Promise<Map<string, boolean>> => {
      const changed = new Map<string, boolean>();
      if (dirs.length === 0) return changed;

      const infos = await listDirsInfo(dirs).catch(() => null);
      if (!infos) {
        dirs.forEach((d) => changed.set(d, false));
        return changed;
      }

      const seen = new Set<string>();
      for (const info of infos) {
        seen.add(info.path);
        const version = info.exists
          ? `${info.modifiedMs ?? 0}:${info.size ?? 0}`
          : "gone";
        const previous = infoMapRef.current.get(info.path);
        changed.set(info.path, previous !== version);
        infoMapRef.current.set(info.path, version);
      }

      // 后端没返回的目录按「无变化」处理
      dirs.filter((d) => !seen.has(d)).forEach((d) => changed.set(d, false));

      return changed;
    },
    [],
  );

  /** 读取某个目录的直接子项 */
  const loadChildren = useCallback(
    async (dir: string): Promise<DirNode[] | null> => {
      setLoadingDirs((prev) => new Set(prev).add(dir));
      try {
        return await listDir(dir);
      } catch {
        return null;
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dir);
          return next;
        });
      }
    },
    [],
  );

  const toggleDir = useCallback(
    async (path: string) => {
      const willExpand = !expandedRef.current.has(path);

      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (willExpand) next.add(path);
        else next.delete(path);
        return next;
      });

      if (!willExpand) {
        // 收起时清掉缓存，下次展开拿最新内容
        setChildrenMap((prev) => {
          const next = { ...prev };
          delete next[path];
          return next;
        });
        infoMapRef.current.delete(path);
        return;
      }

      const [list] = await Promise.all([
        loadChildren(path),
        refreshDirInfo([path]),
      ]);
      if (list) {
        setChildrenMap((prev) => ({ ...prev, [path]: list }));
      }
    },
    [loadChildren, refreshDirInfo],
  );

  // 工作区切换：重置展开状态并重读根目录
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setExpandedDirs(new Set());
    setChildrenMap({});
    infoMapRef.current.clear();

    listDir(root)
      .then((list) => {
        if (!cancelled) setRootNodes(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRootNodes([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [root]);

  /**
   * 一次同步：先看版本号，只重新读取真正变化的目录。
   *
   * @param force 忽略版本号，强制重读（用户点「刷新」或应用内刚做过文件操作）
   */
  const sync = useCallback(
    async (force = false) => {
      const dirs = knownDirs();
      const changed = await refreshDirInfo(dirs);

      const stale: string[] = [];
      for (const dir of dirs) {
        if (force || changed.get(dir)) stale.push(dir);
      }

      const [rootList, ...childLists] = await Promise.all([
        stale.includes(root) ? listDir(root).catch(() => null) : null,
        ...stale
          .filter((d) => d !== root)
          .map((dir) => loadChildren(dir)),
      ]);

      if (rootList) {
        setRootNodes((prev) => (sameNodes(prev, rootList) ? prev : rootList));
      }

      if (childLists.length > 0) {
        const updates: Record<string, DirNode[]> = {};
        const removed: string[] = [];

        stale
          .filter((d) => d !== root)
          .forEach((dir, index) => {
            const list = childLists[index];
            if (list) updates[dir] = list;
            else removed.push(dir); // 目录已不存在（被删或改名）
          });

        if (Object.keys(updates).length > 0) {
          setChildrenMap((prev) => {
            let next = prev;
            for (const [dir, list] of Object.entries(updates)) {
              if (!sameNodes(prev[dir], list)) {
                if (next === prev) next = { ...prev };
                next[dir] = list;
              }
            }
            return next;
          });
        }

        // 目录被删除时一并收起，避免残留空节点
        if (removed.length > 0) {
          setExpandedDirs((prev) => {
            const next = new Set(prev);
            removed.forEach((d) => next.delete(d));
            return next;
          });
          setChildrenMap((prev) => {
            const next = { ...prev };
            removed.forEach((d) => delete next[d]);
            return next;
          });
          removed.forEach((d) => infoMapRef.current.delete(d));
        }
      }
    },
    [knownDirs, loadChildren, refreshDirInfo, root],
  );

  // 应用内操作（新建 / 删除 / 重命名 / 粘贴）后立即强制同步；保留展开状态
  useEffect(() => {
    if (reloadToken === 0) return;
    void sync(true);
  }, [reloadToken, sync]);

  // 定时轮询：外部增删文件后 0.5 秒内反映到目录树
  useEffect(() => {
    const timer = window.setInterval(() => void sync(), POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [sync]);

  if (error) {
    return (
      <div
        className="file-tree"
        onContextMenu={(event) => {
          event.preventDefault();
          // 阻断冒泡：避免 sidebar-body 的处理器再触发一次菜单
          event.stopPropagation();
          onContextMenu({ node: null, x: event.clientX, y: event.clientY });
        }}
      >
        <div className="panel-empty">读取文件夹失败：{error}</div>
      </div>
    );
  }

  return (
    <div
      className="file-tree"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        // 点在空白处：节点级别已经 stopPropagation，走到这里的都是空白
        onContextMenu({ node: null, x: event.clientX, y: event.clientY });
      }}
    >
      {rootNodes.length === 0 ? (
        <div className="panel-empty">此文件夹下没有可编辑的文本文件</div>
      ) : (
        rootNodes.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            activePath={activePath}
            expandedDirs={expandedDirs}
            childrenMap={childrenMap}
            loadingDirs={loadingDirs}
            onToggle={(path) => void toggleDir(path)}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
          />
        ))
      )}
    </div>
  );
});
