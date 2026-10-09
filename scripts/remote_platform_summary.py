#!/usr/bin/env python3
"""Build a stable platform evidence index without running any vendor task."""
import json
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
from command_runtime import atomic_write_json


def read(name):
    return json.loads((ROOT / "docs" / name).read_text(encoding="utf-8"))


def main():
    topologies = {}
    for mode in ("linux-native", "windows-to-linux"):
        base = read("platform-matrix-fixed-" + mode + ".json")
        extra = read("platform-minimax-image-" + mode + ".json")
        merged = {cell["case_id"]: dict(cell, evidence="docs/platform-matrix-fixed-" + mode + ".json") for cell in base["cells"]}
        for cell in extra["cells"]:
            merged[cell["case_id"]] = dict(cell, evidence="docs/platform-minimax-image-" + mode + ".json")
        cells = list(merged.values())
        outcomes = sorted({cell["outcome"] for cell in cells})
        workers = {}
        for worker in sorted({cell["worker"] for cell in cells}):
            selected = [cell for cell in cells if cell["worker"] == worker]
            workers[worker] = {"cells": len(selected), "counts": {name: sum(cell["outcome"] == name for cell in selected) for name in outcomes},
                               "mcp_submissions": sum(cell["dispatch_count"] for cell in selected),
                               "hub_accepted_task_refs": sum(bool(cell.get("final", {}).get("ref")) for cell in selected),
                               "stream_requested_cells": sum(cell["stream"] for cell in selected),
                               "stream_progress_observed_cells": sum(bool(cell.get("stream_observed")) for cell in selected),
                               "stream_progress_notifications": sum(cell.get("progress_notifications", 0) for cell in selected),
                               "thinking_usage_counter_observed_cells": sum(isinstance((cell.get("usage") or {}).get("reasoning_tokens"), (int,float)) for cell in selected),
                               "thinking_mode_verified_by_counter_cells": sum(cell.get("thinking_observed") is True for cell in selected)}
        topologies[mode] = {"grid_cells": len(cells), "counts": {name: sum(cell["outcome"] == name for cell in cells) for name in outcomes},
                            "mcp_submissions": sum(cell["dispatch_count"] for cell in cells),
                            "hub_accepted_task_refs": sum(bool(cell.get("final", {}).get("ref")) for cell in cells),
                            "workers": workers, "cells": cells}
    native = read("platform-linux-native-zcode-minimax.json")
    cleanup = read("platform-cleanup.json")
    regression_path = ROOT / "docs/platform-final-regressions.json"
    result = {"kind": "final-platform-compatibility-evaluation", "grid_dimensions": ["thinking on/off", "stream on/off", "image present/absent", "UTF-8 file present/absent"],
              "canonical_grid_cells": 256, "all_workers_all_modes_passed": False, "topologies": topologies,
              "real_linux": {"distribution": "Ubuntu 24.04.4 LTS", "architecture": "x86_64", "python": "3.12.3", "node": "22.23.1", "transport": "existing SSH alias, isolated loopback Hub"},
              "linux_native_hosts": {"codex": {"status": "blocked", "entry_exists": False, "known_auth_filename_exists": False},
                                     "dsh": {"status": "blocked", "entry_exists": False, "known_profile_directory_exists": True, "profile_directory_is_not_authentication_proof": True},
                                     "zcode": {"status": "verified_native_plugin_agent_and_real_worker_attachment_result", "version": "0.16.9", "vendor_generation_verified": native["generation_verified"], "evidence": "docs/platform-linux-native-zcode-minimax.json"}},
              "limitations": ["Unsupported requests are rejected before launching a vendor process; rejected cells are not successful inference.",
                              "Authentication-blocked remaining cells are deliberately not executed again.",
                              "The existing Linux CN/intl wrappers copy account auth into shared native-extension storage; account isolation and credential-content preservation are not verified.",
                              "Official CodeBuddy 2.162.0 was installed privately and reused Linux auth without Windows credentials; file/image tasks still failed tool-protocol verification.",
                              "Linux reasoning_tokens were observed for CodeBuddy non-stream JSON cases and MiniMax non-stream JSON cases; stream text modes and Copilot lacked these counters, so their thinking modes are not claimed verified by token counts.",
                              "The old Linux traecode default is glm-5.3-flash, different from requested GLM-5.3-FlashX; no Trae default-model generation was executed.",
                              "WSL had no installed distribution and Docker CLI was unavailable on Windows; tests ran on actual remote Linux, not WSL or mock vendor responses."],
              "cleanup": cleanup, "final_linux_regressions": read(regression_path.name) if regression_path.is_file() else {"status": "pending_final_core_freeze"},
              "evidence_stages": ["docs/platform-linux-baseline.json", "docs/platform-linux-workers-preflight.json", "docs/platform-linux-workers-baseline.json", "docs/platform-linux-native-models.json",
                                  "docs/platform-matrix.json", "docs/platform-matrix-fixed.json", "docs/platform-codebuddy-version-align.json", "docs/platform-minimax-image-linux-native.json", "docs/platform-minimax-image-windows-to-linux.json",
                                  "docs/platform-linux-native-zcode.json", "docs/platform-linux-native-zcode-minimax.json", "docs/platform-linux-routing-inventory.json", "docs/platform-cleanup.json"]}
    checked = ("hub/agent_hub.py", "hub/async_worker.py", "hub/task_contract.py", "hub/output_parser.py", "drivers/zcode_rpc.mjs", "tests/hub_core_regressions.py", "tests/zcode_rpc.test.mjs")
    recorded = result["final_linux_regressions"].get("source_sha256", {})
    result["latest_linux_regression_snapshot_matches_current_core"] = all(recorded.get(name) == hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in checked if (ROOT / name).is_file())
    atomic_write_json(ROOT / "docs/platform-matrix-final.json", result)
    print(json.dumps({mode:{key:value[key] for key in ("grid_cells","counts","mcp_submissions","hub_accepted_task_refs")} for mode,value in topologies.items()}))


if __name__ == "__main__":
    main()
