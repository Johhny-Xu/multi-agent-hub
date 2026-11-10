// The ACP driver's configuration and per-CLI support contract (C2-W3: moved verbatim out of core.ts,
// nothing changed). core.ts imports these and re-exports the names, so every existing importer is untouched.
import { type ServerText } from "../../../shared/server-text.ts";
import type {
  EffortLevel,
  EngineInstall,
  ModelCatalog,
  ProviderErrorCode,
  ProviderSnapshot,
  SendTurnInput,
} from "../../contracts.ts";
import { type DeviceSignIn } from "../device-auth.ts";
import { type AcpQuestionRequest } from "./question-requests.ts";
import { type AcpModelSelection } from "./session-model-controls.ts";
import { type AcpMcpServer } from "../turn-mcp.ts";
import { type LogSignal } from "./quiet-status.ts";

export type AccountErrorCode = Extract<ProviderErrorCode,
  "invalid_credentials" | "inactive_subscription" | "insufficient_funds" | "quota_or_region_restriction">;
const ACCOUNT_ERROR_CODES: ReadonlySet<ProviderErrorCode> = new Set<AccountErrorCode>([
  "invalid_credentials", "inactive_subscription", "insufficient_funds", "quota_or_region_restriction",
]);
export const isAccountError = (code: ProviderErrorCode | undefined): code is AccountErrorCode =>
  code !== undefined && ACCOUNT_ERROR_CODES.has(code);

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  workspace?: string;
}

