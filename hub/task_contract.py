"""Validated task options and portable attachments, independent of a vendor CLI."""
import base64
import binascii
import json
import os
import re
import sys
import tempfile
from pathlib import Path

MAX_ATTACHMENT_BYTES = 1024 * 1024
MAX_ATTACHMENTS = 8
OPTIONS_SCHEMA = {
    "thinking": {"type": "string", "enum": ["default", "on", "off"], "default": "default"},
    "effort": {"type": "string", "enum": ["low", "medium", "high", "max"]},
    # 文件编辑权限：各 worker 用自家 CLI 的开关实现（见 capabilities.json 的 permission.modes）
    "permission": {"type": "string", "enum": ["default", "readonly", "edit", "full"]},
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
    scalars = {"--model", "-m", "--agent", "--input-format", "--format", "--output-format", "--output", "--settings", "--reasoning-effort", "--effort", "--timeout", "--permission", "--prompt-mode", "--mode"}
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


def platform_name():
    return "windows" if os.name == "nt" else "darwin" if sys.platform == "darwin" else "linux"


def resolve_model(profile, requested=None):
    aliases = profile.get("models") or {}
    requested = str(requested or "").strip()
    if requested in ("", "default", "默认"):
        requested = str(aliases.get("default") or "")
    return str(aliases.get(requested, requested))


def capabilities(agent, profile, model=None, platform=None):
    catalog = json.loads((Path(__file__).with_name("capabilities.json")).read_text(encoding="utf-8"))
    def merge(left, right):
        result = dict(left)
        for key, value in right.items():
            result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else value
        return result
    result = dict(catalog.get(agent, {}))
    override = profile.get("capabilities", {})
    if not isinstance(override, dict):
        raise ValueError("capabilities must be an object")
    result = merge(result, override)
    result = merge(result, (result.get("platforms") or {}).get(platform or platform_name(), {}))
    result = merge(result, (result.get("models") or {}).get(model or resolve_model(profile), {}))
    return result


def _read_authorized(profile):
    cli = [str(item) for item in (profile.get("cli") or [])]
    def values(flag):
        if flag not in cli:
            return []
        start = cli.index(flag) + 1
        stop = next((i for i in range(start, len(cli)) if cli[i].startswith("-")), len(cli))
        return [part for item in cli[start:stop] for part in re.split(r"[,\s]+", item)]
    # Tools must actually be exposed AND pre-authorized in headless mode.
    allowed, tools = values("--allowedTools"), values("--tools")
    denied = values("--disallowedTools")
    return "Read" not in denied and (not tools or "Read" in tools or "default" in tools) and "Read" in allowed and "--permission-mode" in cli and cli[cli.index("--permission-mode") + 1:cli.index("--permission-mode") + 2] == ["acceptEdits"]


def attachment_config(caps, kind, profile):
    config = (caps.get("attachments") or {}).get(kind)
    if not isinstance(config, dict) or config.get("supported") is False:
        return None, (config or {}).get("reason", "该模型/平台未声明此附件能力")
    if config.get("requires_read_authorization") and not _read_authorized(profile):
        return None, "图像读取需要官方 standard 代理、Read 工具和窄范围预授权配置。"
    return config, None


def public_model_capabilities(agent, profile, model):
    caps = capabilities(agent, profile, model)
    thinking = ["default"]
    reasons = {}
    for mode in ("on", "off"):
        config = (caps.get("thinking") or {}).get(mode)
        if isinstance(config, dict) and config.get("supported") is not False and (not config.get("models") or model in config["models"]):
            thinking.append(mode)
        else:
            reasons[mode] = (config or {}).get("reason", "该模型未验证此思考控制")
    on = (caps.get("stream") or {}).get("on")
    stream_supported = isinstance(on, dict) and on.get("supported") is not False
    stream = {"supported": stream_supported, "semantics": caps.get("stream_semantics", "answer_snapshots" if stream_supported else "unverified")}
    if not stream_supported:
        stream["reason"] = (on or {}).get("reason", "该通道未验证实时回答流；只能查询终态")
    attachments = {}
    for kind in ("file", "image"):
        config, reason = attachment_config(caps, kind, profile)
        attachments[kind] = {"supported": config is not None, "platforms": [platform_name()]}
        if config:
            attachments[kind]["mode"] = config.get("mode")
            if kind == "image" and (config.get("mode") in {"stdin_json", "messages_file"} or config.get("requires_read_authorization")):
                attachments[kind]["content_types"] = ["image/png", "image/jpeg", "image/gif", "image/webp"]
            if config.get("mode") in {"stdin_json", "inline_text", "messages_file"} and kind == "file":
                attachments[kind]["content_types"] = ["text/plain; charset=utf-8"]
        else:
            attachments[kind]["reason"] = reason
    perm_modes = (caps.get("permission") or {}).get("modes") or {}
    permission = {
        "allowed": ["default"] + [k for k in ("readonly", "edit", "full") if isinstance(perm_modes.get(k), dict)],
        "default": "default",
        "labels": {k: (v.get("label") or k) for k, v in perm_modes.items() if isinstance(v, dict)},
        "descriptions": {k: (v.get("desc") or "") for k, v in perm_modes.items() if isinstance(v, dict)},
        "scope": (caps.get("permission") or {}).get("description") or "",
    }
    return {"thinking": {"allowed": thinking, "default": "default", "reasons": reasons}, "stream": stream, "attachments": attachments, "permission": permission}


def _mode_config(value, label):
    if not isinstance(value, dict) or value.get("supported") is False:
        raise UnsupportedCapability("UNSUPPORTED: " + label)
    args, env = value.get("args", []), value.get("env", {})
    if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
        raise ValueError("Invalid capability args: " + label)
    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in env.items()):
        raise ValueError("Invalid capability env: " + label)
    return args, env


