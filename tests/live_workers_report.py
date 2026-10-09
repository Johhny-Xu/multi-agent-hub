"""Build a public, reproducible Windows evidence index without raw reasoning."""
import itertools
import json
from collections import Counter
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))
from output_parser import parse_output, parse_usage
from live_workers_windows import verify_final


def numeric_reasoning(value):
    numbers = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("reasoning_tokens", "reasoningTokens", "thinking_tokens", "reasoning") and isinstance(child, (int, float)) and not isinstance(child, bool):
                numbers.append(child)
            elif isinstance(child, (dict, list)):
                numbers.extend(numeric_reasoning(child))
    elif isinstance(value, list):
        for child in value:
            numbers.extend(numeric_reasoning(child))
    return numbers


def main():
    files = [path for path in sorted((ROOT / "docs").glob("live-workers-windows-*.json")) if path.name != "live-workers-windows-capabilities.json"]
    records = []
    for path in files:
        report = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        for row in report.get("results", []):
            if "case" not in row or "cwd" not in row:
                continue
            rawfile = Path(row["cwd"]) / "stdout.raw.log"
            raw = rawfile.read_text(encoding="utf-8") if rawfile.exists() else ""
            public = parse_output(raw)
            expected = row.get("expected", {})
            verified, strict_json, final_json = verify_final(public["text"], expected.get("total"), expected.get("nonce"))
            verified = verified and public["error"] is None
            row["answer_verified"] = verified
            row["strict_json_answer"] = strict_json
            row["verification_source"] = "parse_output-selected public final text only; never raw event/tool/reasoning content"
            row["answer_evidence"] = [json.dumps(final_json, ensure_ascii=False)] if verified else []
            if not verified and row.get("status") == "passed":
                row["status"] = "failed_public_final_validation"
            if row.get("worker") == "minimaxcode" and row.get("file") and verified and not row.get("written_artifact_verified"):
                row["status"] = "unsupported_native_file_write"
            row["public_usage"] = parse_usage(raw)
            row["observed_reasoning_token_counts"] = numeric_reasoning(row.get("usage", []))
            if row.get("status") == "blocked_auth" and row.get("answer_verified") and row.get("written_artifact_verified") and public["error"] is None:
                row["status"] = "passed"
                row["classification_correction"] = "Only actual CLI error diagnostics count as authentication failures; words inside provider reasoning do not."
            row.pop("output_tail", None)
            if row.get("answer_verified") and row.get("written_artifact_verified"):
                row.pop("diagnostic", None)
            changed = True
            records.append({key: row.get(key) for key in ("worker", "case", "thinking", "stream", "image", "file", "status", "answer_verified", "written_artifact_verified", "elapsed_seconds", "public_usage", "observed_reasoning_token_counts", "stdout_chunks", "delta_events")} | {"evidence": "docs/" + path.name, "completed_at_unix": rawfile.stat().st_mtime if rawfile.exists() else 0})
        if changed:
            path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    records.sort(key=lambda row: row["completed_at_unix"])
    workers = ["antigravity", "codebuddy", "codebuddy-cn", "github-copilot", "mimocode", "minimaxcode", "traecode", "zcode"]
    matrix = []
    for worker in workers:
        for bits in itertools.product((False, True), repeat=4):
            thinking, stream, image, file = bits
            case = worker + "-t" + str(int(thinking)) + "s" + str(int(stream)) + "i" + str(int(image)) + "f" + str(int(file))
            matches = [row for row in records if row["case"] == case]
            # Preserve the tested case's result; flag unimplemented settings even
            # when computation happened to work with vendor defaults.
            limitations = []
            if worker == "minimaxcode" and not thinking:
                limitations.append("thinking_off_unsupported_always_thinking_model")
            if worker == "minimaxcode" and file:
                limitations.append("native_local_file_write_unsupported_host_inline_input_only")
            if worker == "github-copilot" and thinking:
                limitations.append("thinking_on_unsupported_auto_model")
            if worker == "antigravity" and not thinking:
                limitations.append("no_off_or_none_in_official_effort_contract")
            if worker == "zcode":
                limitations.extend(["thinking_toggle_not_exposed_in_headless_argv", "stream_toggle_not_exposed_in_headless_argv", "GLM-5.3-Flash_not_available_in_official_runtime_catalog"])
            row = {"worker": worker, "bits": "".join(str(int(bit)) for bit in bits), "thinking": thinking, "stream": stream, "image": image, "file": file,
                "actually_run": bool(matches), "limitations": limitations, "attempts": matches}
            if worker == "zcode":
                row["result"] = "blocked_model"
                row["observed_runtime_model"] = "wx/Deepseek-v4-flash"
                row["model_evidence"] = "docs/live-workers-zcode-rpc.json"
            elif matches:
                setting_unsupported = any("thinking_off_unsupported" in note or "thinking_on_unsupported" in note or "no_off_or_none" in note for note in limitations)
                row["result"] = "unsupported_setting" if setting_unsupported else matches[-1]["status"]
            elif limitations:
                row["result"] = "unsupported_setting_not_run"
            elif worker == "codebuddy":
                row["result"] = "not_run_auth_blocked_baseline"
            elif worker == "antigravity":
                row["result"] = "not_run_region_blocked_baseline"
            elif worker == "traecode":
                row["result"] = "not_run_vendor_authentication_blocked"
            else:
                row["result"] = "not_run"
            matrix.append(row)
    worker_summary = {}
    for worker in workers:
        cells = [row for row in matrix if row["worker"] == worker]
        run_cells = [row for row in cells if row["actually_run"]]
        latest = [row["attempts"][-1] for row in run_cells]
        file_latest = [row for row in latest if row["file"]]
        worker_summary[worker] = {
            "exact_cells_run": len(run_cells),
            "direct_cli_attempts": sum(len(row["attempts"]) for row in run_cells),
            "latest_final_answer_verified_cells": sum(row["answer_verified"] is True for row in latest),
            "qualified_passed_cells": sum(row["result"] == "passed" for row in cells),
            "file_cells_run": len(file_latest),
            "latest_file_artifact_verified_cells": sum(row["written_artifact_verified"] is True for row in file_latest),
            "matrix_result_counts": dict(sorted(Counter(row["result"] for row in cells).items())),
        }
    final = {"platform": "Windows", "generated_from_real_cli_reports": True, "matrix_order": "thinking,stream,image,file", "matrix_cells": 128,
        "warning": "A cell is marked actually_run only if an exact 4-bit probe exists. A default behavior computation pass cannot prove an unsupported setting. MiMo's stream axis is CLI event projection / Hub buffering, not a provider HTTP stream disable switch.",
        "summary_note": "latest_final_answer_verified_cells counts public-answer acceptance only. It does not prove unsupported thinking settings or requested-model availability. qualified_passed_cells applies those requirements. File artifact counts exclude no-file cells.",
        "direct_cli_attempts": len(records), "exact_cells_run": sum(row["actually_run"] for row in matrix), "worker_summary": worker_summary, "matrix": matrix}
    (ROOT / "docs/live-workers-windows-capabilities.json").write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"direct_cli_attempts": len(records), "exact_cells_run": final["exact_cells_run"], "worker_exact_cells": {worker: sum(row["actually_run"] for row in matrix if row["worker"] == worker) for worker in workers}}))


if __name__ == "__main__":
    main()
