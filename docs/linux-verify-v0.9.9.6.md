# Linux-side Verification — multi-agent-hub v0.9.9.6

## 1. Host facts

| Item | Value |
|---|---|
| `uname -a` | `Linux prod-node 7.0.0-30-generic #30~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug  7 13:27:52 UTC 2 x86_64 x86_64 x86_64 GNU/Linux` |
| node | v22.23.1 |
| python | Python 3.12.3 |
| cores | 4 |
| repo path | `/home/<user>/multi-agent-hub` |
| git status | HEAD detached at `v0.9.9.6`, working tree clean |
| exact commit | `b8ff309` — `docs: record the v0.9.9.6 release run and its environment limits` |
| tag | `v0.9.9.6` (`git describe --tags --exact-match`) |
| output dir | `/home/<user>/ah-release-v0.9.9.6/` |
| regression report | `/home/<user>/ah-linux-regressions.json` |

> Note: this host's hostname is `prod-node`. The literal `prod-node` must NOT appear inside any shipped artifact; it appears here only as host fact in this report.

## 2. Artifact table

All artifacts written to `/home/<user>/ah-release-v0.9.9.6/`. SHA256 values are the SHA256 of the file as written to disk and match the values in `SHA256SUMS`.

| File | Bytes | SHA256 |
|---|---:|---|
| `agenthub-0.9.9.6-hub.zip` | 434,802 | `839b7540405ed1e2d5d1ed015c65e3fddb1ddfb16467fbe713aefb14a492edff` |
| `agenthub-0.9.9.6-plugins.zip` | 637,821 | `7dff8bfe84f169802f471c33d69d23690d3c318044d144a24f4baaccd8625c0e` |
| `agenthub-0.9.9.6-both.zip` | 1,022,621 | `1408a71e80e52885d433cf5edcd0a7b945b6e0af9f543874dcb902121fbcd37b` |
| `agenthub-workers-0.9.9.6-minimax-plugin.zip` | 211,928 | `a445ae4e8fc6928d8dbe70ca58d3982bdd5ed292e17255118d63a501499b1596` |
| `multi-agent-hub-0.9.9.6.vsix` | 78,791 | `54be0dbd6e14e47129c322f864952ab0158da6bdcdc5c1358111aca2be5c0fcd` |
| `multi-agent-hub-0.9.9.6.carts` | 78,791 | `54be0dbd6e14e47129c322f864952ab0158da6bdcdc5c1358111aca2be5c0fcd` |
| `multi-agent-hub-0.9.9.6.cloudide` | 78,791 | `54be0dbd6e14e47129c322f864952ab0158da6bdcdc5c1358111aca2be5c0fcd` |

The three extension files share an identical SHA256 — they are byte-identical packages renamed for three marketplaces (as reported by `package_extensions.py`). The internal manifest inside the VSIX/CARTS/CloudIDE payload should be checked separately if you want to confirm the manifest field still says `0.9.9.6` for the extensions; that was not part of this task's required checks.

## 3. Verification results (Task 2)

### 3.1 `sha256sum -c SHA256SUMS`

All seven lines report `OK`:

```
agenthub-0.9.9.6-both.zip: OK
agenthub-0.9.9.6-hub.zip: OK
agenthub-0.9.9.6-plugins.zip: OK
agenthub-workers-0.9.9.6-minimax-plugin.zip: OK
multi-agent-hub-0.9.9.6.vsix: OK
multi-agent-hub-0.9.9.6.carts: OK
multi-agent-hub-0.9.9.6.cloudide: OK
```

### 3.2 ZIP structure & `manifest.json` version

| ZIP | Entries | Root contains wrapper dir? | `manifest.json` in archive? | `SHA256SUMS` in archive? | `version` in `manifest.json` |
|---|---:|---|---|---|---|
| `agenthub-0.9.9.6-hub.zip` | 52 | yes (`agenthub-0.9.9.6-hub/`) | yes (in root of wrapper) | yes | `0.9.9.6` |
| `agenthub-0.9.9.6-plugins.zip` | 153 | yes (`agenthub-0.9.9.6-plugins/`) | yes | yes | `0.9.9.6` |
| `agenthub-0.9.9.6-both.zip` | 182 | yes (`agenthub-0.9.9.6-both/`) | yes | yes | `0.9.9.6` |
| `agenthub-workers-0.9.9.6-minimax-plugin.zip` | 31 | **no wrapper dir** (flat layout) | **no** (expected — note explicitly) | **no** (expected) | n/a — no `manifest.json` |

