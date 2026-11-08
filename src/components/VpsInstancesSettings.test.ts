// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  config: null as unknown,
  api: vi.fn(),
}));

vi.mock("@/state/api", () => ({
  api: (...args: unknown[]) => fixture.api(...args),
}));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config }, dispatch: vi.fn() }) };
});

const { setLocale } = await import("@/lib/i18n");
const { VpsInstancesSettings, vpsAddBody, vpsRowsAfterRemoval } = await import("./VpsInstancesSettings");

const row = (id: string, name: string, kind: "ssh" | "mcp" = "ssh", extra: Record<string, unknown> = {}) => ({
  id, name, kind, configured: true, available: null as boolean | null,
  capabilities: { status: true, join: true, screenshot: true, start: true, stop: true, remove: kind === "ssh" },
  ...extra,
});

describe("VPS instance settings", () => {
  afterEach(() => { fixture.config = null; });

  it("adds and lists multiple SSH instances", () => {
    const alpha = vpsAddBody({ kind: "ssh", name: "Alpha", sshAlias: "alpha-vps" }, "rev");
    const beta = vpsAddBody({ kind: "ssh", name: "Beta", sshAlias: "beta-vps" }, "rev");
    expect(alpha).toMatchObject({ kind: "ssh", name: "Alpha", sshAlias: "alpha-vps", expectedRevision: "rev" });
    expect(beta).toMatchObject({ kind: "ssh", name: "Beta", sshAlias: "beta-vps" });
    fixture.config = { cloudHome: false, vps: { revision: "rev", instances: [row("a", "Alpha"), row("b", "Beta")] } };
    const markup = renderToStaticMarkup(createElement(VpsInstancesSettings));
    expect(markup).toContain("Alpha");
    expect(markup).toContain("Beta");
  });

  it("binds an existing simular box by id", () => {
    expect(vpsAddBody({ kind: "mcp", name: "Boxed", mcpServer: "simular-box", boxId: "box-1" }, "rev")).toEqual({
      kind: "mcp", adapter: "simular-box", name: "Boxed", mcpServer: "simular-box", boxId: "box-1", expectedRevision: "rev",
    });
  });

  it("keeps the list unchanged after a rejected removal", () => {
    const rows = [row("a", "Alpha"), row("b", "Boxed", "mcp")];
    expect(vpsRowsAfterRemoval(rows, false, "a")).toEqual(rows);
    expect(vpsRowsAfterRemoval(rows, true, "a").map((entry) => entry.id)).toEqual(["b"]);
  });

  it("shows a green dot and the round trip of an online computer", () => {
    fixture.config = { cloudHome: false, vps: { revision: "rev", instances: [row("a", "Alpha", "ssh", { online: true, latencyMs: 42, checkedAt: "2026-11-08T10:00:00.000Z" })] } };
    const markup = renderToStaticMarkup(createElement(VpsInstancesSettings));
    expect(markup).toContain("bg-success");
    expect(markup).toContain("Online · 42 ms");
  });

  it("shows a red dot and the reason of an offline computer", () => {
    fixture.config = { cloudHome: false, vps: { revision: "rev", instances: [row("a", "Alpha", "ssh", { online: false, reason: "timeout" })] } };
    const markup = renderToStaticMarkup(createElement(VpsInstancesSettings));
    expect(markup).toContain("bg-danger");
    expect(markup).toContain("Offline · The check timed out.");
  });

  it("shows a grey dot for a computer that was never checked", () => {
    fixture.config = { cloudHome: false, vps: { revision: "rev", instances: [row("a", "Alpha")] } };
    const markup = renderToStaticMarkup(createElement(VpsInstancesSettings));
    expect(markup).toContain("bg-ink-tertiary");
    expect(markup).toContain("Not checked");
  });
});

