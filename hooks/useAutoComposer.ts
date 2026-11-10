"use client";

import { useCallback, useState } from "react";

/** An explicit expansion lasts only for this owner's current active interval. */
export function useAutoComposer(owner: string, running: boolean, waitingForInput: boolean) {
  const active = running && !waitingForInput;
  const [view, setView] = useState({ owner, active, expanded: false });
  const current = view.owner === owner && view.active === active;
  // Reset before committing a different owner/run, rather than showing a stale
  // override until an effect runs. The composer itself always stays mounted.
  if (!current) setView({ owner, active, expanded: false });
  const expand = useCallback(() => setView({ owner, active, expanded: true }), [owner, active]);
  return { minimized: active && (!current || !view.expanded), expand };
}
