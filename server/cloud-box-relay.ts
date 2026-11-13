// T6 (PLAN-C2 stage 3): a Simular box as a cloud browser. A box is reached only through its MCP server: no SSH in, no
// public port, and its own traffic leaves through the box's local proxies (HTTP and SOCKS5 on its loopback). So the
// box gets its Chrome the same way an SSH machine does, plus a reverse relay: over MCP the box starts a headless
// Chrome on its loopback and an ssh session (through its SOCKS5 proxy) to one of the person's SSH machines (the relay
// host). That ssh session's stdin/stdout carries every connection the relay host gets on its loopback relay port to
// the box's Chrome, because the SSH gateways in use refuse -R. This host then tunnels to the relay port with -L like
// any SSH machine, and the box's Chrome takes the same CDP proxy door as the others (scoped sessions, file serving,
// sign-in refusal, page cap). The relay host's address and user are read from this host's ssh config at runtime and
// written to the box; nothing about them lives in code.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/** The stdio-multiplexed reverse forward: `box <port> -- <ssh…>` on the box, `cloud <port>` on the relay host. */
export const RELAY_SCRIPT = String.raw`// cdp-relay.mjs (OpenMausBot): reverse port forward over one ssh session's stdin/stdout.
import net from "node:net";
import { spawn } from "node:child_process";
const OPEN = 1, DATA = 4, CLOSE = 5, MAX = 65536;
const frame = (t, id, p = Buffer.alloc(0)) => { const h = Buffer.alloc(9); h.writeUInt8(t, 0); h.writeUInt32BE(id >>> 0, 1); h.writeUInt32BE(p.length, 5); return Buffer.concat([h, p]); };
const parser = (on) => { let b = Buffer.alloc(0); return (c) => { b = b.length ? Buffer.concat([b, c]) : c; while (b.length >= 9) { const n = b.readUInt32BE(5); if (b.length < 9 + n) break; on(b.readUInt8(0), b.readUInt32BE(1), b.subarray(9, 9 + n)); b = b.subarray(9 + n); } }; };
const pump = (s, id, w, done) => { s.on("data", (d) => { for (let i = 0; i < d.length; i += MAX) w(frame(DATA, id, d.subarray(i, i + MAX))); }); s.on("close", () => { done(); w(frame(CLOSE, id)); }); s.on("error", () => {}); };
const [mode, port, sep, ...cmd] = process.argv.slice(2);
if (mode === "cloud") {
  const socks = new Map(); let next = 1; const w = (b) => process.stdout.write(b);
  process.stdin.on("data", parser((t, id, p) => { const s = socks.get(id); if (!s) return; if (t === DATA) s.write(p); else if (t === CLOSE) { socks.delete(id); s.destroy(); } }));
  process.stdin.on("end", () => process.exit(0));
  const server = net.createServer((s) => { const id = next++; socks.set(id, s); w(frame(OPEN, id)); pump(s, id, w, () => socks.delete(id)); });
  server.on("error", () => process.exit(3));
  server.listen(Number(port), "127.0.0.1");
} else if (mode === "box" && sep === "--" && cmd.length) {
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
  const socks = new Map(); const w = (b) => child.stdin.write(b);
  // Idle exit (E80): with no relayed connection and no traffic for OMB_RELAY_IDLE_S seconds the session ends with 9,
  // so a box whose server went away does not hold the relay host's ssh open for ever.
  const idle = Number(process.env.OMB_RELAY_IDLE_S) || 0; let last = Date.now();
  if (idle > 0) setInterval(() => { if (socks.size === 0 && Date.now() - last > idle * 1000) { child.kill(); process.exit(9); } }, Math.min(30, idle) * 1000).unref();
  child.stdout.on("data", parser((t, id, p) => {
    last = Date.now();
    if (t === OPEN) { const s = net.connect(Number(port), "127.0.0.1"); socks.set(id, s); pump(s, id, w, () => { socks.delete(id); last = Date.now(); }); }
    else if (t === DATA) socks.get(id)?.write(p);
    else if (t === CLOSE) { socks.get(id)?.destroy(); socks.delete(id); }
  }));
  child.on("exit", (code) => process.exit(code ?? 1));
}
`;

