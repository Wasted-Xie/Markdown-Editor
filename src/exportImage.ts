//! 导出长图：把文档渲染成一张完整 PNG。
//!
//! ## 为什么要分片
//!
//! canvas 有硬限制。`html-to-image` 内部的 `checkCanvasDimensions`
//! 把单边限制在 16384px；浏览器实际上限约 32767px、总面积约 2.68 亿像素。
//! 超长文档一次渲染会得到被压扁或全空的图，因此采用
//! 「按片渲染 → 逐片画进总 canvas」，最终仍输出**一张完整长图**。
//!
//! 短文档也走同一条路径（边界只有一片），避免两套逻辑不一致。
//!
//! ## 两个必须遵守的约束（都是实测踩出来的）
//!
//! 1. **克隆体必须重置定位**。`html-to-image` 是 `cloneNode()` 后把克隆体
//!    塞进 SVG foreignObject，而克隆体保留原节点的行内样式；它的
//!    `applyStyle` 只覆盖 width/height/backgroundColor。我们的离屏容器用了
//!    `position:fixed; left:-100000px`，不重置就会连偏移一起序列化，
//!    内容落在 SVG 视口外 → 导出一张纯背景色的空白图。
//! 2. **分片靠 `transform: translateY`，不能用负 margin**，且容器不能有
//!    垂直 padding —— foreignObject 视口固定，垂直 padding 会被 `height`
//!    压掉（border-box），导致每片少一截内容、拼接错位累积。
//!    留白改在最终 canvas 上补。

import { toCanvas } from "html-to-image";
import { renderMarkdown, renderMermaidIn, type DiagramTheme } from "./renderer";

/** 导出图的容器宽度（CSS px），含左右内边距。 */
export const EXPORT_CONTENT_WIDTH = 900;

/** 导出图四周留白（CSS px）。 */
export const EXPORT_PADDING = 40;

/** 单片的 CSS 像素高度。 */
const SLICE_HEIGHT = 3000;

/**
 * 单次 `toCanvas` 的边长上限。
 *
 * 取 15000 而不是库内部的 16384：留出余量，
 * 避免它触发 `checkCanvasDimensions` 自动缩放把图压扁。
 */
const SINGLE_MAX_SIDE = 15000;

/** 最终拼接 canvas 的单边上限（自行创建，适用浏览器约 32767 的真实上限）。 */
const FINAL_MAX_SIDE = 32000;

/** 最终拼接 canvas 的面积上限（Chromium 约 2.68 亿，取 2.5 亿留余量）。 */
const FINAL_MAX_AREA = 250_000_000;

/** 默认渲染倍率。 */
export const DEFAULT_SCALE = 2;

/**
 * 导出图的最大宽度（CSS px）。
 *
 * 宽元素（长公式、宽表格）无法折行，只能横向展开。若不设上限，
 * 极端内容会产出几千像素宽的图。但上限也不能太小 —— 否则公式会被裁掉，
 * 那正是导出要避免的问题。
 *
 * 取 6000：足以容纳常见的长公式与宽表格；超出这个宽度的内容极少见，
 * 且此时会走 clamp 缩放路径。
 */
const MAX_CONTENT_WIDTH = 6000;

/** 倍率下限；低于此值不如提示用户改用 HTML 导出。 */
const MIN_SCALE = 0.5;

/**
 * 重置克隆体定位。见文件头注释「约束 1」。
 */
const CLONE_RESET: Record<string, string> = {
  position: "static",
  left: "auto",
  top: "auto",
  right: "auto",
  bottom: "auto",
  margin: "0",
  zIndex: "0",
  contain: "none",
  // 容器不留垂直 padding，留白在最终 canvas 上补
  paddingTop: "0",
  paddingBottom: "0",
};

export interface ExportImageOptions {
  scale?: number;
  backgroundColor?: string;
  /** 进度回调：ratio 为 0-1 */
  onProgress?: (ratio: number, message: string) => void;
}

export interface ExportImageResult {
  dataUrl: string;
  width: number;
  height: number;
  /** 实际使用的倍率（超限时会被调低） */
  scale: number;
  /** 是否走了分片路径 */
  sliced: boolean;
  /** 分片数量（未分片为 1） */
  sliceCount: number;
}

/**
 * 建一个离屏容器渲染文档，供导出成图片。
 *
 * 结构分两层，这是关键：
 *
 *   .export-wrap            外层：提供留白、决定最终画布宽度
 *     └ .preview.export-root  正文栏：**固定 900px**，文本换行保持正常
 *
 * 为什么不能只有一层：若把正文栏本身撑宽，全文会重排成一行超长文本，
 * 得到一张几千像素宽、却只有一两行字的废图。
 * 正确做法是正文栏保持阅读宽度，宽表格/公式向右溢出，外层按溢出量加宽。
 *
 * 调用方负责在用完后 `element.remove()`。
 */
