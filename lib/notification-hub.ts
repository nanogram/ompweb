import webpush from "web-push";
import en from "./i18n/locales/en.json";
import ja from "./i18n/locales/ja.json";
import zhCN from "./i18n/locales/zh-CN.json";
import zhTW from "./i18n/locales/zh-TW.json";
import {
  renderNotification,
  isValidNotificationId,
  type NotificationEvent,
  type RenderedNotification,
} from "./notification-events";
import { dropDeviceSubscription, getDevice, getVapidKeys, listDevices, listHistory, markHistoryRead, recordHistory, type NotificationDevice } from "./notification-store";

/**
 * Server side of notifications: presence of open tabs, per-device preferences
 * and Web Push subscriptions, and routing each event to an in-app toast, an
 * in-page system notification, or a push.
 */

/** A tab counts as present this long after its last presence report. */
export const PRESENCE_TTL_MS = 60_000;
const PUSH_TTL_SECONDS = 3600;
const PUSH_TIMEOUT_MS = 10_000;
/** Waits before each retry of a push the push service never answered or answered 429/5xx. Well inside the TTL. */
export const PUSH_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
/** Covers every possible in-flight push attempt and its retry backoffs. */
export const PUSH_RETRACTION_TTL_MS = PUSH_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)
  + (PUSH_RETRY_DELAYS_MS.length + 1) * PUSH_TIMEOUT_MS;
// Apple's push service rejects VAPID subjects it cannot resolve (e.g. localhost mail).
const VAPID_SUBJECT = "https://github.com/kahme247/ompweb";

/** What a tab last reported. Written only by presence reports, pruned by TTL. */
export interface NotificationPresence {
  clientId: string;
  deviceId: string;
  visible: boolean;
  sessionId: string | null;
  /** Per-tab report counter: requests can arrive out of order, and only the newest counts. */
  seq: number;
  lastSeen: number;
}

export type NotificationMessage =
  | { kind: "toast" | "os"; event: NotificationEvent }
  | { kind: "dismiss"; tag: string; sessionId: string; requestId: string };

type Send = (message: NotificationMessage) => void;

export type Delivery =
  | { kind: "toast" | "os"; clientId: string }
  | { kind: "push"; deviceId: string };

interface HubState {
  presence: Map<string, NotificationPresence>;
  /** Open SSE streams per tab. Independent of presence: streams reconnect, overlap, and close while the tab stays put. */
  streams: Map<string, Set<Send>>;
  streamDevices: Map<string, string | undefined>;
  streamBindings: Map<Send, string | undefined>;
  retractions: Map<string, number>;
}

declare global {
  var __ompNotificationHub: HubState | undefined;
}

function hub(): HubState {
  const state = (globalThis.__ompNotificationHub ??= { presence: new Map(), streams: new Map(), streamDevices: new Map(), streamBindings: new Map(), retractions: new Map() });
  state.streamDevices ??= new Map();
  state.streamBindings ??= new Map();
  state.retractions ??= new Map();
  return state;
}

export function getVapidPublicKey(): string {
  return getVapidKeys(webpush.generateVAPIDKeys).publicKey;
}

// ---------------------------------------------------------------- presence and streams

function livePresence(now: number): NotificationPresence[] {
  const { presence } = hub();
  for (const [id, entry] of presence) {
    if (now - entry.lastSeen > PRESENCE_TTL_MS) presence.delete(id);
  }
  return [...presence.values()];
}

export function reportPresence(report: Omit<NotificationPresence, "lastSeen">): void {
  const { presence } = hub();
  const current = presence.get(report.clientId);
  if (current && current.seq > report.seq) return;
  presence.set(report.clientId, { ...report, lastSeen: Date.now() });
}

/** Declared devices must already be registered, including for direct hub callers. */
export function attachNotificationClient(clientId: string, send: Send, deviceId?: string): () => void {
  if (deviceId !== undefined && (!isValidNotificationId(deviceId) || !getDevice(deviceId))) {
    throw new Error("Invalid or unregistered notification device");
  }
  const state = hub();
  if (deviceId !== undefined && state.streamDevices.get(clientId) !== undefined && state.streamDevices.get(clientId) !== deviceId) {
    throw new Error("Notification client is already bound to another device");
  }
  const own = state.streams.get(clientId) ?? new Set();
  own.add(send);
  state.streams.set(clientId, own);
  state.streamBindings.set(send, deviceId);
  state.streamDevices.set(clientId, deviceId ?? state.streamDevices.get(clientId));
  return () => {
    own.delete(send);
    state.streamBindings.delete(send);
    if (own.size === 0 && state.streams.get(clientId) === own) {
      state.streams.delete(clientId);
      state.streamDevices.delete(clientId);
    } else if (state.streams.get(clientId) === own) {
      let remainingDevice: string | undefined;
      for (const remaining of own) {
        remainingDevice = state.streamBindings.get(remaining);
        if (remainingDevice !== undefined) break;
      }
      state.streamDevices.set(clientId, remainingDevice);
    }
  };
}

