import { memo, useCallback, useEffect, useRef } from "react";
import { renderMermaidIn, type DiagramTheme } from "../renderer";

/** 父组件通过它控制预览区滚动（大纲跳转、滚动联动） */
export interface PreviewHandle {
  scrollToRatio: (ratio: number) => void;
  scrollToId: (id: string) => void;
}

/** 只要求可写 current 字段，避免绑定 React 版本特定的 Ref 类型 */
interface HandleRef<T> {
  current: T | null;
}

interface PreviewProps {
  html: string;
  theme: DiagramTheme;
  /** 用户滚动预览时上报比例（0-1），由父组件同步给编辑器 */
  onScrollRatio: (ratio: number) => void;
  /** 把控制接口交给父组件 */
  handleRef: HandleRef<PreviewHandle>;
  /** mermaid 渲染开始/结束，用于临时暂停滚动联动 */
  onRenderingChange?: (rendering: boolean) => void;
}

/** mermaid 渲染前的防抖时间（毫秒） */
const MERMAID_DEBOUNCE = 140;

export const Preview = memo(function Preview({
  html,
  theme,
  onScrollRatio,
  handleRef,
  onRenderingChange,
}: PreviewProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const renderTokenRef = useRef(0);
  const firstRenderRef = useRef(true);
  /** 上一次由联动程序化写入的 scrollTop，用于挡掉回传事件 */
  const programmaticTopRef = useRef(-1);

  /**
   * 程序化滚动守护。
   *
   * `scrollToId` 用平滑滚动，动画期间每帧都会派发 scroll 事件；这些中间位置
   * 若被回传给编辑器，会把刚设置好的跳转位置覆盖掉（表现为「点大纲没反应」）。
   *
   * 判断依据是「是否已接近预期目标位置」而不是「位置是否稳定」：
   * 后者在目标被边界钳制（例如滚到底部）或联动持续续期时会永远无法满足，
   * 导致守护长期不放、回传被一直拦截。
   */
  const guardRef = useRef<{ top: number; until: number; timer: number } | null>(
    null,
  );

  const releaseGuard = useCallback(() => {
    const guard = guardRef.current;
    if (!guard) return;
    window.clearTimeout(guard.timer);
    guardRef.current = null;
  }, []);

  /**
   * 声明「接下来是程序化滚动」。
   *
   * @param top 预期到达的 scrollTop。若为 null（例如平滑滚动目标未知），
   *            退化为纯时间窗口守卫。
   */
  const beginProgrammaticScroll = useCallback((top: number | null) => {
    const previous = guardRef.current;
    if (previous) window.clearTimeout(previous.timer);

    // 350ms 兜底：即使目标判断失效，也不会长期拦截回传
    const timer = window.setTimeout(() => {
      guardRef.current = null;
    }, 350);

    guardRef.current = {
      top: top ?? -1,
      until: performance.now() + 350,
      timer,
    };
  }, []);

  useEffect(() => releaseGuard, [releaseGuard]);

  // 把控制方法挂到父组件的 ref 上
  useEffect(() => {
    handleRef.current = {
      scrollToRatio: (ratio: number) => {
        const el = scrollerRef.current;
        if (!el) return;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const desired = Math.max(0, Math.min(1, ratio)) * max;

        programmaticTopRef.current = desired;
        if (Math.abs(el.scrollTop - desired) < 1) return; // 已经在位

        el.scrollTop = desired;
        // 写入可能被边界钳制，以真实落点作为预期目标
        beginProgrammaticScroll(el.scrollTop);
      },
      scrollToId: (id: string) => {
        const scroller = scrollerRef.current;
        const content = contentRef.current;
        if (!scroller || !content) return;
        const target = content.querySelector<HTMLElement>(`#${cssEscape(id)}`);
        if (!target) return;

        // 交给浏览器计算落点：它内部处理布局、contain、图片/图表撑高等细节，
        // 比手动算 getBoundingClientRect 差值可靠得多。
        // 顶部留白由 CSS 的 scroll-margin-top 控制。
        target.scrollIntoView({ block: "start", behavior: "auto" });

        beginProgrammaticScroll(scroller.scrollTop);
      },
    };

    return () => {
      handleRef.current = null;
    };
  }, [beginProgrammaticScroll]);

  // 内容变化 -> 防抖写入 DOM -> 异步渲染 mermaid
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    // 首次渲染立即执行，之后做短防抖，避免连续输入时反复触发图表渲染
    const delay = firstRenderRef.current ? 0 : MERMAID_DEBOUNCE;
    firstRenderRef.current = false;

    const timer = window.setTimeout(() => {
      const token = ++renderTokenRef.current;
      content.innerHTML = html;

      // 等一帧让布局稳定，再启动 mermaid（此时高度变化不会打断用户的滚动）
      window.requestAnimationFrame(() => {
        renderMermaidIn(content, theme)
          .then((rendered) => {
            // 只有真的渲染了图表（高度会变）才需要恢复联动判断，
            // 无图表时不打扰滚动
            if (rendered && renderTokenRef.current === token) {
              onRenderingChange?.(false);
            }
          })
          .catch(() => undefined);
      });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [html, theme, onRenderingChange]);

  // 同上：滚动上报按帧合并
  const frameRef = useRef(0);

  const handleScroll = useCallback(() => {
    if (frameRef.current !== 0) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      const el = scrollerRef.current;
      if (!el) return;

      const guard = guardRef.current;
      if (guard) {
        // 已经到达预期目标：程序化滚动完成，解除守护并上报这最后一帧
        if (Math.abs(el.scrollTop - guard.top) < 1) {
          releaseGuard();
        } else if (performance.now() < guard.until) {
          // 仍在向目标滑动中（或已被边界钳制），拦下中间帧
          return;
        } else {
          // 超出兜底窗口，必须放行，避免守护长期拦截
          releaseGuard();
        }
      }

      // 由联动程序化写入引发的滚动事件不必再回传，否则会形成往返回路
      if (Math.abs(el.scrollTop - programmaticTopRef.current) < 1) return;

      const max = el.scrollHeight - el.clientHeight;
      onScrollRatio(max > 0 ? el.scrollTop / max : 0);
    });
  }, [releaseGuard, onScrollRatio]);

  useEffect(
    () => () => {
      if (frameRef.current !== 0) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return (
    <div className="preview-scroll" ref={scrollerRef} onScroll={handleScroll}>
      <article className="preview markdown-body" ref={contentRef} />
    </div>
  );
});

/** CSS.escape 的降级实现，用于 querySelector */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/([^\w-])/g, "\\$1");
}
