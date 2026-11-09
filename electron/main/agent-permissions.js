"use strict";

const COPY = {
  ru: ["Разрешить агенту запуск программ?", "Команды выполняются на этом компьютере. Каждый запуск проходит через политику подтверждения агента.", "Разрешить CMD и PowerShell?", "Оболочка может запускать другие программы и обращаться за пределы проекта. Отдельные команды проходят через политику подтверждения агента."],
  en: ["Allow the agent to run programs?", "Programs run on this computer. Each invocation uses the agent's approval policy.", "Allow CMD and PowerShell?", "A shell can start other programs and access files outside the project. Each command uses the agent's approval policy."],
  de: ["Darf der Agent Programme ausführen?", "Programme laufen auf diesem Computer. Jeder Aufruf nutzt die Freigaberichtlinie des Agenten.", "CMD und PowerShell erlauben?", "Eine Shell kann weitere Programme starten und auf Dateien außerhalb des Projekts zugreifen. Jeder Befehl nutzt die Freigaberichtlinie des Agenten."],
};

/** Registered through main.js's sender-validated handle wrapper. The host
 * credential belongs to this process; only the result crosses the bridge. */
function registerAgentPermissionIpc(ipc, deps) {
  let queue = Promise.resolve();
  ipc.handle("aqvenor:agent-permissions", (_event, input, locale) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A permission change is required.");
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !["allowCommands", "allowShellCommands"].includes(key) || typeof input[key] !== "boolean")) {
      throw new Error("Unsupported permission change.");
    }
    const patch = Object.fromEntries(keys.map((key) => [key, input[key]]));
    const pending = queue.then(async () => {
      const copy = typeof locale === "string" && Object.hasOwn(COPY, locale) ? COPY[locale] : COPY.en;
      if (Object.values(patch).some((value) => value === true)) {
        const shell = patch.allowShellCommands === true;
        const buttons = { ru: ["Отмена", "Разрешить"], en: ["Cancel", "Allow"], de: ["Abbrechen", "Erlauben"] };
        const labels = typeof locale === "string" && Object.hasOwn(buttons, locale) ? buttons[locale] : buttons.en;
        if (!await deps.confirm(copy[shell ? 2 : 0], copy[shell ? 3 : 1], labels)) return { cancelled: true };
      }
      await deps.ready;
      const url = new URL(deps.getBackendUrl());
      if (!/^https?:$/.test(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
        throw new Error("Permission changes require the local server.");
      }
      const response = await deps.fetchImpl(new URL("/api/host/agent-permissions", url).href, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.authToken}`, "X-Aqvenor-Host-Token": deps.hostToken },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Permission change failed (${response.status}).`);
      const value = await response.json();
      if (typeof value.allowCommands !== "boolean" || typeof value.allowShellCommands !== "boolean") throw new Error("Invalid permission response.");
      return { allowCommands: value.allowCommands, allowShellCommands: value.allowShellCommands };
    });
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  });
}

module.exports = { registerAgentPermissionIpc };
