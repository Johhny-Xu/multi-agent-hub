// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineSetup, EngineUpdateNotice, installCommandFor, isWebChatEngine, needsCli, needsSignIn } from "./EngineSetup";
import { providerName } from "./EngineLibrary";
import { HarkMark, ProviderMark } from "./ProviderIcons";
import { engineStatus } from "./ModelPickerFull";
import { BotEditorStore, initialState, StoreProvider, type InstanceInfo, type useStore } from "@/state/store";

afterEach(() => vi.unstubAllGlobals());

it("chooses the server installer even when the client has a different OS", () => {
  vi.stubGlobal("window", { ogb: { platform: "win32" } });
  expect(installCommandFor({ platform: "linux", command: { linux: "linux-install", win32: "windows-install" } })).toBe("linux-install");
  expect(installCommandFor({ platform: "linux", command: { win32: "windows-only" } })).toBeNull();
});

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("managed engine setup errors", () => {
  function managed(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
    return {
      ...instance(snapshot),
      instanceId: "antigravity",
      driverKind: "antigravityAgent",
      displayName: "Antigravity",
      install: { managed: { label: "Install official Antigravity", downloadBytes: 1024 } },
    };
  }

  function render(engine: InstanceInfo): string {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  }

  it("shows profile failures without claiming the runtime is missing", () => {
    const reason = "Cannot write Antigravity profile settings (EACCES).";
    const engine = managed({ state: "unavailable", reason });
    const markup = render(engine);
    expect(markup).toContain(reason);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Install official Antigravity");
    expect(engineStatus(engine)).toBe("Setup required");
    expect(markup).not.toMatch(/CLI not found|Not installed/);
  });

  it("renders an initialization failure reported by the snapshot", () => {
    const engine = managed({ state: "unavailable", reason: "initialize timed out." });
    expect(render(engine)).toContain("initialize timed out.");
    expect(engineStatus(engine)).toBe("Setup required");
  });

  it("preserves the installed engine's sign-in flow", () => {
    const engine = managed({ state: "available", authenticated: false, version: "1.1.1" });
    const markup = render(engine);
    expect(engineStatus(engine)).toBe("Sign-in required");
    expect(markup).toContain("Sign in with Google");
    expect(markup).not.toContain("Install official Antigravity");
  });
});

describe("engines set up with a key in Settings", () => {
  it("opens Settings → API keys instead of offering a terminal command", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    const engine: InstanceInfo = {
      ...instance({ state: "unavailable", reason: "No API key — open Settings → API keys." }),
      instanceId: "openaiCompat",
      driverKind: "openai-compat",
      displayName: "Other (OpenAI-compatible)",
      install: { docsUrl: "https://openrouter.ai/keys", settings: "connections" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Other (OpenAI-compatible) needs an API key");
    expect(markup).toContain("Open AI › Other services");
    expect(markup).not.toContain("Open install in Terminal");
    expect(markup).not.toContain("config.json");
  });

  it("still offers the install when a key engine's own CLI is missing, and the key once it is installed", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    const dsh = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
      ...instance(snapshot),
      instanceId: "deepseek",
      driverKind: "deepseekAgent",
      displayName: "DeepSeek Harness",
      install: {
        command: { linux: "npm install -g @deepseek-ai/dsh", darwin: "npm install -g @deepseek-ai/dsh", win32: "npm install -g @deepseek-ai/dsh" },
        docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
        needsNode: true,
        settings: "connections",
      },
    });
    const missing = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: dsh({ state: "unavailable", reason: "dsh not found" }) })));
    expect(missing).toContain("npm install -g @deepseek-ai/dsh");
    expect(missing).not.toContain("needs an API key");
    const keyless = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: dsh({ state: "available", authenticated: false, version: "0.2.1" }) })));
    expect(keyless).toContain("DeepSeek Harness needs an API key");
    expect(keyless).toContain('data-key-row="deepseek"');
    expect(keyless).not.toContain("Terminal");
    // No key is saved, so nothing was rejected.
    expect(keyless).not.toContain("rejected the saved key");
  });
});

