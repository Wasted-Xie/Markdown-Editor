//! Markdown 渲染管线：markdown-it + GFM + KaTeX + Mermaid + highlight.js
//!
//! 分两阶段：
//!   1. 同步：markdown-it 渲染出 HTML（含安全清洗）
//!   2. 异步：把 mermaid 代码块占位替换成 SVG
//! 这样输入时的实时预览不会被 mermaid 的异步渲染阻塞。

import MarkdownIt from "markdown-it";
import type { MarkdownIt as MarkdownItInstance } from "markdown-it";
import katexPlugin from "@vscode/markdown-it-katex";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import type { MermaidConfig } from "mermaid";

/** 代码块 / 行内代码的语言标记 -> mermaid */
const MERMAID_LANGS = new Set(["mermaid", "mmd"]);

/** mermaid 图表容器类名，供 CSS 与后续查找使用 */
export const MERMAID_BLOCK_CLASS = "mermaid-block";

/** 渲染主题。与 mermaid 的 theme 字段一一对应 */
export type DiagramTheme = "light" | "dark";

let mdInstance: MarkdownItInstance | null = null;
let mermaidLoader: Promise<typeof import("mermaid").default> | null = null;
let mermaidTheme: DiagramTheme | null = null;

// ---------------------------------------------------------------------------
// markdown-it 初始化
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createMarkdownIt(): MarkdownItInstance {
  const md = new MarkdownIt({
    html: true, // 允许内嵌 HTML，导出时会被清洗
    linkify: true, // 自动识别裸 URL
    typographer: false, // 不做智能引号替换，避免中文标点被误改
    breaks: false,
    langPrefix: "language-",
    highlight(code: string, lang: string): string {
      const language = (lang || "").trim().toLowerCase();

      // mermaid 交给第二阶段处理，这里只输出占位容器
      if (MERMAID_LANGS.has(language)) {
        return `<div class="${MERMAID_BLOCK_CLASS}" data-mermaid="${encodeURIComponent(
          code,
        )}"></div>`;
      }

      if (language && hljs.getLanguage(language)) {
        try {
          return hljs.highlight(code, {
            language,
            ignoreIllegals: true,
          }).value;
        } catch {
          /* 落到下面的纯文本分支 */
        }
      }

      // 未标注语言或语言不支持时，按纯文本转义，不做自动猜测（猜错更难看）
      return escapeHtml(code);
    },
  });

  // 注意：@vscode/markdown-it-katex 的选项类型只声明了下面这些字段，
  // 传 errorColor / strict 会导致 tsc 报「对象字面量只能指定已知属性」。
  md.use(katexPlugin, {
    throwOnError: false,
  });

  md.use(taskLists, { enabled: true, label: true, labelAfter: true });

  return md;
}

/**
 * 给 HTML 里的标题补 id，供大纲跳转使用。
 *
 * 用「渲染后处理」而不是 `md.core.ruler` 插件：后者需要在回调上显式标注
 * markdown-it 的内部类型（StateCore），而 `@types/markdown-it` 的默认导出
 * 只有类型构造函数、没有可用的类型命名空间，写起来反而更脆弱。
 */
function addHeadingAnchors(html: string): string {
  const used = new Map<string, number>();

  return html.replace(
    /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g,
    (tag, level: string, attrs: string, inner: string) => {
      // 已自带 id（用户手写 HTML）时不覆盖
      if (/\sid\s*=/.test(attrs)) return tag;

      const text = inner
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      let slug = slugify(text);
      const count = used.get(slug) ?? 0;
      used.set(slug, count + 1);
      if (count > 0) slug = `${slug}-${count}`;

      return `<h${level}${attrs} id="${escapeHtml(slug)}">${inner}</h${level}>`;
    },
  );
}

/** 中文保留原字符，空白转连字符，去掉标点 */
export function slugify(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "");
  return base || "section";
}

function getMarkdownIt(): MarkdownItInstance {
  if (!mdInstance) mdInstance = createMarkdownIt();
  return mdInstance;
}

// ---------------------------------------------------------------------------
// 安全清洗
// ---------------------------------------------------------------------------

