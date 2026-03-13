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
 * resourceId = vm_id；username 必传，maindesk 传 ""，subuser 传实际用户名。
 */
export interface VncTarget {
  /** 物理 PC 标识（VmControl Ed25519），用于路由。可选，未传时从 my-devices 取第一个在线 */
  pcClientId?: string;
  /** vm_id（deviceId） */
  resourceId: string;
  subjectType: 'main' | 'vm_user' | 'default';
  /** 逻辑设备 ID（devices 表主键） */
  deviceId: string;
  /** 必传：maindesk 传 ""，subuser 传实际用户名 */
  username: string;
}
