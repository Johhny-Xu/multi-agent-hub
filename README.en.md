# multi-agent-hub

**English** · [简体中文](README.md)

![multi-agent-hub 0.9.9.6 architecture: any MCP client plugs in, 6 native deep-integration hosts, and a zero-client WebUI for standalone management — 9 Workers under one scheduler](docs/architecture.svg)

**multi-agent-hub** is a unified dispatch hub for AI agents across multiple development environments. Built on the standard MCP protocol, native plugins and a sub-agent system, it gives 9 mainstream AI coding Workers and 6 native deep-integration hosts (plus any MCP client) a single place to dispatch tasks, collect results, monitor quotas, manage accounts, and run a zero-client WebUI console. It offers three ways to plug in:

1. **Any MCP client works as-is.** Any client speaking standard MCP (Cursor, Claude Desktop, Windsurf, VS Code Cline / Roo Code, Continue, …) can schedule Workers across machines by pointing at the Hub's MCP URL, or by using the built-in one-click prompt.
2. **6 native deep-integration hosts, for a smoother experience.** **Codex**, **ZCode**, **MiniMax Code** (plus Claude Code / Agent Plugins 1.0), **DeepSeek Harness (DSH)**, **Huawei CodeArts** and **Antigravity** each get a purpose-built native plugin, a dedicated sub-agent set (`hub-*.md`), their own skills and slash commands, with context isolated automatically and no manual parameter wiring.
3. **Zero-client standalone use.** Even with no external IDE or AI client, the built-in **CodeBuddy-style three-pane WebUI console** handles platform session trees, immersive chat, task dispatch and monitoring, and full archive restore and cleanup on its own.

