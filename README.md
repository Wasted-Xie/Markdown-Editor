# Markdown 编辑器

基于 **Tauri v2 + React 19 + TypeScript** 的本地 Markdown 编辑器：左侧写源码，右侧实时渲染，直接读写本地文件夹并自动保存。

## 功能

| 能力 | 实现方式 |
| --- | --- |
| 实时渲染 | markdown-it 渲染 + 140ms 防抖，输入即更新预览 |
| GFM 语法 | 表格、任务列表、删除线、自动链接（markdown-it 内置 + task-lists 插件） |
| 代码高亮 | highlight.js（内置常用语言），明暗双主题 |
| 数学公式 | KaTeX，支持 `$...$` 与 `$$...$$` |
| 图表 | Mermaid 12，懒加载，按主题切换配色 |
| 多文件管理 | 打开单个文件或整个文件夹，目录树懒加载子目录，**支持右键菜单** |
| 文件树实时同步 | **0.5 秒**轮询，外部增删文件立即反映；刷新时保留展开状态 |
| 文件操作 | 新建文件 / 文件夹、重命名、删除、复制、剪切、粘贴（与系统剪贴板互通） |
| 保存行为 | 不自动保存；`Ctrl+S` 手动保存，切换文件与关闭窗口前询问 |
| 外部修改检测 | 每 3 秒轮询 mtime/size；无本地改动时自动重载，有冲突时询问；文件被移走只在**首次**提示一次 |
| 目录大纲 | 解析标题生成大纲，点击跳转（源码定位 + 预览滚动） |
| 滚动同步 | 编辑器与预览按滚动比例双向联动，可开关 |
| 布局 | 文件面板与预览均可独立收起，收起后编辑区自动铺满（面板开关状态记忆在 localStorage） |
| 导出 HTML | 自包含单文件（内联全部 CSS，公式字体转 base64） |
| 导出图片 | 整篇渲染成一张 PNG 长图，超长文档自动分片渲染后拼接 |
| 导出 PDF | 系统打印对话框 → Microsoft Print to PDF |
| 安全 | DOMPurify 清洗 HTML，脚本/iframe 等标签与事件属性一律移除 |

## 导出长图

「导出图片」把整篇文档渲染成**一张** PNG，长文档不会被切断。

实现要点（`src/exportImage.ts`）：

- **不截预览区**，而是新建固定宽度（900px）的离屏容器重新渲染，
  因此导出宽度可复现，且预览面板收起时也能导出。
- **超长文档自动分片**：canvas 有硬限制（`html-to-image` 内部单边 16384px，
  浏览器约 32767px、总面积约 2.68 亿像素）。超限时按片渲染再逐片画进
  最终 canvas，输出仍是一张完整长图。
- **分片边界避让块级元素**，尽量不把一行文字或图表拦腰截断。
- **倍率自适应**：默认 2 倍；内容过长时自动下调（下限 0.5 倍），
  低于下限则明确报错并建议改用「导出 HTML」。

> ⚠️ **「不分页的超长 PDF」做不到**，这不是实现难度问题：
> PDF 规范限定单页最大 14400 单位（200 英寸），突破需要 PDF 1.6+ 的
> `UserUnit`，而 WebView2 的 `PrintToPdf` 无法控制该字段；
> jsPDF 也在源码里硬钳制到 14400。因此 PDF 导出保持系统打印对话框方案。

> 实现时踩过的两个坑（都在代码注释里记着，改动时别回退）：
> 1. 离屏容器用了 `position:fixed; left:-100000px`，而 `html-to-image`
>    是 `cloneNode()` 后序列化进 SVG，克隆体**保留行内样式**，
>    不重置定位就会导出一张纯背景色的空白图。
> 2. 分片必须用 `transform: translateY()`，不能用负 margin；
>    且容器不能留垂直 padding（会被 `height` 压掉导致每片错位累积）。

## 保存行为

编辑器**不会自动写盘**，与 VS Code / Typora 的默认行为一致：

