# Building a connector

> This doc doubles as the spec for an AI agent that writes connectors. Follow it
> literally; the harness loads any `connectors/<id>/index.mjs` that matches it.

A connector is **one ES module** that default-exports a manifest. No build, no
dependencies beyond Node's standard library + global `fetch`.

## The manifest

```js
export default {
  id: "my-service",            // unique, lowercase, matches the folder name
  name: "My Service",          // shown in the UI
  description: "One line.",    // shown in the UI and to the model
  icon: "◆",                   // optional single glyph

  // Fields rendered in the config form. Values are saved server-side.
  config: [
    { key: "apiKey", label: "API key", type: "text", secret: true, required: true, help: "..." },
    { key: "baseUrl", label: "Base URL", type: "text", default: "https://api.example.com" },
    // type: "text" | "number" | "textarea". secret:true masks it (••••).
  ],

  // Optional connectivity check (the UI "Test" button).
  async test(config) {
    // return { ok: boolean, message: string }
  },

  // Voice tools this connector exposes. Each becomes a function the model can call.
  actions: [
    {
      name: "myservice_do_thing",          // GLOBALLY-UNIQUE — prefix with the id
      description: "Plain-language: what it does and when to use it.",
      parameters: {                         // JSON Schema for the args
        type: "object",
        properties: { thing: { type: "string", description: "..." } },
        required: ["thing"],
      },
      async handler(args, config) {
        // ...do the work, using args + config...
        return { result: "human-readable string" };   // success
        // return { error: "what went wrong" };        // failure
      },
    },
  ],
};
```

## Letting Voxa SEE an image (vision connectors)

A handler may return an `image` alongside `result` so Voxa can *look* at a
picture (e.g. a screenshot), not just read text:

```js
return {
  result: "Captured the primary display.",       // short text ack the model reads
  image: { mimeType: "image/jpeg", data: base64 } // the picture the model SEES
};
```

The harness forwards `image` to the orb, which injects it into the live Gemini
session as an image turn — because a tool's text `result` can't carry a picture
the model can interpret. Keep images reasonable (downscale to ~1600px longest
side). See `connectors/screen` for a working example. Vision requires a
vision-capable model (the orb's `gemini-3.1-flash-live-preview` is — verified).

## Rules that matter

1. **Tool names are global.** Prefix every action `name` with the connector `id`
   (`grenton_light_on`, not `light_on`) so it never collides with brain tools or
   other connectors.
2. **`description` is the model's only guide.** Write it for an LLM deciding
   whether to call the tool. Say what it does, the units, and when to use it.
3. **`parameters` is JSON Schema** and is passed to the realtime models. Keep it
   flat and typed. Avoid `anyOf`/`$ref` — the Gemini path degrades those to
   strings.
4. **`handler` returns `{ result }` or `{ error }`.** `result` should be a short
   string the model can read aloud. Don't dump giant JSON.
5. **Never block forever.** Wrap outbound calls with
   `AbortSignal.timeout(ms)`.
6. **Secrets live in `config` with `secret: true`.** They're stored server-side
   and never sent back to the browser in clear text.

## Workflow

1. `cp -r connectors/example-echo connectors/my-service`
2. Edit `connectors/my-service/index.mjs`.
3. In the UI, click **Reload** (or `POST /api/reload`), then **Configure** →
   fill fields → **Save** → **Test** → run each action.
4. Flip the connector **on**. Its tools now appear in `/api/voice/tools` and in
   the cockpit.

## Checklist before shipping a connector

- [ ] `id` matches the folder name, lowercase.
- [ ] Every action `name` is prefixed with `id`.
- [ ] Every action has a model-friendly `description` and typed `parameters`.
- [ ] Handlers return `{ result }`/`{ error }` and time out on network calls.
- [ ] Secrets use `secret: true`.
- [ ] `test()` gives a clear pass/fail message.