const PURIFY_CONFIG = {
  ADD_TAGS: [
    "math",
    "semantics",
    "annotation",
    "annotation-xml",
    "mrow",
    "mi",
    "mo",
    "mn",
    "ms",
    "mtext",
    "mspace",
    "msup",
    "msub",
    "msubsup",
    "mfrac",
    "mroot",
    "msqrt",
    "mstyle",
    "munder",
    "mover",
    "munderover",
    "mtable",
    "mtr",
    "mtd",
    "mlabeledtr",
    "mpadded",
    "mphantom",
    "menclose",
    "mglue",
    "mspace",
    "svg",
    "path",
    "g",
    "use",
    "defs",
    "marker",
    "foreignObject",
    "text",
    "tspan",
  ],
  ADD_ATTR: [
    "class",
    "id",
    "style",
    "align",
    "colspan",
    "rowspan",
    "start",
    "type",
    "checked",
    "disabled",
    "data-mermaid",
    "aria-hidden",
    "xmlns",
    "viewBox",
    "d",
    "fill",
    "stroke",
    "stroke-width",
    "transform",
    "x",
    "y",
    "x1",
    "x2",
    "y1",
    "y2",
    "points",
    "rx",
    "ry",
    "cx",
    "cy",
    "r",
    "width",
    "height",
    "marker-end",
    "marker-start",
    "text-anchor",
    "dominant-baseline",
    "font-size",
    "font-family",
  ],
  // 注意：不能禁用 input —— GFM 任务列表依赖 <input type="checkbox">
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "base"],
  FORBID_ATTR: ["srcdoc", "formaction", "onerror", "onload", "onclick"],
  // 允许 data: 图片（本地粘贴的 base64 图片）
  ALLOW_DATA_ATTR: true,
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
};

function sanitize(html: string): string {
  return DOMPurify.sanitize(
    html,
    PURIFY_CONFIG as Parameters<typeof DOMPurify.sanitize>[1],
  ) as unknown as string;
}

// ---------------------------------------------------------------------------
// 对外渲染接口
// ---------------------------------------------------------------------------

export interface RenderResult {
  /** 已清洗的 HTML（mermaid 占位尚未替换） */
  html: string;
  /** 是否包含 mermaid 图表 */
  hasMermaid: boolean;
}

/** 第一阶段：同步渲染 Markdown -> HTML */
export function renderMarkdown(source: string): RenderResult {
  const md = getMarkdownIt();
  const raw = addHeadingAnchors(md.render(source));
  const html = sanitize(raw);

  return {
    html,
    hasMermaid: html.includes(`class="${MERMAID_BLOCK_CLASS}"`),
  };
}