/** The relay host's side for a dedicated, locked-down relay account (cloudOffload.boxRelayUser): the same protocol as
 * RELAY_SCRIPT's cloud mode, in Perl, because a small relay host may have no node and too little memory for one. It
 * is root-owned on the relay host and run only as the forced command of each box's key. */
export const RELAY_PERL_SCRIPT = String.raw`#!/usr/bin/perl
# cdp-relay.pl (OpenMausBot): cloud side of cdp-relay.mjs: perl cdp-relay.pl cloud <port>
use strict; use warnings; use IO::Socket::INET; use IO::Select;
my ($mode, $port) = @ARGV; exit 2 unless defined $port && $mode eq 'cloud' && $port =~ /^\d+$/;
$SIG{PIPE} = 'IGNORE'; binmode STDIN; binmode STDOUT;
my $srv = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => $port, Listen => 16, ReuseAddr => 1) or exit 3;
my $sel = IO::Select->new($srv, \*STDIN); my (%sock, %idof); my $next = 1; my $buf = '';
sub put { my ($fh, $d) = @_; my $o = 0; while ($o < length $d) { my $n = syswrite($fh, $d, length($d) - $o, $o); return 0 unless defined $n; $o += $n; } 1 }
sub frame { my ($t, $id, $p) = @_; $p = '' unless defined $p; put(\*STDOUT, pack('CNN', $t, $id, length $p) . $p) or exit 0; }
sub drop { my ($id, $tell) = @_; my $s = delete $sock{$id} or return; delete $idof{"$s"}; $sel->remove($s); close $s; frame(5, $id) if $tell; }
while (1) {
  for my $fh ($sel->can_read) {
    if ($fh == $srv) { my $c = $srv->accept or next; my $id = $next++; $sock{$id} = $c; $idof{"$c"} = $id; $sel->add($c); frame(1, $id); }
    elsif (fileno($fh) == fileno(STDIN)) {
      my $n = sysread(STDIN, my $chunk, 262144); exit 0 unless $n; $buf .= $chunk;
      while (length $buf >= 9) {
        my ($t, $id, $len) = unpack('CNN', $buf); last if length $buf < 9 + $len;
        my $p = substr($buf, 9, $len); substr($buf, 0, 9 + $len, '');
        my $s = $sock{$id} or next;
        if ($t == 4) { put($s, $p) or drop($id, 1); } elsif ($t == 5) { drop($id, 0); }
      }
    } else { my $id = $idof{"$fh"}; next unless defined $id; my $n = sysread($fh, my $d, 65536); if ($n) { frame(4, $id, $d); } else { drop($id, 1); } }
  }
}
`;
/** Where the Perl relay lives on a relay host with a dedicated account, root-owned so that account cannot change it. */
export const RESTRICTED_RELAY_DIR = "/opt/omb-relay";
const perlHash = createHash("sha1").update(RELAY_PERL_SCRIPT).digest("hex").slice(0, 12);
/** How long a box keeps its relay with nothing relayed before ending it on its own; a little longer than this host's
 * idle teardown (cloud-offload RELAY_IDLE_MS), which normally comes first. */
export const BOX_RELAY_IDLE_S = 12 * 60;

/** ssh's ProxyCommand through the box's SOCKS5 proxy: the box has no direct route out. */
export const SOCKS_CONNECT_SCRIPT = String.raw`// socks-connect.mjs (OpenMausBot): node socks-connect.mjs <proxyPort> <host> <port>
import net from "node:net";
const [proxyPort, host, port] = process.argv.slice(2);
const s = net.connect(Number(proxyPort), "127.0.0.1", () => s.write(Buffer.from([5, 1, 0])));
let stage = 0, buf = Buffer.alloc(0);
s.on("data", function on(d) {
  buf = Buffer.concat([buf, d]);
  if (stage === 0 && buf.length >= 2) {
    if (buf[1] !== 0) process.exit(2);
    buf = buf.subarray(2); stage = 1;
    const h = Buffer.from(host), p = Buffer.alloc(2); p.writeUInt16BE(Number(port));
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, p]));
  }
  if (stage === 1 && buf.length >= 10) {
    if (buf[1] !== 0) process.exit(3);
    const rest = buf.subarray(buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4]);
    stage = 2; s.off("data", on);
    if (rest.length) process.stdout.write(rest);
    s.pipe(process.stdout); process.stdin.pipe(s);
  }
});
s.on("close", () => process.exit(0)); s.on("error", () => process.exit(1));
`;

