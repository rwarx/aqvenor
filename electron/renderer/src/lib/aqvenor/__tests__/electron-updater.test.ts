import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createUpdater, createNativeUpdater, registerUpdaterIpc } = require("../../../../../main/updater.js");

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  allowDowngrade = true;
  requestHeaders: Record<string, string> | null = null;
  setFeedURL = vi.fn();
  quitAndInstall = vi.fn();
  checkForUpdates = vi.fn(async (): Promise<{ downloadPromise?: Promise<unknown> }> => {
    this.emit("checking-for-update");
    this.emit("update-not-available");
    return {};
  });
}

function fixture(packaged = true, version = "0.3.2-alpha", platform = "win32") {
  const updater = new FakeUpdater();
  const timers: { callback: () => void; delay: number }[] = [];
  const notify = vi.fn();
  const requestClose = vi.fn(() => true);
  const onInstallFailure = vi.fn();
  const loadUpdater = vi.fn(() => updater);
  const controller = createUpdater({
    app: { isPackaged: packaged, getVersion: () => version }, platform,
    notify, requestClose, onInstallFailure, loadUpdater,
    setTimer: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return { unref() {} }; },
    clearTimer: vi.fn(),
  });
  return { controller, updater, timers, notify, requestClose, onInstallFailure, loadUpdater };
}

