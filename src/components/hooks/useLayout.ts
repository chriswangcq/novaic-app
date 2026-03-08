/**
 * components/hooks/useLayout.ts — View ↔ Business bridge for layout state.
 */
import { useAppStore } from '../../application/store';
import { getLayoutService } from '../../application';
import type { LayoutMode, SidebarMode } from '../../types';

export function useLayout() {
  const layoutMode       = useAppStore(s => s.layoutMode);
  const leftPanelWidth   = useAppStore(s => s.leftPanelWidth);
  const drawerOpen       = useAppStore(s => s.drawerOpen);
  const drawerWidth      = useAppStore(s => s.drawerWidth);
  const sidebarWidth     = useAppStore(s => s.sidebarWidth);
  const sidebarCollapsed = useAppStore(s => s.sidebarCollapsed);
  const sidebarMode      = useAppStore(s => s.sidebarMode);
  const logExpanded      = useAppStore(s => s.logExpanded);
  const logHeightRatio   = useAppStore(s => s.logHeightRatio);
  const expandedCapsules = useAppStore(s => s.expandedCapsules);

  const svc = getLayoutService();

  return {
    layoutMode, leftPanelWidth, drawerOpen, drawerWidth,
    sidebarWidth, sidebarCollapsed, sidebarMode,
    logExpanded, logHeightRatio, expandedCapsules,
    setLayoutMode:      (m: LayoutMode)    => svc.setLayoutMode(m),
    setDrawerOpen:      (v: boolean)       => svc.setDrawerOpen(v),
    setDrawerWidth:     (w: number)        => svc.setDrawerWidth(w),
    setSidebarWidth:    (w: number)        => svc.setSidebarWidth(w),
    setLeftPanelWidth:  (w: number)        => svc.setLeftPanelWidth(w),
    setSidebarCollapsed:(v: boolean)       => svc.setSidebarCollapsed(v),
    setSidebarMode:     (m: SidebarMode)   => svc.setSidebarMode(m),
    setLogExpanded:     (v: boolean)       => svc.setLogExpanded(v),
    setLogHeightRatio:  (r: number)        => svc.setLogHeightRatio(r),
    setExpandedCapsules:(s: Set<string>)   => svc.setExpandedCapsules(s),
  };
}
