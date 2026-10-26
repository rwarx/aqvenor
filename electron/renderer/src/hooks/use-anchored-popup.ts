import { useEffect, useState, type RefObject } from "react";

/* ============================================================
   Anchored popups that stay inside the viewport.

   An absolutely positioned popup is positioned against its nearest
   positioned ancestor, which inside a dock panel can be a scrolled —
   and very tall — container. That is how the composer's model picker
   ended up at y ≈ −18858, off screen and unclickable (AQV-005).

   These popups render through a portal at document.body and are placed
   with `position: fixed` from the anchor's measured rect, clamped into
   the window. The placement maths is a pure function so it can be
   tested without a DOM.
   ============================================================ */

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PopupBox {
  width: number;
  /** Natural height of the popup; it shrinks to the room available. */
  height: number;
}

export interface PopupPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  /** which side of the anchor the popup ended up on */
  side: "top" | "bottom";
}

export const POPUP_GAP = 6;
export const POPUP_MARGIN = 8;
/** below this much room a popup prefers the other side */
const MIN_COMFORTABLE = 200;

/**
 * Place a popup next to its anchor, fully inside the viewport.
 *
 * Preferred side is above the anchor (composer pills sit at the bottom of the
 * window); the popup flips below only when there is clearly more room there.
 */
export function computePopupPlacement(
  anchor: AnchorRect,
  box: PopupBox,
  viewport: { width: number; height: number },
  opts?: { gap?: number; margin?: number },
): PopupPlacement {
  const gap = opts?.gap ?? POPUP_GAP;
  const margin = opts?.margin ?? POPUP_MARGIN;

  const width = Math.max(160, Math.min(box.width, viewport.width - margin * 2));
  /* right-align to the anchor (pills sit at the right edge), then clamp */
  const left = Math.min(
    Math.max(anchor.right - width, margin),
    Math.max(margin, viewport.width - width - margin),
  );

  const roomAbove = anchor.top - gap - margin;
  const roomBelow = viewport.height - anchor.bottom - gap - margin;
  const side: "top" | "bottom" =
    roomBelow > roomAbove && roomAbove < Math.min(box.height, MIN_COMFORTABLE)
      ? "bottom"
      : "top";

  const room = Math.max(0, side === "top" ? roomAbove : roomBelow);
  /* never taller than fits; when the anchor is jammed against the window edge
     keep a usable minimum and let the popup scroll inside itself */
  const maxHeight = Math.max(120, Math.min(box.height, room));
  const height = Math.min(box.height, maxHeight);

  const rawTop = side === "top" ? anchor.top - gap - height : anchor.bottom + gap;
  const top = Math.min(
    Math.max(rawTop, margin),
    Math.max(margin, viewport.height - height - margin),
  );

  return { left, top, width, maxHeight, side };
}

/**
 * Live placement for a popup anchored to `anchorRef`.
 * Re-measures on open, on viewport resize and on any scroll (capture, so
 * scrolling inside a dock panel counts). Returns null until measured.
 */
export function useAnchoredPopup(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  box: PopupBox,
): PopupPlacement | null {
  const [placement, setPlacement] = useState<PopupPlacement | null>(null);

  useEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const update = () => {
      const el = anchorRef.current;
      if (!el || typeof window === "undefined") return;
      const r = el.getBoundingClientRect();
      setPlacement(
        computePopupPlacement(
          { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          box,
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
    // box is a literal at every call site; width/height are its identity
  }, [open, anchorRef, box.width, box.height]);

  return placement;
}
