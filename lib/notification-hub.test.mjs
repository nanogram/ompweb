import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import test from "node:test";

const hub = await import("./notification-hub.ts");
const { DEFAULT_NOTIFICATION_PREFS } = await import("./notification-events.ts");
const store = await import("./notification-store.ts");
const webpush = (await import("web-push")).default;

const event = { type: "completed", sessionId: "s1", sessionName: "Session" };
const prefs = (patch = {}) => ({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true, ...patch });
const tab = (clientId, deviceId, patch = {}) => ({ clientId, deviceId, visible: false, sessionId: null, lastSeen: 0, ...patch });
const device = (deviceId, patch = {}) => ({ deviceId, prefs: prefs(), updatedAt: 0, ...patch });
const subscription = { endpoint: "https://push.example/abc", keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) } };
const all = (...ids) => new Map(ids.map((id) => [id, undefined]));

test("nothing is sent anywhere while a visible tab shows the session, even while its stream reconnects", () => {
  const presence = [tab("viewer", "desk", { visible: true, sessionId: "s1" }), tab("phone-tab", "phone")];
  const devices = [device("desk"), device("phone", { prefs: prefs({ whenActive: "system" }), subscription })];
  assert.deepEqual(hub.routeNotification(event, presence, all("phone-tab"), devices), []);
});

test("active in another session: toast on the active tab only, toast-mode devices elsewhere stay quiet", () => {
  const presence = [tab("desk-active", "desk", { visible: true, sessionId: "other" }), tab("desk-hidden", "desk"), tab("laptop-tab", "laptop")];
  const devices = [device("desk"), device("laptop")];
  assert.deepEqual(hub.routeNotification(event, presence, all("desk-active", "desk-hidden", "laptop-tab"), devices), [{ kind: "toast", clientId: "desk-active" }]);
});

test("a visible tab that cannot receive toasts (stream closed) does not silence other devices", () => {
  const presence = [tab("settings-open", "desk", { visible: true })];
  const devices = [device("desk"), device("phone", { subscription })];
  assert.deepEqual(hub.routeNotification(event, presence, all(), devices), [{ kind: "push", deviceId: "phone" }]);
});

test("'always send a system notification' devices still get one while the user is active elsewhere", () => {
  const presence = [tab("desk-active", "desk", { visible: true, sessionId: "other" })];
  const devices = [device("desk", { prefs: prefs({ whenActive: "system" }) }), device("phone", { prefs: prefs({ whenActive: "system" }), subscription })];
  assert.deepEqual(hub.routeNotification(event, presence, all("desk-active"), devices), [
    { kind: "os", clientId: "desk-active" },
    { kind: "push", deviceId: "phone" },
  ]);
});

test("nobody active: push to subscribed devices, in-page to reachable tabs of unsubscribed ones", () => {
  const presence = [tab("desk-tab", "desk"), tab("phone-tab", "phone"), tab("beacon-only", "laptop")];
  const devices = [device("desk"), device("phone", { subscription }), device("laptop")];
  assert.deepEqual(hub.routeNotification(event, presence, all("desk-tab", "phone-tab"), devices), [
    { kind: "os", clientId: "desk-tab" },
    { kind: "push", deviceId: "phone" },
  ]);
});

test("a tab still showing a moved session's old id counts as viewing it", () => {
  const presence = [tab("viewer", "desk", { visible: true, sessionId: "old-id" })];
  const moved = { ...event, sessionId: "new-id", aliases: ["old-id"] };
  assert.deepEqual(hub.routeNotification(moved, presence, all("viewer"), [device("desk", { subscription })]), []);
});

test("disabled devices and disabled types get nothing", () => {
  const presence = [tab("tab", "desk")];
  assert.deepEqual(hub.routeNotification(event, presence, all("tab"), [device("desk", { prefs: prefs({ enabled: false }) })]), []);
  assert.deepEqual(hub.routeNotification(event, presence, all("tab"), [device("desk", { prefs: prefs({ types: { ...DEFAULT_NOTIFICATION_PREFS.types, completed: false } }) })]), []);
});

