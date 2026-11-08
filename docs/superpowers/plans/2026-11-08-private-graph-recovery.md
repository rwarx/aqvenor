# Private graph recovery implementation plan

**Goal:** Preserve damaged private graph bytes before the next save replaces them.
**Architecture:** Resolve recovery state by destination filename in `JsonGraphStore`. Make a unique, verified sibling backup before writing the replacement; retain the state on failure so saving can be retried.
**Tech Stack:** C#/.NET 10, System.IO, SHA256, xUnit.
**Spec:** `docs/superpowers/specs/2026-11-08-private-graph-recovery-design.md`

### Task 1: Reproduce replacement and failure recovery

**Files:** `tests/AIClient.Tests/JsonGraphRecoveryTests.cs`

- [x] Add close-save coverage using malformed UTF8 bytes and an existing backup; assert `Assert.Equal(original, await File.ReadAllBytesAsync(backup, Token))`.
- [x] Deny backup reads with `new FileStream(source, FileMode.Open, FileAccess.ReadWrite, FileShare.Write | FileShare.Delete)` and assert that failure leaves the original intact and the next save can recover it.
- [x] Run `dotnet test --filter FullyQualifiedName~JsonGraphRecoveryTests --no-restore`; observe that the old close-save produces no backup.

### Task 2: Preserve and verify the source

**Files:** `src/AIClient.Infrastructure/Graph/JsonGraphStore.cs`

- [x] Track failed destination filenames in `ConcurrentDictionary<string, byte>`; clear them on successful or absent loads.
- [x] Call `PreserveUnreadableGraphAsync(target, cancellationToken)` before creating the replacement temporary file; use `FileMode.CreateNew` and compare `SHA256.HashDataAsync` results.
- [x] Remove only an incomplete backup created by this attempt; retain the marker and propagate failed preservation.
- [x] Run the recovery tests, then all graph store and graph persistence tests. Review that prior backup files are untouched and repeated saves create no extra backup.

### Task 3: Apply recovery to private layout and null entries

**Files:** `src/AIClient.Infrastructure/Graph/GraphRecoveryFiles.cs`, `src/AIClient.Server/GraphPersistence.cs`, `tests/AIClient.Tests/JsonGraphRecoveryTests.cs`

- [x] Add invalid DTO theory cases, observe `NullReferenceException` for null nodes/edges, then return null from `FromDto` to trigger recovery preservation.
- [x] Add close-save and denied-backup-read layout tests; observe that no recovery copy exists before the fix.
- [x] Extract `GraphRecoveryFiles.CreateAsync(target, logger, ct)` and use it for both private documents.
- [x] Run all graph/workspace tests after the extraction and review that layout markers remain on failed backup: 136 passed, including 8 recovery cases.

### Task 4: Release handoff

**Files:** `qa-audit/SECURITY-RELEASE-2026-11-08.md`

- [x] Record the confirmed findings, resolved behavior, test evidence, and updater trust boundaries in the release security review.
- [x] Ask the parent to rebuild the sidecar before release packaging. Commit and publish are owned by the parent.
