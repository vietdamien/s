// src/config.ts
var DEFAULT_BASE_URL = "http://127.0.0.1:3030";
var STORAGE_KEY_TOKEN = "screenpipe_token";
var STORAGE_KEY_BASE_URL = "screenpipe_base_url";
function buildWsUrl(baseHttpUrl, token) {
  const base = baseHttpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const path = "/browser/ws";
  if (!token)
    return `${base}${path}`;
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}
function healthUrl(baseHttpUrl) {
  return `${baseHttpUrl.replace(/\/$/, "")}/health`;
}
function browserStatusUrl(baseHttpUrl) {
  return `${baseHttpUrl.replace(/\/$/, "")}/browser/status`;
}

// src/worker.ts
var RECONNECT_BASE_MS = 500;
var RECONNECT_MAX_MS = 30000;
var AUTH_FAIL_THRESHOLD = 3;
var ALERT_COOLDOWN_MS = 10 * 60000;
var socket = null;
var reconnectDelay = RECONNECT_BASE_MS;
var reconnectTimer = null;
var closeWithoutOpen = 0;
var lastAlertAt = 0;
var openedThisAttempt = false;
async function getConfig() {
  const s = await chrome.storage.local.get([STORAGE_KEY_TOKEN, STORAGE_KEY_BASE_URL]);
  const token = s[STORAGE_KEY_TOKEN]?.trim() || null;
  const baseUrl = s[STORAGE_KEY_BASE_URL]?.trim() || DEFAULT_BASE_URL;
  return { token, baseUrl };
}
function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch {}
}
function clearBadge() {
  setBadge("", "#00000000");
}
function notifyOnce(title, message) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS)
    return;
  lastAlertAt = now;
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon-128.png",
      title,
      message,
      priority: 1
    });
  } catch {}
}
async function connect() {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    return;
  }
  const { token, baseUrl } = await getConfig();
  const url = buildWsUrl(baseUrl, token);
  openedThisAttempt = false;
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    console.log("[screenpipe] connected");
    openedThisAttempt = true;
    reconnectDelay = RECONNECT_BASE_MS;
    closeWithoutOpen = 0;
    clearBadge();
    const hello = {
      type: "hello",
      from: "extension",
      browser: detectBrowser(),
      version: chrome.runtime.getManifest().version
    };
    send(hello);
  };
  socket.onclose = () => {
    if (!openedThisAttempt) {
      closeWithoutOpen += 1;
      if (closeWithoutOpen >= AUTH_FAIL_THRESHOLD) {
        setBadge("!", "#dc2626");
        notifyOnce("Screenpipe extension needs a token", "Open the extension options to paste your screenpipe API token.");
      }
    }
    scheduleReconnect();
  };
  socket.onerror = () => {
    try {
      socket?.close();
    } catch {}
  };
  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.action === "ping") {
      send({ type: "pong" });
      return;
    }
    if (msg.action === "eval") {
      const { id, code, url: url2 } = msg;
      try {
        const tabId = await findTab(url2);
        const result = await evalInTab(tabId, code);
        send({ id, ok: true, result });
      } catch (err) {
        send({ id, ok: false, error: err?.message ?? String(err) });
      }
    }
  };
}
function scheduleReconnect() {
  if (reconnectTimer)
    return;
  const cap = closeWithoutOpen >= AUTH_FAIL_THRESHOLD ? RECONNECT_MAX_MS : RECONNECT_MAX_MS / 6;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, cap);
    connect();
  }, reconnectDelay);
}
function forceReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectDelay = RECONNECT_BASE_MS;
  closeWithoutOpen = 0;
  lastAlertAt = 0;
  clearBadge();
  try {
    socket?.close();
  } catch {}
  socket = null;
  connect();
}
function send(obj) {
  try {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(obj));
    }
  } catch {}
}
async function findTab(urlPattern) {
  if (urlPattern) {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find((t) => t.url?.includes(urlPattern));
    if (match?.id != null)
      return match.id;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id != null)
    return active.id;
  throw new Error("no matching tab found");
}
async function evalInTab(tabId, code) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:") || tab.url.includes("chromewebstore.google.com")) {
    throw new Error(`cannot execute scripts on ${tab.url}`);
  }
  const expression = `(async () => { ${code} })()`;
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError?.message?.includes("already attached")) {
          resolve();
        } else if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  } catch (e) {
    if (!e.message?.includes("already attached"))
      throw e;
  }
  const evalResult = await new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
  if (evalResult?.exceptionDetails) {
    const desc = evalResult.exceptionDetails.exception?.description || evalResult.exceptionDetails.text || "evaluation error";
    throw new Error(desc);
  }
  return evalResult?.result?.value ?? null;
}
function detectBrowser() {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/"))
    return "edge";
  if (ua.includes("Brave/"))
    return "brave";
  if (ua.includes("OPR/") || ua.includes("Opera/"))
    return "opera";
  if (ua.includes("Chrome/"))
    return "chrome";
  if (ua.includes("Firefox/"))
    return "firefox";
  return "unknown";
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local")
    return;
  if (STORAGE_KEY_TOKEN in changes || STORAGE_KEY_BASE_URL in changes) {
    forceReconnect();
  }
});
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install")
    return;
  const s = await chrome.storage.local.get(STORAGE_KEY_TOKEN);
  if (!s[STORAGE_KEY_TOKEN]) {
    chrome.runtime.openOptionsPage();
  }
});
chrome.alarms.create("screenpipe_keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "screenpipe_keepalive")
    connect();
});
chrome.tabs.onActivated.addListener(() => void connect());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === "complete")
    connect();
});
connect();