1. 编辑后标题栏出现橙色圆点与「未保存 · Ctrl+S」提示
2. `Ctrl+S` 或工具栏「保存」写回磁盘
3. **切换文件**前若有未保存改动，弹窗询问「保存 / 放弃」；选择放弃会中止切换
4. **关闭窗口**前若有未保存改动，弹窗询问「保存后退出 / 不保存退出」

写盘前还会比对文件的 mtime 与大小，若磁盘上的版本已被其它程序改动，
会再确认一次「是否用编辑器内容覆盖」，绝不静默覆盖别人的修改。

## 环境要求

- **Node.js** ≥ 20.19（本项目在 v24.20 上开发）
- **Rust** ≥ 1.77.2（通过 rustup 安装）
- **MSVC 工具链**：Visual Studio 生成工具（含 Windows SDK）
- **WebView2 Runtime**：Windows 10/11 通常已预装

## 安装步骤

### 1. 安装系统工具链（一次性）

```powershell
# MSVC 编译器 + Windows SDK（约 3-6 GB，耗时较长）
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# Rust（装完后重开终端，让 PATH 生效）
winget install --id Rustlang.Rustup -e
rustup default stable-msvc
```

国内网络建议配置 crates.io 镜像（可选）：

```powershell
# 写入 %USERPROFILE%\.cargo\config.toml
@"
[source.crates-io]
replace-with = 'rsproxy-sparse'

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
"@ | Out-File -Encoding utf8 $env:USERPROFILE\.cargo\config.toml
```

### 2. 安装前端依赖

```powershell
npm install
```

### 3. 开发运行

```powershell
npm run app:dev
```

首次运行需要编译全部 Rust 依赖，约 3-10 分钟；之后的增量编译只需数秒。

> 修改 `src-tauri/**` 下的 Rust 文件后，`tauri dev` 会自动重编译并重启应用。
> 若只改了前端代码，Vite 会热更新，无需重启。

### 4. 打包安装包

```powershell
npm run app:build
```

产物在 `src-tauri/target/release/bundle/` 下（MSI 与 NSIS 安装包）。

> 首次打包前若要自定义图标，执行 `npm run tauri icon src-tauri/icons/icon.png`
> 可重新生成全平台图标（含 macOS 需要的 `.icns`）。

## 文件面板右键菜单

在文件树的任意文件 / 文件夹上点击右键：

| 菜单项 | 说明 |
| --- | --- |
| 打开 | 在编辑器中打开（文件夹不可用） |
| 在资源管理器中显示 | 文件会打开所在目录并选中；文件夹直接打开 |
| 新建 Markdown 文件 | 在选中目录内创建并立即打开 |
| 新建文件夹 | 在选中目录内创建 |
| 粘贴 | 粘贴系统剪贴板中的文件（同名时自动追加 `-1`、`-2`） |
| 重命名 | 只输入主名时保留原扩展名 |
| 删除 | 二次确认；文件夹递归删除；删除当前编辑的文件前会提示未保存内容 |
| 复制 / 剪切 | 写入**系统剪贴板**，因此也可以直接粘到资源管理器里 |

在文件树**空白处**右键，会弹出**同一套**菜单（只改可用性）：
目标目录按「选中的文件夹 → 选中文件所在目录 → 工作区根目录」逐级回退，
因此空白处也能新建 / 粘贴到根目录。「刷新」会立即重读目录（通常不必手动点，
平时靠 2.5 秒的轮询自动同步）。

> 展开状态与子目录缓存都存放在 `FileTree` 组件层，而不是各自节点内部：
> 这样定时同步只替换数据，不会把用户展开的目录重新收起来。

### 文件树如何做到 0.5 秒同步

高频轮询不能每次都把目录内容（含全部路径字符串）序列化一遍，所以分两层：

1. **每 0.5 秒**调用 `list_dirs_info`，它只对「根目录 + 所有已展开目录」各做一次
   `stat`，不读取目录内容，返回 `modified_ms` / `size` 作为版本号
