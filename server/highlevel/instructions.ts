// No imports: harness-mcp-proxy bundles this file into the agent process.

/** tools/list instructions for the HighLevel MCP server. */
export const HIGHLEVEL_INSTRUCTIONS =
  "The HighLevel tools read and update the connected HighLevel (or Growably, or another HighLevel-based) CRM location: contacts, tags, notes, tasks, " +
  "pipelines and opportunities, conversations (read only), calendars and events (read only), and the location's custom fields. " +
  "Call HIGHLEVEL_GET_LOCATION once to learn the location's name, timezone and custom field names before writing custom fields. " +
  "Find a contact with HIGHLEVEL_SEARCH_CONTACTS before creating one; pass ids from results, never guessed ones. " +
  "Dates are ISO 8601 strings. Results are trimmed to the fields a person would care about, never raw API dumps. " +
  "These tools never send SMS, email, WhatsApp or any other message, and never start campaigns or workflows: do not try to message anyone through the CRM, " +
  "and do not work around it with other tools. Every write is recorded in the bot's activity with the record id and the fields changed. " +
  "When a tool answers that HighLevel is signed out, ask the person to reconnect it under Connected apps and end the turn.";

/** The system prompt part for a bot whose turn mounts the HighLevel tools. */
export const HIGHLEVEL_PROMPT =
  " The user's HighLevel CRM (also Growably and other HighLevel-based CRMs) is reachable through the highlevel tools (HIGHLEVEL_SEARCH_CONTACTS, HIGHLEVEL_GET_CONTACT, " +
  "HIGHLEVEL_CREATE_CONTACT, HIGHLEVEL_UPDATE_CONTACT, HIGHLEVEL_ADD_TAGS, HIGHLEVEL_REMOVE_TAGS, HIGHLEVEL_LIST_NOTES, HIGHLEVEL_ADD_NOTE, HIGHLEVEL_LIST_TASKS, HIGHLEVEL_ADD_TASK, " +
  "HIGHLEVEL_LIST_PIPELINES, HIGHLEVEL_SEARCH_OPPORTUNITIES, HIGHLEVEL_GET_OPPORTUNITY, HIGHLEVEL_CREATE_OPPORTUNITY, HIGHLEVEL_UPDATE_OPPORTUNITY, " +
  "HIGHLEVEL_SEARCH_CONVERSATIONS, HIGHLEVEL_READ_CONVERSATION, HIGHLEVEL_LIST_CALENDARS, HIGHLEVEL_LIST_EVENTS, HIGHLEVEL_GET_LOCATION). " +
  "Use them for contacts, tags, notes, tasks, pipelines and deals, reading conversations, and reading calendars; only the tools this bot was granted will run. " +
  "You can never message anyone through the CRM (no SMS, email, WhatsApp, campaigns or workflows); if the user asks for that, say it is not available and offer to prepare the text instead. " +
  "Every change you make in the CRM is recorded in your activity with the record id and the fields changed. " +
  "If a HighLevel tool says it is signed out, ask the user to reconnect HighLevel under Connected apps and end the turn.";

/** The failed-call text when the connection is signed out: the bot asks the person to reconnect and ends the turn. */
export const HIGHLEVEL_SIGNED_OUT_TEXT =
  "OpenMausBot note: HighLevel is signed out (its sign-in expired or was revoked), so this call did not run. " +
  "Ask the person to reconnect HighLevel under Connected apps in OpenMausBot, then end this turn. Do not retry this call before they reconnect.";

/** The failed-call text when no connection exists at all. */
export const HIGHLEVEL_NOT_CONNECTED_TEXT =
  "OpenMausBot note: HighLevel is not connected, so this call did not run. " +
  "Ask the person to connect HighLevel under Connected apps in OpenMausBot, then end this turn.";
