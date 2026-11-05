"""Validated task options and portable attachments, independent of a vendor CLI."""
import base64
import binascii
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

MAX_ATTACHMENT_BYTES = 1024 * 1024  # 1 MiB hard cap
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


HARD_MAX_ATTACHMENTS = 8
HARD_MAX_ATTACHMENT_BYTES = 1024 * 1024
SUPPORTED_IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")
SUPPORTED_MODES = ("cli", "prompt_path", "inline_text", "messages_file", "stdin_json")
ERROR_LIMIT = "ATTACHMENT_LIMIT_EXCEEDED"
ERROR_TYPE = "ATTACHMENT_UNSUPPORTED_TYPE"
ERROR_ACCESS = "ATTACHMENT_ACCESS_DENIED"
ERROR_UNREADABLE = "ATTACHMENT_UNREADABLE"
ERROR_UNDECLARED = "ATTACHMENT_CAPABILITY_UNDECLARED"
ERROR_CONFIG = "ATTACHMENT_CONFIG_MISMATCH"
ERROR_WORKER = "WORKER_EXECUTION_FAILED"
ERROR_ANSWER_EMPTY = "WORKER_ANSWER_EMPTY"
ERROR_EVIDENCE = "VERIFICATION_EVIDENCE_INSUFFICIENT"
ERROR_DISPATCH_TIMEOUT = "DISPATCH_TIMEOUT"
ERROR_UNKNOWN = "TASK_STATE_UNKNOWN"
ERROR_BUDGET = "WAIT_BUDGET_EXHAUSTED"
ERROR_PERMISSION = "blocked_permission"
ERROR_AUDIT = "AUDIT_WRITE_FAILED"


class TaskContractError(ValueError):
    """Stable redacted task failure shared by the Hub and the bridges.

    Subclasses ValueError so existing call sites keep working. Details are
    built from a fixed allowlist and never carry attachment bodies, base64,
    tokens or absolute local paths.
    """

    _DETAIL_KEYS = ("file_id", "actual_count", "allowed_count", "actual_bytes",
                    "allowed_bytes", "actual_type", "allowed_types", "worker_reason")

    def __init__(self, message, *, code="TASK_CONTRACT_ERROR", stage="validation", **details):
        super().__init__(message)
        self.code = str(code)
        self.stage = str(stage)
        for key, value in details.items():
            if key not in self._DETAIL_KEYS:
                raise ValueError("Unsupported task error detail: " + key)
            setattr(self, key, value)

    def details(self):
        return {key: getattr(self, key) for key in self._DETAIL_KEYS if getattr(self, key, None) is not None}

    def to_dict(self):
        value = {"code": self.code, "stage": self.stage}
        details = self.details()
        if details:
            value["details"] = details
        return value

    def to_public(self):
        """Stable JSON payload for the Hub text protocol and the MCP bridge."""
        value = {"error_code": self.code, "failure_stage": self.stage,
                 "message": str(ValueError.__str__(self))}
        details = self.details()
        if details:
            value["error_details"] = details
        return value

    def __str__(self):
        details = self.details()
        text = super().__str__()
        return text + (" | details=" + json.dumps(details, ensure_ascii=False, sort_keys=True) if details else "")


class UnsupportedCapability(TaskContractError):
    """Backwards-compatible capability rejection (still a ValueError)."""

    def __init__(self, message, *, code=ERROR_UNDECLARED, stage="capability_validation", **details):
        super().__init__(message, code=code, stage=stage, **details)