/** 第二阶段：把容器内的 mermaid 占位替换成 SVG。返回是否真的渲染了图表 */
export async function renderMermaidIn(
  container: HTMLElement,
  theme: DiagramTheme,
): Promise<boolean> {
  const placeholders = Array.from(
    container.querySelectorAll<HTMLElement>(`.${MERMAID_BLOCK_CLASS}`),
  );
  // 没有图表时立即返回，调用方据此避免多余的联动暂停
  if (placeholders.length === 0) return false;

  const mermaid = await loadMermaid(theme);
  container.classList.add("mermaid-rendering");

  for (let i = 0; i < placeholders.length; i += 1) {
    const el = placeholders[i];
    const source = decodeURIComponent(el.dataset.mermaid ?? "");
    if (!source.trim()) {
      el.classList.add("mermaid-error");
      el.textContent = "（空的 mermaid 代码块）";
      continue;
    }

    const id = `mermaid-${Date.now().toString(36)}-${i}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    try {
      const { svg } = await mermaid.render(id, source);
      el.innerHTML = svg;
      el.dataset.rendered = "1";
    } catch (err) {
      // 渲染失败时保留源码和错误信息，而不是留下空白
      el.classList.add("mermaid-error");
      const message = err instanceof Error ? err.message : String(err);
      el.innerHTML = `<pre class="mermaid-error-msg">Mermaid 渲染失败：\n${escapeHtml(
        message,
      )}\n\n源码：\n${escapeHtml(source)}</pre>`;

      // mermaid 失败时可能在 body 里遗留临时节点
      document.getElementById(`d${id}`)?.remove();
    }
  }

  container.classList.remove("mermaid-rendering");
  return true;
}

async function loadMermaid(
  theme: DiagramTheme,
): Promise<typeof import("mermaid").default> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((mod) => mod.default);
  }

  const mermaid = await mermaidLoader;

  if (mermaidTheme !== theme) {
    const config: MermaidConfig = {
      startOnLoad: false,
      securityLevel: "strict",
      // mermaid 的主题名没有 "light"，浅色对应 "default"
      theme: theme === "dark" ? "dark" : "default",
      fontFamily:
        '"Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", ' +
        '"Source Han Sans SC", "WenQuanYi Micro Hei", system-ui, sans-serif',
      flowchart: { useMaxWidth: true, htmlLabels: true },
      sequence: { useMaxWidth: true },
      gantt: { useMaxWidth: true },
      er: { useMaxWidth: true },
      journey: { useMaxWidth: true },
    };
    mermaid.initialize(config);
    mermaidTheme = theme;
  }

  return mermaid;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/** 收集页面样式；排除非当前主题的 highlight 样式表 */
function collectCss(): string {
  const chunks: string[] = [];

  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode as HTMLElement | null;
    const hljsTheme = owner?.dataset?.hljsTheme;
    if (hljsTheme && hljsTheme !== currentTheme()) continue;

    try {
      for (const rule of Array.from(sheet.cssRules)) {
        chunks.push(rule.cssText);
      }
    } catch {
      // 跨域样式表无法读取，跳过
    }
  }

  return chunks.join("\n");
}

function currentTheme(): DiagramTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * 构建用于导出的完整 HTML。
 *
 * 关键点：
 *  - 在临时离屏容器里重新渲染并跑一遍 mermaid，保证「预览面板已隐藏」时
 *    导出的文件里依然是渲染好的 SVG，而不是代码占位。
 *  - 内联全部 CSS；若文档含公式，把 KaTeX 字体也转成 data URI，
 *    使导出的单文件在离线环境下依然排版正确。
 */
export async function buildExportHtml(
  source: string,
  title: string,
): Promise<string> {
  const theme = currentTheme();
  const { html } = renderMarkdown(source);

  const holder = document.createElement("div");
  holder.style.cssText =
    "position:fixed;left:-100000px;top:0;width:900px;background:#fff;";
  document.body.appendChild(holder);

  let body = html;
  try {
    // 临时挂上 .preview 类，让 mermaid / 图表样式生效
    holder.className = "preview markdown-body";
    holder.innerHTML = html;
    await renderMermaidIn(holder, theme);
    body = holder.innerHTML;
  } catch {
    body = html;
  } finally {
    holder.remove();
  }

  const css = await embedKatexFonts(collectCss());
  const safeTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
${css}
html, body { margin: 0; padding: 0; }
body { background: var(--bg); color: var(--fg); }
.export-wrap { max-width: 900px; margin: 0 auto; padding: 40px 32px 96px; }
.export-wrap .preview { padding: 0; max-width: none; }
@media print {
  body { background: #fff; }
  .export-wrap { max-width: none; padding: 0; }
  pre, blockquote, table, .preview .mermaid-block { break-inside: avoid; }
  .preview h1, .preview h2, .preview h3 { break-after: avoid; }
}
</style>
</head>
<body data-theme="${theme}">
<div class="export-wrap">
<article class="preview markdown-body">
${body}
</article>
</div>
</body>
</html>`;
}

let katexFontCache: Map<string, string> | null = null;

/** 把 CSS 里引用的字体文件读成 data URI，使导出文件不依赖外部资源 */
async function embedKatexFonts(css: string): Promise<string> {
  const fonts = await katexFontDataUrls();
  let out = css;

  // 文档里没有公式时 fonts 为空，直接原样返回
  for (const [url, data] of fonts) {
    if (out.includes(url)) out = out.split(url).join(data);
  }

  return out.replace(/<\/style>/gi, "<\\/style>");
}

async function katexFontDataUrls(): Promise<Map<string, string>> {
  if (katexFontCache) return katexFontCache;

  const map = new Map<string, string>();
  const seen = new Set<string>();
  const hasFormula = document.querySelector(".preview .katex") !== null;

  if (hasFormula) {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }

      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSFontFaceRule)) continue;

        const src = rule.style.getPropertyValue("src");
        for (const match of src.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
          const raw = match[2];
          if (!/\.(woff2?|ttf|otf)(\?|$)/i.test(raw) || seen.has(raw)) continue;
          seen.add(raw);

          try {
            // 用样式表自身的地址解析相对路径，保证命中 node_modules 里的字体
            const href = sheet.href
              ? new URL(raw, sheet.href).href
              : new URL(raw, document.baseURI).href;
            const res = await fetch(href);
            if (!res.ok) continue;
            const blob = await res.blob();
            const data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            map.set(raw, data);
          } catch {
            // 读取失败时保留原始 URL
          }
        }
      }
    }
  }

  katexFontCache = map;
  return map;
}
