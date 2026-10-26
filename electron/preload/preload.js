"use strict";

/* Aqvenor — preload bridge (context-isolated). */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aqvenor", {
  getBackendUrl: () => ipcRenderer.invoke("aqvenor:getBackendUrl"),

  /* The sidecar's per-launch bearer token. It is fetched, never bundled, and the renderer only ever
     attaches it as an Authorization header. */
  getBackendAuth: () => ipcRenderer.invoke("aqvenor:getBackendAuth"),
  pickFolder: () => ipcRenderer.invoke("aqvenor:pickFolder"),
  saveDialog: (defaultName, filters) => ipcRenderer.invoke("aqvenor:saveDialog", defaultName, filters),
  openDialog: (filters) => ipcRenderer.invoke("aqvenor:openDialog", filters),
  showInFolder: (fullPath) => ipcRenderer.invoke("aqvenor:showInFolder", fullPath),
  readFileLocal: (fullPath) => ipcRenderer.invoke("aqvenor:readFileLocal", fullPath),
  openExternal: (url) => ipcRenderer.invoke("aqvenor:openExternal", url),
  /* MCP: one request to a built-in server ({builtin:"memory"|"thinking"|"computer"})
     or a remote Streamable-HTTP endpoint ({url}). Runs in the main process —
     remote MCP never widens the page's connect-src. */
  mcp: (target, method, params) => ipcRenderer.invoke("aqvenor:mcp", target, method, params),
  win: {
    minimize: () => ipcRenderer.invoke("aqvenor:winMinimize"),
    maximizeToggle: () => ipcRenderer.invoke("aqvenor:winMaximizeToggle"),
    close: () => ipcRenderer.invoke("aqvenor:winClose"),
    isMaximized: () => ipcRenderer.invoke("aqvenor:winIsMaximized"),
    onMaximizedChanged: (cb) => {
      const listener = (_evt, maximized) => cb(Boolean(maximized));
      ipcRenderer.on("aqvenor:winMaximizedChanged", listener);
      return () => ipcRenderer.removeListener("aqvenor:winMaximizedChanged", listener);
    },
  },
  view: {
    setZoom: (factor) => ipcRenderer.invoke("aqvenor:setZoom", factor),
  },
});
