"""Validated task options and portable attachments, independent of a vendor CLI."""
import base64
import binascii
import json
import os
import re
import tempfile
from pathlib import Path

MAX_ATTACHMENT_BYTES = 1024 * 1024
MAX_ATTACHMENTS = 8
OPTIONS_SCHEMA = {
    "thinking": {"type": "string", "enum": ["default", "on", "off"], "default": "default"},
    "stream": {"type": "boolean", "default": False},
    "attachments": {"type": "array", "maxItems": MAX_ATTACHMENTS, "items": {
        "type": "object", "properties": {"name": {"type": "string"}, "mime_type": {"type": "string"}, "data_base64": {"type": "string"}},
        "required": ["name", "mime_type", "data_base64"], "additionalProperties": False}},
}


class UnsupportedCapability(ValueError):
    pass


def merge_cli_arguments(command, additions):
    """Replace scalar options instead of turning duplicate flags into CLI arrays.

    Call before substituting {task}, so arbitrary prompt text cannot be parsed
    as an option. Repeated attachment flags intentionally remain repeated.
    """
    scalars = {"--model", "-m", "--format", "--output-format", "--output", "--settings", "--reasoning-effort", "--effort", "--timeout"}
    result = list(command)
    index = 0
    while index < len(additions):
        flag = additions[index]
        scalar = flag in scalars or (flag == "--stream" and index + 1 < len(additions) and additions[index + 1] in ("on", "off"))
        if not scalar:
            result.append(flag)
            index += 1
            continue
        if index + 1 >= len(additions):
            raise ValueError("Missing CLI option value: " + flag)
        value = additions[index + 1]
        aliases = {"--model", "-m"} if flag in {"--model", "-m"} else {flag}
        retained, old_values = [], []
        cursor = 0
        while cursor < len(result):
            current = result[cursor]
            if current in aliases:
                if cursor + 1 >= len(result) or result[cursor + 1] == "{task}":
                    raise ValueError("Invalid configured CLI option: " + current)
                old_values.append(result[cursor + 1])
                cursor += 2
            elif any(current.startswith(alias + "=") for alias in aliases):
                old_values.append(current.partition("=")[2])
                cursor += 1
            else:
                retained.append(current)
                cursor += 1
        if flag == "--settings" and old_values:
            merged = {}
            for item in [*old_values, value]:
                try:
                    settings = json.loads(item)
                except ValueError as exc:
                    raise ValueError("Cannot merge --settings file/path with task options; use an inline JSON object") from exc
                if not isinstance(settings, dict):
                    raise ValueError("--settings must be an inline JSON object")
                merged.update(settings)
            value = json.dumps(merged, ensure_ascii=False)
        result = retained + [flag, value]
        index += 2
    return result


def capabilities(agent, profile):
    catalog = json.loads((Path(__file__).with_name("capabilities.json")).read_text(encoding="utf-8"))
    result = dict(catalog.get(agent, {}))
    override = profile.get("capabilities", {})
    if not isinstance(override, dict):
        raise ValueError("capabilities must be an object")
    result.update(override)
    return result


def _mode_config(value, label):
    if not isinstance(value, dict):
        raise UnsupportedCapability("UNSUPPORTED: " + label)
    args, env = value.get("args", []), value.get("env", {})
    if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
        raise ValueError("Invalid capability args: " + label)
    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in env.items()):
        raise ValueError("Invalid capability env: " + label)
    return args, env


