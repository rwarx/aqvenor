# Security review for v0.3.2-alpha

Date: 8 November 2026.

Baseline commit: `0c452e1838c8d8a59e3ce5a7b2d193512bf7929f`.
The review covers the uncommitted implementation being prepared for this release;
it does not attest to a final tag or an independently rebuilt published binary.
The release owner must record the final tested SHA and complete packaged Electron
acceptance before publication.

## Scope and trust boundaries

Reviewed the Electron updater controller, native NSIS launcher, main/preload IPC,
renderer restart/save handshake, active-task coordination, graph endpoints,
graph persistence/coordinator, workspace file hashes and leases, portable JSON
validation, release workflow, asset collector, and related privacy documentation.

- The sidecar's `/api` graph and workspace endpoints require authentication.
  Mutations acquire a workspace lease and check the expected root, preventing a
  delayed request from writing to a workspace selected after the request began.
- Electron IPC uses the existing exact renderer URL and main-frame sender
  validation. The renderer receives a limited updater state and action surface;
  it cannot select a feed, token, installer path, shell arguments or repository.
- The update repository is fixed to the public `rwarx/aqvenor` GitHub Releases.
  TLS, GitHub repository publishing access and GitHub asset delivery are part of
  the publisher trust boundary. Installer SHA512 verification detects corruption
  against downloaded metadata; it does not provide an independent signature.
- Portable graph parsing checks format versions, finite geometry, viewport,
  graph counts and relationships. Export writes retain a content hash so a
  concurrent external edit is reported rather than silently replaced.
- The renderer coordinator keeps pending edits across snapshots, checks workspace
  identity, accepts undo's decreasing graph version, and reuses request IDs on a
  response-loss retry. Backend idempotency prevents that retry from duplicating
  an already accepted edit.
- Update requests carry no workspace data, provider key, conversation or GitHub
  user token. The library's persistent staging UUID is local; the outgoing
  staging header is overridden with a value common to all installations.

No confirmed Critical/High authentication, command-injection or secret-exposure
finding was identified in the reviewed change. This is a scoped review, not a
claim that every pre-existing application feature was exhaustively audited.

## Findings and disposition

### Medium: A recoverable corrupt private graph was erased by close-save — fixed

Location: `src/AIClient.Infrastructure/Graph/JsonGraphStore.cs`, `LoadAsync`,
`SaveAsync` and `PreserveUnreadableGraphAsync`;
`src/AIClient.Server/GraphPersistence.cs`, `ReadLayoutAsync` and `SaveLayoutAsync`;
`src/AIClient.Infrastructure/Graph/GraphRecoveryFiles.cs`, `CreateAsync`.
Category: Data integrity / silent failure. CWE-703.

An unreadable private graph loaded as an empty snapshot while reporting an
error. The subsequent close-save could overwrite the source, removing data that
could otherwise be recovered manually. Failed loads now mark the destination
filename. Before replacing that document, saving copies its original bytes to a
unique sibling `.corrupt-<guid>.json`, uses `CreateNew` to protect existing copies,
denies concurrent source writes during copying, flushes the backup to disk and
verifies SHA256 equality. A failed preservation leaves the original intact and
keeps recovery state for a later save retry. The same shared procedure protects
the private layout document's viewport and additional metadata. Null node/edge
entries are refused through the ordinary recoverable-load path, so they cannot
bypass the backup marker through a null-reference exception.

Regression evidence: the real `GraphPersistence.SaveCurrentAsync` close-save
tests initially failed because no backups existed. They now preserve malformed
graph and layout files byte for byte, including BOM, CRLF and an invalid byte.
Two tests deny backup reads, prove that the originals survive failed saving,
and successfully retry. Repeated saves do not create duplicate backups or
replace earlier ones. Four invalid-document cases cover null DTOs, collections
and entries and verify recovery state follows an alias key's destination file.

### Medium: Installing while a task can still mutate state — fixed

Location: `electron/renderer/src/lib/aqvenor/project-files.ts`,
`electron/renderer/src/lib/aqvenor/agent-live.ts`,
`electron/renderer/src/lib/aqvenor/backend.ts`,
`src/AIClient.Server/RunRegistry.cs`,
`src/AIClient.Server/Endpoints/RunEndpoints.cs`.
Category: Concurrency / data integrity. CWE-362.

