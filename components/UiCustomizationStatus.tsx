"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { pollUiCustomizationStatus, type UiCustomizationStatus as CustomizationStatus } from "@/lib/ui-customization-client";

export function UiCustomizationStatus({ highlighted = false }: { highlighted?: boolean }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<CustomizationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);
  useEffect(() => pollUiCustomizationStatus((next) => {
    setStatus((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    setError(null);
  }, setError), []);

  const failure = error ?? status?.lastError;
  return (
    <section ref={ref} data-search-id="ui-customization" aria-label={t("uiCustomization.title")} className="settings-card" style={{
      display: "block", minWidth: 0, width: "100%", boxSizing: "border-box",
      overflowWrap: "anywhere", padding: 14,
      color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5,
      ...(highlighted ? { borderColor: "var(--accent)", boxShadow: "0 0 0 2px var(--accent)" } : {}),
    }}>
      <details open>
        <summary style={{ cursor: "pointer" }}>
          <span role="status" aria-live="polite">
            {t("uiCustomization.title")}{status
              ? ` · ${t("uiCustomization.revision", { revision: status.appliedRevision })}`
              : ` · ${t("uiCustomization.connecting")}`}
            {status?.deferredFiles.length ? ` · ${t("uiCustomization.deferred", { count: status.deferredFiles.length })}` : ""}
            {failure ? ` · ${t("uiCustomization.error")}` : ""}
          </span>
        </summary>
        {status && <>
          <div style={{ overflowWrap: "anywhere" }}>{t("uiCustomization.source")}: {status.sourceRoot}</div>
          {status.appliedFiles.length > 0 && <div>
            {t("uiCustomization.applied")}: <ul>{status.appliedFiles.map((file) => <li key={file}>{file}</li>)}</ul>
          </div>}
          {status.deferredFiles.length > 0 && <div>
            {t("uiCustomization.deferredExplanation")}
            <ul>{status.deferredFiles.map((file) => <li key={file}>{file}</li>)}</ul>
          </div>}
        </>}
        <div>{t("uiCustomization.fullReloadWarning")}</div>
      </details>
      {failure && <div role="alert" style={{ color: "var(--status-error)", overflowWrap: "anywhere" }}>{failure}</div>}
    </section>
  );
}