export async function renderExportRoot(
  source: string,
  width: number = EXPORT_CONTENT_WIDTH,
): Promise<HTMLElement> {
  const theme: DiagramTheme =
    document.documentElement.dataset.theme === "dark" ? "dark" : "light";

  const { html } = renderMarkdown(source);

  const cssVar = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg")
    .trim();
  const background = cssVar || (theme === "dark" ? "#0d1117" : "#ffffff");

  // 外层：初始宽度只够正文栏 + 留白，稍后按溢出量加宽
  const wrap = document.createElement("div");
  wrap.className = "export-wrap";
  wrap.style.cssText = [
    "position:fixed",
    "left:-100000px",
    "top:0",
    `width:${width + EXPORT_PADDING * 2}px`,
    "max-width:none",
    "margin:0",
    `padding:0 ${EXPORT_PADDING}px`,
    `background:${background}`,
    "contain:none",
    "z-index:-1",
    "pointer-events:none",
  ].join(";");

  // 正文栏：宽度固定，保证换行与阅读宽度一致
  const holder = document.createElement("div");
  holder.className = "preview markdown-body export-root";
  holder.style.cssText = [
    `width:${width}px`,
    "max-width:none",
    "margin:0",
    "padding:0",
  ].join(";");
  holder.innerHTML = html;

  wrap.appendChild(holder);
  document.body.appendChild(wrap);

  try {
    await renderMermaidIn(holder, theme);
  } catch {
    // 图表渲染失败不该阻断导出，保留占位块即可
  }

  expandWrapToFitContent(wrap, holder, width);

  return wrap;
}

/**
 * 可能真正超出正文栏的元素白名单。
 *
 * 必须用白名单，不能遍历全部后代：KaTeX 的可伸缩符号（根号、积分号等）
 * 内部用 `width="400em"` 的 SVG 再靠 CSS 裁切显示，
 * 它的 getBoundingClientRect 会返回几千像素 —— 但那是**视觉上已被裁掉的内部结构**，
 * 并非真实溢出。
 *
 * 早期版本遍历所有元素取最大右边界，于是画布被无谓撑宽
 * （正文 900px、画布 2080px，右侧一大片空白）。
 */
const WIDE_SELECTORS = [
  "table",
  "pre",
  ".katex-display",
  ".mermaid-block",
  "img",
].join(",");

/**
 * 按正文栏内最宽元素的溢出量加宽外层容器。
 *
 * 正文栏宽度固定，所以这里改外层宽度**不会引起重排**，一次测量即可。
 *
 * 宽度会被 MAX_CONTENT_WIDTH 截住：公式、宽表格这类无法折行的元素，
 * 超过上限时改为让它们自身缩放（由 styles.css 的 export-wrap--clamp 规则处理），
 * 而不是把整张图撑到几千像素宽。
 *
 * @returns 实际采用的正文区宽度
 */
function expandWrapToFitContent(
  wrap: HTMLElement,
  holder: HTMLElement,
  contentWidth: number,
): number {
  const base = holder.getBoundingClientRect();
  let maxRight = contentWidth;
  let minLeft = 0;

  for (const el of holder.querySelectorAll<HTMLElement>(WIDE_SELECTORS)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const right = r.right - base.left;
    const left = r.left - base.left;
    if (right > maxRight) maxRight = right;
    if (left < minLeft) minLeft = left;
  }

  const natural = Math.ceil(maxRight - minLeft) + 2; // 吸收亚像素误差
  const contentSpan = Math.min(natural, MAX_CONTENT_WIDTH);

  wrap.style.width = `${contentSpan + EXPORT_PADDING * 2}px`;
  // 供样式表判断是否需要让宽元素缩放
  wrap.dataset.contentWidth = String(contentSpan);
  if (natural > MAX_CONTENT_WIDTH) {
    wrap.classList.add("export-wrap--clamp");
  }

  return contentSpan;
}

/** 取背景色：显式传入 > 计算样式 > 白色。 */
function resolveBackground(element: HTMLElement, explicit?: string): string {
  if (explicit) return explicit;
  const computed = getComputedStyle(element).backgroundColor;
  if (!computed || computed === "rgba(0, 0, 0, 0)" || computed === "transparent") {
    return "#ffffff";
  }
  return computed;
}

/** 按 0.05 向下取整，避免浮点噪声导致临界超限。 */
function quantize(scale: number): number {
  return Math.floor(scale * 20) / 20;
}

/**
 * 计算最终图片的倍率。
 *
 * 受三重约束：最终 canvas 的单边、面积，以及单片渲染时的边长。
 */
function resolveScale(
  cssWidth: number,
  cssHeight: number,
  preferred: number,
): number | null {
  const paddedHeight = cssHeight + EXPORT_PADDING * 2;

  const byFinalSide = Math.min(
    FINAL_MAX_SIDE / cssWidth,
    FINAL_MAX_SIDE / paddedHeight,
  );
  const byArea = Math.sqrt(FINAL_MAX_AREA / (cssWidth * paddedHeight));
  // 单片高度也受单次渲染上限约束
  const bySlice = SINGLE_MAX_SIDE / SLICE_HEIGHT;

  const scale = quantize(
    Math.min(preferred, byFinalSide, byArea, bySlice),
  );

  return scale >= MIN_SCALE ? scale : null;
}

