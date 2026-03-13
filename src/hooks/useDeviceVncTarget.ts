/**
 * useDeviceVncTarget — 纯 Device 体系的 VncTarget 获取
 *
 * 不依赖 Agent，直接通过 deviceId + subjectType + subjectId 构造 VncTarget。
 * 用于 DeviceManagerPage、DeviceFloatingPanel 的 deviceMode。
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';
import type { Device } from '../types';
import type { VncTarget } from '../types/vnc';

export interface UseDeviceVncTargetResult {
  device: Device | null;
  vncTarget: VncTarget | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useDeviceVncTarget(
  deviceId: string | null,
  subjectType: 'main' | 'vm_user' | 'default',
  subjectId?: string | null
): UseDeviceVncTargetResult {
  const [device, setDevice] = useState<Device | null>(null);
  const [vncTarget, setVncTarget] = useState<VncTarget | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const deviceIdRef = useRef(deviceId);
  deviceIdRef.current = deviceId;

  const fetch = useCallback(async () => {
    const id = deviceId;
    if (!id) {
      setDevice(null);
      setVncTarget(null);
      setIsLoading(false);
      setError(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const d = await api.devices.get(id);
      if (deviceIdRef.current !== id) return;
      setDevice(d);
      setVncTarget({
        resourceId: id,
        subjectType,
        deviceId: id,
        username: subjectType === 'vm_user' ? (subjectId ?? '') : '',
        pcClientId: d.pc_client_id != null ? d.pc_client_id : undefined,
      });
    } catch (e: unknown) {
      if (deviceIdRef.current !== id) return;
      setError(e instanceof Error ? e.message : String(e));
      setDevice(null);
      setVncTarget(null);
    } finally {
      if (deviceIdRef.current === id) setIsLoading(false);
    }
  }, [deviceId, subjectType, subjectId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { device, vncTarget, isLoading, error, refetch: fetch };
}
