use std::path::PathBuf;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use clap::Parser;
use tokio::sync::oneshot;

/// VM Control Service
#[derive(Parser, Debug)]
#[command(name = "vmcontrol")]
#[command(about = "VM Control Service with VNC WebSocket support", long_about = None)]
struct Args {
    /// Port to listen on
    #[arg(short, long, default_value = "19996")]
    port: u16,

    /// Host to bind to
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// Data directory (when set, Android AVD stored under data_dir/android/avd)
    #[arg(long)]
    data_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "vmcontrol=info,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Starting vmcontrol server on http://{}:{}", args.host, args.port);
    tracing::info!(
        "VNC WebSocket endpoint: ws://{}:{}/api/vms/{{id}}/vnc",
        args.host,
        args.port
    );
    if let Some(ref d) = args.data_dir {
        tracing::info!("Android AVD data dir: {}/android/avd", d.display());
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    // SIGINT (Ctrl+C) 和 SIGTERM (Tauri 父进程关闭子进程) graceful shutdown
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = match signal(SignalKind::terminate()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("Failed to register SIGTERM handler: {}", e);
                    // SIGTERM 注册失败时退化为只处理 SIGINT
                    let _ = tokio::signal::ctrl_c().await;
                    let _ = shutdown_tx.send(());
                    return;
                }
            };
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    tracing::info!("SIGINT received, shutting down...");
                }
                _ = sigterm.recv() => {
                    tracing::info!("SIGTERM received, shutting down...");
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("Ctrl+C received, shutting down...");
        }
        let _ = shutdown_tx.send(());
    });

    // 用 ? 传播错误（端口占用、地址解析失败等），进程以非 0 退出码退出
    vmcontrol::start_embedded_server(args.port, args.host, args.data_dir, shutdown_rx).await?;

    Ok(())
}
