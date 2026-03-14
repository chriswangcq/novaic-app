import { useState, useEffect } from 'react';
import { getDevices } from '../db/deviceRepo';
import { subscribe } from '../db/deviceSubscription';
import { getCachedUser } from '../services/auth';
import type { Device } from '../types';

/**
 * useDevicesFromDB
 * 
 * SWR-style hook for observing local Device static metadata from IndexedDB.
 * Status and P2P states are handled by memory stores (DeviceStatusStore).
 */
export function useDevicesFromDB() {
  const [devices, setDevices] = useState<Device[]>([]);
  // getCachedUser() returns a NEW object each call — extract stable user_id to avoid infinite re-render
  const userId = getCachedUser()?.user_id ?? null;

  useEffect(() => {
    if (!userId) return;

    // Load initial data
    const fetch = async () => {
      try {
        const data = await getDevices(userId);
        // Sort devices by creation or ID if desired
        data.sort((a, b) => (b.id < a.id ? -1 : 1));
        setDevices(data);
      } catch (e) {
        console.error('[useDevicesFromDB] load error', e);
      }
    };
    fetch();

    // Re-fetch on write
    return subscribe(userId, () => {
      fetch();
    });
  }, [userId]);

  return devices;
}
