"""Extract public answers/errors from known official CLI envelopes.

User JSON is left untouched when it is not a recognized vendor record. Tool
arguments/results and reasoning blocks are never used as an answer.
"""
import json
import math
import re

_USAGE_KEYS = {
    "input_tokens": "input_tokens", "inputTokens": "input_tokens", "input": "input_tokens",
    "output_tokens": "output_tokens", "outputTokens": "output_tokens", "output": "output_tokens",
    "reasoning_tokens": "reasoning_tokens", "reasoningTokens": "reasoning_tokens", "thinking_tokens": "reasoning_tokens", "reasoning": "reasoning_tokens",
    "total_tokens": "total_tokens", "totalTokens": "total_tokens", "total": "total_tokens",
    "cache_read_input_tokens": "cache_read_tokens", "cache_read_tokens": "cache_read_tokens", "cacheReadTokens": "cache_read_tokens",
    "cache_creation_input_tokens": "cache_write_tokens", "cache_write_tokens": "cache_write_tokens", "cacheWriteTokens": "cache_write_tokens",
    "modelRequestCount": "model_request_count", "webFetchRequests": "web_fetch_requests", "webSearchRequests": "web_search_requests",
}


def parse_usage(raw):
    """Return only public model identifiers and numeric usage counters.

    Never return arbitrary metadata or any text/reasoning/tool content. Unknown
    user JSON is not treated as a provider record.
    """
    if not isinstance(raw, str):
        raise TypeError("CLI output must be a string")
    clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", raw).strip()
    try:
        decoded = json.loads(clean)
        records = decoded if isinstance(decoded, list) else [decoded]
    except ValueError:
        records = []
        for line in clean.splitlines():
            try:
                records.append(json.loads(line))
            except ValueError:
                pass
    result = {}
    provider_reasoning = []
    seen_provider_usage = set()

    def counters(value):
        if not isinstance(value, dict):
            return
        for key, public in _USAGE_KEYS.items():
            number = value.get(key)
            if isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number) and number >= 0:
                result[public] = number
        # Only these nested usage dictionaries contain numeric counters.
        for key in ("cache", "usage"):
            if isinstance(value.get(key), dict):
                counters(value[key])
        for key in ("output_tokens_details", "outputTokensDetails", "input_tokens_details", "inputTokensDetails"):
            details = value.get(key)
            if isinstance(details, dict):
                counters(details)
            elif isinstance(details, list):
                # These arrays describe this usage block's constituent calls.
                # Sum its numeric reasoning details without summing separate
                # cumulative result envelopes across the event stream.
                numbers = [entry.get("reasoning_tokens") for entry in details if isinstance(entry, dict)]
                valid = [number for number in numbers if isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number) and number >= 0]
                if valid:
                    result["reasoning_tokens"] = sum(valid)

    def visit(value):
        if not isinstance(value, dict):
            return
        model = value.get("model")
        if isinstance(model, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,160}", model):
            result["model"] = model
        for key in ("usage", "tokens"):
            counters(value.get(key))
        model_usage = value.get("modelUsage")
        if isinstance(model_usage, dict) and len(model_usage) == 1:
            model_name, usage = next(iter(model_usage.items()))
            if isinstance(model_name, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,160}", model_name) and isinstance(usage, dict):
                result["model"] = model_name
                counters(usage)
        provider = value.get("providerData")
        if isinstance(provider, dict):
            usage = provider.get("usage")
            counters(usage)
            if isinstance(usage, dict):
                identity = (provider.get("messageId"), provider.get("stepSeq"))
                if identity not in seen_provider_usage:
                    seen_provider_usage.add(identity)
                    details = usage.get("outputTokensDetails")
                    if isinstance(details, list):
                        for entry in details:
                            number = entry.get("reasoning_tokens") if isinstance(entry, dict) else None
                            if isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number) and number >= 0:
                                provider_reasoning.append(number)
        for key in ("message", "part", "data", "result", "step_update"):
            child = value.get(key)
            if isinstance(child, dict):
                visit(child)

    for record in records:
        public_cb_usage = isinstance(record, dict) and record.get("type") in ("function_call", "function_call_result", "reasoning") and "sessionId" in record and isinstance(record.get("providerData"), dict)
        if _known(record) or public_cb_usage:
            visit(record)
    if provider_reasoning:
        result["reasoning_tokens"] = sum(provider_reasoning)
    return result