def prepare_task(agent, profile, args, directory):
    """Reject unsupported requests before creating files or launching a process."""
    caps = capabilities(agent, profile)
    thinking, stream = args.get("thinking", "default"), args.get("stream", False)
    if thinking not in ("default", "on", "off") or not isinstance(thinking, str):
        raise ValueError("thinking must be default/on/off")
    if not isinstance(stream, bool):
        raise ValueError("stream must be a boolean")
    extra, env = [], {}
    if thinking != "default":
        config = (caps.get("thinking") or {}).get(thinking)
        more, values = _mode_config(config, agent + " thinking=" + thinking)
        aliases = profile.get("models") or {}
        requested = str(args.get("model") or "").strip()
        if requested in ("", "default", "默认"):
            requested = aliases.get("default")
        requested = aliases.get(requested, requested)
        if config.get("models") and requested not in config["models"]:
            raise UnsupportedCapability("UNSUPPORTED: thinking mode has not been verified for this model")
        extra.extend(more)
        env.update(values)
    output_mode = (caps.get("stream") or {}).get("on" if stream else "off")
    if output_mode is not None:
        more, values = _mode_config(output_mode, agent + " stream")
        extra.extend(more)
        env.update(values)
    raw = args.get("attachments", [])
    if not isinstance(raw, list) or len(raw) > MAX_ATTACHMENTS:
        raise ValueError("attachments must be an array with at most 8 files")
    decoded, total = [], 0
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"name", "mime_type", "data_base64"}:
            raise ValueError("Invalid attachment fields")
        name, mime, encoded = item["name"], item["mime_type"], item["data_base64"]
        if not isinstance(name, str) or not name or len(name) > 160 or any(c in name for c in '/\\\0\r\n') or name in {".", ".."}:
            raise ValueError("Invalid attachment name")
        if re.fullmatch(r"(?:\.env(?:\..*)?|\.?auth\.json|\.?credentials(?:\.json|\.ya?ml)?|id_(?:rsa|ed25519))", name, re.I) or name.lower().endswith((".key", ".pem")):
            raise ValueError("Credential files cannot be sent as attachments")
        if not isinstance(mime, str) or not mime or not isinstance(encoded, str) or len(encoded) > (MAX_ATTACHMENT_BYTES * 4 // 3 + 8):
            raise ValueError("Invalid attachment type or size")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Invalid attachment base64") from exc
        total += len(data)
        if total > MAX_ATTACHMENT_BYTES:
            raise ValueError("Attachments exceed the 1 MiB combined limit")
        kind = "image" if mime.startswith("image/") else "file"
        config = (caps.get("attachments") or {}).get(kind)
        if not isinstance(config, dict) or config.get("mode") not in {"cli", "prompt_path", "inline_text", "messages_file"}:
            raise UnsupportedCapability("UNSUPPORTED: " + agent + " " + kind + " attachment")
        text = None
        if config["mode"] == "inline_text" or config["mode"] == "messages_file" and kind == "file":
            if kind == "image":
                raise UnsupportedCapability("UNSUPPORTED: image cannot be treated as text")
            try:
                text = data.decode("utf-8-sig")
            except UnicodeError as exc:
                raise UnsupportedCapability("UNSUPPORTED: this worker accepts UTF-8 text attachments only") from exc
            if "\0" in text:
                raise UnsupportedCapability("UNSUPPORTED: binary attachment")
            if config["mode"] == "inline_text" and len(args["task"]) + sum(len(entry[3] or "") for entry in decoded) + len(text) > 24000:
                raise UnsupportedCapability("UNSUPPORTED: inline text exceeds the portable 24000-character command limit")
        if config["mode"] == "messages_file" and kind == "image" and mime not in {"image/png", "image/jpeg", "image/gif", "image/webp"}:
            raise UnsupportedCapability("UNSUPPORTED: this message API accepts PNG/JPEG/GIF/WebP images only")
        if config["mode"] == "cli" and (not isinstance(config.get("flag"), str) or not config["flag"]):
            raise ValueError("Attachment CLI flag is missing")
        decoded.append((name, data, config, text, kind, mime))
    task = args["task"]
    attachments = []
    staging = None
    message_file = None
    message_content = []
    try:
        if decoded:
            parent = Path(directory).resolve()
            parent.mkdir(parents=True, exist_ok=True)
            staging = Path(tempfile.mkdtemp(prefix="task-", dir=str(parent)))
            for index, (name, data, config, text, kind, mime) in enumerate(decoded):
                # User names are metadata; generated names stay portable on Windows and Linux.
                suffix = Path(name).suffix.lower()
                suffix = suffix if suffix and len(suffix) < 12 and suffix[1:].isalnum() else ".bin"
                path = staging / ("attachment-" + str(index) + suffix)
                path.write_bytes(data)
                try:
                    path.chmod(0o600)
                except OSError:
                    pass
                mode = config["mode"]
                if mode == "cli":
                    extra.extend([config["flag"], str(path)])
                elif mode == "prompt_path":
                    task += "\n\n[Attached " + kind + ": " + name + "]\n" + str(path)
                elif mode == "messages_file":
                    if kind == "image":
                        message_content.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(data).decode("ascii")}})
                    else:
                        message_content.append({"type": "text", "text": "[Attached file: " + name + "]\n" + text})
                else:
                    task += "\n\n[Attached file: " + name + "]\n" + text + "\n[End attachment]"
                attachments.append({"name": name, "kind": kind, "bytes": len(data), "mode": mode})
            if message_content:
                message_file = staging / "messages.json"
                message_file.write_text(json.dumps([{"role": "user", "content": [{"type": "text", "text": task}, *message_content]}], ensure_ascii=False), encoding="utf-8")
                message_file.chmod(0o600)
                extra.extend(["--messages-file", str(message_file)])
    except BaseException:
        cleanup_attachments(str(staging) if staging else None, directory)
        raise
    return {"task": task, "extra_args": extra, "env": env, "staging": str(staging) if staging else None, "message_file": bool(message_file),
            "metadata": {"thinking": thinking, "stream": stream, "attachments": attachments}}


def apply_environment(base, updates):
    """Preserve existing provider options when applying model-specific JSON overrides."""
    def merge(left, right):
        result = dict(left)
        for key, value in right.items():
            result[key] = merge(result[key], value) if isinstance(result.get(key), dict) and isinstance(value, dict) else value
        return result
    result = dict(base)
    for key, value in updates.items():
        if key == "MIMOCODE_CONFIG_CONTENT" and result.get(key):
            try:
                original, override = json.loads(result[key]), json.loads(value)
            except ValueError as exc:
                raise ValueError("Invalid existing MiMo inline configuration") from exc
            if not isinstance(original, dict) or not isinstance(override, dict):
                raise ValueError("MiMo inline configuration must be an object")
            result[key] = json.dumps(merge(original, override), ensure_ascii=False)
        else:
            result[key] = value
    return result


def cleanup_attachments(staging, parent):
    if not staging:
        return
    target, parent = Path(staging).resolve(), Path(parent).resolve()
    if target.parent != parent or not target.name.startswith("task-"):
        raise ValueError("Attachment cleanup escaped its owned directory")
    if target.exists():
        for entry in target.iterdir():
            if entry.is_file() and not entry.is_symlink():
                entry.unlink()
        target.rmdir()
