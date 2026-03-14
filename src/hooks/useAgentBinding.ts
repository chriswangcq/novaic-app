/**
 * useAgentBinding – fetch agent's device binding + device details.
 *
 * Flow: use initialBinding from agent list when available, else getAgentBinding.
 * Then fetch device via devices.get(binding.device_id).
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import type { AgentDeviceBinding } from '../services/api';
import type { Device } from '../types';
import { useAppStore } from '../application/store';
import { getDevice } from '../db/deviceRepo';
import { getCachedUser } from '../services/auth';

export interface AgentBindingState {
  binding: AgentDeviceBinding | null;
  device: Device | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useAgentBinding(
  agentId: string | null,
  /** Binding from agent list (agents list API includes it) – avoids extra API call */
  initialBinding?: AgentDeviceBinding | null
): AgentBindingState {
  const [binding, setBinding] = useState<AgentDeviceBinding | null>(initialBinding ?? null);
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!agentId) {
      setBinding(null);
      setDevice(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let b: AgentDeviceBinding | null = initialBinding ?? useAppStore.getState().agents.find(a => a.id === agentId)?.binding ?? null;
      if (!b) {
        b = await api.getAgentBinding(agentId);
      }
      setBinding(b);

      if (!b) {
        setDevice(null);
        setLoading(false);
        return;
      }

      const user = getCachedUser();
      let d: Device | null = null;
      if (user) {
         d = await getDevice(user.user_id, b.device_id);
      }
      if (!d) {
         d = await api.devices.get(b.device_id);
      }
      setDevice(d);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setBinding(null);
      setDevice(null);
    } finally {
      setLoading(false);
    }
  }, [agentId, initialBinding]);

  useEffect(() => {
    setBinding(initialBinding ?? null);
    fetch();
  }, [fetch, initialBinding]);

  return { binding, device, loading, error, refetch: fetch };
}