describe("install from Settings on the server", () => {
  function npmEngine(snapshot: InstanceInfo["snapshot"], server = true): InstanceInfo {
    return {
      ...instance(snapshot),
      install: {
        command: { linux: "npm install -g kimi-fixture", darwin: "npm install -g kimi-fixture", win32: "npm install -g kimi-fixture" },
        needsNode: true,
        signInCommand: "kimi login",
        ...(server ? { server: { package: "kimi-fixture" } } : {}),
      },
    };
  }
  function render(engine: InstanceInfo): string {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  }

  it("offers one click on the server and keeps the terminal command behind a disclosure", () => {
    const markup = render(npmEngine({ state: "unavailable", reason: "`kimi` CLI not found" }));
    expect(markup).toContain("Install Kimi here");
    expect(markup).toContain("as its own user");
    expect(markup).toContain("Prefer a terminal?");
    expect(markup).toContain("npm install -g kimi-fixture");
    expect(markup).not.toContain("needs");
  });

  it("keeps a quiet setup's probe reason behind Details, in plain grey, never as an alert", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const reason = "`kimi` isn't installed, or isn't on this app's PATH.";
    const engine = npmEngine({ state: "unavailable", reason });
    const quiet = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine, quiet: true })));
    expect(quiet).toMatch(/<details data-engine-setup-reason="true" class="[^"]*text-ink-tertiary"><summary[^>]*>Details<\/summary><p[^>]*>`kimi` isn&#x27;t installed/);
    expect(quiet).not.toContain('role="alert"');
    expect(quiet).not.toContain("text-danger");
    expect(quiet).toContain("Install Kimi here");
    expect(render(engine)).toMatch(/role="alert" class="[^"]*text-danger">`kimi` isn&#x27;t installed/);
  });

  it("falls back to the terminal command when the server cannot install", () => {
    const markup = render(npmEngine({ state: "unavailable", reason: "`kimi` CLI not found" }, false));
    expect(markup).not.toContain("Install Kimi here");
    expect(markup).toContain("npm install -g kimi-fixture");
  });

  it("offers the vendor's own build on a machine without Node.js, and drops the Node.js line", () => {
    const opencode = (server?: NonNullable<InstanceInfo["install"]>["server"]): InstanceInfo => ({
      ...instance({ state: "unavailable", reason: "`opencode` CLI not found" }),
      instanceId: "opencode",
      driverKind: "opencodeGo",
      displayName: "OpenCode",
      install: {
        command: { linux: "npm install -g opencode-ai", darwin: "npm install -g opencode-ai", win32: "npm install -g opencode-ai" },
        needsNode: true,
        ...(server ? { server } : {}),
      },
    });
    const standalone = render(opencode({ standalone: { version: "1.19.4", downloadBytes: 79_667_571 } }));
    expect(standalone).toContain("Install OpenCode here");
    expect(standalone).not.toContain("Requires Node.js");
    // No npm on the server, so no npm command to paste into a terminal.
    expect(standalone).not.toContain("npm install -g opencode-ai");
    // Decimal megabytes, as macOS and Windows show file sizes: 79,667,571 bytes is about 80 MB.
    expect(standalone).toContain("About 80 MB download");
    expect(render(opencode({ standalone: { version: "1.19.4", downloadBytes: 64_291_659 } }))).toContain("About 64 MB download");
    const withNpm = render(opencode({ standalone: { version: "1.19.4", downloadBytes: 79_667_571 }, package: "opencode-ai" }));
    expect(withNpm).toContain("Prefer a terminal?");
    expect(withNpm).toContain("npm install -g opencode-ai");
    const neither = render(opencode());
    expect(neither).not.toContain("Install OpenCode here");
    expect(neither).toContain("Requires Node.js");
  });

  it("finishes the app's own signed-out copy in the app, never in a terminal", () => {
    const appCopy = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
      ...instance(snapshot),
      instanceId: "opencodeGo",
      driverKind: "opencodeGo",
      displayName: "OpenCode",
      install: {
        command: { linux: "npm install -g opencode-ai", darwin: "npm install -g opencode-ai", win32: "npm install -g opencode-ai" },
        needsNode: true,
        docsUrl: "https://opencode.ai/docs/",
        server: { standalone: { version: "1.19.4", downloadBytes: 64_291_659 } },
        appCopy: true,
      },
    });
    const markup = render(appCopy({ state: "available", authenticated: false, version: "1.19.4" }));
    expect(markup).toContain("OpenCode is installed");
    expect(markup).toContain("free models");
    expect(markup).toContain("Open AI › Other services");
    expect(markup).toContain("Check again");
    for (const line of ["Terminal", "terminal", "one-line installer", "npm install", "Install and sign in on the computer", "Sign in to OpenCode"]) {
      expect(markup).not.toContain(line);
    }
    // A remote client's Settings has no keys, so it names the computer instead of offering the button.
    vi.stubGlobal("window", { ogb: { platform: "linux", remoteClient: { active: true } } });
    const remote = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: appCopy({ state: "available", authenticated: false, version: "1.19.4" }) })));
    expect(remote).toContain("on the computer running MausBot");
    expect(remote).not.toContain("Open AI › Other services");
    // Missing or broken, the app's copy is installed again from here.
    expect(render(appCopy({ state: "unavailable", reason: "`opencode` version check failed." }))).toContain("Install OpenCode here");
  });

  it("never offers an install when only sign-in is missing", () => {
    const markup = render(npmEngine({ state: "available", authenticated: false, version: "1.0.0" }));
    expect(markup).not.toContain("Install Kimi here");
    expect(markup).toContain("kimi login");
  });

  it("turns the update notice into a button when the server can update", () => {
    const update = { title: "Kimi update available", message: "Newer models need it.", command: "npm install -g kimi-fixture@latest" };
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const withServer = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineUpdateNotice, { update, instance: npmEngine({ state: "available", authenticated: true }) })));
    expect(withServer).toContain("Update Kimi here");
    expect(withServer).toContain("Prefer a terminal?");
    const without = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineUpdateNotice, { update, instance: npmEngine({ state: "available", authenticated: true }, false) })));
    expect(without).not.toContain("Update Kimi here");
    expect(without).toContain("npm install -g kimi-fixture@latest");
  });
});