// ---------------------------------------------------------------- routing

/** A visible tab is showing the event's conversation (under any of its ids). */
function isOnScreen(event: NotificationEvent, presence: NotificationPresence[]): boolean {
  const viewedAs = new Set([event.sessionId, ...(event.aliases ?? [])]);
  return presence.some((tab) => tab.visible && tab.sessionId !== null && viewedAs.has(tab.sessionId));
}

/**
 * Decide where one event goes. `reachable` maps open streams to declared devices.
 * 1. A visible tab is showing the session: nothing, for every device.
 * 2. The user is active in some reachable tab and the device prefers toasts:
 *    toast to that device's active tabs only (other devices stay quiet).
 * 3. Otherwise a system notification: push when the device has a
 *    subscription, else in-page on each of its reachable tabs.
 */
export function routeNotification(event: NotificationEvent, presence: NotificationPresence[], reachable: ReadonlyMap<string, string | undefined>, devices: NotificationDevice[]): Delivery[] {
  if (event.type === "test") return [];
  if (isOnScreen(event, presence)) return [];
  const active = presence.filter((tab) => tab.visible && reachable.has(tab.clientId));
  const presenceById = new Map(presence.map((tab) => [tab.clientId, tab]));
  const deliveries: Delivery[] = [];
  for (const device of devices) {
    if (!device.prefs.enabled || !device.prefs.types[event.type]) continue;
    if (active.length > 0 && device.prefs.whenActive === "toast") {
      for (const tab of active) if ((reachable.get(tab.clientId) ?? tab.deviceId) === device.deviceId) deliveries.push({ kind: "toast", clientId: tab.clientId });
    } else if (device.subscription) {
      deliveries.push({ kind: "push", deviceId: device.deviceId });
    } else {
      for (const [clientId, declaredDevice] of reachable) {
        const tab = presenceById.get(clientId);
        // A declared binding is authoritative, not a contradictory presence report.
        if ((declaredDevice ?? tab?.deviceId) === device.deviceId) deliveries.push({ kind: "os", clientId });
      }
    }
  }
  return deliveries;
}

const dictionaries: Record<string, Record<string, string>> = { en, ja, "zh-CN": zhCN, "zh-TW": zhTW };

function renderFor(event: NotificationEvent, locale: string): RenderedNotification {
  const dictionary = Object.hasOwn(dictionaries, locale) ? dictionaries[locale] : dictionaries.en;
  return renderNotification(event, (key, vars) => {
    const template = dictionary[key] ?? dictionaries.en[key] ?? key;
    return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : template;
  });
}

/** `String()` of Node's multi-address connect failure is just "AggregateError"; name each address's cause instead. */
function describePushError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) return error.errors.map(describePushError).join("; ");
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** The device still wants pushes at this endpoint; false when the store cannot tell. */
function stillSubscribed(deviceId: string, endpoint: string): boolean {
  try {
    const device = getDevice(deviceId);
    return device?.prefs.enabled === true && device.subscription?.endpoint === endpoint;
  } catch {
    return false;
  }
}

/** Never throws: a failed push must not break delivery to anyone else. */
async function sendPush(device: NotificationDevice, event: NotificationEvent, retryDelaysMs: readonly number[] = []): Promise<{ ok: true } | { ok: false; error: string }> {
  const subscription = device.subscription;
  if (!subscription) return { ok: false, error: "no push subscription" };
  for (let attempt = 0; ; attempt++) {
    if (event.type === "input" && event.requestId && isRetracted(event.sessionId, event.requestId)) {
      return { ok: false, error: "dialog settled" };
    }
    try {
      const { publicKey, privateKey } = getVapidKeys(webpush.generateVAPIDKeys);
      // `type` lets the service worker tell open tabs which kind of entry to list.
      const payload = { ...renderFor(event, device.prefs.locale), type: event.type };
      // Action labels/responses repeat exact option strings; fall back to Open as a whole.
      let payloadText = JSON.stringify(payload);
      if (Buffer.byteLength(payloadText, "utf8") > 3800) {
        delete payload.dialog;
        delete payload.actions;
        delete payload.responses;
        payloadText = JSON.stringify(payload);
      }
      await webpush.sendNotification(subscription, payloadText, {
        TTL: PUSH_TTL_SECONDS,
        urgency: event.type === "input" || event.type === "error" ? "high" : "normal",
        timeout: PUSH_TIMEOUT_MS,
        vapidDetails: { subject: VAPID_SUBJECT, publicKey, privateKey },
      });
      // Settlement can race an in-flight HTTP attempt. Retract after acceptance too.
      if (event.type === "input" && event.requestId && isRetracted(event.sessionId, event.requestId)) {
        await sendDismissPush(device, event.sessionId, event.requestId);
      }
      return { ok: true };
    } catch (error) {
      const status = error instanceof webpush.WebPushError ? error.statusCode : undefined;
      try {
        // 404/410: the browser unsubscribed or the subscription expired.
        if (status === 404 || status === 410) dropDeviceSubscription(device.deviceId, subscription.endpoint);
      } catch {
        // A store write failure only delays the cleanup to the next push.
      }
      const message = status ? `push service answered ${status}` : describePushError(error);
      // No answer (offline, DNS, timeout) or a busy push service: the next attempt may get through.
      const delay = status === undefined || status === 429 || status >= 500 ? retryDelaysMs[attempt] : undefined;
      if (delay === undefined) {
        console.warn("[notifications] push failed:", message);
        return { ok: false, error: message };
      }
      console.warn(`[notifications] push failed, retrying in ${delay / 1000}s:`, message);
      await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
      if (!stillSubscribed(device.deviceId, subscription.endpoint)) return { ok: false, error: message };
    }
  }
}

