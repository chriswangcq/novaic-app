//! Guest Agent 客户端使用示例
//!
//! 运行方式：
//! ```bash
//! cargo run --example guest_agent_demo
//! ```
//!
//! 注意：需要先启动一个带有 Guest Agent 的 QEMU 虚拟机

use vmcontrol::qemu::GuestAgentClient;
use base64::{engine::general_purpose, Engine as _};

#[tokio::main]
async fn main() -> vmcontrol::Result<()> {
    // 初始化日志
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .init();

    let socket_path = "/tmp/novaic/novaic-ga-1.sock";

    println!("==================================================");
    println!("Guest Agent 客户端演示");
    println!("==================================================\n");

    // 检查 socket 是否存在
    if !std::path::Path::new(socket_path).exists() {
        eprintln!("错误: Guest Agent socket 不存在: {}", socket_path);
        eprintln!("\n请先启动带有 Guest Agent 的虚拟机。");
        eprintln!("示例命令:");
        eprintln!("  qemu-system-x86_64 \\");
        eprintln!("    -chardev socket,path={},server=on,wait=off,id=ga0 \\", socket_path);
        eprintln!("    -device virtio-serial \\");
        eprintln!("    -device virtserialport,chardev=ga0,name=org.qemu.guest_agent.0 \\");
        eprintln!("    ...");
        return Ok(());
    }

    // 连接到 Guest Agent
    println!("1. 连接到 Guest Agent...");
    let mut client = GuestAgentClient::connect(socket_path).await?;
    println!("   ✅ 连接成功\n");

    // Ping 测试
    println!("2. 测试连接 (guest-ping)...");
    client.ping().await?;
    println!("   ✅ Guest Agent 响应正常\n");

    // 获取 Guest Agent 信息
    println!("3. 获取 Guest Agent 信息 (guest-info)...");
    let info = client.info().await?;
    println!("   版本: {}", info.version);
    println!("   支持的命令数: {}", info.supported_commands.len());
    println!("   部分命令列表:");
    for cmd in info.supported_commands.iter().take(5) {
        println!("     - {} (enabled: {})", cmd.name, cmd.enabled);
    }
    println!();

    // 执行命令测试
    println!("4. 执行命令 (guest-exec)...");
    println!("   执行: /bin/echo 'Hello from Guest Agent!'");
    let status = client
        .exec_sync("/bin/echo", vec!["Hello from Guest Agent!".to_string()])
        .await?;
    
    println!("   退出码: {:?}", status.exit_code);
    
    if let Some(stdout_b64) = status.stdout {
        let stdout_bytes = general_purpose::STANDARD.decode(&stdout_b64).unwrap();
        let stdout_str = String::from_utf8_lossy(&stdout_bytes);
        println!("   标准输出: {}", stdout_str.trim());
    }
    println!();

    // 文件写入测试
    println!("5. 文件操作测试...");
    let test_file = "/tmp/guest_agent_test.txt";
    let test_content = b"This is a test file written by Guest Agent client!";
    
    println!("   写入文件: {}", test_file);
    client.write_file(test_file, test_content).await?;
    println!("   ✅ 写入 {} 字节", test_content.len());

    // 文件读取测试
    println!("   读取文件: {}", test_file);
    let read_content = client.read_file(test_file).await?;
    println!("   ✅ 读取 {} 字节", read_content.len());
    println!("   内容: {}", String::from_utf8_lossy(&read_content));

    // 验证内容一致性
    if read_content == test_content {
        println!("   ✅ 文件内容验证成功");
    } else {
        println!("   ❌ 文件内容不匹配");
    }
    println!();

    // 清理测试文件
    println!("6. 清理测试文件...");
    let status = client
        .exec_sync("/bin/rm", vec![test_file.to_string()])
        .await?;
    
    if status.exit_code == Some(0) {
        println!("   ✅ 测试文件已清理\n");
    } else {
        println!("   ⚠️  清理失败 (退出码: {:?})\n", status.exit_code);
    }

    // 高级命令测试
    println!("7. 高级命令测试...");
    println!("   执行: uname -a");
    let status = client
        .exec_sync("/bin/uname", vec!["-a".to_string()])
        .await?;
    
    if let Some(stdout_b64) = status.stdout {
        let stdout_bytes = general_purpose::STANDARD.decode(&stdout_b64).unwrap();
        let stdout_str = String::from_utf8_lossy(&stdout_bytes);
        println!("   系统信息: {}", stdout_str.trim());
    }
    println!();

    // 异步命令测试
    println!("8. 异步命令测试...");
    println!("   启动异步命令: sleep 2");
    let result = client.exec("/bin/sleep", vec!["2".to_string()]).await?;
    println!("   命令 PID: {}", result.pid);

    // 轮询命令状态
    println!("   等待命令完成...");
    let mut count = 0;
    loop {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        let status = client.exec_status(result.pid).await?;
        count += 1;
        
        if status.exited {
            println!("   ✅ 命令完成 (轮询 {} 次，退出码: {:?})", count, status.exit_code);
            break;
        } else {
            println!("   ⏳ 命令仍在运行... (第 {} 次检查)", count);
        }
    }
    println!();

    println!("==================================================");
    println!("所有测试完成！");
    println!("==================================================");

    Ok(())
}
