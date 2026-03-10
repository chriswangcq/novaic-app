//! 文件操作平台抽象
//!
//! 桌面端：使用 shell 命令（open、xdg-open、explorer）
//! 移动端：需 Kotlin/Swift 插件实现 Intent/UIDocument

use std::path::Path;

/// 跨平台文件操作 trait（待 open_file 移动端插件实现后接入）
#[allow(dead_code)]
pub trait FileOps: Send + Sync {
    /// 用默认应用打开文件
    fn open_file(&self, path: &Path) -> Result<(), String>;

    /// 在文件管理器中显示文件所在目录
    fn show_in_folder(&self, path: &Path) -> Result<(), String>;
}