/** Per-CLI specifics plugged into the shared ACP runtime; `askTool` is the native tool `questionRequests` come from. */
export interface AcpSupport {
  questionRequests?: Readonly<Record<string, AcpQuestionRequest>>; askTool?: string;
  /** Verified native catalog parameters, applied before both new and restored sessions. */
  toolScopeSessionParams?(turn: SendTurnInput, initializeResult: unknown, hasMcp: boolean,
    context: { config: AcpConfig; env: Record<string, string | undefined>; cwd: string }): Record<string, unknown>;
  /** Existing native restrictions also participate in scoped session reuse. */
  toolScopeCacheKey?(context: { config: AcpConfig; env: Record<string, string | undefined>; cwd: string }): string;
  driverKind: string;
  displayName: string; /** What this CLI's own `--version` looks like: any other answer is another program behind the CLI path. */ cliVersion?: RegExp;
  /** Omit for subscription CLIs. Custom-only CLIs have no first-party cloud catalog. */
  access?: "subscription" | "custom";
  models: ModelCatalog;
  /** Effort levels the CLI accepts, ascending; omit when it has none. Static because describe()
   * runs before any session exists. */
  effortLevels?: readonly EffortLevel[];
  /** Discover and select opaque model variants through ACP config options. */
  modelVariants?: boolean;
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Optional live model catalog; a failed lookup keeps the last usable one. `config` lets a support ask the binary
   *  it will spawn, not whatever is on PATH; `fresh` is the person's Refresh, which may bypass the CLI's own cache. */
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string, fresh?: boolean,
  ): ModelCatalog | Promise<ModelCatalog>;
  /** Some managed agents are not probed at app startup; their Refresh is the only lookup. */
  resolveModelsOnCreate?: boolean;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Whether models behind this CLI can consume a referenced image. */
  images?: boolean;
  /** Narrow compatibility exception for a CLI with verified native image
   * transport but a defective initialize capability (never a path fallback). */
  acceptsUnadvertisedImages?(initializeResult: unknown): boolean;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** How a user installs this harness's CLI; surfaced by the setup UI. */
  install?: EngineInstall;
  /** The CLI's own device-code login (`grok login --device-auth`), run with the turns' binary and
   * environment and confirmed by isAuthenticated. */
  deviceSignIn?: DeviceSignIn;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /** Provider credential variables this ACP child is allowed to inherit. */
  credentialEnv?: readonly string[];
  /** Select the model through a session config option instead of argv (opencode's ACP subcommand
   *  takes no -m). The agent must confirm it before the prompt. */
  selectModel?: AcpModelSelection;
  /** With `selectModel`: the model a turn runs when it asked for none or for one this session does
   * not offer; null keeps the strict behaviour. */
  fallbackModel?(sessionConfig: unknown, catalogDefault: string): string | null;
  /** Env var the runtime reads its new-session default model from, set at spawn so session/new runs
   * it. The runtime takes any id unchecked, so it is set only for a model this account offered. Not
   * part of the spawn contract. */
  sessionModelEnv?: string;
  /** Spawn-contract state outside the env that a running process never re-reads (OpenCode's auth.json). */
  spawnFingerprint?(env: Record<string, string | undefined>, config: AcpConfig): string;
  /** The approval mode is applied per turn by configureSession, which must throw unless the runtime
   * confirms it; an approval change never respawns the process. */
  sessionScopedApproval?: boolean;
  /** False when this engine cannot run memory upkeep's one-shot text call cleanly; oneShotFolder holds a one-shot's folder. */
  backgroundText?: false; oneShotFolder?(): Promise<string>;
  /** Mutate the child env in place. `instanceEnvironment` tells a key put there on purpose from one
   *  riding along in the server's own env. */
  transformEnv?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
    instanceEnvironment: Readonly<Record<string, string>>,
  ): void;
  /** Resolve a managed or account-scoped executable just before use. */
  resolveCommand?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): Promise<{ command: string; args?: string[]; env?: Record<string, string | undefined> }>;
  /** Snapshot override for agents whose binary has no conventional --version. */
  snapshot?(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): Promise<ProviderSnapshot>;
  /** Google Antigravity resumes through session/resume, not session/load. */
  resumeMethod?: "load" | "resume";
  /** Some agents acknowledge a live load without applying new MCP credentials. */
  restartOnMcpChange?: boolean; /** The turn's MCP servers come from launcher-owned configuration, not ACP session parameters. */ mcpServersFromLaunch?: boolean;
  /** hermes-agent 0.22.4 re-sends a streamed reply whole under its messageId, as its `💭` reasoning block, a blank line,
   * then the reply; that chunk is dropped instead of appended. */
  resendsReasoningReply?: boolean;
  /** Threads with the same spawn contract run their sessions in one process (OpenCode 1.19: about 100 MB a session
   * instead of about 450 MB a process), up to SHARED_SESSIONS_MAX. */
  shareProcess?: boolean;
  /** Route workspace file access through ACP so edits retain approval cards. */
  clientFileSystem?: boolean;
  /** Sent as `clientCapabilities._meta` on initialize, where agents read vendor capabilities. */
  clientCapabilitiesMeta?: Record<string, unknown>;
  /** Made once per process: rewrites a session/update before the turn reads it, or drops it by returning null. */
  updateFilter?(): (update: Record<string, any>) => Record<string, any> | null;
  /** The agent reaches MCP servers by URL: OpenMausBot's own servers are this server's endpoints, no process each. */
  ownMcpOverHttp?: boolean;
  /** The engine receives session/new's mcpServers. A bridge that drops them (codearts, meoo,
   *  mcode) declares false, and the workbench then offers the bot no MCP-class tools. */
  mcp?: boolean;
  /** How many tools the agent lists of its own beside the MCP servers', counted against a provider's tool limit. */
  engineTools?: number;
  /** The agent's own debug log, read while a prompt is quiet: a new line proves it alive and `parse`
   * picks what to tell the person. Null when this process keeps none. A `shared` log holds every session's
   * and process's lines, so its lines prove nothing about this turn and only `parse` reads them. */
  statusLog?: {
    path(env: Record<string, string | undefined>, sessionId: string): string | null;
    parse(line: string, sessionId: string): LogSignal | null;
    shared?: true;
  };
  /** Bound provider-native tool payloads before writing diagnostic logs. */
  sanitizeToolPayload?: boolean;
  /** Mutate the child env once the turn model is known; catalog refresh and snapshot see only `transformEnv`. */
  applyTurnEnv?(
    env: Record<string, string | undefined>,
    ctx: { model?: string; requestedModel?: string; fullAuto: boolean; botId?: string; cwd: string; toolScope?: SendTurnInput["toolScope"]; threadId: string; mcpServers: AcpMcpServer[] },
  ): void;
  /** The authenticate methodId from initialize's authMethods; null skips authenticate. */
  pickAuthMethod(authMethods: Array<{ id?: string }>, env: Record<string, string | undefined>): string | null;
  /** "fail": abort if auth is missing/errors (subscription CLIs).
   * "fail-request": cached API credentials need no method, but a requested
   * OAuth login must succeed. "continue": proceed on an ambient login. */
  authFailure: "fail" | "fail-request" | "continue";
  /** Whether this CLI can run a turn (env carries the merged config). */
  isAuthenticated(
    env: Record<string, string | undefined>,
    config: AcpConfig,
    instanceId: string,
  ): boolean | Promise<boolean>;
  /** Refuse a first-party cloud turn before spawning when snapshot auth is
   * false. Local injected models deliberately bypass this subscription gate. */
  requireAuthenticationBeforeSpawn?: boolean;
  /** Classify provider-native failures without coupling the core to messages. */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** A session/prompt error saying the agent never reached its model; startup recovery then holds the ACK for it. */
  promptUnreachedModel?(error: unknown): boolean;
  /** The output-token cap one model request runs under in this process (E54); a turn whose last request spent it
   * all without writing anything after its last tool was cut off while thinking. */
  outputTokenCap?(env: Record<string, string | undefined>): number | undefined;
  /** How far a usage limit the engine reports reaches: its whole account, or one allowance its models share (OpenCode's free models), with the models that allowance holds. */ limitFacts?(text: string, model?: string): { limit: "engine" | "model"; limitModels?: string[] };
  /** Plain words for an account failure (bad key, no credit, a used-up
   * quota, no subscription) in place of the provider's raw RPC text. */
  describeAccountError?(code: AccountErrorCode, model?: string): string;
  accountErrorText?(code: AccountErrorCode): ServerText | undefined;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Rewrite a picker id (`omlx::model`) into the CLI-native id before spawn and session/select. */
  resolveTurnModel?(
    model: string | undefined,
    env: Record<string, string | undefined>,
  ): string | undefined;
  /** Map a saved selection onto the live session's catalog (a retired model id), once session/new or load answers. */
  normalizeSessionSelection?(turn: SendTurnInput, offeredModels: readonly string[]): SendTurnInput;
  /** Per-session settings between session/new (or load) and the first prompt. Some CLIs ignore argv
   * and take the model/mode over the wire (droid); a throw fails the turn rather than run another model. */
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string;
    env: Record<string, string | undefined>;
    config: AcpConfig;
    turn: SendTurnInput;
    /** The session's advertised models, verbatim: some CLIs name ACP model ids differently from
     * their argv slugs (Cursor answers `default[]` for the CLI's `auto`). */
    sessionModels: Array<{ modelId?: string; name?: string }>;
    /** Last model acknowledged by session/new/load/set_model, preserved for pooled turns. */
    currentModelId?: string;
    /** session/new's or session/load's `configOptions`, verbatim. */
    configOptions: Array<{ id?: unknown; currentValue?: unknown }>;
    /** Tell the person the session runs another model than the one picked. */
    notice: (message: string) => void;
  }): Promise<void>;
}
