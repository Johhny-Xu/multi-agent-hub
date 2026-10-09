---
name: hub-discover
description: Finds reachable local or LAN multi-agent-hub candidates and guides explicit target selection without changing the connection automatically.
---

# Discover a Hub

Call the registered hub_discover MCP tool. Show each returned candidate's address, host and status, and the selected connection if provided. Discovery must not send the existing token to candidate hosts or start model tasks.

If there is no candidate, present the manual connection step returned by the tool. Use the installation's connect.cmd or connect.sh to configure the selected server and external client.json. Do not write secrets to plugin manifests or project files.

The user selects which Hub to connect to. Do not switch a running task's host; its ref belongs to the original Hub.
