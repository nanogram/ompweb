"use client";

import { Component, createContext, startTransition, useEffect, useRef, useState, type ReactNode, type RefCallback, type RefObject } from "react";

/** Live output and non-history Markdown render normally outside this boundary. */
export const HistoryRenderingContext = createContext(true);

type ViewportWatch = { observer: IntersectionObserver; targets: Map<Element, () => void> };
const viewportWatches = new WeakMap<Element, ViewportWatch>();

function watchViewport(element: Element, onVisible: () => void): () => void {
  const root = element.closest('[role="log"]') ?? document.documentElement;
  let watch = viewportWatches.get(root);
  if (!watch) {
    const targets = new Map<Element, () => void>();
    const observer = new IntersectionObserver((entries) => {
      startTransition(() => {
        for (const entry of entries) {
          if (entry.isIntersecting) targets.get(entry.target)?.();
        }
      });
    }, { root: root === document.documentElement ? null : root, rootMargin: "400px 0px" });
    watch = { observer, targets };
    viewportWatches.set(root, watch);
  }
  watch.targets.set(element, onVisible);
  watch.observer.observe(element);
  return () => {
    watch.targets.delete(element);
    watch.observer.unobserve(element);
    if (watch.targets.size === 0) {
      watch.observer.disconnect();
      viewportWatches.delete(root);
    }
  };
}

type AnchorProps = { children: ReactNode; enhanced: boolean; elementRef: RefObject<HTMLDivElement | null> };
type ScrollSnapshot = { root: HTMLElement; anchor: HTMLElement | null; offset: number };

/** Snapshot before DOM replacement; a layout-effect cleanup is already too late. */
class HistoryScrollAnchor extends Component<AnchorProps, unknown, ScrollSnapshot | null> {
  getSnapshotBeforeUpdate(previous: AnchorProps): ScrollSnapshot | null {
    if (previous.enhanced || !this.props.enhanced) return null;
    const root = this.props.elementRef.current?.closest<HTMLElement>('[role="log"]');
    if (!root) return null;
    if (root.scrollHeight - root.scrollTop - root.clientHeight < 96) return { root, anchor: null, offset: 0 };
    const viewport = root.getBoundingClientRect();
    for (const anchor of root.querySelectorAll<HTMLElement>("[data-message-index]")) {
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
        return { root, anchor, offset: rect.top - viewport.top };
      }
    }
    return null;
  }

  componentDidUpdate(_previous: AnchorProps, _state: unknown, snapshot: ScrollSnapshot | null) {
    if (!snapshot?.root.isConnected) return;
    const { root, anchor, offset } = snapshot;
    if (!anchor) root.scrollTop = root.scrollHeight;
    else if (anchor.isConnected) {
      const shift = anchor.getBoundingClientRect().top - root.getBoundingClientRect().top - offset;
      if (Math.abs(shift) > 0.5) root.scrollTop += shift;
    }
  }

  render() { return this.props.children; }
}

/** Keep source text and navigation anchors mounted; enhance nearby history once. */
export function HistoryMessage({ children, messageIndex, messageRef, ready = true, immediate = false }: {
  children: ReactNode;
  messageIndex: number;
  messageRef?: RefCallback<HTMLDivElement>;
  ready?: boolean;
  immediate?: boolean;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const canObserve = typeof IntersectionObserver !== "undefined";
  useEffect(() => {
    const element = elementRef.current;
    if (!element || visible) return;
    if (ready && immediate) { setVisible(true); return; }
    if (!canObserve) return;
    return watchViewport(element, () => setVisible(true));
  }, [canObserve, visible, immediate, ready]);
  const enhanced = ready && (immediate || visible || !canObserve);
  return (
    <div data-message-index={messageIndex} data-history-rendering={enhanced ? "rich" : "plain"} ref={(element) => {
      elementRef.current = element;
      messageRef?.(element);
    }}>
      <HistoryScrollAnchor enhanced={enhanced} elementRef={elementRef}>
        <HistoryRenderingContext.Provider value={enhanced}>{children}</HistoryRenderingContext.Provider>
      </HistoryScrollAnchor>
    </div>
  );
}