2. 版本号**变化时**才调用 `list_dir` 拉完整列表，并用子项签名比对决定是否更新 state

这样空闲时每 0.5 秒只付出一次轻量 stat 的代价。方案依赖两个已实测的行为
（`cargo test --lib` 覆盖）：

- 目录的**直接子项**增删会更新目录 mtime → 能感知新增/删除
- 只修改文件**内容**不会更新目录 mtime → 不会因为编辑文件而反复重读目录

平台差异：Windows 下目录的 `len()` 恒为 0，所以版本号实际由 `modified_ms` 决定；
`size` 字段保留给其它平台。

### 「文件已不存在」只提示一次

外部修改轮询每 3 秒跑一次，文件不存在时会弹原生提示框。
这里有个容易写错的地方：**不能靠把 `lastMeta` 置空来防重复提示** ——
「文件不存在」这个分支根本不读 `lastMeta`，置空之后下一轮会再次进入该分支，
于是每 3 秒弹一次窗，用户看到的现象是「每次刷新文件夹都弹一次」。

正确做法是用一个独立的状态 `missingNotifiedPath` 记住「已经就哪个路径提示过」：

- 同一路径只提示一次，不再重复
- 该路径的文件重新出现时（撤销删除、另存为回原路径）清除记录，允许再次提示
- 切换当前文件时复位（放在依赖 `currentPath` 的 effect 里，
  这样打开 / 重命名 / 删除 / 换工作区都能覆盖，不必在每个调用点各写一遍）

> 回归验证方式：用无头浏览器加载**真实 App**、只把 Tauri IPC 换成内存实现，
> 统计原生提示框的调用次数。移走文件后观察 11 秒（覆盖 3 轮以上轮询）：
> 修复前 **4 次**（每轮一次），修复后 **1 次**；
> 再切换到另一个同样缺失的文件，仍会正确提示一次（证明没有把功能一并禁掉）。

实现说明：菜单是自绘的（`src/components/ContextMenu.tsx`），不用系统原生
Shell 菜单 —— 跨平台一致、可控性高。剪贴板通过 PowerShell 调用 .NET 的
`System.Windows.Forms.Clipboard` 实现真正的 `CF_HDROP` 文件列表，
并设置 `Preferred DropEffect` 以区分复制与剪切，因此与资源管理器双向互通。

> **「复制还是剪切」只由剪贴板决定，前端不记忆这个状态。**
> 剪贴板是全局共享的，用户随时可能在资源管理器里重新复制一批文件；
> 前端若用 ref 记住「上次点的是剪切」，那个状态在剪贴板被外部改写后就是错的，
> 表现为「明明点了复制，粘贴却把原文件移走了」。
> 因此 `paste_entries` 不接受 `cut` 参数，而是从剪贴板读 `Preferred DropEffect`
> （Linux 读 `x-special/gnome-copied-files`），
> 判定收敛在 `effect_is_cut` 一处：**只有「含 MOVE 且不含 COPY」才算剪切**，
> 其余一律按复制处理 —— 复制最多多留一份文件，误判成剪切却会真的删掉用户的文件。
> 读取时一次拿到「意图 + 路径」，避免两次读取之间被外部改写。

