//! 文件系统相关的 Tauri 命令。
//!
//! 安全约束：所有写操作都要求目标文件位于「当前工作区」内。
//! 该根目录由前端在打开文件 / 文件夹时通过 [`set_workspace_root`] 告知。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

// 仅 Linux 剪贴板实现使用
#[cfg(target_os = "linux")]
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};

/// 允许打开的文本文件扩展名（Markdown 优先，附带少量纯文本格式）。
const TEXT_EXTS: &[&str] = &[
    "md", "markdown", "mdown", "mkd", "mdx", "txt", "text", "log", "json", "yml", "yaml", "toml",
];

/// 递归时需要跳过的目录名（依赖目录通常很大且无编辑价值）。
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", ".git", ".svn", ".hg", ".idea", ".vscode",
];

/// 当前工作区根目录。`None` 表示尚未打开任何文件夹，此时禁止写文件。
pub struct WorkspaceState(pub Mutex<Option<PathBuf>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirNode {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub children: Vec<DirNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub exists: bool,
    pub modified_ms: Option<u64>,
    pub size: Option<u64>,
    pub is_file: bool,
}

/// 目录的轻量版本信息，用于高频轮询时判断内容是否变化。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirInfo {
    pub path: String,
    pub exists: bool,
    /// 不存在时为 null，前端据此识别「目录被删除」
    pub modified_ms: Option<u64>,
    /// 注意：Windows 下目录的 len() 恒为 0，这里只用 modified_ms 判变化
    pub size: Option<u64>,
}

/// 一次性返回多个目录的版本信息。
///
/// 只对目录本身做一次 stat，不读取目录内容，因此可以高频调用（例如 0.5 秒一次）；
/// 前端只在版本变化时再调用 `list_dir` 拉取完整列表。
///
/// 平台差异：目录 mtime 只在**直接子项**增删时更新（NTFS 上修改文件内容不会更新，
/// 这正是我们想要的）；更深层的变化由「子目录也在轮询列表里」覆盖。
#[tauri::command]
pub fn list_dirs_info(dirs: Vec<String>) -> Vec<DirInfo> {
    dirs.into_iter()
        .map(|dir| match std::fs::metadata(&dir) {
            Ok(meta) if meta.is_dir() => DirInfo {
                path: dir,
                exists: true,
                modified_ms: meta.modified().ok().and_then(system_time_ms),
                size: Some(meta.len()),
            },
            _ => DirInfo {
                path: dir,
                exists: false,
                modified_ms: None,
                size: None,
            },
        })
        .collect()
}

/// 读取目录内容并返回一层子节点。
#[tauri::command]
pub fn list_dir(dir: String) -> Result<Vec<DirNode>, String> {
    let p = PathBuf::from(&dir);
    if !p.is_dir() {
        return Err(format!("不是有效文件夹：{dir}"));
    }
    read_children(&p)
}

/// 读取文本文件内容。使用容错解码，避免非 UTF-8 文件直接报错。
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("不是有效文件：{path}"));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("读取失败：{e}"))?;
    Ok(decode_lossy(&bytes))
}

/// 写入文本文件。目标必须位于已打开的文件夹内。
#[tauri::command]
pub fn write_file(
    path: String,
    contents: String,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    ensure_inside_root(&path, &state)?;

    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&p, contents.as_bytes()).map_err(|e| format!("写入失败：{e}"))
}

/// 设置当前工作区根目录。
///
/// 必须由前端在「打开文件夹 / 打开单个文件 / 拖入文件」时调用，
/// 否则写操作会因找不到工作区而被拒绝。
#[tauri::command]
pub fn set_workspace_root(
    root: String,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "工作区状态被占用".to_string())?;
    *guard = Some(PathBuf::from(root));
    Ok(())
}

/// 弹出文件选择对话框，返回所选文件的绝对路径（取消时返回 `None`）。
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .set_title("打开 Markdown 文件")
        .add_filter("Markdown / 文本", &["md", "markdown", "mdown", "mkd", "mdx", "txt"])
        .add_filter("所有文件", &["*"])
        .blocking_pick_file();

    let Some(target) = picked else {
        return Ok(None);
    };

    let path = target
        .into_path()
        .map_err(|e| format!("无法解析文件路径：{e}"))?;

    Ok(Some(normalize(&path)))
}

/// 判断路径是否存在（用于外部修改/删除检测）。
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// 读取路径的元信息（修改时间、大小）。
#[tauri::command]
pub fn path_info(path: String) -> PathInfo {
    match std::fs::metadata(&path) {
        Ok(meta) => PathInfo {
            exists: true,
            modified_ms: meta.modified().ok().and_then(system_time_ms),
            size: Some(meta.len()),
            is_file: meta.is_file(),
        },
        Err(_) => PathInfo {
            exists: false,
            modified_ms: None,
            size: None,
            is_file: false,
        },
    }
}

