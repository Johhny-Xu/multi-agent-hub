// The HighLevel CRM connector's fixed names, shared by the server (tools, per-bot checks) and the app (bot settings).
// Tool names are upper-snake with the HIGHLEVEL_ prefix so the connector grant and scope rules apply unchanged.

/** The connector slug in a bot's connectorScopes.apps and connectorTools. */
export const HIGHLEVEL_SLUG = "highlevel";

/** The MCP server name bots see (tools arrive as mcp__highlevel__HIGHLEVEL_<ACTION>). */
export const HIGHLEVEL_MCP_SERVER = "highlevel";

export const HIGHLEVEL_TOOL_NAMES = [
  "HIGHLEVEL_SEARCH_CONTACTS",
  "HIGHLEVEL_GET_CONTACT",
  "HIGHLEVEL_CREATE_CONTACT",
  "HIGHLEVEL_UPDATE_CONTACT",
  "HIGHLEVEL_ADD_TAGS",
  "HIGHLEVEL_REMOVE_TAGS",
  "HIGHLEVEL_LIST_NOTES",
  "HIGHLEVEL_ADD_NOTE",
  "HIGHLEVEL_LIST_TASKS",
  "HIGHLEVEL_ADD_TASK",
  "HIGHLEVEL_LIST_PIPELINES",
  "HIGHLEVEL_SEARCH_OPPORTUNITIES",
  "HIGHLEVEL_GET_OPPORTUNITY",
  "HIGHLEVEL_CREATE_OPPORTUNITY",
  "HIGHLEVEL_UPDATE_OPPORTUNITY",
  "HIGHLEVEL_SEARCH_CONVERSATIONS",
  "HIGHLEVEL_READ_CONVERSATION",
  "HIGHLEVEL_LIST_CALENDARS",
  "HIGHLEVEL_LIST_EVENTS",
  "HIGHLEVEL_GET_LOCATION",
] as const;

export type HighLevelToolName = (typeof HIGHLEVEL_TOOL_NAMES)[number];

export type HighLevelToolGroup = "contacts" | "pipelines" | "conversations" | "calendars";

/** The per-bot groups shown in bot settings; a group is a connectorTools grant naming exactly these tools.
 * HIGHLEVEL_GET_LOCATION belongs to every group: it only describes the connected location. */
export const HIGHLEVEL_TOOL_GROUPS: Record<HighLevelToolGroup, { label: string; tools: readonly HighLevelToolName[] }> = {
  contacts: {
    label: "Contacts and notes",
    tools: [
      "HIGHLEVEL_SEARCH_CONTACTS", "HIGHLEVEL_GET_CONTACT", "HIGHLEVEL_CREATE_CONTACT", "HIGHLEVEL_UPDATE_CONTACT",
      "HIGHLEVEL_ADD_TAGS", "HIGHLEVEL_REMOVE_TAGS", "HIGHLEVEL_LIST_NOTES", "HIGHLEVEL_ADD_NOTE",
      "HIGHLEVEL_LIST_TASKS", "HIGHLEVEL_ADD_TASK", "HIGHLEVEL_GET_LOCATION",
    ],
  },
  pipelines: {
    label: "Pipelines and deals",
    tools: [
      "HIGHLEVEL_LIST_PIPELINES", "HIGHLEVEL_SEARCH_OPPORTUNITIES", "HIGHLEVEL_GET_OPPORTUNITY",
      "HIGHLEVEL_CREATE_OPPORTUNITY", "HIGHLEVEL_UPDATE_OPPORTUNITY", "HIGHLEVEL_GET_LOCATION",
    ],
  },
  conversations: {
    label: "Conversations (read)",
    tools: ["HIGHLEVEL_SEARCH_CONVERSATIONS", "HIGHLEVEL_READ_CONVERSATION", "HIGHLEVEL_GET_LOCATION"],
  },
  calendars: {
    label: "Calendars (read)",
    tools: ["HIGHLEVEL_LIST_CALENDARS", "HIGHLEVEL_LIST_EVENTS", "HIGHLEVEL_GET_LOCATION"],
  },
};

/** The default grant for a new bot: contacts and notes. */
export const HIGHLEVEL_DEFAULT_GROUPS: readonly HighLevelToolGroup[] = ["contacts"];

export function highlevelToolsForGroups(groups: readonly HighLevelToolGroup[]): HighLevelToolName[] {
  const names = new Set<HighLevelToolName>();
  for (const group of groups) for (const tool of HIGHLEVEL_TOOL_GROUPS[group].tools) names.add(tool);
  return HIGHLEVEL_TOOL_NAMES.filter((name) => names.has(name));
}

/** The groups a grant list covers completely. */
export function highlevelGroupsForTools(tools: "*" | readonly string[]): HighLevelToolGroup[] {
  const all = Object.keys(HIGHLEVEL_TOOL_GROUPS) as HighLevelToolGroup[];
  if (tools === "*") return all;
  const granted = new Set(tools);
  return all.filter((group) => HIGHLEVEL_TOOL_GROUPS[group].tools.every((tool) => granted.has(tool)));
}

export type HighLevelConnectionState = "unavailable" | "signed-out" | "connecting" | "connected" | "needs-sign-in";

/** GET /api/highlevel. */
export interface HighLevelStatus {
  state: HighLevelConnectionState;
  kind?: "oauth" | "token";
  location?: { id: string; name: string };
  connectedAt?: number;
  flow?: { flowId: string; authorizationUrl: string; expiresAt: number };
  problem?: string;
}

export type HighLevelSignInPhase = "waiting" | "connected" | "failed" | "expired";