test("push subscriptions must use an HTTPS endpoint and real key sizes", () => {
  assert.equal(store.parsePushSubscription({ ...subscription, endpoint: "http://127.0.0.1:8080/x" }), null);
  assert.equal(store.parsePushSubscription({ ...subscription, keys: { p256dh: "not-a-real-key", auth: "x" } }), null);
  assert.deepEqual(store.parsePushSubscription(subscription), subscription);
});

const reopenStore = store.closeNotificationStore;

function isolatedStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-notify-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousSend = webpush.sendNotification;
  const previousHub = globalThis.__ompNotificationHub;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__ompNotificationHub = undefined;
  reopenStore();
  t.after(() => {
    webpush.sendNotification = previousSend;
    globalThis.__ompNotificationHub = previousHub;
    reopenStore();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("another omp-web instance sharing the agent dir sees the same keys and devices", (t) => {
  isolatedStore(t);
  store.saveDevice("phone-device", prefs({ locale: "ja" }), subscription);
  const publicKey = hub.getVapidPublicKey();

  // The other instance has its own handle on the shared store.
  reopenStore();
  store.saveDevice("laptop-device", prefs());
  reopenStore();

  assert.equal(hub.getVapidPublicKey(), publicKey);
  assert.equal(store.getDevice("laptop-device").prefs.enabled, true);
  store.saveDevice("phone-device", prefs({ locale: "en" }));
  assert.ok(store.getDevice("laptop-device"), "saving one device keeps the other instance's devices");
  assert.deepEqual(store.getDevice("phone-device").subscription, subscription);
});

test("a notification some device wants is recorded even when no tab or push receives it", (t) => {
  isolatedStore(t);
  store.saveDevice("desk-0001", prefs());
  hub.publishNotification(event);
  assert.deepEqual(store.listHistory().map((entry) => [entry.id, entry.read, entry.event.sessionName]), [["s1:completed", false, "Session"]]);
});

test("a notification no device has turned on is not recorded", (t) => {
  isolatedStore(t);
  hub.publishNotification(event);
  store.saveDevice("desk-0001", prefs({ enabled: false }));
  store.saveDevice("phone-0001", prefs({ types: { ...DEFAULT_NOTIFICATION_PREFS.types, completed: false } }));
  hub.publishNotification(event);
  assert.deepEqual(store.listHistory(), []);
});

test("a notification for the session a visible tab shows is recorded as already read", (t) => {
  isolatedStore(t);
  store.saveDevice("desk-0001", prefs());
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "s1", seq: 1 });
  hub.publishNotification(event);
  assert.deepEqual(store.listHistory().map((entry) => [entry.id, entry.read]), [["s1:completed", true]]);
});

test("an unusable store never breaks publishing", (t) => {
  const dir = isolatedStore(t);
  // The data directory's place is taken by a file: the store cannot open.
  writeFileSync(join(dir, "omp-web"), "");
  t.mock.method(console, "warn", () => {});
  assert.doesNotThrow(() => hub.publishNotification(event));
});

test("test notifications are never recorded", (t) => {
  isolatedStore(t);
  hub.publishNotification({ type: "test", sessionId: "", sessionName: "omp web" });
  assert.deepEqual(store.listHistory(), []);
});

test("a failed history write does not stop delivery", (t) => {
  const dir = isolatedStore(t);
  store.saveDevice("desk-0001", prefs({ whenActive: "system" }));
  const raw = new Database(join(dir, "omp-web", "notifications.db"));
  raw.exec("DROP TABLE history");
  raw.close();
  const received = [];
  hub.attachNotificationClient("tab-0001", (message) => received.push(message.kind));
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: false, sessionId: null, seq: 1 });
  t.mock.method(console, "warn", () => {});
  hub.publishNotification(event);
  assert.deepEqual(received, ["os"]);
});

