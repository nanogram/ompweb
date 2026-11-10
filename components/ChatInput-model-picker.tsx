"use client";

import React, { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { displayThinkingLevel, selectableThinkingLevels } from "@/lib/thinking-levels";
import { ThinkingGlyph } from "./ThinkingGlyph";
import type { ModelOption } from "./ChatInput-model-options";

export interface ProviderModelGroup {
  provider: string;
  options: ModelOption[];
}

export function groupModelOptionsByProvider(options: ModelOption[]): ProviderModelGroup[] {
  const groups: ProviderModelGroup[] = [];
  const byProvider = new Map<string, ProviderModelGroup>();
  for (const option of options) {
    let group = byProvider.get(option.provider);
    if (!group) {
      group = { provider: option.provider, options: [] };
      byProvider.set(option.provider, group);
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}

/** Keep the current provider's models nearest the start of the list. */
export function orderProviderGroups(groups: ProviderModelGroup[], currentProvider: string | null | undefined): ProviderModelGroup[] {
  if (!currentProvider) return groups;
  const index = groups.findIndex((group) => group.provider === currentProvider);
  if (index <= 0) return groups;
  const next = [...groups];
  const [active] = next.splice(index, 1);
  next.unshift(active);
  return next;
}

export interface ModelPickerPanelProps {
  modelOptions: ModelOption[];
  currentModel?: { provider: string; modelId: string } | null;
  showModelsLoading?: boolean;
  onSelectModel?: (provider: string, modelId: string) => void;
  thinkingLevel?: string;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  onSelectThinkingLevel?: (level: string) => void;
  selectionPending?: boolean;
  onClose?: () => void;
}

export function ModelPickerPanel({
  modelOptions, currentModel, showModelsLoading,
  onSelectModel, thinkingLevel = "auto", availableThinkingLevels,
  thinkingLevelMap, onSelectThinkingLevel, selectionPending = false,
  onClose,
}: ModelPickerPanelProps) {
  const { t } = useI18n();
  const modelsRef = useRef<HTMLDivElement>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const wasPending = useRef(selectionPending);
  const groups = useMemo(
    () => orderProviderGroups(groupModelOptionsByProvider(modelOptions), currentModel?.provider),
    [modelOptions, currentModel?.provider],
  );
  const levels = useMemo(() => selectableThinkingLevels(availableThinkingLevels), [availableThinkingLevels]);

  const focusPane = useCallback((pane: HTMLDivElement | null) => {
    const options = Array.from(pane?.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]:not(:disabled)') ?? []);
    const selected = options.find((option) => option.getAttribute("aria-checked") === "true");
    (selected ?? options[0])?.focus();
  }, []);
  useLayoutEffect(() => {
    const completed = wasPending.current && !selectionPending;
    wasPending.current = selectionPending;
    const active = document.activeElement;
    if (completed && (active === document.body || (active && modelsRef.current?.contains(active)))) {
      focusPane(reasoningRef.current);
    }
  }, [selectionPending, focusPane]);
  const navigate = (event: React.KeyboardEvent<HTMLDivElement>, pane: HTMLDivElement | null) => {
    const options = Array.from(pane?.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]:not(:disabled)') ?? []);
    const index = options.indexOf(event.target as HTMLButtonElement);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusPane(event.key === "ArrowRight" ? reasoningRef.current : modelsRef.current);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : event.key === "ArrowDown" ? (index + 1) % options.length : (index - 1 + options.length) % options.length;
      options[next]?.focus();
    }
  };

  return (
    <div className="picker-model-reasoning-content" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose?.();
      }
    }}>
      {selectionPending && <div className="picker-update-status" role="status">{t("chatInput.updatingModel")}</div>}
      <div className="picker-nested" aria-busy={selectionPending}>
        <div ref={modelsRef} className="picker-nested-models" role="menu" aria-label={t("chatInput.modelsLabel")}
          onKeyDown={(event) => navigate(event, modelsRef.current)}>
          <div className="picker-pane-title">{t("chatInput.modelsLabel")}</div>
          {groups.length === 0 ? <div className="picker-empty">{showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}</div>
            : groups.map((group) => <React.Fragment key={group.provider}>
              <div className="picker-group-label">{group.provider}</div>
              {group.options.map((option) => {
                const active = option.provider === currentModel?.provider && option.modelId === currentModel?.modelId;
                return <button key={`${option.provider}:${option.modelId}`} type="button" className="picker-row"
                  role="menuitemradio" aria-checked={active} data-active={active}
                  disabled={selectionPending || !onSelectModel}
                  onClick={() => { if (!selectionPending) onSelectModel?.(option.provider, option.modelId); }}>
                  <span className="picker-check">{active && <Check size={11} strokeWidth={2.4} aria-hidden="true" />}</span>
                  <span className="picker-option-label" title={option.name || option.modelId}>{option.name || option.modelId}</span>
                </button>;
              })}
            </React.Fragment>)}
        </div>
        <div ref={reasoningRef} className="picker-nested-reasoning" role="menu" aria-label={t("chatInput.reasoningLabel")}
          onKeyDown={(event) => navigate(event, reasoningRef.current)}>
          <div className="picker-pane-title">{t("chatInput.reasoningLabel")}</div>
          {!onSelectThinkingLevel ? <div className="picker-empty">{t("chatInput.reasoningUnavailable")}</div>
            : levels.map((level) => {
              const active = level === thinkingLevel;
              const label = displayThinkingLevel(level, thinkingLevelMap);
              return <button key={level} type="button" className="picker-row" role="menuitemradio"
                aria-checked={active} data-active={active} disabled={selectionPending}
                onClick={() => { if (!selectionPending) onSelectThinkingLevel(level); }}>
                <span className="picker-check">{active && <Check size={11} strokeWidth={2.4} aria-hidden="true" />}</span>
                <ThinkingGlyph level={level} />
                <span className="picker-option-label" title={label}>{label}</span>
              </button>;
            })}
        </div>
      </div>
    </div>
  );
}
