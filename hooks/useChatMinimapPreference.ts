"use client";

import { useCallback, useSyncExternalStore } from "react";

export type DesktopMinimapMode = "rail" | "fab" | "off";
export const STORAGE_KEY_DESKTOP = "omp-minimap-desktop";
export const STORAGE_KEY_MOBILE_FAB = "omp-minimap-mobile-fab";
export const MINIMAP_PREF_CHANGE_EVENT = "omp-minimap-pref-change";
export const DEFAULT_DESKTOP_MODE: DesktopMinimapMode = "rail";
export const DEFAULT_MOBILE_FAB = false;
export interface ChatMinimapPreferenceState { desktopMode: DesktopMinimapMode; mobileFab: boolean }
const defaults: ChatMinimapPreferenceState = Object.freeze({ desktopMode: DEFAULT_DESKTOP_MODE, mobileFab: DEFAULT_MOBILE_FAB });
let snapshot = defaults;

let storageFailed = false;
export function storedChatMinimapPreference(): ChatMinimapPreferenceState {
  if (typeof window === "undefined") return defaults;
  if (storageFailed) return snapshot;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY_DESKTOP);
    const desktopMode = value === "rail" || value === "fab" || value === "off" ? value : DEFAULT_DESKTOP_MODE;
    const mobileFab = window.localStorage.getItem(STORAGE_KEY_MOBILE_FAB) === "true";
    if (snapshot.desktopMode !== desktopMode || snapshot.mobileFab !== mobileFab) snapshot = { desktopMode, mobileFab };
  } catch { storageFailed = true; }
  return snapshot;
}

function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY_DESKTOP || event.key === STORAGE_KEY_MOBILE_FAB) {
      storageFailed = false;
      listener();
    }
  };
  window.addEventListener("storage", storage);
  window.addEventListener(MINIMAP_PREF_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(MINIMAP_PREF_CHANGE_EVENT, listener);
  };
}

export function saveChatMinimapPreference(updates: Partial<ChatMinimapPreferenceState>): void {
  const current = storedChatMinimapPreference();
  snapshot = { ...current, ...updates };
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_DESKTOP, snapshot.desktopMode);
    window.localStorage.setItem(STORAGE_KEY_MOBILE_FAB, String(snapshot.mobileFab));
    storageFailed = false;
  } catch { storageFailed = true; }
  window.dispatchEvent(new Event(MINIMAP_PREF_CHANGE_EVENT));
}
export function useChatMinimapPreference() {
  const state = useSyncExternalStore(subscribe, storedChatMinimapPreference, () => defaults);
  const setDesktopMode = useCallback((desktopMode: DesktopMinimapMode) => saveChatMinimapPreference({ desktopMode }), []);
  const setMobileFab = useCallback((mobileFab: boolean) => saveChatMinimapPreference({ mobileFab }), []);
  return { ...state, setDesktopMode, setMobileFab };
}
