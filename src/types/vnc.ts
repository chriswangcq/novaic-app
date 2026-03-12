/**
 * Phase 3 统一 RFB 参数
 * shared、wsProtocols、credentials、clipViewport 保持一致
 */
export const RFB_OPTIONS: {
  shared: boolean;
  wsProtocols: string[];
  credentials: Record<string, string>;
  clipViewport: boolean;
} = {
  shared: true,
  wsProtocols: ['binary'],
  credentials: {},
  clipViewport: true,
};

/**
 * VNC 目标寻址类型（Phase 1 统一模型）
 *
 * 用于 VNC 连接时明确「连到哪台物理机的哪个桌面」。
 * pcClientId 可选：Phase 1 阶段可由 createVncTransport 从 my-devices 解析；Phase 2 后由 useAgentDevice 填充。
 */
export interface VncTarget {
  /** 物理 PC 标识（VmControl Ed25519），用于路由。可选，未传时从 my-devices 取第一个在线 */
  pcClientId?: string;
  /** maindesk: device_id；subuser: `${deviceId}:${username}` */
  resourceId: string;
  subjectType: 'main' | 'vm_user' | 'default';
  /** 逻辑设备 ID（devices 表主键） */
  deviceId: string;
  /** vm_user 时有值 */
  username?: string;
}
