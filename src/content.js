import {
  createOpenAIResponsesAdapter,
  createAgentMessages,
  isAgentError,
  runAgent,
  domAppendHtmlTool,
  domBindEventTool,
  domRemoveTool,
  domSubtreeHtmlTool,
  domSummaryTool,
  jsRunTool,
  Skill,
  withStatus
} from "browseragentkit";
import { createChatUi } from "browseragentkit/ui";
import $ from "jquery";

const ROOT_ID = "__bak-root";
const SKILL_ID = "bak-skill-page-edit";
const STORAGE_KEY = "bak_settings_v1";
const HISTORY_KEY = "bak_history_v1";
const UNDO_KEY = "bak_undo_v1";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.1-codex-mini";

const api = globalThis.chrome ?? globalThis.browser;

if (globalThis) {
  globalThis.$ = $;
  globalThis.jQuery = $;
}

const existingRoot = document.getElementById(ROOT_ID);
if (existingRoot && globalThis.__bakPageAgent?.toggle) {
  globalThis.__bakPageAgent.toggle();
} else if (existingRoot) {
  existingRoot.style.display = existingRoot.style.display === "none" ? "" : "none";
} else {
  init();
}

function init() {
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.all = "initial";
  root.style.position = "fixed";
  root.style.right = "24px";
  root.style.bottom = "24px";
  root.style.zIndex = "2147483647";

  const shadow = root.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = getStyles();
  shadow.appendChild(style);

  const container = document.createElement("div");
  container.className = "bak-container";
  container.innerHTML = getTemplate();
  shadow.appendChild(container);

  document.documentElement.appendChild(root);

  const closeBtn = shadow.querySelector(".bak-close");
  const runBtn = shadow.querySelector(".bak-run");
  const undoBtn = shadow.querySelector(".bak-undo");
  const clearBtn = shadow.querySelector(".bak-clear");
  const promptInput = shadow.querySelector(".bak-input");
  const chatLog = shadow.querySelector(".bak-log");
  const baseUrlInput = shadow.querySelector(".bak-baseurl");
  const modelInput = shadow.querySelector(".bak-model");
  const apiKeyInput = shadow.querySelector(".bak-apikey");
  const statusEl = shadow.querySelector(".bak-status");

  if (baseUrlInput && !baseUrlInput.value) baseUrlInput.value = DEFAULT_BASE_URL;
  if (modelInput && !modelInput.value) modelInput.value = DEFAULT_MODEL;

  const chatUi = chatLog ? createChatUi({ container: chatLog }) : null;

  const agentMessages = createAgentMessages(
    "System: You are a browser page customization agent. You can edit the page body, but do not modify or remove the element with id '__bak-root'. Make minimal, safe changes and confirm what you changed."
  );

  ensureSkillTag();

  const skills = [
    Skill.fromDomSelector(`//script[@id='${SKILL_ID}']`, document)
  ];

  const tools = [
    jsRunTool(),
    domSummaryTool(),
    domSubtreeHtmlTool(),
    domAppendHtmlTool(),
    domRemoveTool(),
    domBindEventTool()
  ];

  const agentContext = { viewRoot: document.body };

  const history = [];
  const undoStack = [];

  restoreState();
  restoreHistory();
  restoreUndo();

  closeBtn?.addEventListener("click", () => toggle(false));

  runBtn?.addEventListener("click", async () => {
    const prompt = promptInput?.value?.trim();
    if (!prompt) return;

    const adapter = getAdapter();
    if (!adapter) {
      addAssistantMessage("Missing model settings. Add base URL and API key in Settings.");
      return;
    }

    runBtn.disabled = true;
    setStatus("Working...");

    const snapshot = captureBodyHtml();
    if (snapshot) {
      undoStack.push(snapshot);
      persistUndo();
    }

    addUserMessage(prompt);
    promptInput.value = "";

    try {
      let thinkingSummary = "";
      for await (const ev of withStatus(
        runAgent(
          agentMessages,
          adapter.generate,
          prompt,
          [...tools, ...skills],
          25,
          agentContext,
          undefined,
          {
            tokenCounter: adapter.countTokens,
            contextWindowTokens: adapter.contextWindowTokens,
            model: adapter.model
          }
        )
      )) {
        if (isAgentError(ev)) {
          const error = ev.left;
          addAssistantMessage(`${String(error)}`);
          break;
        }
        const event = ev.right;
        if (event.type === "message.delta") {
          chatUi?.appendAssistantDelta(event.delta);
        }
        if (event.type === "message") {
          chatUi?.finalizeAssistantMessage(event.content);
          pushHistory({ role: "assistant", content: event.content });
          persistHistory();
        }
        if (event.type === "status") {
          if (event.status.kind !== "thinking") {
            thinkingSummary = "";
          }
          setStatus(event.status.label || event.status.kind);
        }
        if (event.type === "thinking.delta") {
          thinkingSummary += event.delta;
          chatUi?.setThinkingSummary(thinkingSummary);
        }
        if (event.type === "thinking") {
          thinkingSummary = event.summary;
          chatUi?.setThinkingSummary(event.summary);
        }
      }
    } catch (error) {
      addAssistantMessage(`${String(error)}`);
    } finally {
      runBtn.disabled = false;
      setStatus("");
    }
  });

  undoBtn?.addEventListener("click", () => {
    const last = undoStack.pop();
    if (!last) {
      addAssistantMessage("Nothing to undo.");
      return;
    }
    restoreBodyHtml(last);
    persistUndo();
    addAssistantMessage("Reverted last change.");
  });

  clearBtn?.addEventListener("click", () => {
    chatLog.innerHTML = "";
    history.length = 0;
    persistHistory();
  });

  promptInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      runBtn?.click();
    }
  });

  baseUrlInput?.addEventListener("change", persistSettings);
  modelInput?.addEventListener("change", persistSettings);
  apiKeyInput?.addEventListener("change", persistSettings);

  function toggle(forceOpen) {
    const isHidden = root.style.display === "none";
    const shouldShow = forceOpen === undefined ? isHidden : forceOpen;
    root.style.display = shouldShow ? "" : "none";
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function addUserMessage(text) {
    chatUi?.addUserMessage(text);
    pushHistory({ role: "user", content: text });
    persistHistory();
  }

  function addAssistantMessage(text) {
    chatUi?.finalizeAssistantMessage(text);
    pushHistory({ role: "assistant", content: text });
    persistHistory();
  }

  function pushHistory(msg) {
    history.push(msg);
    if (history.length > 50) {
      history.shift();
    }
  }

  function restoreHistory() {
    if (!api?.storage?.local) return;
    storageGet([HISTORY_KEY], (res) => {
      const items = res?.[HISTORY_KEY];
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (item.role === "user") {
          chatUi?.addUserMessage(item.content);
        } else {
          chatUi?.finalizeAssistantMessage(item.content);
        }
        history.push(item);
      }
    });
  }

  function persistHistory() {
    if (!api?.storage?.local) return;
    storageSet({ [HISTORY_KEY]: history });
  }

  function persistSettings() {
    if (!api?.storage?.local) return;
    storageSet({
      [STORAGE_KEY]: {
        baseUrl: baseUrlInput?.value?.trim() ?? DEFAULT_BASE_URL,
        model: modelInput?.value?.trim() ?? DEFAULT_MODEL,
        apiKey: apiKeyInput?.value?.trim() ?? ""
      }
    });
  }

  function restoreState() {
    if (!api?.storage?.local) return;
    storageGet([STORAGE_KEY], (res) => {
      const state = res?.[STORAGE_KEY];
      if (!state) return;
      if (baseUrlInput && state.baseUrl) baseUrlInput.value = state.baseUrl;
      if (modelInput && state.model) modelInput.value = state.model;
      if (apiKeyInput && state.apiKey) apiKeyInput.value = state.apiKey;
    });
  }

  function restoreUndo() {
    if (!api?.storage?.local) return;
    storageGet([UNDO_KEY], (res) => {
      const items = res?.[UNDO_KEY];
      if (Array.isArray(items)) {
        undoStack.push(...items);
      }
    });
  }

  function persistUndo() {
    if (!api?.storage?.local) return;
    storageSet({ [UNDO_KEY]: undoStack.slice(-5) });
  }

  function getAdapter() {
    const baseURL = baseUrlInput?.value?.trim() ?? DEFAULT_BASE_URL;
    const apiKey = apiKeyInput?.value?.trim() ?? "";
    const model = modelInput?.value?.trim() || DEFAULT_MODEL;
    if (!apiKey) {
      return null;
    }
    return createOpenAIResponsesAdapter({
      model,
      baseURL,
      apiKey,
      dangerouslyAllowBrowser: true
    });
  }

  function captureBodyHtml() {
    try {
      const clone = document.body.cloneNode(true);
      const node = clone.querySelector(`#${ROOT_ID}`);
      if (node) node.remove();
      return clone.innerHTML;
    } catch {
      return null;
    }
  }

  function restoreBodyHtml(html) {
    const existingRoot = document.getElementById(ROOT_ID);
    document.body.innerHTML = html;
    if (existingRoot) {
      document.body.appendChild(existingRoot);
    }
  }

  function ensureSkillTag() {
    if (document.getElementById(SKILL_ID)) return;
    const skill = document.createElement("script");
    skill.type = "text/markdown";
    skill.id = SKILL_ID;
    skill.textContent = `---\nname: page.edit\ndescription: Modify the current page safely.\n---\n# Goal\nSafely modify the current page based on the user request.\n\n# Steps\n1) Inspect the relevant DOM using the provided tools.\n2) Make minimal changes to fulfill the request.\n3) Do not modify or remove the element with id '__bak-root'.\n4) Avoid removing forms or scripts unless explicitly asked.\n5) Confirm what changed in a short response.\n\n# Output\n- A short confirmation of changes.`;
    document.documentElement.appendChild(skill);
  }

  globalThis.__bakPageAgent = {
    toggle
  };
}

