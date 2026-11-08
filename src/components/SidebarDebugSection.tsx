import type { ReactNode } from "react";

import { t } from "@/lib/i18n";
import { SidebarSectionHeader } from "./SidebarSectionHeader";

/** The 调试区: bots an agent/hub integration created, kept out of everyday lists and shown only in Advanced mode. */
export function SidebarDebugSection({
  count,
  collapsed,
  onToggle,
  showHeader = true,
  children,
}: {
  count: number;
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
          count={count}
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