class AttachmentPolicyResolver:
    """Resolve one worker/model/platform attachment contract.

    Declared limits can only tighten the global hard limits. The same
    snapshot feeds hub_capabilities and prepare_task, so a query and a
    dispatch cannot disagree about limits or content types.
    """

    def __init__(self, agent, profile, model=None, platform=None):
        self.agent = agent
        self.profile = profile or {}
        self.model = model or resolve_model(self.profile)
        self.platform = platform or platform_name()
        self.caps = capabilities(agent, self.profile, self.model, self.platform)

    @staticmethod
    def _limit(value, hard, label):
        if value is None:
            return hard
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise ValueError("invalid worker " + label)
        return min(value, hard)

    def policy(self, kind):
        config, reason = attachment_config(self.caps, kind, self.profile)
        if config is None:
            return {"supported": False, "reason": reason, "platform": self.platform}
        mode = config.get("mode")
        if mode not in SUPPORTED_MODES:
            return {"supported": False, "mode": mode, "platform": self.platform,
                    "reason": "unrecognized attachment input binding", "config_mismatch": True}
        declared_types = config.get("content_types")
        if not isinstance(declared_types, list) or not declared_types:
            if kind == "image" and (mode in {"messages_file", "stdin_json"} or config.get("requires_read_authorization")):
                content_types = list(SUPPORTED_IMAGE_TYPES)
            elif kind == "file" and mode in {"messages_file", "stdin_json", "inline_text"}:
                content_types = ["text/plain; charset=utf-8"]
            else:
                content_types = []
        else:
            content_types = [str(item).lower() for item in declared_types]
        return {
            "supported": True,
            "platform": self.platform,
            "mode": mode,
            "flag": config.get("flag"),
            "max_count": self._limit(config.get("max_count", self.caps.get("attachments", {}).get("max_count")),
                                     HARD_MAX_ATTACHMENTS, "attachment limit"),
            "max_total_bytes": self._limit(config.get("max_total_bytes", self.caps.get("attachments", {}).get("max_total_bytes")),
                                           HARD_MAX_ATTACHMENT_BYTES, "attachment total limit"),
            "content_types": content_types,
        }

    def snapshot(self):
        file_policy = self.policy("file")
        image_policy = self.policy("image")
        limits = [policy["max_count"] for policy in (file_policy, image_policy) if policy.get("supported")]
        totals = [policy["max_total_bytes"] for policy in (file_policy, image_policy) if policy.get("supported")]
        return {
            "worker": self.agent,
            "model": self.model,
            "platform": self.platform,
            "file": file_policy,
            "image": image_policy,
            "max_count": min(limits) if limits else HARD_MAX_ATTACHMENTS,
            "max_total_bytes": min(totals) if totals else HARD_MAX_ATTACHMENT_BYTES,
        }


def normalize_mime(value):
    parts = [part.strip() for part in str(value or "").lower().split(";")]
    base = parts[0]
    params = {}
    for part in parts[1:]:
        if "=" in part:
            key, _, item = part.partition("=")
            params[key.strip()] = item.strip().strip('"')
    return base, params


def logical_task_summary(agent, task, attachments):
    """Stable, non-reversible identifier for one logical dispatch.

    Only worker, task text and attachment content hashes are mixed in; the
    result is used to correlate audit events and never for global dedupe.
    """
    digest = hashlib.sha256()
    digest.update(str(agent).encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(task).encode("utf-8"))
    for name, data, _policy, _text, _kind, _mime in attachments:
        digest.update(b"\0")
        digest.update(str(name).encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(data).digest())
    return "sha256:" + digest.hexdigest()[:32]


def validate_workspace_path(cwd, platform=None):
    """Reject a client path masquerading as the target Hub's workdir."""
    if cwd in (None, ""):
        return None
    if not isinstance(cwd, str):
        raise TaskContractError("cwd must be a string", code="WORKSPACE_PATH_MISMATCH", stage="validation")
    platform = platform or platform_name()
    expanded = os.path.expandvars(os.path.expanduser(cwd))
    windows_style = bool(re.match(r"^[A-Za-z]:[\\/]", expanded) or expanded.startswith("\\\\"))
    posix_style = expanded.startswith("/")
    if platform == "windows" and posix_style and not windows_style:
        raise TaskContractError("cwd uses a non-Windows path on a Windows Hub",
                                code="WORKSPACE_PATH_MISMATCH", stage="validation", worker_reason="platform_path")
    if platform != "windows" and windows_style:
        raise TaskContractError("cwd uses a Windows path on a " + platform + " Hub",
                                code="WORKSPACE_PATH_MISMATCH", stage="validation", worker_reason="platform_path")
    return expanded


