/**
 * 共享的 statusKey 工具
 *
 * 复合 key：多 PC 时避免同一 device 不同 pc_client_id 互相覆盖。
 * 供 DeviceStatusStore、useDeviceStatus、useAgentDevice 等统一使用。
 */
export function statusKey(deviceId: string, pcClientId?: string | null): string {
  return pcClientId ? `${deviceId}:${pcClientId}` : deviceId;
}
