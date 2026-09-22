# Chromium 151 build alongside the unchanged 149 runtime

Target: **151.0.7922.173**, Chromium commit `a96602f30358e9b5d256a0464e7e4d4bec223004`, V8 commit `4b407bc23f23059b1019cde542601c2cf8f70eb2`.

This port starts from the verified 149 patch, SHA256 `17eceb36c98ce1962a4910cd799295ba0fabd4b6f98be51085a38c732f33f33f`. It preserves that patch's behavior, including the current Canvas behavior and known Pixelscan limitation. It does not import Ungoogled patches disabling Chrome Web Store integration.

The 151 patch applies cleanly to the pinned source and reproduces all 60 changed file hashes. Compatibility resolutions cover four include-only conflicts, applying Client Hints changes before the new metadata-cache comparison, and preserving the old port's V8 binding behavior in the updated function. Default fingerprint brand versions are updated to 151. Compilation and runtime validation are separate gates; clean application alone is not proof of a working browser.

## Separate build paths

- Source, tools and output: `E:\GoogleToolBuild151`.
- Expected executable: `E:\GoogleToolBuild151\src\out\GoogleTool151\chrome.exe`.
- Status: `../artifacts/build151-status.json`.
- Logs: `../artifacts/build151-background.stdout.log` and `.stderr.log`.
- Provenance: `source-manifest.json`, `port-report.json`, `LICENSE.adryfish`.
- Baseline 149 manifest snapshot: `baseline149-manifest.json`.

`build-pipeline.ps1` copies build tools into the new root, checks out the pinned tag, syncs dependencies, runs hooks, applies the verified patch, generates GN files and builds `chrome` with 8 jobs. The pipeline temporarily keeps the computer awake and releases that request on exit. It records failure stages and stops on errors. The final stage is `compiled_pending_tests`; it does not activate 151 in the app.

After a verified compilation, `record-build.ps1` records the version, commits, source hashes and runtime file hashes in a new `build-manifest.json`. Keep the whole component output directory with its DLLs and resources. The 149 build, its manifest, application default and user profiles remain unchanged.

Before activating 151, run the same local API, Canvas/WebGL, cookie persistence, UI, Web Store and native IPhey/Pixelscan checks used for 149. No 151 runtime result is claimed yet.

For source reproduction in a fresh engine151 workspace: `prepare.py`, then `resolve.py`, then `port.py`. Preparation intentionally refuses to overwrite an existing resolved work tree. `apply.py` verifies the exact source hashes and refuses an already modified checkout.
