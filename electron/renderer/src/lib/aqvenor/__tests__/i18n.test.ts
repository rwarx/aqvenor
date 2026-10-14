import { describe, expect, it } from "vitest";
import { tp } from "../i18n";

describe("plural-aware lookup tp()", () => {
  it("picks .one for a single item in English", () => {
    expect(tp("en", "canvas.connect.bulkCreated", 1)).toBe("1 connection created");
    expect(tp("en", "canvas.connect.bulkCreated", 5)).toBe("5 connections created");
  });

  it("declines Russian one / few / many", () => {
    expect(tp("ru", "canvas.connect.bulkCreated", 1)).toBe("Создана связь: 1");
    expect(tp("ru", "canvas.connect.bulkCreated", 3)).toBe("Создано связи: 3");
    expect(tp("ru", "canvas.connect.bulkCreated", 11)).toBe("Создано связей: 11");
    expect(tp("ru", "canvas.connect.bulkCreated", 25)).toBe("Создано связей: 25");
    expect(tp("ru", "status.nodes", 1)).toBe("1 узел");
    expect(tp("ru", "status.nodes", 2)).toBe("2 узла");
    expect(tp("ru", "status.nodes", 5)).toBe("5 узлов");
  });

  it("covers the reconnected drift keys", () => {
    expect(tp("ru", "trajectory.checkpointGraph", 1)).toContain("узел:");
    expect(tp("ru", "code.checkpoint.applied", 1)).toContain("изменение:");
    expect(tp("ru", "code.checkpoint.filesChanged", 2)).toContain("файла:");
    expect(tp("ru", "import.skipped", 1)).toContain("Пропущен файл:");
    expect(tp("ru", "canvas.bgmenu.nodeCount", 2)).toContain("узла:");
    expect(tp("ru", "outline.bulk.title", 5)).toContain("связей выбрано:");
    expect(tp("ru", "canvas.toolbar.clearEdgeSelection", 1)).toContain("связи (1)");
    expect(tp("de", "code.checkpoint.applied", 1)).toBe("1 Änderung angewendet");
    expect(tp("de", "code.checkpoint.filesChanged", 1)).toBe("1 Datei geändert");
    expect(tp("de", "status.nodes", 1)).toBe("1 Knoten");
  });

  it("falls back to the key itself when nothing matches", () => {
    expect(tp("en", "no.such.key", 3)).toBe("no.such.key");
  });
});
