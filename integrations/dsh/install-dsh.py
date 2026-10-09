#!/usr/bin/env python3
"""Prepare one existing DSH profile; never load or launch a DSH runtime.

The official `dsh plugin --profile NAME add file:PACKAGE` command owns package
installation. This adapter preserves user patches and prepares an owned override.
"""
import argparse
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_URL = "http://127.0.0.1:8765/mcp"
PLUGIN_ID = "mcp-agenthub"
BUNDLE_NAME = "dsh-plugin-multi-agent-hub"
PRESET_IDS = ["preset-agenthub-" + name for name in ("all", "antigravity", "codebuddy", "codebuddy-cn", "zcode", "traecode", "copilot", "minimaxcode", "mimocode")]
BLOCK_BEGIN = "# >>> Multi-Agent Hub BEGIN >>>"
BLOCK_END = "# <<< Multi-Agent Hub END <<<"

class RawYaml:
    def __init__(self, text):
        self.text = text

def get_dsh_home():
    return Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh").expanduser().resolve()

def profile_dir(dsh_home, name):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name) or name in (".", ".."):
        raise ValueError("profile must be a single directory name")
    root = (Path(dsh_home) / "profiles").resolve()
    target = (root / name).resolve()
    if target.parent != root:
        raise ValueError("profile escapes the profiles directory")
    return target

def find_target_patch_file(dsh_home, profile_name):
    return profile_dir(dsh_home, profile_name) / "cordis.patch.yml"

def find_target_package_json(dsh_home, profile_name):
    return profile_dir(dsh_home, profile_name) / "package.json"

def _id(line):
    match = re.fullmatch(r"-\s+id:\s*['\"]?([\w-]+)['\"]?\s*(?:#.*)?", line)
    return match.group(1) if match else None

def is_installed(content):
    return BLOCK_BEGIN in content or any(_id(line) in [PLUGIN_ID] + PRESET_IDS for line in content.splitlines())

def strip_managed_content(content):
    # Remove only exact owned blocks/legacy top-level rows. Never remove persona rows.
    if content.count(BLOCK_BEGIN) != content.count(BLOCK_END):
        raise ValueError("Unmatched AgentHub managed markers; refusing to rewrite")
    pattern = re.compile(r"(?m)^" + re.escape(BLOCK_BEGIN) + r"\r?\n.*?^" + re.escape(BLOCK_END) + r"(?:\r?\n|$)", re.S)
    content = pattern.sub("", content)
    if BLOCK_BEGIN in content or BLOCK_END in content:
        raise ValueError("Invalid AgentHub marker placement")
    output = []
    skipping = False
    for line in content.splitlines(keepends=True):
        if line.startswith("- "):
            skipping = _id(line.rstrip("\r\n")) in [PLUGIN_ID] + PRESET_IDS
        if not skipping:
            output.append(line)
    return "".join(output)

def existing_settings(content):
    # Read only our MCP row. Scalars remain literal YAML, including !!js expressions.
    lines = content.splitlines()
    start = next((i for i, line in enumerate(lines) if _id(line) == PLUGIN_ID), None)
    if start is None:
        return {}
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("- ") or lines[i] == BLOCK_END), len(lines))
    block = lines[start + 1:end]
    settings = {}
    env = {}
    field = None
    env_key = None
    env_indent = None
    for line in block:
        if field == "env" and env_key and env[env_key].text.startswith(("|", ">")) and (not line.strip() or len(line) - len(line.lstrip()) > env_indent + 2):
            env[env_key].text += "\n" + line[env_indent + 2:]
            continue
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(r"^( +)([A-Za-z_][\w]*):\s*(.*)$", line)
        if match:
            indent, key, scalar = len(match[1]), match[2], match[3]
            if key == "config" and indent == 2:
                if scalar.startswith("{"):
                    parsed = json.loads(scalar)
                    if not isinstance(parsed, dict):
                        raise ValueError("Managed config must be an object")
                    return parsed
                continue
            if indent == 4:
                field = key
                env_key = None
                if key == "env":
                    env_indent = indent
                    if scalar and scalar != "{}":
                        raise ValueError("Use a mapping for AgentHub config.env")
                elif key in ("url", "token", "command", "cwd", "toolCallTimeoutMs", "failOnStartupError"):
                    settings[key] = RawYaml(scalar)
            elif field == "env" and env_indent is not None and indent == env_indent + 2:
                env_key = key
                if key in env:
                    raise ValueError("Duplicate managed environment key")
                env[key] = RawYaml(scalar)
            elif field == "env" and env_key and indent > env_indent + 2:
                env[env_key].text += "\n" + line[env_indent + 2:]
        elif field == "env" and env_key and len(line) - len(line.lstrip()) > env_indent + 2:
            env[env_key].text += "\n" + line[env_indent + 2:]
        else:
            raise ValueError("Ambiguous managed YAML; refusing to drop existing settings")
    if env:
        settings["env"] = env
    return settings

