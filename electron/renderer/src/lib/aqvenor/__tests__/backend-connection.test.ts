// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  delete window.aqvenor;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.aqvenor;
});

function desktopBridge() {
  Object.defineProperty(window, "aqvenor", {
    configurable: true,
    value: {
      getBackendUrl: vi.fn().mockResolvedValue("http://127.0.0.1:45631"),
      getBackendAuth: vi.fn().mockResolvedValue("launch-token"),
    },
  });
}

describe("sidecar exit IPC bridge", () => {
  it("forwards only the exit code and removes the exact listener on unsubscribe", () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const removeListener = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener);
    });
    let bridge!: { onSidecarGone: (callback: (code: number | null) => void) => () => void };
    runInNewContext(readFileSync(resolve("preload/preload.js"), "utf8"), {
      require: (name: string) => {
        if (name !== "electron") throw new Error(`Unexpected preload dependency: ${name}`);
        return {
          contextBridge: { exposeInMainWorld: (name: string, api: typeof bridge) => { expect(name).toBe("aqvenor"); bridge = api; } },
          ipcRenderer: {
            invoke: vi.fn(),
            on: (channel: string, listener: (...args: unknown[]) => void) => {
              if (!listeners.has(channel)) listeners.set(channel, new Set());
              listeners.get(channel)!.add(listener);
            },
            removeListener,
          },
        };
      },
    });
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = bridge.onSidecarGone(first);
    bridge.onSidecarGone(second);
    const listener = [...listeners.get("aqvenor:sidecarGone")!][0];
    const emit = (code: number | null) => {
      for (const callback of listeners.get("aqvenor:sidecarGone") ?? []) callback({ sender: "privileged IPC event" }, code);
    };

    emit(17);
    expect(first).toHaveBeenCalledExactlyOnceWith(17);
    expect(second).toHaveBeenCalledExactlyOnceWith(17);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledExactlyOnceWith("aqvenor:sidecarGone", listener);
    emit(null);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenLastCalledWith(null);
    expect(listeners.get("aqvenor:sidecarGone")?.size).toBe(1);
  });
});

describe("backend connection probes", () => {
  it("immediately reflects a sidecar exit in both availability sources", async () => {
    const backend = await import("../backend");
    const { useAqvenor } = await import("../store");
    useAqvenor.getState().setBackendReachable(true);

    backend.markBackendUnavailable();
    expect(backend.isBackendKnownAvailable()).toBe(false);
    expect(useAqvenor.getState().backendReachable).toBe(false);
  });

  it("shares an in-flight health/auth probe, then allows a fresh check", async () => {
    desktopBridge();
    let answer!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; })).mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const backend = await import("../backend");
    const { useAqvenor } = await import("../store");

    const first = backend.checkBackend();
    const second = backend.checkBackend();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    answer({ ok: true } as Response);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useAqvenor.getState().backendReachable).toBe(true);
    expect(await backend.checkBackend()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps an exit authoritative when a successful health response was already in flight", async () => {
    desktopBridge();
    let answer!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; })).mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const backend = await import("../backend");
    const { useAqvenor } = await import("../store");
    const pending = backend.checkBackend();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    backend.markBackendUnavailable();
    answer({ ok: true } as Response);
    expect(await pending).toBe(false);
    expect(backend.isBackendKnownAvailable()).toBe(false);
    expect(useAqvenor.getState().backendReachable).toBe(false);
    // A later, independently requested probe may discover a recovered sidecar.
    expect(await backend.checkBackend()).toBe(true);
    expect(useAqvenor.getState().backendReachable).toBe(true);
  });

  it("requires the desktop launch token to be accepted even when anonymous health returns 200", async () => {
    desktopBridge();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 }).mockResolvedValueOnce({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    const backend = await import("../backend");
    const { useAqvenor } = await import("../store");

    expect(await backend.checkBackend()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:45631/api/workspace");
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer launch-token" });
    expect(backend.isBackendKnownAvailable()).toBe(false);
    expect(useAqvenor.getState().backendReachable).toBe(false);
  });

  it("uses anonymous health for an externally hosted browser backend", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const backend = await import("../backend");

    expect(await backend.checkBackend()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:45631/api/health");
  });
});
