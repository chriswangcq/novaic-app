//! `p2p` crate — NovAIC P2P 网络层
//!
//! 供 VmControl（PC 广播端）和 Tauri Mobile（移动发现端）共用。
//!
//! # 模块
//! - [`types`]：共用数据结构（VmControlService、DiscoveryEvent）
//! - [`device_id`]：Ed25519 设备身份（生成 / 持久化）
//! - [`local_discovery`]：LAN 内 mDNS 广播与发现（Phase 2）
//! - [`crypto`]：QUIC TLS 证书生成 + cert pinning（Phase 3）
//! - [`rendezvous`]：Gateway 心跳注册 + STUN 外网地址（Phase 3）
//! - [`hole_punch`]：QUIC UDP 打洞（Phase 3）
//! - [`tunnel`]：QUIC 流多路复用代理（Phase 3）

pub mod device_id;
pub mod local_discovery;
pub mod types;

// Phase 3
pub mod crypto;
pub mod hole_punch;
pub mod rendezvous;
pub mod tunnel;