describe("GitHub Releases updater lifecycle", () => {
  it("never loads updater or schedules network checks in development or unsupported packages", async () => {
    for (const env of [fixture(false), fixture(true, "0.3.2", "darwin")]) {
      env.controller.start();
      expect((await env.controller.check()).status).toBe("disabled");
      env.controller.requestInstall();
      expect(env.loadUpdater).not.toHaveBeenCalled();
      expect(env.timers).toHaveLength(0);
      expect(env.requestClose).not.toHaveBeenCalled();
    }
  });

  it("pins the GitHub repository, accepts alpha updates and disables every implicit install", async () => {
    const { controller, updater, timers } = fixture();
    controller.start();
    controller.start();
    expect(timers.map((timer) => timer.delay)).toEqual([10_000]);
    await controller.check();
    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: "github", owner: "rwarx", repo: "aqvenor" });
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(timers.at(-1)?.delay).toBe(6 * 60 * 60_000);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    const stable = fixture(true, "1.0.0");
    await stable.controller.check();
    expect(stable.updater.allowPrerelease).toBe(false);
    expect(stable.controller.getState().channel).toBe("stable");
  });

  it("serializes checks and observes the independent download failure without quitting", async () => {
    const { controller, updater, timers } = fixture();
    let rejectDownload!: (error: Error) => void;
    const downloadPromise = new Promise((_, reject) => { rejectDownload = reject; });
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("update-available", { version: "0.3.3-alpha" });
      updater.emit("download-progress", { percent: 250 });
      return { downloadPromise };
    });
    await Promise.all([controller.check(), controller.check()]);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ status: "downloading", percent: 100, version: "0.3.3-alpha" });
    await controller.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    rejectDownload(new Error("checksum mismatch"));
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ status: "error", error: "download" });
    expect(timers.at(-1)?.delay).toBe(15 * 60_000);
    await controller.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(controller.getState().status).toBe("idle");
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  // The first real library import takes longer when the full suite runs in parallel.
  it("overrides the persistent staging ID in the real library's metadata and download request headers", async () => {
    const { controller, updater } = fixture();
    await controller.check();
    const { AppUpdater } = require("electron-updater/out/AppUpdater.js");
    const provider = { setRequestHeaders: vi.fn(), getLatestVersion: vi.fn(async () => ({ version: "0.3.3-alpha" })), fileExtraDownloadHeaders: { accept: "application/octet-stream" } };
    const client = {
      app: { whenReady: async () => {} }, clientPromise: Promise.resolve(provider),
      stagingUserIdPromise: { value: Promise.resolve("private-installation-uuid") },
      requestHeaders: updater.requestHeaders,
      computeFinalHeaders: AppUpdater.prototype.computeFinalHeaders,
    };
    await AppUpdater.prototype.getUpdateInfoAndProvider.call(client);
    expect(provider.setRequestHeaders).toHaveBeenCalledWith({ "x-user-staging-id": "" });
    expect(JSON.stringify(provider.setRequestHeaders.mock.calls)).not.toContain("private-installation-uuid");
    expect(AppUpdater.prototype.computeRequestHeaders.call(client, provider)).toEqual({ accept: "application/octet-stream", "x-user-staging-id": "" });
  }, 30_000);

  it.each([
    { current: "0.3.2-alpha", allowPrerelease: true, tags: ["0.3.3-alpha", "0.3.2-alpha"], selected: "0.3.3-alpha", channel: "alpha" },
    { current: "0.3.2-alpha", allowPrerelease: true, tags: ["1.0.0", "0.3.3-alpha"], selected: "1.0.0", channel: "latest" },
    { current: "1.0.0", allowPrerelease: false, tags: ["1.1.0-alpha", "1.0.1"], selected: "1.0.1", channel: "latest" },
  ])("uses real GitHub provider $channel.yml for $current and preserves installer basenames", async ({ current, allowPrerelease, tags, selected, channel }) => {
    const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider.js");
    const { SemVer } = require("semver");
    const executor = { request: vi.fn(async (options: { path: string }) => {
      if (options.path.endsWith(".atom")) return `<feed>${tags.map((tag) => `<entry><link href="https://github.com/rwarx/aqvenor/releases/tag/v${tag}"/><title>${tag}</title><content>Release notes</content></entry>`).join("")}</feed>`;
      if (options.path.endsWith("/latest")) return JSON.stringify({ tag_name: `v${selected}` });
      expect(options.path).toBe(`/rwarx/aqvenor/releases/download/v${selected}/${channel}.yml`);
      return `version: ${selected}\nfiles:\n  - url: Aqvenor-Setup-${selected}.exe\n    sha512: test-checksum\nreleaseName: Aqvenor\nreleaseNotes: test\n`;
    }) };
    const provider = new GitHubProvider({ provider: "github", owner: "rwarx", repo: "aqvenor" }, {
      allowPrerelease, channel: null, currentVersion: new SemVer(current),
    }, { executor, platform: "win32" });
    const info = await provider.getLatestVersion();
    expect(info.version).toBe(selected);
    expect(provider.resolveFiles(info)[0].url.href).toBe(`https://github.com/rwarx/aqvenor/releases/download/v${selected}/Aqvenor-Setup-${selected}.exe`);
  });

  it("keeps downloaded updates across checks and requests the close handshake before installation", async () => {
    const { controller, updater, requestClose } = fixture();
    await controller.check();
    updater.emit("update-downloaded", { version: "0.3.3-alpha", downloadedFile: "private-installer-path" });
    expect(controller.getState()).toMatchObject({ status: "downloaded", percent: 100, version: "0.3.3-alpha" });
    expect(controller.getState()).not.toHaveProperty("downloadedFile");
    await controller.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    controller.requestInstall();
    controller.requestInstall();
    expect(requestClose).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    controller.cancelInstall();
    expect(controller.getState()).toMatchObject({ status: "downloaded", error: "save" });
    expect(await controller.installAfterClose()).toBe(false);
    controller.requestInstall();
    expect(await controller.installAfterClose()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("recovers from failed save, rejected close and synchronous installer errors", async () => {
    const { controller, updater, requestClose, onInstallFailure } = fixture();
    await controller.check();
    updater.emit("update-downloaded", { version: "0.3.3-alpha" });
    requestClose.mockReturnValueOnce(false);
    controller.requestInstall();
    expect(controller.getState()).toMatchObject({ status: "downloaded", error: "save" });
    controller.requestInstall();
    updater.quitAndInstall.mockImplementationOnce(() => { updater.emit("error", new Error("installer missing")); });
    expect(await controller.installAfterClose()).toBe(false);
    expect(controller.getState()).toMatchObject({ status: "downloaded", error: "install" });
    expect(onInstallFailure).toHaveBeenCalledOnce();
    controller.requestInstall();
    expect(await controller.installAfterClose()).toBe(true);
  });

  it("waits for a real NSIS launch and clears its installation latch after asynchronous failure before retry", async () => {
    const appAdapter = {
      version: "0.3.2-alpha", name: "Aqvenor", isPackaged: true,
      appUpdateConfigPath: "unused", userDataPath: "unused", baseCachePath: "unused",
      whenReady: async () => {}, relaunch: vi.fn(), quit: vi.fn(), onQuit: vi.fn(),
    };
    const emitQuit = vi.fn();
    const native = createNativeUpdater({ appAdapter, emitQuit });
    native.logger = null;
    native.downloadedUpdateHelper = { file: "Aqvenor-Setup-0.3.3-alpha.exe", downloadedFileInfo: { isAdminRightsRequired: false } };
    vi.spyOn(native, "checkForUpdates").mockImplementation(async () => { native.emit("update-not-available"); return {}; });
    const spawn = vi.spyOn(native, "spawnLog").mockRejectedValueOnce(Object.assign(new Error("launch denied"), { code: "EPERM" }));
    let resolveLaunch!: (launched: boolean) => void;
    spawn.mockReturnValueOnce(new Promise<boolean>((resolve) => { resolveLaunch = resolve; }));
    const onInstallFailure = vi.fn();
    const controller = createUpdater({
      app: { isPackaged: true, getVersion: () => "0.3.2-alpha" }, platform: "win32",
      notify: vi.fn(), requestClose: () => true, onInstallFailure,
      loadUpdater: () => native, setTimer: () => ({ unref() {} }), clearTimer: vi.fn(),
    });
    await controller.check();
    native.emit("update-downloaded", { version: "0.3.3-alpha" });
    controller.requestInstall();
    expect(await controller.installAfterClose()).toBe(false);
    expect(controller.getState()).toMatchObject({ status: "downloaded", error: "install" });
    expect(native.quitAndInstallCalled).toBe(false);
    expect(onInstallFailure).toHaveBeenCalledOnce();
    expect(appAdapter.quit).not.toHaveBeenCalled();
    expect(emitQuit).not.toHaveBeenCalled();
    controller.requestInstall();
    const retriedInstall = controller.installAfterClose();
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(appAdapter.quit).not.toHaveBeenCalled();
    resolveLaunch(true);
    expect(await retriedInstall).toBe(true);
    expect(spawn.mock.calls[1]).toEqual(["Aqvenor-Setup-0.3.3-alpha.exe", ["--updated", "--force-run"]]);
    expect(emitQuit).toHaveBeenCalledOnce();
    expect(appAdapter.quit).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("does not retain listeners or schedule another check after disposal", async () => {
    const { controller, updater, timers, notify } = fixture();
    await controller.check();
    controller.dispose();
    const count = timers.length;
    updater.emit("update-downloaded", { version: "9.0.0" });
    await controller.check();
    expect(timers).toHaveLength(count);
    expect(updater.listenerCount("update-downloaded")).toBe(0);
    expect(notify.mock.calls.at(-1)?.[0].status).toBe("idle");
  });
});

async function shellFixture(useNative = false) {
  let updater = new FakeUpdater();
  let nativeSpawn: ReturnType<typeof vi.fn> | undefined;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, getVersion: () => "0.3.2-alpha", setAppUserModelId: vi.fn(),
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit: vi.fn(),
  });
  let win!: FakeWindow;
  class FakeWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: pathToFileURL(resolve("dist/renderer/index.html")).href },
      send: vi.fn(), setWindowOpenHandler: vi.fn(),
    });
    destroyed = false;
    enabled = true;
    setEnabled = vi.fn((enabled: boolean) => { this.enabled = enabled; });
    loadFile = vi.fn(async () => {});
    isDestroyed = () => this.destroyed;
    close = vi.fn(() => {
      let prevented = false;
      this.emit("close", { preventDefault: () => { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.emit("closed"); }
    });
    static getFocusedWindow = () => win;
    static getAllWindows = () => win && !win.destroyed ? [win] : [];
    constructor() { super(); win = this; }
  }
  const mainDir = resolve("main");
  runInNewContext(readFileSync(resolve(mainDir, "main.js"), "utf8"), {
    __dirname: mainDir, process: { platform: "win32", env: {}, resourcesPath: "scratch" },
    URL, Buffer, setTimeout, clearTimeout, console: { log: vi.fn(), error: vi.fn() },
    require: (name: string) => {
      if (name === "electron") return {
        app, BrowserWindow: FakeWindow, ipcMain: { handle: (channel: string, listener: (...args: unknown[]) => unknown) => handlers.set(channel, listener) },
        dialog: {}, shell: {}, Menu: { buildFromTemplate: () => ({}), setApplicationMenu: vi.fn() },
        session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onHeadersReceived: vi.fn() } } },
      };
      if (name === "./updater") return {
        registerUpdaterIpc,
        createUpdater: (options: object) => createUpdater({ ...options, platform: "win32", loadUpdater: (beforeQuit: () => Promise<boolean>) => {
          if (!useNative) return updater;
          const native = createNativeUpdater({ beforeQuit, emitQuit: vi.fn(), appAdapter: {
            version: "0.3.2-alpha", name: "Aqvenor", isPackaged: true,
            appUpdateConfigPath: "unused", userDataPath: "unused", baseCachePath: "unused",
            whenReady: async () => {}, relaunch: vi.fn(), onQuit: vi.fn(), quit: () => app.quit(),
          } });
          native.logger = null;
          native.downloadedUpdateHelper = { file: "Aqvenor-Setup-0.3.3-alpha.exe", downloadedFileInfo: { isAdminRightsRequired: false } };
          vi.spyOn(native, "checkForUpdates").mockImplementation(async () => { native.emit("update-not-available"); return {}; });
          nativeSpawn = vi.spyOn(native, "spawnLog").mockResolvedValue(true);
          updater = native;
          return updater;
        }, setTimer: () => ({ unref() {} }), clearTimer: vi.fn() }),
      };
      if (name === "./mcp") return { registerMcpIpc: vi.fn() };
      if (name === "node:fs") return { existsSync: () => false };
      return name.startsWith("./") ? require(resolve(mainDir, name)) : require(name);
    },
  });
  await Promise.resolve();
  app.quit.mockImplementation(() => win.close());
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  await invoke("aqvenor:updateCheck");
  updater.emit("update-downloaded", { version: "0.3.3-alpha" });
  const lastRequest = () => win.webContents.send.mock.calls.filter(([channel]) => channel === "aqvenor:prepareClose").at(-1)![1];
  return { updater, win, event, handlers, invoke, lastRequest, nativeSpawn, app };
}

