import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// highlight.js 的明暗主题：两份都加载，运行时通过 disabled 切换，避免异步闪烁
import "highlight.js/styles/github.css";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import "./styles.css";

type Theme = "light" | "dark";

/** 给 highlight.js 的样式表打上明暗标记，导出时用于排除非当前主题 */
function tagHighlightSheets(): void {
  const links = Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  );
  for (const link of links) {
    const href = link.getAttribute("href") ?? "";
    if (!/highlight\.js/i.test(href)) continue;
    link.dataset.hljsTheme = /github-dark/i.test(href) ? "dark" : "light";
  }
}

/** 只启用与当前主题匹配的高亮样式表 */
function syncHighlightTheme(theme: Theme): void {
  tagHighlightSheets();
  const links = Array.from(
    document.querySelectorAll<HTMLLinkElement>("link[data-hljs-theme]"),
  );
  for (const link of links) {
    link.disabled = link.dataset.hljsTheme !== theme;
  }
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root 挂载点");

// 阻止把文件拖进窗口时浏览器默认的「打开文件」行为，统一交给 Tauri 的拖放钩子处理
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 主题由 App 写入 <html data-theme>，这里跟随切换高亮样式表
new MutationObserver(() => syncHighlightTheme(currentTheme())).observe(
  document.documentElement,
  { attributes: true, attributeFilter: ["data-theme"] },
);

syncHighlightTheme(currentTheme());
