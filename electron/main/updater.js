"use strict";

/* GitHub update traffic stays in the main process. The renderer receives a small
   status object, never a feed URL, installer path or an updater instance. */

/** @typedef {"disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "error"} UpdateStatus */
/** @typedef {"development" | "unsupported" | "initialization" | "check" | "download" | "install" | "save" | null} UpdateError */
/** @typedef {{ status: UpdateStatus, currentVersion: string, channel: string, version: string | null, percent: number | null, checkedAt: number | null, error: UpdateError }} UpdateState */

/**
 * NSIS's default quitAndInstall quits before spawnLog settles, and an async
 * failure leaves its installation flag latched. Use its supported subclass
 * hooks to wait for an actual launch, retaining Windows elevation fallbacks.
 * @param {{ appAdapter?: import("electron-updater/out/AppAdapter").AppAdapter, emitQuit?: () => void, beforeQuit?: () => Promise<boolean> }} [options]
 */
function createNativeUpdater(options = {}) {
  const { NsisUpdater } = require("electron-updater");
  class SavedWorkUpdater extends NsisUpdater {
    /** @type {Promise<boolean> | null} */
    launch = null;
    doInstall(installOptions) {
      const installer = this.installerPath;
      if (!installer) {
        this.dispatchError(new Error("Downloaded installer is unavailable."));
        return false;
      }
      const args = ["--updated"];
      if (installOptions.isSilent) args.push("/S");
      if (installOptions.isForceRunAfter) args.push("--force-run");
      if (this.installDirectory) args.push(`/D=${this.installDirectory}`);
      const packageFile = this.downloadedUpdateHelper?.packageFile;
      if (packageFile) args.push(`--package-file=${packageFile}`);
      const elevated = () => this.spawnLog(require("node:path").join(process.resourcesPath, "elevate.exe"), [installer, ...args]);
      this.launch = (async () => {
        if (installOptions.isAdminRightsRequired) return elevated();
        try {
          return await this.spawnLog(installer, args);
        } catch (error) {
          if (error.code === "UNKNOWN" || error.code === "EACCES") return elevated();
          if (error.code === "ENOENT") {
            const message = await require("electron").shell.openPath(installer);
            if (message) throw new Error(message);
            return true;
          }
          throw error;
        }
      })();
      return true;
    }
    async quitAndInstall(isSilent = false, isForceRunAfter = false) {
      this.launch = null;
      try {
        if (!this.install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall)) {
          this.quitAndInstallCalled = false;
          return;
        }
        if (!await this.launch) throw new Error("The update installer did not start.");
        if (options.beforeQuit && !await options.beforeQuit()) {
          this.quitAndInstallCalled = false;
          return;
        }
        if (options.emitQuit) options.emitQuit();
        else require("electron").autoUpdater.emit("before-quit-for-update");
        this.app.quit();
      } catch (error) {
        this.quitAndInstallCalled = false;
        this.dispatchError(error);
      }
    }
  }
  return new SavedWorkUpdater(null, options.appAdapter);
}

/**
 * @param {{ app: Pick<Electron.App, "isPackaged" | "getVersion">,
 *   notify: (state: UpdateState) => void, requestClose: () => boolean,
 *   onInstallFailure: () => void, platform?: string,
 *   confirmQuit?: () => Promise<boolean>,
 *   loadUpdater?: (beforeQuit: () => Promise<boolean>) => import("electron-updater").AppUpdater,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} options
 */
