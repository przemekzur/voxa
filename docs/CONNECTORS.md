# Connectors

A **connector** gives Voxa new tools (voice-callable actions). It's a single ES
module — no build step, no dependencies beyond Node's stdlib + global `fetch`.
The harness auto-discovers any `packages/harness/connectors/<id>/index.mjs`.

There are three ways to add one.

## 1. Just ask Voxa (the forge)

Enable the **`forge`** connector and say:

> "Build me a connector for the OpenWeather API."

Forge writes a new connector from a declarative, data-only HTTP spec (it never
executes model-written code), guarded against SSRF. Great for any public REST
API. Tap the orb to reload and the new tools are live.

## 2. Write one by hand

A connector default-exports a manifest. Minimal example:

```js
// packages/harness/connectors/dice/index.mjs
export default {
  id: "dice",
  name: "Dice",
  description: "Roll dice.",
  icon: "🎲",
  config: [],                       // optional config/secret fields
  async test() { return { ok: true, message: "Ready." }; },
  actions: [
    {
      name: "dice_roll",            // GLOBALLY unique — prefix with the id
      description: "Roll an N-sided die and return the result.",
      parameters: {                 // JSON Schema for the args (flat, typed)
        type: "object",
        properties: { sides: { type: "number", description: "Number of sides (default 6)." } },
      },
      async handler(args) {
        const n = Math.max(2, Math.floor(args.sides || 6));
        return { result: `You rolled a ${1 + Math.floor(Math.random() * n)} (d${n}).` };
      },
    },
  ],
};
```

Then in the harness UI (**http://localhost:3010**) click **Reload**, toggle the
connector **on**, fill any config, and **Test**. Its tools appear on the orb's
next session.

### Rules that matter

1. **Tool names are global** — prefix every action `name` with the connector `id`.
2. **`description` is the model's only guide** — write it for an LLM deciding when to call.
3. **`parameters` is flat JSON Schema** — typed; avoid `$ref`/`anyOf`.
4. **`handler` returns `{ result }` or `{ error }`** — `result` is a short string the model reads aloud.
5. **Secrets** go in `config` with `secret: true` — stored server-side, never sent to the browser.
6. **Never block forever** — wrap outbound calls in `AbortSignal.timeout(ms)`.

The full contract (with vision/image connectors, secrets, and the checklist) is in
[`packages/harness/BUILDING-A-CONNECTOR.md`](../packages/harness/BUILDING-A-CONNECTOR.md).

## 3. Memory / "bring your own brain"

The default **`memory`** connector is Voxa's local brain — a folder of Markdown
notes (`memory_search` / `memory_save` / `memory_read` / `memory_list`). Point its
`brainDir` at an Obsidian vault to talk to your existing notes. Any server that
speaks the tool contract (`GET/POST /api/voice/tools`) can be a tool source too —
set it as the harness URL in Settings.
