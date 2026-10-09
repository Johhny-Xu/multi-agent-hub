---
name: hub-login
description: Checks a Hub worker login or starts its official login when requested, returning an authorization link or device code without exposing credentials.
---

# Worker login

Identify the worker the user named and call hub_login with action=status. Report whether the worker is ready, waiting for authorization, blocked or requires manual setup.

When the user requests login, call action=start once. Relay the returned official login_url and user_code, then use action=status to check completion. If manual_required is returned, give the official instructions exactly within that supported method; do not claim a desktop login authenticates a separate CLI.

Use action=cancel only when the user asks to cancel the flow started by this tool. Never request a password or API key in chat, read vendor credential stores, or copy secrets into the plugin.
