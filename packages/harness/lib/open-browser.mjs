// Open a URL in the user's default browser, cross-platform.
//
// win32 gotcha: do NOT use `cmd /c start "" <url>`. cmd.exe treats the `&` that
// separates query params as a command separator, so OAuth authorize URLs get
// truncated at the first `&` (dropping client_id and everything after) and the
// consent page fails with "client_id: Not present". rundll32's FileProtocolHandler
// takes the whole URL as a single argv and launches the default browser intact.
import { spawn } from "node:child_process";

export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* non-fatal */ }
}
