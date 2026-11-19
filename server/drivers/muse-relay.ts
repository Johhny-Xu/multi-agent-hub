// An engine whose turns are handed to a Muse personal assistant running in
// its owner's own authorized environment. OpenMausBot persists the turn, a
// Muse hook polls for it, and the reply comes back as runtime events for the
// same thread. There is no native Muse session, token stream or remote abort.
import { z } from "zod";

import type {
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RequestOutcome,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId } from "../contracts.ts";
import {
  defaultMuseRelayHub,
  MUSE_RELAY_MODEL,
  MuseRelayError,
  type MuseRelayHub,
  type MuseRelayHubEvent,
} from "../muse-relay.ts";

const DRIVER_KIND = "museRelay";

const MODELS: ModelCatalog = {
  default: MUSE_RELAY_MODEL,
  options: [{ id: MUSE_RELAY_MODEL, label: "Muse Personal Assistant", custom: true }],
};

const configSchema = z.object({}).strict();
export type MuseRelayConfig = z.output<typeof configSchema>;

interface ActiveTurn {
  turnId: string;
  threadId: string;
}

export interface MuseRelayDriverOptions {
  /** Tests and embedded hosts supply their own hub; the built-in driver uses the process-wide one. */
  hub?: MuseRelayHub;
}

