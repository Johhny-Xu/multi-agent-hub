// Security: the key is write-only; the server reports configured-or-not, never the value.
import { useEffect, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { LearnMore, SETTINGS_INPUT, SettingRow, SettingsField, SettingsFormFoot, SettingsGroup, SettingsRows, StatusDot, Switch } from "./SettingsPrimitives";
import { Select } from "./Select";
import { WorkersAiKeyCard } from "./WorkersAiKeyCard";
import { openKeySettings } from "./keys/key-focus";

type CustomApi = "systemone" | "decisions" | "chat";
const customApiOf = (api: string | undefined): CustomApi => (api === "decisions" || api === "chat" ? api : "systemone");

const KEY_URL = { jev: "https://typesafe.ai", openrouter: "https://openrouter.ai/keys", gemini: "https://aistudio.google.com/api-keys" } as const;
/** Gemini's key has no desktop credential slot: it always goes through the server's config. */
const KEY_SLOT = {
  jev: { credential: "jevApiKey", field: "key" },
  openrouter: { credential: "openrouterDeciderKey", field: "openrouterKey" },
  gemini: { credential: null, field: "geminiKey" },
  custom: { credential: "customDeciderKey", field: "customKey" },
} as const;
const COPY: Record<Provider, { master: LocaleKey; needsKey: LocaleKey; keyLabel: LocaleKey; placeholder: LocaleKey }> = {
  jev: { master: "decider.master", needsKey: "decider.masterNeedsKey", keyLabel: "decider.key.label", placeholder: "decider.key.placeholder" },
  openrouter: {
    master: "decider.openrouter.master", needsKey: "decider.masterNeedsKey.openrouter",
    keyLabel: "decider.openrouter.key.label", placeholder: "decider.openrouter.key.placeholder",
  },
  gemini: { master: "decider.gemini.master", needsKey: "decider.masterNeedsKey.gemini", keyLabel: "decider.gemini.key.label", placeholder: "decider.gemini.key.placeholder" },
  custom: { master: "decider.custom.master", needsKey: "decider.custom.masterNeedsKey", keyLabel: "decider.custom.key.label", placeholder: "decider.custom.key.placeholder" },
};
/** The room decision budget in server/decider/room-routing.ts; slower falls back to the lead. */
const ROOM_BUDGET_MS = 1_500;

type Provider = "jev" | "openrouter" | "gemini" | "custom";
type ModelList = { source: "openrouter" | "builtin"; models: Array<{ id: string; name: string; group: "recommended" | "more" | "chat"; api?: "chat" | "decisions" }> };
const MODEL_GROUP = { recommended: "decider.model.recommended", more: "decider.model.more", chat: "decider.model.geminiChat" } as const satisfies Record<string, LocaleKey>;
type TestResult = { ok: true; latencyMs: number } | { ok: false; reason: unknown; status?: number };

const FAILURES: Record<string, LocaleKey> = {
  rejected: "decider.error.rejected",
  unreachable: "decider.error.unreachable",
  timeout: "decider.error.timeout",
  rate_limited: "decider.error.rateLimited",
  overloaded: "decider.error.overloaded",
  malformed: "decider.error.malformed",
  no_key: "decider.error.noKey",
  misconfigured: "decider.error.misconfigured",
};

/** Cloud Pro's relay refuses an inactive subscription (402) and a used-up month of decisions (429). */
const INCLUDED_FAILURES: Record<string, LocaleKey> = {
  rejected: "decider.included.error.rejected",
  rate_limited: "decider.included.error.limited",
};

const OPENROUTER_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.openrouter.error.rejected",
  unreachable: "decider.openrouter.error.unreachable",
  timeout: "decider.openrouter.error.timeout",
  rate_limited: "decider.openrouter.error.rateLimited",
  overloaded: "decider.openrouter.error.overloaded",
  malformed: "decider.openrouter.error.malformed",
};

const CUSTOM_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.custom.error.rejected",
  unreachable: "decider.custom.error.unreachable",
  timeout: "decider.custom.error.timeout",
  rate_limited: "decider.custom.error.rateLimited",
  overloaded: "decider.custom.error.overloaded",
  malformed: "decider.custom.error.malformed",
  misconfigured: "decider.custom.error.misconfigured",
};

