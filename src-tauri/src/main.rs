// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "desktop", feature = "mobile"))]
compile_error!("Cannot enable both 'desktop' and 'mobile' features");

fn main() {
    app::run();
}
