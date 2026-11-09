# Scenarios, delegation and Windows commands — verification

Date: 2026-11-09. Workspace: `D:\kontur-spatial-ui`.

## Delivered behavior

The Scenarios screen provides seven editable tasks, preserves each brief separately, shows the selected project/model/method and reads tool availability from the server. Launch uses the existing conversation pipeline and refuses a busy chat, unsent draft, mismatched workspace or unavailable required tool.

`delegate_task` creates a real child conversation with the parent's captured model, workspace, mode and approval policy. Limits are three child tasks per parent run and twelve model steps per child. Children cannot delegate. Parent Stop and stream disposal clean up children and preserve terminal result links. An active child conversation is reserved against independent HTTP chat/agent runs.

The active child remains viewable. Sending, regeneration, image generation and deletion are disabled while its parent owns the run. Store and server-backed synchronization refuse deletion before cancellation hooks or HTTP requests. Drafts and history survive, and the child links back to its controlling parent. A failed cancellation retains ownership until cancellation can be confirmed. The server returns HTTP 409 for deleting a reserved child or deleting, editing or truncating its messages, including the interval between Stop and cleanup. These operations become available after its lease is released.

`run_shell` executes system CMD or Windows PowerShell, separately from the program allowlist used by `run_command`. Starting directories resolve inside the selected project; shell scripts are not an OS sandbox. Every shell invocation requires approval showing the full script. Timeouts stop the process tree and output is capped. CMD accepts a single line; PowerShell supports multiline scripts.

Program and shell permissions default to disabled. Desktop Settings → Advanced → Permissions changes them through a sender-validated IPC handler, native confirmation and a separate private host credential. The ordinary settings API cannot enable them. Task delegation is controlled in Settings → Agent. Other access switches remain read-only in this interface.

## Backend evidence

- Final full .NET suite: **1165 passed, 8 opt-in provider tests skipped, 0 failed**, 1173 total. The opt-in tests were not enabled in that run; the separate configured AutoRouter smoke is described below.
- Release server build and self-contained Windows publish: **0 warnings, 0 errors**.
- 85 process/tool checks include real CMD/PowerShell Unicode, quoting, exit codes, cancellation, timeouts and child-process termination.
- 53 targeted child reservation/agent/concurrency checks passed, including real HTTP 409 responses for a busy child, cleanup after Stop/Dispose and stale lease identity.
- The final transcript mutation guard passed 58 targeted HTTP/SQLite/settings/graph checks. Four regressions first reproduced HTTP 200 instead of 409; the corrected routes preserve reserved transcripts, permit mutations after release, and leave independent chats usable. Deleting a project only unfiles its chats and does not cascade into the running child's messages.
- Security review checked host-token exposure, ordinary settings restrictions, environment scrubbing, planning-mode execution, approval inheritance and delegation limits. The discovered child concurrency defect was fixed and rechecked.

Two process-tree regressions exposed a test startup race under parallel load: the two-second deadline expired before PowerShell wrote ready markers. Their fixture now waits for two real live PIDs with a separate bounded startup wait, then triggers cancellation or advances the injected clock by two seconds. `ProcessRunner` uses `TimeProvider.System` in production; caller cancellation, timeout, tree termination and output draining retain their behavior. The original constructor is preserved. The strict shell/process/command checks passed 85/85 and the complete suite above passed after this correction.

Evidence: `.tools/qa-agent-capabilities-2026-11-09/backend-verification.json` and `agent-capabilities-ready-final.trx`.

## Real provider evidence

The current self-contained server was launched on isolated port 45643 against a SQLite backup of the QA profile. Credentials remained encrypted in storage and were resolved by the application provider. The test did not print API keys.

OpenRouter `openrouter/auto`:

1. Called `delegate_task`, created a child conversation and completed a read-only page review in three child model steps. Parent and child canonical messages were all Complete.
2. Called `run_shell` for PowerShell and CMD. The test answered two individual approvals for exact harmless marker scripts. Both expected marker outputs were present, with no error frames or remaining Streaming messages.
3. An ordinary bearer request to the host permission endpoint returned 403.

Evidence: `.tools/qa-agent-capabilities-2026-11-09/live-verification.json`, `live-delegation-frames.json` and `live-shells-frames.json`. These are real provider/HTTP/process checks, not native UI automation.

## Output limits and continuation

The agent loop now handles the provider's `Completed(length)` as `OutputLimit`, appended to the enum without changing the existing values. It preserves partial text and usage, discards calls from the truncated turn before approval or execution, and reports a delegated task as incomplete. Five regressions failed before the fix and passed afterwards; a sixth checks that a subsequent request has no orphaned tool calls or tool results.

Electron reports output, step and time limits as stopped tasks, with the partial text retained. Output limits show a specific explanation and continuation advice. All three renderer regressions were observed failing before the status correction.

The original WPF host does not yet show a specific OutputLimit banner; these UI changes target Electron.

## Generated mini-projects

The configured OpenRouter AutoRouter created two standalone mini-projects through Aqvenor's actual write/edit tools:

| Project | File | Chromium checks | JavaScript errors | External requests |
| --- | --- | --- | --- | --- |
| Northline design studio | `.tools/qa-agent-2026-11-09/projects/02-studio/index.html` | 56/56 | 0 | 0 |
| FocusField study timer | `.tools/qa-agent-2026-11-09/projects/03-product/index.html` | 67/67 | 0 | 0 |

Checks used the generated files on local HTTP at widths 320, 768 and 1440, exercised FAQ entries, form validation and local confirmations, and checked overflow and internal links. FocusField also passed start, repeated start, pause and reset checks. Desktop and mobile screenshots were visually inspected.

During generation Aqvenor itself removed `novalidate="false"` from both forms: the presence of this boolean attribute disables native validation. It also simplified FocusField's header CSS for compatibility. No additional page repair was required by the final Chromium checks.

The first studio attempt used 12000 output tokens, reported Answered and created no file. Its raw provider finish reason was not recorded, so it is not evidence of a live `finish_reason=length`. The output-limit defect was established independently by the unit regressions above.

Evidence: `.tools/qa-agent-capabilities-2026-11-09/landing-qa-result.json`, `landing-qa-report.md` and `landing-checks/studio-product-1794220273883-result.json`. These are real provider and headless Chromium checks, not native computer use.

## Renderer evidence

Actual WorkflowsView, SettingsView and MessageBlocks components were exercised in Chromium with fixture backend responses and a fixture privileged bridge. The initial complete matrix passed **90/90** layouts across panel widths 280/320/414/580/960, English/Russian/German and dark/light themes, plus **12/12** interaction checks and no runtime errors.

The checks found and fixed offline capability loading, ModelPicker focus escape/restore and hidden overflow of long model names. They also cover preserved scenario briefs, model keyboard selection, permission responses and canonical child navigation.

A separate actual ChatView/Composer/MessageItem fixture passed **24/24** delegated-child layouts and **9/9** interactions with no runtime errors. This includes draft preservation, disabled mutations, the parent link and re-enabling Send after ownership cleanup. The final child-deletion regressions also exercise the real Sidebar menu, raw store and server-backed synchronization.

Two additional polling regressions confirm that eight consecutive approval-request errors lead to exactly one cancellation; ownership survives until its acknowledgement, and a failed cancellation enters the existing retry path. Partial text, draft attachments and the stopped child state survive. The suspected polling defect was withdrawn after these tests passed on the unchanged production driver.

The final renderer suite passed **287/287 tests in 38 files**. `npm run typecheck:all` and `npm run build:renderer` both exited successfully. The test harness still emits non-failing React `act` warnings in Settings preference tests; Vite reports the existing large bundles and mixed static/dynamic scenario imports.

Evidence: `electron/.tools/qa-agent-renderer-2026-11-09.json`, `.tools/qa-workflows-2026-11-09/verification.json`, `delegated-verification.json` and screenshots in the same directory.

## QA application package

The latest backend was published self-contained for win-x64 and packed together with the final renderer and Electron permission bridge. `electron-builder --dir --win --publish never` exited successfully. This is an unpacked QA application, not a published release.

Executable: `.tools/qa-agent-capabilities-2026-11-09/package/win-unpacked/Aqvenor.exe`. Close the older running Aqvenor instance before opening this build.

The package verification passed **12/12 checks**. SHA256 comparisons match the current main/preload code, renderer entry and its referenced assets, backend assemblies and runtime. The isolated QA data is absent from the application archive. The build is unsigned because no signing certificate is configured.

Evidence: `.tools/qa-agent-capabilities-2026-11-09/package-verification.json`, `verify-package.cjs` and `builder.cjs`.

## Computer use and retained test data

Windows computer use used the bundled `computer-use` skill and `@oai/sky`. Aqvenor was discovered and selected from returned windows. Both the initial screen capture and the recovery capture failed with channel timeouts (`FrameArrived timed out` / `window capture timed out`). Native UI inputs stopped after the recovery failure. Browser harness results do not establish native Electron verification.

The design kit's separate gate also failed on Windows path/runtime infrastructure; no WCAG or contrast score is claimed.

Automatic command review rejected deletion of the new isolated `live-data` snapshot with `blocked by policy`, including the attempt using an explicit checked literal path. It remains at `.tools/qa-agent-capabilities-2026-11-09/live-data`. No alternate deletion method was used.

The published `0.3.2-alpha` release and tag are unchanged by this task. New Canvas ideas remain in `docs/canvas-ideas-2026-11-09.md`; they were not implemented.

## Release preparation

The `0.3.3-alpha` version matches across .NET, Electron and the npm lockfile. The full Release solution build, including WPF, completed with zero warnings or errors. The renderer suite passed 287/287 again, both shell and renderer typechecks passed, and the release asset validator passed 7/7 tests.

The new self-contained win-x64 publish passed `scripts/smoke-sidecar.ps1`, covering its embedded runtime, bearer authentication, complete document reads, checkpoint restoration, stale content hashes and workspace isolation. An earlier attempt timed out before readiness while the renderer suite was running concurrently, with empty process logs; the isolated run passed in 8.9 seconds. The readiness check and production startup code were unchanged.