describe("update IPC and save-before-restart integration", () => {
  it("requires an exact request from the trusted main renderer and a successful save", async () => {
    const { updater, win, event, handlers, invoke, lastRequest } = await shellFixture();
    await expect(Promise.resolve().then(() => handlers.get("aqvenor:updateInstall")!({ ...event, sender: {} }))).rejects.toThrow();
    await invoke("aqvenor:updateInstall");
    const failedRequest = lastRequest();
    expect(win.webContents.send).toHaveBeenCalledWith("aqvenor:prepareClose", failedRequest, true);
    await invoke("aqvenor:finishClose", "forged-request", true);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await invoke("aqvenor:finishClose", failedRequest, false);
    expect(await invoke("aqvenor:updateState")).toMatchObject({ status: "downloaded", error: "save" });
    expect(win.destroyed).toBe(false);
    await invoke("aqvenor:updateInstall");
    expect(lastRequest()).not.toBe(failedRequest);
    await invoke("aqvenor:finishClose", failedRequest, true);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await invoke("aqvenor:finishClose", lastRequest(), true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    await invoke("aqvenor:finishClose", lastRequest(), true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does not let an already pending ordinary close authorize an update installation", async () => {
    const { updater, win, invoke, lastRequest } = await shellFixture();
    win.close();
    const normalClose = lastRequest();
    expect(win.webContents.send).toHaveBeenCalledWith("aqvenor:prepareClose", normalClose, false);
    await invoke("aqvenor:updateInstall");
    expect(await invoke("aqvenor:updateState")).toMatchObject({ status: "downloaded", error: "save" });
    await invoke("aqvenor:finishClose", normalClose, true);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(win.destroyed).toBe(true);
  });

  it("requires another flush when the installer fails and the person later closes the window", async () => {
    const { updater, win, invoke, lastRequest } = await shellFixture();
    updater.quitAndInstall.mockImplementationOnce(() => { updater.emit("error", new Error("installer cannot launch")); });
    await invoke("aqvenor:updateInstall");
    const installRequest = lastRequest();
    await invoke("aqvenor:finishClose", installRequest, true);
    expect(await invoke("aqvenor:updateState")).toMatchObject({ status: "downloaded", error: "install" });
    win.close();
    expect(win.destroyed).toBe(false);
    expect(lastRequest()).not.toBe(installRequest);
    await invoke("aqvenor:finishClose", lastRequest(), false);
    expect(win.destroyed).toBe(false);
  });

  it("does not install after the renderer crashes during its save handshake", async () => {
    const { updater, win, invoke } = await shellFixture();
    await invoke("aqvenor:updateInstall");
    win.webContents.emit("render-process-gone");
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(win.destroyed).toBe(true);
  });

  it("freezes the window before saving and keeps manual close blocked until a pending launch fails", async () => {
    const { win, invoke, lastRequest, nativeSpawn, app } = await shellFixture(true);
    let rejectLaunch!: (error: Error) => void;
    nativeSpawn!.mockReturnValueOnce(new Promise((_, reject) => { rejectLaunch = reject; }));
    await invoke("aqvenor:updateInstall");
    expect(win.enabled).toBe(false);
    const initialRequest = lastRequest();
    const installing = invoke("aqvenor:finishClose", initialRequest, true);
    await Promise.resolve();
    win.close();
    expect(win.destroyed).toBe(false);
    expect(lastRequest()).toBe(initialRequest);
    rejectLaunch(Object.assign(new Error("launch denied"), { code: "EPERM" }));
    await installing;
    expect(app.quit).not.toHaveBeenCalled();
    expect(win.destroyed).toBe(false);
    expect(win.enabled).toBe(true);
    win.close();
    expect(lastRequest()).not.toBe(initialRequest);
    await invoke("aqvenor:finishClose", lastRequest(), false);
    expect(win.destroyed).toBe(false);
    expect(await invoke("aqvenor:updateState")).toMatchObject({ status: "downloaded", error: "install" });
  });

  it.each([true, false])("starts the real NSIS adapter only after the frozen window reports saved=%s", async (saved) => {
    const { win, invoke, lastRequest, app, nativeSpawn } = await shellFixture(true);
    await invoke("aqvenor:updateInstall");
    expect(win.enabled).toBe(false);
    const initialRequest = lastRequest();
    await invoke("aqvenor:finishClose", "stale-request", true);
    expect(app.quit).not.toHaveBeenCalled();
    expect(nativeSpawn).not.toHaveBeenCalled();
    await invoke("aqvenor:finishClose", initialRequest, saved);
    expect(nativeSpawn).toHaveBeenCalledTimes(saved ? 1 : 0);
    expect(app.quit).toHaveBeenCalledTimes(saved ? 1 : 0);
    expect(win.destroyed).toBe(saved);
    expect(lastRequest()).toBe(initialRequest);
    if (!saved) expect(win.enabled).toBe(true);
    if (!saved) expect(await invoke("aqvenor:updateState")).toMatchObject({ status: "downloaded", error: "save" });
  });

  it("blocks queued renderer input and restores it on save/launch failure in preload", () => {
    const ipcListeners = new Map<string, (...args: unknown[]) => void>();
    const inputListeners = new Map<string, (...args: unknown[]) => void>();
    const body = { inert: false };
    runInNewContext(readFileSync(resolve("preload/preload.js"), "utf8"), {
      document: { body }, window: { addEventListener: (type: string, listener: (...args: unknown[]) => void, capture: boolean) => { expect(capture).toBe(true); inputListeners.set(type, listener); } },
      require: () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { on: (channel: string, listener: (...args: unknown[]) => void) => ipcListeners.set(channel, listener) } }),
    });
    const input = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    ipcListeners.get("aqvenor:updateChanged")!({}, { status: "installing" });
    expect(body.inert).toBe(true);
    for (const listener of inputListeners.values()) listener(input);
    expect(input.preventDefault).toHaveBeenCalledTimes(inputListeners.size);
    expect(input.stopImmediatePropagation).toHaveBeenCalledTimes(inputListeners.size);
    ipcListeners.get("aqvenor:updateChanged")!({}, { status: "downloaded", error: "save" });
    expect(body.inert).toBe(false);
    inputListeners.get("keydown")!(input);
    expect(input.preventDefault).toHaveBeenCalledTimes(inputListeners.size);
  });

  it("exposes fixed update methods and removes only its own status listener in preload", async () => {
    const invoke = vi.fn();
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let bridge!: { updates: { getState: () => unknown; check: () => unknown; install: () => unknown; onChanged: (cb: (...args: unknown[]) => void) => () => void } };
    runInNewContext(readFileSync(resolve("preload/preload.js"), "utf8"), {
      require: () => ({
        contextBridge: { exposeInMainWorld: (_: string, api: typeof bridge) => { bridge = api; } },
        ipcRenderer: {
          invoke,
          on: (channel: string, listener: (...args: unknown[]) => void) => { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(listener); },
          removeListener: (channel: string, listener: (...args: unknown[]) => void) => listeners.get(channel)?.delete(listener),
        },
      }),
    });
    bridge.updates.getState(); bridge.updates.check(); bridge.updates.install();
    expect(invoke.mock.calls).toEqual([["aqvenor:updateState"], ["aqvenor:updateCheck"], ["aqvenor:updateInstall"]]);
    const first = vi.fn(); const second = vi.fn();
    const unsub = bridge.updates.onChanged(first); bridge.updates.onChanged(second);
    unsub();
    const state = { status: "downloaded" };
    for (const listener of listeners.get("aqvenor:updateChanged")!) listener({ sender: "must not cross bridge" }, state);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(state);
  });
});
