/**
 * useAgentDevice — Agent 绑定设备与 VncTarget 的组合查询
 *
 * 正确数据流：getAgentBinding → devices.get，替代已废弃的 api.devices.list(agentId)。
 * 返回 binding、device、vncTarget，供 VNC 组件使用。
 * P1: 缓存 key 含 pc_client_id，多 PC 同 device 避免读到错误缓存。
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';
import type { AgentDeviceBinding } from '../services/api';
import type { Device } from '../types';
import type { VncTarget } from '../types/vnc';
import { statusKey } from '../utils/deviceStatusKey';
import { useAppStore } from '../application/store';

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

async function getDeviceCached(deviceId: string, pcClientId?: string | null): Promise<Device> {
  const key = statusKey(deviceId, pcClientId);
  const cached = deviceCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.device;
  }
  const device = await api.devices.get(deviceId);
  const storeKey = statusKey(deviceId, device.pc_client_id ?? pcClientId);
  deviceCache.set(storeKey, { device, ts: Date.now() });
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
      const appInstanceId = useAppStore.getState().appInstanceId;
      const [b, pcResult] = await Promise.all([
        api.getAgentBinding(requestFor),
        appInstanceId ? api.p2p.resolveCurrentPcClientId(appInstanceId) : Promise.resolve({ pcClientId: undefined }),
      ]);
      const pcClientId = pcResult?.pcClientId;
      if (agentIdRef.current !== requestFor) return;
      setBinding(b);
      if (!b) {
        setDevice(null);
        setVncTarget(null);
        setError(null);
        setIsLoading(false);
        return;
      }
      const d = await getDeviceCached(b.device_id, pcClientId);
      if (agentIdRef.current !== requestFor) return;
      setDevice(d);
      const target = bindingToVncTarget(b, d);
      console.log('[VNC-FLOW] [useAgentDevice] vncTarget 来源 agentId=', requestFor, 'binding.device_id=', b.device_id, 'subject_type=', b.subject_type, 'resourceId=', target.resourceId, 'device_id===agentId?', b.device_id === requestFor);
      setVncTarget(target);
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
