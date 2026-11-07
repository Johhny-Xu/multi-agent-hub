# multi-agent-hub

**简体中文** · [English](README.en.md)

**v1.3 is a restructure, not an incremental release.** The repository is now based on the
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) multi-engine workbench, with the hub's MCP task pool,
check-in and vendor-quota modules kept as secondary components. The old agenthub WebUI is deprecated; its
complete copy lives in the tag `webui-final-20261107`.

**Version: v1.3.0** · [Apache-2.0](LICENSE) · [Changelog](CHANGELOG.md) · Maintained by
[@Johhny-Xu](https://github.com/Johhny-Xu) alone.

## What is in it

| Part | Origin | Notes |
| --- | --- | --- |
| Bot workbench | OpenMausBot 0.1.145 | Multi-engine chat UI and server; one process per bot |
| Engine layer | OpenMausBot + local work | 30+ coding CLIs, incl. five Chinese ones added here: CodeBuddy (intl/CN), Qoder (intl/CN), CodeArts, MiniMax Code, Meoo |
| MCP task pool | hub (`hub/`, `mcp/`) | Shared queue, mailbox and notes at `http://127.0.0.1:8765/mcp` |
| Check-in and quota | hub (was `console/`) | Pure ESM modules, now under `checkin/` |

## Build and run

```bash
pnpm install          # Node >= 24, pnpm 10.33
pnpm build
node --experimental-strip-types server/openmausbot.ts serve --port 8801
python3 hub/agent_hub.py --http 8765 --host 127.0.0.1   # MCP pool, separate process
```

## Known state

- The old WebUI (`console/`, `desktop/`, `demo/`) is gone from the trunk. Retrieve it from the tag above.
- Automatic check-in was driven by the WebUI server every 30 minutes; that trigger no longer exists. The modules
  themselves still work, but need a new host.
- `ops/remote_linux_services.py` still points at the removed `console/server.mjs`; kept for reference only.

Full detail — including why Antigravity no longer needs Google's 900 MB runtime — is in the Chinese README.