describe("server device-code sign-in", () => {
  it("offers the distinct ChatGPT plan connection without the legacy Codex command", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "available", authenticated: false, chatgptPlan: true }),
      instanceId: "chatgpt", displayName: "ChatGPT plan", driverKind: "codex",
      authentication: { method: "browser-pkce" }, install: { signInCommand: "codex login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Continue with ChatGPT");
    expect(markup).toContain("separate from MausBot Cloud and from paying with an API key");
    expect(markup).not.toContain("codex login");
    expect(markup).not.toContain("Device-code login");
  });

  it("explains unavailable hosted plan auth without offering a broken login or install", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "unavailable", authenticated: false, chatgptPlan: true, authenticationUnavailableReason: "Hosted ChatGPT plan access requires approval." }),
      instanceId: "chatgpt", displayName: "ChatGPT plan", driverKind: "codex",
      authentication: { method: "browser-pkce" }, install: { command: { linux: "npm install -g @openai/codex" }, signInCommand: "codex login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Hosted ChatGPT plan access requires approval.");
    expect(markup).not.toContain("Continue with ChatGPT");
    expect(markup).not.toContain("npm install");
    expect(markup).not.toContain("codex login");
  });

  it("uses the supported browser sign-in flow instead of asking a remote user to run a command", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "available", authenticated: false }),
      instanceId: "codex",
      driverKind: "codexAgent",
      displayName: "Codex",
      authentication: { method: "device-code" },
      install: { signInCommand: "codex login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Connect ChatGPT");
    expect(markup).toContain("no terminal or password sharing");
    expect(markup).not.toContain("codex login");
  });

  it("does not ask to sign in when installing a CLI for local-model injection", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "available", authenticated: false }),
      authentication: { method: "device-code" },
      install: { command: { linux: "npm install -g @openai/codex" }, signInCommand: "codex login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine, intent: "inject" })));
    expect(markup).not.toContain("Connect ChatGPT");
    expect(markup).toContain("npm install");
  });
});

