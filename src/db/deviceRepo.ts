/**
 * db/deviceRepo.ts — Device CRUD over IndexedDB.
 * Used for fast UI rendering from cache. Real-time statuses are managed by DeviceStatusStore.
 */

import { getDb } from './index';
import { notifyDeviceChange } from './deviceSubscription';
import type { Device } from '../types';

/** Upsert devices (from API). */
export async function putDevices(userId: string, devices: Device[]): Promise<void> {
  if (!devices.length) return;
  const db = await getDb(userId);
  const tx = db.transaction('devices', 'readwrite');
  await Promise.all(devices.map(d => tx.store.put(d)));
  await tx.done;
  notifyDeviceChange(userId);
}

/** Load all devices. */
export async function getDevices(userId: string): Promise<Device[]> {
  const db = await getDb(userId);
  const all = await db.getAll('devices');
  return all as Device[];
}

/** Get a single device by id. */
export async function getDevice(userId: string, deviceId: string): Promise<Device | null> {
  const db = await getDb(userId);
  return (await db.get('devices', deviceId)) ?? null;
}

/** Delete a single device by id. */
export async function deleteDeviceLocally(userId: string, deviceId: string): Promise<void> {
  const db = await getDb(userId);
  const tx = db.transaction('devices', 'readwrite');
  await tx.store.delete(deviceId);
  await tx.done;
  notifyDeviceChange(userId);
}