/** Where the relay files live on the box and on the relay host, under each one's home. */
export const RELAY_DIR = ".omb-relay";
export const scriptsHash = createHash("sha1").update(RELAY_SCRIPT + SOCKS_CONNECT_SCRIPT).digest("hex").slice(0, 12);

const shq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface BoxRelayTarget {
  /** The box's Chrome port on its loopback. */
  cdpPort: number;
  /** The relay host's loopback port that reaches the box's Chrome. */
  relayPort: number;
  /** The box's own proxies (Simular: HTTP 3128, SOCKS5 1080). */
  httpProxyPort: number;
  socksPort: number;
}

/** The ssh client config the box uses to reach the relay host; `host` names it only inside the box. */
export function boxSshConfig(relay: { hostname: string; user: string; port: number }, socksPort: number): string {
  return [
    "Host omb-relay",
    `  HostName ${relay.hostname}`,
    `  User ${relay.user}`,
    `  Port ${relay.port}`,
    `  IdentityFile ~/${RELAY_DIR}/id`,
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  StrictHostKeyChecking accept-new",
    `  UserKnownHostsFile ~/${RELAY_DIR}/known_hosts`,
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 3",
    "  LogLevel ERROR",
    `  ProxyCommand node ~/${RELAY_DIR}/socks-connect.mjs ${socksPort} %h %p`,
    "",
  ].join("\n");
}

/** The box-side script, run over MCP: files are (re)written when their hash changed, then Chrome and the relay are
 * kept up. Prints "OMB_OK <load1> <cores>" or "OMB_ERR <why>", like the SSH machines' script. */
export function boxUpScript(target: BoxRelayTarget, sshConfig: string): string {
  const d = `$HOME/${RELAY_DIR}`;
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  return [
    `D=${d}; mkdir -p "$D"; chmod 700 "$D"; P=${target.cdpPort}`,
    `if [ "$(cat "$D/.hash" 2>/dev/null)" != ${scriptsHash} ]; then echo ${b64(RELAY_SCRIPT)} | base64 -d > "$D/cdp-relay.mjs"; echo ${b64(SOCKS_CONNECT_SCRIPT)} | base64 -d > "$D/socks-connect.mjs"; echo ${scriptsHash} > "$D/.hash"; pkill -f "cdp-relay.mjs box $P" 2>/dev/null; fi`,
    `echo ${b64(sshConfig)} | base64 -d > "$D/ssh_config.new"; chmod 600 "$D/ssh_config.new"; cmp -s "$D/ssh_config.new" "$D/ssh_config" && rm -f "$D/ssh_config.new" || { mv "$D/ssh_config.new" "$D/ssh_config"; pkill -f "cdp-relay.mjs box $P" 2>/dev/null; }`,
    `[ -f "$D/id" ] || ssh-keygen -q -t ed25519 -N "" -C omb-relay -f "$D/id"`,
    `up() { curl -s -m 3 --noproxy '*' "http://127.0.0.1:$P/json/version" | grep -q webSocketDebuggerUrl; }`,
    `B=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)`,
    `if ! up; then [ -z "$B" ] && { echo "OMB_ERR 没有 Chrome"; exit 0; }; mkdir -p "$HOME/.omb-cloud-chrome"; setsid nohup "$B" --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=$P --user-data-dir="$HOME/.omb-cloud-chrome" --proxy-server=http://127.0.0.1:${target.httpProxyPort} --no-first-run --no-default-browser-check --disable-dev-shm-usage --lang=zh-CN about:blank >"$D/chrome.log" 2>&1 </dev/null & for i in $(seq 1 20); do sleep 0.5; up && break; done; fi`,
    `up || { echo "OMB_ERR Chrome 起不来"; exit 0; }`,
    // The loop is named by its $0 so a check between two of its ssh sessions still finds it; a relay host that keeps
    // refusing is retried less and less often (up to 2 min), since SSH gateways rate-limit and cool a machine down.
    // A session that ended idle (9, E80) ends the loop and the box's Chrome with it: the next pick starts both again.
    `if ! pgrep -f "omb-relay-loop-$P" >/dev/null; then D="$D" P="$P" R=${target.relayPort} OMB_RELAY_IDLE_S=${BOX_RELAY_IDLE_S} setsid nohup bash -c 'n=1; while true; do s=$(date +%s); node "$D/cdp-relay.mjs" box "$P" -- ssh -F "$D/ssh_config" omb-relay node ${RELAY_DIR}/cdp-relay.mjs cloud "$R"; [ $? -eq 9 ] && { pkill -f -- "--remote-debugging-port=$P" 2>/dev/null; exit 0; }; [ $(( $(date +%s) - s )) -gt 120 ] && n=1 || n=$(( n * 2 > 120 ? 120 : n * 2 )); sleep $n; done' "omb-relay-loop-$P" >"$D/relay.log" 2>&1 </dev/null & sleep 2; fi`,
    `pgrep -f "omb-relay-loop-$P" >/dev/null || { echo "OMB_ERR 中继起不来"; exit 0; }`,
    // The box's own relay key, public half only: a relay host with a dedicated account authorizes it for this box.
    `echo "OMB_PUB $(cut -d' ' -f1,2 "$D/id.pub")"`,
    `echo "OMB_OK $(cut -d' ' -f1 /proc/loadavg) $(nproc 2>/dev/null || echo 1)"`,
  ].join("\n");
}

