// Reference connector — the smallest possible example. Copy this folder to start
// a new connector. It has one config field and two actions, no external calls.
export default {
  id: "example-echo",
  name: "Example · Echo",
  description: "Reference connector. Echoes text and reports the time — proves the harness wiring.",
  icon: "◇",

  config: [
    { key: "prefix", label: "Echo prefix", type: "text", placeholder: "Voxa says", default: "Voxa says", help: "Prepended to echoed text." },
  ],

  async test(cfg) {
    return { ok: true, message: `Ready. Prefix = "${cfg.prefix}".` };
  },

  actions: [
    {
      name: "echo_say",
      description: "Echo a phrase back, prefixed by the configured prefix.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The phrase to echo." } },
        required: ["text"],
      },
      async handler(args, cfg) {
        return { result: `${cfg.prefix}: ${args.text ?? ""}` };
      },
    },
    {
      name: "echo_time",
      description: "Return the current server time as an ISO string.",
      parameters: { type: "object", properties: {} },
      async handler() {
        return { result: new Date().toISOString() };
      },
    },
  ],
};
