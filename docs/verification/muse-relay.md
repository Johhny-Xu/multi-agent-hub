# Muse relay

Two parts: the part that runs here against a fake management API, and the
part that only the person can do with a real account and a real public
entrance. Nothing in this recipe signs in to Meta, deploys a hook, opens a
port or touches a live app.

## What runs here

The connection card is driven against a fake API in the renderer's DOM:

```sh
RTEST_SRC="$PWD" rtest vitest run \
  src/components/MuseRelayCard.dom.test.ts \
  src/components/EnginesSettings.muse-relay.dom.test.ts
```

The fake answers the four management routes the card uses, with the shapes the
relay agrees on:

- `GET /api/instances/<id>/muse-relay` → `{ config: { connections, pendingTurns, canManage } }`
- `POST /api/instances/<id>/muse-relay/connections` → `{ config, credentials: { connectionId, token, basePath } }`
- `POST /api/instances/<id>/muse-relay/connections/<connectionId>/rotate` → the same
- `DELETE /api/instances/<id>/muse-relay/connections/<connectionId>` → `{ config }`

### Checks

1. The card lists every connection with its id, its online state and when it
   was last seen, and shows how many turns are waiting (one turn in the
   singular).
2. With no connection, the card offers **Create connection** and the request
   goes to the route above with the instance's id.
3. The token, the connection id and the hook path can each be copied.
4. The token is shown once: closing the panel removes it from the page, and a
   second load does not bring it back. It never reaches `localStorage`,
   `sessionStorage`, a cookie or the address bar.
5. **Rotate token** posts to the connection's `rotate` route and shows the new
   token; the connection id stays the same.
6. **Revoke** asks first. The confirmation focuses Cancel, so a stray Enter
   cannot revoke; only the confirm button sends the `DELETE`.
7. With `canManage` false the card is read-only: no create, rotate or revoke,
   and it says why.
8. A refused read shows a safe sentence. The server's own words, which can
   quote what it refused, never reach the window.
9. A long connection id stays inside its row (the row wraps, the id truncates
   and keeps the full text as its title).
10. Every action is a real button with a name a screen reader reads, so the
    card works from the keyboard and on a touch screen.

The Settings page itself is checked too: the card is mounted on an instance
whose driver is `museRelay`, the provider is named Meta, other AIs get no such
card, and a relay with no program of its own is still listed.

## What only the person can do

These steps need a real Meta account, a real public entrance and a real
deployment. The agent stops before them and reports them instead.

1. **Sign in to Muse** in the environment the hook will run in, with the
   account the person wants to answer.
2. **Confirm the entrance answers.** Check the existing HTTPS address from
   outside the network. A tunnel process running is not proof that it
   answers. The app's own entrance is not reused, widened or replaced for this.
3. **Create the connection** in Settings → Engines → Muse, and copy the token
   and the hook path while they are on screen.
4. **Deploy the hook** into that environment, with the token in the hook's own
   configuration, and point it at the confirmed address and the hook path.
   Nothing about the token goes into a log, a chat message or a repository.
5. **Start the hook** and watch the connection turn *Online* in the card.
6. **Send a message** from a bot that uses the Muse engine, and check that the
   answer arrives in the same conversation.
7. **Rotate the token**, restart the hook with the new one, and check that the
   old token stops working.
8. **Revoke the connection**, and check that the hook is refused from then on.

## What this recipe does not prove

- No real Muse account, no Meta session, no real assistant and no real hook.
- No real public address: none is configured, opened or verified here.
- No screenshot of the real product: every check above runs in a test DOM.
- The hook's own behaviour (its pending/processing/ledger files, its wake and
  log steps) belongs to the bridge the person runs, and is checked where that
  bridge lives, not here.
- The relay's data plane (polling, heartbeats, events and files) is checked
  where that code lives; this page covers the management card and the docs.