/** A box's relay public key as its up script prints it ("OMB_PUB ssh-ed25519 <base64>"), or null. */
export function parseBoxPub(out: string): string | null {
  return /^OMB_PUB (ssh-ed25519 [A-Za-z0-9+/]+={0,2})\s*$/m.exec(out)?.[1] ?? null;
}

export interface RestrictedRelay {
  /** The dedicated account on the relay host the boxes log in as. */
  user: string;
  /** This box's port on the relay host's loopback, pinned by its key's forced command. */
  relayPort: number;
  /** The box's relay public key, from parseBoxPub. */
  pub: string;
  /** Names this box's line in the account's authorized_keys (the machine id). */
  tag: string;
}

/** The relay host's side, run over this host's own login there. Without `restricted`: its copy of the relay script
 * (the box's ssh session runs it), refreshed when it changed. With it (the login must be root): the root-owned Perl
 * relay, and the box's key authorized for the dedicated account with `restrict` and a forced command that can only
 * run the relay on this box's port; the account's authorized_keys is root-owned so the account cannot add to it. */
export function relayHostScript(restricted?: RestrictedRelay): string {
  if (!restricted) {
    const b64 = Buffer.from(RELAY_SCRIPT).toString("base64");
    return `D=$HOME/${RELAY_DIR}; mkdir -p "$D"; [ "$(cat "$D/.hash" 2>/dev/null)" = ${scriptsHash} ] || { echo ${b64} | base64 -d > "$D/cdp-relay.mjs"; echo ${scriptsHash} > "$D/.hash"; }; echo OMB_RELAY_OK`;
  }
  const { user, relayPort, pub, tag } = restricted;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("not a relay account name");
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(pub)) throw new Error("not an ed25519 public key");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(tag)) throw new Error("not a relay tag");
  if (!Number.isInteger(relayPort) || relayPort < 1024 || relayPort > 65535) throw new Error("not a relay port");
  const b64 = Buffer.from(RELAY_PERL_SCRIPT).toString("base64");
  const d = RESTRICTED_RELAY_DIR;
  return [
    `U=${user}; R=${relayPort}; T=omb-relay-${tag}; D=${d}`,
    `[ "$(id -u)" = 0 ] || { echo "OMB_RELAY_ERR 中继登录不是 root"; exit 0; }`,
    `H=$(getent passwd "$U" | cut -d: -f6); [ -n "$H" ] && [ -d "$H" ] || { echo "OMB_RELAY_ERR 没有中继账号"; exit 0; }`,
    `PL=$(command -v perl) || { echo "OMB_RELAY_ERR 没有 perl"; exit 0; }`,
    `install -d -o root -g root -m 755 "$D"; [ "$(cat "$D/.hash" 2>/dev/null)" = ${perlHash} ] || { echo ${b64} | base64 -d > "$D/cdp-relay.pl.new" && chmod 644 "$D/cdp-relay.pl.new" && mv "$D/cdp-relay.pl.new" "$D/cdp-relay.pl" && echo ${perlHash} > "$D/.hash"; }`,
    `install -d -o root -g root -m 755 "$H/.ssh"; K="$H/.ssh/authorized_keys"; [ -f "$K" ] || install -o root -g root -m 644 /dev/null "$K"`,
    `L="restrict,command=\\"$PL $D/cdp-relay.pl cloud $R\\" ${pub} $T"`,
    `if ! grep -qxF "$L" "$K"; then { grep -v " $T\\$" "$K"; printf '%s\\n' "$L"; } > "$K.new"; chown root:root "$K.new"; chmod 644 "$K.new"; mv "$K.new" "$K"; echo OMB_RELAY_NEW; fi`,
    `echo OMB_RELAY_OK`,
  ].join("\n");
}

