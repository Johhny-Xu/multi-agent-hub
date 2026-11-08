import { describe, expect, it } from "vitest";

import {
  BOAT_ACCOUNT_RESOURCES_ERROR,
  CLOUD_BACKEND_CHANGE_ERROR,
  VPS_ALIAS_RESOURCES_ERROR,
  VPS_BOT_ALIAS_CHANGE_ERROR,
  boatAccountResourceChangeError,
  cloudBackendChangeError,
  vpsAliasResourceChangeError,
  vpsBotAliasChangeError,
  resolveCloudBackend,
  resolveCloudBackendFacts,
} from "./cloud-backend.ts";

describe("cloud backend switching", () => {
  const activeTurnCases: Array<[string, boolean, boolean]> = [
    ["a busy bot", true, false],
    ["an active VPS thread", false, true],
  ];

  it.each(activeTurnCases)("rejects changes during %s", (_reason, busy, activeVpsThread) => {
    expect(cloudBackendChangeError(busy, activeVpsThread)).toBe(CLOUD_BACKEND_CHANGE_ERROR);
  });

  it("allows changes while idle", () => {
    expect(cloudBackendChangeError(false, false)).toBeNull();
  });

  it("allows Boat token rotation only when the replacement sees the same resources", () => {
    const current = [{ boxId: "bx_23456789", name: "ogb-scope-bot-hash" }];
    expect(boatAccountResourceChangeError(current, [...current])).toBeNull();
    expect(boatAccountResourceChangeError(current, null)).toBe(BOAT_ACCOUNT_RESOURCES_ERROR);
    expect(boatAccountResourceChangeError(current, [{ ...current[0]!, boxId: "bx_3456789a" }]))
      .toBe(BOAT_ACCOUNT_RESOURCES_ERROR);
    expect(boatAccountResourceChangeError([], null)).toBeNull();
  });

  it("keeps an SSH alias attached while its VPS still has local computers", () => {
    expect(vpsAliasResourceChangeError(1)).toBe(VPS_ALIAS_RESOURCES_ERROR);
    expect(vpsAliasResourceChangeError(0)).toBeNull();
  });

  it.each(activeTurnCases)("rejects a bot's own SSH alias change during %s", (_reason, busy, activeVpsThread) => {
    expect(vpsBotAliasChangeError(busy, activeVpsThread)).toBe(VPS_BOT_ALIAS_CHANGE_ERROR);
  });

  it("allows a bot's own SSH alias change while idle", () => {
    expect(vpsBotAliasChangeError(false, false)).toBeNull();
  });
});

describe("resolveCloudBackend", () => {
  const vpsInstance = { id: "vps-1", name: "VPS 1", kind: "ssh" as const, sshAlias: "vps-one" };
  const vpsConfig = { version: 2 as const, instances: [vpsInstance] };
  const boatConfig = { token: "boat_token_123" };

  it("automatically falls back to vps when Boat is unconfigured and VPS is available", () => {
    const cfg = { box: undefined, vps: vpsConfig };
    expect(resolveCloudBackend(cfg, { cloudBackend: undefined })).toBe("vps");
    expect(resolveCloudBackend(cfg, {})).toBe("vps");
    expect(resolveCloudBackend(cfg, null)).toBe("vps");
    expect(resolveCloudBackend(cfg, { cloudBackend: "box" })).toBe("vps");
    expect(resolveCloudBackend(cfg, { cloudBackend: "vps" })).toBe("vps");
  });

  it("resolves to vps when Boat is null and VPS has multiple instances", () => {
    const cfg = {
      box: null as unknown as { token?: string },
      vps: {
        version: 2 as const,
        instances: [
          { id: "vps-1", name: "VPS 1", kind: "ssh" as const, sshAlias: "vps-1" },
          { id: "vps-2", name: "VPS 2", kind: "ssh" as const, sshAlias: "vps-2" },
          { id: "vps-3", name: "VPS 3", kind: "ssh" as const, sshAlias: "vps-3" },
          { id: "vps-4", name: "VPS 4", kind: "ssh" as const, sshAlias: "vps-4" },
        ],
      },
    };
    expect(resolveCloudBackend(cfg, { cloudBackend: undefined })).toBe("vps");
  });

  it("picks by bot choice and defaults to box when both Boat and VPS are configured", () => {
    const cfg = { box: boatConfig, vps: vpsConfig };
    expect(resolveCloudBackend(cfg, { cloudBackend: undefined })).toBe("box");
    expect(resolveCloudBackend(cfg, {})).toBe("box");
    expect(resolveCloudBackend(cfg, null)).toBe("box");
    expect(resolveCloudBackend(cfg, { cloudBackend: "box" })).toBe("box");
    expect(resolveCloudBackend(cfg, { cloudBackend: "vps" })).toBe("vps");
  });

  it("defaults to box when Boat is configured and VPS is absent", () => {
    const cfg = { box: boatConfig, vps: undefined };
    expect(resolveCloudBackend(cfg, { cloudBackend: undefined })).toBe("box");
    expect(resolveCloudBackend(cfg, { cloudBackend: "box" })).toBe("box");
    expect(resolveCloudBackend(cfg, { cloudBackend: "vps" })).toBe("vps");
  });

  it("defaults to box when neither Boat nor VPS is configured", () => {
    const cfg = { box: undefined, vps: undefined };
    expect(resolveCloudBackend(cfg, { cloudBackend: undefined })).toBe("box");
    expect(resolveCloudBackend(cfg, { cloudBackend: "vps" })).toBe("vps");
  });

  it("resolves pure facts across all combinations", () => {
    expect(resolveCloudBackendFacts({ hasBoat: false, hasVps: true, cloudBackend: undefined })).toBe("vps");
    expect(resolveCloudBackendFacts({ hasBoat: false, hasVps: true, cloudBackend: "box" })).toBe("vps");
    expect(resolveCloudBackendFacts({ hasBoat: false, hasVps: true, cloudBackend: "vps" })).toBe("vps");

    expect(resolveCloudBackendFacts({ hasBoat: true, hasVps: true, cloudBackend: undefined })).toBe("box");
    expect(resolveCloudBackendFacts({ hasBoat: true, hasVps: true, cloudBackend: "box" })).toBe("box");
    expect(resolveCloudBackendFacts({ hasBoat: true, hasVps: true, cloudBackend: "vps" })).toBe("vps");

    expect(resolveCloudBackendFacts({ hasBoat: true, hasVps: false, cloudBackend: undefined })).toBe("box");
    expect(resolveCloudBackendFacts({ hasBoat: true, hasVps: false, cloudBackend: "box" })).toBe("box");
    expect(resolveCloudBackendFacts({ hasBoat: true, hasVps: false, cloudBackend: "vps" })).toBe("vps");

    expect(resolveCloudBackendFacts({ hasBoat: false, hasVps: false, cloudBackend: undefined })).toBe("box");
    expect(resolveCloudBackendFacts({ hasBoat: false, hasVps: false, cloudBackend: "vps" })).toBe("vps");
  });
});
