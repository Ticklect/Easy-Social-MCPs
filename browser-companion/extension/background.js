// MV3 Chromium extension: Helium, Chrome, Edge, Brave, Chromium, Vivaldi, Opera.
const ENDPOINT = "ws://127.0.0.1:19411/extension";
const SITES = ["reddit.com", "x.com", "twitter.com", "youtube.com", "accounts.google.com", "tiktok.com"];
const watched = new Set();
const attaching = new Map();
let connection = null;
let connecting = false;
let pulse = null;
let lastError = "";

function allowed(url) {
  try {
    const page = new URL(url);
    const host = page.hostname.toLowerCase().replace(/\.$/, "");
    return page.protocol === "https:" && SITES.some((name) => host === name || host.endsWith("." + name));
  } catch { return false; }
}
function send(data) {
  if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify(data));
}
async function disconnect() {
  if (pulse) clearInterval(pulse);
  pulse = null;
  const old = connection; connection = null;
  if (old && old.readyState !== WebSocket.CLOSED) {
    const closed = new Promise((resolve) => {
      const onClose = () => { clearTimeout(timeout); resolve(); };
      old.addEventListener("close", onClose, { once: true });
      const timeout = setTimeout(() => {
        old.removeEventListener("close", onClose);
        resolve();
      }, 750);
    });
    try { old.close(); } catch {}
    await closed;
  }
  // Mark pending attachments revoked immediately. A native Chrome attach can
  // stall; its own completion handler will detach if it eventually succeeds.
  for (const tabId of [...attaching.keys()]) void invalidateTab(tabId);
  for (const tabId of watched) {
    if (attaching.has(tabId)) continue;
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
  watched.clear();
}
async function checkTab(tabId) {
  if (!Number.isSafeInteger(tabId)) throw new Error("Invalid tab identifier.");
  const tab = await chrome.tabs.get(tabId);
  if (!allowed(tab.pendingUrl || tab.url)) throw new Error("This tab is outside the approved social websites.");
  return tab;
}
async function invalidateTab(tabId) {
  const pendingAttach = attaching.get(tabId);
  if (pendingAttach) {
    if (pendingAttach.invalidated) return;
    pendingAttach.invalidated = true;
    send({ type: "invalidated", tabId });
    // The attach handler detaches if Chrome grants the debugger after this
    // invalidation. Waiting prevents a late attach from remaining active.
    try { await pendingAttach.promise; } catch {}
    return;
  }
  if (!watched.delete(tabId)) return;
  // Close the bridge's CDP clients immediately, even if debugger.detach fails.
  send({ type: "invalidated", tabId });
  try { await chrome.debugger.detach({ tabId }); } catch {}
}
async function attachTab(tabId) {
  if (watched.has(tabId)) return;
  let record = attaching.get(tabId);
  if (!record) {
    record = { invalidated: false, promise: Promise.resolve() };
    attaching.set(tabId, record);
    record.promise = (async () => {
      let attached = false;
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
        attached = true;
        watched.add(tabId);
        // Navigation or tab removal may happen while attach is in flight.
        if (record.invalidated) throw new Error("Tab left the approved social websites.");
        await checkTab(tabId);
        if (record.invalidated) throw new Error("Tab left the approved social websites.");
      } catch (error) {
        if (attached && watched.delete(tabId)) {
          try { await chrome.debugger.detach({ tabId }); } catch {}
        }
        throw new Error(`Could not attach the browser debugger to this tab: ${error?.message || error}`);
      } finally {
        if (attaching.get(tabId) === record) attaching.delete(tabId);
      }
    })();
  }
  await record.promise;
  if (!watched.has(tabId)) throw new Error("Tab is no longer available.");
}
async function dispatch(item) {
  if (item.type === "list") {
    return (await chrome.tabs.query({}))
      .filter((tab) => Number.isSafeInteger(tab.id) && allowed(tab.url))
      .map(({ id, url, title, active }) => ({ id, url, title, active: Boolean(active) }));
  }
  if (item.type === "open") {
    if (!allowed(item.url)) throw new Error("Only approved social websites can be opened.");
    const tab = await chrome.tabs.create({ url: item.url, active: false });
    return { id: tab.id, url: item.url, title: tab.title || "" };
  }
  if (item.type === "command") {
    await checkTab(item.tabId);
    if (!/^(Page|Runtime|Network|DOM|Input|Emulation|Storage)\.[A-Za-z]+$/.test(item.method || "")) {
      throw new Error("Unsupported browser command.");
    }
    if (item.method === "Page.navigate" && !allowed(item.params?.url)) {
      throw new Error("Navigation outside approved social websites is blocked.");
    }
    const target = { tabId: item.tabId };
    // All concurrent first commands share one attachment attempt. Chrome
    // displays the same native debugger permission indicator as before.
    await attachTab(item.tabId);
    return await chrome.debugger.sendCommand(target, item.method, item.params || {});
  }
  throw new Error("Unknown companion request.");
}
chrome.debugger.onEvent.addListener((target, method, params) => {
  if (!watched.has(target.tabId) && !attaching.has(target.tabId)) return;
  if (method === "Page.frameNavigated" && !params?.frame?.parentId && !allowed(params?.frame?.url)) {
    void invalidateTab(target.tabId);
    return;
  }
  send({ type: "event", tabId: target.tabId, method, params });
});
chrome.debugger.onDetach.addListener((target) => {
  const pendingAttach = attaching.get(target.tabId);
  if (pendingAttach) {
    if (!pendingAttach.invalidated) {
      pendingAttach.invalidated = true;
      send({ type: "invalidated", tabId: target.tabId });
    }
    return;
  }
  if (watched.delete(target.tabId)) send({ type: "invalidated", tabId: target.tabId });
});
chrome.tabs.onRemoved.addListener((id) => {
  void invalidateTab(id);
});
chrome.tabs.onUpdated.addListener((id, changes) => {
  if ((watched.has(id) || attaching.has(id)) && typeof changes.url === "string" && !allowed(changes.url)) {
    void invalidateTab(id);
  }
});

