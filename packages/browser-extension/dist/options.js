// src/config.ts
var DEFAULT_BASE_URL = "http://127.0.0.1:3030";
var STORAGE_KEY_TOKEN = "screenpipe_token";
var STORAGE_KEY_BASE_URL = "screenpipe_base_url";
var BROWSER_BASE_PATH = "/connections/browser";
function buildWsUrl(baseHttpUrl, token) {
  const base = baseHttpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const path = `${BROWSER_BASE_PATH}/ws`;
  if (!token)
    return `${base}${path}`;
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}
function healthUrl(baseHttpUrl) {
  return `${baseHttpUrl.replace(/\/$/, "")}/health`;
}
function browserStatusUrl(baseHttpUrl) {
  return `${baseHttpUrl.replace(/\/$/, "")}${BROWSER_BASE_PATH}/status`;
}

// src/options.ts
var $ = (id) => document.getElementById(id);
function setStatus(status, message) {
  const el = $("status");
  el.dataset.state = status;
  el.textContent = message;
}
async function loadSettings() {
  const s = await chrome.storage.local.get([STORAGE_KEY_TOKEN, STORAGE_KEY_BASE_URL]);
  return {
    token: s[STORAGE_KEY_TOKEN] ?? "",
    baseUrl: s[STORAGE_KEY_BASE_URL] ?? DEFAULT_BASE_URL
  };
}
async function saveSettings(token, baseUrl) {
  await chrome.storage.local.set({
    [STORAGE_KEY_TOKEN]: token,
    [STORAGE_KEY_BASE_URL]: baseUrl
  });
}
async function probeConnection(token, baseUrl) {
  try {
    const health = await fetch(healthUrl(baseUrl), { method: "GET" });
    if (!health.ok) {
      return { status: "server_down", message: `server responded ${health.status}` };
    }
  } catch (e) {
    return {
      status: "server_down",
      message: `can't reach screenpipe at ${baseUrl} — is the app running?`
    };
  }
  try {
    const headers = {};
    if (token)
      headers["Authorization"] = `Bearer ${token}`;
    const auth = await fetch(browserStatusUrl(baseUrl), { method: "GET", headers });
    if (auth.ok) {
      return { status: "ok", message: token ? "connected (authenticated)" : "connected (no auth required)" };
    }
    if (auth.status === 401 || auth.status === 403) {
      return {
        status: "auth_required",
        message: token ? "token was rejected — copy a fresh one from screenpipe Settings" : "this server requires a token — paste one above"
      };
    }
    return { status: "error", message: `unexpected HTTP ${auth.status}` };
  } catch (e) {
    return { status: "error", message: e?.message ?? "probe failed" };
  }
}
function getFormValues() {
  const token = $("token").value.trim();
  const baseUrl = $("baseUrl").value.trim() || DEFAULT_BASE_URL;
  return { token, baseUrl };
}
async function onSaveClick() {
  setStatus("saving", "saving…");
  const { token, baseUrl } = getFormValues();
  await saveSettings(token, baseUrl);
  const { status, message } = await probeConnection(token, baseUrl);
  setStatus(status, status === "ok" ? `settings saved · ${message}` : message);
}
async function onTestClick() {
  setStatus("saving", "testing…");
  const { token, baseUrl } = getFormValues();
  const { status, message } = await probeConnection(token, baseUrl);
  setStatus(status, message);
}
async function init() {
  const { token, baseUrl } = await loadSettings();
  $("token").value = token;
  $("baseUrl").value = baseUrl;
  $("save").addEventListener("click", () => {
    onSaveClick();
  });
  $("test").addEventListener("click", () => {
    onTestClick();
  });
  if (token || baseUrl !== DEFAULT_BASE_URL) {
    const { status, message } = await probeConnection(token, baseUrl);
    setStatus(status, message);
  } else {
    setStatus("idle", "paste your screenpipe API token to get started");
  }
}
document.addEventListener("DOMContentLoaded", () => {
  init();
});