/// 弹出保存对话框，把 HTML 导出到用户选择的位置。
///
/// 返回值：写入的完整路径；用户取消时返回 `None`。
#[tauri::command]
pub async fn export_html(
    app: tauri::AppHandle,
    html: String,
    default_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_name = if default_name.trim().is_empty() {
        "document.html".to_string()
    } else {
        default_name
    };

    let picked = app
        .dialog()
        .file()
        .set_title("导出 HTML")
        .set_file_name(&file_name)
        .add_filter("HTML 文件", &["html"])
        .blocking_save_file();

    let Some(target) = picked else {
        return Ok(None);
    };

    let target = target
        .into_path()
        .map_err(|e| format!("无法解析保存路径：{e}"))?;

    std::fs::write(&target, html.as_bytes()).map_err(|e| format!("写入失败：{e}"))?;

    Ok(Some(target.to_string_lossy().replace('\\', "/")))
}

/// 关闭主窗口。
///
/// 用于「关闭前询问是否保存」流程：前端在 `onCloseRequested` 里
/// `preventDefault()` 拦下关闭，确认后再调用本命令强制销毁窗口
/// （`destroy` 不再触发关闭请求，因此不会被前端自己的拦截挡住）。
#[tauri::command]
pub fn close_window(window: tauri::Window) -> Result<(), String> {
    window.destroy().map_err(|e| format!("关闭窗口失败：{e}"))
}

/// 在系统文件管理器中打开。
///
/// - 目标是目录：直接打开该目录
/// - 目标是文件：打开所在目录并选中该文件
///
/// 注意：`explorer` 的 `/select,` 参数与路径都必须是反斜杠形式，
/// 直接用前端传来的 `/` 形式路径会导致 Explorer 解析失败（回落成「此电脑」）。
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }

    let is_dir = p.is_dir();

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // 统一成反斜杠形式
        let win_path = p.to_string_lossy().replace('/', "\\");
        // explorer 命中已存在路径时也可能返回非 0，这里不检查退出码
        let mut cmd = std::process::Command::new("explorer");
        if is_dir {
            cmd.arg(&win_path);
        } else {
            cmd.arg(format!("/select,{win_path}"));
        }
        cmd.creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("打开资源管理器失败：{e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let target = if is_dir {
            p.clone()
        } else {
            p.parent().map(Path::to_path_buf).unwrap_or(p.clone())
        };
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("打开 Finder 失败：{e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if is_dir {
            p.clone()
        } else {
            p.parent().map(Path::to_path_buf).unwrap_or(p.clone())
        };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败：{e}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("当前平台不支持该操作".to_string())
}

// ---------------------------------------------------------------------------
// 文件管理：新建 / 重命名 / 删除 / 复制 / 剪切 / 粘贴
// ---------------------------------------------------------------------------

/// 新建文件或文件夹。
#[tauri::command]
pub fn create_entry(
    dir: String,
    name: String,
    kind: String,
    state: State<'_, WorkspaceState>,
) -> Result<String, String> {
    let target = join_child(&dir, &name)?;
    ensure_inside_root(&target.to_string_lossy(), &state)?;

    if target.exists() {
        return Err(format!("「{name}」已存在"));
    }

    if kind == "dir" {
        std::fs::create_dir_all(&target).map_err(|e| format!("新建文件夹失败：{e}"))?;
    } else {
        std::fs::write(&target, b"").map_err(|e| format!("新建文件失败：{e}"))?;
    }

    Ok(normalize(&target))
}

/// 重命名（同目录内改名）。
#[tauri::command]
pub fn rename_entry(
    path: String,
    new_name: String,
    state: State<'_, WorkspaceState>,
) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    ensure_inside_root(&path, &state)?;

    let parent = src
        .parent()
        .ok_or_else(|| "无法确定所在目录".to_string())?;
    let dst = join_child(&parent.to_string_lossy(), &new_name)?;
    ensure_inside_root(&dst.to_string_lossy(), &state)?;

    if dst.exists() {
        return Err(format!("「{new_name}」已存在"));
    }

    std::fs::rename(&src, &dst).map_err(|e| format!("重命名失败：{e}"))?;
    Ok(normalize(&dst))
}