The current source version is **0.9.9.9**. **0.9.9.7**, **0.9.9.8** and **0.9.9.9** are three legs of one consolidation. 0.9.9.7 fixes the install path for a source checkout on Linux (lost exec bits, installing straight from a checkout, loopback requests hijacked by an environment proxy). 0.9.9.8 adds WebSocket compatibility on Node 20, path discovery in the login flow and the console, and decouples the tests from the host, and finishes the pre-open-source cleanup (contributing guide, security policy and English README added; credential path hint removed; 66 unreferenced test-evidence files moved out). 0.9.9.9 redraws both diagrams and adds the handover record. Before that, v0.9.9.3 → v0.9.9.6 built on the **9-Worker login-flow state-detection refactor and real credential alignment**, and focused on **systematic WebUI console polish, a global glassmorphism system for custom wallpapers, and the three-way smart hover reveal/collapse engine with sidebar decluttering**. It adds a persistent brand anchor in the top-left corner (`.brand-logo-pin`, click to toggle auto-collapse / always-pinned, persisted) and a cursor-aware reveal/collapse engine for the top bar, activity bar and platform sidebar (the activity bar stays pinned while a chat sidebar is expanded, so nothing jumps; the trigger zone was unified to the sidebar's full footprint). The theme presets grew to **6 complete light/dark palettes — Mocha, Shell, Aurora, Dusk, Cyber and Grid** (12 combinations, WCAG AA contrast calibrated). With a custom wallpaper or a high-end preset, a global Glassmorphism system and unified base neutral surfaces kick in (leftover grey surfaces 96 → 0, with `--gem-surface-high` kept as the carrier for interactive states and the progress track). The send button, context progress bar and every second-level menu in the chat area now follow the active sub-agent's brand colour (`--agent-accent`), while informational text such as model names strictly stays in the standard body colour (`--gem-text`). Sidebar cards were reduced to a single line (dropping the idle placeholder row, the magnifier icon, the ⌘K hint and the oversized capsule, so the "N sessions" badge is never clipped), and a single-file zero-dependency offline interactive Demo (`demo.html`) with an in-memory virtual driver engine was shipped.

---

### ✨ Highlights

- 🔌 **6 native host clients**: deep integration for Codex, ZCode, MiniMax Code (compatible with Claude Code / Agent Plugins 1.0), DeepSeek Harness, CodeArts and Antigravity, each with native sub-agents, slash commands and workflows.
- 🤖 **9 Workers under one contract**: Antigravity, CodeBuddy (international / China), GitHub Copilot, MiMo, MiniMax, TraeCode, ZCode and CodeArts. (The Antigravity native client is an added host role, not a tenth Worker.)
- 🎛️ **CodeBuddy-style three-pane console with smart hover reveal/collapse**: a built-in Web console (`--with-console`, port `8890`, binds `0.0.0.0` by default to expose it on the LAN) with a slim activity bar, a platform session tree, single-platform immersive chat (unified glassmorphism composer shell `.chat-composer-shell` plus adaptive model / thinking / streaming overlays docked left or right) and a collapsible right-hand workbench. A never-hiding brand anchor `#brand-logo-pin` sits in the top-left corner. The top bar (`Y ≤ 38px`), activity bar (`X ≤ 42px`) and platform sidebar (full-footprint hot zone) reveal and collapse smoothly on cursor presence, with anti-misfire buffering (locked while a modal is open, an input is focused, or the session sidebar is expanded). Also included: 35 greeting lines across 7 time-of-day bands, cross-platform global avatar replacement, archive filtering / restore / **top-right two-step confirmed clear-all**, and clipboard fallbacks for every network context.
- 🎨 **6 light/dark presets, wallpaper glassmorphism, and sub-agent accent propagation**: 6 presets — Mocha, Shell, Aurora, Dusk, Cyber, Grid — each with a complete light and dark palette and CSS-variable gradient backgrounds that follow the theme automatically. Light-theme status panels reach `14.27:1` to `15.27:1` contrast. With a custom wallpaper or a high-end preset, the top bar, chat header, composer, message bubbles, sidebar and right workbench all switch to translucent glass (`backdrop-filter: blur(20px~24px) saturate(180%~190%)`), and base neutral surfaces merge into the card colour `--gem-bg-card`. The send button, context progress bar and second-level menus in the chat area follow the active sub-agent's accent (`--agent-accent`), while model label text uses the standard body colour (`--gem-text`).
- 🖥️ **Zero-dependency single-file interactive Demo**: `scripts/build_demo.py` plus the in-memory virtual driver engine `demo_engine.js` produce a single-file pure-frontend demo (`demo.html` / `demo/index.html`) — the full three-pane console, theme switching and simulated dispatch, entirely offline, no backend required.
- 🔐 **OAuth login for all 9 Workers in the WebUI, with state detection and multi-account switching**: all 9 Workers (`minimaxcode`, `codebuddy`, `codebuddy-cn`, `github-copilot`, `antigravity`, `mimocode`, `traecode`, `zcode`, `codearts`) can be authorised, logged out, profiled (full Chinese / Unicode display names), switched between accounts with 44 ms optimistic UI, and given additional isolated sandbox accounts — all from the "Quotas & Accounts" panel, with no SSH terminal. It uses real on-disk credential state detection (no fake successes), and aligns with CodeBuddy's new XDG shared session storage and official state redemption watchdog, Trae's official PKCE flow, ZCode's China / international dual-region switching, MiMo's separation of API keys from account identity, and cancellation of login sessions with process reclamation (`POST /api/auth/cancel`).
- 🚀 **Native HTTP MCP endpoint for sub-agents**: a lightweight built-in HTTP MCP server (default `http://127.0.0.1:8790/mcp`) exposes `subagent_run` (waits server-side; oversized output is written to disk and only a summary returns, so it never consumes session context), `subagent_result`, `subagent_artifact` and `subagent_agents` to any AI client (Cursor, Claude Desktop, Antigravity, Windsurf, Cline, …). The console offers one-click **Copy MCP URL** and **Copy this text (send it to your agent)** — paste it into an agent and it configures itself.
- ⚡ **Per-sub-agent enable switch with two-way sync**: enable or disable any Worker from the WebUI (a sub-agent that is out of quota, or under debugging). The authoritative state is persisted immediately and picked up live by the Hub scheduler, the WebUI and every client plugin. Disabled Workers show `[已禁用]` in `hub_status` and are intercepted before dispatch (`profile_disabled`), so no compute or quota is wasted.
- 🎯 **A curated, de-duplicated production model catalogue**: each Worker is aligned to its vendor's real models and credit multipliers. Image-generation models that cannot do coding work, redundant platform aliases and previous-generation models were removed, leaving each vendor's current flagships and high-availability picks (for example MiniMax-M3 with a 1M context and M3.1-Flash-Preview with 512K, switchable via one capsule; custom model aliases can be deleted individually).
- 🔄 **Flexible deployment shapes**: plugins and the Hub can live on the same machine or on separate ones. Pure Windows, pure Linux, and Windows ↔ Linux cross-machine connections (direct LAN or SSH reverse tunnel) are all supported. A client connecting to one Hub is not a multi-Hub federation; model requests are still sent to the vendor by the official CLI.
- 🛡️ **Strict capability pre-checks and terminal-state determination**: thinking, streaming and attachments are constrained by model capability. CodeArts hosts are forced onto the single `tool_search → tool_describe → tool_call` path with one dispatch per task. Empty answers, known abnormal exits and partial answers after an agy timeout are rejected. The original task receipt (ref) is preserved, and a Worker cannot re-dispatch to itself.
- 🔍 **Smart discovery and smooth switching**: automatic broadcast scanning for LAN and local Hubs, with manual fallback. The MCP bridge reconnects and self-heals after a config restore. Connection settings and credentials live outside the source tree, so upgrades never lose task history.

---

## Native client integration and verification status

Each client connects through its own native plugin:

- **Antigravity native plugin**: ships `plugin.json`, 9 agents (`agents/*.md`), 4 skills (`skills/*/SKILL.md`) and an `mcp_config.json` with 8 bridge tools (including `hub_set_status`). An optional Python SDK pins `google-antigravity==0.1.21` and provides a typed `SubagentConfig` with serial and parallel orchestration. Note that the installed wheel does not include the `beta.run_workflow` API, and SDK authentication is independent of IDE/CLI login (without SDK credentials, SDK-orchestrated model calls are blocked).
- **CodeArts native plugin and driver**: 9 sub-agents, 3 slash commands, 1 dispatch skill, 1 hooks plugin and 8 MCP tools. It works in both directions — dispatching as a client, and being dispatched to as a Worker (`worker="codearts"`, aliases `ca`, `huawei-codearts`).
  - **Lazy-loading tool protocol and a single enforced path**: supports the CodeArts IDE dynamic tool registry and enforces the single standard path `tool_search` to discover → `tool_describe` for the parameter schema → `tool_call` to execute. Emitting XML tags directly from Markdown or plain-text reasoning is forbidden, which prevents double dispatch by the engine. After a single dispatch the client polls safely.
  - **Permission handling and terminal-state polling**: on host permission denial (Permission Denied / auto-rejecting) it stops immediately and returns `blocked_permission` with the original ref — it will not rename the tool or retry through a parent agent. Within the wait budget it keeps polling `hub_fetch` with the original ref, and only accepts a non-empty real Worker answer that meets the acceptance criteria as `completed`. A finished session or a successful tool call never stands in for a completed task.
  - **Accurate Windows CLI discovery and isolation**: identifies the official `installers/bin/codearts.exe` precisely and uses a dedicated `cli-data` directory and session database, so it is never confused with the IDE GUI AgentKernel. It inherits external authentication and keeps TLS verification on, and classifies "folder is not trusted" accurately as a redacted `CODEARTS_PERMISSION_REQUIRED`.
  - **Hardened Linux process lifecycle**: the driver and the Hub share process-group management, so cancellation and timeouts reclaim every descendant process with no orphans left behind.

| Check | Result | Notes |
| --- | --- | --- |
| Windows regressions & DOM assertions | ✅ Pass (32 suites + 7 DOM) | 32/32 regression suites pass (see `docs/refactor-validation.json`); WebUI layout / theme / glassmorphism / sidebar-declutter DOM assertions `tests/console_layout_theme_dom.mjs` 7/7. Not a full paid-model verification. |
| Linux regressions & load tests | ✅ Pass (29 suites + >4,500 load runs) | 360-concurrency peak with 0 errors (`/health` P95 1.25s), 60-concurrency quota Singleflight coalescing (P95 850ms), 100KB task + 30-concurrency state machine with zero corruption (see `docs/stage3-stress-report.json`, `docs/stage4-5-load-report.json`, `docs/stage6-compat-report.json`) |
| Linux production Hub 0.9.9.6 | ✅ Pass | Exposes 24 Hub tools and 9 Workers, with native quota monitoring for 9 vendors, multi-account switching, and the v0.9.9.6 smart reveal/collapse + glassmorphism WebUI console. Existing config, task history and auth were preserved through the upgrade. |
| Linux Antigravity CLI 1.3.1 | ✅ Real calls pass | gemini-3.8-flash-medium resolved exactly; plugin-mode validation passed (4 skills / 9 agents / 1 MCP). A real model call to `hub_status` returned all 9 Workers, and a full native sub-agent dispatch to `hub-mimocode` succeeded (`ref=mimocode-79e2416c91`, `completed`, `answer=95`) |
| Linux ZCode CLI 0.16.9 | ✅ Real calls pass | The native `agenthub-workers:mimocode` sub-agent dispatched through the plugin; polling the same ref returned `73` |
| Windows Codex / ZCode | ✅ Real calls pass | The two native sub-agents returned `2117` and `2077`; records where the first-round long-marker answer was incomplete were also kept |
| Windows DSH | ⚠️ Blocked by account balance | 10 presets, 7 MCP tools and workflow registration all pass; the actual model call returned `402 ACCOUNT_QUOTA` |
| Windows Antigravity | ✅ Real calls pass | Fixed a missing local `client.json` and added dynamic MCP connection retries; `hub_status` / `hub_capabilities` now return all 9 Workers online with capability state |
| Linux Codex & DSH CLI | ❌ Not installed (`not_installed`) | No CLI executable was found on the Linux host, so no live test was run and no pass is claimed |
| CodeArts native components & channels | ✅ Pass | The Windows production kernel recognises the components; the Linux CLI native files and MCP installation checks pass; Windows ↔ Linux direct LAN and SSH channels both establish correctly |
| Windows CodeArts IDE | ⚠️ Native dispatch passes, result retrieval permission-limited | A real DeepSeek v4.1 Flash call to `hub-mimocode` produced a single receipt `mimocode-d5f1337f8a`; the Linux side answered `45`, but the IDE's subsequent `hub_fetch` was denied by the host, so it is not counted as a complete acceptance |
| Linux CodeArts own-model calls | ✅ Official models return in seconds | Credential environment loaded automatically; explicit GLM-5.2 and GLM-5.2-ArkTS-SPARK dispatches returned completed results in seconds with valid receipts. Verified that the driver and CLI share a process group and that all processes exit cleanly afterwards. |
| Windows standalone CodeArts CLI | ⚠️ Not yet model-accepted | Official exe discovery and a CLI-specific config are fixed; the standalone directory probe is limited by folder trust, and does not replace the state of an already-logged-in IDE |

> **Boundaries and differences**
> 1. **Regression tests are not full paid-model testing.** The Windows 32-suite and Linux 29-suite passes are framework logic and offline regressions. They do not mean every vendor, model or native host has run a real paid task.
> 2. **Native plugins vs. the optional Python SDK.** The Antigravity native plugin wires into the MCP bridge and sub-agents through declarative config and has run real model calls and native sub-agent dispatch. The optional Python SDK is an external orchestration library; the current wheel has no `beta.run_workflow`, and its API authentication is isolated from host login.
> 3. **Uninstalled environments are reported honestly.** Codex and the DSH CLI are not installed on the Linux host, so they are marked `not_installed` rather than claimed as passing.
> 4. **CodeArts auth and call boundaries.** An IDE login does not mean the standalone CLI can call models, and a login to another service does not stand in for Huawei account permissions. The Worker currently exposes only default thinking and non-streaming text; a config that never took effect will not replace your existing default model.
> 5. **Local and network privacy.** A client selecting one Hub is not a cross-Hub federation. Prompts and attachments are still sent to the official model vendors when the corresponding Worker is invoked.

Full task receipts, source hashes, failure records and the 83 incremental checks on each side after the fixes are in the [0.9.9 acceptance record](docs/release-0.9.9.md).

CodeArts IDE-first adaptation, official auth fixes and the follow-up testing are in the [2026-10-10 follow-up record](docs/codearts-ide-followup.md). Those fixes came after the release; the original `v0.9.9` tag and its built ZIPs keep their original contents.

Example: install only the CodeArts client and connect to a remote Hub:

```powershell
# Windows
.\install.cmd --component plugins --native-hosts codearts --project C:\Work\my-project --url http://SERVER:8765/mcp --token-file C:\private\hub-token.txt
```

```bash
# Linux
./install.sh --component plugins --native-hosts codearts --codearts-target cli --url http://SERVER:8765/mcp --token-file /private/hub-token.txt
```

*Note: for the IDE, `--project` should point at the workspace actually open; you can also use `--codearts-ide-settings` to name the MCP config file. If it is omitted, the entry is marked as pending configuration. Reload the IDE or restart the CLI after installing. See the [CodeArts native package docs](integrations/codearts/README.md).*

### Connecting CodeArts to the Hub after switching workspaces

CodeArts IDE (26.9.501) loads `.codeartsdoer/mcp/mcp_settings.json` per workspace. When you switch to a new project you do not need to re-enter the Hub token or start a local Hub — reuse the external `client.json`:

```powershell
# Register the IDE MCP settings for the current workspace
python integrations/codearts/install.py --config "$env:LOCALAPPDATA/AgentHub/client.json" --ide-settings "C:/Work/new-project/.codeartsdoer/mcp/mcp_settings.json" --target ide --apply
```

Then run "Developer: Reload Window" in the IDE and verify the connection and Worker availability with `/hub-status`. See the [CodeArts native package docs](integrations/codearts/README.md#换工作区后连接-hub).

---

## 🚀 Quick start

The project offers a minimal, scenario-based path in for different working habits:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                     Pick the installation path that suits you          │
├────────────────────────────────────────────────────────────────────────┤
│ 0. Laziest · send one sentence to your agent → paste the prompt below  │
│ 1. Easiest · local one-click      → double-click install.cmd / install.sh │
│ 2. Any AI client, direct          → add http://127.0.0.1:8790/mcp (10s) │
│ 3. Cross-machine (server + client)→ Hub on the server, client connects │
│ 4. 6 native hosts, install one    → CodeArts/MiniMax/ZCode/Codex/DSH/AGY │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 🤖 Option 0: no manual work — paste one sentence into your AI agent (most recommended ⭐⭐⭐⭐⭐)

You do not need to remember commands or hunt for config files. Pick the client you are using and **copy the matching sentence below into your AI assistant** — it will clone, install and configure everything for you.

#### 🅰️ Type 1: the 6 native deep-integration clients (installs the dedicated sub-agents, skills and commands)

- **🌟 Generic sentence for any native host (Antigravity / CodeArts / ZCode / Codex / DSH / MiniMax Code)**:
  ```text
  Please clone https://github.com/Johhny-Xu/multi-agent-hub.git locally, read its README.md, and run the matching install.cmd (Windows) or ./install.sh (Linux/macOS) for the client I am using, to install the Multi-Agent Hub service and the native deep-integration plugin for this client (sub-agents, Skills and the MCP bridge). Then call hub_status to verify the connection.
  ```

- **🎯 Per-client sentences (copy only the line for your client)**:
  - **For Google Antigravity**:
    ```text
    Please clone https://github.com/Johhny-Xu/multi-agent-hub.git, run install.cmd (use ./install.sh on Linux) with --native-hosts antigravity, install the Multi-Agent Hub native plugin and its 9 hub-* sub-agents into ~/.gemini/config/plugins/multi-agent-hub, and start the Hub service.
    ```
  - **For Huawei CodeArts (IDE / CLI)**:
    ```text
    Please clone https://github.com/Johhny-Xu/multi-agent-hub.git and run install.cmd --native-hosts codearts --project <current project path> for this workspace (use ./install.sh on Linux), to install the Multi-Agent Hub service and register it with this workspace's .codeartsdoer/mcp/mcp_settings.json along with the dedicated sub-agents.
    ```
  - **For MiniMax Code (`mcode`) / Claude Code**:
    ```text
    Please clone https://github.com/Johhny-Xu/multi-agent-hub.git, start the Multi-Agent Hub service, and load the repository's plugins/agenthub-workers directory into my current client as a native plugin (it contains .minimax-plugin/plugin.json, .claude-plugin/plugin.json, hub-bridge.mcp.json and the dispatch-hub skill).
    ```
  - **For ZCode (IDE / CLI)**:
    ```text
    Please clone https://github.com/Johhny-Xu/multi-agent-hub.git, run install.cmd --native-hosts zcode (use ./install.sh on Linux), register the plugins/agenthub-workers native plugin (with its 9 external Worker sub-agents and MCP bridge) into my ZCode environment, and start the Hub.
    ```
  - **For OpenAI Codex**:
    ```text
    Please clone https://github.com/Johhny-Xu/multi-agent-hub.git and run install.cmd --native-hosts codex --project <current project path> for this workspace (use ./install.sh on Linux), to configure the Codex native plugin marketplace and the .codex/agents/ routing rules automatically.
    ```
  - **For DeepSeek Harness (DSH)**:
    ```text
    Please clone https://github.com/Johhny-Xu/multi-agent-hub.git and run install.cmd --native-hosts dsh (use ./install.sh on Linux), or mount the native presets and workflow plugin with dsh plugin add file:./integrations/dsh.
    ```

#### 🅱️ Type 2: any generic MCP client (Cursor / Windsurf / Claude Desktop / Cline / Roo Code / Continue, …)

- **🌐 Hub already running (local or LAN) — 10-second one-sentence setup**:
  ```text
  Please add a Streamable HTTP MCP server named "multi-agent-hub" to my current client's MCP config file, with the URL http://127.0.0.1:8790/mcp (replace the IP if the Hub is on a LAN server). Once configured, call the subagent_agents tool to list the available external sub-agents.
  ```
- **🛠️ From scratch (let a generic client clone, start the service and write the MCP config) — one sentence**:
  ```text
  Please clone https://github.com/Johhny-Xu/multi-agent-hub.git, run its install.cmd (use bash install.sh on Linux) to start the Multi-Agent Hub and the Web console (ports :8890 / :8790), then write http://127.0.0.1:8790/mcp into my current client's MCP config file automatically.
  ```

---

### Option 1: easiest — local one-click install (recommended ⭐⭐⭐⭐⭐)

> **Best for**: developing on a single machine (Windows or Linux), and wanting the Hub service, the WebUI console and any existing IDE plugins configured in one go.

#### Step 1: get the code
- **Via Git clone (latest v0.9.9.9 source, recommended)**:
  ```bash
  git clone https://github.com/Johhny-Xu/multi-agent-hub.git
  cd multi-agent-hub
  ```
- **Via a Release bundle**:
  Download the latest prebuilt package (for example `agenthub-0.9.9.9-both.zip`) from [Releases](https://github.com/Johhny-Xu/multi-agent-hub/releases) and unzip it.

#### Step 2: install and start in one step
- **Windows**: double-click **`install.cmd`** in the repository root (or run `.\install.cmd` in a terminal).
- **Linux**: run **`bash install.sh`** in a terminal.

> 💡 **Automatic diagnosis and registration**: the installer checks the environment, installs the Hub service and Web console, and auto-detects and registers the Codex, ZCode, DSH, CodeArts and Antigravity native plugins and dedicated sub-agents already on the machine.

#### Step 3: start using it
- Open **`http://localhost:8890`** in a browser for the three-pane Web console (or double-click the repository's `demo.html` to explore the full frontend offline).
- Or bring up the sub-agents directly from an IDE you already have installed.
- **Day-to-day start/stop**: double-click or run `start.bat` (`bash start.sh` on Linux); to stop, run `stop.bat` (`bash stop.sh` on Linux).

---

### Option 2: no plugin needed — any AI client in 10 seconds (direct MCP ⭐⭐⭐⭐⭐)

> **Best for**: Cursor, Claude Desktop, Windsurf, VS Code (Cline / Roo Code / Continue) or any other MCP-capable host. No extension or plugin installation required.

Start the Hub locally, then hand the standard HTTP MCP endpoint to the client:

- **MCP endpoint**: `http://127.0.0.1:8790/mcp`
- **The more comfortable route**: open the Web console (`http://localhost:8890`) and click **Copy this text (send it to your agent)** on the "sub-agent endpoint" card. Paste the resulting prompt into your AI assistant and it will write the client's MCP config for you.
- **Manual JSON reference**:
  ```json
  {
    "mcpServers": {
      "multi-agent-hub": {
        "url": "http://127.0.0.1:8790/mcp"
      }
    }
  }
  ```

---

### Option 3: cross-machine deployment (server and client separated)

> **Best for**: running the Hub and the 9 CLI Workers on a home server, NAS or cloud machine (Linux / Windows), while writing code on a separate personal computer.

#### Step A: install and start the Hub on the server
```bash
# Run on the server: bind the LAN address and enable the Web console
bash install.sh --component hub --bind 0.0.0.0 --port 8765 --with-console
```
*Note: the installer generates a strong random connection token file, `hub-token.txt`.*

#### Step B: install the native plugin on the client and pair it
```powershell
# Windows client pairs by naming the target server and token
.\install.cmd --component plugins --url http://SERVER_IP:8765/mcp --token-file C:\private\hub-token.txt
```
- **Automatic broadcast discovery**: if `--url` is not given on first install, the client scans the LAN for candidate Hubs over UDP broadcast and lets you pick one interactively.
- **Re-pick or switch Hubs at any time**: run `connect.cmd` (`./connect.sh` on Linux) later to rediscover or switch the target Hub.
- **SSH reverse tunnel**: if the two machines are not on the same LAN, map the port over SSH (for example `ssh -N -R 127.0.0.1:18765:127.0.0.1:8765 user@SERVER`).
- **Linux service**: add `--systemd-user` to register the Linux Hub as a standard user-level systemd service.

---

### Option 4: import or install the 6 native host plugins individually

> **Best for**: importing or registering the native plugin for one specific IDE / CLI only (including its dedicated sub-agents `hub-*.md`, skills `SKILL.md`, slash commands and workflows).

| Native host | How to import / install it alone | Plugin directory and docs |
| --- | --- | --- |
| **1. Huawei CodeArts / VS Code** | • **GUI extension**: in the IDE's Extensions panel choose "Install from VSIX/CARTS…" and import `multi-agent-hub-0.9.9.9.carts` or `.vsix`<br>• **Command line**: `.\install.cmd --component plugins --native-hosts codearts --project <workspace path>` | [`integrations/codearts`](integrations/codearts/README.md) & [`integrations/vscode`](integrations/vscode/README.md) |
| **2. MiniMax Code / Claude Code** | • **Desktop / cloud plugin bundle (MiniMax Plugin V1)**: import `agenthub-workers-0.9.9.9-minimax-plugin.zip` directly (contains `.minimax-plugin/plugin.json`)<br>• **CLI (`mcode` / `claude`)**: `mcode --plugin-dir ./plugins/agenthub-workers` (contains `.claude-plugin/plugin.json` and an Agent Plugins 1.0 `plugin.json`) | [`plugins/agenthub-workers`](plugins/agenthub-workers/README.md) |
| **3. ZCode IDE / CLI** | • **Automatic registration**: `.\install.cmd --component plugins --native-hosts zcode`<br>• **Discovery page / local config**: add this repository on ZCode's plugin discovery page, or set `{"plugins":{"enabled":true,"dirs":[".../plugins/agenthub-workers"]}}` in `zcode.json` | [`plugins/agenthub-workers`](plugins/agenthub-workers/README.md) |
| **4. OpenAI Codex** | • **Automatic registration**: `.\install.cmd --component plugins --native-hosts codex --project <workspace path>`<br>• Registers a local plugin marketplace and writes the 9 sub-agents and workflows into the target workspace's `.codex/agents/` | [`integrations/codex`](integrations/codex/README.md) |
| **5. DeepSeek Harness (DSH)** | • **Automatic registration**: `.\install.cmd --component plugins --native-hosts dsh --profile agenthub-client`<br>• **Manual bundle mount**: `dsh plugin --profile <PROFILE> add file:./integrations/dsh --ignore-scripts` | [`integrations/dsh`](integrations/dsh/README.md) |
| **6. Google Antigravity** | • **Automatic registration**: `.\install.cmd --component plugins --native-hosts antigravity`<br>• Installs the native plugin (skills + 9 `hub-*` sub-agents + MCP bridge) into `~/.gemini/config/plugins/multi-agent-hub`; restart Antigravity to take effect | [`integrations/antigravity`](integrations/antigravity/README.md) |

---

### 📦 Prebuilt packages and runtime requirements

> *Note: the table lists the `v0.9.9.9` prebuilt artifacts, matching the current source version. You can also build from source with `python packaging/build.py --output <dir> --component all`.*

| Package | Environment | Contents |
| --- | --- | --- |
| **agenthub-0.9.9.9-both.zip** | Client and Hub on the same machine (most recommended) | All components, the install wizard, and service management scripts |
| **agenthub-0.9.9.9-plugins.zip** | A client machine used only for writing code | Native plugins for multiple hosts, the MCP bridge, sub-agents and workflows |
| **agenthub-0.9.9.9-hub.zip** | A server machine running only Workers and models | Python Hub service, 9 Worker adapter drivers, optional WebUI console |
| **agenthub-workers-0.9.9.9-minimax-plugin.zip** | MiniMax Code desktop / MiniMax Agent cloud / Marketplace | A zero-wrapper standalone plugin package conforming to MiniMax Plugin V1 |
| **multi-agent-hub-0.9.9.9.carts / .vsix** | Huawei CodeArts IDE, VS Code and compatible editors | Desktop GUI extension: one-click import, sidebar panel, status indicator |

- **Runtime requirements**:
  - **Base environment**: Python 3.8+ (Codex agent installation needs Python 3.11+); Node.js 20+ (for the MCP bridge and Web console).
  - **Worker model environment**: requires each vendor's official CLI (such as `agy`, `cb`, `trae`, `codearts`) and its official login state. The installer only probes the environment and invokes commands; it does not register accounts or log in for you.
- For more advanced parameters see [package build and full parameter reference](packaging/README.md).

---

## Web console (Console & WebUI)

The Hub ships a lightweight, modern Web console (enable it with `--with-console` at install or start time; it runs on Node.js port `8890`, binds `0.0.0.0` by default and is reachable on the LAN):

- 🎛️ **CodeBuddy-style three-pane console with a smart reveal/collapse engine**:
  - **Persistent brand anchor (`#brand-logo-pin`)**: fixed in the top-left corner (`z-index: 120`) and never hidden. Clicking it toggles the top bar and activity bar between "auto reveal/collapse" and "always pinned" and persists the choice. When both are collapsed it adds safe clearance automatically.
  - **Smart top bar and slim activity bar**: a minimal two-view switch between Chat and Settings (sub-agents and the quota hub, task queue and cross-agent shared notes live inside), with the navigation sinking to the bottom bar on mobile. On desktop, moving the cursor to the top edge (`Y ≤ 38px`) or left edge (`X ≤ 42px`) reveals them smoothly after a 90 ms anti-misfire check; leaving collapses them after a 650 ms debounce into immersive focus mode, and they stay pinned while the platform session sidebar is expanded or a modal / input has focus.
  - **Platform session tree, reduced to single-line cards**: the sidebar slides out when the cursor enters its full footprint (`X ≤ 324px` at a `1440px` viewport). The contentless "idle · click to start a chat" placeholder row was removed so cards stay single-line (a row is mounted on demand when an async summary or last message exists, via `/api/chat/agent-summary`); the search magnifier icon and the ⌘K hint were removed and the quota / cache capsules were narrowed, so the "N sessions" badge renders completely unclipped on all 9 cards.
  - **Immersive central chat area**: the chat header is a single capsule combining the sub-agent avatar (click to switch between the 9 sub-agents) and the current session name (click to switch sessions); New / Clear / Export moved into a "⋯" overflow menu, with a separate Workbench button on the right (on narrow screens it no longer auto-covers the chat full-width, showing an edge handle instead). The top bar (`z-index: 100`) and chat header (`z-index: 50`) get independent stacking contexts, so dropdowns are never clipped by code blocks or the workbench.
- 🎨 **6 light/dark presets, wallpaper glassmorphism and sub-agent accent propagation**:
  - **6 complete light/dark palettes**: **Mocha** (`#1e1e2e` / Latte `#eff1f5`), **Shell** (`#0f0f11` / Paper `#f8f9fa`), **Aurora** (`#0B0F19`), **Dusk** (`#18121D`), **Cyber** (`#070913`) and **Grid** (`#0A0F1E`) — 12 combinations in total. Gradient backgrounds are collapsed into CSS variables that follow the light/dark theme, and status panel text contrast in light themes reaches `7.99:1` to `15.27:1`, well beyond WCAG AA.
  - **Global glassmorphism for custom wallpapers (`body.has-custom-bg`)**: when you upload a local or remote wallpaper, or pick the Aurora / Dusk / Cyber / Grid presets, the top bar, chat header, composer, user message bubbles, sidebar and right workbench all become translucent glass (`backdrop-filter: blur(20px~24px) saturate(180%~190%)`). Base neutral surfaces merge entirely into the card colour `--gem-bg-card` (leftover grey surfaces went from 96 to 0), keeping only `--gem-surface-high` as the carrier for interactive states, the quota progress track and selected rows.
  - **Sub-agent accent propagation (`--agent-accent`)**: switching sub-agents updates in real time the send button's dark gradient, the context progress bar's inner fill, and every second-level menu in the `#panel-chat` chat area (model and run-parameter popover badges / selected-row bars / checkmarks / thinking levels / confirm buttons, the status bar's display-item popover, chat header menu icons, input focus outlines). The model capsule under the composer and the model name in the status bar stay in the standard greeting body colour `var(--gem-text)`, balancing brand recognition with comfortable reading.
- 🖥️ **Single-file zero-dependency interactive Demo (`demo.html`)**:
  - `scripts/build_demo.py` and the in-memory virtual driver engine `demo_engine.js` produce a single-file pure-frontend demo (written to both `demo.html` and `demo/index.html`). No Node or Python backend is needed — open it in any browser for the full UI/UX and simulated task interaction, offline.
- 📦 **Aggregated archive with one-click batch delete**:
  - Aggregates history across all platforms, folding platform filtering and sorting into a single funnel-icon menu (project / timeline views; sort by update or creation time) with live fuzzy search in the input box.
  - Supports one-click restore of a session back into the active conversation tree (located and opened automatically), permanent single-item deletion, and a top-right **Delete all** with an inline two-step confirmation. Opening an agent's conversation clears the unread dot on all of its sessions.
- 🚀 **Native HTTP MCP endpoint and config generation**:
  - A lightweight built-in HTTP MCP server (default `http://127.0.0.1:8790/mcp`) exposes four core tools to any AI host: `subagent_run` (waits server-side; oversized output is written to disk locally and only a summary is returned, so session context is not consumed), `subagent_result`, `subagent_artifact` and `subagent_agents`.
  - The console offers **Copy MCP URL** and **Copy this text (send it to your agent)**, generating a complete prompt with the tool list, a JSON config template and usage guidance — send it to any AI agent and MCP registration is done automatically.
- 📋 **Robust clipboard fallback on any network context**:
  - On LAN IPs (insecure context, `window.isSecureContext=false`) modern browsers silently block `navigator.clipboard`. A multi-layer fallback through a native textarea and `execCommand` keeps copy working 100% of the time, everywhere.
- 🔘 **Per-Worker enable switch and optimistic account switching**:
  - Every Worker card has a native enable toggle whose state is persisted immediately to `agents.json` and takes effect across all clients. A unified "🔐 Log in / Add account" entry, real on-disk credential state detection, 44 ms optimistic UI account/context switching, and Chinese / Unicode account profiles are all supported.
- ⚡ **Authoritative two-way state sync with pre-dispatch interception**:
  - A disabled Worker shows `[已禁用]` in `hub_status` and returns `enabled: false` from `hub_capabilities`. Dispatching (`hub_dispatch` / `hub_ask`) triggers a fast pre-check (`profile_disabled`), preventing pointless waits and quota alerts from stray calls.
- 🌟 **Time-of-day greetings, avatar customisation and community touches**:
  - 35 warm greeting lines across 7 fine-grained time-of-day bands, shown at random on each entry or platform switch.
  - Click the avatar to pick a local image and replace it globally across platforms, persisted and synced (with vertical stretching removed in the top bar and a unified global squircle radius and logo standard).
  - A light, elegant footer: an open-source nod on the left (with a "eat well first" easter egg), a one-click GitHub Star in the middle, and the current version (`v0.9.9.9`, dynamically overridable via the backend `snap.version`) on the right.
- 🎛️ **Customisable status bar panel and model drawer**:
  - The whole status bar is clickable as one surface (clicking anywhere opens the display-item config panel centred just above the click point, clamped to the container, where you can tick model, network latency, throughput TPS, session tokens, platform quota and more). The model picker supports left/right adaptive docking, condensed thinking-level labels (`model · thinking level`), a two-stage deep-thinking capsule (`default / on / off`) and a streaming toggle, and lets you delete individual custom model aliases.
- 🏷️ **Official credit multipliers and promotional badges**:
  - Deep integration with TraeCode, CodeBuddy-CN and other platforms' credit multipliers, showing `0.06x ~ 2.00x` conversion rates alongside dedicated visual badges such as `[会员 5 折]`, `[限时 1 折]` and `[专属补贴]`.
- 💳 **Live quota and channel balance monitoring**:
  - The native `console/vendor-quota.mjs` module fetches quotas for all 9 vendors in real time, with a 60 s TTL cache and Singleflight request coalescing. It supports one-click switching between MiniMax's `512K` and `1M` context tiers and shows remaining upstream channel quota.

---

## Unified tools and capability constraints

Host plugins expose **7 core dispatch MCP tools** (plus the sub-agent state management extensions `hub_set_status` / `hub_set_agent_status`, for 8 bridge tools in total):
`hub_ask`, `hub_dispatch`, `hub_fetch`, `hub_status`, `hub_capabilities`, `hub_login`, `hub_discover`.

Every host (Codex agents/skills, ZCode agents, the MiniMaxCode plugin, DSH presets/workflows, CodeArts sub-agents, Antigravity skills/agents) follows the same task contract:

| Worker | Default model | Platform traits, catalogue curation and multiplier rules |
| --- | --- | --- |
| **Antigravity** | gemini-3.8-flash-medium | Condensed to 6 flagships including 3.8 Flash (High/Medium), 3.1 Pro High and Claude 4.6 (Sonnet/Opus); supports multimodal input and standard workflows (as a Worker role; the Antigravity native client is a host role) |
| **CodeBuddy** (China) | deepseek-v4.1-flash (x0.11) | Image-generation and legacy models removed, condensed to 13 coding models including DeepSeek V4.1/Pro, MiniMax-M3, GLM-5.3/5.2/5.1, Kimi-K3/K2.8/K2.7 and the Hunyuan series, with official multipliers (`x0.06 ~ x2.00`) and trial badges. Aligned with XDG shared session storage and the state redemption watchdog |
| **CodeBuddy** (International) | deepseek-v4.1-flash | Condensed to 18 mainstream high-availability models; file tools require real permissions, and a standard proxy isolates context |
| **GitHub Copilot** | auto | Follows the official CLI's model selection; supports WebUI device-code login and GNOME Keyring read/write |
| **MiMo** | xiaomi/mimo-v2.6-flash (26f) | Condensed to 4 high-efficiency picks including MiMo-V2.6 Flash/Pro/UltraSpeed; the API-key channel is separated from Xiaomi OAuth account identity |
| **MiniMax** | MiniMax-M3 | Condensed to the season's two flagships — M3 (1M context) and M3.1-Flash-Preview (512K context) — with a one-click context capsule and `oauth.account` display-name detection |
| **TraeCode** | GLM-5.3-FlashX (0.31x) | Condensed to 20 official models with precise `0.06x ~ 1.50x` credit multipliers and `[会员 5 折]` / `[限时 1 折]` / `[专属补贴]` badges; supports dual-region PKCE OAuth and the TraeClaw gateway |
| **ZCode** | GLM-5.3-Flash | Supports China (BigModel) / international (Z.ai) dual-region switching and `enc:v1:` AES-256-GCM encrypted storage; explicit thinking toggle, with unverified body streaming disabled by default |
| **CodeArts** | GLM-5.2 (0.70x) | Keeps all 4 enterprise official models (`GLM-5.2`, `GLM-5.2-ArkTS-SPARK`, `OpenPangu-2.0-Pro`, `OpenPangu-2.0-Flash`); supports automatic AK/SK loading for the Linux CLI, the IDE dynamic tool protocol and separate data isolation |

The table above is the default for new installations. Existing servers keep their current models; this round's Linux MiMo test reused the server's existing configuration and does not mean `26f` was tested.

- **Input file limits**: the `files` parameter transfers the client's local file contents and stages them on the Hub, capped at 8 files and 1 MiB in total.
- **Working directory**: `cwd` refers to a working directory **on the Hub's host**. Client paths are never silently mapped.
- **Results and task tracking**: an accepted task returns a persistent `ref`; the client polls for the result through `hub_fetch` with that `ref` and never needs to re-dispatch. The Hub rejects empty answers, known timeouts and incomplete tool protocols. `completed` means the task finished executing — whether the answer is correct still has to be accepted by the caller against the task requirements.
- For detailed parameter specifications see the [task options reference](docs/task-options.md).

---

## Data flow and security

- **The real data path**: `host client → local MCP bridge → target Hub → official CLI / kernel → vendor model API`.
- **Nothing hidden**: a self-hosted Hub is only a task router and execution proxy, not an offline private model. Prompts and attachments are sent to the vendors as part of the official CLI call.
- **Credential isolation**: client and server auth tokens, vendor API keys and session data all live in dedicated directories outside the source tree and are never committed to Git.
- **Transport security**: the HTTP Bearer token only authenticates identity. When communicating across the public internet or an untrusted network, always add HTTPS via a reverse proxy, a VPN or an SSH tunnel.

---

## Version history and development

**0.9.9.9** redraws both diagrams and adds the handover record; **0.9.9.8** adds WebSocket compatibility on Node 20, path discovery and test decoupling; **0.9.9.7** fixes the source-checkout install path on Linux and finishes the pre-open-source cleanup; **0.9.9.6** focuses on WebUI console polish, the 6 light/dark presets and wallpaper glassmorphism system, the persistent brand anchor and three-way smart reveal/collapse engine, full sub-agent accent propagation, and single-line sidebar cards:

![multi-agent-hub 0.9.9.6 roadmap: current focus on WebUI polish, the wallpaper glassmorphism system and the smart reveal/collapse engine, showing existing foundations, key results, version evolution and actual verification scope](docs/roadmap.svg)

### Offline regressions, frontend assertions and security checks

```bash
# Clone the repository
git clone https://github.com/Johhny-Xu/multi-agent-hub.git
cd multi-agent-hub

# Full isolated regression run (no real model costs)
python tests/run_regressions.py --report docs/local-validation.json

# WebUI console DOM structure, theme colours and smart reveal/collapse assertions
node --test tests/console_layout_theme_dom.mjs

# Scan source and Git history for credential / privacy leaks
python scripts/audit_secrets.py --history

# Rebuild the single-file offline interactive demo (updates demo.html and demo/index.html)
python scripts/build_demo.py

# Build the distribution packages (output outside the repository)
python packaging/build.py --output ../agenthub-releases
```

---

## Related documentation

- [Latest handover and v0.9.9.6 status](docs/HANDOVER_20261015.md)
- [CodeArts two-way integration, live tests and auth boundaries](docs/codearts-compatibility.md)
- [CodeArts IDE-first adaptation and follow-up testing](docs/codearts-ide-followup.md)
- [Connecting CodeArts to an existing model router](docs/codearts-custom-provider.md)
- [Antigravity native plugin and optional SDK](integrations/antigravity/README.md)
- [Network auto-discovery and pairing acceptance report (v0.8)](docs/release-0.8.md)
- [Standalone packages and distribution](packaging/README.md)
- [Unified task options and parameter definitions](docs/task-options.md)
- [Version history and checkpoints](docs/version-history.md)
- [Changelog](CHANGELOG.md)
- [Codex plugin and sub-agent integration](integrations/codex/README.md)
- [ZCode / MiniMaxCode native plugin integration](plugins/agenthub-workers/README.md)
- [DSH presets and workflow integration](integrations/dsh/README.md)
- [CodeArts native plugin and command integration](integrations/codearts/README.md)
- [CodeArts IDE & VS Code desktop extension (CARTS / VSIX)](integrations/vscode/README.md)
- [Contributing guide](CONTRIBUTING.md) — currently written in Chinese
- [Security policy](SECURITY.md) — currently written in Chinese

---

## Acknowledgements

- 🎨 **Brand vector icons and avatar standards**: thanks to [LobeHub / Lobe Icons](https://github.com/lobehub/lobe-icons) for the refined, high-quality tech and AI brand SVGs that give the Web console and every sub-agent avatar a clean, standard native vector foundation.
- 🤖 **Vendor kernels and developer ecosystems**: thanks to Huawei CodeArts, Google Antigravity, Tencent CodeBuddy, GitHub Copilot, Xiaomi MiMo, MiniMax, ByteDance Trae, Z.ai and others for their official CLI kernels and open ecosystems.
- 💖 **Open-source community**: thanks to every developer who gave feedback and suggestions on multi-model dispatch, cross-platform native integration and the Web console.

---

## License

This project is licensed under the [Apache License 2.0](LICENSE) — use, modification and distribution are permitted; derivative works must retain the original copyright notice, the license text and a description of changes, and the patent grant and trademark protection clauses apply.