export async function exportElementAsImage(
  element: HTMLElement,
  options: ExportImageOptions = {},
): Promise<ExportImageResult> {
  const cssWidth = Math.ceil(element.clientWidth);
  const cssHeight = Math.ceil(element.scrollHeight);

  if (cssWidth <= 0 || cssHeight <= 0) {
    throw new Error("预览区尺寸为 0，无法导出");
  }

  const background = resolveBackground(element, options.backgroundColor);
  const opaque = background === "rgba(0, 0, 0, 0)" ? "#ffffff" : background;

  const preferred = options.scale ?? DEFAULT_SCALE;
  const scale = resolveScale(cssWidth, cssHeight, preferred);

  if (scale === null) {
    throw new Error(
      `内容过长（${cssWidth}×${cssHeight} CSS px），超出可导出上限。` +
        `建议改用「导出 HTML」，或把文档拆成多份。`,
    );
  }

  const boundaries = planSlices(element, cssHeight);
  const sliceCount = boundaries.length - 1;
  const sliced = sliceCount > 1;

  // 最终画布：上下各补 EXPORT_PADDING 留白
  const padPx = Math.round(EXPORT_PADDING * scale);
  const outWidth = Math.floor(cssWidth * scale);
  const outHeight = Math.floor(cssHeight * scale) + padPx * 2;

  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 canvas 上下文");

  // 先铺底色：PNG 默认透明，深色主题导出会变成白底黑字看不清
  ctx.fillStyle = opaque;
  ctx.fillRect(0, 0, outWidth, outHeight);

  for (let i = 0; i < sliceCount; i += 1) {
    const top = boundaries[i];
    const bottom = boundaries[i + 1];
    const sliceHeight = bottom - top;
    if (sliceHeight <= 0) continue;

    if (sliced) {
      options.onProgress?.(i / sliceCount, `渲染第 ${i + 1}/${sliceCount} 段…`);
    } else {
      options.onProgress?.(0.3, "正在渲染…");
    }

    const slice = await toCanvas(element, {
      width: cssWidth,
      height: sliceHeight,
      backgroundColor: opaque,
      pixelRatio: scale,
      // 尺寸由我们自己保证，避免库自动缩放把图压扁
      skipAutoScale: true,
      style: {
        ...CLONE_RESET,
        // 关键：把目标区间移到视口顶端。不能用负 margin（见文件头约束 2）
        transform: `translateY(-${top}px)`,
        transformOrigin: "top left",
      } as unknown as Partial<CSSStyleDeclaration>,
    });

    ctx.drawImage(
      slice,
      0,
      0,
      slice.width,
      slice.height,
      0,
      padPx + Math.round(top * scale),
      outWidth,
      Math.round(sliceHeight * scale),
    );

    // 让出主线程，避免长文档导出时界面完全卡死
    if (sliced) await new Promise((r) => setTimeout(r, 0));
  }

  options.onProgress?.(1, "生成图片…");

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: outWidth,
    height: outHeight,
    scale,
    sliced,
    sliceCount,
  };
}

/**
 * 规划分片边界（CSS px，相对元素顶部）。
 *
 * 优先切在块级元素之间的空隙，避免把一行文字或一个图表拦腰截断；
 * 附近没有合适空隙时退回等分位置，保证一定能切、不会死循环。
 */
function planSlices(element: HTMLElement, totalHeight: number): number[] {
  if (totalHeight <= SLICE_HEIGHT) return [0, totalHeight];

  const gaps = collectGaps(element);
  gaps.push(0, totalHeight);
  gaps.sort((a, b) => a - b);

  const boundaries: number[] = [0];
  let cursor = 0;

  while (cursor + SLICE_HEIGHT < totalHeight) {
    const ideal = cursor + SLICE_HEIGHT;

    // 找 ideal 之前、且离 cursor 足够远的最大空隙
    let chosen = -1;
    for (let i = gaps.length - 1; i >= 0; i -= 1) {
      const g = gaps[i];
      if (g <= ideal && g - cursor >= SLICE_HEIGHT / 2) {
        chosen = g;
        break;
      }
    }

    const next = chosen >= 0 ? chosen : ideal;
    boundaries.push(Math.round(next));
    cursor = next;
  }

  boundaries.push(totalHeight);
  return boundaries;
}

/** 收集可作为分片间隙的纵向位置（相对元素顶部）。 */
function collectGaps(root: HTMLElement): number[] {
  const rootTop = root.getBoundingClientRect().top;
  const gaps: number[] = [];

  const blocks = root.querySelectorAll<HTMLElement>(
    "h1,h2,h3,h4,h5,h6,p,pre,blockquote,table,ul,ol,hr,div.mermaid-block",
  );

  for (const block of blocks) {
    const r = block.getBoundingClientRect();
    if (r.height <= 0) continue;
    gaps.push(r.top - rootTop, r.bottom - rootTop);
  }

  return gaps;
}

/** 把 data URL 拆成纯 Base64（供 Rust 侧解码写盘）。 */
export function dataUrlToBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf("base64,");
  return idx >= 0 ? dataUrl.slice(idx + "base64,".length) : dataUrl;
}