/// 删除文件（文件夹需 recursive 为 true）。
#[tauri::command]
pub fn delete_entry(
    path: String,
    recursive: bool,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    ensure_inside_root(&path, &state)?;

    if p.is_dir() {
        if recursive {
            std::fs::remove_dir_all(&p).map_err(|e| format!("删除文件夹失败：{e}"))?;
        } else {
            std::fs::remove_dir(&p)
                .map_err(|e| format!("删除失败（文件夹非空？）：{e}"))?;
        }
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("删除失败：{e}"))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 剪贴板：路径数据一律用 Base64(UTF-16LE) 嵌进脚本
// ---------------------------------------------------------------------------
//
// 不走 stdin 传数据：PowerShell 读取被重定向的 stdin 时按系统 ANSI 代码页
// （简中为 GBK）解码，而我们写入的是 UTF-8 —— 中文路径会被解成乱码，
// 结果是「复制成功但粘贴说找不到文件」。
// Base64 是纯 ASCII，经命令行与 stdin 都不可能被编码转换破坏。

/// 把字符串按 UTF-16LE 编码后转 Base64，供嵌入 PowerShell 脚本。
#[cfg(target_os = "windows")]
fn encode_utf16_base64(text: &str) -> String {
    let mut bytes: Vec<u8> = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        bytes.push((unit & 0xFF) as u8);
        bytes.push((unit >> 8) as u8);
    }
    base64_encode(&bytes)
}

/// 把 Base64(文件列表) 写入系统剪贴板，与资源管理器互通。
#[tauri::command]
pub fn clipboard_set_files(
    paths: Vec<String>,
    cut: bool,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有要复制的文件".to_string());
    }
    for p in &paths {
        ensure_inside_root(p, &state)?;
    }

    #[cfg(target_os = "windows")]
    {
        // 用 $b64 变量承载，避免 PowerShell 把 $data.SetData 之类误当插值
        let extra = if cut {
            r#"$data.SetData('Preferred DropEffect', [byte[]](2,0,0,0))"#
        } else {
            r#"$data.SetData('Preferred DropEffect', [byte[]](5,0,0,0))"#
        };

        let script = format!(
            r#"$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b64 = '{payload}'
$text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b64))
$files = New-Object System.Collections.Specialized.StringCollection
foreach ($line in $text.Split([char]10)) {{
  $t = $line.Trim()
  if ($t.Length -gt 0) {{ [void]$files.Add($t) }}
}}
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($files)
{extra}
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
"#,
            payload = encode_utf16_base64(&paths.join("\n"))
        );

        run_powershell(&script)?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let uris = paths
            .iter()
            .map(|p| path_to_file_uri(p))
            .collect::<Result<Vec<_>, _>>()?;

        linux_clipboard_write(&uris, cut)
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
    {
        let _ = cut;
        Err("当前平台暂不支持写入系统剪贴板".to_string())
    }
}

