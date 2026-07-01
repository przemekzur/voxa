# Voxa (v2) — the voice orb

A small, frameless, always-on-top **voice assistant** that floats on your desktop.
Tap the orb and talk: Voxa listens, thinks, calls tools, and replies out loud
through [Google Gemini Live](https://ai.google.dev/gemini-api/docs/live-api). It is
the **v2** Voxa — a thin Tauri front-end wired to the the brain brain and a growing
set of service **connectors** — and replaces the older .NET cockpit.

```
┌──────── orb (this app, Tauri) ────────┐
│  Gemini Live  ·  mic/speaker  ·  UI    │
└───────────────┬───────────────────────┘
                │ ToolBridge (mer— first source wins on a name clash)
        ┌───────┴───────────────┐
        ▼                       ▼
  the brain brain          Connector harness
  http://localhost:3000   http://localhost:3010
  (projects, tasks,       (weather, music, home,
   memory, knowledge…)     search, timers, …)
```

The orb itself holds no business logic — it's a **voice + UI shell**. Every
capability is a *tool*: either local to the orb, exposed by the brain, or provided
by a connector. New tools appear automatically on the next session; no rebuild.

---

## Using it

| Action | How |
|---|---|
| **Start / stop talking** | Tap the orb, or press the shortcut (default **Ctrl/Cmd + Space**) |
| **Push-to-talk** | Enable in config (`ui.pushToTalk`), then **hold** the shortcut / mic button to talk, release to send |
| **Type instead** | Open the chat (chevron ▾) and type in the composer; Enter sends |
| **Expand the conversation** | Chevron ▾ — grows into a resizable chat panel with full history |
| **Pick a microphone** | Gear ⚙ → Mic (hot-swaps mid-session) |
| **Set / change the Gemini key** | Asked once on first run; re-set via Gear ⚙ → Key. Also auto-loaded from the harness secret `geminiApiKey` |
| **Clear memory** | Gear ⚙ → Memory → clear conversation memory |

**What Voxa can do, in general**
- **Converse by voice** with barge-in (talk over it to interrupt).
- **Remember across sessions** — a rolling transcript plus a self-written summary
  seed each new session, so it picks up where you left off. It can `compact` long
  chats into durable memory on request.
- **Run proactive timers & reminders** — when one fires it chimes and *speaks* the
  alert, reopening the session if it was closed.
- **Play music in the orb** (VibeEngine) — audio plays through the orb and ducks
  while Voxa talks.
- **Ambient mode** — "just listen": stays quiet by default, acts silently, and
  speaks only when addressed or when it has something genuinely useful.
- **Text mode** — show replies as text (with a soft chime) instead of speaking.

---

## Tools

### Built-in (run inside the orb)
| Tool | What it does |
|---|---|
| `set_timer` / `remind_me` | Countdown timer / spoken reminder; alerts and speaks when it fires |
| `list_timers` / `cancel_timer` | List or cancel active timers/reminders |
| `compact_conversation` | Summarize the chat into persistent memory, then clear the on-screen history |
| `set_ambient_mode` | Toggle ambient ("just listen") mode |
| `set_reply_mode` | Switch between speaking and text-only replies |
| `stay_quiet` / `notify` | (ambient mode) say nothing, or post a silent text ping |
| `stop_music` · `pause_music` · `resume_music` · `skip_track` · `set_volume` · `volume_up` · `volume_down` | In-orb music control (only when the `vibeplay` connector is on) |

### Brain tools (the brain, `:3000`)
When the brain is running, Voxa can reach the whole the brain stack by voice —
projects, tasks, epics, agents, the scheduler, budgets, sessions, system metrics,
terminals, the knowledge base (`search_knowledge`, `store_knowledge`…), procedural
memory (`brain_query`), and stored facts (`fact_store`, `fact_recall`). Ask it to
remember something and it persists it to the brain.

### Connectors (`:3010`)
Each connector turns a service into voice tools. Manage them at the harness UI
(`http://localhost:3010`). Currently shipped:

| Connector | What it does | Example asks |
|---|---|---|
| **weather** | Conditions + forecast (Open-Meteo, no key) | "What's the weather in Kraków?", "Will it rain today?" |
| **websearch** | Web search + news (Brave/Tavily/SerpApi/DuckDuckGo) | "Search the web for…", "Any news about AI?" |
| **currency** | Live FX + conversion (ECB, no key) | "Convert 100 euros to złoty" |
| **lists** | Named lists (shopping, todo, ideas) | "Add milk to the shopping list" |
| **timers** | Harness-side countdown timers | "Set a 10-minute timer for pasta" |
| **grenton** | Home automation — lights, blinds, LED | "Turn on the kitchen light", "Close the bedroom blinds" |
| **vibeengine** | Browse the VibeEngine music catalog (MCP + OAuth) | "Search VibeEngine for synthwave" |
| **vibeplay** | Play a song / playlist / vibe in the orb | "Play some lo-fi", "Play my focus playlist" |
| **claude-code** | Read-only view of your local Claude Code activity | "What did I work on in Claude Code today?" |
| **xcom-news** | Find recent X/Twitter posts (via web search, no account) + post once you log in | "Search X for Mars news", "Post to X: …" |
| **forge** | Voxa builds new HTTP connectors at runtime, by voice | "Build me an OpenWeather connector" |
| **example-echo** | Reference/template connector | — |

> The harness UI (`:3010`) lists every connector with an **unfoldable doc panel**
> (each action + its parameters), a config form, a connectivity **Test**, and an
> action **Runner**.

---

## Adding a connector

Three ways, easiest first:

1. **By voice (forge)** — "build me a connector for `<API>`". The `forge` connector
   writes a safe declarative HTTP connector at runtime. Set API keys with
   `forge_set_secret`. Good for any REST/JSON API.
2. **With Claude** — run the `connector-builder` skill (`skills/connector-builder/`).
   It scaffolds, writes, validates, reloads, and live-tests a coded connector — use
   it when you need real logic (formatting, local state, OAuth, an MCP client).
3. **By hand** — drop a `connectors/<id>/index.mjs` into the harness and hit
   **Reload**. See [`BUILDING-A-CONNECTOR.md`](../connector-harness/BUILDING-A-CONNECTOR.md).

---

## Configuration

The desktop app authors `<app-data-dir>/voxa-config.json`, served to the orb
at `/api/cass/voxa-config`; the orb merges it over its defaults on boot and before
each session (no rebuild, no relaunch). Schema:

```jsonc
{
  "version": 1,
  "voice":   { "provider": "gemini", "model": "gemini-3.1-flash-live-preview", "voiceName": "Puck" },
  "persona": { "instruction": "You are Voxa, a concise, dry-witted assistant…" },
  "sources": [
    { "url": "http://localhost:3000", "label": "Brain",             "enabled": true },
    { "url": "http://localhost:3010", "label": "Connector harness", "enabled": true }
  ],
  "secretsUrl": "http://localhost:3010",
  "ui": {
    "pushToTalk": false,        // false = shortcut toggles the session (open mic); true = hold-to-talk
    "pttKey": "Space",          // KeyboardEvent.code: "Space", "F8", "Backquote", "KeyJ"…
    "pttModifier": "ctrlmeta"   // "ctrl" | "alt" | "shift" | "meta" | "ctrlmeta" | "none"
  }
}
```

The **Gemini API key** lives in this window's `localStorage` (or the harness secret
`geminiApiKey`), never in the config file.