/** Stops a box's relay and Chrome (idle teardown, E80). Patterns name the port through $P so the shell running this
 * never matches them itself. Prints "OMB_DOWN <left>": how many of those processes are still there. */
export function boxDownScript(cdpPort: number): string {
  return [
    `P=${cdpPort}; D=$HOME/${RELAY_DIR}`,
    `pkill -f "omb-relay-loop-$P" 2>/dev/null; pkill -f "cdp-relay.mjs box $P" 2>/dev/null; pkill -f "ssh -F $D/ssh_config omb-relay" 2>/dev/null; pkill -f -- "--remote-debugging-port=$P" 2>/dev/null`,
    `for i in 1 2 3 4 5 6; do pgrep -f "omb-relay-loop-$P|cdp-relay.mjs box $P|ssh -F $D/ssh_config omb-relay|--remote-debugging-port=$P" >/dev/null || break; sleep 0.5; done`,
    `pgrep -f "omb-relay-loop-$P|cdp-relay.mjs box $P|ssh -F $D/ssh_config omb-relay|--remote-debugging-port=$P" >/dev/null && pkill -9 -f "omb-relay-loop-$P|cdp-relay.mjs box $P|ssh -F $D/ssh_config omb-relay|--remote-debugging-port=$P" 2>/dev/null`,
    `echo "OMB_DOWN $(pgrep -fc "omb-relay-loop-$P|cdp-relay.mjs box $P|ssh -F $D/ssh_config omb-relay|--remote-debugging-port=$P")"`,
  ].join("\n");
}

/** Ends whatever relay process is left on the relay host for a box's port (its ssh session normally takes it along). */
export function relayHostDownScript(relayPort: number): string {
  if (!Number.isInteger(relayPort) || relayPort < 1024 || relayPort > 65535) throw new Error("not a relay port");
  return `R=${relayPort}; pkill -f "cdp-relay\\.(pl|mjs) cloud $R( |$)" 2>/dev/null; sleep 0.5; echo "OMB_RELAY_DOWN $(pgrep -fc "cdp-relay\\.(pl|mjs) cloud $R( |$)")"`;
}

/** The relay host's address as this host's ssh config resolves its alias (`ssh -G`), never printed. */
export function parseSshG(out: string): { hostname: string; user: string; port: number } | null {
  const field = (name: string) => new RegExp(`^${name} (\\S+)$`, "m").exec(out)?.[1];
  const hostname = field("hostname"), user = field("user"), port = Number(field("port") ?? 22);
  if (!hostname || !user || !/^[A-Za-z0-9_.@-]+$/.test(user) || !/^[A-Za-z0-9_.:-]+$/.test(hostname) || !(port > 0)) return null;
  return { hostname, user, port };
}

export function sshResolve(alias: string): Promise<{ hostname: string; user: string; port: number } | null> {
  return new Promise((done) => {
    const child = spawn("ssh", ["-G", alias], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("error", () => done(null));
    child.on("close", () => done(parseSshG(out)));
  });
}

export { shq };
