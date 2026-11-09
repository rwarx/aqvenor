# Desktop host capabilities

Updated 2026-11-09. Both hosts are Windows desktop applications built by CI.
The shared Application/Infrastructure services own provider calls, conversations,
workspace access, agent approval contracts and graph mutations.

| Capability | WPF (`AIClient.App`) | Electron (`electron/` + sidecar) |
| --- | --- | --- |
| Chat, provider configuration and streaming | Shared core, WPF views | Shared core over authenticated HTTP/NDJSON |
| Workspace file access and agent tools | Shared core in process | Shared core through sidecar |
| Editable scenarios | No matching scenario editor | Seven editable tasks, model selection and real capability state |
| Task delegation | Shared core; no matching child-run controller | Real child conversations, progress and parent-controlled cancellation |
| CMD and PowerShell | Shared tool; no matching shell permission control | Explicit off-by-default permission, native confirmation and per-call script approval |
| Output-token limits | Shared run reason; no dedicated WPF banner | Partial text preserved and an unfinished-task explanation |
| Spatial graph | Retained DrawingVisual canvas | React/SVG canvas |
| Code editor | WPF code view | CodeMirror 6, tabs and inline completions |
| Git panel and portable session bundles | No matching panel/bundle workflow | Renderer panels and sidecar Git endpoints |
| MCP catalogue and local MCP memory | No Electron MCP bridge | Main-process registry, native trust approvals; memory search/save connected to runs |
| File checkpoints | No matching sidecar checkpoint UI | Server file snapshots bound to the workspace |
| Runtime distribution | Separate .NET desktop host | Installer embeds the sidecar's .NET runtime |

MCP catalogue presence does not mean every MCP tool is available in the .NET
agent loop. The current agent bridge explicitly connects memory search/save;
other integrations require an adapter to its tool and approval contracts.

Folder changes must wait for graph loading and must fail while the workspace is
pinned by an operation or run. Editor state and UI gestures belong to their host;
file and graph mutations belong to the core. Host-specific persistence keys are
not an interoperability format. Portable Electron canvas synchronization is
tracked separately in the project audit.

When adding a feature, document its host support here and test the shared-core
contract. Do not advertise a host feature based only on a method exposed by the
other host.
