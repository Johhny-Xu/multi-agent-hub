---
name: hub-status
description: Shows the selected multi-agent-hub connection, available workers, defaults and supported capabilities without starting a model task.
---

# Hub status

Call the registered multi-agent-hub hub_status tool. Report available workers and any connection or authentication error accurately. Query hub_capabilities for a worker when the user asks about models, thinking, stream, images or files.

Do not dispatch a test task merely to show status. Do not refresh cached authentication failures unless the user reports a changed login state. On connection failure, use hub_discover to list candidates, retaining the selected Hub until the user chooses another.

Display public status only. Do not print client.json, environment variables, tokens or vendor login stores.
