//! HTTP 客户端工厂
//! 
//! 提供统一的 HTTP 客户端创建方法，自动处理代理配置：
//! - 本地地址 (localhost, 127.0.0.1, 内网 IP) 不走代理
//! - 外网地址 使用系统代理

#![allow(dead_code)]

use reqwest::{Client, ClientBuilder};
use std::time::Duration;
use crate::config::AppConfig;

/// 判断 URL 是否为本地地址（不应该走代理）
pub fn is_local_url(url: &str) -> bool {
    let local_patterns = [
        "localhost",
        "127.0.0.1",
        "127.0.0.",
        "::1",
        "10.0.",
        "10.1.",
        "10.2.",
        "172.16.",
        "172.17.",
        "172.18.",
        "172.19.",
        "172.20.",
        "172.21.",
        "172.22.",
        "172.23.",
        "172.24.",
        "172.25.",
        "172.26.",
        "172.27.",
        "172.28.",
        "172.29.",
        "172.30.",
        "172.31.",
        "192.168.",
    ];
    
    local_patterns.iter().any(|pattern| url.contains(pattern))
}

/// 创建用于本地服务的 HTTP 客户端（不使用代理）
pub fn local_client() -> ClientBuilder {
    Client::builder()
        .no_proxy()  // 禁用所有代理
}

/// 创建用于外网服务的 HTTP 客户端（使用系统代理）
pub fn external_client() -> ClientBuilder {
    Client::builder()
    // 不调用 .no_proxy()，使用系统默认代理配置
}

/// 根据 URL 自动选择合适的客户端
pub fn auto_client(url: &str) -> ClientBuilder {
    if is_local_url(url) {
        local_client()
    } else {
        external_client()
    }
}

/// 创建带超时的本地服务客户端
pub fn local_client_with_timeout(timeout_secs: u64) -> ClientBuilder {
    local_client()
        .timeout(Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(AppConfig::HTTP_CONNECT_TIMEOUT_SECS))
}

/// 创建带超时的外网服务客户端
pub fn external_client_with_timeout(timeout_secs: u64) -> ClientBuilder {
    external_client()
        .timeout(Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(AppConfig::HTTP_CONNECT_TIMEOUT_SECS))
}