The `agenthub-workers-*-minimax-plugin.zip` archive is intentionally a flat payload (`.claude-plugin/`, `.minimax-plugin/`, `.zcode-plugin/`, `agents/`, `commands/`, `mcp/`, `skills/`, `scripts/`, `assets/`, `plugin.json`, `hub-bridge.mcp.json`, `LICENSE`, `README.md`, `icon.png`). Per the task spec, this archive is **expected** to NOT contain `manifest.json` or `SHA256SUMS` — that holds.

### 3.3 Forbidden-string scan

Searched every entry of every shipped archive (4 ZIPs + 3 VSIX-class packages) for the regexes:

- `0\.9\.9\.2` (old version string)
- `192\.168\.\d+\.\d+` (real private-LAN address)
- `/home/<user>` (developer home path)
- `prod-node` (host name token)

Result: **0 hits** across all archives.

## 4. Regression results (Task 3)

`python3 tests/run_regressions.py --report /home/<user>/ah-linux-regressions.json`

- **passed_suites: 28 / failed_suites: 1 / total: 29**
- `source_changed_during_run`: `[]` (clean)

### Per-suite results

| Suite | Result | Duration (s) |
|---|---|---:|
| hub_core | PASS | 4.97 |
| runtime | PASS | 4.31 |
| task_contract | PASS | 2.00 |
| capability_availability | PASS | 0.83 |
| worker_output | PASS | 0.21 |
| live_probe_validation | PASS | 0.25 |
| **login_manager** | **FAIL** | **0.38** |
| codex_adapter | PASS | 2.60 |
| dsh_installer | PASS | 0.50 |
| packaging | PASS | 24.47 |
| packaging_audit | PASS | 2.60 |
| discovery | PASS | 4.02 |
| packaging_discovery | PASS | 12.29 |
| codearts_driver | PASS | 10.54 |
| codearts_native_install | PASS | 1.05 |
| codearts_hub_contract | PASS | 0.39 |
| codearts_packaging | PASS | 0.83 |
| antigravity_native | PASS | 1.20 |
| antigravity_sdk | PASS | 0.49 |
| antigravity_sdk_protocol | PASS | 0.34 |
| antigravity_packaging | PASS | 0.91 |
| antigravity_hub_contract | PASS | 1.62 |
| mcp_bridge | PASS | 8.82 |
| zcode_rpc | PASS | 0.60 |
| codearts_native_plugin | PASS | 0.24 |
| native_plugin_config | PASS | 1.80 |
| console | PASS | 3.09 |
| dsh_workflows | PASS | 0.76 |
| linux_launcher | PASS | 6.34 |

### FAILED suite detail — `login_manager`

**Failure:** 11 of 12 tests pass; 1 fails:

```
FAIL: test_unknown_and_manual_workers_never_spawn
File "tests/login_manager_smoke.py", line 161, in test_unknown_and_manual_workers_never_spawn
  self.assertEqual(self.manager.handle("zcode", "start", {})["status"], "unavailable")
AssertionError: 'manual_required' != 'unavailable'
```

The test expected `unavailable` when starting a worker named `zcode`, but the manager returned `manual_required`. Duration was 0.38s for the whole suite — not load-related.

**Isolation re-run:** `python3 tests/login_manager_smoke.py` — same failure, same assertion, exit 1. **Genuine failure**, not flakiness.

**Did not modify any source.** Per the task rules: not "fixing" the test. The test asserts a contract; the code under test is returning a different status string. This needs a maintainer decision — either the production contract changed and the test should be updated, or the production code regressed. Either way, the v0.9.9.6 Linux build has 1 broken contract assertion on the `login_manager` suite.

## 5. Things worth flagging / surprises

1. **`~/Desktop/agenthub-releases` did not exist on this host.** `package_extensions.py` therefore skipped the second copy of the three extension files. I copied them manually from `integrations/vscode/dist/` into `~/ah-release-v0.9.9.6/` so all artifacts sit in one directory as the task spec required.
2. **`unzip` is not installed** on this host. Used Python's `zipfile` module for all ZIP inspection — same results either way, but worth knowing for any follow-up shell work.
3. **Hostname leak watch-out.** This host's hostname is `prod-node`; the shipped artifacts contained **zero** `prod-node` occurrences, so the build's hygiene (whatever it does to scrub local paths) held. The hostname is only present in this report, not in any ZIP.
4. **Login manager contract failure** (above) is the only red flag in the verification. All other 28 suites — including the long-running `packaging` (24.5s), `packaging_discovery` (12.3s), `codearts_driver` (10.5s), `mcp_bridge` (8.8s), and the Linux-only `linux_launcher` (6.3s) — passed.
5. **`source_changed_during_run: []`** — the regression runner's own source-hash monitor detected no tracked-file mutation during the run. Combined with `git status` showing the working tree clean afterwards, **no tracked file in the repo was modified by this verification.**