test("a tab stays reachable when a stale stream of the same tab attaches late and then closes", (t) => {
  isolatedStore(t);
  store.saveDevice("desk-0001", prefs());
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: false, sessionId: null, seq: 1 });

  // React strict mode / reconnects: the cancelled request reaches the server
  // after the live one, then its abort fires.
  const received = [];
  const detachLive = hub.attachNotificationClient("tab-0001", () => received.push("live"));
  const detachStale = hub.attachNotificationClient("tab-0001", () => received.push("stale"));
  detachStale();
  hub.publishNotification(event);
  assert.deepEqual(received, ["live"]);

  detachLive();
  hub.publishNotification(event);
  assert.deepEqual(received, ["live"]);
});

test("a presence report that arrives after a newer one from the same tab is ignored", (t) => {
  isolatedStore(t);
  store.saveDevice("desk-0001", prefs({ whenActive: "system" }));
  const received = [];
  hub.attachNotificationClient("tab-0001", () => received.push("tab"));
  // The tab moved from s1 to s2, but the s1 report lands last.
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "s2", seq: 2 });
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "s1", seq: 1 });
  hub.publishNotification(event);
  assert.deepEqual(received, ["tab"], "s1 is no longer on screen, so its notification goes out");
});

test("pushes are written in the device's language with urgency by type", async (t) => {
  isolatedStore(t);
  const sent = [];
  webpush.sendNotification = async (_subscription, payload, options) => {
    sent.push({ payload: JSON.parse(payload), urgency: options.urgency, ttl: options.TTL });
  };
  store.saveDevice("phone-device", prefs({ locale: "ja" }), subscription);
  hub.publishNotification(event);
  hub.publishNotification({ type: "input", sessionId: "s2", sessionName: "Deploy", detail: "Ship it?" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sent.map(({ payload, urgency, ttl }) => [payload.body, payload.url, payload.type, urgency, ttl]), [
    ["タスクが完了しました。", "/?session=s1", "completed", "normal", 3600],
    ["回答を待っています: Ship it?", "/?session=s2", "input", "high", 3600],
  ]);
});

for (const status of [404, 410]) {
  test(`a push service ${status} removes the subscription but keeps the device prefs`, async (t) => {
    isolatedStore(t);
    webpush.sendNotification = async () => {
      throw new webpush.WebPushError("Gone", status, {}, "", subscription.endpoint);
    };
    store.saveDevice("phone-device", prefs(), subscription);
    assert.deepEqual(await hub.sendTestPush("phone-device"), { ok: false, error: `push service answered ${status}` });

    const stored = store.getDevice("phone-device");
    assert.equal(stored.subscription, undefined);
    assert.equal(stored.prefs.enabled, true);
  });
}

const offline = () => new AggregateError([
  Object.assign(new Error("connect ENETUNREACH 2001:db8::1:443"), { code: "ENETUNREACH" }),
  Object.assign(new Error("connect ETIMEDOUT 192.0.2.1:443"), { code: "ETIMEDOUT" }),
]);
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a push that never reaches the push service is retried with backoff and logs the cause", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warn = t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    if (attempts < 3) throw offline();
  };
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification(event);
  await flush();
  assert.equal(attempts, 1);
  assert.match(warn.mock.calls[0].arguments.join(" "), /retrying in 2s: connect ENETUNREACH 2001:db8::1:443; connect ETIMEDOUT 192\.0\.2\.1:443/);

  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[0]);
  await flush();
  assert.equal(attempts, 2);
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[1]);
  await flush();
  assert.equal(attempts, 3, "delivered on the third attempt");
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[2]);
  await flush();
  assert.equal(attempts, 3, "nothing is sent after a success");
});

test("a busy push service is retried until the retries run out", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warn = t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw new webpush.WebPushError("Busy", attempts % 2 ? 503 : 429, {}, "", subscription.endpoint);
  };
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification(event);
  for (const delay of hub.PUSH_RETRY_DELAYS_MS) {
    await flush();
    t.mock.timers.tick(delay);
  }
  await flush();
  assert.equal(attempts, hub.PUSH_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(warn.mock.calls.at(-1).arguments, ["[notifications] push failed:", "push service answered 429"]);
});

test("a push the push service refused is not retried", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw new webpush.WebPushError("Forbidden", 403, {}, "", subscription.endpoint);
  };
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification(event);
  await flush();
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0));
  await flush();
  assert.equal(attempts, 1);
});