describe("API-key engine setup", () => {
  function keyEngine(driverKind: string, snapshot: InstanceInfo["snapshot"]): InstanceInfo {
    return { ...instance(snapshot), instanceId: driverKind, driverKind, displayName: "Grok (API)", access: "api", install: { docsUrl: "https://console.x.ai" } };
  }
  const render = (engine: InstanceInfo, ogb: Record<string, unknown> = { platform: "darwin" }) => {
    vi.stubGlobal("window", { ogb });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  };

  it("takes a missing key in place, in the same key row as Settings, not in a config file", () => {
    const html = render(keyEngine("grok", { state: "unavailable", reason: "No xAI API key — open Settings → API keys." }));
    expect(html).toContain("data-engine-setup-api-key");
    expect(html).toContain("Grok (API) needs an API key");
    expect(html).toContain("Paste it here. It saves and checks itself");
    expect(html).toContain('data-key-row="xai"');
    expect(html).not.toContain("Open AI › Other services");
    expect(html).not.toContain("config.json");
  });

  it("says so in the key row when the provider rejected the saved key", () => {
    const html = render(keyEngine("grok", { state: "available", authenticated: false, reason: "The provider rejected this key." }));
    expect(html).toContain("data-engine-setup-api-key");
    expect(html).toContain("Didn&#x27;t work: The provider rejected this key.");
    expect(render(keyEngine("grok", { state: "unavailable" }))).not.toContain("rejected");
  });

  it("still sends an engine with no key row of its own to Settings → API keys", () => {
    const html = render(keyEngine("openai-compat", { state: "unavailable" }));
    expect(html).toContain("Open AI › Other services");
    expect(html).not.toContain("data-key-row");
  });

  it("has no button on a remote client, whose settings hide the keys", () => {
    const html = render(keyEngine("openai-compat", { state: "unavailable" }), { platform: "darwin", remoteClient: { active: true } });
    expect(html).toContain("on the computer running MausBot");
    expect(html).not.toContain("Open AI › Other services");
  });

  it("leaves CLI engines on their install card", () => {
    expect(render(instance({ state: "unavailable", reason: "`kimi` CLI not found" }))).not.toContain("data-engine-setup-api-key");
  });
});

describe("web chat engine (harkWeb)", () => {
  it("identifies web chat engines correctly", () => {
    expect(isWebChatEngine({ driverKind: "harkWeb" } as InstanceInfo)).toBe(true);
    expect(isWebChatEngine({ driverKind: "kimiAgent" } as InstanceInfo)).toBe(false);
    expect(isWebChatEngine(undefined)).toBe(false);
  });

  it("names Hark provider in the engine library", () => {
    expect(providerName({ driverKind: "harkWeb" } as InstanceInfo)).toBe("Hark");
  });

  it("renders web chat setup card with login prompt, copy buttons and viewer button for unauthenticated harkWeb", () => {
    const harkEngine: InstanceInfo = {
      instanceId: "harkWeb",
      driverKind: "harkWeb",
      displayName: "Hark",
      models: { default: "hark-web", options: [] },
      snapshot: {
        state: "unavailable",
        authenticated: false,
        reason: "Login to Hark in the browser (https://hark.com)",
      },
    };
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: harkEngine })));
    expect(html).toContain('data-web-chat-setup="harkWeb"');
    expect(html).toContain("Login to Hark in the browser");
    expect(html).toContain("Open browser viewer");
    expect(html).toContain("Install Userscript");
    expect(html).toContain("Copy connection URL");
    expect(html).toContain("Copy token");
    expect(html).toContain("chrome --remote-debugging-port=9222");
  });

  it("disables copy buttons when connection details are not loaded", () => {
    const harkEngine: InstanceInfo = {
      instanceId: "harkWeb",
      driverKind: "harkWeb",
      displayName: "Hark",
      models: { default: "hark-web", options: [] },
      snapshot: {
        state: "unavailable",
        authenticated: false,
      },
    };
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: harkEngine })));
    expect(html).toContain("disabled");
  });

  it("draws appropriate marks for web chat engines", () => {
    const harkMark = renderToStaticMarkup(createElement(HarkMark, { size: 16 }));
    expect(harkMark).toContain("<svg");
    expect(renderToStaticMarkup(createElement(ProviderMark, { driverKind: "harkWeb", size: 16 }))).toBe(harkMark);
  });
});

