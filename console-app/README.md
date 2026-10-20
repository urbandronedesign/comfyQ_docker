# ComfyQ Console — desktop app

The RunPod / Thunder Compute console ([tools/runpod/console](../tools/runpod/console)) in its own window, for the owner's Windows PC. It is the same server and the same page: the app starts `server.mjs` as a child process and shows its page. `RunPod-Console.bat` keeps working for a browser.

What the app adds over the browser:
- **A lock only the app holds.** The server listens on a random port of this machine only, and accepts only a random token made at each start and given to the app's own window (through `preload.js`). The browser version accepts a fixed header, so any program on the PC could call it; the app does not.
- **Keys in Windows' protected storage** (DPAPI, through Electron's `safeStorage`), in `~/.comfyq/console-secrets.bin`. The first start moves them out of the plain `~/.comfyq/runpod-console.json`: encrypted, written, read back and compared, and only then removed from the plain file. ⚠ After that, `RunPod-Console.bat` (the browser version) no longer sees them; entering them there again puts them back in plain text. The server is handed the keys at start and keeps them in memory only; a key saved from the page is sent back to the app to store.
- **The workflow list follows GitHub.** The console reads each workflow's meta and runtime files and the download sizes. Installed, the app keeps its own copy in `~/.comfyq/app-cache`, filled first from the copy it ships with (works offline), then refreshed from `main` on GitHub at each start, fetching only files whose sha changed. A failed refresh keeps the last copy. Run from the repo, it reads the repo's own files (`COMFYQ_APP_GITHUB_WORKFLOWS=1` forces the GitHub copy).
- **OpenSSH check.** Thunder's setup runs over `ssh`; if it is missing, the Thunder Create panel says so before anything is created.
- **Tray and warnings.** Closing the window keeps the app in the tray (said once, the first time); its tooltip and menu show the current $/hour, today, and each running machine. Every 30 seconds the app reads the console's own figures and warns with a Windows notification (click it to open the window) when:
  - a machine finishes its setup and serves, or its setup fails (it bills anyway);
  - a machine has been on for 3 hours, then 6 and 9;
  - today passes the daily budget;
  - a balance covers less than 4 hours at the current rate (RunPod stops a Pod at zero).
  What is already true when the app starts is not announced. The rules are in [watch.js](watch.js), each tested in `test/watch.test.js`.
- **Quitting while something bills asks first**, naming each machine and the total per hour: quitting does not stop them, and nothing warns about them any more.
- **Updates you can watch.** A bar at the top of the window follows each update: found (with *What's new*), downloading with percent, MB, speed and time left, then *Restart and install now* or *Later* (it installs when you quit); a failure says why, with *Try again*. *Settings → About & updates* shows the version, the last check and its result, and checks on demand. The first start after an update says *Updated to version X*. Every check is logged in `~/.comfyq/console-app.log`.
- **An installer that updates itself.** A one-click, per-user Windows installer (no admin prompt). The installed app checks this repo's GitHub Releases at start and every 6 hours, downloads a new version in the background, says so, and installs it when you quit. The tray menu shows the version and has *Check for updates*. Not code-signed: the first install asks *More info → Run anyway* in Windows SmartScreen.

## Install

Download `ComfyQ-Console-Setup-<version>.exe` from the repo's [Releases](https://github.com/urbandronedesign/comfyQ_docker/releases) and run it. It lands in *Start → ComfyQ Console*. ⚠ Its first start moves your keys out of `~/.comfyq/runpod-console.json` into Windows protected storage, after which `RunPod-Console.bat` no longer sees them.

## Release a new version

```bash
cd console-app
npm run release:patch    # or :minor / :major — bumps, commits, tags console-vX.Y.Z, pushes
```

The tag starts `.github/workflows/console-app.yml`: it tests the warning rules, builds the installer on Windows and publishes it with `latest.yml`. ★ Tags are `console-v…`, never `v…` (that starts the Discovery release). The updater takes the repo's **latest** release, so a release of something else in this repo would hide the app's: keep releases here for the app only. `npm run dist` builds the same installer locally into `dist/` without publishing, and `COMFYQ_APP_EXE="dist/win-unpacked/ComfyQ Console.exe" npm test` runs the app test against it.

## Run it from the repo

```bash
cd console-app
npm install          # once; downloads Electron
npm start            # or, from the repo root: npm run console:app
npm test             # the warning rules (24 checks), then the real app started three times (41 checks, the last with a pretend update; the GitHub part needs the internet)
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
| 2 | Keys in Windows' protected storage; workflow list fetched from GitHub with a bundled copy; `ssh` check | done |
| 3 | Tray with $/hour, notifications (setup done/failed, machine on > 3 h, budget passed, balance < 4 h), confirmation on quit while billing | done |
| 4 | Installer + auto-update from GitHub Releases on a `console-v*` tag | done |

Test hooks: `COMFYQ_APP_EVENTS_FILE` records what the app announces (and lets the test close the window, which a page cannot do to its own top-level window); `COMFYQ_APP_WATCH_MS` reads more often than every 30 s; `COMFYQ_APP_SERVER_HOME` gives the server alone another data folder (Electron itself crashes on a made-up Windows profile, so the test cannot just change `USERPROFILE`).
