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
 * 建一个固定宽度的离屏容器渲染文档，供导出成图片。
 *
 * 为什么不直接截预览区：
 *  - 预览区宽度随窗口变化，导出结果不可复现
 *  - 预览面板可能处于隐藏状态
 *  - 预览区底部有 45vh 留白（为滚动设计），会变成图里的大片空白
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

  const holder = document.createElement("div");
  holder.style.cssText = [
    "position:fixed",
    "left:-100000px",
    "top:0",
    `width:${width}px`,
    "max-width:none",
    "margin:0",
    // 只留左右内边距；垂直留白在最终 canvas 上补，见文件头约束 2
    `padding:0 ${EXPORT_PADDING}px`,
    `background:${background}`,
    "contain:none",
    "z-index:-1",
    "pointer-events:none",
  ].join(";");

  holder.className = "preview markdown-body";
  holder.innerHTML = html;
  document.body.appendChild(holder);

  try {
    await renderMermaidIn(holder, theme);
  } catch {
    // 图表渲染失败不该阻断导出，保留占位块即可
  }

  return holder;
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