describe("web chat connection fetch", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let host: HTMLDivElement;
  let root: Root;

  const harkEngine: InstanceInfo = {
    instanceId: "harkWeb",
    driverKind: "harkWeb",
    displayName: "Hark",
    models: { default: "hark-web", options: [] },
    snapshot: { state: "unavailable", authenticated: false },
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** `/api/auth/session` answers with a live session so a refused request's recheck stays quiet. */
  async function mountConnection(answer: (path: string) => Response): Promise<void> {
    const store = {
      state: initialState,
      dispatch: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof useStore>;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => answer(path)));
    act(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: harkEngine }) })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const copyButton = (name: string) =>
    Array.from(host.querySelectorAll("button")).find((node) => node.textContent?.includes(name))!;

  it("shows the token UI once the connection answers 200", async () => {
    await mountConnection((path) =>
      path === "/api/web-chat/connection"
        ? new Response(JSON.stringify({ wsUrl: "ws://fixture:9222/devtools/browser", token: "fixture-token" }))
        : new Response(JSON.stringify({ kind: "session", id: "fixture" })));
    expect(copyButton("Copy token").disabled).toBe(false);
    expect(copyButton("Copy connection URL").disabled).toBe(false);
    expect(copyButton("Copy token").title).toBe("");
    expect(host.textContent).not.toContain("Admin access is required");
    expect(host.textContent).not.toContain("Connection details unavailable");
  });

  it("asks for the connection with a POST, so a plain-HTTP page can prove it is the app's own", async () => {
    await mountConnection((path) =>
      path === "/api/web-chat/connection"
        ? new Response(JSON.stringify({ wsUrl: "ws://fixture/api/web-chat/ws", token: "fixture-token" }))
        : new Response(JSON.stringify({ kind: "session", id: "fixture" })));
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit | undefined][] } }).mock.calls
      .filter(([path]) => path === "/api/web-chat/connection");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([, init]) => String(init?.method ?? "GET").toUpperCase() === "POST")).toBe(true);
  });

  it("says the connection token needs an admin when the answer is 403", async () => {
    await mountConnection((path) =>
      path === "/api/web-chat/connection"
        ? new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
        : new Response(JSON.stringify({ kind: "session", id: "fixture" })));
    expect(host.textContent).toContain("Admin access is required to fetch the connection token.");
    expect(copyButton("Copy token").disabled).toBe(true);
    expect(copyButton("Copy token").title).toContain("Admin access is required");
  });

  it("keeps the plain failure copy for other refusals such as a 500", async () => {
    await mountConnection((path) =>
      path === "/api/web-chat/connection"
        ? new Response(JSON.stringify({ error: "boom" }), { status: 500 })
        : new Response(JSON.stringify({ kind: "session", id: "fixture" })));
    expect(host.textContent).not.toContain("Admin access is required");
    expect(copyButton("Copy token").disabled).toBe(true);
    expect(copyButton("Copy token").title).toBe("Connection details unavailable");
  });
});

describe("Ollama setup", () => {
  it("says why Ollama can't answer instead of asking for an API key", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    const reason = "Ollama isn't running at http://127.0.0.1:11434. Open the Ollama app or run `ollama serve`.";
    const ollama: InstanceInfo = {
      instanceId: "openaiCompat", driverKind: "openai-compat", displayName: "Ollama", access: "api", serverKind: "ollama",
      models: { default: "", options: [] }, snapshot: { state: "unavailable", reason },
      install: { docsUrl: "https://openrouter.ai/keys", settings: "connections", signInCommand: "Save an OpenAI-compatible API key." },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: ollama })));
    expect(markup).toContain("Ollama isn&#x27;t running at http://127.0.0.1:11434");
    expect(markup).not.toContain("API key");
  });

  it("says it in the app's own words when the engine names the problem, with the command to run", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    const ollama: InstanceInfo = {
      instanceId: "openaiCompat", driverKind: "openai-compat", displayName: "Ollama", access: "api", serverKind: "ollama",
      models: { default: "", options: [] },
      snapshot: { state: "unavailable", reason: "Ollama has no models yet.", ollama: { state: "no-models", url: "http://127.0.0.1:11434" } },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: ollama })));
    expect(markup).toContain('data-ollama-state="no-models"');
    expect(markup).toContain("ollama pull llama3.2");
    expect(markup).toContain("Check again");
    expect(markup).not.toContain("Ollama has no models yet.");
  });
});
