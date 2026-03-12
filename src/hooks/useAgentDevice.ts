/**
 * useAgentDevice — Agent 绑定设备与 VncTarget 的组合查询
 *
 * 正确数据流：getAgentBinding → devices.get，替代已废弃的 api.devices.list(agentId)。
 * 返回 binding、device、vncTarget，供 VNC 组件使用。
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';
import type { AgentDeviceBinding } from '../services/api';
import type { Device } from '../types';
import type { VncTarget } from '../types/vnc';

export interface UseAgentDeviceResult {
  binding: AgentDeviceBinding | null;
  device: Device | null;
  vncTarget: VncTarget | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const deviceCache = new Map<string, { device: Device; ts: number }>();
const CACHE_TTL_MS = 30_000;

async function getDeviceCached(deviceId: string): Promise<Device> {
  const cached = deviceCache.get(deviceId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.device;
  }
  const device = await api.devices.get(deviceId);
  deviceCache.set(deviceId, { device, ts: Date.now() });
  return device;
}

function bindingToVncTarget(binding: AgentDeviceBinding, device: Device | null): VncTarget {
  const { device_id, subject_type, subject_id } = binding;
  const pcClientId = device?.pc_client_id;
  if (subject_type === 'vm_user') {
    return {
      resourceId: `${device_id}:${subject_id}`,
      subjectType: 'vm_user',
      deviceId: device_id,
      username: subject_id,
      pcClientId,
    };
  }
  return {
    resourceId: device_id,
    subjectType: subject_type as 'main' | 'default',
    deviceId: device_id,
    pcClientId,
  };
}

export function useAgentDevice(agentId: string | null): UseAgentDeviceResult {
  const [binding, setBinding] = useState<AgentDeviceBinding | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [vncTarget, setVncTarget] = useState<VncTarget | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;

  const fetch = useCallback(async () => {
    const requestFor = agentId;
    if (!requestFor) {
      setBinding(null);
      setDevice(null);
      setVncTarget(null);
      setIsLoading(false);
      setError(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const b = await api.getAgentBinding(requestFor);
      if (agentIdRef.current !== requestFor) return;
      setBinding(b);
      if (!b) {
        setDevice(null);
        setVncTarget(null);
        setError(null);
        setIsLoading(false);
        return;
      }
      const d = await getDeviceCached(b.device_id);
      if (agentIdRef.current !== requestFor) return;
      setDevice(d);
      setVncTarget(bindingToVncTarget(b, d));
    } catch (e) {
      if (agentIdRef.current !== requestFor) return;
      setError(e instanceof Error ? e.message : String(e));
      setBinding(null);
      setDevice(null);
      setVncTarget(null);
    } finally {
      if (agentIdRef.current === requestFor) setIsLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { binding, device, vncTarget, isLoading, error, refetch: fetch };
}
