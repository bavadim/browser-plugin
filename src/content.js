import {
  createOpenAIResponsesAdapter,
  createAgentMessages,
  isAgentError,
  runAgent,
  Tool,
  withStatus
} from "browseragentkit";

const ROOT_ID = "__bak-root";
const STORAGE_KEY = "bak_settings_v1";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.1-codex-mini";

const api = globalThis.chrome ?? globalThis.browser;

const existingRoot = document.getElementById(ROOT_ID);
if (!existingRoot) {
  init();
}

function init() {
  if (!location?.hostname?.endsWith("habr.com") || !location?.pathname?.includes("/articles/")) {
    return;
  }
  let article;
  try {
    article = getHabrArticleRoot();
  } catch {
    return;
  }
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.all = "initial";
  root.style.position = "relative";
  root.style.zIndex = "2147483647";

  const shadow = root.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = getStyles();
  shadow.appendChild(style);

  const container = document.createElement("div");
  container.className = "bak-container";
  container.innerHTML = getTemplate();
  shadow.appendChild(container);

  ensureSummaryStyle();

  const stats = article.querySelector("div.stats");
  if (stats) {
    stats.appendChild(root);
  } else {
    const h1 = article.querySelector("h1.tm-title.tm-title_h1[data-test-id='articleTitle']");
    if (h1?.parentElement) {
      h1.parentElement.insertBefore(root, h1.nextSibling);
    } else {
      article.prepend(root);
    }
  }

  const settingsBtn = shadow.querySelector(".bak-settings-btn");
  const summaryBtn = shadow.querySelector(".bak-summary-btn");
  const originalBtn = shadow.querySelector(".bak-original-btn");
  const statusEl = shadow.querySelector(".bak-status");

  const agentMessages = createAgentMessages(
    "System: You are a Habr article summarizer. Only work on habr.com article pages. " +
      "Use the provided tools to extract article text and apply summary markup. " +
      "For each paragraph, return HTML with <strong> around the key phrases (2-6 words each). " +
      "Do not add any other tags. Do not modify or remove the element with id '__bak-root'."
  );

  const tools = [
    articleExtractMdTool(),
    applySummaryMarkupTool()
  ];

  const agentContext = { viewRoot: document.body };

  settingsBtn?.addEventListener("click", () => {
    api?.runtime?.openOptionsPage?.();
  });

  let summaryGenerated = false;
  let summaryActive = false;
  let summaryLoading = false;
  let summaryApplied = false;
  const originalHtml = new Map();
  const summaryHtml = new Map();

  summaryBtn?.addEventListener("click", async () => {
    if (summaryLoading) return;
    if (!summaryGenerated) {
      setSummaryLoading(true);
      await generateSummary();
      summaryGenerated = true;
      setSummaryLoading(false);
    }
    if (summaryApplied) {
      applySummaryMode(true);
    } else {
      setStatus("Не удалось выделить ключевые фразы.");
    }
  });

  originalBtn?.addEventListener("click", () => {
    applySummaryMode(false);
  });

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function setSummaryLoading(isLoading) {
    summaryLoading = isLoading;
    if (!summaryBtn) return;
    summaryBtn.disabled = isLoading;
    summaryBtn.textContent = isLoading ? "Loading..." : "Summary";
  }

  function loadSettings() {
    return new Promise((resolve) => {
      if (!api?.storage?.local) {
        resolve(null);
        return;
      }
      storageGet([STORAGE_KEY], (res) => {
        resolve(res?.[STORAGE_KEY] ?? null);
      });
    });
  }

  async function getAdapter() {
    const settings = await loadSettings();
    const baseURL = settings?.baseUrl?.trim() || DEFAULT_BASE_URL;
    const apiKey = settings?.apiKey?.trim() || "";
    const model = settings?.model?.trim() || DEFAULT_MODEL;
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

  async function generateSummary() {
    try {
      if (!location?.hostname?.endsWith("habr.com")) return;
      if (!location?.pathname?.includes("/articles/")) return;
      const adapter = await getAdapter();
      if (!adapter) {
        setStatus("Настройки модели не заполнены. Откройте Settings.");
        return;
      }
      setStatus("Генерирую summary...");
      const prompt =
        "Ты на странице статьи Habr. " +
        "Сначала вызови articleExtractMd. " +
        "Далее для каждого абзаца верни HTML с <strong> вокруг главных фраз (2-6 слов). " +
        "Не добавляй других тегов. " +
        "Вызови applySummaryMarkup с массивом items=[{index, html}] для всех абзацев.";
      let thinkingSummary = "";
      for await (const ev of withStatus(
        runAgent(
          agentMessages,
          adapter.generate,
          prompt,
          [...tools],
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
          setStatus(String(error));
          break;
        }
        const event = ev.right;
        if (event.type === "message.delta") {
          // no-op
        }
        if (event.type === "message") {
          // no-op
        }
        if (event.type === "status") {
          if (event.status.kind !== "thinking") {
            thinkingSummary = "";
          }
          setStatus(event.status.label || event.status.kind);
        }
        if (event.type === "thinking.delta") {
          thinkingSummary += event.delta;
        }
        if (event.type === "thinking") {
          thinkingSummary = event.summary;
        }
      }
      if (!summaryApplied) {
        setStatus("Summary не применен. Проверьте ключ и модель.");
      }
      setStatus("");
    } catch (error) {
      setStatus(String(error));
    }
  }

  function applySummaryMode(enabled) {
    const article = getHabrArticleRoot();
    summaryActive = enabled;
    article.classList.toggle("bak-summary-mode", summaryActive);
    const nodes = [...article.querySelectorAll("p")];
    if (!summaryActive) {
      for (let i = 0; i < nodes.length; i += 1) {
        const original = originalHtml.get(i);
        if (original) nodes[i].innerHTML = original;
      }
      return;
    }
    for (let i = 0; i < nodes.length; i += 1) {
      const summary = summaryHtml.get(i);
      if (summary) nodes[i].innerHTML = summary;
    }
  }

  function storeOriginal(nodes) {
    for (let i = 0; i < nodes.length; i += 1) {
      if (!originalHtml.has(i)) {
        originalHtml.set(i, nodes[i].innerHTML);
      }
    }
  }

  async function autoSummary() {
    if (summaryLoading || summaryGenerated) return;
    setSummaryLoading(true);
    await generateSummary();
    summaryGenerated = true;
    setSummaryLoading(false);
    if (summaryApplied) {
      applySummaryMode(true);
    }
  }

  autoSummary();
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

function ensureSummaryStyle() {
  const styleId = "__bak-summary-style";
  if (document.getElementById(styleId)) return;
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    article.tm-article-presenter__content.bak-summary-mode p {
      color: rgba(15, 23, 42, 0.45);
    }
    article.tm-article-presenter__content.bak-summary-mode strong {
      color: #0f172a;
      font-weight: 700;
    }
    @media (prefers-color-scheme: dark) {
      article.tm-article-presenter__content.bak-summary-mode p {
        color: rgba(226, 232, 240, 0.45);
      }
      article.tm-article-presenter__content.bak-summary-mode strong {
        color: #e2e8f0;
      }
    }
  `;
  document.head.appendChild(style);
}

function getHabrArticleRoot() {
  const article = document.querySelector("article.tm-article-presenter__content");
  if (!article) {
    throw new Error("Habr article container not found.");
  }
  return article;
}

function getHabrTitle(article) {
  const titleEl = article.querySelector("h1.tm-title.tm-title_h1[data-test-id='articleTitle']");
  const title = titleEl?.textContent?.trim();
  if (!title) {
    throw new Error("Habr article title not found.");
  }
  return title;
}

function getHabrParagraphs(article) {
  return [...article.querySelectorAll("p")]
    .map((p) => (p.textContent || "").trim())
    .filter(Boolean);
}

function extractHabrMarkdown() {
  const article = getHabrArticleRoot();
  const title = getHabrTitle(article);
  const paragraphs = getHabrParagraphs(article);
  const markdown = [`# ${title}`, "", ...paragraphs.map((p) => `${p}\n`)].join("\n").trim();
  return { title, markdown, paragraphs };
}


function articleExtractMdTool() {
  const inputSchema = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false
  };
  const outputSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      markdown: { type: "string" },
      paragraphs: { type: "array", items: { type: "string" } }
    },
    required: ["title", "markdown", "paragraphs"],
    additionalProperties: false
  };
  return new Tool(
    "articleExtractMd",
    "Extract the current Habr article into Markdown and return the paragraph list.",
    async () => {
      return extractHabrMarkdown();
    },
    inputSchema,
    outputSchema
  );
}

  function applySummaryMarkupTool() {
    const inputSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number" },
              html: { type: "string" }
            },
            required: ["index", "html"],
            additionalProperties: false
          }
        }
      },
      required: ["items"],
      additionalProperties: false
    };
    const outputSchema = {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        applied: { type: "number" }
      },
      required: ["ok", "applied"],
      additionalProperties: false
    };
    return new Tool(
      "applySummaryMarkup",
      "Apply summary markup by replacing each paragraph HTML with <strong> highlights.",
      async (args) => {
        const { items } = args;
        const article = getHabrArticleRoot();
        const nodes = [...article.querySelectorAll("p")];
        storeOriginal(nodes);
        let applied = 0;
        for (const item of items || []) {
          const idx = item.index;
          const node = nodes[idx];
          if (!node) continue;
          summaryHtml.set(idx, item.html);
          node.innerHTML = item.html;
          applied += 1;
        }
        summaryApplied = applied > 0;
        return { ok: applied > 0, applied };
      },
      inputSchema,
      outputSchema
    );
  }