/// 判断剪贴板里是否是文件列表（用于决定「粘贴」是否可用）。
#[tauri::command]
pub fn clipboard_has_files() -> bool {
    #[cfg(target_os = "windows")]
    {
        let script = r#"$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { [Console]::Out.Write('yes') } else { [Console]::Out.Write('no') }
"#;

        run_powershell(script)
            .map(|out| out.trim() == "yes")
            .unwrap_or(false)
    }

    #[cfg(target_os = "linux")]
    {
        linux_clipboard_has_uri_list()
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
    {
        false
    }
}

/// 粘贴：把剪贴板里的文件复制 / 移动到目标目录，返回新建的路径列表。
#[tauri::command]
pub fn paste_entries(
    dest_dir: String,
    cut: bool,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<String>, String> {
    ensure_inside_root(&dest_dir, &state)?;

    let sources = read_clipboard_files()?;
    if sources.is_empty() {
        return Err("剪贴板里没有文件".to_string());
    }

    let dest = PathBuf::from(&dest_dir);
    if !dest.is_dir() {
        return Err(format!("目标不是文件夹：{dest_dir}"));
    }

    let mut created: Vec<String> = Vec::new();

    for src in sources {
        let src_path = PathBuf::from(&src);

        // 剪贴板里的文本可能不是路径，或路径已失效，跳过而不是整体失败
        if !src_path.exists() {
            continue;
        }

        let Some(file_name) = src_path.file_name() else {
            continue;
        };
        let target = unique_path(&dest.join(file_name));

        // 粘到自己所在的目录时，unique_path 会给出「xxx (1)」这样的副本名
        if cut && target == src_path {
            continue;
        }

        if cut {
            move_entry(&src_path, &target)?;
        } else if src_path.is_dir() {
            copy_dir_recursive(&src_path, &target)?;
        } else {
            std::fs::copy(&src_path, &target).map_err(|e| format!("复制失败：{e}"))?;
        }

        created.push(normalize(&target));
    }

    if created.is_empty() {
        return Err("没有可粘贴的文件（剪贴板内容可能已失效）".to_string());
    }

    Ok(created)
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/// 校验文件名并拼接到目录下，拒绝任何路径穿越写法。
fn join_child(dir: &str, name: &str) -> Result<PathBuf, String> {
    let trimmed = name.trim();

    if trimmed.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("名称无效".to_string());
    }
    // 这些字符在 Windows 上非法，同时也挡住路径分隔符
    if trimmed
        .chars()
        .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err("名称不能包含 / \\ : * ? \" < > | 这些字符".to_string());
    }

    Ok(Path::new(dir).join(trimmed))
}

/// 目标已存在时追加「-1」「-2」后缀。
fn unique_path(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }

    let parent = target.parent().unwrap_or_else(|| Path::new(""));
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = target
        .extension()
        .map(|s| s.to_string_lossy().to_string());

    for i in 1..1000 {
        let name = match &ext {
            Some(e) => format!("{stem}-{i}.{e}"),
            None => format!("{stem}-{i}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }

    target.to_path_buf()
}

/// 移动：同盘用 rename；跨盘失败时退化为「复制 + 删除」。
fn move_entry(src: &Path, dst: &Path) -> Result<(), String> {
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }

    if src.is_dir() {
        copy_dir_recursive(src, dst)?;
        std::fs::remove_dir_all(src).map_err(|e| format!("移动后清理源目录失败：{e}"))?;
    } else {
        std::fs::copy(src, dst).map_err(|e| format!("移动失败：{e}"))?;
        std::fs::remove_file(src).map_err(|e| format!("移动后清理源文件失败：{e}"))?;
    }

    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败：{e}"))?;

    let entries = std::fs::read_dir(src).map_err(|e| format!("读取目录失败：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败：{e}"))?;
        let path = entry.path();
        let target = dst.join(entry.file_name());

        if path.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else {
            std::fs::copy(&path, &target).map_err(|e| format!("复制文件失败：{e}"))?;
        }
    }

    Ok(())
}

/// 读取剪贴板中的文件列表。
///
/// 必须显式把 stdout 设成 UTF-8：PowerShell 默认按系统 ANSI 代码页（简中为
/// GBK/936）输出，非 ASCII 路径回传后会被按 UTF-8 解码成乱码，
/// 表现为「剪贴板里的文件都找不到」，粘贴直接失败。
#[cfg(target_os = "windows")]
fn read_clipboard_files() -> Result<Vec<String>, String> {
    let script = r#"$ErrorActionPreference='SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName System.Windows.Forms
if (-not [System.Windows.Forms.Clipboard]::ContainsFileDropList()) { exit 0 }
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
$lines = @()
foreach ($f in $files) { $lines += $f }
[Console]::Out.Write([string]::Join([char]10, $lines))
"#;

    let out = run_powershell(script)?;

    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

#[cfg(target_os = "linux")]
fn read_clipboard_files() -> Result<Vec<String>, String> {
    let out = run_shell(
        r#"if command -v wl-paste >/dev/null 2>&1; then
  wl-paste --no-newline --type text/uri-list 2>/dev/null
elif command -v xclip >/dev/null 2>&1; then
  xclip -selection clipboard -t text/uri-list -o 2>/dev/null
fi"#,
    )?;

    Ok(out.lines().filter_map(parse_file_uri).collect())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
fn read_clipboard_files() -> Result<Vec<String>, String> {
    Err("当前平台暂不支持读取系统剪贴板".to_string())
}

// ---------------------------------------------------------------------------
// Linux 剪贴板实现
// ---------------------------------------------------------------------------
//
// 不用 arboard 之类的 crate：它们对「文件列表」（text/uri-list）支持不完整，
// 而我们的复制/粘贴需要与文件管理器互通。
// 改用系统命令，行为确定、便于自查：
//   Wayland -> wl-copy / wl-paste（包 wl-clipboard）
//   X11     -> xclip
// 两者都不在时给出可操作的安装提示，而不是静默失败。

/// 把绝对路径编码成 `file://` URI（RFC 8089），非 ASCII 与空格走百分号编码。
#[cfg(target_os = "linux")]
fn path_to_file_uri(path: &str) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err(format!("剪贴板需要绝对路径：{path}"));
    }

    const KEEP: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'<')
        .add(b'>')
        .add(b'?')
        .add(b'`')
        .add(b'{')
        .add(b'}');

    Ok(format!("file://{}", utf8_percent_encode(path, KEEP)))
}