describe("interactive VPS checking", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setLocale("en");
    fixture.config = null;
    fixture.api.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    fixture.config = null;
  });

  it("makes 0 check requests when the server instances list is empty", async () => {
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/vps/instances") return { revision: "rev-1", instances: [] };
      return {};
    });
    fixture.config = {
      cloudHome: false,
      vps: { revision: "rev-1", instances: [row("local-1", "Local Only")] },
    };
    await act(async () => {
      root.render(createElement(VpsInstancesSettings));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const checkCalls = fixture.api.mock.calls.filter(([path]: [string]) => path.includes("/check"));
    expect(checkCalls).toHaveLength(0);
  });

  it("auto-checks only the 2 server ids when there are 2 server rows and 1 unsaved local row", async () => {
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/vps/instances") {
        return { revision: "rev-1", instances: [row("s1", "Server 1"), row("s2", "Server 2")] };
      }
      if (path.includes("/check")) {
        const id = path.split("/")[4];
        return row(id, id, "ssh", { online: true, latencyMs: 20 });
      }
      return {};
    });
    fixture.config = {
      cloudHome: false,
      vps: {
        revision: "rev-1",
        instances: [row("s1", "Server 1"), row("s2", "Server 2"), row("u3", "Unsaved 3")],
      },
    };
    await act(async () => {
      root.render(createElement(VpsInstancesSettings));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const checkCalls = fixture.api.mock.calls
      .map(([path]: [string]) => path)
      .filter((path: string) => path.includes("/check"));
    expect(checkCalls).toEqual([
      "/api/vps/instances/s1/check",
      "/api/vps/instances/s2/check",
    ]);
  });

  it("does not send a request and shows an unsaved hint when clicking check on an unsaved row", async () => {
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/vps/instances") {
        return { revision: "rev-1", instances: [row("s1", "Server 1")] };
      }
      if (path.includes("/check")) {
        return row("s1", "Server 1", "ssh", { online: true });
      }
      return {};
    });
    fixture.config = {
      cloudHome: false,
      vps: { revision: "rev-1", instances: [row("s1", "Server 1"), row("u2", "Unsaved 2")] },
    };
    await act(async () => {
      root.render(createElement(VpsInstancesSettings));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fixture.api.mockClear();

    const rowEls = [...host.querySelectorAll(".rounded-lg.bg-inset")];
    const unsavedRowEl = rowEls.find((el) => el.textContent?.includes("Unsaved 2"))!;
    const checkBtn = [...unsavedRowEl.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Check"))!;

    await act(async () => {
      checkBtn.click();
    });

    expect(fixture.api).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toMatch(/unsaved/i);
  });

  it("enters checking on only the clicked row and updates its online and latency stats on completion", async () => {
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/vps/instances") {
        return { revision: "rev-1", instances: [row("s1", "Server 1"), row("s2", "Server 2")] };
      }
      if (path === "/api/vps/instances/s1/check") return row("s1", "Server 1", "ssh", { online: false });
      if (path === "/api/vps/instances/s2/check") return row("s2", "Server 2", "ssh", { online: true, latencyMs: 80 });
      return {};
    });
    fixture.config = {
      cloudHome: false,
      vps: { revision: "rev-1", instances: [row("s1", "Server 1"), row("s2", "Server 2")] },
    };

    await act(async () => {
      root.render(createElement(VpsInstancesSettings));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    let finishCheck: ((res: unknown) => void) | undefined;
    const pendingCheck = new Promise((resolve) => { finishCheck = resolve; });
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/vps/instances/s1/check") return pendingCheck;
      return {};
    });

    const getRowEls = () => [...host.querySelectorAll(".rounded-lg.bg-inset")];
    const s1Row = () => getRowEls().find((el) => el.textContent?.includes("Server 1"))!;
    const s2Row = () => getRowEls().find((el) => el.textContent?.includes("Server 2"))!;
    const checkBtn = [...s1Row().querySelectorAll("button")].find((btn) => btn.textContent?.includes("Check"))!;

    await act(async () => {
      checkBtn.click();
    });

    expect(s1Row().innerHTML).toContain("animate-spin");
    expect(s2Row().innerHTML).not.toContain("animate-spin");

    await act(async () => {
      finishCheck?.(row("s1", "Server 1", "ssh", {
        online: true,
        latencyMs: 42,
        checkedAt: "2026-11-08T12:00:00.000Z",
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(s1Row().innerHTML).not.toContain("animate-spin");
    expect(s1Row().textContent).toContain("Online · 42 ms");
    expect(s1Row().textContent).toContain("Checked");
    expect(s2Row().textContent).not.toContain("42 ms");
  });

  it("marks only that row offline with reason and clears checking when check fails", async () => {
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/vps/instances") {
        return { revision: "rev-1", instances: [row("s1", "Server 1"), row("s2", "Server 2")] };
      }
      if (path === "/api/vps/instances/s1/check") return row("s1", "Server 1", "ssh", { online: true, latencyMs: 50 });
      if (path === "/api/vps/instances/s2/check") return row("s2", "Server 2", "ssh", { online: true, latencyMs: 30 });
      return {};
    });
    fixture.config = {
      cloudHome: false,
      vps: { revision: "rev-1", instances: [row("s1", "Server 1"), row("s2", "Server 2")] },
    };

    await act(async () => {
      root.render(createElement(VpsInstancesSettings));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/vps/instances/s1/check") {
        throw new Error("The check timed out.");
      }
      return {};
    });

    const getRowEls = () => [...host.querySelectorAll(".rounded-lg.bg-inset")];
    const s1Row = () => getRowEls().find((el) => el.textContent?.includes("Server 1"))!;
    const checkBtn = [...s1Row().querySelectorAll("button")].find((btn) => btn.textContent?.includes("Check"))!;

    await act(async () => {
      checkBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(s1Row().innerHTML).not.toContain("animate-spin");
    expect(s1Row().textContent).toContain("Offline · The check timed out.");
    expect(s1Row().innerHTML).toContain("bg-danger");
  });
});
