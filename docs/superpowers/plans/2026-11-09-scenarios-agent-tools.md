# Scenarios and agent tools

**Goal:** Make scenarios editable, launch real agent work, and support bounded delegation and Windows shell commands.

**Architecture:** Scenarios reuse the existing chat pipeline and its draft/workspace/run guards. Delegation creates a separate child conversation with the same model, workspace and approval policy. Shell execution uses the existing process runner; the desktop host controls permission changes through a private authenticated endpoint.

**Stack:** React, Zustand, Electron, .NET 10.

1. Reproduce launch guards and inaccurate live capability claims with renderer regressions. Replace demo skills and recipe cards with selection, editable brief, actual model/workspace/tools and recent runs.
2. Implement delegate_task with child conversation links, step/task limits, inherited cancellation and terminal status. Test real transcript ownership and canonical reload.
3. Implement run_shell for CMD and PowerShell with bounded output, working directory checks, timeout and cancellation. Keep direct executable execution available separately.
4. Add desktop permission controls with native confirmation, sender validation and a host credential unavailable to the renderer. Ordinary settings requests cannot enable shell execution.
5. Run renderer/backend checks, review the permission boundary, and inspect the scenario screen in both themes and narrow containers. Preserve existing uncommitted changes and the published release.