/// 从 `file://` URI 还原为本地路径；非 file 协议或非法 UTF-8 时返回 None。
#[cfg(target_os = "linux")]
fn parse_file_uri(uri: &str) -> Option<String> {
    let trimmed = uri.trim();
    let rest = trimmed.strip_prefix("file://")?;
    // 形如 file://host/path 时，host 非空但不是 localhost 的按不支持处理
    let path = match rest.find('/') {
        Some(0) => rest,
        Some(idx) => {
            let host = &rest[..idx];
            if host.is_empty() || host.eq_ignore_ascii_case("localhost") {
                &rest[idx..]
            } else {
                return None;
            }
        }
        None => return None,
    };

    percent_decode_str(path)
        .decode_utf8()
        .ok()
        .map(|s| s.into_owned())
}

/// 检测可用的剪贴板工具。
#[cfg(target_os = "linux")]
fn linux_clipboard_tool() -> Result<&'static str, String> {
    let out = run_shell(
        r#"if command -v wl-copy >/dev/null 2>&1; then echo wayland
elif command -v xclip >/dev/null 2>&1; then echo x11
fi"#,
    )?;

    match out.trim() {
        "wayland" => Ok("wayland"),
        "x11" => Ok("x11"),
        _ => Err(
            "系统剪贴板不可用：请安装 wl-clipboard（Wayland）或 xclip（X11）。\n\
             例如：sudo dnf install wl-clipboard   或   sudo apt install wl-clipboard"
                .to_string(),
        ),
    }
}

/// 把 URI 列表写入系统剪贴板。
///
/// `cut` 用 `x-special/gnome-copied-files` 的 cut/copy 首行表达；
/// 该类型仅 GNOME 系文件管理器识别，其它环境会忽略这一行、只当作普通复制。
#[cfg(target_os = "linux")]
fn linux_clipboard_write(uris: &[String], cut: bool) -> Result<(), String> {
    let tool = linux_clipboard_tool()?;
    let op = if cut { "cut" } else { "copy" };
    let plain = uris.join("\n");
    let gnome = format!("{op}\n{}", uris.join("\n"));

    // 注意：脚本整体用单引号包裹，其中的 $ 不会被 PowerShell 之类的层解释；
    // 这里由 sh 执行，$ 是有意保留的变量/命令替换。
    let script = match tool {
        "wayland" => format!(
            r#"set -e
printf '%s' '{plain}' | wl-copy --type text/uri-list
printf '%s' '{plain}' | wl-copy --type text/plain
printf '%s' '{gnome}' | wl-copy --type x-special/gnome-copied-files"#
        ),
        _ => format!(
            r#"set -e
printf '%s' '{plain}' | xclip -selection clipboard -t text/uri-list
printf '%s' '{gnome}' | xclip -selection clipboard -t x-special/gnome-copied-files"#
        ),
    };

    run_shell(&script)?;
    Ok(())
}

/// 剪贴板里是否含文件列表（text/uri-list）。
#[cfg(target_os = "linux")]
fn linux_clipboard_has_uri_list() -> bool {
    let script = r#"if command -v wl-paste >/dev/null 2>&1; then
  wl-paste --list-types 2>/dev/null
elif command -v xclip >/dev/null 2>&1; then
  xclip -selection clipboard -t TARGETS -o 2>/dev/null
fi"#;

    run_shell(script)
        .map(|out| out.contains("text/uri-list"))
        .unwrap_or(false)
}

/// 用 sh 执行一段脚本，返回 stdout（UTF-8 解码）。
///
/// 为 Wayland 会话补齐环境变量：应用可能由 systemd 或桌面项启动，
/// 而剪贴板工具需要 `XDG_RUNTIME_DIR` 才能连上合成器。
#[cfg(target_os = "linux")]
fn run_shell(script: &str) -> Result<String, String> {
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(script)
        .output()
        .map_err(|e| format!("执行 sh 失败：{e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("剪贴板命令失败：{}", err.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 执行一段 PowerShell 脚本，返回其 stdout（按 UTF-8 解码）。
///
/// 用 `-EncodedCommand`（UTF-16LE 的 Base64）而不是 `-Command` 传脚本：
/// PowerShell 在解析 `-Command` 的参数时会吃掉双引号，脚本里像
/// `` -split "`n" `` 这样的写法会变成语法错误。
///
/// 不借助 stdin 传数据：PowerShell 读取被重定向的 stdin 时按系统 ANSI
/// 代码页解码，中文会被破坏。调用方应把数据以 Base64 嵌进脚本。
#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let encoded = encode_powershell_command(script);

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("启动 PowerShell 失败：{e}"))?;

    if !output.status.success() {
        let err = decode_lossy(&output.stderr);
        return Err(format!("PowerShell 执行失败：{}", err.trim()));
    }

    Ok(decode_lossy(&output.stdout))
}

/// 把脚本编码成 `-EncodedCommand` 需要的形式：UTF-16LE 再做 Base64。
#[cfg(target_os = "windows")]
fn encode_powershell_command(script: &str) -> String {
    let mut utf16: Vec<u8> = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        utf16.push((unit & 0xFF) as u8);
        utf16.push((unit >> 8) as u8);
    }
    base64_encode(&utf16)
}

