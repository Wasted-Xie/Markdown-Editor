import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";

/** 父组件通过它触发编辑器内的格式化与滚动 */
export interface EditorHandle {
  /** 滚动到指定行（1 开始） */
  scrollToLine: (line: number, ratio?: number) => void;
  /** 按比例滚动（滚动联动用） */
  scrollToRatio: (ratio: number) => void;
}

/** 只要求可写 current 字段，避免绑定 React 版本特定的 Ref 类型 */
export interface HandleRef<T> {
  current: T | null;
}

interface EditorProps {
  value: string;
  theme: "light" | "dark";
  fontSize: number;
  onChange: (value: string) => void;
  /** 光标所在行变化 */
  onCursorLine: (line: number) => void;
  /** 用户滚动编辑器时上报比例（0-1） */
  onScrollRatio: (ratio: number) => void;
  handleRef: HandleRef<EditorHandle>;
}

/** 编辑器内部的格式化操作（由快捷键触发） */
type FormatAction = "bold" | "italic" | "code" | "link" | "strike";

export const Editor = memo(function Editor({
  value,
  theme,
  fontSize,
  onChange,
  onCursorLine,
  onScrollRatio,
  handleRef,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // 用 ref 保存回调，保证 CodeMirror 扩展只创建一次也能拿到最新函数
  const onChangeRef = useRef(onChange);
  const onCursorLineRef = useRef(onCursorLine);
  const onScrollRatioRef = useRef(onScrollRatio);
  // 程序化滚动期间不对外上报，避免联动死循环
  const suppressScrollRef = useRef(false);

  onChangeRef.current = onChange;
  onCursorLineRef.current = onCursorLine;
  onScrollRatioRef.current = onScrollRatio;

  // 主题与字号通过 CSS 变量驱动，避免重建 EditorState 导致闪烁
  const cssVars = useMemo(
    () =>
      ({
        "--editor-font-size": `${fontSize}px`,
      }) as CSSProperties,
    [fontSize],
  );

  // 初始化 EditorView（只执行一次：文件切换由父组件的 key 触发重挂载）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
      if (update.selectionSet || update.docChanged) {
        const pos = update.state.selection.main.head;
        onCursorLineRef.current(update.state.doc.lineAt(pos).number);
      }
    });

    // 滚动事件可能一帧内触发多次，这里合并成每帧最多上报一次，
    // 让 CodeMirror 的平滑滚动不被同步写入打断
    let scrollFrame = 0;
    let pendingRatio = 0;

    const scrollListener = EditorView.domEventHandlers({
      scroll: (_event, view) => {
        if (suppressScrollRef.current) return;
        const scroller = view.scrollDOM;
        const max = scroller.scrollHeight - scroller.clientHeight;
        pendingRatio = max > 0 ? scroller.scrollTop / max : 0;
        if (scrollFrame !== 0) return;
        scrollFrame = window.requestAnimationFrame(() => {
          scrollFrame = 0;
          onScrollRatioRef.current(pendingRatio);
        });
      },
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        foldGutter(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        placeholder("在此输入 Markdown 内容，右侧会实时渲染…"),
        EditorView.lineWrapping,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        updateListener,
        scrollListener,
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // value 只在首次挂载时使用；后续更新走下面的同步 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部值变化（例如重新加载文件）时同步进编辑器
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;

    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  // 暴露给父组件的控制接口
  useEffect(() => {
    handleRef.current = {
      scrollToLine: (line: number, ratio = 0.35) => {
        const view = viewRef.current;
        if (!view) return;
        const total = view.state.doc.lines;
        const target = Math.min(Math.max(1, line), total);
        const info = view.state.doc.line(target);

        suppressScrollRef.current = true;
        view.dispatch({
          selection: { anchor: info.from },
          effects: EditorView.scrollIntoView(info.from, { y: "start" }),
        });
        // 让目标行落在视口上方 1/3 处，阅读更自然
        const scroller = view.scrollDOM;
        const lineBlock = view.lineBlockAt(info.from);
        const max = scroller.scrollHeight - scroller.clientHeight;
        if (max > 0) {
          const desired = Math.max(
            0,
            lineBlock.top - scroller.clientHeight * ratio,
          );
          scroller.scrollTop = Math.min(desired, max);
        }
        view.focus();
        window.setTimeout(() => {
          suppressScrollRef.current = false;
        }, 80);
      },

      scrollToRatio: (ratio: number) => {
        const view = viewRef.current;
        if (!view) return;
        const scroller = view.scrollDOM;
        const max = scroller.scrollHeight - scroller.clientHeight;
        if (max <= 0) return;

        const top = Math.max(0, Math.min(1, ratio)) * max;
        // 已经在目标位置就不必再写一次，省掉无谓的重排
        if (Math.abs(scroller.scrollTop - top) < 1) return;

        suppressScrollRef.current = true;
        scroller.scrollTop = top;
        window.setTimeout(() => {
          suppressScrollRef.current = false;
        }, 80);
      },
    };

    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;

      const key = event.key.toLowerCase();
      const actions: Record<string, FormatAction> = {
        b: "bold",
        i: "italic",
        k: "link",
        e: "code",
        d: "strike",
      };

      const action = actions[key];
      if (!action) return;
      if (key === "e" && event.shiftKey) return; // Ctrl+Shift+E 留给「导出 HTML」

      const view = viewRef.current;
      if (!view) return;

      event.preventDefault();
      event.stopPropagation();
      applyFormat(view, action);
    },
    [],
  );

  return (
    <div
      className={`editor-host theme-${theme}`}
      style={cssVars}
      onKeyDown={handleKeyDown}
      ref={hostRef}
    />
  );
});

// ---------------------------------------------------------------------------
// 格式化实现
// ---------------------------------------------------------------------------

const WRAPPERS: Record<
  Exclude<FormatAction, "link">,
  { prefix: string; suffix: string; placeholder: string }
> = {
  bold: { prefix: "**", suffix: "**", placeholder: "粗体" },
  italic: { prefix: "*", suffix: "*", placeholder: "斜体" },
  code: { prefix: "`", suffix: "`", placeholder: "代码" },
  strike: { prefix: "~~", suffix: "~~", placeholder: "删除线" },
};

function applyFormat(view: EditorView, action: FormatAction): void {
  const range = view.state.selection.main;

  if (action === "link") {
    const selected = view.state.sliceDoc(range.from, range.to);
    const text = selected || "链接文字";
    const insert = `[${text}](url)`;
    // 光标落在 url 上，方便直接粘贴
    const urlStart = range.from + text.length + 3;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: urlStart, head: urlStart + 3 },
    });
    view.focus();
    return;
  }

  const { prefix, suffix, placeholder } = WRAPPERS[action];
  const selected = view.state.sliceDoc(range.from, range.to);

  // 已有相同包裹时做「反格式化」
  const before = view.state.sliceDoc(
    Math.max(0, range.from - prefix.length),
    range.from,
  );
  const after = view.state.sliceDoc(
    range.to,
    Math.min(view.state.doc.length, range.to + suffix.length),
  );

  if (before === prefix && after === suffix) {
    view.dispatch({
      changes: [
        { from: range.from - prefix.length, to: range.from, insert: "" },
        { from: range.to, to: range.to + suffix.length, insert: "" },
      ],
      selection: {
        anchor: range.from - prefix.length,
        head: range.to - prefix.length,
      },
    });
    view.focus();
    return;
  }

  const content = selected || placeholder;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: prefix + content + suffix },
    selection: {
      anchor: range.from + prefix.length,
      head: range.from + prefix.length + content.length,
    },
  });
  view.focus();
}
