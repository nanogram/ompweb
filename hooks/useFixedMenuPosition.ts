"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

const GAP = 4;
const VIEWPORT_PAD = 8;

/** Viewport position for a fixed, portalled menu, below its anchor by default.
 * Above-anchor pickers shrink to the available space without covering the anchor.
 * Tracks anchor size, scroll, resize and the mobile visual viewport. */
export function useFixedMenuPosition(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  menuWidth: number,
  { placement = "below", height }: { placement?: "above" | "below"; height?: number } = {},
): { top: number; left: number; width: number; height?: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number; width: number; height?: number } | null>(null);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger) {
      setPos(null);
      return;
    }
    const update = () => {
      // --ui-scale zooms <html>: the rect is in painted pixels, while fixed
      // coordinates are zoomed again, so convert to unscaled CSS pixels.
      const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportWidth = (viewport?.width ?? window.innerWidth) / scale;
      const viewportHeight = (viewport?.height ?? window.innerHeight) / scale;
      const viewportLeft = (viewport?.offsetLeft ?? 0) / scale;
      const viewportTop = (viewport?.offsetTop ?? 0) / scale;
      const width = Math.min(menuWidth, Math.max(0, viewportWidth - 2 * VIEWPORT_PAD));
      const aboveBottom = Math.min(rect.top / scale - GAP, viewportTop + viewportHeight - VIEWPORT_PAD);
      const availableHeight = placement === "above"
        ? Math.max(0, aboveBottom - viewportTop - VIEWPORT_PAD)
        : Math.max(0, viewportHeight - 2 * VIEWPORT_PAD);
      const boundedHeight = height === undefined ? undefined : Math.min(height, availableHeight);
      const top = placement === "above" && boundedHeight !== undefined
        ? Math.max(viewportTop + VIEWPORT_PAD, aboveBottom - boundedHeight)
        : rect.bottom / scale + GAP;
      const left = Math.max(viewportLeft + VIEWPORT_PAD, Math.min(rect.left / scale, viewportLeft + viewportWidth - width - VIEWPORT_PAD));
      setPos((previous) => previous && previous.top === top && previous.left === left && previous.width === width && previous.height === boundedHeight
        ? previous : { top, left, width, height: boundedHeight });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(trigger);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open, triggerRef, menuWidth, placement, height]);

  return pos;
}
