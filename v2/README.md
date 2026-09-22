# GoogleTool v2 - Chromium 148 trial

The active runtime is Adryfish fingerprint-chromium **148.0.7778.215**, Windows x64.

## Run

```powershell
npm ci
.\v2\setup-chromium148.ps1
npm start
```

Git tracks v2 source, tests and engine patch/build scripts. Browser binaries,
build manifests, upstream Chromium trees, profiles, logs and artifacts are excluded.
Chromium 149/151 require a local build and generated verification manifest.
Root packaging scripts inherited from v1 are not the v2 release workflow.

Set the optional service key with `TWO_CAPTCHA_API_KEY` before starting the app,
or use the existing local app configuration. No API key is bundled in Git.

`start.bat` also starts v2. Electron is installed in the root node_modules directory. The setup verifies the release archive checksum; the app verifies the exact executable version and chrome.exe/chrome.dll hashes.

Each profile saves a unique seed, locale and timezone. The engine chooses GPU metadata from the seed; manual GPU vendor/renderer selection is unavailable in this version. GPU metadata does not change physical hardware.

## Storage

This trial uses a separate `%APPDATA%/googletool-v2-adryfish148` store and `profiles-adryfish148/<id>` browser directories. The previous `%APPDATA%/googletool-v2` store remains untouched. The trial starts with an empty profile list; previous login sessions are not migrated. Do not open 151 browser data with 148.

Running status tracks processes opened during the current app session. Restoring status for browser windows after restarting GoogleTool is not implemented.

## Verification

```powershell
npm run test:v2
npm run test:v2:ui
node v2/tests/chromium-audit.cjs --offline
node v2/tests/canvas-consistency.cjs
$planFile = node v2/tests/native-launch-plan.cjs --reopen
.\v2\tests\chromium-native.ps1 -PlanFile $planFile
```

The local audit measures two seeds and reopening the first profile using CDP. The Canvas probe compares the active engine against the installed Chrome for Testing 151 baseline, not a same-version control.

The native IPhey audit uses no CDP/WebDriver, captures only its own test windows and restores the clipboard after copying results. Keep its window focused during capture. It checks two profiles and a restart. The report requires matching visible/detail scores and complete detection flags before confirming 100. Artifacts are saved under v2/artifacts. No real Gmail login is used.

Unset ELECTRON_RUN_AS_NODE before running Electron if present. Historical CHROMIUM151 reports and setup scripts describe previous engines, not this active runtime.

Editing/deleting profiles, proxy configuration, cloud sync, automatic login and v2 packaging are not implemented. Root build commands remain for v1; use `npm run start:v1` to start v1.
