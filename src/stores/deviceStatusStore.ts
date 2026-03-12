/**
 * DeviceStatusStore — 统一的设备状态管理
 *
 * Phase 1：将分散的 status 轮询收敛到此 store。
 * 各组件通过 selector 订阅关心的 deviceId，不再各自起定时器。
 */

import { create } from 'zustand';
import { statusKey } from '../utils/deviceStatusKey';

export type DeviceStatusValue = 'created' | 'setup' | 'ready' | 'running' | 'stopped' | 'error';

export interface DeviceStatusEntry {
  deviceId: string;
  pcClientId?: string;
  status: DeviceStatusValue;
  updatedAt: number;
}

interface DeviceStatusState {
  statuses: Map<string, DeviceStatusEntry>;
  /** 订阅计数，用于动态调整轮询间隔（VNC 连接期间可降为 3s） */
  subscriberCount: number;
  /** VNC 连接数，>0 时轮询间隔降为 3s */
  vncConnectionCount: number;
  setStatus: (deviceId: string, status: DeviceStatusValue, pcClientId?: string) => void;
  setStatuses: (entries: DeviceStatusEntry[]) => void;
  getStatus: (deviceId: string, pcClientId?: string | null) => DeviceStatusValue | undefined;
  subscribeDevice: (deviceId: string) => () => void;
  incrementVncConnectionCount: () => void;
  decrementVncConnectionCount: () => void;
}

export const useDeviceStatusStore = create<DeviceStatusState>((set, get) => ({
  statuses: new Map(),
  subscriberCount: 0,
  vncConnectionCount: 0,

  setStatus: (deviceId, status, pcClientId) =>
    set((s) => {
      const next = new Map(s.statuses);
      const key = statusKey(deviceId, pcClientId);
      next.set(key, { deviceId, pcClientId, status, updatedAt: Date.now() });
      return { statuses: next };
    }),

  setStatuses: (entries) =>
    set((s) => {
      const next = new Map(s.statuses);
      for (const e of entries) {
        const key = statusKey(e.deviceId, e.pcClientId);
        next.set(key, e);
      }
      return { statuses: next };
    }),

  getStatus: (deviceId, pcClientId) => get().statuses.get(statusKey(deviceId, pcClientId))?.status,

  subscribeDevice: (_deviceId) => {
    set((s) => ({ subscriberCount: s.subscriberCount + 1 }));
    return () => {
      set((s) => ({ subscriberCount: Math.max(0, s.subscriberCount - 1) }));
    };
  },

  incrementVncConnectionCount: () =>
    set((s) => ({ vncConnectionCount: s.vncConnectionCount + 1 })),

  decrementVncConnectionCount: () =>
    set((s) => ({ vncConnectionCount: Math.max(0, s.vncConnectionCount - 1) })),
}));
