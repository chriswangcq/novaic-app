/**
 * db/fileRepo.ts — Local file cache metadata.
 *
 * Persists downloaded attachment blobs (images) and filesystem paths (files)
 * so FileAttachment can restore its state across component remounts and app restarts.
 *
 * - Images: the Blob itself is stored in IndexedDB (no filesystem permission needed).
 * - Non-image files: only the filesystem path is stored (Tauri wrote the actual bytes).
 *
 * Zero business logic. Zero knowledge of Gateway or Zustand.
 */

import { getDb } from './index';

export interface CachedFile {
  /** attachment.id from server — used as the primary key */
  id: string;
  filename: string;
  mime_type: string;
  file_size: number;
  cached_at: number;
  /** Stored for images: entire Blob so we never re-fetch from server */
  blob?: Blob;
  /** Stored for non-image files: absolute path written by Tauri's download_file_to_cache */
  local_path?: string;
}

export async function getCachedFile(userId: string, fileId: string): Promise<CachedFile | null> {
  const db = await getDb(userId);
  return (await db.get('files', fileId)) ?? null;
}

export async function setCachedFile(userId: string, file: CachedFile): Promise<void> {
  const db = await getDb(userId);
  await db.put('files', file);
}

export async function deleteCachedFile(userId: string, fileId: string): Promise<void> {
  const db = await getDb(userId);
  await db.delete('files', fileId);
}
