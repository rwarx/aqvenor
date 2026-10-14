// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeRuns, useAqvenor } from "../store";
import type { Approval } from "../types";

const S = () => useAqvenor.getState();

function approval(id: string, tool = "write_file"): Approval {
  return {
    id,
    tool,
    risk: "write",
    headline: tool,
    consequence: "test",
    allowForRunAvailable: true,
  };
}

describe("summarizeRuns (global bars mirror per-chat runs)", () => {
  it("prefers streaming over waiting, waiting over idle", () => {
    expect(summarizeRuns({})).toEqual({ status: "idle" });
    expect(summarizeRuns({ a: { status: "done", label: "x" } }).status).toBe("idle");
    expect(
      summarizeRuns({ a: { status: "awaiting-approval", label: "w" } }).status,
    ).toBe("awaiting-approval");
    expect(
      summarizeRuns({
        a: { status: "awaiting-approval" },
        b: { status: "running", label: "r" },
      }),
    ).toEqual({ status: "running", label: "r" });
  });
});

describe("per-chat drafts", () => {
  let a = "";
  let b = "";

  beforeEach(() => {
    a = S().newSession();
    b = S().newSession();
  });

  it("keeps three text boxes independent", () => {
    S().setDraft("aaa", a);
    S().setDraft("bbb", b);
    expect(S().draftOf(a).text).toBe("aaa");
    expect(S().draftOf(b).text).toBe("bbb");
    expect(S().draftOf("missing").text).toBe("");
  });

  it("keeps attachment trays independent", () => {
    const att = (id: string) => ({ id, name: `${id}.txt`, sizeKb: 1, mimeType: "text/plain", textContent: id });
    S().addDraftAttachment(att("x"), a);
    S().addDraftAttachment(att("y"), b);
    S().addDraftAttachment(att("y"), b); // dedupe, not duplicate
    expect(S().draftOf(a).attachments.map((x) => x.id)).toEqual(["x"]);
    expect(S().draftOf(b).attachments.map((x) => x.id)).toEqual(["y"]);
    S().removeDraftAttachment("x", a);
    expect(S().draftOf(a).attachments).toEqual([]);
    expect(S().draftOf(b).attachments.map((x) => x.id)).toEqual(["y"]);
    S().clearDraftAttachments(b);
    expect(S().draftOf(b).attachments).toEqual([]);
  });
});

describe("per-chat approvals and standing permissions", () => {
  let a = "";
  let b = "";

  beforeEach(() => {
    a = S().newSession();
    b = S().newSession();
  });

  it("holds two gates open at once and resolves them separately", () => {
    S().setApproval(approval("q-a"), a);
    S().setApproval(approval("q-b"), b);
    expect(S().approvalOf(a)?.id).toBe("q-a");
    expect(S().approvalOf(b)?.id).toBe("q-b");
    S().resolveApproval("allowed", undefined, a);
    expect(S().approvalOf(a)).toBeNull();
    expect(S().approvalOf(b)?.id).toBe("q-b");
    S().resolveApproval("denied", undefined, b);
    expect(S().approvalOf(b)).toBeNull();
  });

  it("scopes allow-for-run to the chat that granted it", () => {
    S().setApproval(approval("q-a", "edit_file"), a);
    S().resolveApproval("allowed-for-run", undefined, a);
    expect(S().isAllowedForRun("edit_file", a)).toBe(true);
    expect(S().isAllowedForRun("edit_file", b)).toBe(false);
    expect(S().isAllowedForRun("edit_file")).toBe(false);
  });
});

describe("per-chat run state", () => {
  let a = "";
  let b = "";

  beforeEach(() => {
    a = S().newSession();
    b = S().newSession();
  });

  it("mirrors the busiest chat into the global runner", () => {
    S().setSessionRunner(a, { status: "running", label: "Working" });
    expect(S().sessionRunnerOf(a).status).toBe("running");
    expect(S().runner.status).toBe("running");
    S().setSessionRunner(b, { status: "awaiting-approval", label: "You" });
    expect(S().runner.status).toBe("running");
    S().clearSessionRunner(a);
    expect(S().runner.status).toBe("awaiting-approval");
    expect(S().sessionRunnerOf(a).status).toBe("idle");
    S().clearSessionRunner(b);
    expect(S().runner.status).toBe("idle");
  });
});

describe("aliases, unread and deletion cleanup", () => {
  it("follows placeholder → server upgrades", () => {
    const local = S().newSession();
    // Mirror ensureServerSession: the placeholder is dropped, the alias stays.
    useAqvenor.setState((s) => ({
      sessionAliases: { ...s.sessionAliases, [local]: "server-guid" },
      sessions: [
        ...s.sessions.filter((x) => x.id !== local),
        { ...s.sessions.find((x) => x.id === local)!, id: "server-guid" },
      ],
    }));
    expect(S().resolveSession(local)?.id).toBe("server-guid");
    expect(S().resolveSession("server-guid")?.id).toBe("server-guid");
    expect(S().resolveSession("nope")).toBeUndefined();
  });

  it("bumps unread and clears it on view, select and delete", () => {
    const id = S().newSession();
    S().bumpUnread(id);
    S().bumpUnread(id);
    expect(S().unread[id]).toBe(2);
    S().markSessionRead(id);
    expect(S().unread[id]).toBeUndefined();
    S().bumpUnread(id);
    S().selectSession(id);
    expect(S().unread[id]).toBeUndefined();
    S().bumpUnread(id);
    S().deleteSession(id);
    const st = S();
    expect(st.unread[id]).toBeUndefined();
    expect(st.drafts[id]).toBeUndefined();
    expect(st.approvals[id]).toBeUndefined();
    expect(st.runningSessions[id]).toBeUndefined();
  });

  it("pins autonomy per chat without touching the global default", () => {
    const id = S().newSession();
    const before = S().ui.workMethod;
    S().setWorkMethod("plan", id);
    expect(S().sessions.find((s) => s.id === id)?.method).toBe("plan");
    expect(S().ui.workMethod).toBe("plan");
    S().setWorkMethod(before);
  });
});
