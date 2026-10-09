---
description: Inspect multi-agent-hub workers, connection and supported options without dispatching a task.
---
Call the registered hub_status tool, then hub_capabilities for any specifically requested worker. Report the selected host and actual availability. Do not dispatch model work. If connection fails, call hub_discover and present candidates without silently switching the configured Hub.

