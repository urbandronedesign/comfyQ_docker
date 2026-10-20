# ComfyQ Console — desktop app

The RunPod / Thunder Compute console ([tools/runpod/console](../tools/runpod/console)) in its own window, for the owner's Windows PC. It is the same server and the same page: the app starts `server.mjs` as a child process and shows its page. `RunPod-Console.bat` keeps working for a browser.

What the app adds over the browser:
- **A lock only the app holds.** The server listens on a random port of this machine only, and accepts only a random token made at each start and given to the app's own window (through `preload.js`). The browser version accepts a fixed header, so any program on the PC could call it; the app does not.
- Next phases: a tray icon with the current $/hour that keeps the billing alerts running when the window is closed; desktop notifications; keys in Windows' protected storage; an installer that updates itself.

## Run it from the repo

```bash
cd console-app
npm install          # once; downloads Electron
npm start            # or, from the repo root: npm run console:app
npm test             # starts the real app and checks it (13 checks)
```

⚠ If your shell has `ELECTRON_RUN_AS_NODE` set, Electron runs as plain Node and no window opens: unset it first.

## Decisions (owner, 2026-10-20)

- A **separate app**, not part of ComfyQ – Discovery: Discovery goes on students' and lab machines, and this one holds the keys that spend money.
- Closing the window **keeps it running in the tray**, so the billing alerts keep working.
- **Windows only.**
- Keys and passwords in **Windows' protected storage** (moved from `~/.comfyq/runpod-console.json` on first start).

## Plan

| Phase | What | State |
|---|---|---|
| 1 | Window + embedded server + per-start token; runs from source | done |
| 2 | Keys in Windows' protected storage; workflow list fetched from GitHub with a bundled copy; `ssh` check | |
| 3 | Tray with $/hour, notifications (setup done/failed, machine on > 3 h, budget passed, balance < 4 h), confirmation on quit while billing | |
| 4 | Installer + auto-update from GitHub Releases on a `console-v*` tag | |

Test hook: `COMFYQ_APP_SERVER_HOME` gives the server alone another data folder (Electron itself crashes on a made-up Windows profile, so the test cannot just change `USERPROFILE`).
