"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { TranscriptPresentation } from "@/lib/chat-transcript-plan";

export const TRANSCRIPT_PRESENTATION_KEY = "omp-transcript-presentation";
export const PROCESS_DETAILS_EXPANDED_KEY = "omp-process-details-expanded";
export const TRANSCRIPT_PREF_CHANGE_EVENT = "omp-transcript-pref-change";
export interface TranscriptPreferenceState { presentation: TranscriptPresentation; expandProcessDetails: boolean }
const defaults: TranscriptPreferenceState = Object.freeze({ presentation: "classic", expandProcessDetails: false });
let snapshot = defaults;
let storageFailed = false;

export function storedTranscriptPreference(): TranscriptPreferenceState {
  if (typeof window === "undefined") return defaults;
  if (storageFailed) return snapshot;
  try {
    const presentation = window.localStorage.getItem(TRANSCRIPT_PRESENTATION_KEY) === "focused" ? "focused" : "classic";
    const expandProcessDetails = window.localStorage.getItem(PROCESS_DETAILS_EXPANDED_KEY) === "true";
    if (snapshot.presentation !== presentation || snapshot.expandProcessDetails !== expandProcessDetails) snapshot = { presentation, expandProcessDetails };
  } catch { storageFailed = true; }
  return snapshot;
}

function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === TRANSCRIPT_PRESENTATION_KEY || event.key === PROCESS_DETAILS_EXPANDED_KEY) {
      storageFailed = false;
      listener();
    }
  };
  window.addEventListener("storage", storage);
  window.addEventListener(TRANSCRIPT_PREF_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(TRANSCRIPT_PREF_CHANGE_EVENT, listener);
  };
}

export function saveTranscriptPreference(updates: Partial<TranscriptPreferenceState>): void {
  snapshot = { ...storedTranscriptPreference(), ...updates };
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRANSCRIPT_PRESENTATION_KEY, snapshot.presentation);
    window.localStorage.setItem(PROCESS_DETAILS_EXPANDED_KEY, String(snapshot.expandProcessDetails));
    storageFailed = false;
  } catch { storageFailed = true; }
  window.dispatchEvent(new Event(TRANSCRIPT_PREF_CHANGE_EVENT));
}

export function useTranscriptPreference() {
  const state = useSyncExternalStore(subscribe, storedTranscriptPreference, () => defaults);
  const setPresentation = useCallback((presentation: TranscriptPresentation) => saveTranscriptPreference({ presentation }), []);
  const setExpandProcessDetails = useCallback((expandProcessDetails: boolean) => saveTranscriptPreference({ expandProcessDetails }), []);
  return { ...state, setPresentation, setExpandProcessDetails };
}