function storageGet(keys, cb) {
  try {
    const result = api.storage.local.get(keys, cb);
    if (result && typeof result.then === "function") {
      result.then((res) => cb(res)).catch(() => {});
    }
  } catch {
    // ignore
  }
}

function storageSet(data) {
  try {
    const result = api.storage.local.set(data);
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch {
    // ignore
  }
}

function getTemplate() {
  return `
    <div class="bak-card">
      <div class="bak-header">
        <div>
          <div class="bak-title">Page Agent</div>
          <div class="bak-subtitle">Customize this page</div>
        </div>
        <button class="bak-close" title="Close">×</button>
      </div>
      <details class="bak-settings" open>
        <summary>Settings</summary>
        <label>Model base URL</label>
        <input class="bak-baseurl" placeholder="${DEFAULT_BASE_URL}" />
        <label>Model</label>
        <input class="bak-model" value="${DEFAULT_MODEL}" />
        <label>API key</label>
        <input class="bak-apikey" placeholder="sk-..." />
      </details>
      <div class="bak-log"></div>
      <div class="bak-status"></div>
      <textarea class="bak-input" rows="3" placeholder="Describe the change..."></textarea>
      <div class="bak-actions">
        <button class="bak-run">Send</button>
        <button class="bak-undo">Undo</button>
        <button class="bak-clear">Clear</button>
      </div>
      <div class="bak-hint">Press Ctrl+Enter to send</div>
    </div>
  `;
}

function getStyles() {
  return `
    :host, .bak-card {
      font-family: "Space Grotesk", "IBM Plex Sans", "Segoe UI", sans-serif;
      color: #0f172a;
    }
    .bak-card {
      width: 360px;
      max-height: 70vh;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.18);
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px;
    }
    .bak-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .bak-title {
      font-weight: 700;
      font-size: 1rem;
    }
    .bak-subtitle {
      font-size: 0.78rem;
      color: #64748b;
    }
    .bak-close {
      border: none;
      background: #e2e8f0;
      border-radius: 10px;
      width: 28px;
      height: 28px;
      font-size: 1.1rem;
      cursor: pointer;
    }
    .bak-settings {
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 8px 10px;
      background: #ffffff;
    }
    .bak-settings summary {
      cursor: pointer;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .bak-settings label {
      display: block;
      font-size: 0.78rem;
      font-weight: 600;
      color: #475569;
      margin-top: 6px;
    }
    .bak-settings input {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      margin-top: 4px;
      border-radius: 8px;
      border: 1px solid #cbd5f5;
      font: inherit;
      font-size: 0.85rem;
    }
    .bak-log {
      flex: 1 1 auto;
      min-height: 160px;
      max-height: 35vh;
      overflow-y: auto;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
      padding: 8px;
      background: #ffffff;
    }
    .message {
      margin-bottom: 10px;
    }
    .message .bubble {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 12px;
      max-width: 90%;
      line-height: 1.35;
      font-size: 0.85rem;
    }
    .message.user {
      text-align: right;
    }
    .message.user .bubble {
      background: #0f172a;
      color: #ffffff;
    }
    .message.assistant .bubble {
      background: #e2e8f0;
      color: #0f172a;
    }
    .bak-status {
      font-size: 0.75rem;
      color: #64748b;
    }
    .bak-input {
      width: 100%;
      box-sizing: border-box;
      border-radius: 12px;
      border: 1px solid #cbd5f5;
      padding: 8px;
      font: inherit;
      font-size: 0.85rem;
      resize: vertical;
      min-height: 60px;
    }
    .bak-actions {
      display: flex;
      gap: 8px;
    }
    .bak-actions button {
      flex: 1;
      padding: 8px 10px;
      border-radius: 10px;
      border: none;
      background: #0f172a;
      color: #ffffff;
      cursor: pointer;
      font-weight: 600;
    }
    .bak-actions button.bak-undo {
      background: #334155;
    }
    .bak-actions button.bak-clear {
      background: #e2e8f0;
      color: #0f172a;
    }
    .bak-hint {
      font-size: 0.72rem;
      color: #94a3b8;
      text-align: center;
    }
  `;
}
