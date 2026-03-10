//! 应用启动初始化：rustls、panic hook、tracing

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// 初始化 rustls 0.23 crypto provider（tokio-tungstenite 0.24 所需）
pub fn init_rustls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// 安装 panic hook，将 panic 信息写入日志
pub fn init_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = match info.payload().downcast_ref::<&str>() {
            Some(s) => s.to_string(),
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => s.clone(),
                None => "unknown panic payload".to_string(),
            },
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        let entry = format!("[{}] PANIC at {}: {}\n", ts, location, msg);

        eprintln!("{}", entry.trim());

        let home = std::env::var("HOME").unwrap_or_default();
        let log_path = format!(
            "{}/Library/Application Support/com.novaic.app/logs/panic.log",
            home
        );
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            use std::io::Write;
            let _ = f.write_all(entry.as_bytes());
        }
    }));
}

/// 初始化 tracing
pub fn init_tracing() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,vmcontrol=info,tower_http=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}

/// 设置 NO_PROXY 避免代理拦截本地服务
pub fn init_no_proxy() {
    std::env::set_var(
        "NO_PROXY",
        "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    );
    std::env::set_var(
        "no_proxy",
        "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    );
}

/// 统一初始化：rustls、panic hook、tracing、NO_PROXY
pub fn init() {
    init_rustls();
    init_panic_hook();
    init_tracing();
    init_no_proxy();
}
