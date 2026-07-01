# Platform support

Voxa is a **Tauri v2** app and targets **Windows, macOS, and Linux**. Every push
builds the orb on all three via CI (`.github/workflows/build.yml`).

| Platform | WebView | Notes |
|---|---|---|
| Windows | WebView2 | Primary dev platform. Release builds have no console window. |
| macOS | WKWebView | Transparent orb needs `macOSPrivateApi` (set). Mic needs `NSMicrophoneUsageDescription` (shipped in `src-tauri/Info.plist`). |
| Linux | WebKitGTK 4.1 | Needs `libwebkit2gtk-4.1` at runtime; voice requires a WebKitGTK with `getUserMedia` (≥ 2.38). |

## Local build deps

- **All:** Rust (stable) + Node 18+.
- **Linux:** `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
  (the CI workflow installs these).
- **Windows:** WebView2 runtime (preinstalled on Win 11) + VS Build Tools.
- **macOS:** Xcode command-line tools.

## Build

```
cd packages/orb
npm install
npm run tauri build              # release installers for the host OS
npm run tauri build -- --no-bundle   # compile only, no installers (what CI runs)
```

The connector harness (`packages/harness`) is plain Node and runs anywhere Node
18+ runs — no native build.