def _error_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("message", "error", "data"):
            text = _error_text(value.get(key))
            if text:
                return text
        if isinstance(value.get("name"), str):
            return value["name"]
    if isinstance(value, list):
        return "; ".join(filter(None, (_error_text(item) for item in value)))
    return None


def _blocks_text(blocks):
    if isinstance(blocks, str):
        return blocks
    if not isinstance(blocks, list):
        return ""
    return "".join(block["text"] for block in blocks if isinstance(block, dict)
                   and block.get("type") in ("text", "output_text")
                   and isinstance(block.get("text"), str))


def _known(value):
    if not isinstance(value, dict):
        return False
    typ = value.get("type", "")
    if value.get("event") == "result" and isinstance(value.get("result"), dict):
        return _known(value["result"])
    if value.get("event") == "step_update" and isinstance(value.get("step_update"), dict):
        return "conversation_id" in value["step_update"] and "step_type" in value["step_update"]
    if "conversation_id" in value and value.get("status") in ("SUCCESS", "ERROR", "CANCELLED", "TIMEOUT"):
        return isinstance(value.get("response"), str) and "usage" in value
    if typ == "result":
        return any(key in value for key in ("is_error", "subtype", "session_id", "sessionId", "exitCode"))
    if typ in ("assistant", "user", "system", "stream_event"):
        return "session_id" in value or (typ == "stream_event" and isinstance(value.get("event"), dict))
    if typ == "message":
        return value.get("role") in ("user", "assistant") and any(key in value for key in ("sessionId", "providerData", "usage", "stop_reason"))
    if isinstance(typ, str) and typ.startswith(("assistant.", "session.", "tool.", "model.")):
        return isinstance(value.get("data"), dict) and ("timestamp" in value or "id" in value)
    if typ in ("text", "reasoning", "tool_use", "step_start", "step_finish", "error"):
        return "sessionID" in value and (isinstance(value.get("part"), dict) or typ == "error" and isinstance(value.get("error"), dict))
    return isinstance(value.get("response"), str) and "sessionId" in value and any(key in value for key in ("traceId", "projection", "usage"))


def _unexecuted_dsml_call(text):
    """Recognize a terminal action-shaped call, never a quoted DSML example."""
    marker = "<｜｜DSML｜｜ calls>"
    start = text.find(marker)
    if start < 0:
        return False
    prefix = text[:start].strip()
    if prefix.count("```") % 2 or prefix.count("~~~") % 2:
        return False
    if prefix and (re.search(r"\b(?:example|quote|quoted|syntax|protocol|DSML)\b|示例|引用|语法|协议", prefix, re.I)
                   or not re.search(r"(?:let me (?:use|read|run)|i['’]ll (?:use|read|run)|i will (?:use|read|run)|让我|我将)", prefix, re.I)):
        return False
    body = text[start:].strip()
    return bool(re.fullmatch(r'<｜｜DSML｜｜ calls>\s*(?:<｜｜DSML｜｜ invoke name="[^"\r\n]+">[\s\S]*?</｜｜DSML｜｜ invoke>\s*)+</｜｜DSML｜｜ calls>', body))