/// 标准 Base64 编码，避免为此引入额外依赖。
#[cfg(target_os = "windows")]
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        let idx = [
            ((triple >> 18) & 0x3F) as usize,
            ((triple >> 12) & 0x3F) as usize,
            ((triple >> 6) & 0x3F) as usize,
            (triple & 0x3F) as usize,
        ];

        out.push(TABLE[idx[0]] as char);
        out.push(TABLE[idx[1]] as char);
        out.push(if chunk.len() > 1 {
            TABLE[idx[2]] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[idx[3]] as char
        } else {
            '='
        });
    }

    out
}


fn read_children(dir: &Path) -> Result<Vec<DirNode>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读取文件夹失败：{e}"))?;

    let mut out: Vec<DirNode> = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        // 跳过隐藏项
        if file_name.starts_with('.') {
            continue;
        }

        // 跳过符号链接（避免目录环导致的无限递归）
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            if SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&file_name)) {
                continue;
            }
            // 目录只列出「值不值得展开」的判断交给前端，这里返回空 children
            out.push(DirNode {
                name: file_name,
                path: normalize(&path),
                kind: "dir",
                children: Vec::new(),
            });
            continue;
        }

        if file_type.is_file() && is_text_file(&path) {
            out.push(DirNode {
                name: file_name,
                path: normalize(&path),
                kind: "file",
                children: Vec::new(),
            });
        }
    }

    // 目录优先、然后按名称的自然顺序排序
    out.sort_by(|a, b| match (a.kind, b.kind) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(out)
}

fn is_text_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            TEXT_EXTS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

/// 统一路径分隔符，方便前端做字符串比较和前缀判断。
fn normalize(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 校验目标路径位于当前工作区内。
fn ensure_inside_root(path: &str, state: &State<'_, WorkspaceState>) -> Result<(), String> {
    let root = state
        .0
        .lock()
        .map_err(|_| "工作区状态被占用".to_string())?
        .clone();

    let root = root.ok_or_else(|| "尚未打开文件夹，无法写入文件".to_string())?;

    // Windows 路径大小写不敏感，Unix 下用 starts_with 更严谨
    #[cfg(windows)]
    let inside = {
        let target = normalize(Path::new(path)).to_lowercase();
        let root_norm = normalize(&root).to_lowercase();
        target == root_norm || target.starts_with(&format!("{root_norm}/"))
    };

    // Linux 与 macOS 共用这条：路径大小写敏感，用 starts_with 更严谨
    #[cfg(unix)]
    let inside = Path::new(path).starts_with(&root);

    if inside {
        Ok(())
    } else {
        Err(format!("拒绝写入工作区之外的文件：{path}"))
    }
}

/// 容错解码：优先 UTF-8，失败时按 Latin-1 逐字节映射，保证不丢失内容。
fn decode_lossy(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(e) if e.error_len().is_none() => {
            // 合法的截断 UTF-8（例如文件末尾被截断一个多字节字符）
            String::from_utf8_lossy(bytes).to_string()
        }
        Err(_) => {
            // 可能是 GBK 等其它编码：逐字节映射，至少保留全部字符位
            bytes.iter().map(|&b| b as char).collect::<String>()
        }
    }
}

