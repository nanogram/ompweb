"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentMessage, TextContent } from "@/lib/types";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export interface NavNode { id: string; text: string; messageIndex: number; refIndex: number; isUser: boolean }
/**
 * Extracts a concise, clean single-line preview string suitable for the
 * floating context navigation pill (e.g. "move Explorer to right panel").
 */
export function extractPreviewText(msg: AgentMessage | Partial<AgentMessage>): string {
  let raw = "";

  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      raw = content;
    } else if (Array.isArray(content)) {
      raw = content
        .filter((b): b is TextContent => Boolean(b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string"))
        .map((b) => b.text)
        .join(" ");
    }
  } else if (msg.role === "assistant") {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter((b): b is TextContent => Boolean(b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string"))
      .map((b) => b.text)
      .join(" ");
    if (text) {
      raw = text;
    } else {
      const toolNames = blocks
        .filter((b) => Boolean(b && typeof b === "object" && "type" in b && b.type === "toolCall"))
        .map((b) => (b && typeof b === "object" && "toolName" in b && typeof b.toolName === "string" ? b.toolName : ""));
      if (toolNames.length) raw = toolNames.filter(Boolean).join(", ");
    }
  }

  // Strip markdown headers, code blocks, formatting, and flatten whitespace
  let clean = raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_`~[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) {
    clean = raw.replace(/\s+/g, " ").trim();
  }

  if (clean.length > 60) {
    return clean.slice(0, 58) + "…";
  }
  return clean;
}

export function outlineNodes(messages: AgentMessage[]): NavNode[] {
  const users: NavNode[] = [];
  let refIndex = 0;
  messages.forEach((message, messageIndex) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    const currentRef = refIndex++;
    if (message.role !== "user") return;
    const text = extractPreviewText(message);
    if (text) users.push({ id: `user-${messageIndex}`, text, messageIndex, refIndex: currentRef, isUser: true });
  });
  if (users.length) return users;
  const assistants: NavNode[] = [];
  refIndex = 0;
  messages.forEach((message, messageIndex) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    const currentRef = refIndex++;
    if (message.role !== "assistant") return;
    const text = extractPreviewText(message);
    if (text) assistants.push({ id: `assistant-${messageIndex}`, text, messageIndex, refIndex: currentRef, isUser: false });
  });
  return assistants;
}

/** Rail and FAB navigation use the same exact jump supplied by the renderer. */
export function useChatOutline({ messages, scrollContainer, messageRefs, onEnsureVisible }: {
  messages: AgentMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  onEnsureVisible: (messageIndex: number, smooth?: boolean) => void;
}) {
  const nodes = useMemo(() => outlineNodes(messages), [messages]);
  const [activeIndex, setActiveIndex] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  const scrollToNode = useCallback((node: NavNode, smooth = true) => {
    onEnsureVisible(node.messageIndex, smooth && !reducedMotion);
  }, [onEnsureVisible, reducedMotion]);
  const updateRef = useRef(() => {});
  updateRef.current = () => {
    const container = scrollContainer.current;
    if (!container || !nodes.length) return;
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 30) {
      setActiveIndex(nodes.length - 1);
      return;
    }
    const top = container.getBoundingClientRect().top;
    let best = 0;
    for (let index = 0; index < nodes.length; index++) {
      const element = messageRefs.current[nodes[index].refIndex];
      if (!element?.isConnected) continue;
      if (element.getBoundingClientRect().top - top > 120) break;
      best = index;
    }
    setActiveIndex(best);
  };
  useEffect(() => {
    const container = scrollContainer.current;
    if (!container) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; updateRef.current(); });
    };
    container.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(container);
    if (container.firstElementChild) observer?.observe(container.firstElementChild);
    schedule();
    return () => {
      container.removeEventListener("scroll", schedule);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollContainer, nodes]);
  return { nodes, activeIndex, setActiveIndex, scrollToNode };
}
