// MV3 Chromium extension: Helium, Chrome, Edge, Brave, Chromium, Vivaldi, Opera.
const ENDPOINT = "ws://127.0.0.1:19411/extension";
const SITES = ["reddit.com", "x.com", "twitter.com", "youtube.com", "accounts.google.com"];
const watched = new Set();
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
      old.addEventListener("close", resolve, { once: true });
      setTimeout(resolve, 750);
    });
    try { old.close(); } catch {}
    await closed;
  }
  for (const tabId of watched) {
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
async function dispatch(item) {
  if (item.type === "list") {
    return (await chrome.tabs.query({}))
      .filter((tab) => Number.isSafeInteger(tab.id) && allowed(tab.url))
      .map(({ id, url, title }) => ({ id, url, title }));
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
    if (!watched.has(item.tabId)) {
      // Chrome displays a native debugging permission indicator.
      await chrome.debugger.attach(target, "1.3");
      watched.add(item.tabId);
    }
    return await chrome.debugger.sendCommand(target, item.method, item.params || {});
  }
  throw new Error("Unknown companion request.");
}
chrome.debugger.onEvent.addListener((target, method, params) => {
  if (watched.has(target.tabId)) send({ type: "event", tabId: target.tabId, method, params });
});
chrome.debugger.onDetach.addListener((target) => watched.delete(target.tabId));
chrome.tabs.onRemoved.addListener((id) => watched.delete(id));

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
      lastError = "";
      const agent = navigator.userAgent;
      const label = agent.includes("Edg/") ? "Microsoft Edge" : agent.includes("OPR/") ? "Opera" :
        agent.includes("Vivaldi/") ? "Vivaldi" : agent.includes("Brave/") ? "Brave" : "Helium / Chrome / Chromium";
      send({ type: "hello", browser: label });
      pulse = setInterval(() => send({ type: "heartbeat" }), 15_000);
    };
    socket.onmessage = async ({ data }) => {
      let item;
      try { item = JSON.parse(data); } catch { return; }
      if (!Number.isSafeInteger(item.id)) return;
      try { send({ id: item.id, result: await dispatch(item) }); }
      catch (error) { send({ id: item.id, error: String(error?.message || error).slice(0, 250) }); }
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
    reply({ connected: connection?.readyState === WebSocket.OPEN, error: lastError });
    return false;
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
