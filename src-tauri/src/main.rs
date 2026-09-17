// Windows 下发布构建不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    markdown_editor_lib::run()
}
