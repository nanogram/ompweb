"use client";

import { useEffect, useMemo, useState } from "react";
import { composerModelPreference } from "@/lib/composer-model-preference";
import { COMPOSER_MODELS_CHANGED_EVENT, COMPOSER_MODELS_STORAGE_KEY } from "@/lib/composer-model-visibility";

export function useComposerModelPreference() {
  const [preference, setPreference] = useState(composerModelPreference.getSnapshot);
  useEffect(() => {
    const unsubscribe = composerModelPreference.subscribe(() => setPreference(composerModelPreference.getSnapshot()));
    setPreference(composerModelPreference.getSnapshot());
    const refresh = () => { void composerModelPreference.refresh(); };
    const refreshVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const refreshStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === COMPOSER_MODELS_STORAGE_KEY) refresh();
    };
    refresh();
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("online", refreshVisible);
    window.addEventListener(COMPOSER_MODELS_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refreshStorage);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener("online", refreshVisible);
      window.removeEventListener(COMPOSER_MODELS_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refreshStorage);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, []);
  const visibleModelKeys = useMemo(() => preference.keys === null ? null : new Set(preference.keys), [preference.keys]);
  return {
    ...preference,
    visibleModelKeys,
    refresh: composerModelPreference.refresh,
    save: composerModelPreference.save,
  };
}
