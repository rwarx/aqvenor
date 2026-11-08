"use client";

import { useEffect, useRef, useState } from "react";

export interface UpdateState {
  status: "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "error";
  currentVersion: string;
  channel: string;
  version: string | null;
  percent: number | null;
  checkedAt: number | null;
  error: "development" | "unsupported" | "initialization" | "check" | "download" | "install" | "save" | "bridge" | null;
}

export function useAppUpdates() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(false);
  const bridge = window.aqvenor?.updates;

  useEffect(() => {
    mounted.current = true;
    if (!bridge) return () => { mounted.current = false; };
    let active = true;
    const unsubscribe = bridge.onChanged((next) => {
      revision.current += 1;
      setState(next);
    });
    const initialRevision = revision.current;
    void bridge.getState().then((next) => {
      if (active && revision.current === initialRevision) setState(next);
    }).catch(() => {
      if (active && revision.current === initialRevision) setState({
        status: "error", currentVersion: "", channel: "", version: null,
        percent: null, checkedAt: null, error: "bridge",
      });
    });
    return () => { active = false; mounted.current = false; unsubscribe(); };
  }, [bridge]);

  async function action(kind: "check" | "install") {
    if (!bridge || busy) return;
    setBusy(true);
    const initialRevision = revision.current;
    try {
      const next = await bridge[kind]();
      if (mounted.current && revision.current === initialRevision) setState(next);
    } catch {
      if (mounted.current && revision.current === initialRevision) setState((previous) => previous ? {
        ...previous, status: kind === "install" ? "downloaded" : "error", error: "bridge",
      } : null);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return { state, busy, hasBridge: Boolean(bridge), check: () => action("check"), install: () => action("install") };
}
