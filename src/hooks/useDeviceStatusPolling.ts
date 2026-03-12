/**
 * useDeviceStatusPolling — 统一的设备状态轮询
 *
 * 将分散的 status 轮询收敛到此 hook。传入要轮询的 devices，每 5s 更新 DeviceStatusStore。
 * 轮询间隔可通过 POLL_CONFIG.VM_STATUS_NORMAL_INTERVAL 配置。
 * P2-8: 支持 pc_client_id，多 PC 时正确路由到目标物理机。
 */

import { useEffect, useRef, useMemo } from 'react';
import { api } from '../services/api';
import { useDeviceStatusStore } from '../stores/deviceStatusStore';
import { POLL_CONFIG } from '../config';
import type { Device } from '../types';

export function useDeviceStatusPolling(devices: Device[], enabled = true) {
  const setStatuses = useDeviceStatusStore((s) => s.setStatuses);
  const vncConnectionCount = useDeviceStatusStore((s) => s.vncConnectionCount);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const intervalMs =
    vncConnectionCount > 0 ? POLL_CONFIG.VM_STATUS_FAST_INTERVAL : POLL_CONFIG.VM_STATUS_NORMAL_INTERVAL;

  const deviceKey = useMemo(
    () => devices.map((d) => `${d.id}:${d.pc_client_id ?? ''}`).join(','),
    [devices]
  );

  useEffect(() => {
    if (!enabled || devices.length === 0) return;

    const poll = async () => {
      const entries = await Promise.all(
        devices.map(async (d) => {
          try {
            const r = await api.devices.status(d.id, d.pc_client_id);
            const status = (r?.status as 'created' | 'setup' | 'ready' | 'running' | 'stopped' | 'error') ?? 'stopped';
            return { deviceId: d.id, pcClientId: d.pc_client_id, status, updatedAt: Date.now() };
          } catch {
            return { deviceId: d.id, pcClientId: d.pc_client_id, status: 'error' as const, updatedAt: Date.now() };
          }
        })
      );
      setStatuses(entries);
    };

    poll();
    const interval = setInterval(poll, intervalMs);
    intervalRef.current = interval;

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [deviceKey, enabled, setStatuses, intervalMs]);
}