Freezing mouse and keyboard input does not stop an existing SSE generation or
server tool. Restart approval now checks active sessions and agent preparation,
execution, final refresh and cancellation both before and after flushing.
Queued/delayed sends are blocked before consuming the draft or invoking the
backend. Cancellation now signals the run and waits for the handler's completion
task before returning `cancelled=true, completed=true`; after fifteen seconds,
an unfinished run returns a conflict with `stopping=true`. The renderer validates
the completion response, retains failed cancellation markers and retries those
requests before approving an update. A disconnected cancellation request cannot
be mistaken for confirmed server cleanup. Workspace switching also refuses the
update handshake while its writes remain in progress.

Regression evidence: five server tests cover delayed cleanup, timeout/retry,
an already completed run, cancellation after token disposal and caller abort.
Frontend coverage checks preparation/final-refresh races, pending cancellation,
failed retry blocking and successful retry approval without consuming drafts.

### Low: Asynchronous NSIS launch failure could leave installation latched — fixed

Location: `electron/main/updater.js`, `createNativeUpdater`.
Category: Error handling. CWE-703.

The library's default launcher could quit before an asynchronous spawn failure
settled and leave its install flag set. The native subclass awaits actual spawn,
preserves Windows elevation/open-path fallbacks, restores retry state on error,
and confirms the save handshake before quitting. Native and preload input remain
frozen from save preparation through installer launch. Installing on ordinary
application exit is disabled, so no alternate quit hook bypasses saving.

### Low: Release assets could disagree with their manifest or tag — fixed

Location: `.github/workflows/release.yml`, `scripts/collect-release-assets.cjs`.
Category: Release integrity. CWE-345.

The workflow checks the version/tag and source SHA, refuses an existing release,
packages Windows x64, collects only a safe manifest-named installer after size
and SHA512 verification, requires its blockmap and publishes matching channel
and compatibility metadata. It uploads a draft, verifies all remote asset names,
rechecks the tag and only then publishes. Existing release assets are never
replaced. The collector refuses an existing output directory and writes the
source identity and SHA256 sums for the exact collected files.

## Verification evidence

- .NET graph/workspace filter: **136 passed**, including **8 new recovery tests**.
  Uses the repository's .NET 10 toolchain at `.tools/dotnet/dotnet.exe`.
- Server cancellation filter: **5 passed**, including the real fifteen-second
  stopping timeout and subsequent successful retry.
- Electron updater/UI/run-safety/backend filter: **33 passed** across 4 files; earlier
  independent graph-coordinator/graph-sync/updater/UI checks also passed.
- Release collector tests: **7 passed**, including mismatched version, corrupt
  installer, missing blockmap, path escape, inconsistent legacy metadata and
  existing output refusal. Real local installer collection also succeeded.
- `actionlint 1.7.12` accepted the release workflow; `git diff --check` passed.
- Production `npm audit --omit=dev --json --registry=https://registry.npmjs.org`:
  **0 reported vulnerabilities**. The configured mirror did not provide an audit
  endpoint; the official registry was used without changing repository settings.
- The PowerShell 7 smoke fix now reads non-2xx bodies via `SkipHttpErrorCheck`,
  avoiding disposed exception-response content. PowerShell 5.1 keeps its existing
  exception-response path. The release owner runs the updated sidecar smoke.

## Practical limits

Current installers are unsigned. A compromised GitHub publishing credential can
publish both malicious metadata and an installer with matching hashes. Add
Authenticode signing once project signing credentials are available.

Processes running as the same Windows account can access the profile, update
cache and application files. This change does not establish isolation against a
malicious process with that account's access. Existing application key storage
and workspace execution permissions remain their own trust boundaries.

The corruption fix protects both the private node/edge JSON document and the
private viewport/metadata layout. Unreadable portable workspace documents remain
untouched and are reported by the existing portable persistence error path.

All confirmed findings in this scoped implementation review are resolved. Final
source commit verification, complete release checks and packaged Electron
acceptance remain the release owner's publication prerequisites.
