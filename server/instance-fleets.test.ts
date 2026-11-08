import { describe, expect, it } from "vitest";

import { WORKER_SPECS } from "../scripts/import-mah-accounts.ts";
import { specFor } from "./service-accounts.ts";
import { DEFAULT_FLEET, PRODUCT_FLEET_ADDITIONS } from "./instance-fleets.ts";

describe("the built-in fleets", () => {
  // mah 账号迁移按 WORKER_SPECS 的 instanceId 落盘成快照目录；fleet 少注册一个引擎，
  // 那些快照就从工作台消失（/api/instances/<id>/service-accounts 报 Unknown engine）。
  it("registers every migrated engine id with the driver the migration wrote", () => {
    for (const spec of Object.values(WORKER_SPECS)) {
      expect(DEFAULT_FLEET[spec.instanceId], `${spec.instanceId} missing from DEFAULT_FLEET`)
        .toMatchObject({ driver: spec.driver });
      expect(specFor(spec.driver), `no service-account spec for ${spec.driver}`).toBeDefined();
    }
  });

  // 一个已保存的产品 fleet（含 claude/grok/codex）靠 PRODUCT_FLEET_ADDITIONS 补齐缺失实例：
  // 这两个引擎必须两张表都有，否则老配置的工作台依旧 Unknown engine。
  it("gains the mah-migrated account engines in saved product fleets too", () => {
    for (const instanceId of ["traecode", "mimocode"]) {
      const driver = WORKER_SPECS[instanceId === "traecode" ? "traecode" : "mimocode"]!.driver;
      expect(DEFAULT_FLEET[instanceId]).toMatchObject({ driver });
      expect(PRODUCT_FLEET_ADDITIONS[instanceId]).toMatchObject({ driver });
    }
  });
});
