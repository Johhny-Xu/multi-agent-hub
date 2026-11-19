import type { ReactNode } from "react";

import { t } from "@/lib/i18n";
import { SidebarSectionHeader } from "./SidebarSectionHeader";

/** The 调试区: bots an agent/hub integration created, kept out of everyday lists and shown only in Advanced mode. */
export function SidebarDebugSection({
  collapsed,
  onToggle,
  showHeader = true,
  children,
}: {
  /** Kept for callers; the header no longer shows a count (upstream 0.1.169 dropped section counts). */
  count?: number;
  collapsed: boolean;
  onToggle?: () => void;
  showHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <div data-sidebar-debug-zone="" className="flex flex-col gap-0.5 pt-3">
      {showHeader && (
        <SidebarSectionHeader
          name={t("sidebar.section.debug")}
          collapsed={collapsed}
          onToggle={onToggle}
          reorderable={false}
          dragging={false}
        />
      )}
      {!collapsed && children}
    </div>
  );
}
