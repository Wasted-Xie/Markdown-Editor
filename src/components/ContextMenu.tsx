import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** 一个菜单项；`separator: true` 时渲染成分隔线 */
export interface ContextMenuItem {
  /** 唯一标识，同时作为 onClick 的标识符 */
  id: string;
  label: string;
  /** 快捷键提示，仅展示用 */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

/**
 * 自绘右键菜单。
 *
 * 不用系统原生菜单：跨平台行为一致、可自定义条目，
 * 且不需要为 WebView2 计算屏幕坐标。
 */
export function ContextMenu({
  x,
  y,
  items,
  onSelect,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 挂载后按实际尺寸贴边修正，避免菜单超出视口
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 6;
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    });
  }, [x, y]);

  // 点击别处 / 按 Esc / 滚动 / 窗口尺寸变化都关闭菜单
  useEffect(() => {
    const close = () => onClose();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("mousedown", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        // 菜单内部的右键不触发关闭，也不弹出浏览器默认菜单
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div className="context-menu-sep" key={`sep-${index}`} />
        ) : (
          <button
            type="button"
            key={item.id}
            className={`context-menu-item${item.danger ? " is-danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onSelect(item.id);
            }}
          >
            <span className="context-menu-label">{item.label}</span>
            {item.hint && <span className="context-menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
