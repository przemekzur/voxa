# Voxa v2 — Connector Harness

A thin layer that lets you bolt **service integrations** ("connectors") onto the
Voxa realtime cockpit without touching the the brain brain.

## What it does

- Discovers connector plugins in `connectors/<id>/index.mjs`.
- Exposes a **management UI** (`/`) to enable, configure, and test them.
- Serves the **same voice-tool contract** the cockpit already speaks
  (`GET /api/voice/tools`, `POST /api/voice/tools/call`), **merging**:
  - the brain's tools (proxied from `BRAIN_URL`, default `http://localhost:3000`), and
  - every enabled connector's actions.

So the cockpit talks to **one** bridge URL and gets brain + connectors together.

```
 cockpit ──bridgeUrl──▶ connector-harness :3010 ──┬─▶ brain :3000  (proxied tools)
                                                  └─▶ connectors/  (local actions)
```

## Run

```bash
node experiments/connector-harness/server.mjs
# PORT=3010 BRAIN_URL=http://localhost:3000 by default
```

Then in the **cockpit Settings**, set the **Tool bridge URL** to
`http://localhost:3010`. Reconnect — you now have the full brain plus your
enabled connectors.

## Add a connector

See **BUILDING-A-CONNECTOR.md**. Shortest path: copy `connectors/example-echo/`
to `connectors/<your-id>/`, edit the manifest, hit **Reload** in the UI.

## Connectors included

| id             | what                                                            |
|----------------|----------------------------------------------------------------|
| `example-echo` | Reference connector (echo + time). Copy to start a new one.    |
| `grenton`      | Grenton home automation — switch lights via a CLU HTTP listener. See `connectors/grenton/`. |

## Security notes (spike-grade)

- Config/secrets are stored server-side in `data/connectors.json` (gitignored)
  and **masked** before going to the browser.
- No auth on the API yet — localhost only. Hardening (auth + per-tool confirm)
  is a follow-up before this becomes the primary interface.
