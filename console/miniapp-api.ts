/**
 * Agent-facing Mini App runtime authoring declarations.
 *
 * Copy this file into a generated plugin for type checking. It contains no Host implementation;
 * the Host injects runtime values through start(context).
 * Keep the .ts filename: Electron packaging excludes .d.ts files from dependency assets.
 */
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

declare const HOST_CONNECTOR_TOOL_REF: unique symbol;
export type HostConnectorToolRef = string & {
  readonly [HOST_CONNECTOR_TOOL_REF]: 'HostConnectorToolRef';
};

export interface HostConnectorTool {
  readonly toolRef: HostConnectorToolRef;
  readonly provider: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
  readonly outputSchema?: JsonValue;
}

export interface HostConnectorListResult {
  readonly tools: readonly HostConnectorTool[];
  readonly partial: boolean;
}

export interface HostConnectorCallOptions {
  readonly signal?: AbortSignal;
}

export interface HostConnectorCallResult {
  readonly invocationId: string;
  /**
   * Raw provider result; it is not normalized by the Host and may be an object, array, or primitive.
   * A single text-block array is one provider shape, not a global Host transport contract.
   * Decode only a probe-observed envelope; preserve every other value, including direct strings.
   */
  readonly value: JsonValue;
}

export interface HostConnectorClient {
  /** Candidate-safe inventory only; available before and after activation. */
  list(options?: HostConnectorCallOptions): Promise<HostConnectorListResult>;
  /** Activation-only business dispatch; call from request handling, never start(context). */
  call(
    toolRef: HostConnectorToolRef,
    arguments_: JsonObject,
    options?: HostConnectorCallOptions,
  ): Promise<HostConnectorCallResult>;
}

export type HostConnectorErrorDisposition =
  | 'not_dispatched'
  | 'provider_reported'
  | 'unknown_after_dispatch';

export type HostConnectorErrorCode =
  | 'TOOL_REF_STALE'
  | 'SERVICE_RESTARTED'
  | 'REQUEST_CANCELLED'
  | 'CONNECTOR_TIMEOUT'
  | 'INVALID_ARGUMENTS'
  | 'CONNECTOR_PROVIDER_ERROR'
  | 'CONNECTOR_UNAVAILABLE'
  | 'CONNECTOR_OUTCOME_UNKNOWN';

export interface HostConnectorError extends Error {
  readonly code: HostConnectorErrorCode;
  readonly disposition: HostConnectorErrorDisposition;
  readonly retryable: boolean;
  readonly invocationId?: string;
  readonly diagnostic?: {
    readonly issues: readonly {
      readonly path: string;
      readonly constraint: string;
      readonly limit?: number;
    }[];
  };
}

export interface MiniAppLogger {
  debug(message: string, fields?: JsonObject): void;
  info(message: string, fields?: JsonObject): void;
  warn(message: string, fields?: JsonObject): void;
  error(message: string, fields?: JsonObject): void;
}

export interface MiniAppLifecycle {
  dispose(): void | Promise<void>;
}

export interface MiniAppContext {
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly dataDir: string;
  readonly listen: Readonly<{ readonly host: '127.0.0.1'; readonly port: number }>;
  readonly signal: AbortSignal;
  readonly logger: MiniAppLogger;
  readonly hostConnector?: HostConnectorClient;
}

export interface MiniAppModule {
  /** Resolve only after the listener accepts connections and every route is installed. */
  start(context: MiniAppContext): Promise<void | MiniAppLifecycle>;
}
