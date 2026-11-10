export interface UiCustomizationStatus {
  enabled: true;
  sourceRoot: string;
  appliedRevision: number;
  appliedFiles: string[];
  deferredFiles: string[];
  lastError: string | null;
}

function readStatus(value: unknown): UiCustomizationStatus {
  const status = value as Partial<UiCustomizationStatus> | null;
  const files = (value: unknown): value is string[] => Array.isArray(value) && value.every((file) => typeof file === "string");
  if (!status || status.enabled !== true || typeof status.sourceRoot !== "string"
    || !Number.isSafeInteger(status.appliedRevision) || status.appliedRevision! < 0
    || !files(status.appliedFiles) || !files(status.deferredFiles)
    || (status.lastError !== null && typeof status.lastError !== "string")) {
    throw new Error("Invalid live customization status");
  }
  return status as UiCustomizationStatus;
}

/** One request at a time, and none while hidden. Cleanup also fences late responses. */
export function pollUiCustomizationStatus(onStatus: (status: UiCustomizationStatus) => void, onError: (error: string) => void): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  const stop = () => {
    clearTimeout(timer);
    request?.abort();
    request = undefined;
  };
  const poll = async () => {
    if (disposed || document.visibilityState === "hidden" || request) return;
    const controller = new AbortController();
    request = controller;
    try {
      const response = await fetch("/ui-customization.json", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Live customization status unavailable (HTTP ${response.status})`);
      const status = readStatus(await response.json());
      if (!disposed && request === controller) onStatus(status);
    } catch (error) {
      if (!disposed && request === controller && !controller.signal.aborted) {
        onError(error instanceof Error ? error.message : "Live customization status unavailable");
      }
    } finally {
      if (!disposed && request === controller) {
        request = undefined;
        timer = setTimeout(() => void poll(), 1500);
      }
    }
  };
  const visibility = () => {
    stop();
    if (document.visibilityState !== "hidden") void poll();
  };
  document.addEventListener("visibilitychange", visibility);
  void poll();
  return () => {
    disposed = true;
    stop();
    document.removeEventListener("visibilitychange", visibility);
  };
}

/**
 * Bun 1.4.4 starts CSS replacements without awaiting them. Firefox follows
 * CSSOM's modification lock, so overlapping updates must wait per stylesheet.
 * Genuine native failures still reject; a failed update cannot poison the queue.
 */
export function serializeCssHmrUpdates(): () => void {
  const prototype = window.CSSStyleSheet.prototype;
  const nativeReplace = prototype.replace;
  const pending = new WeakMap<CSSStyleSheet, Promise<CSSStyleSheet>>();
  function serializedReplace(this: CSSStyleSheet, text: string): Promise<CSSStyleSheet> {
    const previous = pending.get(this);
    const replace = () => nativeReplace.call(this, text);
    const result = previous ? previous.then(replace, replace) : replace();
    pending.set(this, result);
    return result.finally(() => {
      if (pending.get(this) === result) pending.delete(this);
    });
  }
  prototype.replace = serializedReplace;
  return () => { if (prototype.replace === serializedReplace) prototype.replace = nativeReplace; };
}

/**
 * Driven only by Bun's documented beforeUpdate/afterUpdate events, not React
 * effect cleanup (StrictMode replays that on ordinary mounts). No accept boundary
 * or draft cache: ChatInput and the global draft-store still own all values.
 */
export function createComposerHmrPreservation() {
  let cancelPending = () => {};
  let afterUpdate = () => {};
  const cancel = () => cancelPending();
  return {
    beforeUpdate() {
      cancel();
      const original = document.activeElement;
      if (!(original instanceof HTMLTextAreaElement) || !original.matches(".chat-input-shell textarea")
        || document.visibilityState === "hidden") return;
      const value = original.value;
      const start = original.selectionStart;
      const end = original.selectionEnd;
      const direction = original.selectionDirection;
      const top = original.scrollTop;
      const left = original.scrollLeft;
      const url = window.location.href;
      const ancestors: { element: HTMLElement; top: number; left: number }[] = [];
      for (let element = original.parentElement; element; element = element.parentElement) {
        ancestors.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
      let applied = false;
      let cancelled = false;
      let frame: number | undefined;
      const timeout = setTimeout(cancel, 2000);
      const observer = new MutationObserver(() => schedule());
      const focusChanged = (event: Event) => { if (event.target !== original) cancel(); };
      const focusOut = (event: FocusEvent) => {
        if (event.target !== original || event.relatedTarget !== null) { cancel(); return; }
        // Chromium blurs before detaching a focused node. Wait for the commit
        // to distinguish a remount from an explicit blur of the intact input.
        queueMicrotask(() => { if (!cancelled && original.isConnected) cancel(); });
      };
      const visibilityChanged = () => { if (document.visibilityState === "hidden") cancel(); };
      const restore = () => {
        frame = undefined;
        if (!applied) return;
        if (window.location.href !== url) { cancel(); return; }
        if (original.isConnected) return; // Fast Refresh usually keeps the DOM intact.
        const candidates = document.querySelectorAll<HTMLTextAreaElement>(".chat-input-shell textarea");
        if (candidates.length !== 1) return;
        const replacement = candidates[0];
        const active = document.activeElement;
        if (replacement.disabled || replacement.value !== value
          || (active !== document.body && active !== replacement && active !== null)) {
          cancel();
          return;
        }
        // Consume before focus dispatches events. Never assign a value: a changed
        // draft belongs to its new owner, even if it appeared during this update.
        cancel();
        replacement.focus({ preventScroll: true });
        replacement.setSelectionRange(start, end, direction);
        replacement.scrollTop = top;
        replacement.scrollLeft = left;
        for (const saved of ancestors) {
          if (!saved.element.isConnected) continue;
          saved.element.scrollTop = saved.top;
          saved.element.scrollLeft = saved.left;
        }
      };
      function schedule() {
        if (applied && frame === undefined) frame = requestAnimationFrame(restore);
      }
      const documentEvents = ["pointerdown", "keydown", "beforeinput", "input", "compositionstart"];
      const windowEvents = ["omp:navigate", "popstate", "hashchange", "pagehide", "blur"];
      cancelPending = () => {
        cancelled = true;
        observer.disconnect();
        if (frame !== undefined) cancelAnimationFrame(frame);
        clearTimeout(timeout);
        for (const event of documentEvents) document.removeEventListener(event, cancel, true);
        for (const event of windowEvents) window.removeEventListener(event, cancel);
        document.removeEventListener("focusout", focusOut, true);
        document.removeEventListener("focusin", focusChanged, true);
        document.removeEventListener("visibilitychange", visibilityChanged);
        cancelPending = () => {};
        afterUpdate = () => {};
      };
      for (const event of documentEvents) document.addEventListener(event, cancel, true);
      for (const event of windowEvents) window.addEventListener(event, cancel);
      document.addEventListener("focusin", focusChanged, true);
      document.addEventListener("focusout", focusOut, true);
      document.addEventListener("visibilitychange", visibilityChanged);
      observer.observe(document.body, { childList: true, subtree: true });
      afterUpdate = () => { applied = true; schedule(); };
    },
    afterUpdate() { afterUpdate(); },
    cancel,
  };
}