def prepare_task(agent, profile, args, directory):
    """Reject unsupported requests before creating files or launching a process."""
    model = resolve_model(profile, args.get("model"))
    caps = capabilities(agent, profile, model)
    declared = set((profile.get("models") or {}).values())
    if model and declared and model not in declared and profile.get("allow_unlisted_models") is not True:
        raise UnsupportedCapability("UNSUPPORTED: 所选模型未在本机 worker 配置中声明")
    if any(args.get(key) is not None for key in ("contextTier", "autoTier")):
        raise UnsupportedCapability("UNSUPPORTED: contextTier/autoTier 不是已验证的 CLI 控制")
    if args.get("extra_args") is not None:
        values = args["extra_args"]
        if not isinstance(values, list) or any(not isinstance(item, str) for item in values):
            raise ValueError("extra_args must be a string array")
        protected = {"--model", "-m", "--agent", "--input-format", "--output-format", "--format", "--output", "--stream", "--include-partial-messages", "--thinking", "--effort", "--reasoning-effort", "--settings", "--messages-file", "--file", "--attach", "--attachment", "--tools", "--allowedTools", "--disallowedTools", "--permission-mode"}
        if any(item.partition("=")[0] in protected for item in values):
            raise UnsupportedCapability("UNSUPPORTED: extra_args 不能覆盖已校验的模型、思考、流式、附件或工具授权；请修改本机 profile 或使用任务选项")
    thinking, stream = args.get("thinking", "default"), args.get("stream", False)
    if thinking not in ("default", "on", "off") or not isinstance(thinking, str):
        raise ValueError("thinking must be default/on/off")
    if not isinstance(stream, bool):
        raise ValueError("stream must be a boolean")
    extra, env = _mode_config({"args": caps.get("task_args", [])}, agent + " task")
    extra, env = list(extra), dict(env)
    remove_args = []
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
    permission_mode = str(args.get("permission") or "default")
    if permission_mode not in ("default", "readonly", "edit", "full"):
        raise ValueError("permission must be default/readonly/edit/full")
    if permission_mode != "default":
        # 每家 CLI 的开关都不一样，统一查 capabilities.json 里该 worker 自己的 permission.modes
        conf = ((caps.get("permission") or {}).get("modes") or {}).get(permission_mode)
        if not isinstance(conf, dict):
            modes = (caps.get("permission") or {}).get("modes") or {}
            allowed = "/".join(["default"] + [k for k in ("readonly", "edit", "full") if k in modes])
            raise UnsupportedCapability("UNSUPPORTED: " + agent + " 不支持编辑权限模式 " + permission_mode + "（可选 " + allowed + "）")
        more, values = _mode_config(conf, agent + " permission=" + permission_mode)
        extra.extend(more)
        env.update(values)
    output_mode = (caps.get("stream") or {}).get("on" if stream else "off")
    if stream and (not isinstance(output_mode, dict) or output_mode.get("supported") is False):
        raise UnsupportedCapability("UNSUPPORTED: " + (output_mode or {}).get("reason", agent + " 未验证实时输出流"))
    if output_mode is not None and output_mode.get("supported") is not False:
        more, values = _mode_config(output_mode, agent + " stream")
        extra.extend(more)
        env.update(values)
        remove_args = output_mode.get("remove_args", [])
        if not isinstance(remove_args, list) or any(flag not in {"--stream", "--include-partial-messages"} for flag in remove_args):
            raise ValueError("Invalid removable CLI boolean flags")
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
        config, reason = attachment_config(caps, kind, profile)
        if not isinstance(config, dict) or config.get("mode") not in {"cli", "prompt_path", "inline_text", "messages_file", "stdin_json"}:
            raise UnsupportedCapability("UNSUPPORTED: " + agent + " " + kind + " attachment: " + str(reason or "未声明"))
        text = None
        if config["mode"] == "inline_text" or config["mode"] in {"messages_file", "stdin_json"} and kind == "file":
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
        if kind == "image" and (config["mode"] in {"messages_file", "stdin_json"} or config.get("requires_read_authorization")) and mime not in {"image/png", "image/jpeg", "image/gif", "image/webp"}:
            raise UnsupportedCapability("UNSUPPORTED: this message API accepts PNG/JPEG/GIF/WebP images only")
        if config["mode"] == "cli" and (not isinstance(config.get("flag"), str) or not config["flag"]):
            raise ValueError("Attachment CLI flag is missing")
        decoded.append((name, data, config, text, kind, mime))
    task = args["task"]
    attachments = []
    staging = None
    message_file = None
    message_content = []
    stdin_content = []
    input_file = None
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
                elif mode == "stdin_json":
                    if kind == "image":
                        stdin_content.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(data).decode("ascii")}})
                    else:
                        stdin_content.append({"type": "text", "text": "[Attached file: " + name + "]\n" + text})
                else:
                    task += "\n\n[Attached file: " + name + "]\n" + text + "\n[End attachment]"
                attachments.append({"name": name, "kind": kind, "bytes": len(data), "mode": mode})
            if stdin_content:
                input_file = staging / "input.jsonl"
                input_file.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": task}, *stdin_content]}}, ensure_ascii=False) + "\n", encoding="utf-8")
                input_file.chmod(0o600)
                extra = merge_cli_arguments(extra, ["--input-format", "stream-json", "--output-format", "stream-json"])
            if message_content:
                message_file = staging / "messages.json"
                message_file.write_text(json.dumps([{"role": "user", "content": [{"type": "text", "text": task}, *message_content]}], ensure_ascii=False), encoding="utf-8")
                message_file.chmod(0o600)
                extra.extend(["--messages-file", str(message_file)])
    except BaseException:
        cleanup_attachments(str(staging) if staging else None, directory)
        raise
    return {"task": task, "extra_args": extra, "remove_args": remove_args, "env": env, "staging": str(staging) if staging else None, "message_file": bool(message_file), "input_file": str(input_file) if input_file else None,
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