function createUpdater(options) {
  const { app, notify, requestClose, onInstallFailure } = options;
  const platform = options.platform ?? process.platform;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const currentVersion = app.getVersion();
  const prerelease = /-([a-zA-Z][a-zA-Z0-9-]*)/.exec(currentVersion)?.[1] ?? null;
  /** @type {UpdateState} */
  let state = {
    status: !app.isPackaged || platform !== "win32" ? "disabled" : "idle",
    currentVersion, channel: prerelease ?? "stable", version: null, percent: null,
    checkedAt: null, error: !app.isPackaged ? "development" : platform !== "win32" ? "unsupported" : null,
  };
  /** @type {import("electron-updater").AppUpdater | null} */
  let updater = null;
  /** @type {Promise<UpdateState> | null} */
  let checking = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let started = false;
  let disposed = false;
  const listeners = [];
  const getState = () => ({ ...state });
  /** @param {Partial<UpdateState>} change */
  function publish(change) {
    if (disposed) return;
    state = { ...state, ...change };
    notify(getState());
  }
  /** @param {UpdateError} reason */
  function fail(reason) {
    if (state.status === "installing") {
      publish({ status: "downloaded", error: "install" });
      onInstallFailure();
    } else {
      publish({ status: "error", error: reason, percent: null });
      scheduleCheck(15 * 60_000);
    }
  }
  function scheduleCheck(delay) {
    if (timer !== null) clearTimer(timer);
    if (disposed) return;
    timer = setTimer(() => {
      timer = null;
      void check();
    }, delay);
    timer.unref?.();
  }
  function initialize() {
    if (updater) return true;
    try {
      // Do not even require electron-updater in development: its constructor
      // and test overrides must never enable network traffic for `electron .`.
      const beforeQuit = async () => {
          // The window/input stayed frozen since the save handshake. NSIS can
          // terminate the old app itself, so all saving precedes its launch.
          if (disposed || !options.confirmQuit || !await options.confirmQuit()) {
            publish({ status: "downloaded", error: "save" });
            onInstallFailure();
            return false;
          }
          return true;
      };
      updater = options.loadUpdater ? options.loadUpdater(beforeQuit) : createNativeUpdater({ beforeQuit });
      const client = updater;
      client.autoDownload = true;
      // Every installer launch goes through the renderer's dirty-buffer and
      // graph flush. The library's quit hook would bypass that contract.
      client.autoInstallOnAppQuit = false;
      client.autoRunAppAfterInstall = true;
      client.disableWebInstaller = true;
      client.allowPrerelease = prerelease !== null;
      client.allowDowngrade = false;
      // electron-updater adds a persistent staging UUID to metadata requests.
      // Aqvenor does not identify installations to GitHub; override that header
      // through the library's public requestHeaders API for every request.
      client.requestHeaders = { "x-user-staging-id": "" };
      client.setFeedURL({ provider: "github", owner: "rwarx", repo: "aqvenor" });
      const on = (event, listener) => {
        client.on(event, listener);
        listeners.push([event, listener]);
      };
      on("checking-for-update", () => publish({ status: "checking", error: null, percent: null }));
      on("update-not-available", () => publish({ status: "idle", version: null, checkedAt: Date.now(), error: null }));
      on("update-available", (info) => publish({ status: "available", version: info.version, checkedAt: Date.now(), error: null }));
      on("download-progress", (progress) => publish({
        status: "downloading", percent: Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, progress.percent)) : null,
      }));
      on("update-downloaded", (info) => publish({ status: "downloaded", version: info.version, percent: 100, error: null }));
      on("error", () => fail(["available", "downloading"].includes(state.status) ? "download" : "check"));
      return true;
    } catch {
      updater = null;
      publish({ status: "error", error: "initialization" });
      return false;
    }
  }
  async function check() {
    if (disposed || state.status === "disabled") return getState();
    if (["available", "downloading", "downloaded", "installing"].includes(state.status)) return getState();
    if (checking) return checking;
    if (!initialize()) return getState();
    publish({ status: "checking", error: null, percent: null });
    const client = updater;
    // Run on a microtask so synchronous test/transport failures are caught and
    // the in-flight promise is assigned before any event can ask to retry.
    checking = Promise.resolve().then(async () => {
      try {
        const result = await client?.checkForUpdates();
        // checkForUpdates resolves once metadata is ready; the independent
        // download promise also needs a rejection handler to avoid a crash.
        if (result?.downloadPromise) {
          void result.downloadPromise.catch(() => {
            if (state.status !== "error" && state.status !== "downloaded") fail("download");
          });
        }
      } catch {
        if (state.status !== "error") fail("check");
      } finally {
        checking = null;
        // Keep checking quietly during a long session. Errors retry after 15m;
        // normal checks run every 6h, without repeatedly downloading a file.
        scheduleCheck(state.status === "error" ? 15 * 60_000 : 6 * 60 * 60_000);
      }
      return getState();
    });
    return checking;
  }
  function requestInstall() {
    if (disposed || state.status !== "downloaded") return getState();
    publish({ status: "installing", error: null });
    // Existing/invalid close requests cannot grant permission to install.
    if (!requestClose()) publish({ status: "downloaded", error: "save" });
    return getState();
  }
  function cancelInstall() {
    if (state.status === "installing") publish({ status: "downloaded", error: "save" });
  }
  // Called exclusively after the trusted finishClose(request, true) handshake.
  async function installAfterClose() {
    if (disposed || state.status !== "installing" || !updater) return false;
    try {
      await updater.quitAndInstall(false, true);
      return state.status === "installing";
    } catch {
      if (state.status === "installing") fail("install");
      return false;
    }
  }
  return {
    getState, check, requestInstall, cancelInstall, installAfterClose,
    start() {
      if (started || disposed || state.status === "disabled") return;
      started = true;
      scheduleCheck(10_000);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      for (const [event, listener] of listeners) updater?.removeListener(event, listener);
    },
  };
}

/** Register through main.js's sender-validated handle wrapper. */
function registerUpdaterIpc({ handle }, controller) {
  handle("aqvenor:updateState", () => controller.getState());
  handle("aqvenor:updateCheck", () => controller.check());
  handle("aqvenor:updateInstall", () => controller.requestInstall());
}

module.exports = { createUpdater, createNativeUpdater, registerUpdaterIpc };