test("a retry is dropped once the device turned notifications off", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw offline();
  };
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification(event);
  await flush();
  store.saveDevice("phone-device", prefs({ enabled: false }));
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[0]);
  await flush();
  assert.equal(attempts, 1);
});

test("the test button gets one attempt and the network failure's cause", async (t) => {
  isolatedStore(t);
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw offline();
  };
  store.saveDevice("phone-device", prefs(), subscription);
  assert.deepEqual(await hub.sendTestPush("phone-device"), {
    ok: false,
    error: "connect ENETUNREACH 2001:db8::1:443; connect ETIMEDOUT 192.0.2.1:443",
  });
  assert.equal(attempts, 1);
});

test("registered streams deliver without presence while retaining preference and visible-session precedence", (t) => {
  isolatedStore(t);
  store.saveDevice("phone-device", prefs());
  const received = [];
  const detach = hub.attachNotificationClient("phone-client", (message) => received.push(message), "phone-device");
  t.after(detach);
  hub.publishNotification(event);
  assert.deepEqual(received.map((entry) => entry.kind), ["os"]);
  received.length = 0;
  store.saveDevice("phone-device", prefs({ enabled: false }));
  hub.publishNotification(event);
  assert.deepEqual(received, []);
  store.saveDevice("phone-device", prefs());
  hub.reportPresence({ clientId: "other-client", deviceId: "desk-device", visible: true, sessionId: "s1", seq: 1 });
  hub.publishNotification(event);
  assert.deepEqual(received, []);
});

test("registration rejects malformed, unknown and conflicting device bindings before delivery", (t) => {
  isolatedStore(t);
  const receive = () => assert.fail("rejected stream received a notification");
  assert.throws(() => hub.attachNotificationClient("phone-client", receive, "../invalid"));
  assert.throws(() => hub.attachNotificationClient("phone-client", receive, "unknown-device"));
  assert.equal(globalThis.__ompNotificationHub?.streams.size ?? 0, 0);
  store.saveDevice("phone-device", prefs());
  store.saveDevice("other-device", prefs());
  const received = [];
  const detach = hub.attachNotificationClient("phone-client", (message) => received.push(message), "phone-device");
  assert.throws(() => hub.attachNotificationClient("phone-client", receive, "other-device"));
  const detachStale = hub.attachNotificationClient("phone-client", () => {});
  detachStale();
  hub.publishNotification(event);
  assert.equal(received.length, 1);
  detach();
  // The old binding is removed with the last overlapping stream.
  const rebound = hub.attachNotificationClient("phone-client", () => {}, "other-device");
  rebound();
});

test("stream-only clients never inherit another device's preferences or duplicate its push", () => {
  const reachable = new Map([["phone-client", "phone-device"]]);
  assert.deepEqual(hub.routeNotification(event, [], reachable, [device("other-device")]), []);
  assert.deepEqual(hub.routeNotification(event, [], reachable, [device("phone-device", { subscription })]), [{ kind: "push", deviceId: "phone-device" }]);
  const presence = [tab("desk-client", "desk-device", { visible: true, sessionId: "other" })];
  const active = new Map([...reachable, ["desk-client", "desk-device"]]);
  assert.deepEqual(hub.routeNotification(event, presence, active, [device("phone-device"), device("desk-device")]), [{ kind: "toast", clientId: "desk-client" }]);
  assert.deepEqual(hub.routeNotification(event, presence, active, [device("phone-device", { prefs: prefs({ whenActive: "system" }) })]), [{ kind: "os", clientId: "phone-client" }]);
});

