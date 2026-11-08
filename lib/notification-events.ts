import { isRecord } from "./type-guards";
import type { RpcAskDialogAnswer } from "./pi-types";

/**
 * Notification events shared by the server (detection, routing, push) and the
 * browser (in-app toasts, in-page system notifications, settings).
 */

export const NOTIFICATION_TYPES = ["completed", "input", "error", "modelSwitch"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** The same answer contract is used by the in-app dialog and notification route. */
export type ExtensionUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
  | { answers: RpcAskDialogAnswer[] };

export interface NotificationDialogQuestion {
  id: string;
  question: string;
  options?: string[];
  multi?: boolean;
  allowCustom?: boolean;
}

export interface NotificationDialog {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor" | "ask";
  title?: string;
  message?: string;
  options?: string[];
  questions?: NotificationDialogQuestion[];
  placeholder?: string;
  expiresAt?: number;
}

export interface NotificationEvent {
  /** `test` is only sent by the settings "Send test notification" button. */
  type: NotificationType | "test";
  sessionId: string;
  sessionName: string | null;
  /** Question, error text, or model-switch reason. */
  detail?: string;
  from?: string;
  to?: string;
  /** Earlier ids of this conversation (omp moved it to a new file); tabs may still show one. */
  aliases?: string[];
  requestId?: string;
  dialog?: NotificationDialog;
}

/** One entry of the persisted notification history; `id` is the replace-tag `<sessionId>:<type>`. */
export interface NotificationHistoryEntry {
  id: string;
  event: NotificationEvent;
  at: number;
  read: boolean;
}

export interface NotificationPrefs {
  enabled: boolean;
  types: Record<NotificationType, boolean>;
  /** While the user is active in another omp-web tab: in-app toast or system notification. */
  whenActive: "toast" | "system";
  /** UI locale, so pushes are written in the device's language. */
  locale: string;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: false,
  types: { completed: true, input: true, error: true, modelSwitch: false },
  whenActive: "toast",
  locale: "en",
};

/** Validate untrusted prefs (request bodies, localStorage); unknown fields fall back to defaults. */
export function parseNotificationPrefs(value: unknown): NotificationPrefs {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawTypes = raw.types && typeof raw.types === "object" ? (raw.types as Record<string, unknown>) : {};
  const types = { ...DEFAULT_NOTIFICATION_PREFS.types };
  for (const type of NOTIFICATION_TYPES) {
    if (typeof rawTypes[type] === "boolean") types[type] = rawTypes[type] as boolean;
  }
  return {
    enabled: raw.enabled === true,
    types,
    whenActive: raw.whenActive === "system" ? "system" : "toast",
    locale: typeof raw.locale === "string" && /^[A-Za-z-]{2,10}$/.test(raw.locale) ? raw.locale : "en",
  };
}

export interface RenderedNotification {
  title: string;
  body: string;
  url: string;
  tag: string;
  sessionId: string;
  requestId?: string;
  dialog?: NotificationDialog;
  actions?: { action: string; title: string }[];
  responses?: Record<string, ExtensionUiResponse>;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const MAX_DETAIL = 180;
/** Session names can be pasted at any length; push payloads are capped near 4 KB. */
const MAX_TITLE = 100;

function clip(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Title, body, click target, and replace-tag for one event in the caller's language. */
export function renderNotification(event: NotificationEvent, t: Translate): RenderedNotification {
  const detail = event.detail ? clip(event.detail) : "";
  let body: string;
  switch (event.type) {
    case "completed":
      body = t("notifications.completedBody");
      break;
    case "input":
      body = detail ? t("notifications.inputBody", { detail }) : t("notifications.inputBodyNoDetail");
      break;
    case "error":
      body = detail ? t("notifications.errorBody", { detail }) : t("notifications.errorBodyNoDetail");
      break;
    case "modelSwitch":
      if (event.from && event.to) {
        body = detail
          ? t("notifications.modelSwitchBody", { from: event.from, to: event.to, detail })
          : t("notifications.modelSwitchBodyNoDetail", { from: event.from, to: event.to });
      } else {
        body = detail;
      }
      break;
    case "test":
      body = t("notifications.testBody");
      break;
  }
  const actions: NonNullable<RenderedNotification["actions"]> = [];
  const responses: Record<string, ExtensionUiResponse> = {};
  if (event.dialog?.method === "confirm") {
    actions.push({ action: "confirm", title: t("chatWindow.confirm") }, { action: "decline", title: t("chatWindow.cancel") });
    responses.confirm = { confirmed: true };
    responses.decline = { confirmed: false };
  } else if (event.dialog?.method === "select" && event.dialog.options && event.dialog.options.length <= 2) {
    event.dialog.options.forEach((value, index) => {
      const action = `option-${index}`;
      actions.push({ action, title: value });
      responses[action] = { value };
    });
  }
  return {
    title: (event.sessionName && clip(event.sessionName, MAX_TITLE)) || t("notifications.untitledSession"),
    body,
    url: event.sessionId ? `/?session=${encodeURIComponent(event.sessionId)}` : "/",
    tag: `${event.sessionId}:${event.type}`,
    sessionId: event.sessionId,
    ...(event.requestId ? { requestId: event.requestId } : {}),
    ...(event.dialog ? { dialog: event.dialog } : {}),
    ...(actions.length ? { actions, responses } : {}),
  };
}

const MODEL_SWITCH_NOTICE_SOURCES = new Set(["prewalk", "plan-yolo"]);

/** Extension UI methods that block the agent until the user answers (rpc-manager replays these too). */
export const BLOCKING_UI_METHODS = new Set(["select", "confirm", "input", "editor", "ask", "open_url"]);

const NOTIFICATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Client and device ids: generated by the browser, checked by the server. */
export function isValidNotificationId(value: unknown): value is string {
  return typeof value === "string" && NOTIFICATION_ID_PATTERN.test(value);
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };
const dialogEncoder = new TextEncoder();

function dialogText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? clip(text, max) : undefined;
}

/** Answer labels and ids are never clipped or normalized. */
function exactOptions(value: unknown, count: number, chars: number): string[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > count) return undefined;
  const labels: string[] = [];
  for (const entry of value) {
    const label = typeof entry === "string" ? entry : isRecord(entry) ? entry.label : undefined;
    if (typeof label !== "string" || !label.length || label.length > chars) return undefined;
    labels.push(label);
  }
  return labels;
}

/** Oversize/incomplete dialogs remain open-only notifications, never partial answers. */
export function buildNotificationDialog(frame: Record<string, unknown>): NotificationDialog | undefined {
  if (typeof frame.method !== "string" || !Object.hasOwn(DIALOG_METHODS, frame.method)) return undefined;
  if (typeof frame.id !== "string" || !frame.id || frame.id.trim() !== frame.id || frame.id.length > 128) return undefined;
  const dialog: NotificationDialog = { requestId: frame.id, method: frame.method as NotificationDialog["method"] };
  const title = dialogText(frame.title, 160);
  if (title) dialog.title = title;
  switch (dialog.method) {
    case "select": {
      const options = exactOptions(frame.options, 12, 160);
      if (!options) return undefined;
      dialog.options = options;
      break;
    }
    case "confirm": {
      const message = dialogText(frame.message, 480);
      if (message) dialog.message = message;
      break;
    }
    case "input": {
      const placeholder = dialogText(frame.placeholder, 80);
      if (placeholder) dialog.placeholder = placeholder;
      break;
    }
    case "ask": {
      if (!Array.isArray(frame.questions) || !frame.questions.length || frame.questions.length > 5) return undefined;
      const questions: NotificationDialogQuestion[] = [];
      const ids = new Set<string>();
      for (const raw of frame.questions) {
        if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || raw.id.trim() !== raw.id || raw.id.length > 128 || ids.has(raw.id)) return undefined;
        const question = dialogText(raw.question, 240);
        if (!question) return undefined;
        ids.add(raw.id);
        const entry: NotificationDialogQuestion = { id: raw.id, question };
        if (raw.options !== undefined && raw.options !== null) {
          if (!Array.isArray(raw.options)) return undefined;
          if (raw.options.length) {
            const options = exactOptions(raw.options, 9, 120);
            if (!options) return undefined;
            entry.options = options;
          }
        }
        if (raw.multi === true) entry.multi = true;
        if (raw.allowCustom !== false) entry.allowCustom = true;
        questions.push(entry);
      }
      dialog.questions = questions;
      break;
    }
  }
  if (!dialog.title && !dialog.message && !dialog.placeholder && !dialog.options && !dialog.questions) return undefined;
  if (typeof frame.expiresAt === "number" && Number.isFinite(frame.expiresAt) && frame.expiresAt > 0) dialog.expiresAt = frame.expiresAt;
  return dialogEncoder.encode(JSON.stringify(dialog)).byteLength <= 1800 ? dialog : undefined;
}

