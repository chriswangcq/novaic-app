/**
 * app/index.ts — Singleton service instances.
 *
 * Components and hooks import services from here — never directly from service files.
 * Services are instantiated lazily with the current userId.
 *
 * Dependency order (no circular deps):
 *   db/ ← messageService, logService
 *   gateway/ ← messageService, logService, agentService, modelService
 *   messageService + logService ← syncService
 *   syncService + modelService ← agentService
 */

import { getCurrentUser } from '../gateway/auth';
import { MessageService } from './messageService';
import { LogService } from './logService';
import { SyncService } from './syncService';
import { AgentService } from './agentService';
import { ModelService } from './modelService';
import { LayoutService } from './layoutService';
import { resetDb } from '../db/index';

// ── Lazy singleton with userId-scoped services ────────────────────────────────

let _userId: string | null = null;
let _messageService: MessageService | null = null;
let _logService: LogService | null = null;
let _syncService: SyncService | null = null;
let _agentService: AgentService | null = null;
let _modelService: ModelService | null = null;
let _layoutService: LayoutService | null = null;

function userId(): string {
  return getCurrentUser()?.user_id ?? 'anonymous';
}

function ensureServices(): void {
  const uid = userId();
  if (_userId === uid && _messageService) return;

  // New user or first call — (re)create everything
  _userId = uid;
  _messageService = new MessageService(uid);
  _logService     = new LogService(uid);
  _syncService    = new SyncService(_messageService, _logService);
  _modelService   = new ModelService(uid);
  _agentService   = new AgentService(uid, _syncService, _modelService);
  _layoutService  = new LayoutService(uid);
}

export function getMessageService(): MessageService { ensureServices(); return _messageService!; }
export function getLogService():     LogService     { ensureServices(); return _logService!; }
export function getSyncService():    SyncService    { ensureServices(); return _syncService!; }
export function getAgentService():   AgentService   { ensureServices(); return _agentService!; }
export function getModelService():   ModelService   { ensureServices(); return _modelService!; }
export function getLayoutService():  LayoutService  { ensureServices(); return _layoutService!; }

/** Call on logout — resets DB handle and all service instances. */
export function resetServices(): void {
  if (_syncService) _syncService.disconnect();
  resetDb();
  _userId = null;
  _messageService = _logService = _syncService = _agentService = _modelService = _layoutService = null;
}

// ── Re-export store for convenience ──────────────────────────────────────────
export { useAppStore, getAppState } from './store';
