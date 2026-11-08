"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

/** Used only by the opt-in focused presentation. Preserve the message itself,
 * including its actions, metadata, source indices and live tool updates. */
export function AssistantOutputStep({ final, latest, children }: { final?: boolean; latest?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  return <div style={{ minWidth: 0, ...(final ? { borderLeft: "2px solid var(--accent)", paddingLeft: 10, marginTop: 6 } : {}) }}>
    {(final || latest) && <div style={{ color: final ? "var(--accent)" : "var(--text-muted)", fontSize: 10, fontWeight: 650, letterSpacing: "0.04em", margin: "4px 0" }}>{t(final ? "chatWindow.finalReply" : "chatWindow.latestOutput")}</div>}
    {children}
  </div>;
}
