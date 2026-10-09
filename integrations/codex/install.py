#!/usr/bin/env python3
"""Plan or copy a project-scoped Codex adapter without editing live config."""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
MCP_FILES = ("server.mjs", "hub.mjs", "ask.mjs", "login.mjs")
FORWARDED_ENV = ("AGENTHUB_URL", "HUB_MCP_URL", "HUB_TOKEN")


def toml_string(value):
    # JSON's quoted strings use the escape subset needed for these TOML values.
    return json.dumps(str(value), ensure_ascii=False)


def node_runtime(command):
    path = shutil.which(command) or command
    if not Path(path).is_file():
        raise ValueError("Node.js 20 or newer is required; pass --node with its executable")
    version = subprocess.run([path, "--version"], stdin=subprocess.DEVNULL,
                             capture_output=True, text=True, timeout=5)
    match = re.fullmatch(r"v(\d+)\.\d+\.\d+\s*", version.stdout)
    if version.returncode or not match or int(match[1]) < 20:
        raise ValueError("Node.js 20 or newer is required")
    return str(Path(path).resolve()), version.stdout.strip()


def package_files():
    files = [SOURCE / name for name in ("plugin.json", "mcp.json", ".mcp.json", "package.json", "README.md", "install.py", ".codex-plugin/plugin.json", "scripts/start.mjs", "scripts/config.mjs")]
    files.extend(SOURCE / "mcp" / name for name in MCP_FILES)
    files.extend(sorted((SOURCE / "skills").rglob("SKILL.md")))
    files.extend(sorted((SOURCE / "templates" / ".codex" / "agents").glob("*.toml")))
    if any(not path.is_file() for path in files):
        raise ValueError("Codex package is incomplete")
    for path in files:
        if path.suffix == ".json":
            json.loads(path.read_text(encoding="utf-8"))
        elif path.suffix == ".toml":
            agent = tomllib.loads(path.read_text(encoding="utf-8"))
            if not all(isinstance(agent.get(key), str) and agent[key] for key in ("name", "description", "developer_instructions")):
                raise ValueError("Invalid custom agent: " + path.name)
    return files


def config_fragment(node, plugin):
    return ("# Review and merge only the required tables into .codex/config.toml.\n"
            "# This file is a fragment; Codex does not load it automatically.\n"
            "# Use this direct MCP route OR install the plugin, avoiding duplicate tools.\n"
            "[mcp_servers.agenthub]\n"
            "command = " + toml_string(node) + "\n"
            "args = [" + toml_string((plugin / "scripts" / "start.mjs").as_posix()) + "]\n"
            "env_vars = [" + ", ".join(toml_string(name) for name in FORWARDED_ENV) + "]\n"
            "startup_timeout_sec = 15\n"
            "tool_timeout_sec = 120\n\n"
            "# Suggested native routing-agent concurrency; preserve existing settings.\n"
            "[agents]\n"
            "max_concurrent_threads_per_session = 8\n")


def checked_target(path, scope):
    target = path.resolve()
    if not target.is_relative_to(scope.resolve()):
        raise ValueError("Target escapes its explicitly selected project/plugin directory: " + str(path))
    return target


def plan(project, plugin, node, *, separate_plugin=False):
    writes = {}
    plugin_scope = plugin if separate_plugin else project
    for source in package_files():
        target = checked_target(plugin / source.relative_to(SOURCE), plugin_scope)
        writes[target] = source.read_bytes()
    existing_agents = {}
    for existing in (project / ".codex" / "agents").glob("*.toml"):
        try:
            name = tomllib.loads(existing.read_text(encoding="utf-8")).get("name")
        except (OSError, ValueError):
            continue  # Preserve unrelated existing definitions, even malformed ones.
        if isinstance(name, str):
            existing_agents.setdefault(name, []).append(existing)
    for source in sorted((SOURCE / "templates" / ".codex" / "agents").glob("*.toml")):
        name = tomllib.loads(source.read_text(encoding="utf-8"))["name"]
        aliases = existing_agents.get(name, [])
        target = project / ".codex" / "agents" / source.name
        if any(alias != target for alias in aliases):
            if len(aliases) != 1 or aliases[0].read_bytes() != source.read_bytes():
                raise ValueError("A different existing agent already uses name " + name)
            target = aliases[0]  # Same definition under another filename: reuse it.
        target = checked_target(target, project)
        writes[target] = source.read_bytes()
    fragment = config_fragment(node, plugin)
    tomllib.loads(fragment)
    writes[checked_target(project / ".codex" / "agenthub.config.fragment.toml", project)] = fragment.encode("utf-8")
    changes = []
    for target, content in writes.items():
        if target.exists():
            action = "unchanged" if target.is_file() and target.read_bytes() == content else "conflict"
        else:
            action = "create"
        changes.append({"path": str(target), "action": action})
    return writes, changes


def apply(writes, changes):
    # Refuse all known conflicts before creating directories or files. Exclusive
    # creation also protects an existing file that appears after this preflight.
    if any(change["action"] == "conflict" for change in changes):
        raise ValueError("Existing files differ; choose another plugin path or review conflicts manually")
    for change in changes:
        if change["action"] == "unchanged":
            continue
        target = Path(change["path"])
        content = writes[target]
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with target.open("xb") as stream:
                stream.write(content)
        except FileExistsError:
            if not target.is_file() or target.read_bytes() != content:
                raise ValueError("Target appeared during installation and was preserved: " + str(target))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True, help="Existing project directory; never inferred from home")
    parser.add_argument("--plugin-dir", type=Path, help="Optional separate plugin output directory")
    parser.add_argument("--node", default="node", help="Node.js executable (20+) used in the reviewed fragment")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    options = parser.parse_args(argv)
    try:
        project = options.project.expanduser().resolve()
        if not project.is_dir() or project in {Path.home().resolve(), (Path.home() / ".codex").resolve()}:
            raise ValueError("--project must name an existing project directory, not a personal Codex configuration directory")
        plugin = options.plugin_dir.expanduser().resolve() if options.plugin_dir else project / ".codex" / "plugins" / "agenthub-workers"
        if options.plugin_dir and plugin in {Path.home().resolve(), (Path.home() / ".codex").resolve()}:
            raise ValueError("--plugin-dir must name a dedicated plugin directory")
        node, version = node_runtime(options.node)
        writes, changes = plan(project, plugin, node, separate_plugin=bool(options.plugin_dir))
        conflicts = [change for change in changes if change["action"] == "conflict"]
        report = {"mode": "apply" if options.apply else "dry-run", "project": str(project),
                  "plugin_directory": str(plugin), "node_version": version,
                  "config_modified": False, "conflicts": len(conflicts), "files": changes}
        if options.apply and not conflicts:
            apply(writes, changes)
        print(json.dumps(report, ensure_ascii=True, indent=2))
        return 1 if conflicts else 0
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
