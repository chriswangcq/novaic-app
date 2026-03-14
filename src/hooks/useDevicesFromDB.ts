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
  const user = getCachedUser();

  useEffect(() => {
    if (!user) return;
    const userId = user.user_id;

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
  }, [user]);

  return devices;
}
