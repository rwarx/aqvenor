import { describe, expect, it } from "vitest";
import {
  NODE_MIME,
  SESSION_MIME,
  getNodeDragIds,
  getSessionDragId,
  hasNodeDrag,
  hasSessionDrag,
  setNodeDrag,
  setSessionDrag,
} from "../dnd";

/* Minimal DataTransfer stand-in: the helpers only touch types/setData/getData. */
function transfer(types: string[] = [], data: Record<string, string> = {}): DataTransfer {
  const dt = {
    types,
    effectAllowed: "none",
    setData: (format: string, value: string) => {
      // Like the real DataTransfer, setting data registers its type.
      const lower = format.toLowerCase();
      if (!types.includes(lower)) types.push(lower);
      data[lower] = value;
    },
    getData: (format: string) => data[format.toLowerCase()] ?? "",
  };
  return dt as unknown as DataTransfer;
}

describe("canvas node drag payload", () => {
  it("round-trips several node ids through one MIME slot", () => {
    const dt = transfer();
    const ids = ["file:a", "file:b", "note-1"];
    setNodeDrag({ dataTransfer: dt } as unknown as React.DragEvent, ids);
    expect(dt.effectAllowed).toBe("copy");
    expect(hasNodeDrag({ dataTransfer: dt })).toBe(true);
    expect(getNodeDragIds({ dataTransfer: dt })).toEqual(ids);
  });

  it("accepts a single id as well", () => {
    const dt = transfer();
    setNodeDrag({ dataTransfer: dt } as unknown as React.DragEvent, "only");
    expect(getNodeDragIds({ dataTransfer: dt })).toEqual(["only"]);
  });

  it("falls back to a bare (pre-JSON) payload instead of dropping the gesture", () => {
    const dt = transfer([NODE_MIME], { [NODE_MIME]: "legacy-node-id" });
    expect(getNodeDragIds({ dataTransfer: dt })).toEqual(["legacy-node-id"]);
  });

  it("ignores foreign drags and empty payloads", () => {
    expect(hasNodeDrag({ dataTransfer: null })).toBe(false);
    expect(hasNodeDrag({})).toBe(false);
    expect(getNodeDragIds({ dataTransfer: null })).toEqual([]);
    const dt = transfer([NODE_MIME], {});
    expect(getNodeDragIds({ dataTransfer: dt })).toEqual([]);
  });
});

describe("chat session drag payload", () => {
  it("round-trips a session id", () => {
    const dt = transfer();
    setSessionDrag({ dataTransfer: dt } as unknown as React.DragEvent, "s-123");
    expect(hasSessionDrag({ dataTransfer: dt })).toBe(true);
    expect(getSessionDragId({ dataTransfer: dt })).toBe("s-123");
  });

  it("does not mistake node drags for session drags", () => {
    const dt = transfer();
    setNodeDrag({ dataTransfer: dt } as unknown as React.DragEvent, ["n"]);
    expect(hasSessionDrag({ dataTransfer: dt })).toBe(false);
    expect(getSessionDragId({ dataTransfer: dt })).toBeNull();
  });
});
