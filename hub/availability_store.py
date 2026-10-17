"""Local, expiring worker failure hints. Never store provider diagnostic text."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time

from command_runtime import atomic_write_json
from state_store import StateFileLock

FAILURE_TTL = 3600
REASONS = {
    "authentication_required": "最近一次调用认证失败；请完成官方登录或检查本机密钥后手动刷新。",
    "region_restricted": "最近一次调用被服务区域限制拒绝；插件不能绕过区域限制。",
    "quota_exhausted": "最近一次调用额度不足；请处理账户额度后手动刷新。",
    "model_unavailable": "最近一次调用找不到所选模型；请更新本机模型配置后手动刷新。",
    "empty_answer": "最近一次调用退出但未返回回答；未将偶发空答判为永久不支持。",
    "timeout": "最近一次调用超时；未将超时判为永久不支持。",
    "tool_protocol_unverified": "最近一次调用返回未执行的工具协议，不能视为任务成果。",
    "rate_limited": "最近一次调用处于排队或限流状态；未将排队判为永久不支持。",
}
BLOCKING = {"authentication_required", "region_restricted", "quota_exhausted", "model_unavailable"}


def signature(profile):
    # Environment values and account material must never enter public metadata.
    value = {k: profile.get(k) for k in ("cli", "models", "model_arg", "capabilities")}
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _path(directory):
    return Path(directory) / "availability.json"


def _read(path):
    if not path.exists():
        return {"version": 1, "workers": {}}
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict) or not isinstance(value.get("workers"), dict):
        raise ValueError("Invalid availability state")
    return value


def classify_failure(status, text):
    if status == "completed":
        return None
    if status == "timeout":
        return "timeout"
    diagnostic = str(text).lower()
    if ("401" in diagnostic and any(t in diagnostic for t in ("auth", "unauthorized", "login"))) or any(t in diagnostic for t in ("invalid api key", "invalid_api_key", "authentication required", "authentication_required", "codearts_auth_required")):
        return "authentication_required"
    if "failed_precondition" in diagnostic and "region" in diagnostic or any(t in diagnostic for t in ("region restricted", "not supported in your country", "unsupported region", "user location is not supported")):
        return "region_restricted"
    if any(t in diagnostic for t in ("quota exceeded", "quota_exceeded", "insufficient credits", "credit balance is too low", "quota exhausted", "额度已用完", "可用额度已用完", "体验套餐可用额度已用完", "套餐查询失败", "积分不足", "无可用额度")):
        return "quota_exhausted"
    if any(t in diagnostic for t in ("排队提醒", "当前模型请求量较高", "升级权益等待中", "rate limit", "rate_limited", "too many requests", "429")):
        return "rate_limited"
    if any(t in diagnostic for t in ("model_selection_not_applied", "model_catalog_unavailable", "model_ambiguous", "codearts_provider_unavailable", "no providers found")) or re.search(r"(?:model.{0,100}(?:not found|unavailable|not available|does not exist)|unknown model|model_not_found)", diagnostic):
        return "model_unavailable"
    if "tool_protocol_unverified" in diagnostic:
        return "tool_protocol_unverified"
    if "没有可验证的回答" in diagnostic or "empty answer" in diagnostic:
        return "empty_answer"
    return None


def record_outcome(directory, worker, model, status, text="", profile_signature=None):
    """Save only a canned code and time; successful calls clear the same model."""
    code = classify_failure(status, text)
    if status != "completed" and code is None:
        return
    model = str(model or "default")
    if not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,160}", model):
        return
    path = _path(directory)
    with StateFileLock(path.with_suffix(".lock")):
        value = _read(path)
        models = value["workers"].setdefault(worker, {})
        if status == "completed":
            models.pop(model, None)
        else:
            now = time.time()
            models[model] = {"code": code, "at": now, "expires_at": now + FAILURE_TTL,
                             "profile_signature": profile_signature}
        atomic_write_json(path, value)


def refresh(directory, worker=None, model=None):
    path = _path(directory)
    with StateFileLock(path.with_suffix(".lock")):
        value = _read(path)
        if not worker:
            value["workers"] = {}
        elif model:
            value["workers"].get(worker, {}).pop(model, None)
        else:
            value["workers"].pop(worker, None)
        atomic_write_json(path, value)


def recent(directory, worker, model, profile):
    path = _path(directory)
    with StateFileLock(path.with_suffix(".lock")):
        item = _read(path)["workers"].get(worker, {}).get(str(model or "default"))
    if not isinstance(item, dict) or item.get("profile_signature") not in (None, signature(profile)):
        return None
    code = item.get("code")
    if code not in REASONS:
        return None
    return {"code": code, "reason": REASONS[code], "at": item["at"],
            "blocking": code in BLOCKING and item.get("expires_at", 0) > time.time(),
            "expires_at": item.get("expires_at", 0)}


def local_availability(worker, profile, model, directory=None):
    result = {"enabled": True, "code": "ready", "reason": "已配置；此查询不验证登录或执行推理。", "refreshable": False}
    cli = profile.get("cli")
    code, reason = None, None
    if profile.get("disabled") is True:
        code, reason = "profile_disabled", "已在控制台或配置中禁用此 worker。"
    elif not isinstance(cli, list) or not cli:
        if worker in ("traecode", "trae"):
            result["reason"] = "已配置 TraeClaw 网关；此查询不验证登录或执行推理。"
        elif profile.get("gateway"):
            result["reason"] = "已配置专用网关通道；此查询不验证登录或执行推理。"
        else:
            code, reason = "cli_not_configured", "此 worker 未配置无头 CLI。"
    else:
        configured = str(cli[0])
        executable = os.path.expandvars(os.path.expanduser(configured))
        # Match dispatch's inherited environment plus expanded profile values.
        # Looking only at the Hub's PATH wrongly disables a private CLI install.
        process_env = os.environ.copy()
        for key, value in (profile.get("env") or {}).items():
            process_env[str(key)] = os.path.expandvars(os.path.expanduser(str(value)))
        executable = shutil.which(executable, path=process_env.get("PATH", os.defpath)) or (executable if Path(executable).is_file() else None)
        if not executable:
            # 带上配置路径与「安装损坏」提示：CLI 自更新半途失败时文件会消失，
            # 只报「找不到」会让人以为是配置写错。
            code, reason = "cli_missing", f"本机找不到已配置的 CLI：{configured}；若该文件本应存在，多为该 CLI 自更新中断导致安装损坏，重装一次即可。"
        if not code and len(cli) > 1 and str(cli[1]).endswith((".py", ".js", ".mjs", ".cjs")):
            path = Path(os.path.expandvars(os.path.expanduser(str(cli[1]))))
            if path.is_absolute() and not path.is_file():
                code, reason = "cli_script_missing", "本机找不到已配置 CLI 脚本。"
    if not code and model and worker == "zcode" and not profile.get("model_arg"):
        code, reason = "model_selection_unverified", "旧 ZCode 通道不能确认所选模型；请配置支持 --model 的官方 RPC 驱动。"
    if code:
        return {"enabled": False, "code": code, "reason": reason, "refreshable": False}
    if directory is not None:
        failure = recent(directory, worker, model, profile)
        if failure:
            result["last_failure"] = failure
            result["refreshable"] = True
            if failure["blocking"]:
                result.update(enabled=False, code=failure["code"], reason=failure["reason"])
    return result