> **写 `Preferred DropEffect` 只能用 `MemoryStream`，绝不能用 `[byte[]]`。**
> 这是「复制变剪切」最隐蔽的一层，两个坑叠在一起：
>
> 1. `DataObject.SetData(string, byte[])` 不会存成 4 字节 DWORD，
>    而是用 `BinaryFormatter` 把字节数组包成 NRBF blob
>    （实测 `GlobalSize=48`，开头是 `96-A7-9E-FD-13-3B-70-43` 这种类型头）。
> 2. 资源管理器按**裸 DWORD** 解释这段内存，取前 4 字节 `0xFD9EA796`：
>    bit0(COPY)=0、bit1(MOVE)=1 —— 恰好满足「含 MOVE 且不含 COPY」，
>    于是「复制」被当成「剪切」，粘贴到别处会把原文件移走。
>
> 之所以极难发现：**只用 .NET 的 `GetData` 读回是测不出来的** ——
> 它能正确反序列化自己写的 blob，读写自洽、看起来完全正常，
> 只有跨进程（资源管理器）才暴露。因此回归测试
> `clipboard_dropeffect_is_raw_dword` 绕过 .NET，
> 用 Win32 `GetClipboardData` + `GlobalLock` 直接断言 HGLOBAL 是 4 字节。
>
> 对称地，读取端也要认 `MemoryStream`：裸 DWORD 经 .NET 读回就是
> `MemoryStream`，而资源管理器写的正是这种形式。

> PowerShell 调用有三个坑，都在 `commands.rs` 里绕过了：
> 1. 脚本用 `-EncodedCommand`（UTF-16LE 的 Base64）传入，不能用 `-Command`
>    —— 后者在解析参数时会吃掉双引号，`` -split "`n" `` 会变成语法错误。
> 2. 脚本里不能写 `$data.SetData(...)`，PowerShell 会把它当成变量插值
>    `$data.SetData`（未定义）后剩个 `.SetData(...)` 报 CommandNotFound。
> 3. **不要把数据经 stdin 传给 PowerShell**：它读取被重定向的 stdin 时按系统
>    ANSI 代码页（简中为 GBK）解码，而我们写的是 UTF-8，中文路径会被解成乱码，
>    表现为「复制成功但粘贴提示剪贴板内容已失效」。文件路径统一用
>    Base64(UTF-16LE) 嵌进脚本，Base64 是纯 ASCII，任何环节都不会被转换破坏。
>
> 这几条都有测试覆盖：`cargo test --lib -- --include-ignored`
> 会真实执行 PowerShell 与剪贴板往返，其中
> `clipboard_roundtrip_non_ascii_path`、`paste_moves_non_ascii_file`
> 专门用「中文目录 + 中文文件名 + 空格」验证端到端不变形。

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl + O` | 打开单个 Markdown 文件 |
| `Ctrl + Shift + O` | 打开文件夹 |
| `Ctrl + S` | 保存当前文件 |
| `Ctrl + Shift + N` | 新建 Markdown 文件 |
| `Ctrl + Shift + E` | 导出 HTML |
| `Ctrl + Shift + I` | 导出图片（整篇长图 PNG） |
| `F5` | 显示 / 隐藏预览（隐藏后编辑区自动铺满，大纲保留） |
| `Ctrl + \` | 显示 / 收起文件面板（只改单个文件时可收起，减少干扰） |
| `F11` | 导出 PDF（打开系统打印对话框） |
| `Ctrl + B` / `Ctrl + I` | 粗体 / 斜体（可反格式化） |
| `Ctrl + K` | 插入链接 |
| `Ctrl + E` / `Ctrl + D` | 行内代码 / 删除线 |
| `Ctrl + =` / `Ctrl + -` / `Ctrl + 0` | 字号增大 / 减小 / 重置 |
| `Ctrl + F` | 编辑器内搜索 |
| `Ctrl + Z` / `Ctrl + Y` | 撤销 / 重做 |
| `Tab` / `Shift + Tab` | 缩进 / 反缩进 |

> 说明：`Ctrl + P` 在编辑器内被 CodeMirror 绑定为「移到上一行」，因此预览切换使用 `F5`。

## 项目结构

```
├─ index.html                 入口页面
├─ vite.config.ts             Vite 配置（固定 1420 端口）
├─ src/
│  ├─ main.tsx                挂载 React、切换高亮主题
│  ├─ App.tsx                 状态编排、文件操作、快捷键、导出
│  ├─ renderer.ts             Markdown 渲染管线（含 DOMPurify 白名单）
│  ├─ outline.ts              大纲提取与字数统计
│  ├─ fs.ts                   Tauri 命令封装与路径工具
│  ├─ styles.css              全部样式与主题变量
│  └─ components/
│     ├─ Editor.tsx           CodeMirror 6 编辑器
│     ├─ Preview.tsx          预览区（含 Mermaid 异步渲染）
│     ├─ FileTree.tsx         文件树
│     └─ OutlinePanel.tsx     大纲面板
├─ src-tauri/
│  ├─ tauri.conf.json         窗口与打包配置
│  ├─ capabilities/           权限声明（dialog 插件）
│  └─ src/
│     ├─ lib.rs               Tauri 装配
│     └─ commands.rs          文件读写命令（含工作区越界校验）
└─ sample/                    示例文档（功能演示 + 图表测试）
```

## 安全设计

1. **写操作限制在工作区内**：打开文件或文件夹时前端会调用 `set_workspace_root`
   把根目录告知后端，`write_file` 校验目标路径是否位于该目录内，越界写入直接报错
   （不使用 `tauri-plugin-fs`，避免动态 scope 带来的不可预测行为）。
2. **渲染结果强制清洗**：所有 HTML 经 DOMPurify 处理后才写入 DOM，
   保留 KaTeX/MathML 与 SVG，移除 `script` / `iframe` / `form` 等标签与全部事件属性。
   为保证金公式与图表排版，`class` 与 `style` 属性予以保留——
   这意味着文档内的 HTML 可以影响局部样式，但无法执行脚本。
3. **不静默覆盖**：写盘前比对 mtime 与文件大小，磁盘文件被外部改动时先确认再写入。

## 窗口关闭流程

Tauri 在用户点击窗口关闭按钮时会自动广播**内建事件** `tauri://close-requested`：

