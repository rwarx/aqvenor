import { describe, expect, it } from "vitest";
import { serverCreateTitle } from "../session-titles";

describe("title sent to conversations.create (AQV-003)", () => {
  it("never sends the placeholder — that is what froze auto-titles", () => {
    expect(serverCreateTitle({ title: "New chat", titleUserDefined: undefined })).toBeUndefined();
    // a poisoned row: flagged as if renamed, but the "name" is still the placeholder
    expect(serverCreateTitle({ title: "New chat", titleUserDefined: true })).toBeUndefined();
    expect(serverCreateTitle({ title: "New Chat", titleUserDefined: true })).toBeUndefined();
    expect(serverCreateTitle({ title: "Новый чат", titleUserDefined: true })).toBeUndefined();
    expect(serverCreateTitle({ title: "   ", titleUserDefined: true })).toBeUndefined();
  });

  it("does not send a title derived from the first message", () => {
    expect(serverCreateTitle({ title: "Fix the docker build", titleUserDefined: false })).toBeUndefined();
  });

  it("sends a real hand-typed title", () => {
    expect(serverCreateTitle({ title: "QA Test Chat", titleUserDefined: true })).toBe("QA Test Chat");
    expect(serverCreateTitle({ title: "  Spaced  ", titleUserDefined: true })).toBe("Spaced");
  });

  it("survives a missing session", () => {
    expect(serverCreateTitle(null)).toBeUndefined();
    expect(serverCreateTitle(undefined)).toBeUndefined();
    expect(serverCreateTitle({})).toBeUndefined();
  });
});
