/**
 * Client-side composer preferences (localStorage). These live outside the
 * native OMP config because they are ompweb UI behaviors.
 */

import { useSyncExternalStore } from "react";

export type SubmitDuringRunBehavior = "steer" | "queue";

const SUBMIT_DURING_RUN_KEY = "omp-web:submit-during-run";

/** The default, applied when nothing was ever stored under the key. */
export const DEFAULT_SUBMIT_DURING_RUN_BEHAVIOR: SubmitDuringRunBehavior = "queue";

/**
 * How a composer submit during a run is delivered. Defaults to `queue`:
 * queuing stays resilient while a `!!` shell command owns the session, where a
 * live steer/prompt frame would collide with the running bash command instead
 * of joining the next turn.
 *
 * Only an explicitly stored choice overrides that default — the option was
 * never written unless the user picked one, so an absent key simply yields
 * "queue" and no stored value needs rewriting.
 */
export function getSubmitDuringRunBehavior(): SubmitDuringRunBehavior {
  if (typeof window === "undefined") return DEFAULT_SUBMIT_DURING_RUN_BEHAVIOR;
  try {
    const value = window.localStorage.getItem(SUBMIT_DURING_RUN_KEY);
    if (value === "steer" || value === "queue") return value;
  } catch {
    // storage unavailable — fall through to the default
  }
  return DEFAULT_SUBMIT_DURING_RUN_BEHAVIOR;
}

export function setSubmitDuringRunBehavior(behavior: SubmitDuringRunBehavior): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SUBMIT_DURING_RUN_KEY, behavior);
  } catch {
    // storage unavailable — the preference simply won't persist
  }
}

/** Ghost-text word completion: `auto` enables it only with a physical keyboard. */
export type WordCompletionMode = "auto" | "on" | "off";

const WORD_COMPLETION_KEY = "omp-web:word-completion";

export function getWordCompletionMode(): WordCompletionMode {
  if (typeof window === "undefined") return "auto";
  try {
    const value = window.localStorage.getItem(WORD_COMPLETION_KEY);
    if (value === "auto" || value === "on" || value === "off") return value;
  } catch {
    // storage unavailable — fall through to the default
  }
  return "auto";
}

export function setWordCompletionMode(mode: WordCompletionMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORD_COMPLETION_KEY, mode);
  } catch {
    // storage unavailable — the preference simply won't persist
  }
}

/**
 * Whether ghost text is on. Browsers cannot see an on-screen keyboard, so
 * `auto` goes by the primary pointer: a mouse/trackpad (`pointer: fine`)
 * means a physical keyboard is likely; touch devices bring their own
 * keyboard suggestions and have no Tab key.
 */
export function isWordCompletionEnabled(mode: WordCompletionMode = getWordCompletionMode()): boolean {
  if (mode !== "auto") return mode === "on";
  return typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;
}

const SLOW_MODE_CONTROL_KEY = "omp-web:slow-mode-control-visible";
let unsavedSlowModeControl: boolean | null = null;

/** Browser UI visibility only; never changes OMP's native /slow setting. */
export function getSlowModeControlVisible(): boolean {
  if (typeof window === "undefined") return false;
  if (unsavedSlowModeControl !== null) return unsavedSlowModeControl;
  try {
    return window.localStorage.getItem(SLOW_MODE_CONTROL_KEY) === "on";
  } catch {
    return false;
  }
}

export function setSlowModeControlVisible(visible: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SLOW_MODE_CONTROL_KEY, visible ? "on" : "off");
    unsavedSlowModeControl = null;
  } catch {
    // Match other visibility preferences: retain the choice for this page load.
    unsavedSlowModeControl = visible;
  }
  window.dispatchEvent(new Event(SLOW_MODE_CONTROL_KEY));
}

function subscribeSlowModeControl(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SLOW_MODE_CONTROL_KEY) onChange();
  };
  window.addEventListener(SLOW_MODE_CONTROL_KEY, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SLOW_MODE_CONTROL_KEY, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSlowModeControlVisible(): boolean {
  return useSyncExternalStore(subscribeSlowModeControl, getSlowModeControlVisible, () => false);
}