export function createMuseRelayDriver(options: MuseRelayDriverOptions = {}): ProviderDriver<MuseRelayConfig> {
  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "Muse Personal Assistant", supportsMultipleInstances: true, access: "custom" },
    models: MODELS,
    decodeConfig: (raw) => configSchema.parse(raw ?? {}),
    defaultConfig: () => configSchema.parse({}),
    async create(input): Promise<ProviderInstance> {
      const hub = () => options.hub ?? defaultMuseRelayHub();
      const listeners = new Set<RuntimeEventListener>();
      const activeByTurn = new Map<string, ActiveTurn>();
      const activeByThread = new Map<string, string>();
      let unsubscribe: (() => void) | undefined;

      const emit = (event: RuntimeEvent) => {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch (error) {
            console.error("muse relay: a runtime listener failed", error);
          }
        }
      };

      const base = (threadId: string, turnId: string, eventId = newEventId()) => ({
        eventId,
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      const finishTurn = (turnId: string, ok: boolean, stopReason: string, errorMessage?: string) => {
        const active = activeByTurn.get(turnId);
        if (!active) return;
        activeByTurn.delete(turnId);
        if (activeByThread.get(active.threadId) === turnId) activeByThread.delete(active.threadId);
        if (errorMessage !== undefined) {
          emit({
            ...base(active.threadId, turnId, `muse-relay:${turnId}:error`),
            type: "runtime.error",
            message: errorMessage,
            terminal: true,
          });
        }
        emit({
          ...base(active.threadId, turnId, `muse-relay:${turnId}:${ok ? "completed" : "failed"}`),
          type: "turn.completed",
          ok,
          stopReason,
          cost: null,
        });
      };

      const onHubEvent = (event: MuseRelayHubEvent) => {
        if (event.instanceId !== input.instanceId) return;
        if (event.type === "turn.cancelled") {
          finishTurn(event.turnId, false, "interrupted");
          return;
        }
        if (event.type === "turn.failed") {
          finishTurn(event.turnId, false, event.stopReason, event.message);
          return;
        }
        const active = activeByTurn.get(event.turnId);
        if (!active) return;
        if (event.type === "turn.claimed") {
          // Muse holds the message now: a live status for the chat, which also settles the 20 s first-reply notice.
          // itemId carries attempt and stage: the progress gate drops a frame whose key matches the last one.
          const stage = event.via === "input" ? "Muse · receiving" : "Muse";
          emit({
            ...base(event.threadId, event.turnId),
            type: "turn.progress",
            activity: "tool",
            tool: event.attempt > 1 ? `${stage} (retry ${event.attempt})` : stage,
            itemId: `muse-relay:${event.turnId}:a${event.attempt}:${event.via === "input" ? "input" : "worker"}`,
          });
          return;
        }
        if (event.type === "turn.file") {
          emit({
            ...base(event.threadId, event.turnId, `muse-relay:${event.turnId}:${event.file.eventId}`),
            type: "item.completed",
            itemType: "assistant_file",
            itemId: event.file.eventId,
            kind: event.file.kind,
            path: event.file.path,
            mime: event.file.mime,
            ...(event.file.name ? { name: event.file.name } : {}),
          });
          return;
        }
        const payload = event.event;
        if (payload.type === "delta") {
          emit({
            ...base(event.threadId, event.turnId, `muse-relay:${event.turnId}:${payload.eventId}`),
            type: "content.delta",
            streamKind: "assistant_text",
            delta: payload.text ?? "",
            ...(payload.itemId ? { itemId: payload.itemId } : {}),
          });
          return;
        }
        if (payload.type === "text") {
          emit({
            ...base(event.threadId, event.turnId, `muse-relay:${event.turnId}:${payload.eventId}`),
            type: "item.completed",
            itemType: "assistant_text",
            text: payload.text ?? "",
            ...(payload.itemId ? { itemId: payload.itemId } : {}),
          });
          return;
        }
        if (payload.type === "completed") {
          finishTurn(event.turnId, true, payload.stopReason ?? "completed");
          return;
        }
        finishTurn(event.turnId, false, payload.stopReason ?? "failed", payload.text || "Muse reported that this turn failed.");
      };

      const subscribe = () => {
        if (unsubscribe) return;
        unsubscribe = hub().subscribe(onHubEvent);
      };

      const adapter = {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported" as const },
        sendTurn: async (turn: SendTurnInput) => {
          if (activeByThread.has(turn.threadId)) throw new Error("a turn is already running on this thread");
          subscribe();
          const queued = hub().queueTurn({
            instanceId: input.instanceId,
            threadId: turn.threadId,
            text: turn.text,
            ...(turn.system ? { system: turn.system } : {}),
            transcript: turn.transcript ?? [],
          });
          const active: ActiveTurn = { turnId: queued.turnId, threadId: turn.threadId };
          activeByTurn.set(queued.turnId, active);
          activeByThread.set(turn.threadId, queued.turnId);
          emit({ ...base(turn.threadId, queued.turnId), type: "session.started", sessionId: null, model: MUSE_RELAY_MODEL });
          emit({ ...base(turn.threadId, queued.turnId), type: "turn.started" });
          return { turnId: queued.turnId };
        },
        interruptTurn: async (threadId: string, turnId?: string) => {
          const active = activeByThread.get(threadId);
          if (!active || (turnId !== undefined && turnId !== active)) return;
          try {
            hub().cancelTurn(active);
          } catch {
          }
          finishTurn(active, false, "interrupted");
        },
        respondToRequest: async (): Promise<RequestOutcome> => "unavailable",
        hasSession: () => false,
        stopAll: async () => {
          for (const turnId of activeByTurn.keys()) {
            try {
              hub().cancelTurn(turnId);
            } catch {
            }
            finishTurn(turnId, false, "interrupted");
          }
        },
        onEvent: (listener: RuntimeEventListener) => {
          listeners.add(listener);
          subscribe();
          return () => listeners.delete(listener);
        },
      };

      return {
        instanceId: input.instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        models: MODELS,
        snapshot: async (): Promise<ProviderSnapshot> => {
          let online: boolean;
          try {
            online = hub().instanceOnline(input.instanceId);
          } catch (error) {
            if (error instanceof MuseRelayError && error.status === 503) {
              return { state: "unavailable", reason: "The Muse relay state could not be read." };
            }
            throw error;
          }
          return {
            state: "available",
            authenticated: true,
            version: null,
            ...(online ? {} : {
              warning: {
                title: "Muse is offline",
                message: "No Muse connection has checked in recently. Messages wait in the relay until it reconnects.",
              },
            }),
          };
        },
        adapter,
        dispose: async () => {
          unsubscribe?.();
          unsubscribe = undefined;
          activeByTurn.clear();
          activeByThread.clear();
          listeners.clear();
        },
      };
    },
  };
}

export const MuseRelayDriver = createMuseRelayDriver();