def _scalar(value):
    return value.text if isinstance(value, RawYaml) else json.dumps(value, ensure_ascii=False)

def load_template_yaml(url=None, token=None, settings=None):
    config = dict(settings or {})
    env = dict(config.pop("env", {}) or {})
    if url is not None:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("Invalid Hub URL")
        env["AGENTHUB_URL"] = url
        config.pop("url", None)
    if token is not None:
        env["HUB_TOKEN"] = token
        config.pop("token", None)
    config.setdefault("toolCallTimeoutMs", 310000)
    output = ["- id: " + PLUGIN_ID, "  config:", "    env:"]
    for key, value in env.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("Invalid environment variable name")
        scalar_lines = _scalar(value).split("\n")
        if not scalar_lines[0].strip():
            raise ValueError("Managed environment value must be a string; empty/null YAML value: " + key)
        output.append("      " + key + ": " + scalar_lines[0])
        output.extend("      " + line if line else "" for line in scalar_lines[1:])
    if not env:
        output[-1] = "    env: {}"
    for key, value in config.items():
        if key not in ("url", "token", "command", "cwd", "toolCallTimeoutMs", "failOnStartupError"):
            raise ValueError("Unknown managed config field: " + key)
        output.append("    " + key + ": " + _scalar(value))
    return "\n".join(output) + "\n"

def validate_yaml(content):
    # Existing YAML/!!js is preserved, never executed. Use a parser if available.
    try:
        import yaml
    except ImportError:
        return
    try:
        parsed = yaml.load(content, Loader=yaml.BaseLoader)
        if parsed is not None and not isinstance(parsed, list):
            raise ValueError("DSH patch root must be a list")
    except Exception as exc:
        raise ValueError("YAML syntax validation failed") from exc

def package_content(pkg_file, install=True):
    data = json.loads(pkg_file.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("dependencies", {}), dict):
        raise ValueError("Invalid profile package dependencies")
    profile = data.get("dsh", {}).get("profile", {}) if isinstance(data.get("dsh", {}), dict) else None
    if not isinstance(profile, dict) or not isinstance(profile.get("bundles"), list) or not all(isinstance(name, str) for name in profile["bundles"]):
        raise ValueError("Existing DSH profile manifest with bundles is required")
    dependencies = data.setdefault("dependencies", {})
    bundles = profile["bundles"]
    if install:
        dependencies[BUNDLE_NAME] = "file:" + Path(__file__).resolve().parent.as_posix()
        if BUNDLE_NAME not in bundles:
            bundles.append(BUNDLE_NAME)
    else:
        dependencies.pop(BUNDLE_NAME, None)
        profile["bundles"] = [name for name in bundles if name != BUNDLE_NAME]
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"

