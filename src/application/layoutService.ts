/**
 * app/layoutService.ts — Layout state persistence.
 * Reads layout from DB on startup, debounces writes back.
 */

import { useAppStore, buildLayoutPersistence, parseLayoutPersistence } from './store';
import * as prefsRepo from '../db/prefsRepo';
import { LAYOUT_CONFIG } from '../config';
import type { LayoutMode, SidebarMode } from '../types';

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

export class LayoutService {
  private userId: string;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(userId: string) { this.userId = userId; }

  async load(): Promise<void> {
    try {
      const raw = await prefsRepo.getLayout(this.userId);
      const parsed = parseLayoutPersistence(raw);
      if (parsed) {
        useAppStore.getState().patchState({
          layoutMode:       parsed.mode ?? 'normal',
          leftPanelWidth:   parsed.leftWidth ?? LAYOUT_CONFIG.DRAWER_WIDTH,
          drawerWidth:      parsed.drawerWidth ?? LAYOUT_CONFIG.DRAWER_WIDTH,
          sidebarWidth:     parsed.sidebarWidth ?? LAYOUT_CONFIG.SIDEBAR_WIDTH,
          drawerOpen:       parsed.drawerOpen ?? true,
          sidebarCollapsed: parsed.sidebarCollapsed ?? false,
          sidebarMode:      parsed.sidebarMode ?? 'expanded',
          logExpanded:      parsed.logExpanded ?? false,
          logHeightRatio:   parsed.logHeightRatio ?? LAYOUT_CONFIG.LOG_HEIGHT_RATIO,
          expandedCapsules: new Set(parsed.expandedCapsules ?? []),
        });
      }
    } catch {}
  }

  persist(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const state = useAppStore.getState();
      prefsRepo.setLayout(this.userId, buildLayoutPersistence(state)).catch(() => {});
    }, 300);
  }

  flushNow(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    const state = useAppStore.getState();
    prefsRepo.setLayout(this.userId, buildLayoutPersistence(state)).catch(() => {});
  }

  // ── Convenience setters that also trigger persist ─────────────────────────

  setLayoutMode(mode: LayoutMode):      void { useAppStore.getState().setLayoutField('layoutMode', mode); this.persist(); }
  setDrawerOpen(open: boolean):         void { useAppStore.getState().setLayoutField('drawerOpen', open); this.persist(); }
  setDrawerWidth(w: number):            void { useAppStore.getState().setLayoutField('drawerWidth', clamp(w, LAYOUT_CONFIG.DRAWER_MIN, LAYOUT_CONFIG.DRAWER_MAX)); this.persist(); }
  setSidebarWidth(w: number):           void { useAppStore.getState().setLayoutField('sidebarWidth', clamp(w, LAYOUT_CONFIG.SIDEBAR_MIN, LAYOUT_CONFIG.SIDEBAR_MAX)); this.persist(); }
  setLeftPanelWidth(w: number):         void { useAppStore.getState().setLayoutField('leftPanelWidth', clamp(w, LAYOUT_CONFIG.MIN_LEFT_WIDTH, LAYOUT_CONFIG.MAX_LEFT_WIDTH)); this.persist(); }
  setSidebarCollapsed(v: boolean):      void { useAppStore.getState().patchState({ sidebarCollapsed: v, sidebarMode: v ? 'collapsed' : 'expanded' }); this.persist(); }
  setSidebarMode(mode: SidebarMode):    void { useAppStore.getState().patchState({ sidebarMode: mode, sidebarCollapsed: mode === 'collapsed' }); this.persist(); }
  setLogExpanded(v: boolean):           void { useAppStore.getState().setLayoutField('logExpanded', v); this.persist(); }
  setLogHeightRatio(r: number):         void { useAppStore.getState().setLayoutField('logHeightRatio', clamp(r, LAYOUT_CONFIG.LOG_HEIGHT_RATIO_MIN, LAYOUT_CONFIG.LOG_HEIGHT_RATIO_MAX)); this.persist(); }
  setExpandedCapsules(s: Set<string>):  void { useAppStore.getState().setLayoutField('expandedCapsules', s); this.persist(); }
}
