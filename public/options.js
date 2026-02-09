const STORAGE_KEY = "bak_settings_v1";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.1-codex-mini";

const baseUrlInput = document.getElementById("baseUrl");
const modelInput = document.getElementById("model");
const apiKeyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("save");
const resetBtn = document.getElementById("reset");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
  if (text) {
    setTimeout(() => {
      statusEl.textContent = "";
    }, 2500);
  }
}

function loadSettings() {
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    const state = res?.[STORAGE_KEY] || {};
    baseUrlInput.value = state.baseUrl || DEFAULT_BASE_URL;
    modelInput.value = state.model || DEFAULT_MODEL;
    apiKeyInput.value = state.apiKey || "";
  });
}

function saveSettings() {
  const payload = {
    baseUrl: baseUrlInput.value.trim() || DEFAULT_BASE_URL,
    model: modelInput.value.trim() || DEFAULT_MODEL,
    apiKey: apiKeyInput.value.trim()
  };
  chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => {
    setStatus("Saved");
  });
}

function resetSettings() {
  chrome.storage.local.remove([STORAGE_KEY], () => {
    baseUrlInput.value = DEFAULT_BASE_URL;
    modelInput.value = DEFAULT_MODEL;
    apiKeyInput.value = "";
    setStatus("Reset");
  });
}

saveBtn.addEventListener("click", saveSettings);
resetBtn.addEventListener("click", resetSettings);

loadSettings();
