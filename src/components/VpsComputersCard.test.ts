import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { VpsComputersCard, type VpsInstanceSection } from "./VpsComputersCard";
import type { VpsComputerInventoryInstance } from "./LocalComputerSection";

const fakeDesktop: VpsComputerInventoryInstance = {
  name: "openmausbot-vps-bot-abc123456789",
  instanceId: "cloud-a",
  containerId: "c".repeat(64),
  state: "running",
  vpsAlias: "cloud-a",
  ownerBotId: "bot-1",
  ownerName: "Scout",
  orphaned: false,
  inUse: true,
};

describe("VpsComputersCard sections", () => {
  it("renders each VPS instance in its own section with instance name, kind, status, and desktops", () => {
    const sections: VpsInstanceSection[] = [
      {
        id: "cloud-a-id",
        name: "cloud-a",
        kind: "ssh",
        sshAlias: "cloud-a",
        state: "running",
        desktops: [fakeDesktop],
      },
      {
        id: "simular-1",
        name: "simular-box",
        kind: "mcp",
        mcpServer: "simular-box",
        boxId: "box-42",
        state: "ready",
        desktops: [],
      },
      {
        id: "simular-2",
        name: "simular-box-2",
        kind: "mcp",
        mcpServer: "simular-box",
        boxId: "box-99",
        state: "ready",
        desktops: [],
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(VpsComputersCard, {
        instances: [fakeDesktop],
        sections,
        configured: true,
        aliases: ["cloud-a"],
        loading: false,
        removingName: null,
        error: null,
        unavailableReason: null,
        onRefresh: vi.fn(),
        onRemove: vi.fn(),
      }),
    );

    // Section 1: SSH cloud-a
    expect(markup).toContain("cloud-a");
    expect(markup).toContain("SSH");
    expect(markup).toContain("Scout");
    // The section carries the instance's own status; the desktop carries its own.
    expect(markup).toContain("running");
    expect(markup).toContain("In use");

    // Section 2: simular-box
    expect(markup).toContain("simular-box");
    expect(markup).toContain("box-42");

    // Section 3: simular-box-2
    expect(markup).toContain("simular-box-2");
    expect(markup).toContain("box-99");
  });

  it("displays box status for an MCP instance without a desktop container list", () => {
    const sections: VpsInstanceSection[] = [
      {
        id: "mcp-box",
        name: "simular-box-3",
        kind: "mcp",
        mcpServer: "simular-box",
        boxId: "box-alpha-7",
        state: "ready",
        desktops: [],
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(VpsComputersCard, {
        instances: [],
        sections,
        configured: true,
        aliases: [],
        loading: false,
        removingName: null,
        error: null,
        unavailableReason: null,
        onRefresh: vi.fn(),
        onRemove: vi.fn(),
      }),
    );

    expect(markup).toContain("simular-box-3");
    expect(markup).toContain("Box: ");
    expect(markup).toContain("box-alpha-7");
    expect(markup).toContain("ready");
    // Should not contain desktop remove button
    expect(markup).not.toContain("Permanently remove this desktop");
  });

  const renderCard = (props: {
    instances?: VpsComputerInventoryInstance[];
    sections?: VpsInstanceSection[];
    configured: boolean | null;
    aliases?: string[];
  }) => renderToStaticMarkup(createElement(VpsComputersCard, {
    instances: props.instances ?? [],
    sections: props.sections,
    configured: props.configured,
    aliases: props.aliases ?? [],
    loading: false,
    removingName: null,
    error: null,
    unavailableReason: null,
    onRefresh: vi.fn(),
    onRemove: vi.fn(),
  }));

  it("reports an empty SSH host as an SSH host, not as a Boat desktop that is missing", () => {
    const markup = renderCard({
      configured: true,
      sections: [{ id: "cloud-a-id", name: "cloud-a", kind: "ssh", sshAlias: "cloud-a", state: "ready", desktops: [] }],
    });
    expect(markup).toContain("No desktop on this SSH host yet.");
    expect(markup).not.toContain("desktops found on your VPS");
  });

  it("keeps listing configured instances when the SSH-alias flag is false", () => {
    const markup = renderCard({
      configured: false,
      sections: [
        { id: "cloud-a-id", name: "cloud-a", kind: "ssh", sshAlias: "cloud-a", state: "ready", desktops: [fakeDesktop] },
      ],
      instances: [fakeDesktop],
    });
    expect(markup).toContain("Scout");
    expect(markup).not.toContain("No VPS is set up yet.");
  });
});