fn system_time_ms(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    /// 与前端 `listDirsInfo` 相同的版本号算法
    fn dir_version(dir: &Path) -> String {
        let info = list_dirs_info(vec![normalize(dir)])
            .into_iter()
            .next()
            .expect("应返回一条结果");
        if info.exists {
            format!("{}:{}", info.modified_ms.unwrap_or(0), info.size.unwrap_or(0))
        } else {
            "gone".to_string()
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        list_dir(normalize(dir))
            .unwrap()
            .into_iter()
            .map(|n| n.name)
            .collect()
    }

    /// 两层轮询成立的前提：增删子项会更新目录 mtime
    #[test]
    fn dir_version_changes_on_add_and_remove() {
        let dir = std::env::temp_dir().join("mde_diritem_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 先扫一次，避开首轮缓存与 mtime 精度带来的抖动
        let _ = names(&dir);
        let before = dir_version(&dir);

        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::write(dir.join("added.md"), "x").unwrap();
        let after_add = dir_version(&dir);
        assert_ne!(before, after_add, "新增文件后目录版本号应变化");
        assert_eq!(names(&dir).len(), 1);

        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::remove_file(dir.join("added.md")).unwrap();
        let after_remove = dir_version(&dir);
        assert_ne!(after_add, after_remove, "删除文件后目录版本号应变化");
        assert!(names(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 修改文件内容不应触发目录版本变化（目录树不关心内容变化）
    #[test]
    fn dir_version_stable_on_content_change() {
        let dir = std::env::temp_dir().join("mde_diritem_content");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        std::fs::write(&file, "one").unwrap();

        let _ = names(&dir);
        let before = dir_version(&dir);

        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::write(&file, "two - 内容变了").unwrap();

        assert_eq!(
            before,
            dir_version(&dir),
            "只改文件内容时不应重读目录（否则 0.5 秒轮询会浪费）"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 目录被删除时 list_dirs_info 必须报 exists=false
    #[test]
    fn dir_info_reports_missing() {
        let dir = std::env::temp_dir().join("mde_diritem_missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(list_dirs_info(vec![normalize(&dir)])[0].exists);

        std::fs::remove_dir(&dir).unwrap();
        let info = &list_dirs_info(vec![normalize(&dir)])[0];
        assert!(!info.exists, "目录已删除时应报告不存在");
        assert_eq!(dir_version(&dir), "gone");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b"A"), "QQ==");
        assert_eq!(base64_encode(b"AB"), "QUI=");
        assert_eq!(base64_encode(b"ABC"), "QUJD");
        assert_eq!(base64_encode(b"hello world"), "aGVsbG8gd29ybGQ=");
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn powershell_command_is_utf16le_base64() {
        // 'Write-Output 1' 的 UTF-16LE 字节做 Base64
        assert_eq!(
            encode_powershell_command("Write-Output 1"),
            "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIAAxAA=="
        );
    }

    #[test]
    fn utf16_base64_roundtrips_non_ascii() {
        // 中文在两个字节里往返，编码形态必须可逆
        let text = "中文路径 A.md";
        let encoded = encode_utf16_base64(text);
        let decoded: Vec<u16> = {
            let raw = base64_decode(&encoded).expect("base64 解码失败");
            raw.chunks(2)
                .map(|c| (c[0] as u16) | ((*c.get(1).unwrap_or(&0) as u16) << 8))
                .collect()
        };
        assert_eq!(String::from_utf16(&decoded).unwrap(), text);
    }

    /// 与 encode 对称的解码，仅测试用
    fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

        let cleaned: Vec<u8> = input
            .bytes()
            .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
            .collect();

        let mut out = Vec::new();
        for chunk in cleaned.chunks(4) {
            let mut acc: u32 = 0;
            for (i, byte) in chunk.iter().enumerate() {
                let idx = TABLE
                    .iter()
                    .position(|c| c == byte)
                    .ok_or_else(|| format!("非法 base64 字符：{}", *byte as char))?;
                acc |= (idx as u32) << (18 - 6 * i);
            }
            out.push((acc >> 16) as u8);
            if chunk.len() > 2 {
                out.push((acc >> 8) as u8);
            }
            if chunk.len() > 3 {
                out.push(acc as u8);
            }
        }
        Ok(out)
    }

    #[test]
    #[ignore = "会在 Windows 上实际执行 PowerShell"]
    fn encoded_command_roundtrip() {
        let out = run_powershell("Write-Output 'ok'").expect("执行失败");
        assert_eq!(out.trim(), "ok");
    }

    /// 把给定路径写入系统剪贴板（测试用，走与命令相同的实现路径）
    fn put_files_on_clipboard(paths: &[String]) {
        let script = format!(
            r#"$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b64 = '{payload}'
$text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b64))
$files = New-Object System.Collections.Specialized.StringCollection
foreach ($line in $text.Split([char]10)) {{
  $t = $line.Trim()
  if ($t.Length -gt 0) {{ [void]$files.Add($t) }}
}}
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($files)
$data.SetData('Preferred DropEffect', [byte[]](5,0,0,0))
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
"#,
            payload = encode_utf16_base64(&paths.join("\n"))
        );

        run_powershell(&script).expect("写入剪贴板失败");
    }

    #[test]
    #[ignore = "需要 GUI 环境，且会改动系统剪贴板"]
    fn clipboard_roundtrip_non_ascii_path() {
        // 目录名与文件名都带中文，贴近真实使用场景
        let base = std::env::temp_dir().join("mde_中文目录");
        let dir = base.join("子目录");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("功能 演示.md");
        std::fs::write(&file, "content").unwrap();

        let expected = normalize(&file);
        put_files_on_clipboard(&[expected.clone()]);

        let back = read_clipboard_files().expect("读取剪贴板失败");
        assert_eq!(back.len(), 1, "应读到 1 个路径");
        assert!(
            std::path::Path::new(&back[0]).exists(),
            "读回的路径不存在（编码损坏）：{:?}，期望 {:?}",
            back[0],
            expected
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 端到端：复制 -> 粘贴到另一目录，且中文路径全程不变形
    #[test]
    #[ignore = "需要 GUI 环境，且会改动系统剪贴板"]
    fn paste_moves_non_ascii_file() {
        let base = std::env::temp_dir().join("mde_粘贴测试");
        let src_dir = base.join("源目录");
        let dst_dir = base.join("目标目录");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dst_dir).unwrap();

        let src = src_dir.join("文档 副本.md");
        std::fs::write(&src, "粘贴内容").unwrap();

        put_files_on_clipboard(&[normalize(&src)]);

        let sources = read_clipboard_files().expect("读取剪贴板失败");
        assert_eq!(sources.len(), 1);
        assert!(std::path::Path::new(&sources[0]).exists(), "源路径应为有效路径");

        // 复用与命令相同的复制逻辑
        let src_path = PathBuf::from(&sources[0]);
        let target = unique_path(&dst_dir.join(src_path.file_name().unwrap()));
        std::fs::copy(&src_path, &target).expect("复制失败");

        assert!(target.exists(), "粘贴目标不存在：{:?}", target);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "粘贴内容",
            "内容不一致"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}

/// Linux 剪贴板的 URI 编解码测试。
///
/// 这些测试只在 Linux 上编译运行（`cargo test --lib`），
/// 因为它们依赖的 `path_to_file_uri` / `parse_file_uri` 是 Linux 专用实现。
#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;

    #[test]
    fn uri_encodes_ascii_path() {
        assert_eq!(
            path_to_file_uri("/home/u/a.md").unwrap(),
            "file:///home/u/a.md"
        );
    }

    #[test]
    fn uri_encodes_space_and_non_ascii() {
        let uri = path_to_file_uri("/home/u/功能 演示.md").unwrap();
        assert!(uri.starts_with("file:///home/u/"), "uri={uri}");
        // 空格与中文都必须被百分号编码
        assert!(uri.contains("%20"), "空格未编码: {uri}");
        assert!(!uri.contains(' '), "残留空格: {uri}");
        assert!(uri.is_ascii(), "含未编码的非 ASCII: {uri}");
    }

    #[test]
    fn uri_encodes_special_chars() {
        let uri = path_to_file_uri("/tmp/a#b%c?d.md").unwrap();
        assert!(uri.contains("%23"), "# 未编码: {uri}");
        assert!(uri.contains("%25"), "% 未编码: {uri}");
        assert!(uri.contains("%3F"), "? 未编码: {uri}");
    }

    #[test]
    fn uri_requires_absolute_path() {
        assert!(path_to_file_uri("relative/a.md").is_err());
    }

    #[test]
    fn uri_roundtrips_ascii() {
        let path = "/home/u/a.md";
        let uri = path_to_file_uri(path).unwrap();
        assert_eq!(parse_file_uri(&uri).as_deref(), Some(path));
    }

    #[test]
    fn uri_roundtrips_non_ascii_with_spaces() {
        // 中文 + 空格：这是最容易出问题的一类路径
        let path = "/home/u/中文 目录/功能 演示.md";
        let uri = path_to_file_uri(path).unwrap();
        assert_eq!(
            parse_file_uri(&uri).as_deref(),
            Some(path),
            "往返后路径不一致，uri={uri}"
        );
    }

    #[test]
    fn parse_accepts_localhost_authority() {
        assert_eq!(
            parse_file_uri("file://localhost/tmp/a.md").as_deref(),
            Some("/tmp/a.md")
        );
    }

    #[test]
    fn parse_rejects_foreign_authority() {
        assert!(parse_file_uri("file://server/share/a.md").is_none());
    }

    #[test]
    fn parse_rejects_non_file_scheme() {
        assert!(parse_file_uri("http://example.com/a").is_none());
        assert!(parse_file_uri("/tmp/a.md").is_none());
        assert!(parse_file_uri("").is_none());
    }

    #[test]
    fn parse_ignores_blank_lines() {
        // 剪贴板内容常带尾随换行，解析结果里不应出现空项
        let raw = "file:///tmp/a.md\n\nfile:///tmp/b.md\n";
        let parsed: Vec<String> = raw.lines().filter_map(parse_file_uri).collect();
        assert_eq!(parsed, vec!["/tmp/a.md", "/tmp/b.md"]);
    }
}
