// Only the Jev backend's requests may ride the configured proxy: a global dispatcher or HTTPS_PROXY would take the
// whole process through it. The address can carry credentials, so it is never written to a log or echoed back.
import type { Dispatcher } from "undici";

const AGENTS_MAX = 8;
type Proxied = { dispatcher: Dispatcher; fetch: typeof fetch };
const agents = new Map<string, Promise<Proxied | undefined>>();

/** Where Jev's requests proxy through: the saved `proxyUrl` first, then `JEV_PROXY`; empty is direct. */
export function jevProxyUrl(configured?: string): string | undefined {
  return configured?.trim() || process.env.JEV_PROXY?.trim() || undefined;
}

export function maskProxyUrl(raw?: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.replace(
    /^(https?|socks[45]?h?):\/\/([^@\s/]+)@/i,
    (_match, scheme: string, userinfo: string) => {
      const maskedAuth = userinfo.includes(":") ? "******:******" : "******";
      return `${scheme}://${maskedAuth}@`;
    },
  );
}

export function isMaskedProxyUrl(value?: string): boolean {
  if (!value) return false;
  return /[*•]{3,}/.test(value);
}

function agentFor(address: string): Promise<Proxied | undefined> {
  let agent = agents.get(address);
  if (!agent) {
    if (agents.size >= AGENTS_MAX) {
      const oldest = agents.keys().next().value;
      if (oldest !== undefined) {
        agents.get(oldest)!.then((built) => { void built?.dispatcher.close().catch(() => undefined); });
        agents.delete(oldest);
      }
    }
    // The npm undici's dispatcher must go through the same package's fetch: Node's bundled fetch is an older undici
    // and rejects it (UND_ERR_INVALID_ARG, seen on Node 24 / undici 8 on 2026-11-07).
    agent = import("undici")
      .then(({ ProxyAgent, fetch: undiciFetch }) => ({ dispatcher: new ProxyAgent(address), fetch: undiciFetch as unknown as typeof fetch }))
      .catch(() => undefined);
    agents.set(address, agent);
  }
  return agent;
}

/** The fetch the Jev backend gets: the given one with the proxy's dispatcher added, unchanged when no proxy is set or
 * one cannot be built. The dispatcher rides the init — Node's fetch is undici's and reads it — and every other
 * option, `redirect: "error"` included, passes through. */
export function withJevProxy(base: typeof fetch, proxyUrl?: string): typeof fetch {
  if (!proxyUrl?.trim()) return base;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const proxied = await agentFor(proxyUrl);
    if (!proxied) return base(input, init);
    return proxied.fetch(input, { ...init, dispatcher: proxied.dispatcher } as Parameters<typeof fetch>[1]);
  }) as typeof fetch;
}
