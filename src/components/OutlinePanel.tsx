import { memo } from "react";
import type { OutlineHeading } from "../outline";

interface OutlinePanelProps {
  headings: OutlineHeading[];
  /** 当前光标所在行，用于高亮最近的大纲项 */
  cursorLine: number;
  onJump: (heading: OutlineHeading) => void;
}

/** 找到光标行之前（含）的最后一个标题 */
export function findActiveHeading(
  headings: OutlineHeading[],
  cursorLine: number,
): OutlineHeading | null {
  let active: OutlineHeading | null = null;
  for (const h of headings) {
    if (h.line <= cursorLine) active = h;
    else break;
  }
  return active;
}

export const OutlinePanel = memo(function OutlinePanel({
  headings,
  cursorLine,
  onJump,
}: OutlinePanelProps) {
  const active = findActiveHeading(headings, cursorLine);

  // 归一化缩进：最浅的标题作为基准，避免出现 5 级缩进
  const minLevel = headings.reduce((min, h) => Math.min(min, h.level), 6);

  if (headings.length === 0) {
    return <div className="panel-empty">当前文档没有标题</div>;
  }

  return (
    <nav className="outline">
      {headings.map((h) => (
        <button
          type="button"
          key={`${h.line}:${h.id}`}
          className={`outline-item${active?.line === h.line ? " is-active" : ""}`}
          style={{ paddingLeft: 10 + (h.level - minLevel) * 12 }}
          onClick={() => onJump(h)}
          title={`第 ${h.line} 行`}
        >
          <span className={`outline-lv outline-lv-${h.level}`}>H{h.level}</span>
          <span className="outline-text">{h.text}</span>
        </button>
      ))}
    </nav>
  );
});
