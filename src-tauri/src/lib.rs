//! Markdown 编辑器 —— Tauri 后端入口。
//!
//! 设计取舍：文件读写不使用 `tauri-plugin-fs`，而是通过自定义命令实现。
//! 原因是 fs 插件的 scope 需要动态配置，而自定义命令可以自己做「只允许
//! 读写当前工作区内文件」的校验，行为更可预测。

mod commands;

use std::sync::Mutex;

use commands::WorkspaceState;

/// 装配 Tauri 应用。
///
/// 窗口关闭流程由前端负责：Tauri 在用户点击关闭时自动广播内建事件
/// `tauri://close-requested`，前端在 `onCloseRequested` 中调用
/// `preventDefault()` 拦下关闭，确认保存后再调用 `close_window` 命令真正退出。
/// 这里刻意不再手动 `on_window_event` 拦截——那样会抢在内建事件之前无条件
/// 吃掉关闭请求，反而让前端收不到通知。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WorkspaceState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            commands::set_workspace_root,
            commands::pick_file,
            commands::close_window,
            commands::list_dir,
            commands::list_dirs_info,
            commands::read_file,
            commands::write_file,
            commands::path_exists,
            commands::path_info,
            commands::export_html,
            commands::open_in_explorer,
            commands::create_entry,
            commands::rename_entry,
            commands::delete_entry,
            commands::clipboard_set_files,
            commands::clipboard_has_files,
            commands::paste_entries,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