test("retraction reaches every stream and subscribed device even after notifications were disabled", async (t) => {
  isolatedStore(t);
  const pushes = [];
  webpush.sendNotification = async (_subscription, payload) => pushes.push(JSON.parse(payload));
  store.saveDevice("phone-device", prefs(), subscription);
  store.saveDevice("desk-device", prefs());
  const received = [];
  t.after(hub.attachNotificationClient("phone-client", (message) => received.push(["phone", message]), "phone-device"));
  t.after(hub.attachNotificationClient("desk-client", (message) => received.push(["desk", message]), "desk-device"));
  store.saveDevice("phone-device", prefs({ enabled: false }));
  store.saveDevice("desk-device", prefs({ enabled: false }));
  hub.publishNotificationDismiss("s1", "question");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received.map(([id, message]) => [id, message.kind, message.requestId]), [["phone", "dismiss", "question"], ["desk", "dismiss", "question"]]);
  assert.deepEqual(pushes, [{ type: "dismiss", tag: "s1:input", sessionId: "s1", requestId: "question" }]);
});

test("a late retraction leaves a replacement question unread", (t) => {
  isolatedStore(t);
  store.recordHistory({ type: "input", sessionId: "s1", sessionName: null, requestId: "new-question" });
  hub.publishNotificationDismiss("s1", "old-question");
  assert.equal(store.listHistory()[0].read, false);
  hub.publishNotificationDismiss("s1", "new-question");
  assert.equal(store.listHistory()[0].read, true);
});

test("a settled question's sleeping push retry never re-delivers it", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const attempted = [];
  webpush.sendNotification = async (_subscription, payload) => {
    const message = JSON.parse(payload);
    attempted.push(message.type);
    if (message.type === "input") throw offline();
  };
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification({ type: "input", sessionId: "s1", sessionName: null, requestId: "settled" });
  await flush();
  hub.publishNotificationDismiss("s1", "settled");
  await flush();
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[0]);
  await flush();
  assert.deepEqual(attempted, ["input", "dismiss"]);
});

test("a push accepted after settlement is retracted again after the in-flight delivery", async (t) => {
  isolatedStore(t);
  const accepted = Promise.withResolvers();
  const messages = [];
  webpush.sendNotification = async (_subscription, payload) => {
    const message = JSON.parse(payload);
    messages.push(message.type);
    if (message.type === "input") await accepted.promise;
  };
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification({ type: "input", sessionId: "s1", sessionName: null, requestId: "settled" });
  hub.publishNotificationDismiss("s1", "settled");
  assert.deepEqual(messages, ["input", "dismiss"]);
  accepted.resolve();
  await flush();
  assert.deepEqual(messages, ["input", "dismiss", "dismiss"]);
});

test("action metadata that would exceed Web Push capacity falls back to a complete open-only notification", async (t) => {
  isolatedStore(t);
  const { buildNotificationDialog } = await import("./notification-events.ts");
  const options = ["甲".repeat(150), "乙".repeat(150)];
  const dialog = buildNotificationDialog({ id: "large", method: "select", title: "問".repeat(160), options });
  assert.ok(dialog);
  const payloads = [];
  webpush.sendNotification = async (_subscription, payload) => payloads.push(payload);
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification({ type: "input", sessionId: "s1", sessionName: "名".repeat(100), detail: "詳".repeat(180), requestId: "large", dialog });
  await flush();
  assert.equal(payloads.length, 1);
  assert.ok(Buffer.byteLength(payloads[0], "utf8") < 4096);
  const payload = JSON.parse(payloads[0]);
  assert.equal(payload.requestId, "large");
  assert.equal(payload.dialog, undefined);
  assert.equal(payload.actions, undefined);
  assert.equal(payload.responses, undefined);
});

test("Traditional Chinese devices use their own dictionary and Apple endpoints never receive silent pushes", async (t) => {
  isolatedStore(t);
  const zhTW = (await import("./i18n/locales/zh-TW.json")).default;
  const payloads = [];
  webpush.sendNotification = async (_subscription, payload) => payloads.push(JSON.parse(payload));
  store.saveDevice("apple-device", prefs({ locale: "zh-TW" }), { ...subscription, endpoint: "https://web.push.apple.com/token" });
  hub.publishNotification(event);
  await flush();
  assert.equal(payloads[0].body, zhTW["notifications.completedBody"]);
  hub.publishNotificationDismiss("s1", "question");
  await flush();
  assert.equal(payloads.length, 1);
  assert.equal(hub.isApplePushEndpoint("https://example.com/?endpoint=web.push.apple.com"), false);
});
