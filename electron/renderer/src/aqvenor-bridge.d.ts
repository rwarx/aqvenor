/// <reference types="vite/client" />

interface AqvenorBridge {
  onPrepareClose: (cb: (request: string, forUpdate?: boolean) => void) => () => void;
  finishClose: (request: string, saved: boolean) => Promise<void>;
  /** GitHub Releases updates; installation first flushes pending project writes. */
  updates?: {
    getState: () => Promise<import("./lib/aqvenor/updates").UpdateState>;
    check: () => Promise<import("./lib/aqvenor/updates").UpdateState>;
    install: () => Promise<import("./lib/aqvenor/updates").UpdateState>;
    onChanged: (cb: (state: import("./lib/aqvenor/updates").UpdateState) => void) => () => void;
  };
  mcpConfigure: (servers: import("./lib/aqvenor/types").McpServerConfig[]) => Promise<void>;
  getBackendUrl: () => Promise<string>;
  /**
   * The sidecar's per-launch bearer token. Generated in the main process, handed to the sidecar over
   * an environment variable and fetched here on demand — never bundled, never persisted. Every route
   * except `/api/health` returns 401 without it.
   */
  getBackendAuth: () => Promise<string>;
  /** Reports an unexpected local-server exit; returns an unsubscribe function. */
  onSidecarGone?: (cb: (code: number | null) => void) => () => void;
  pickFolder: () => Promise<string | null>;
  saveDialog: (defaultName: string, filters: { name: string; extensions: string[] }[]) => Promise<string | null>;
  openDialog: (filters: { name: string; extensions: string[] }[]) => Promise<string[]>;
  showInFolder: (fullPath: string) => Promise<void>;
  readFileLocal: (fullPath: string) => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  /** MCP bridge: one request to a built-in server ({builtin}) or a remote
   *  Streamable-HTTP endpoint ({url}). Absent in the plain browser build. */
  mcp?: (
    target: { id: string },
    method: "probe" | "tools/list" | "tools/call",
    params?: Record<string, unknown>,
  ) => Promise<{ tools?: { name: string; description: string }[] } & Record<string, unknown>>;
  /** Window-chrome controls for the frameless shell. Absent in the plain browser build. */
  win?: {
    minimize: () => Promise<void>;
    maximizeToggle: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    /** Subscribe to maximize/unmaximize; returns an unsubscribe fn. */
    onMaximizedChanged: (cb: (maximized: boolean) => void) => () => void;
  };
  /** Interface zoom (app scale) via webContents.setZoomFactor. Absent in the plain browser build. */
  view?: {
    /** Set the renderer zoom factor (1 = 100%); returns the applied, clamped factor. */
    setZoom: (factor: number) => Promise<number>;
  };
}

declare global {
  interface Window {
    aqvenor?: AqvenorBridge;
  }
}

export {};