const WORKERS_AI_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.workersAi.error.rejected",
  unreachable: "decider.workersAi.error.unreachable",
  timeout: "decider.workersAi.error.timeout",
  rate_limited: "decider.workersAi.error.rateLimited",
  overloaded: "decider.workersAi.error.overloaded",
  malformed: "decider.workersAi.error.malformed",
};

const GEMINI_FAILURES: Record<string, LocaleKey> = {
  ...FAILURES,
  rejected: "decider.gemini.error.rejected",
  unreachable: "decider.gemini.error.unreachable",
  timeout: "decider.gemini.error.timeout",
  rate_limited: "decider.gemini.error.rateLimited",
  overloaded: "decider.gemini.error.overloaded",
  malformed: "decider.gemini.error.malformed",
  no_key: "decider.gemini.error.noKey",
  misconfigured: "decider.gemini.error.misconfigured",
  too_large: "decider.gemini.error.tooLarge",
  blocked: "decider.gemini.error.blocked",
};

const BY: Record<Provider | "workersai", LocaleKey> = {
  jev: "decider.status.byJev", workersai: "decider.status.byWorkersAi", openrouter: "decider.status.byOpenRouter", custom: "decider.status.byCustom",
  gemini: "decider.status.byGemini",
};

/** Who decides and who reads, in a word each: the person's own key, the Cloud plan's, or nothing yet. */
export function helpersStatusLine(config: ConfigStatus | null): string {
  const decider = config?.decider;
  const extraction = config?.helpers?.extraction;
  const decisions = !decider?.configured ? t("decider.status.notSetUp")
    : decider.included ? t("decider.status.byCloud") : t(BY[decider.provider] ?? BY.jev);
  const reading = !extraction?.provider ? t("decider.status.notSetUp")
    : extraction.included ? t("decider.status.byCloud") : t(BY[extraction.provider]);
  return t("decider.status.line", { decisions, extraction: reading });
}

function failureReason(value: unknown): string {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (!value || typeof value !== "object") return "";
  for (const key of ["reason", "code", "status", "error"] as const) {
    const nested = failureReason((value as Record<string, unknown>)[key]);
    if (nested) return nested;
  }
  return "";
}