1. 前端通过 `getCurrentWindow().onCloseRequested()` 监听该事件
2. 回调里先调用 `event.preventDefault()` 拦下关闭（避免异步询问期间窗口直接消失）
3. 无未保存改动 → 直接关闭；有改动 → 弹窗询问
4. 确认后调用 `close_window` 命令，内部用 `Window::destroy()` 强制销毁窗口
   （`destroy` 不会再次触发关闭请求，因此不会被第 2 步的拦截挡住）

> 注意两点：
> 1. 不要在 Rust 侧用 `on_window_event` + `api.prevent_close()` 处理这个流程。
>    那样会抢在内建事件广播之前无条件吃掉关闭请求，前端根本收不到通知。
> 2. 不要用 `window.confirm` 做确认。`onCloseRequested` 会 `await` 回调，
>    而在 WebView2 的关闭请求处理期间 `window.confirm` 不可靠 ——
>    实测会出现「既不弹出又返回真值」的情况，导致未询问就写盘退出。
>    确认框统一走 `@tauri-apps/plugin-dialog` 的 `ask`（Rust 侧原生对话框）。

## 已知限制

- **PDF 导出依赖系统打印**：使用 WebView2 的打印对话框，需要在对话框中选择
  「Microsoft Print to PDF」。这种方式会带上 URL/页码等默认页眉页脚，
  且分页由浏览器引擎决定。若需要精确分页，后续可换成基于 Rust 的 PDF 生成方案。
- **超大文件性能**：数万行以上的文档，实时渲染会占用较多 CPU；
  当前未做渲染 worker 与虚拟滚动。
- **Mermaid 渲染是异步的**：图表更新比正文晚约 100-200ms，
  渲染期间滚动同步会暂停以避免位置跳动。
- **非 UTF-8 文件**：读取时做容错解码（GBK 等会得到乱码但不会丢内容），
  写入统一使用 UTF-8。
- **拖动文件打开**：依赖 Tauri 的原生拖放事件，在开发模式下可能看不到系统光标反馈。

## 示例文档

`sample/` 下有两个文件可用于验收：

- `sample/功能演示.md`：覆盖全部语法（GFM、代码、公式、图表、长文档滚动）
- `sample/图表测试.md`：集中测试 Mermaid 各类图表，含一个故意的语法错误用例
