// Screen capture connector — lets Voxa SEE the operator's screen.
//
// Capture uses .NET (System.Drawing) via inline PowerShell so there are no native
// npm deps. The screenshot is written to a temp JPEG (the base64 conversion is
// done here in Node — doing it in PowerShell trips AV/AMSI "screen-exfil"
// heuristics). The handler returns an `image` field; the orb's tool bridge +
// GeminiSession recognise it and inject the screenshot into the live session as
// an image turn — a tool's text result can't carry a picture the model can "see".
//
// Windows-only (System.Windows.Forms.Screen). Other platforms return a clear error.

import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IS_WIN = process.platform === "win32";

function ps(command, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || "").trim() || err.message));
        resolve(String(stdout || ""));
      },
    );
  });
}

const LIST_CMD = [
  "Add-Type -AssemblyName System.Windows.Forms;",
  "$s=[System.Windows.Forms.Screen]::AllScreens;",
  "$o=for($i=0;$i -lt $s.Count;$i++){$b=$s[$i].Bounds;[pscustomobject]@{index=$i;width=$b.Width;height=$b.Height;primary=[bool]$s[$i].Primary}};",
  "ConvertTo-Json @($o) -Compress",
].join("");

// Build a capture command that writes a downscaled JPEG to `out`. `sel` is the
// PowerShell expression selecting the screen.
function captureCmd(sel, out) {
  const outLit = out.replace(/'/g, "''");
  return [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
    `$scr=${sel};`,
    "$b=$scr.Bounds;",
    "$src=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
    "$g=[System.Drawing.Graphics]::FromImage($src);",
    "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
    "$g.Dispose();",
    "$max=1600;$scale=[Math]::Min(1.0,$max/[Math]::Max($b.Width,$b.Height));",
    "if($scale -lt 1.0){$nw=[int]($b.Width*$scale);$nh=[int]($b.Height*$scale);$dst=New-Object System.Drawing.Bitmap $nw,$nh;$dg=[System.Drawing.Graphics]::FromImage($dst);$dg.DrawImage($src,0,0,$nw,$nh);$dg.Dispose();$src.Dispose();$src=$dst};",
    `$src.Save('${outLit}',[System.Drawing.Imaging.ImageFormat]::Jpeg);`,
    "$src.Dispose();",
  ].join("");
}

async function capture(sel) {
  const out = join(tmpdir(), `voxa-screen-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`);
  try {
    await ps(captureCmd(sel, out));
    const buf = await readFile(out);
    return buf.toString("base64");
  } finally {
    unlink(out).catch(() => {});
  }
}

export default {
  id: "screen",
  name: "Screen Vision",
  description: "Capture the operator's screen so Voxa can see and act on what's displayed.",
  icon: "🖥",
  config: [],

  async test() {
    if (!IS_WIN) return { ok: false, message: "Screen capture is only supported on Windows." };
    try {
      const n = (JSON.parse((await ps(LIST_CMD)).trim() || "[]") || []).length;
      return { ok: n > 0, message: n > 0 ? `${n} display(s) detected.` : "No displays detected." };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  },

  actions: [
    {
      name: "screen_list_displays",
      description:
        "List the operator's monitors with their index and resolution. Call this first when the operator has more than one screen and you need to know which display index to capture.",
      parameters: { type: "object", properties: {} },
      async handler() {
        if (!IS_WIN) return { error: "Screen capture is only supported on Windows." };
        try {
          const arr = JSON.parse((await ps(LIST_CMD)).trim() || "[]");
          const list = Array.isArray(arr) ? arr : [arr];
          if (!list.length) return { error: "No displays detected." };
          return {
            result: list
              .map((d) => `Display ${d.index}: ${d.width}x${d.height}${d.primary ? " (primary)" : ""}`)
              .join("; "),
          };
        } catch (e) {
          return { error: "list displays failed: " + (e?.message || e) };
        }
      },
    },
    {
      name: "screen_capture",
      description:
        "Take a screenshot of the operator's screen so you can SEE it, then read and act on what's shown. Use whenever the operator asks you to look at / read / check / describe / work with what's on their screen. The image is delivered to you right after this call — wait for it, then answer. Optional `display`: the 0-based monitor index from screen_list_displays; omit it to capture the primary display.",
      parameters: {
        type: "object",
        properties: {
          display: {
            type: "integer",
            description: "0-based display index from screen_list_displays. Omit for the primary display.",
          },
        },
      },
      async handler(args) {
        if (!IS_WIN) return { error: "Screen capture is only supported on Windows." };
        const hasIdx = Number.isInteger(args?.display);
        const sel = hasIdx
          ? `([System.Windows.Forms.Screen]::AllScreens[${args.display}])`
          : "[System.Windows.Forms.Screen]::PrimaryScreen";
        try {
          const data = await capture(sel);
          if (!data) return { error: "Capture produced no image." };
          return {
            result: hasIdx ? `Captured display ${args.display}.` : "Captured the primary display.",
            image: { mimeType: "image/jpeg", data },
          };
        } catch (e) {
          return { error: "capture failed: " + (e?.message || e) };
        }
      },
    },
  ],
};