/** A fixed sentence per failure: the vendor's own body never reaches the UI. */
export function deciderFailureText(result: { reason: unknown; status?: number }, included = false, provider: Provider | "workersai" = "jev"): string {
  const reason = failureReason(result.reason);
  if (provider === "workersai") {
    if (reason === "http_error") return t("decider.workersAi.error.http", { status: String(result.status ?? "?") });
    const key = WORKERS_AI_FAILURES[reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (provider === "custom") {
    if (reason === "http_error") return t("decider.custom.error.http", { status: String(result.status ?? "?") });
    const key = CUSTOM_FAILURES[reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (provider === "openrouter") {
    // 402 is OpenRouter's answer for an account with no credits left.
    if (reason === "http_error" && result.status === 402) return t("decider.openrouter.error.credits");
    if (reason === "http_error") return t("decider.openrouter.error.http", { status: String(result.status ?? "?") });
    const key = OPENROUTER_FAILURES[reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (provider === "gemini") {
    if (reason === "http_error") return t("decider.gemini.error.http", { status: String(result.status ?? "?") });
    const key = GEMINI_FAILURES[reason];
    return key ? t(key) : t("decider.error.other");
  }
  if (included && reason === "http_error" && result.status === 402) return t("decider.included.error.subscription");
  if (included && INCLUDED_FAILURES[reason]) return t(INCLUDED_FAILURES[reason]!);
  if (reason === "http_error") return t("decider.error.http", { status: String(result.status ?? "?") });
  const key = FAILURES[reason];
  return key ? t(key) : t("decider.error.other");
}

const asProvider = (value: string | undefined): Provider => (value === "openrouter" || value === "custom" || value === "gemini" ? value : "jev");

/** A text setting saved when it loses focus or on Enter, and only when it changed. */
function SavedText({ saved, onSave, disabled, label, placeholder, testId }: {
  saved: string; onSave: (value: string) => void; disabled: boolean; label: string; placeholder: string; testId: string;
}) {
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const commit = () => { if (value.trim() !== saved) onSave(value.trim()); };
  return (
    <input
      type="text"
      data-testid={testId}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && commit()}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      className={cn(SETTINGS_INPUT, "[width:var(--settings-select-width,200px)] max-w-full")}
    />
  );
}

export function DecisionModelSettings() {
  const { state, dispatch } = useStore();
  const decider = state.config?.decider;
  const provider = asProvider(decider?.chosen ?? decider?.provider);
  const openrouter = provider === "openrouter";
  const gemini = provider === "gemini";
  const custom = provider === "custom";
  const keySlot = KEY_SLOT[provider];
  const configured = decider?.configured ?? false;
  const included = configured && decider?.included === true;
  // The shared OpenRouter key decides, whether OpenRouter is chosen or it stands in for a chosen Jev with no key yet.
  const usingShared = configured && decider?.keySource === "shared";
  const sharedOpenRouter = openrouter && usingShared;
  const sharedKey = openrouter && decider?.sharedKey === true;
  const ownKey = configured && !included && !usingShared;
  const enabled = decider?.enabled ?? false;
  const roomRouting = decider?.jobs.roomRouting ?? true;
  const browserAutomation = decider?.jobs.browserAutomation ?? false;
  const browserTextModel = decider?.jobs.browserTextModel ?? true;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const initialProxy = decider?.proxyUrl ?? "";
  const [proxyUrl, setProxyUrl] = useState(initialProxy);
  const [prevProxy, setPrevProxy] = useState(decider?.proxyUrl);
  const [savingProxy, setSavingProxy] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);

  if (decider?.proxyUrl !== prevProxy) {
    setPrevProxy(decider?.proxyUrl);
    setProxyUrl(decider?.proxyUrl ?? "");
  }
  const [more, setMore] = useState(false);
  const draft = value.trim();
  const clearing = !draft && ownKey;
  const keyHint: LocaleKey | null = !openrouter || included
    ? null
    : usingShared
      ? "decider.openrouter.status.sharedHint"
      : !configured
        ? "decider.openrouter.status.notConnectedHint"
        : sharedKey
          ? "decider.openrouter.status.ownFallbackHint"
          : null;

  const applied = (config: ConfigStatus) => dispatch({ type: "configStatus", config });

  const patch = async (decision: Record<string, unknown>) => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      applied(await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: decision }) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSwitching(false);
    }
  };

  useEffect(() => {
    if (!openrouter || models) return;
    let cancelled = false;
    api<ModelList>("/api/decider/models").then(
      (list) => { if (!cancelled) setModels(list); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [openrouter, models]);

  const choose = (decision: { provider: Provider } | { openrouterModel: string; openrouterApi: "chat" | "decisions" } | { customApi: CustomApi }) => {
    setValue("");
    setVerdict(null);
    void patch(decision);
  };

  const save = async () => {
    if (saving || (!draft && !ownKey)) return;
    setSaving(true);
    setError(null);
    setVerdict(null);
    try {
      const status = keySlot.credential && window.ogb?.setCredential
        ? await window.ogb.setCredential(keySlot.credential, draft)
        : await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ decider: { [keySlot.field]: draft } }) });
      applied(status);
      setValue("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveProxy = async () => {
    if (savingProxy) return;
    setSavingProxy(true);
    setProxyError(null);
    try {
      const result = await api<{ ok: boolean; proxyUrl?: string }>("/api/decider/proxy", {
        method: "PUT",
        body: JSON.stringify({ proxyUrl }),
      });
      if (result.proxyUrl !== undefined) {
        setProxyUrl(result.proxyUrl);
      }
      if (state.config?.decider) {
        dispatch({
          type: "configStatus",
          config: {
            ...state.config,
            decider: { ...state.config.decider, proxyUrl: result.proxyUrl },
          },
        });
      }
    } catch (cause) {
      setProxyError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingProxy(false);
    }
  };

  const test = async () => {
    if (testing || saving || (!draft && !configured)) return;
    setTesting(true);
    setVerdict(null);
    setError(null);
    const testingIncluded = !draft && included;
    const testingShared = !draft && usingShared;
    // The saved independent Gemini key answers a test with no draft; its verdict must not name Jev or OpenRouter.
    const testingGemini = !draft && configured && decider?.provider === "gemini";
    try {
      const result = await api<TestResult>("/api/decider/test", { method: "POST", body: JSON.stringify(draft ? { key: draft } : {}) });
      setVerdict(result.ok
        ? {
          ok: true,
          text: openrouter || custom || testingShared || testingGemini
            ? [
              t(testingGemini ? "decider.gemini.test.ok" : custom ? "decider.custom.test.ok" : testingShared ? "decider.openrouter.test.okShared" : "decider.openrouter.test.ok", { ms: String(result.latencyMs) }),
              ...(result.latencyMs > ROOM_BUDGET_MS ? [t("decider.test.slow")] : []),
            ].join(" ")
            : gemini
              ? t("decider.gemini.test.ok", { ms: String(result.latencyMs) })
              : t("decider.test.ok", { ms: String(result.latencyMs) }),
        }
        : { ok: false, text: deciderFailureText(result, testingIncluded, testingGemini ? "gemini" : testingShared ? "openrouter" : provider) });
    } catch (cause) {
      setVerdict({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  const keyLabel = t(COPY[provider].keyLabel);
  const keyStatus = included
    ? t("keys.includedWithCloudPro")
    : usingShared
      ? t("decider.openrouter.status.shared")
      : configured
        ? t(sharedKey ? "decider.openrouter.status.own" : "decider.status.connected")
        : t("decider.status.notConnected");
  return (
    <>
      <SettingsGroup label={t("settings.ai.routing")} block="routing"
        description={<>{t("decider.introShort")}{" "}<LearnMore onClick={() => setMore(!more)} /></>}>
        {more && <p data-decider-more="" className="px-4 text-[12px] leading-4 text-ink-secondary">{t("decider.intro")}</p>}
        <SettingsRows>
          <SettingRow
            title={t(COPY[provider].master)}
            subtitle={<span role="status" data-testid="helpers-status">{helpersStatusLine(state.config)}</span>}
            message={configured ? undefined : t(COPY[provider].needsKey)}
          >
            <Switch
              data-testid="decider-master"
              aria-label={t(COPY[provider].master)}
              checked={enabled}
              disabled={!configured || switching || !state.config}
              onClick={() => void patch({ enabled: !enabled })}
              className="cursor-pointer"
            />
          </SettingRow>
        </SettingsRows>
      </SettingsGroup>
      <WorkersAiKeyCard failureText={(result) => deciderFailureText(result, false, "workersai")} />
      <SettingsGroup label={t("decider.provider.label")} block="routing-key">
        <SettingsRows selectWidth={200}>
          <SettingRow title={t("decider.provider.title")}>
            <Select
              data-testid="decider-provider"
              value={provider}
              onChange={(event) => choose({ provider: asProvider(event.target.value) })}
              disabled={switching || !state.config}
              aria-label={t("decider.provider.label")}
            >
              <option value="jev">{t("decider.provider.jev")}</option>
              <option value="openrouter">{t("decider.provider.openrouter")}</option>
              <option value="gemini">{t("decider.provider.gemini")}</option>
              <option value="custom">{t("decider.provider.custom")}</option>
            </Select>
          </SettingRow>
          {custom && (
            <>
              <SettingRow title={t("decider.custom.baseUrl")} subtitle={t("decider.custom.baseUrlDetail")}>
                <SavedText testId="decider-custom-base-url" saved={decider?.baseUrl ?? ""} disabled={switching}
                  label={t("decider.custom.baseUrl")} placeholder={t("decider.custom.baseUrlPlaceholder")}
                  onSave={(customBaseUrl) => void patch({ customBaseUrl })} />
              </SettingRow>
              <SettingRow title={t("decider.custom.model")}>
                <SavedText testId="decider-custom-model" saved={decider?.model ?? ""} disabled={switching}
                  label={t("decider.custom.model")} placeholder={t("decider.custom.modelPlaceholder")}
                  onSave={(customModel) => void patch({ customModel })} />
              </SettingRow>
              <SettingRow title={t("decider.custom.api")}>
                <Select
                  data-testid="decider-custom-api"
                  value={customApiOf(decider?.api)}
                  onChange={(event) => choose({ customApi: customApiOf(event.target.value) })}
                  disabled={switching}
                  aria-label={t("decider.custom.api")}
                >
                  <option value="systemone">{t("decider.custom.api.systemone")}</option>
                  <option value="decisions">{t("decider.custom.api.decisions")}</option>
                  <option value="chat">{t("decider.custom.api.chat")}</option>
                </Select>
              </SettingRow>
            </>
          )}
          {openrouter && (
            <SettingRow title={t("decider.model.label")} subtitle={models?.source === "builtin" ? t("decider.model.builtinNote") : undefined}>
              <Select
                data-testid="decider-model"
                value={decider?.model ?? ""}
                onChange={(event) => choose({
                  openrouterModel: event.target.value,
                  openrouterApi: models?.models.find((model) => model.id === event.target.value)?.api ?? "chat",
                })}
                disabled={switching}
                aria-label={t("decider.model.label")}
              >
                {decider?.model && !models?.models.some((model) => model.id === decider.model) && (
                  <option value={decider.model}>{decider.model}</option>
                )}
                {(["recommended", "more", "chat"] as const).map((group) => {
                  const inGroup = models?.models.filter((model) => model.group === group) ?? [];
                  return inGroup.length > 0 && (
                    <optgroup key={group} label={t(MODEL_GROUP[group])}>
                      {inGroup.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                    </optgroup>
                  );
                })}
              </Select>
            </SettingRow>
          )}
          <div data-decider-key="" className="flex flex-col gap-2 px-4 pb-1 pt-3">
            <SettingsField label={keyLabel}>
              <input
                type="password"
                value={value}
                onChange={(event) => { setVerdict(null); setError(null); setValue(event.target.value); }}
                onKeyDown={(event) => event.key === "Enter" && void save()}
                disabled={saving}
                placeholder={ownKey ? t("keys.replace") : t(sharedOpenRouter ? "decider.openrouter.key.overridePlaceholder" : COPY[provider].placeholder)}
                aria-label={keyLabel}
                autoComplete="off"
                spellCheck={false}
                className={SETTINGS_INPUT}
              />
            </SettingsField>
            <p className="text-[13px] leading-[18px] text-ink-secondary">
              {keyHint && <>{t(keyHint)}{" "}</>}
              {keyHint && !ownKey && (
                <><button type="button" data-testid="decider-manage-keys" onClick={() => dispatch(openKeySettings("openrouter"))}
                  className="cursor-pointer text-accent-text hover:underline">{t("decider.openrouter.key.manageLink")}</button>{" "}</>
              )}
              {!sharedOpenRouter && provider !== "custom" && (
                <a href={KEY_URL[provider]} target="_blank" rel="noopener noreferrer" className="cursor-pointer text-accent-text hover:underline focus-visible:underline">
                  {t(openrouter ? "decider.openrouter.key.getKey" : gemini ? "decider.gemini.key.getKey" : "decider.key.getKey")}
                </a>
              )}
            </p>
          </div>
          <SettingsFormFoot status={<span className="flex flex-col gap-1">
            <span role="status" className="flex items-center"><StatusDot tone={configured ? "success" : null} />{!configured && <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-ink/20" />}{keyStatus}</span>
            {error && <span role="alert" className="text-danger">{error}</span>}
            {verdict && <span role="status" className={verdict.ok ? "text-ink-secondary" : "text-danger"}>{verdict.text}</span>}
          </span>}>
            <button
              type="button"
              data-testid="decider-test"
              onClick={() => void test()}
              disabled={testing || saving || (!draft && !configured)}
              className="ui-button ui-button-md cursor-pointer rounded-full"
            >
              {testing ? t("keys.testing") : t("keys.test")}
            </button>
            <button
              type="button"
              data-testid="decider-save"
              onClick={() => void save()}
              disabled={saving || (!draft && !ownKey)}
              title={clearing ? t("keys.removeKey") : t("common.save")}
              className={cn("ui-button ui-button-md cursor-pointer rounded-full", clearing && "!text-danger")}
            >
              {saving ? t("settings.threads.saving") : clearing ? t("keys.clear") : t("common.save")}
            </button>
          </SettingsFormFoot>
        </SettingsRows>
      </SettingsGroup>

      {!openrouter && (
        <SettingsGroup label={t("decider.jev.proxy.title")} block="routing-proxy" description={t("decider.jev.proxy.help")}>
          <SettingsRows>
            <div className="flex flex-col gap-2 px-4 pb-1 pt-3">
              <SettingsField label={t("decider.jev.proxy.title")}>
                <input
                  type="text"
                  value={proxyUrl}
                  onChange={(event) => { setProxyError(null); setProxyUrl(event.target.value); }}
                  onKeyDown={(event) => event.key === "Enter" && void saveProxy()}
                  disabled={savingProxy}
                  placeholder="http://127.0.0.1:7890"
                  aria-label={t("decider.jev.proxy.title")}
                  autoComplete="off"
                  spellCheck={false}
                  className={SETTINGS_INPUT}
                />
              </SettingsField>
            </div>
            <SettingsFormFoot status={proxyError ? <span role="alert" className="text-danger">{proxyError}</span> : undefined}>
              <button
                type="button"
                data-testid="decider-proxy-save"
                onClick={() => void saveProxy()}
                disabled={savingProxy || proxyUrl === initialProxy}
                className="ui-button ui-button-md cursor-pointer rounded-full"
              >
                {savingProxy ? t("settings.threads.saving") : t("common.save")}
              </button>
            </SettingsFormFoot>
          </SettingsRows>
        </SettingsGroup>
      )}

      <SettingsGroup label={t("decider.jobs.title")} block="routing-jobs">
        <SettingsRows>
          <SettingRow title={t("decider.jobs.roomRouting")} subtitle={t("decider.jobs.roomRoutingDetail")}>
            <Switch
              data-testid="decider-job-roomRouting"
              aria-label={t("decider.jobs.roomRouting")}
              checked={enabled && roomRouting}
              disabled={!enabled || switching}
              onClick={() => void patch({ jobs: { roomRouting: !roomRouting } })}
              className="cursor-pointer"
            />
          </SettingRow>
          <SettingRow title={t("decider.jobs.browserAutomation")} subtitle={<>{t("decider.jobs.browserAutomationDetail")}{(gemini || (!openrouter && !custom && !configured)) && <><br />{t("decider.jobs.browserAutomationMissingJev")}</>}{(openrouter || custom) && <><br />{t("decider.jobs.browserAutomationJevOnly")}</>}</>}>
            <Switch
              data-testid="decider-job-browserAutomation"
              aria-label={t("decider.jobs.browserAutomation")}
              checked={enabled && browserAutomation}
              disabled={!enabled || switching || openrouter || custom || gemini}
              onClick={() => void patch({ jobs: { browserAutomation: !browserAutomation } })}
              className="cursor-pointer"
            />
          </SettingRow>
          <SettingRow title={t("decider.jobs.browserTextModel")} subtitle={t("decider.jobs.browserTextModelDetail")}>
            <Switch
              data-testid="decider-job-browserTextModel"
              aria-label={t("decider.jobs.browserTextModel")}
              checked={enabled && browserTextModel}
              disabled={!enabled || switching || openrouter}
              onClick={() => void patch({ jobs: { browserTextModel: !browserTextModel } })}
              className="cursor-pointer"
            />
          </SettingRow>
          {/* Jobs that aren't built yet are not listed: a row nobody can use is noise (§6.5 Not applicable). */}
        </SettingsRows>
      </SettingsGroup>
    </>
  );
}