function getTemplate() {
  return `
    <div class="bak-card">
      <div class="bak-header">
        <div>
          <div class="bak-title">Habr Summary</div>
          <div class="bak-subtitle">Скорочтение</div>
        </div>
        <button class="bak-settings-btn" title="Settings">⚙</button>
      </div>
      <div class="bak-actions">
        <button class="bak-summary-btn">Summary</button>
        <button class="bak-original-btn ghost">Original</button>
      </div>
      <div class="bak-status"></div>
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
      width: 100%;
      max-width: 420px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px 14px;
    }
    .bak-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .bak-header-actions {
      display: flex;
      gap: 6px;
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
    .bak-settings-btn {
      border: none;
      background: #e2e8f0;
      border-radius: 10px;
      width: 28px;
      height: 28px;
      font-size: 1.1rem;
      cursor: pointer;
    }
    .bak-settings-btn {
      font-size: 0.95rem;
    }
    .bak-status {
      font-size: 0.75rem;
      color: #64748b;
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
    .bak-actions button.ghost {
      background: #e2e8f0;
      color: #0f172a;
    }
    @media (prefers-color-scheme: dark) {
      .bak-card {
        background: #0f172a;
        border-color: rgba(226, 232, 240, 0.16);
        color: #e2e8f0;
      }
      .bak-actions button.ghost {
        background: rgba(226, 232, 240, 0.12);
        color: #e2e8f0;
      }
    }
  `;
}
