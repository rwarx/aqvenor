"use strict";

/* Aqvenor — preload bridge (context-isolated). */

const { contextBridge, ipcRenderer } = require("electron");

// Freeze renderer input before the update's prepareClose callback flushes.
// Native setEnabled(false) prevents new OS input; inert/capture also stop
// renderer shortcuts and already queued input while an installer is starting.
let installingUpdate = false;
ipcRenderer.on("aqvenor:updateChanged", (_event, state) => {
  installingUpdate = state?.status === "installing";
  if (typeof document !== "undefined" && document.body) document.body.inert = installingUpdate;
});
if (typeof window !== "undefined") {
  for (const type of ["keydown", "keyup", "beforeinput", "input", "click", "pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "wheel", "drop", "dragover"]) {
    window.addEventListener(type, (event) => {
      if (!installingUpdate) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
}

contextBridge.exposeInMainWorld("aqvenor", {
  getBackendUrl: () => ipcRenderer.invoke("aqvenor:getBackendUrl"),

  /* The sidecar's per-launch bearer token. It is fetched, never bundled, and the renderer only ever
     attaches it as an Authorization header. */
  getBackendAuth: () => ipcRenderer.invoke("aqvenor:getBackendAuth"),
  onSidecarGone: (cb) => {
    const listener = (_event, code) => cb(code);
    ipcRenderer.on("aqvenor:sidecarGone", listener);
    return () => ipcRenderer.removeListener("aqvenor:sidecarGone", listener);
  },
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
  mcpConfigure: (servers) => ipcRenderer.invoke("aqvenor:mcpConfigure", servers),
  onPrepareClose: (cb) => {
    const listener = (_event, request, forUpdate) => cb(request, forUpdate === true);
    ipcRenderer.on("aqvenor:prepareClose", listener);
    return () => ipcRenderer.removeListener("aqvenor:prepareClose", listener);
  },
  finishClose: (request, saved) => ipcRenderer.invoke("aqvenor:finishClose", request, saved),
  updates: {
    getState: () => ipcRenderer.invoke("aqvenor:updateState"),
    check: () => ipcRenderer.invoke("aqvenor:updateCheck"),
    install: () => ipcRenderer.invoke("aqvenor:updateInstall"),
    onChanged: (cb) => {
      const listener = (_event, state) => cb(state);
      ipcRenderer.on("aqvenor:updateChanged", listener);
      return () => ipcRenderer.removeListener("aqvenor:updateChanged", listener);
    },
  },
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