Runtime appearance can also be extended from the same config through an `appearance`
block. Add declarative palettes and skins there when you want custom skins without
recompiling; use built-in renderer primitives such as `wire`, `soft`, `lens`,
`orbit`, `halo`, `reactor`, and `spectrum`. For the full schema and procedural
skin checklist, see `../../docs/voxa-orb-skins.md`.

---

## Running it

```bash
# dev (hot-reload the web shell; needs Rust + the Tauri CLI)
cd experiments/voxa-orb
npm run tauri dev

# build the exe (no installer — fastest for iterating)
npm run tauri build -- --no-bundle
```

The frontend is embedded at compile time, so code changes need a rebuild (kill a
running orb first — it locks the exe). For the full local stack (brain + harness +
orb) use the desktop supervisor app in `packages/desktop`.

## Layout

```
src/
  index.html        orb + panel markup
  styles.css        orb shell styling (procedural canvas orb, glass panel)
  main.js           app logic: session lifecycle, tools, memory, PTT, music, config
  js/
    gemini.js       GeminiSession — Gemini Live (open mic, server VAD, tool calls)
    audio.js        MicCapture (16 kHz PCM) + PcmPlayer (24 kHz)
    orb.js          procedural holographic orb (canvas, audio-reactive)
    tools.js        ToolBridge — merge + route tools across sources
  src-tauri/        Rust/Tauri window shell
```
