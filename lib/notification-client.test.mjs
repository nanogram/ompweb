import assert from "node:assert/strict";
import test from "node:test";

const { showSystemNotification, dismissSystemNotification } = await import("./notification-client.ts");

function browser(t, registration) {
  const previous = new Map(["window", "navigator", "Notification", "CustomEvent"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const created = [];
  const events = [];
  class PageNotification {
    static permission = "granted";
    constructor(title, options) { this.title = title; this.data = options.data; this.options = options; this.closed = false; created.push(this); }
    close() { this.closed = true; this.onclose?.(); }
  }
  for (const [key, value] of Object.entries({
    window: { Notification: PageNotification, focus() {}, dispatchEvent: (event) => events.push(event) },
    navigator: { serviceWorker: { getRegistration: async () => registration } },
    Notification: PageNotification,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { created, events };
}

const notification = {
  title: "Continue?", body: "Waiting", tag: "session:input", sessionId: "session", url: "/?session=session",
  requestId: "request", dialog: { method: "confirm", requestId: "request" },
  actions: [{ action: "confirm", title: "Confirm" }], responses: { confirm: { confirmed: true } },
};

test("in-page service-worker notifications carry actionable answers and request-scoped retractions", async (t) => {
  const shown = [];
  const posted = [];
  const old = { data: { requestId: "request" }, closed: false, close() { this.closed = true; } };
  const newer = { data: { requestId: "newer" }, closed: false, close() { this.closed = true; } };
  browser(t, {
    showNotification: async (title, options) => shown.push({ title, options }),
    getNotifications: async ({ tag }) => { assert.equal(tag, "session:input"); return [old, newer]; },
    active: { postMessage: (message) => posted.push(message) },
  });
  assert.equal(await showSystemNotification(notification), true);
  assert.deepEqual(shown[0].options.data.responses, { confirm: { confirmed: true } });
  assert.equal(shown[0].options.data.requestId, "request");
  assert.deepEqual(shown[0].options.actions, notification.actions);
  await dismissSystemNotification("session:input", "request");
  assert.equal(old.closed, true);
  assert.equal(newer.closed, false);
  assert.deepEqual(posted, [{ type: "omp-notification-dismiss", tag: "session:input", requestId: "request" }]);
  await dismissSystemNotification("session:input", "request", false);
  assert.equal(posted.length, 1, "worker-originated retractions do not echo back forever");
});

test("workerless desktop notifications preserve click navigation and close only the settled request", async (t) => {
  const { created, events } = browser(t, undefined);
  assert.equal(await showSystemNotification(notification), true);
  assert.equal(created[0].data.requestId, "request");
  await dismissSystemNotification("session:input", "older");
  assert.equal(created[0].closed, false);
  created[0].onclick();
  assert.equal(events[0].type, "omp-open-session");
  assert.equal(events[0].detail, "session");
  assert.equal(await showSystemNotification({ ...notification, requestId: "next" }), true);
  await dismissSystemNotification("session:input", "next");
  assert.equal(created[1].closed, true);
});
