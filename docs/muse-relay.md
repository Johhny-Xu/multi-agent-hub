# Muse relay: Meta's personal assistant as an engine

OpenMausBot can use Meta's Muse personal assistant as an engine
(`driverKind: "museRelay"`). The assistant runs in an environment the person
has already authorized; it asks the app for work and sends the answers back.
The app never drives a browser, and Meta publishes no personal-assistant
message API, so there is no native conversation behind this and no
token-by-token stream.

This page describes the shape of the relay, what the first version does, and
what it deliberately does not claim.

## How a turn travels

```text
person → bot → durable outbox (MuseRelayHub)
              → webhook IngressDoor (existing)
              → the HTTPS entrance the person confirmed
              → Muse's omb-watch → pending/wake → worker
              → events and files → RuntimeEvent → the same thread
```

- The outbox is durable. A turn is written down before it is offered, so a
  restart of the app does not lose it.
- Every offer is a **lease**. A lease that runs out is offered again with a new
  delivery id; the old delivery id may not write anything afterwards.
- The assistant's side keeps its own per-turn files: pending, processing, a
  ledger and locks. A turn is claimed with an atomic rename, never by writing
  into a file another worker may be reading.
- The answer comes back as events on the turn, and the app writes them into the
  thread the turn came from.

Each turn is self-contained: its thread id, the current text, the system
prompt and a transcript of the last exchanges. The relay does **not** create a
Meta thread and does not claim that the assistant's own history is the app's
history.

## What it is not

- Not a WeChat channel. The WeChat (iLink) bridge is a separate thing with its
  own inbox; this one is the assistant itself.
- Not the Meta Model API. `server/drivers/meta.ts` calls `api.meta.ai` with an
  API key and holds the conversation.
- Not a local `muse serve`. `server/drivers/muse-code.ts` spawns Meta's own CLI
  and speaks its session protocol over stdio.
- Not browser automation. Nothing here types into a page.

## How it differs from the other Meta drivers

| | `meta` (Model API) | `museCode` (CLI) | `museRelay` (this one) |
|---|---|---|---|
| Where the model runs | Meta's API | a `muse` child process | the assistant's own environment |
| Who holds the conversation | the app | the CLI's session | neither: every turn carries its own context |
| Credentials | an API key | `muse login` or `META_API_KEY` | a per-connection token, shown once |
| Sessions | yes | yes, resumable | none (`hasSession` is false) |
| Extra abilities | tools, effort levels | steer, tools, MCP, effort | none yet |

What the relay deliberately leaves out of the first version: steering a running
turn, MCP tools, approval cards, guest confinement, effort levels, image
input and resuming a conversation. `snapshot` only tells whether the
connection is online, from the last heartbeat.

## Setting it up

1. **Reach the app over HTTPS.** The assistant can only poll an address the
   outside world can reach. Use an entrance that already exists and that the
   person has confirmed answers; do not open a new port for this and do not
   change the app's own entrance.
2. **Create a connection.** Settings → Engines → Muse → **Create connection**.
   The card shows the connection id, the token and the hook path once. The
   token is never shown again: it is not stored in a list, not written to the
   app's data, not kept in the address bar.
3. **Give the hook what it needs.** In the authorized environment, install the
   assistant's hook and give it the token, the hook path and the public
   address of the app. The path is a path (`/hooks/muse-relay/v1/<connection>`),
   not an address: the app does not guess, print or derive a public URL.
4. **Start the hook.** The connection shows *Online* after its first
   heartbeat, and the app shows how many turns are waiting.
5. **Send a message.** Put a bot on the Muse engine, write to it, and the
   answer lands in the same conversation.

The card also manages the connections: **Rotate token** replaces the token of
one connection and stops the old one working at once, and **Revoke** removes a
connection so the hook is refused from then on.

## The first version's limits

- **Input is text only.** A turn carries the text, the system prompt and the
  transcript. No images and no files go into a turn.
- **Output may carry files.** The assistant can upload an image or an ordinary
  file back; it lands as an attachment on that turn, once, and never as a
  public link or inline data.
- **No native session.** Every turn stands on its own.
- **The assistant is a person, not a service.** The hook is private and
  unsupported: it can change or disappear without notice.

## At least once, and how it stays one message

The outbox hands a turn over **at least once**. A lease can expire while the
worker is busy, and the turn is then offered again with a fresh delivery id.
Two rules keep that from turning into two answers:

- Every event carries a delivery id, an event id and a sequence number that
  keeps rising across redeliveries.
- The same event id with the same content is a duplicate: the app accepts it
  quietly. The same event id with different content is refused.
- A bubble's deltas are previews; its final text arrives as its own event and
  has to match the deltas that came before it. The `completed` event comes
  last.

A worker that loses an answer retries with the same event id, so the thread
shows one answer. A worker that gets `409` on an old lease stops instead of
writing its result into the newer lease.

## Cancelling is best effort

**Stop** ends the turn in the app immediately. The app then tells the assistant
to stop, but that request travels the same public entrance as everything else
and can be lost, delayed or refused. The app does not wait for the assistant
to acknowledge it: a late answer to a cancelled turn is ignored.

## Not token by token

The relay streams *previews*, not tokens. A delta is a partial text that may
change, two deltas are not ordered against each other, and a bubble's final
text replaces the preview. The app renders one bubble per item and updates it.
Do not expect a character-by-character stream, a stable prefix, or the ability
to interrupt mid-word.

## The private hook is a risk

The assistant's hook is an unsupported entry point into someone's own
environment:

- It can change or vanish without notice, and nothing in the app can pin it.
- The token it holds is that person's credential in that environment. Keep it
  out of logs, chat messages, screenshots and repositories.
- The hook's files (pending, processing, ledger, locks) are that person's
  data; they are theirs to keep, not the app's to read.
- Only the files the person explicitly wants back are uploaded. Credentials
  and the assistant's own configuration never leave that environment.

## The public entrance

The relay reuses one entrance: the HTTPS address or tunnel the person has
already confirmed. A tunnel process running is **not** proof that the address
answers — check it from outside the network before pointing a hook at it. This
page does not name an address, and neither does the app.

## What the app never does with a token

- It never returns a token from a read. The list shows ids, state and times.
- It never writes a token to storage, a URL, a log or a snapshot.
- It never accepts a turn on another instance's connection: a connection
  belongs to the instance it was created on.
- It never reuses another engine's credential for a relay request.