def _atomic_write(path, content):
    fd, temporary = tempfile.mkstemp(prefix=".agenthub-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(content.encode("utf-8"))
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def update_profile_package_json(pkg_file, install=True):
    _atomic_write(pkg_file, package_content(pkg_file, install))
    return True

def prepare_profile(dsh_home, name, url=None, token=None, uninstall=False, config_file=None, command=None):
    patch = find_target_patch_file(dsh_home, name)
    package = find_target_package_json(dsh_home, name)
    if not package.is_file():
        raise ValueError("Selected profile does not exist; initialize it with the official dsh CLI")
    package_text = package_content(package, not uninstall)  # Validate before any mutation.
    original = patch.read_bytes().decode("utf-8") if patch.exists() else ""
    settings = existing_settings(original) if not uninstall else {}
    if config_file is not None and not uninstall:
        if url is not None or token is not None:
            raise ValueError("Choose --config-file or explicit --url/--token, not both")
        settings.pop("url", None)
        settings.pop("token", None)
        env = settings.setdefault("env", {})
        for key in ("AGENTHUB_URL", "HUB_MCP_URL", "HUB_TOKEN", "AGENTHUB_CONFIG_FILE"):
            env.pop(key, None)
        env["AGENTHUB_CONFIG"] = str(Path(config_file).expanduser().resolve())
        env["AGENTHUB_CONNECTION_MODE"] = "file"
    elif not uninstall and (url is not None or token is not None):
        # An explicit legacy connection leaves the authoritative file mode.
        settings.get("env", {}).pop("AGENTHUB_CONNECTION_MODE", None)
    if command is not None and not uninstall:
        if not isinstance(command, str) or not command.strip():
            raise ValueError("command must be a nonempty executable path")
        settings["command"] = command
    cleaned = strip_managed_content(original)
    active = [line.strip() for line in cleaned.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if active == ["[]"]:
        cleaned = re.sub(r"(?m)^\[\]\r?\n?", "", cleaned)
    elif active and active[0].startswith(("[", "{")):
        raise ValueError("Flow-style user patch cannot be safely extended")
    if uninstall:
        final = cleaned if cleaned.strip() else "[]\n"
    else:
        payload = load_template_yaml(url, token, settings)
        final = cleaned + ("" if not cleaned or cleaned.endswith("\n") else "\n") + BLOCK_BEGIN + "\n" + payload + BLOCK_END + "\n"
    validate_yaml(final)
    old_package = package.read_bytes()
    stamp = str(time.time_ns())
    if patch.exists():
        shutil.copy2(patch, patch.with_name(patch.name + ".bak-" + stamp))
    shutil.copy2(package, package.with_name(package.name + ".bak-" + stamp))
    try:
        _atomic_write(package, package_text)
        _atomic_write(patch, final)
    except Exception:
        package.write_bytes(old_package)
        if patch.exists() or original:
            patch.write_bytes(original.encode("utf-8"))
        raise
    return patch

def main():
    parser = argparse.ArgumentParser(description="Prepare the selected existing DSH profile for multi-agent-hub")
    parser.add_argument("--profile", default="web", help="Existing profile name; never falls back to another profile")
    parser.add_argument("--url", default=None, help="Override Hub URL; omission preserves existing value")
    parser.add_argument("--token", default=None, help="Override Hub token; omission preserves existing env/token")
    parser.add_argument("--config-file", type=Path, help="External client.json; no token copied into the profile")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        home = get_dsh_home()
        patch = find_target_patch_file(home, args.profile)
        package = find_target_package_json(home, args.profile)
        if not package.is_file():
            raise ValueError("Selected profile does not exist: " + args.profile)
        if args.check:
            content = patch.read_bytes().decode("utf-8") if patch.exists() else ""
            print("multi-agent-hub profile configuration: " + ("present" if is_installed(content) else "absent"))
            print("This check does not launch or verify a DSH host.")
            return 0
        prepare_profile(home, args.profile, args.url, args.token, args.uninstall, args.config_file)
        print("Prepared profile: " + args.profile)
        print("User patches preserved; configuration backups saved.")
        package_path = Path(__file__).resolve().parent.as_posix()
        action = "remove " + BUNDLE_NAME if args.uninstall else 'add "file:' + package_path + '"'
        print("Complete package linking with the official CLI: dsh plugin --profile " + args.profile + " " + action)
        print("Then verify with dsh --profile " + args.profile + " --dump-config before starting the host.")
        return 0
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print("DSH preparation failed: " + ("Invalid profile JSON" if isinstance(exc, json.JSONDecodeError) else str(exc)), file=__import__("sys").stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
