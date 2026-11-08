"use client";

import { memo, useEffect, useId, useRef, useState, type RefObject } from "react";
import { ListTree, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useChatOutline } from "@/hooks/useChatOutline";
import type { AgentMessage } from "@/lib/types";

export const ChatOutlineFab = memo(function ChatOutlineFab({ messages, scrollContainer, messageRefs, nearBottom, isMobile, onEnsureVisible }: {
  messages: AgentMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  nearBottom: boolean;
  isMobile: boolean;
  onEnsureVisible: (messageIndex: number, smooth?: boolean) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { nodes, activeIndex, scrollToNode } = useChatOutline({ messages, scrollContainer, messageRefs, onEnsureVisible });
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const close = () => { setOpen(false); button.current?.focus({ preventScroll: true }); };

  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!popup.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus({ preventScroll: true });
    };
    window.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", keyboard, true);
    popup.current?.querySelector<HTMLButtonElement>(`[data-outline-index="${activeIndexRef.current}"]`)?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", keyboard, true);
    };
    // Focus on opening only, not while the user scrolls the conversation.
  }, [open]);

  useEffect(() => {
    const container = list.current;
    const active = container?.querySelector<HTMLElement>(`[data-outline-index="${activeIndex}"]`);
    if (open && container && active) container.scrollTop = Math.max(0, active.offsetTop - container.offsetTop - container.clientHeight / 2 + active.offsetHeight / 2);
  }, [open, activeIndex]);

  if (!nodes.length) return null;
  const right = isMobile ? 16 : 48;
  return <>
    <button ref={button} type="button" className="ui-focus-ring" title={t("chatOutline.toggleTitle")} aria-label={t("chatOutline.toggleTitle")} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)} style={{ position: "absolute", zIndex: 35, right, bottom: nearBottom ? 16 : 60, width: isMobile ? 44 : 36, height: isMobile ? 44 : 36, display: "grid", placeItems: "center", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: open ? "var(--accent)" : "var(--text-muted)", boxShadow: "var(--shadow-pop)", cursor: "pointer" }}>
      <ListTree size={16} aria-hidden="true" />
    </button>
    {open && <div id={id} ref={popup} role="dialog" aria-label={t("chatOutline.title")} style={{ position: "absolute", zIndex: 40, right, bottom: nearBottom ? 68 : 112, width: "min(340px, calc(100vw - 32px))", maxHeight: "min(55dvh, 460px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-pop)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 13, fontWeight: 650 }}>{t("chatOutline.title")} · {nodes.length}</span>
        <button type="button" aria-label={t("chatOutline.close")} onClick={close} className="ui-focus-ring" style={{ width: 36, height: 36, display: "grid", placeItems: "center", border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}><X size={16} aria-hidden="true" /></button>
      </div>
      <div ref={list} style={{ overflowY: "auto", padding: 6, minHeight: 0 }}>
        {nodes.map((node, index) => <button key={node.id} type="button" data-outline-index={index} aria-current={activeIndex === index ? "location" : undefined} aria-label={`${t("chatOutline.jumpTo")} ${node.text}`} onClick={() => { scrollToNode(node); close(); }} className="ui-focus-ring" style={{ display: "flex", width: "100%", gap: 8, padding: "10px", minHeight: 44, textAlign: "left", border: 0, borderRadius: "var(--radius-control)", background: activeIndex === index ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "transparent", color: "var(--text)", cursor: "pointer", fontSize: 12, overflowWrap: "anywhere" }}>
          <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>#{index + 1}</span><span>{node.text}</span>
        </button>)}
      </div>
    </div>}
  </>;
});
