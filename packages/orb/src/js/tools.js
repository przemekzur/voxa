// Tool bridge client — aggregates one or more INDEPENDENT tool sources, each
// speaking GET /api/voice/tools + POST /api/voice/tools/call. Voxa v2 uses two:
//   • the brain (the brain, :3000) — projects, tasks, memory, system
//   • the connector harness (:3010) — service integrations (Grenton, …)
// They stay separate; this just merges their tool lists for the model and routes
// each call back to the source that owns the tool.

export class ToolBridge {
  // sources: a single URL string (legacy) or a list of { url } objects.
  constructor(sources = []) {
    const list = typeof sources === "string" ? [{ url: sources }] : (Array.isArray(sources) ? sources : []);
    this.sources = list
      .filter((s) => s && s.url)
      .map((s) => ({ url: String(s.url).replace(/\/$/, "") }));
    this.declarations = [];
    this._owner = new Map(); // toolName -> source base url
  }

  // Fetch + merge tool declarations from every source (in order; first wins on
  // a name clash, which shouldn't happen — connector tools are prefixed).
  async load() {
    const all = [];
    this._owner.clear();
    for (const s of this.sources) {
      try {
        const res = await fetch(s.url + "/api/voice/tools", { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        for (const t of (Array.isArray(data.tools) ? data.tools : [])) {
          if (this._owner.has(t.name)) continue;
          this._owner.set(t.name, s.url);
          all.push(t);
        }
      } catch { /* a source being down must not break the others */ }
    }
    this.declarations = all;
    return all;
  }

  get available() { return this.declarations.length > 0; }

  // Execute a tool call against whichever source declared it.
  async call(name, args) {
    const base = this._owner.get(name) || this.sources[0]?.url;
    if (!base) return { error: "no tool source available" };
    try {
      const res = await fetch(base + "/api/voice/tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, args: args || {} }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.error) return { error: data.error };
      // A connector may hand back an `image` (e.g. the screen connector) for the
      // model to SEE — the GeminiSession injects it as a session image turn since
      // a tool's text result can't carry a picture the model can interpret.
      return data.image?.data ? { result: data.result, image: data.image } : { result: data.result };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }
}