async function connect() {
  if (connecting || connection?.readyState === WebSocket.OPEN || connection?.readyState === WebSocket.CONNECTING) return;
  connecting = true;
  try {
    const { pairingCode, browserId: existingId } = await chrome.storage.local.get(["pairingCode", "browserId"]);
    if (!/^[0-9a-f]{64}$/.test(pairingCode || "")) { lastError = "Open the extension and enter the pairing code shown by the local companion."; return; }
    const browserId = existingId && /^[a-f0-9]{32}$/.test(existingId) ? existingId : crypto.randomUUID().replaceAll("-", "");
    if (browserId !== existingId) await chrome.storage.local.set({ browserId });
    const socket = new WebSocket(`${ENDPOINT}?key=${encodeURIComponent(pairingCode)}&browserId=${browserId}`);
    connection = socket;
    socket.onopen = () => {
      if (connection !== socket) { socket.close(); return; }
      lastError = "";
      const agent = navigator.userAgent;
      const label = agent.includes("Edg/") ? "Microsoft Edge" : agent.includes("OPR/") ? "Opera" :
        agent.includes("Vivaldi/") ? "Vivaldi" : agent.includes("Brave/") ? "Brave" : "Helium / Chrome / Chromium";
      send({ type: "hello", browser: label });
      pulse = setInterval(() => send({ type: "heartbeat" }), 15_000);
    };
    socket.onmessage = async ({ data }) => {
      if (connection !== socket) return;
      let item;
      try { item = JSON.parse(data); } catch { return; }
      if (!Number.isSafeInteger(item.id)) return;
      try {
        const result = await dispatch(item);
        if (connection === socket) send({ id: item.id, result });
      } catch (error) {
        if (connection === socket) send({ id: item.id, error: String(error?.message || error).slice(0, 250) });
      }
    };
    socket.onclose = () => {
      if (connection !== socket) return;
      lastError = lastError || "Companion disconnected. Check the local server.";
      void disconnect();
    };
    socket.onerror = () => { lastError = "Cannot connect to the local companion server."; };
  } finally { connecting = false; }
}
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === "status") {
    reply({ connected: connection?.readyState === WebSocket.OPEN,
      connecting: connecting || connection?.readyState === WebSocket.CONNECTING, error: lastError });
    return false;
  }
  if (message?.type === "reconnect") {
    (async () => {
      const { pairingCode } = await chrome.storage.local.get("pairingCode");
      if (!/^[0-9a-f]{64}$/.test(pairingCode || "")) {
        return reply({ error: "Pair this browser once before reconnecting." });
      }
      await disconnect();
      await connect();
      reply({ ok: true });
    })().catch((error) => reply({ error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "pair" && /^[0-9a-f]{64}$/.test(message.code || "")) {
    (async () => {
      await disconnect();
      await chrome.storage.local.set({ pairingCode: message.code });
      await connect();
      reply({ ok: true });
    })().catch((error) => reply({ error: error.message }));
    return true;
  }
  if (message?.type === "disconnect") {
    (async () => {
      await disconnect();
      await chrome.storage.local.remove("pairingCode");
      lastError = "Disconnected.";
      reply({ ok: true });
    })().catch((error) => reply({ error: error.message }));
    return true;
  }
  reply({ error: "Unsupported command." });
  return false;
});
chrome.alarms.create("connect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(({ name }) => { if (name === "connect") void connect(); });
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
void connect();
