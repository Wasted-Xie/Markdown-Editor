import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发时由 Rust 侧拉起这个 dev server，端口必须固定
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],

  // 让 Vite 不要清屏，便于同时看 Rust 和前端日志
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // 这些路径不参与前端构建，却会被监听器扫到。
      // Windows 上文件替换存在瞬时锁，扫到就抛 EBUSY 让 dev server 直接退出。
      // 编辑器的原子保存会在目标文件旁生成 `.<name>.<pid>.<uuid>.tmpdir/`，
      // 必须一并忽略，否则改一次源码就崩一次。
      ignored: [
        "**/src-tauri/**",
        "**/.git/**",
        "**/.temp/**",
        "**/.backup/**",
        "**/node_modules/**",
        "**/*.tmpdir/**",
        "**/.*.tmpdir/**",
        "**/*.tmp",
      ],
    },
  },

  // Tauri 使用的环境变量前缀
  envPrefix: ["VITE_", "TAURI_ENV_*"],

  build: {
    // Windows 上用 WebView2(Chromium)，可以直接用较新的语法
    target: "chrome110",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // 用函数式分包：highlight.js 的完整语言包接近 1MB，
        // 对象式 manualChunks 在这种「默认导入 + 内部子模块」场景下不可靠。
        manualChunks(id: string) {
          const path = id.replace(/\\/g, "/");
          if (path.includes("/node_modules/highlight.js/")) return "highlight";
          if (path.includes("/node_modules/mermaid/")) return "mermaid";
          if (path.includes("/node_modules/katex/")) return "katex";
          return undefined;
        },
      },
    },
  },
});
