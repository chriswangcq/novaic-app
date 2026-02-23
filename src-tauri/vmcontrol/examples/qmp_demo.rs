//! QMP 客户端使用示例
//! 
//! 运行方式：
//! 1. 启动 QEMU: qemu-system-x86_64 -qmp unix:/tmp/test-qmp.sock,server,nowait -m 512 ...
//! 2. 运行示例: cargo run --example qmp_demo

use vmcontrol::qemu::QmpClient;

#[tokio::main]
async fn main() -> vmcontrol::Result<()> {
    // 初始化日志
    tracing_subscriber::fmt::init();

    let socket_path = "/tmp/test-qmp.sock";

    println!("🚀 连接到 QMP socket: {}", socket_path);
    println!("⚠️  确保 QEMU 已启动并监听该 socket\n");

    // 连接到 QEMU
    let mut client = match QmpClient::connect(socket_path).await {
        Ok(client) => {
            println!("✅ QMP 连接成功\n");
            client
        }
        Err(e) => {
            eprintln!("❌ 连接失败: {}", e);
            eprintln!("\n提示：请先启动 QEMU:");
            eprintln!("  qemu-system-x86_64 \\");
            eprintln!("    -qmp unix:/tmp/test-qmp.sock,server,nowait \\");
            eprintln!("    -m 512 -nographic");
            return Err(e);
        }
    };

    // 1. 查询虚拟机状态
    println!("📊 查询虚拟机状态...");
    match client.query_status().await {
        Ok(status) => {
            println!("   状态: {}", status.status);
            println!("   运行中: {}", if status.running { "是" } else { "否" });
            println!("   单步执行: {}\n", if status.singlestep { "是" } else { "否" });
        }
        Err(e) => eprintln!("   ❌ 查询失败: {}\n", e),
    }

    // 2. 暂停虚拟机
    println!("⏸️  暂停虚拟机...");
    match client.stop().await {
        Ok(_) => println!("   ✅ 已暂停\n"),
        Err(e) => eprintln!("   ❌ 暂停失败: {}\n", e),
    }

    // 等待 1 秒
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    // 3. 再次查询状态
    println!("📊 验证暂停状态...");
    match client.query_status().await {
        Ok(status) => {
            println!("   状态: {}", status.status);
            println!("   运行中: {}\n", if status.running { "是" } else { "否" });
        }
        Err(e) => eprintln!("   ❌ 查询失败: {}\n", e),
    }

    // 4. 恢复虚拟机
    println!("▶️  恢复虚拟机...");
    match client.cont().await {
        Ok(_) => println!("   ✅ 已恢复\n"),
        Err(e) => eprintln!("   ❌ 恢复失败: {}\n", e),
    }

    // 5. 最终状态
    println!("📊 最终状态...");
    match client.query_status().await {
        Ok(status) => {
            println!("   状态: {}", status.status);
            println!("   运行中: {}\n", if status.running { "是" } else { "否" });
        }
        Err(e) => eprintln!("   ❌ 查询失败: {}\n", e),
    }

    println!("✅ 演示完成！");

    // 注意：不调用 quit() 以保持 QEMU 运行
    // 如需关闭 QEMU，取消注释下面的代码：
    // println!("\n🛑 关闭 QEMU...");
    // client.system_powerdown().await?;

    Ok(())
}