def parse_output(raw):
    """Return ``{'text': str, 'error': str | None}`` without truncation."""
    if not isinstance(raw, str):
        raise TypeError("CLI output must be a string")
    clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", raw).strip()
    # CodeBuddy's headless runner can exit 0 with this diagnostic instead of a
    # result envelope. Match its complete login instruction, not generic 401
    # text that might be a legitimate answer or a quoted document.
    if re.match(r"^401 Authentication required\. Please use /login command to sign in to your account(?:\s|$)", clean):
        return {"text": "", "error": "CodeBuddy authentication required; sign in using the official login flow"}
    try:
        decoded = json.loads(clean)
        records = decoded if isinstance(decoded, list) else [decoded]
    except ValueError:
        records = []
        for line in clean.splitlines():
            try:
                records.append(json.loads(line))
            except ValueError:
                continue
    if not any(_known(record) for record in records):
        return {"text": clean, "error": None}
    error = None
    final = None
    last_assistant = ""
    delta = ""
    delta_message = None
    mimo_parts = {}
    mimo_message = None
    for record in records:
        if not _known(record):
            continue
        typ = record.get("type")
        if record.get("event") == "result" or "conversation_id" in record and "status" in record:
            result = record["result"] if record.get("event") == "result" else record
            final = result.get("response", "")
            if result.get("status") != "SUCCESS":
                error = _error_text(result.get("error")) or "Antigravity CLI reported " + str(result.get("status"))
        elif record.get("event") == "step_update":
            step = record["step_update"]
            if step.get("step_type") == "agent_response" and isinstance(step.get("text_delta"), str):
                delta += step["text_delta"]
        elif typ == "result":
            code = record.get("exitCode")
            if record.get("is_error") is True or isinstance(code, int) and not isinstance(code, bool) and code != 0 or str(record.get("subtype", "")).startswith("error"):
                error = _error_text(record.get("errors")) or _error_text(record.get("error")) or _error_text(record.get("result")) or "CLI reported a failed result"
            if isinstance(record.get("result"), str):
                final = record["result"]
            elif isinstance(record.get("response"), str) and "sessionId" in record:
                final = record["response"]
                projection = record.get("projection", {})
                if record.get("error") or isinstance(projection, dict) and projection.get("status") in ("error", "failed"):
                    error = _error_text(record.get("error")) or "CLI projection reported failure"
        elif typ == "assistant":
            message = record.get("message", {})
            if not record.get("parent_tool_use_id") and isinstance(message, dict) and message.get("role", "assistant") == "assistant":
                text = _blocks_text(message.get("content"))
                if text:
                    last_assistant = text
        elif typ == "message" and record.get("role") == "assistant":
            text = _blocks_text(record.get("content"))
            if text:
                last_assistant = text
            base = record.get("base_resp")
            if isinstance(base, dict) and base.get("status_code", 0) != 0:
                error = _error_text(base.get("status_msg")) or "CLI provider reported an error"
        elif typ == "stream_event":
            event = record.get("event", {})
            if record.get("parent_tool_use_id"):
                continue
            if event.get("type") == "message_start":
                delta = ""
                last_assistant = ""
            elif event.get("type") == "content_block_delta":
                part = event.get("delta", {})
                if part.get("type") == "text_delta" and isinstance(part.get("text"), str):
                    delta += part["text"]
            elif event.get("type") == "error":
                error = _error_text(event.get("error")) or "CLI stream reported an error"
        elif typ == "assistant.message":
            data = record.get("data", {})
            if data.get("phase") not in ("analysis", "thinking", "reasoning") and isinstance(data.get("content"), str):
                last_assistant = data["content"]
        elif typ == "assistant.message_delta":
            data = record.get("data", {})
            key = data.get("messageId")
            if key != delta_message:
                delta = ""
                last_assistant = ""
                delta_message = key
            if isinstance(data.get("deltaContent"), str):
                delta += data["deltaContent"]
        elif typ in ("session.error", "model.call_error", "model.call_failed"):
            error = _error_text(record.get("data")) or "CLI reported an error event"
        elif typ == "text":
            part = record.get("part", {})
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                key = part.get("messageID")
                if key != mimo_message:
                    mimo_parts = {}
                    mimo_message = key
                mimo_parts[part.get("id", str(len(mimo_parts)))] = part["text"]
        elif typ == "error":
            error = _error_text(record.get("error")) or "CLI reported an error event"
        elif typ is None and "response" in record:
            final = record["response"]
            projection = record.get("projection", {})
            if record.get("error") or isinstance(projection, dict) and projection.get("status") in ("error", "failed"):
                error = _error_text(record.get("error")) or "CLI projection reported failure"
    text = final if final is not None else "".join(mimo_parts.values()) if mimo_parts else last_assistant or delta
    if not error and final is not None and _unexecuted_dsml_call(text):
        error = "TOOL_PROTOCOL_UNVERIFIED: CLI final result contains an unexecuted tool call; preserve this task and do not automatically redispatch."
    return {"text": text.strip(), "error": error}
