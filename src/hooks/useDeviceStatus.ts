/**
 * useDeviceStatus — 从 DeviceStatusStore 读取单个设备状态
 *
 * 组件通过此 hook 订阅设备状态，无需自己轮询。
 * 需配合 useDeviceStatusPolling 使用（由父组件或全局启动轮询）。
 */

import { useDeviceStatusStore } from '../stores/deviceStatusStore';

export function useDeviceStatus(deviceId: string | null) {
  return useDeviceStatusStore((s) =>
    deviceId ? s.statuses.get(deviceId)?.status : undefined
  );
}