/** Never throws: callers publish from the RPC frame path, and a store failure must not cost them the frame. */
export function publishNotification(event: NotificationEvent): void {
  const state = hub();
  let devices: NotificationDevice[] = [];
  try {
    devices = listDevices();
  } catch (error) {
    console.warn("[notifications] store unavailable:", error);
  }
  const presence = livePresence(Date.now());
  // The Notifications tab lists what a device asked for, received or not; one the user watched happen is already read.
  const { type } = event;
  if (type !== "test" && devices.some((device) => device.prefs.enabled && device.prefs.types[type])) {
    try {
      recordHistory(event, { read: isOnScreen(event, presence) });
    } catch (error) {
      console.warn("[notifications] history write failed:", error);
    }
  }
  const reachable = new Map([...state.streams.keys()].map((id) => [id, state.streamDevices.get(id)]));
  for (const delivery of routeNotification(event, presence, reachable, devices)) {
    if (delivery.kind === "push") {
      const device = devices.find((entry) => entry.deviceId === delivery.deviceId);
      if (device) void sendPush(device, event, PUSH_RETRY_DELAYS_MS);
      continue;
    }
    for (const send of state.streams.get(delivery.clientId) ?? []) {
      try {
        send({ kind: delivery.kind, event });
      } catch {
        // A closing stream must not break delivery to the others.
      }
    }
  }
}

function retractionKey(sessionId: string, requestId: string): string {
  return JSON.stringify([sessionId, requestId]);
}

function isRetracted(sessionId: string, requestId: string): boolean {
  const at = hub().retractions.get(retractionKey(sessionId, requestId));
  return at !== undefined && Date.now() - at <= PUSH_RETRACTION_TTL_MS;
}

/** iOS requires visible pushes; retract there over an open stream, never a silent push. */
export function isApplePushEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "web.push.apple.com" || host.endsWith(".push.apple.com");
  } catch {
    return false;
  }
}

async function sendDismissPush(device: NotificationDevice, sessionId: string, requestId: string): Promise<void> {
  if (!device.subscription || isApplePushEndpoint(device.subscription.endpoint)) return;
  try {
    const { publicKey, privateKey } = getVapidKeys(webpush.generateVAPIDKeys);
    await webpush.sendNotification(device.subscription, JSON.stringify({ type: "dismiss", tag: `${sessionId}:input`, sessionId, requestId }), {
      TTL: PUSH_TTL_SECONDS, urgency: "normal", timeout: PUSH_TIMEOUT_MS,
      vapidDetails: { subject: VAPID_SUBJECT, publicKey, privateKey },
    });
  } catch (error) {
    console.warn("[notifications] dismiss push failed:", describePushError(error));
  }
}

/** Retractions ignore presence and current prefs: a previously delivered dialog is now gone. */
export function publishNotificationDismiss(sessionId: string, requestId: string): void {
  const state = hub();
  const now = Date.now();
  for (const [key, at] of state.retractions) if (now - at > PUSH_RETRACTION_TTL_MS) state.retractions.delete(key);
  state.retractions.set(retractionKey(sessionId, requestId), now);
  const tag = `${sessionId}:input`;
  try {
    if (listHistory().some((entry) => entry.id === tag && entry.event.requestId === requestId)) markHistoryRead([tag]);
  } catch (error) {
    console.warn("[notifications] history read mark failed:", error);
  }
  for (const sends of state.streams.values()) {
    for (const send of sends) {
      try { send({ kind: "dismiss", tag, sessionId, requestId }); } catch { /* Closing stream. */ }
    }
  }
  try {
    for (const device of listDevices()) void sendDismissPush(device, sessionId, requestId);
  } catch (error) {
    console.warn("[notifications] store unavailable:", error);
  }
}

/** Settings "Send test notification" for a device with push: reports whether the push service accepted it.
 * One attempt, so the button answers at once. */
export async function sendTestPush(deviceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const device = getDevice(deviceId);
  if (!device) return { ok: false, error: "unknown device" };
  return sendPush(device, { type: "test", sessionId: "", sessionName: "omp web" });
}