def image_signature_matches(data, mime):
    if mime == "image/png":
        return data.startswith(bytes([137, 80, 78, 71, 13, 10, 26, 10]))
    if mime == "image/jpeg":
        return data.startswith(bytes([255, 216, 255]))
    if mime == "image/gif":
        return data[:6] in (b"GIF87a", b"GIF89a")
    if mime == "image/webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return False


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
    resolver = AttachmentPolicyResolver(agent, profile, model)
    for kind in ("file", "image"):
        policy = resolver.policy(kind)
        attachments[kind] = {"supported": bool(policy.get("supported")), "platforms": [resolver.platform]}
        if policy.get("supported"):
            attachments[kind]["mode"] = policy["mode"]
            attachments[kind]["max_count"] = policy["max_count"]
            attachments[kind]["max_total_bytes"] = policy["max_total_bytes"]
            if policy.get("content_types"):
                attachments[kind]["content_types"] = policy["content_types"]
        else:
            attachments[kind]["reason"] = policy.get("reason", "该模型/平台未声明此附件能力")
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
    requested_task = args.get("task")
    if not isinstance(requested_task, str) or not requested_task.strip():
        raise TaskContractError("task must be a non-empty string", code="INVALID_TASK", stage="validation")
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
    resolver = AttachmentPolicyResolver(agent, profile, model)
    raw = args.get("attachments", [])
    file_policy, image_policy = resolver.policy("file"), resolver.policy("image")
    if not isinstance(raw, list):
        raise ValueError("attachments must be an array")
    if len(raw) > HARD_MAX_ATTACHMENTS:
        raise TaskContractError("attachments must be an array with at most 8 files", code=ERROR_LIMIT,
                                 stage="validation", actual_count=len(raw), allowed_count=HARD_MAX_ATTACHMENTS)
    declared_kinds = ["image" if normalize_mime(item.get("mime_type") or "")[0].startswith("image/")
                      else "file" for item in raw if isinstance(item, dict)]
    for kind, policy in (("file", file_policy), ("image", image_policy)):
        count = declared_kinds.count(kind)
        if not count:
            continue
        if not policy.get("supported"):
            if policy.get("config_mismatch"):
                raise UnsupportedCapability("Attachment input binding is not recognized", code=ERROR_CONFIG,
                                            stage="command_binding", actual_type=kind)
            raise UnsupportedCapability(agent + " " + kind + " attachment: " + str(policy.get("reason") or "not declared"),
                                        code=ERROR_UNDECLARED, stage="capability_validation")
        if count > policy["max_count"]:
            raise TaskContractError("attachments must be an array with at most %d files" % policy["max_count"],
                                    code=ERROR_LIMIT, stage="validation", actual_count=count,
                                    allowed_count=policy["max_count"])
    hard_total = min([policy["max_total_bytes"] for policy in (file_policy, image_policy)
                      if policy.get("supported")] or [HARD_MAX_ATTACHMENT_BYTES])
    decoded, total = [], 0
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"name", "mime_type", "data_base64"}:
            raise TaskContractError("Invalid attachment fields", code=ERROR_TYPE, stage="validation")
        name, mime, encoded = item["name"], item["mime_type"], item["data_base64"]
        if not isinstance(name, str) or not name or len(name) > 160 or any(c in name for c in '/\\\0\r\n') or name in {".", ".."}:
            raise TaskContractError("Invalid attachment name", code=ERROR_ACCESS, stage="validation",
                                    file_id=str(name)[:64] if isinstance(name, str) else None)
        if re.fullmatch(r"(?:\.env(?:\..*)?|\.?auth\.json|\.?credentials(?:\.json|\.ya?ml)?|id_(?:rsa|ed25519))", name, re.I) or name.lower().endswith((".key", ".pem")):
            raise TaskContractError("Credential files cannot be sent as attachments", code=ERROR_ACCESS,
                                    stage="validation", file_id=name, worker_reason="credential_filename")
        if not isinstance(mime, str) or not mime or not isinstance(encoded, str) or len(encoded) > (HARD_MAX_ATTACHMENT_BYTES * 4 // 3 + 8):
            raise TaskContractError("Invalid attachment type or size", code=ERROR_TYPE, stage="validation", file_id=name)
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise TaskContractError("Invalid attachment base64", code=ERROR_TYPE, stage="validation", file_id=name) from exc
        total += len(data)
        if total > hard_total:
            raise TaskContractError("Attachments exceed the declared combined limit", code=ERROR_LIMIT,
                                    stage="validation", file_id=name, actual_bytes=total,
                                    allowed_bytes=hard_total)
        base_mime, mime_params = normalize_mime(mime)
        kind = "image" if base_mime.startswith("image/") else "file"
        policy = image_policy if kind == "image" else file_policy
        if kind == "image" and policy.get("mode") == "inline_text":
            raise UnsupportedCapability("UNSUPPORTED: image cannot be treated as text", code=ERROR_TYPE,
                                        stage="capability_validation", file_id=name, actual_type=str(mime))
        if not policy.get("supported"):
            if policy.get("config_mismatch"):
                raise UnsupportedCapability("Attachment input binding is not recognized", code=ERROR_CONFIG,
                                            stage="command_binding", file_id=name, actual_type=base_mime,
                                            allowed_types=policy.get("content_types") or [])
            raise UnsupportedCapability(agent + " " + kind + " attachment: " + str(policy.get("reason") or "not declared"),
                                        code=ERROR_UNDECLARED, stage="capability_validation", file_id=name,
                                        actual_type=base_mime)
        mode = policy["mode"]
        text = None
        message_api = mode in {"messages_file", "stdin_json"} or (mode == "inline_text" and kind == "file")
        # 声明了 content_types 的 cli 直传通道（如 mcode 的 `--file <path>`）同样按声明校验：
        # 文本仍要求 UTF-8 text/plain，图片仍校验魔数，避免把未声明的类型直接落盘丢给 CLI。
        declared_cli = mode == "cli" and bool(policy.get("content_types"))
        if kind == "file" and (message_api or declared_cli):
            charset = mime_params.get("charset")
            if base_mime != "text/plain" or (charset is not None and charset.lower() not in {"utf-8", "utf8"}):
                raise TaskContractError("Text attachments must be UTF-8 text/plain", code=ERROR_TYPE,
                                        stage="validation", file_id=name, actual_type=str(mime),
                                        allowed_types=["text/plain; charset=utf-8"])
            try:
                text = data.decode("utf-8-sig")
            except UnicodeError as exc:
                raise TaskContractError("Text attachment is not valid UTF-8", code=ERROR_TYPE,
                                        stage="validation", file_id=name, actual_type=str(mime),
                                        allowed_types=["text/plain; charset=utf-8"]) from exc
            if "\0" in text:
                raise TaskContractError("Binary attachment cannot be treated as text", code=ERROR_TYPE,
                                        stage="validation", file_id=name, actual_type=str(mime),
                                        allowed_types=["text/plain; charset=utf-8"])
            if mode == "inline_text" and len(args["task"]) + sum(len(entry[3] or "") for entry in decoded) + len(text) > 24000:
                raise UnsupportedCapability("UNSUPPORTED: inline text exceeds the portable 24000-character command limit",
                                            code=ERROR_LIMIT, stage="validation", file_id=name,
                                            actual_bytes=len(text), allowed_bytes=24000)
        if kind == "image" and (message_api or declared_cli):
            if base_mime not in SUPPORTED_IMAGE_TYPES:
                raise TaskContractError("This message API accepts PNG/JPEG/GIF/WebP images only", code=ERROR_TYPE,
                                        stage="validation", file_id=name, actual_type=str(mime),
                                        allowed_types=list(SUPPORTED_IMAGE_TYPES))
            if not image_signature_matches(data, base_mime):
                raise TaskContractError("Image signature does not match its declared type", code=ERROR_TYPE,
                                        stage="validation", file_id=name, actual_type=base_mime,
                                        allowed_types=[base_mime], worker_reason="signature_mismatch")
        if kind == "image" and mode not in {"messages_file", "stdin_json"} and policy.get("content_types") and base_mime not in SUPPORTED_IMAGE_TYPES:
            raise TaskContractError("Image type is not declared by this worker", code=ERROR_TYPE, stage="validation",
                                    file_id=name, actual_type=str(mime), allowed_types=list(SUPPORTED_IMAGE_TYPES))
        if mode == "cli" and (not isinstance(policy.get("flag"), str) or not policy["flag"]):
            raise TaskContractError("Attachment CLI flag is missing", code=ERROR_CONFIG, stage="command_binding", file_id=name)
        decoded.append((name, data, policy, text, kind, base_mime))
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
                attachments.append({"name": name, "kind": kind, "bytes": len(data), "mode": mode, "mime": mime})
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
    summary = {"count": len(attachments), "total_bytes": sum(item["bytes"] for item in attachments),
               "content_types": sorted({item["mime"] for item in attachments}),
               "validation_result": "passed" if attachments else "not_applicable"}
    binding = ({"mode": "messages_file", "flag": "--messages-file", "path": str(message_file)}
               if message_file else None)
    return {"task": task, "extra_args": extra, "remove_args": remove_args, "env": env, "staging": str(staging) if staging else None, "message_file": bool(message_file), "input_file": str(input_file) if input_file else None,
            "binding": binding, "attachment_summary": summary,
            "logical_task_summary": logical_task_summary(agent, task, decoded),
            "metadata": {"thinking": thinking, "stream": stream, "attachments": attachments,
                         "attachment_summary": summary}}


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
