# multi-agent-hub

**English** · [简体中文](README.md)

> A local dispatch hub for AI agents: it turns the AI coding CLIs scattered across your machines into one Worker pool you can delegate to and collaborate with.

![multi-agent-hub architecture: any MCP client plugs in, 6 native deep-integration hosts, and a zero-client WebUI — 11 Workers under one scheduler](docs/architecture.en.svg)

**Current version: v1.0.1** · License: [Apache-2.0](LICENSE) · Changelog: [CHANGELOG.md](CHANGELOG.md)

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Choose how to connect](#choose-how-to-connect)
- [Native host plugins](#native-host-plugins)
- [Workers and default models](#workers-and-default-models)
- [MCP tools and task contract](#mcp-tools-and-task-contract)
- [Web console](#web-console)
- [Verification status](#verification-status)
- [Data flow and security](#data-flow-and-security)
- [Prebuilt packages](#prebuilt-packages)
- [Development and testing](#development-and-testing)
- [Version history](#version-history)
- [Documentation](#documentation)
- [Acknowledgements](#acknowledgements)

---

## What it does

Built on standard MCP, native plugins and a sub-agent system, multi-agent-hub gives **9 AI coding Workers** and **6 native hosts** (plus any MCP client) one place to dispatch tasks, collect results, monitor quotas, manage accounts, and run a WebUI console.

Any AI client connected to the Hub can hand tasks to other AIs (each running on its own account quota) and share a task queue, mailbox and notes.

Three ways to plug in:

| Mode | For | What you do |
| --- | --- | --- |
| **Any MCP client** | Cursor, Claude Desktop, Windsurf, Cline / Roo Code, Continue, … | Paste one MCP URL |
| **6 native hosts** | Codex, ZCode, MiniMax Code (plus Claude Code / Agent Plugins 1.0), DeepSeek Harness (DSH), Huawei CodeArts, Antigravity | Run the installer; it adds dedicated `hub-*.md` sub-agents, skills and slash commands |
| **Zero-client** | No IDE or AI client at all | Open the built-in three-pane WebUI and chat, dispatch and monitor there |

**Highlights**

- 🤖 **11 Workers, one contract**: Antigravity, CodeBuddy (international / China), GitHub Copilot, MiMo, MiniMax, TraeCode, ZCode, CodeArts, plus the new opencode and Cline.
- 🔌 **6 native hosts**: native sub-agents, slash commands and workflows, with context isolated automatically.
- 🔐 **OAuth for all 9 vendors inside the WebUI**: log in, log out, save and switch accounts without SSH; login state is read from real on-disk credentials, so there are no fake successes.
- ⚡ **One-click Worker on/off, synced everywhere**: disabled Workers are rejected before dispatch (`profile_disabled`), so no quota is wasted.
- 🛡️ **Strict terminal states**: empty answers, known abnormal exits and partial answers after a timeout are rejected; the original `ref` is kept and a Worker can never dispatch to itself.
- 🔄 **Flexible deployment**: same machine or separate; pure Windows, pure Linux, or Windows ↔ Linux (LAN or SSH reverse tunnel).
- 🔍 **Auto-discovery**: LAN and local Hub broadcast scanning; the MCP bridge reconnects after a config restore; config and credentials live outside the source tree, so upgrades keep task history.
- 🖥️ **Offline demo**: `demo.html` is a single zero-dependency file that runs the full console without a backend.

---

## Quick start

### Requirements

- **Python 3.8+** (3.11+ to install the Codex native plugin)
- **Node.js 20+** (MCP bridge and Web console)
- Each Worker's **official vendor CLI, already logged in** (e.g. `agy`, `cb`, `trae`, `codearts`). The installer only probes the environment and invokes commands; it does not register accounts or log in for you.

### Up and running in three steps

```bash
# 1. Get the code
git clone https://github.com/Johhny-Xu/multi-agent-hub.git
cd multi-agent-hub

# 2. Install and start the Hub + Web console + native plugins for hosts already on this machine
sh install.sh --with-console          # Windows: .\install.cmd --with-console

# 3. Open the console
#    http://localhost:8890
```

- You can also download `agenthub-1.0.1-both.zip` from [Releases](https://github.com/Johhny-Xu/multi-agent-hub/releases), unzip it and run the same command.
- Run from a source checkout, the installer first builds a release bundle in a temp directory, so no manual packaging is needed.
- Day to day: `sh start.sh` / `sh stop.sh` (Windows: `start.bat` / `stop.bat`).
- Just want to look around? Open `demo.html` in a browser.

> 💡 Prefer `sh install.sh` over `./install.sh`: it still works when an unzip tool drops the exec bit (`Permission denied`). See [RUN_ON_LINUX.md](RUN_ON_LINUX.md).

### Default ports

| Port | Service | Used by |
| --- | --- | --- |
| `8765` | **Hub** (`http://<host>:8765/mcp`, token required) | Native plugins, cross-machine clients |
| `8890` | **Web console** (needs `--with-console`) | Your browser |
| `8790` | **Console's built-in sub-agent MCP endpoint** (`http://127.0.0.1:8790/mcp`, starts with the console) | Generic MCP clients, no plugin needed |

---

## Choose how to connect

### Option 0: let your AI install it (recommended)

Copy the matching sentence to the AI assistant you are using; it will clone, install and configure everything.

<details>
<summary><b>Any native host</b> (Antigravity / CodeArts / ZCode / Codex / DSH / MiniMax Code)</summary>

```text
Clone https://github.com/Johhny-Xu/multi-agent-hub.git, read its README.md, and based on the client I am using run install.cmd (Windows) or sh install.sh (Linux/macOS) to install the Multi-Agent Hub service and this client's native plugin (sub-agents, skills and MCP bridge). Then call hub_status to verify the connection.
```
</details>

<details>
<summary><b>Per client</b></summary>

- **Google Antigravity**
  ```text
  Clone https://github.com/Johhny-Xu/multi-agent-hub.git, run install.cmd (sh install.sh on Linux) with --native-hosts antigravity to install the Multi-Agent Hub native plugin and its 9 hub-* sub-agents into ~/.gemini/config/plugins/multi-agent-hub, and start the Hub service.
  ```
- **Huawei CodeArts (IDE / CLI)**
  ```text
  Clone https://github.com/Johhny-Xu/multi-agent-hub.git and run install.cmd --native-hosts codearts --project <current project path> (sh install.sh on Linux) to install the Multi-Agent Hub service and register this workspace's .codeartsdoer/mcp/mcp_settings.json and dedicated sub-agents.
  ```
- **MiniMax Code (`mcode`) / Claude Code**
  ```text
  Clone https://github.com/Johhny-Xu/multi-agent-hub.git, start its Multi-Agent Hub service, and load the repository's plugins/agenthub-workers directory as a native plugin (including .minimax-plugin/plugin.json, .claude-plugin/plugin.json, hub-bridge.mcp.json and the dispatch-hub skill) into this client.
  ```
- **ZCode (IDE / CLI)**
  ```text
  Clone https://github.com/Johhny-Xu/multi-agent-hub.git, run install.cmd --native-hosts zcode (sh install.sh on Linux) to register the plugins/agenthub-workers native plugin (9 external Worker sub-agents plus the MCP bridge) with my ZCode environment, and start the Hub.
  ```
- **OpenAI Codex**
  ```text
  Clone https://github.com/Johhny-Xu/multi-agent-hub.git and run install.cmd --native-hosts codex --project <current project path> (sh install.sh on Linux) to configure the Codex native plugin marketplace and the .codex/agents/ routing rules for this workspace.
  ```
- **DeepSeek Harness (DSH)**
  ```text
  Clone https://github.com/Johhny-Xu/multi-agent-hub.git and run install.cmd --native-hosts dsh (sh install.sh on Linux), or mount the native presets and workflow plugin with dsh plugin add file:./integrations/dsh.
  ```
</details>

<details>
<summary><b>Generic MCP clients</b> (Cursor / Windsurf / Claude Desktop / Cline / Roo Code / Continue)</summary>

With a Hub and console already running:

```text
Add a Streamable HTTP MCP server named "multi-agent-hub" with URL http://127.0.0.1:8790/mcp to this client's MCP config (replace with the server's IP if it runs on the LAN), then call the subagent_agents tool to list the available external sub-agents.
```

From scratch:

```text
Clone https://github.com/Johhny-Xu/multi-agent-hub.git, run install.cmd --with-console (sh install.sh --with-console on Linux) to start the Multi-Agent Hub and Web console (:8890 / :8790), then write http://127.0.0.1:8790/mcp into this client's MCP config.
```
</details>

### Option 1: one-click local install

For a single development machine where you want the Hub, the console and plugins for every installed IDE in one go. Follow [Quick start](#quick-start): the installer checks the environment and detects and registers Codex, ZCode, DSH, CodeArts and Antigravity native plugins and sub-agents.

### Option 2: any MCP client, no plugin

For Cursor, Claude Desktop, Windsurf, Cline / Roo Code / Continue and similar. Start the console with `--with-console`, then either:

- click **Copy this text (send it to your agent)** on the console's "Sub-agent endpoint" card and paste it to your AI, which writes the config itself; or
- add it by hand:

```json
{
  "mcpServers": {
    "multi-agent-hub": { "url": "http://127.0.0.1:8790/mcp" }
  }
}
```

Tools: `subagent_run` (waits server-side; large output is written to disk and only a summary returns), `subagent_result`, `subagent_artifact`, `subagent_agents`.

### Option 3: cross-machine (server + workstation)

Run the Hub and Workers on a home server, NAS or cloud host, and write code on another machine.

```bash
# Server: listen on the LAN and enable the console (a random token file hub-token.txt is generated in the external config dir)
sh install.sh --component hub --bind 0.0.0.0 --port 8765 --with-console
```

```powershell
# Client: point at the server and its token
.\install.cmd --component plugins --url http://SERVER_IP:8765/mcp --token-file C:\private\hub-token.txt
```

- **Auto-discovery**: without `--url`, the client scans the LAN by UDP broadcast and lets you pick a Hub.
- **Switch Hubs later**: run `connect.cmd` (Linux: `sh connect.sh`).
- **Not on the same LAN**: use an SSH reverse tunnel, e.g. `ssh -N -R 127.0.0.1:18765:127.0.0.1:8765 user@SERVER`.
- **Run as a Linux service**: add `--systemd-user` to register a user-level systemd unit (Hub only, no console in this mode).

### Option 4: install a single host's plugin

See [Native host plugins](#native-host-plugins).

---

## Native host plugins

| Host | How to install | Docs |
| --- | --- | --- |
| **Huawei CodeArts / VS Code** | In the IDE's Extensions panel choose "Install from VSIX/CARTS" and import `multi-agent-hub-1.0.1.carts` / `.vsix`; or `.\install.cmd --component plugins --native-hosts codearts --project <workspace>` | [codearts](integrations/codearts/README.md) · [vscode](integrations/vscode/README.md) |
| **MiniMax Code / Claude Code** | Import `agenthub-workers-1.0.1-minimax-plugin.zip` in the desktop or cloud app; CLI: `mcode --plugin-dir ./plugins/agenthub-workers` | [agenthub-workers](plugins/agenthub-workers/README.md) |
| **ZCode IDE / CLI** | `.\install.cmd --component plugins --native-hosts zcode`; or set `{"plugins":{"enabled":true,"dirs":[".../plugins/agenthub-workers"]}}` in `zcode.json` | [agenthub-workers](plugins/agenthub-workers/README.md) |
| **OpenAI Codex** | `.\install.cmd --component plugins --native-hosts codex --project <workspace>`; registers a local plugin marketplace and writes 9 sub-agents to `.codex/agents/` | [codex](integrations/codex/README.md) |
| **DeepSeek Harness (DSH)** | `.\install.cmd --component plugins --native-hosts dsh --profile agenthub-client`; or `dsh plugin --profile <PROFILE> add file:./integrations/dsh --ignore-scripts` | [dsh](integrations/dsh/README.md) |
| **Google Antigravity** | `.\install.cmd --component plugins --native-hosts antigravity`; installs to `~/.gemini/config/plugins/multi-agent-hub`, restart to load | [antigravity](integrations/antigravity/README.md) |

On Linux, replace `.\install.cmd` with `sh install.sh`.

<details>
<summary><b>Antigravity notes</b></summary>

- The native plugin ships `plugin.json`, 9 agents (`agents/*.md`), 4 skills (`skills/*/SKILL.md`) and an `mcp_config.json` with 8 bridge tools.
- The optional Python SDK is pinned to `google-antigravity==0.1.21` and provides typed `SubagentConfig` plus serial / parallel orchestration. The installed wheel has no `beta.run_workflow`, and SDK API auth is separate from the IDE / CLI login.
</details>

<details>
<summary><b>CodeArts notes</b></summary>

Ships 9 sub-agents, 3 slash commands, 1 dispatch skill, 1 Hooks plugin and 8 MCP tools. CodeArts can dispatch to others as a client and be dispatched to as a Worker (`worker="codearts"`, aliases `ca`, `huawei-codearts`).

- **Single call path**: strictly `tool_search → tool_describe → tool_call`; no raw XML tags in prose, so nothing is dispatched twice; one dispatch per task, then the client polls.
- **Permissions and terminal state**: on a host permission denial it returns `blocked_permission` with the original ref instead of retrying under another tool name; only a non-empty real Worker answer counts as `completed`.
- **Windows CLI detection**: finds the official `installers/bin/codearts.exe` and uses its own `cli-data` directory and session database, never the IDE's; "folder not trusted" maps to `CODEARTS_PERMISSION_REQUIRED`.
- **Linux process cleanup**: driver and Hub share a process group, so cancel or timeout reclaims every descendant.

Install only the CodeArts plugin and connect to a remote Hub:

```powershell
.\install.cmd --component plugins --native-hosts codearts --project C:\Work\my-project --url http://SERVER:8765/mcp --token-file C:\private\hub-token.txt
```

```bash
sh install.sh --component plugins --native-hosts codearts --codearts-target cli --url http://SERVER:8765/mcp --token-file /private/hub-token.txt
```

`--project` must point at the workspace the IDE actually has open (or use `--codearts-ide-settings` for the MCP settings file). Reload the IDE or restart the CLI afterwards.

**After switching workspaces** (reuses the external `client.json`, no token re-entry):

```powershell
python integrations/codearts/install.py --config "$env:LOCALAPPDATA/AgentHub/client.json" --ide-settings "C:/Work/new-project/.codeartsdoer/mcp/mcp_settings.json" --target ide --apply
```

Then run "Developer: Reload Window" in the IDE and verify with `/hub-status`. See the [CodeArts package docs](integrations/codearts/README.md).
</details>

---

## Workers and default models

| Worker | Default model | Notes |
| --- | --- | --- |
| **Antigravity** | gemini-3.8-flash-medium | 6 models kept, incl. 3.8 Flash (High/Medium), 3.1 Pro High, Claude 4.6 (Sonnet/Opus); multimodal |
| **CodeBuddy** (China) | deepseek-v4.1-flash (x0.11) | 13 coding models with official credit multipliers x0.06–x2.00; XDG shared session storage |
| **CodeBuddy** (international) | deepseek-v4.1-flash | 18 mainstream models; file tools need real permissions |
| **GitHub Copilot** | auto | Official model choice; WebUI device-code login and GNOME Keyring |
| **MiMo** | xiaomi/mimo-v2.6-flash (26f) | 4 V2.6 models; API key separate from Xiaomi OAuth identity |
| **MiniMax** | MiniMax-M3 | M3 (1M context) and M3.1-Flash-Preview (512K), one-click switch |
| **TraeCode** | GLM-5.3-FlashX (0.31x) | 20 official models, multipliers 0.06x–1.50x; dual-region PKCE OAuth and TraeClaw gateway |
| **ZCode** | GLM-5.3-Flash | China (BigModel) / international (Z.ai) regions; `enc:v1:` AES-256-GCM on disk |
| **CodeArts** | GLM-5.2 (0.70x) | 4 enterprise models (GLM-5.2, GLM-5.2-ArkTS-SPARK, OpenPangu-2.0-Pro/Flash); Linux CLI loads AK/SK automatically |

These are defaults for **new installs**; existing servers keep their configured models.

---

## MCP tools and task contract

Host plugins expose **8 tools** through the MCP bridge:

| Tool | Purpose |
| --- | --- |
| `hub_ask` | Dispatch and wait for the result |
| `hub_dispatch` | Dispatch only; returns a `ref` immediately |
| `hub_fetch` | Fetch a result by `ref` |
| `hub_status` | Worker online / enabled status |
| `hub_capabilities` | Model capabilities (thinking / streaming / attachments) |
| `hub_login` | Check or start a Worker login |
| `hub_discover` | Read-only discovery of available Hubs |
| `hub_set_status` | Enable / disable a Worker (synced everywhere) |

Every host follows the same task contract:

- **Attachments**: `files` takes at most 8 files, 1 MiB total, staged on the Hub.
- **Working directory**: `cwd` is a directory **on the Hub's host**; client paths are never mapped silently.
- **Tracking**: an accepted task returns a persistent `ref`; poll it with `hub_fetch` instead of dispatching again. `completed` means the task finished — whether the answer is correct is still for the caller to check.
- Full parameters: [task options](docs/task-options.md).

---

## Web console

Enable with `--with-console`; default port `8890`.

| Feature | What it does |
| --- | --- |
| **Three panes** | Slim activity bar + platform session tree + immersive chat, with a collapsible right-hand workbench; bottom navigation on mobile |
| **Smart reveal / collapse** | Top bar, activity bar and sidebar expand and hide with the cursor; the top-left brand anchor toggles auto-collapse vs pinned and remembers it |
| **Themes** | Mocha, Shell, Aurora, Dusk, Cyber, Grid — each in light and dark (12 total), WCAG AA calibrated |
| **Custom wallpaper** | Uploading a wallpaper switches the whole UI to translucent glass |
| **Sub-agent accent** | Send button, progress bar and menus follow the active sub-agent's brand colour |
| **Accounts and quotas** | OAuth for 9 vendors, instant account switching; live quota monitoring (60 s cache, request coalescing) |
| **Worker on/off** | A switch on each card, persisted to `agents.json` and applied everywhere |
| **Archive** | Cross-platform aggregation, filter, search, one-click restore, two-step confirm before deleting |
| **Sub-agent MCP endpoint** | `:8790/mcp`, with one-click copy of the URL or a ready-to-send agent prompt |
| **Clipboard fallback** | Works on plain-HTTP LAN addresses where `navigator.clipboard` is blocked |

<details>
<summary><b>Interaction details (for frontend developers)</b></summary>

- Brand anchor `#brand-logo-pin` (`z-index: 120`) never hides. Trigger zones: top bar `Y ≤ 38px`, activity bar `X ≤ 42px`; 90 ms anti-misfire on reveal, 650 ms debounce on collapse; stays pinned while a modal is open, an input is focused or the session sidebar is expanded.
- The sidebar trigger zone is its full footprint (`X ≤ 324px` at a `1440px` viewport); cards are single-line, with `/api/chat/agent-summary` summaries mounted on demand.
- Top bar `z-index: 100` and chat header `z-index: 50` have their own stacking contexts, so dropdowns are never clipped by code blocks or the workbench.
- Glass: under `body.has-custom-bg`, `backdrop-filter: blur(20px~24px) saturate(180%~190%)`; neutral surfaces unify to `--gem-bg-card`, and `--gem-surface-high` is kept only for interactive states and the progress track.
- `--agent-accent` drives the send button, context progress bar and `#panel-chat` second-level menus; model names stay in body colour `--gem-text`.
- The whole status bar is clickable and opens a display picker (model, latency, TPS, tokens, quota); the model drawer has thinking-level and streaming switches.
- The footer shows `v1.0.1`, overridable by the backend's `snap.version`.
- Offline demo: `scripts/build_demo.py` + `scripts/demo_engine.js` generate `demo.html` and `demo/index.html`.
</details>

---

## Verification status

> **Regression tests are not paid end-to-end runs.** Passing regressions prove the framework logic; they do not mean every vendor, model or host has completed a real paid task.

| Item | Result | Notes |
| --- | --- | --- |
| Windows regressions & DOM assertions | ✅ 32 groups + 7 DOM checks | See `docs/refactor-validation.json`, `tests/console_layout_theme_dom.mjs` |
| Linux regressions & load tests | ✅ 29 groups + 4,500+ requests | 360 concurrent, 0 errors; see `docs/stage3-stress-report.json` and siblings |
| Linux production Hub | ✅ Pass | 24 Hub tools, 9 Workers; config, history and auth preserved |
| Linux Antigravity CLI 1.3.1 | ✅ Real call | Native sub-agent `hub-mimocode` dispatched successfully |
| Linux ZCode CLI 0.16.9 | ✅ Real call | Follow-up on the original ref returned the right answer |
| Windows Codex / ZCode | ✅ Real call | Both native sub-agents returned results |
| Windows Antigravity | ✅ Real call | `hub_status` / `hub_capabilities` list 9 Workers |
| CodeArts native components & channels | ✅ Pass | Windows ↔ Linux LAN and SSH channels working |
| Linux CodeArts own models | ✅ Real call | GLM-5.2 family completes in seconds; all processes exit cleanly |
| Windows DSH | ⚠️ Blocked by account balance | Registration passes; model calls return `402 ACCOUNT_QUOTA` |
| Windows CodeArts IDE | ⚠️ Partial | Dispatch succeeds, but the host denies the follow-up `hub_fetch` |
| Windows standalone CodeArts CLI | ⚠️ Not yet accepted | Blocked by folder trust |
| Linux Codex & DSH CLI | ❌ Not installed | Not tested; no pass claimed |

<details>
<summary><b>Boundaries</b></summary>

1. **Native plugin vs optional SDK**: the Antigravity native plugin has completed real calls; the optional Python SDK is an external orchestration library whose current wheel lacks `beta.run_workflow` and whose auth is separate from the host login.
2. **CodeArts auth**: an IDE login does not make the standalone CLI callable, and other vendors' logins cannot stand in for Huawei account permissions. Only default thinking and non-streaming text are enabled.
3. **Privacy**: a client choosing one Hub is not a multi-Hub federation; prompts and attachments still go to the matching model vendor.

Full receipts, source hashes and failure records: [0.9.9 acceptance record](docs/release-0.9.9.md); CodeArts follow-up: [2026-10-10 record](docs/codearts-ide-followup.md).
</details>

---

## Data flow and security

- **Path**: `host client → local MCP bridge → Hub → official CLI / kernel → model vendor API`.
- **Not an offline model**: the Hub only routes and executes; prompts and attachments go to each vendor through its official CLI.
- **Credential isolation**: tokens, API keys and session data live outside the source tree and are never committed.
- **Transport**: the Bearer token only authenticates; across the internet use an HTTPS reverse proxy, VPN or SSH tunnel.
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## Prebuilt packages

| File | Use it for |
| --- | --- |
| `agenthub-1.0.1-both.zip` | Client and Hub on one machine (recommended) |
| `agenthub-1.0.1-plugins.zip` | A workstation that only writes code |
| `agenthub-1.0.1-hub.zip` | A server that only runs Workers |
| `agenthub-workers-1.0.1-minimax-plugin.zip` | MiniMax Code desktop / cloud (Plugin V1) |
| `multi-agent-hub-1.0.1.carts` / `.vsix` | Huawei CodeArts IDE, VS Code and compatible editors |

Build them yourself: `python packaging/build.py --output <dir outside the repo> --component all`. All options: [packaging/README.md](packaging/README.md).

---

## Development and testing

```bash
# Full isolated regression run (no model charges)
python tests/run_regressions.py --report docs/local-validation.json

# Console DOM / theme / reveal-collapse assertions
node --test tests/console_layout_theme_dom.mjs

# Scan the tree and Git history for leaked credentials
python scripts/audit_secrets.py --history

# Rebuild the offline demo after editing console/client/index.html
python scripts/build_demo.py

# Build release packages (outside the repo)
python packaging/build.py --output ../agenthub-releases
```

Optional: with these two installed, the real-SDK / real-CLI cases that are otherwise skipped also run:

```bash
pip install google-antigravity==0.1.21
npm i -g @openai/codex && export CODEX_TEST_BINARY=$(command -v codex)
```

Contribution rules (pre-commit checks, commit message format) are in [CONTRIBUTING.md](CONTRIBUTING.md); see also the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Version history

| Version | Focus |
| --- | --- |
| **1.0.1** | Adds the opencode and Cline Workers (11 total): config templates, capability declarations, NDJSON event-stream parsing, native sub-agents and every count aligned; both diagrams redrawn with larger type and higher contrast |
| 1.0.0 | First public release: audit cleanup, TraeClaw credit, handover docs scrubbed, Code of Conduct added, post-review fixes folded in |
| 0.9.9.9 | Redrawn architecture and roadmap diagrams, handover record |
| 0.9.9.8 | Node 20 WebSocket compatibility, path discovery for login and console, tests decoupled from hosts; contributing guide, security policy and English README |
| 0.9.9.7 | Linux source install fixes: lost exec bits, install from a checkout, loopback requests hijacked by a proxy |
| 0.9.9.3 – 0.9.9.6 | 9-Worker login state-detection refactor; systematic WebUI polish, 6 themes, glassmorphism and smart reveal/collapse |

![multi-agent-hub roadmap](docs/roadmap.en.svg)

Full details: [CHANGELOG.md](CHANGELOG.md) and [version history](docs/version-history.md).

---

## Documentation

**Getting started and deployment**
- [Running on Linux](RUN_ON_LINUX.md)
- [Packaging and all installer options](packaging/README.md)
- [Task options](docs/task-options.md)

**Host integrations**
- [Codex](integrations/codex/README.md) · [ZCode / MiniMax Code](plugins/agenthub-workers/README.md) · [DSH](integrations/dsh/README.md) · [Antigravity](integrations/antigravity/README.md)
- [CodeArts native plugin](integrations/codearts/README.md) · [CodeArts IDE & VS Code extension](integrations/vscode/README.md)
- [CodeArts two-way integration and auth boundaries](docs/codearts-compatibility.md) · [CodeArts IDE follow-up](docs/codearts-ide-followup.md) · [CodeArts with existing model routes](docs/codearts-custom-provider.md)

**Releases and acceptance**
- [Changelog](CHANGELOG.md) · [Version history](docs/version-history.md)
- [0.9.9 acceptance record](docs/release-0.9.9.md) · [Network discovery acceptance (v0.8)](docs/release-0.8.md)
- [Development handover](docs/HANDOVER_20261016.md)

---

## Acknowledgements

- [LobeHub / Lobe Icons](https://github.com/lobehub/lobe-icons): brand SVG icons used for the console and sub-agent avatars.
- [TraeClaw](https://github.com/firerlAGI/TraeClaw): the local bridge and CDP/DOM automation behind the `trae_delegate` channel.
- Huawei CodeArts, Google Antigravity, Tencent CodeBuddy, GitHub Copilot, Xiaomi MiMo, MiniMax, ByteDance Trae, Z.ai and their official CLIs and ecosystems.
- Everyone who sent feedback and suggestions.

## License

[Apache License 2.0](LICENSE): use, modify and distribute freely; derivative works must keep the copyright notice, license text and a statement of changes.