type Detect = (frame: Record<string, unknown>, session: { sessionId: string; sessionName: string | null }) => NotificationEvent[];

/**
 * Per-session detector: feed it every top-level rpc-ui frame in order. Subagent
 * activity arrives wrapped in `subagent_*` frames and is never inspected.
 *
 * "completed" fires on `session_settled` (the run and any background work it
 * started are done), unless the last prompt in that stretch failed or was
 * aborted. Errors fire on the failing `prompt_result` itself.
 *
 * omp announces a retry fallback (`retry_fallback_applied`) before the
 * `auto_retry_start` carrying the error that caused it, so a fallback without
 * its own `reason` waits for that frame and takes its error as the reason.
 */
export function createNotificationDetector(): Detect {
  let lastOutcome: string | null = null;
  let heldFallback: NotificationEvent | null = null;
  /** omp-web already reported this run's failure (from a failed `response`); its `prompt_result` must not repeat it. */
  let failureReported = false;

  const releaseFallback = (detail?: string): NotificationEvent[] => {
    const held = heldFallback;
    heldFallback = null;
    return held ? [{ ...held, detail }] : [];
  };

  return (frame, { sessionId, sessionName }) => {
    const base = { sessionId, sessionName };
    switch (frame.type) {
      case "agent_start":
        failureReported = false;
        return [];
      // omp-web's own frames: an async prompt failure (`response` with
      // success: false) and the omp child exiting mid-run.
      case "prompt_error":
      case "process_exit": {
        const events = releaseFallback();
        lastOutcome = "error";
        if (failureReported) return events;
        failureReported = true;
        return [...events, { ...base, type: "error", detail: str(frame.errorMessage) ?? str(frame.detail) }];
      }
      case "auto_retry_start":
        return releaseFallback(str(frame.errorMessage));
      case "retry_fallback_applied": {
        const from = str(frame.from);
        const to = str(frame.to);
        if (!from || !to) return [];
        const event: NotificationEvent = { ...base, type: "modelSwitch", from, to };
        const reason = str(frame.reason);
        if (reason) return [...releaseFallback(), { ...event, detail: reason }];
        const earlier = releaseFallback();
        heldFallback = event;
        return earlier;
      }
      case "notice": {
        const source = str(frame.source);
        const message = str(frame.message);
        if (!source || !message || !MODEL_SWITCH_NOTICE_SOURCES.has(source)) return [];
        return [{ ...base, type: "modelSwitch", detail: message }];
      }
      case "prompt_result": {
        const events = releaseFallback();
        if (frame.agentInvoked !== true) return events;
        lastOutcome = str(frame.status) ?? null;
        if (lastOutcome !== "error" || failureReported) return events;
        failureReported = true;
        return [...events, { ...base, type: "error", detail: isRecord(frame.error) ? str(frame.error.message) : undefined }];
      }
      case "auto_retry_end":
        return releaseFallback();
      case "session_settled": {
        const events = releaseFallback();
        const outcome = lastOutcome;
        lastOutcome = null;
        failureReported = false;
        if (outcome === "error" || outcome === "aborted") return events;
        return [...events, { ...base, type: "completed" }];
      }
      case "extension_ui_request": {
        // Only reached for requests that wait on the user (omp-web answers
        // auto-approved ones before they are emitted).
        if (typeof frame.method !== "string" || !BLOCKING_UI_METHODS.has(frame.method)) return [];
        const firstQuestion = Array.isArray(frame.questions) && isRecord(frame.questions[0]) ? str(frame.questions[0].question) : undefined;
        const event: NotificationEvent = { ...base, type: "input", detail: str(frame.title) ?? firstQuestion ?? str(frame.message) ?? str(frame.instructions) };
        if (typeof frame.id === "string" && frame.id) event.requestId = frame.id;
        const dialog = buildNotificationDialog(frame);
        if (dialog) event.dialog = dialog;
        return [event];
      }
      default:
        return [];
    }
  };
}
