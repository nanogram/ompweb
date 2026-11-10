"use client";

// Composer-attached native pending queue. Once omp consumes a message, its
// transcript owns the display; the ledger is not a second execution history.

import React, { useState } from "react";
import { ChevronDown, Circle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { QueuePanelItem } from "@/lib/queue-progress";
import { QueuedActionButton } from "./ChatInput-banners";

export interface QueuedEntry {
  kind: "follow-up" | "steer";
  text: string;
}

interface QueueProgressPanelProps {
  items: QueuePanelItem[];
  /** A queue mutation is awaiting omp's answer. */
  actionPending: boolean;
  canRemove: boolean;
  canPromote: boolean;
  /** Steering is refused right now (e.g. a dictation is still submitting). */
  promoteBlocked: boolean;
  onAction: (entry: QueuedEntry, action: "edit" | "steer") => void;
  onDelete: (entry: QueuedEntry) => void;
}

function PendingIcon({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-queue-status="queued"
      style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-dim)" }}
    >
      <Circle size={10} strokeWidth={2} aria-hidden />
    </span>
  );
}

export function QueueProgressPanel({
  items, actionPending, canRemove, canPromote, promoteBlocked, onAction, onDelete,
}: QueueProgressPanelProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((current) => !current);
  const current = items[0];
  if (!current) return null;

  const renderItem = (item: QueuePanelItem) => {
    const entry: QueuedEntry = { kind: item.queue === "steering" ? "steer" : "follow-up", text: item.text };
    const steer = entry.kind === "steer";
    return (
      <div
        key={item.id}
        data-queue-item={item.status}
        style={{
          padding: "4px 8px 4px 12px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
          background: "var(--bg-panel)",
          fontSize: 12,
        }}
      >
        <PendingIcon label={t("chatInput.queueStatus.queued")} />
        <span style={{
          flexShrink: 0,
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          padding: "1px 4px",
          borderRadius: 4,
          background: steer ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "var(--bg)",
          border: `1px solid ${steer ? "var(--accent)" : "var(--border)"}`,
          color: steer ? "var(--accent)" : "var(--text-muted)",
        }}>
          {steer ? t("chatInput.queuedSteer") : t("chatInput.queuedFollowUp")}
        </span>
        <span
          title={item.text}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
          }}
        >
          {item.text}
        </span>
        {item.actionable && (
          <>
            <QueuedActionButton disabled={actionPending || !canRemove} onClick={() => onAction(entry, "edit")} title={t("chatInput.queuedEditTitle")}>
              {t("chatInput.queuedEdit")}
            </QueuedActionButton>
            <QueuedActionButton disabled={actionPending || !canRemove} onClick={() => onDelete(entry)} title={t("chatInput.queuedDeleteTitle")}>
              {t("chatInput.queuedDelete")}
            </QueuedActionButton>
            {!steer && (
              <QueuedActionButton disabled={promoteBlocked || actionPending || !canPromote} onClick={() => onAction(entry, "steer")} title={t("chatInput.queuedSteerTitle")} accent>
                {t("chatInput.queuedSteerAction")}
              </QueuedActionButton>
            )}
          </>
        )}
      </div>
    );
  };


  return (
    <div
      aria-label={t("chatInput.queuedPrompts")}
      style={{
        border: "1px solid var(--border)",
        borderBottom: "none",
        borderRadius: "var(--radius-card) var(--radius-card) 0 0",
        background: "var(--bg-panel)",
        overflow: "hidden",
      }}
    >
      {items.length === 1 ? (
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0, padding: "1px 0" }}>{renderItem(items[0])}</div>
        </div>
      ) : (
        <>
          <div style={{
            padding: "5px 8px 5px 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            borderBottom: expanded ? "1px solid var(--border)" : "none",
          }}>
            <button
              type="button"
              onClick={toggle}
              aria-expanded={expanded}
              title={expanded ? t("chatInput.collapseQueued") : t("chatInput.expandQueued")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--text-muted)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                minWidth: 0,
                flex: 1,
                textAlign: "left",
              }}
            >
              <ChevronDown
                size={13}
                strokeWidth={2}
                style={{
                  transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
                  transition: "transform var(--dur-fast) var(--ease-out-warm)",
                  flexShrink: 0,
                }}
                aria-hidden
              />
              <span style={{ flexShrink: 0 }}>{t("chatInput.queuedPrompts")}</span>
              <span
                style={{ flexShrink: 0, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, textTransform: "none", letterSpacing: 0 }}
              >
                {items.length}
              </span>
              {!expanded && current && (
                <span style={{
                  marginLeft: 4,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  minWidth: 0,
                  color: "var(--text-dim)",
                  fontSize: 11,
                  fontWeight: 400,
                  textTransform: "none",
                  letterSpacing: 0,
                }}>
                  <PendingIcon label={t("chatInput.queueStatus.queued")} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {current.queue === "steering" ? `[${t("chatInput.queuedSteer")}] ` : ""}{current.text}
                  </span>
                </span>
              )}
            </button>
            <button
                type="button"
                onClick={toggle}
                style={{
                  background: "none",
                  border: "none",
                  padding: "2px 6px",
                  cursor: "pointer",
                  color: "var(--text-dim)",
                  fontSize: 11,
                  flexShrink: 0,
                }}
              >
                {expanded ? t("chatInput.collapseQueued") : t("chatInput.expandQueued")}
            </button>
          </div>
          {expanded && (
            <div style={{
              maxHeight: 180,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 1,
              background: "var(--bg-subtle)",
              padding: "4px 0",
            }}>
              {items.map(renderItem)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
