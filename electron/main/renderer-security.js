"use strict";
const { pathToFileURL } = require("node:url");

function isRendererUrl(url, devUrl, entryPath, isDev) {
  try {
    const target = new URL(url);
    const expected = new URL(isDev ? devUrl : pathToFileURL(entryPath).href);
    target.hash = "";
    expected.hash = "";
    return target.href === expected.href;
  } catch { return false; }
}

function assertRendererSender(event, window, devUrl, entryPath, isDev) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isRendererUrl(event.senderFrame?.url, devUrl, entryPath, isDev)) {
    throw new Error("IPC is available only to the Aqvenor main frame.");
  }
}

module.exports = { isRendererUrl, assertRendererSender };
