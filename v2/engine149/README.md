# Adryfish fingerprint patches ported to Chromium 149

Status: **all 32 patched C++ translation units compile; complete browser build/link is in progress; runtime is not yet tested**. The default GoogleTool launcher continues to run the tested 148 binary.

## Inputs

- Chromium tag `149.0.7827.102`, commit `112f665d98a2fe84b156c74fbea2aed742f16c15`.
- V8 revision from that tag's DEPS: `16ef80c1f5d3cfade812bd1743952a4cfd480a31`.
- Public Adryfish patch tag `144.0.7559.132`. This is NOT the unpublished 148 patch implementation and cannot reproduce all features of its binary.
- Vendor source archive SHA-256: `7fe09e319d12db1dbf794a0152b01b383b3aac331b773a71c1fce7a68df9086c`.
- Retained upstream license: [LICENSE.adryfish](LICENSE.adryfish). Chromium and V8 files retain their original notices.

Sources: [Adryfish tag](https://github.com/adryfish/fingerprint-chromium/tree/144.0.7559.132), [Chromium tag](https://chromium.googlesource.com/chromium/src/+/refs/tags/149.0.7827.102).

## What was ported

The 16 public fingerprint patches plus four prerequisite patches: switch plumbing, UA/Client Hints, CPU, font filtering, audio, Canvas pixels/export/text, client rectangles, GPU metadata/readback, timezone and the upstream automation-related changes. Only fingerprint prerequisites were selected; Ungoogled patches disabling Google/Web Store services were not imported. This preserves upstream source behavior for those services, but extension installation has not been tested on a compiled 149 build.

Explicit resolutions cover changed Chromium 149 UA signatures, missing switch propagation, renamed `String::FromUtf8`, moved constructor/include contexts and GPU insertion points without the unrelated Ungoogled GPU override feature. Added GN dependencies and public symbol exports for the new component references.

Source corrections:

- `TextMetrics::Shuffle` multiplies by its argument. Adryfish supplies a delta in approximately [-0.000005, 0.000005]. The port supplies `1.0 + delta` to preserve the original width scale. This addresses a code-level defect consistent with the observed negative/near-zero 148 width; it is not yet verified in a compiled browser.
- Client-rectangle noise is an offset, so its neutral document default is zero rather than one.
- Default Chromium/Chrome version constants use `149.0.7827.102`, avoiding the original 144 Client Hints when the binary is launched without the app's explicit version flag.
- Client Hints permutation tables use `std::array` to satisfy Chromium 149's unsafe-buffer compiler checks without disabling the checks.
- Font/GPU tables use `NoDestructor`, and GPU model indexing uses `base::span` for the 149 compiler checks.
- Canvas accesses pixels through `SkPixmap`, preserving the actual stride and destination buffer bounds. WebGL noise only handles contiguous RGBA8 readback; other formats/packing remain unchanged rather than being reinterpreted as RGBA bytes.

## Evidence

`port.py` applies the original series, runs explicit resolutions, emits `adryfish-149.patch`, then applies that patch to another clean copy of the upstream files. Both `git apply --check` and actual application succeeded; SHA-256 of all 60 changed files matched the intended output. See [port-report.json](port-report.json).

The `patched` build stage has now compiled all 32 changed C++ translation units successfully with their actual dependencies. Its first pass exposed compiler errors in Client Hints/font/GPU/Canvas; these were fixed in the reproducible port. The successful follow-up is logged in `v2/artifacts/build149-patched-fixed.log`. This verifies C++ compilation of the patch, but does not yet verify the complete browser link or runtime.

The upstream/work/verify directories contain only the files touched by this investigation, **not complete Chromium checkouts**. Clean patch application is not a C++ compile, GN dependency validation, browser compatibility test or IPhey result. Further build errors may require changes.

## Apply to a complete checkout

Obtain Chromium and dependencies at the exact revisions above using Chromium's depot_tools workflow. Use LF source files and a short local build path; the helper checks source hashes and refuses modified or already-patched files.

```powershell
python v2/engine149/apply.py C:/chromium149/src --check
python v2/engine149/apply.py C:/chromium149/src
```

Follow the [Windows build instructions for this tag](https://chromium.googlesource.com/chromium/src/+/refs/tags/149.0.7827.102/docs/windows_build_instructions.md), not the moving main branch instructions. This machine has VS 2022 C++/ATL headers and SDK debugging tools; the tag's toolchain code includes VS 2022 support.

The full checkout is now at `E:\GoogleToolBuild149\src`, with depot_tools in the sibling directory. Chromium and V8 revisions were checked, dependencies synced, the patch applied and verified, and `gclient runhooks` completed successfully. GN generation completed with 30,077 targets. GN header checks passed for `//components/embedder_support:user_agent` and `//third_party/blink/*`. Compilation is in progress; runtime validation is pending. `build-local.ps1` records the local Windows environment and supports the stages `sync`, `hooks`, `generate`, `patched`, and `build`. Do not rerun sync over the patched checkout without preserving local changes. Logs are under `v2/artifacts/build149-*.log`.

After a successful `build` stage, the helper invokes `record-build.ps1` to verify the version and patched source and record binary/resource hashes in `build-manifest.json`. This manifest initially does not claim runtime or IPhey validation. `start149.bat` selects the local build in GoogleTool using a separate `googletool-v2-adryfish149` data directory. It refuses to launch the browser until the build manifest and binary checks pass.

`finish-build.ps1 -BuildProcessId <PID>` watches a specific build process, then runs local API/restart, Canvas/buffer-boundary and UI probes. Only if all probes return success does it set `runtimeTested: true` and start the 149 app. The ordinary launcher then defaults to 149; `start148.bat` remains available for the separate 148 data. This does not assert an IPhey score. The watcher temporarily keeps the system awake while waiting/testing and releases that request on completion/failure. Status is in `v2/artifacts/build149-finish-status.json`; current background compiler output is `build149-background.stdout.log` and `build149-background.stderr.log`.

After compiling, verify the real binary version, run local Canvas/API and restart probes, test extensions, then run native IPhey. Only then pin its hashes and switch the app. Do not reuse production profile data during the trial.

## Reproduce the port locally

The `vendor` directory must contain the source archive extracted as `fingerprint-chromium-144.0.7559.132`.

```powershell
python v2/engine149/prepare.py
python v2/engine149/port.py
```

`prepare.py` downloads pinned upstream files, including V8 from its separate repository; `source-manifest.json` records their hashes. `port.py` retains rejected-hunk logs for audit but emits a resolved patch. Temporary trees and vendor caches are ignored by Git.
