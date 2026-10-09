---
description: Check worker login or retrieve an explicitly requested official login link.
---
Determine the worker from the user's request and call hub_login with action=status. If the user requested login, call action=start and relay its official login_url, user_code and instructions. Never ask for or output passwords, API keys or tokens. A login link is not proof of authentication; query status after the user's authorization.

