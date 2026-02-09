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
  root.style.position = "fixed";
  root.style.left = "16px";
  root.style.top = "16px";
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

  const mountRoot = () => {
    const pageRoot = document.querySelector("div.tm-page") || document.body;
    pageRoot.appendChild(root);
    return true;
  };

  mountRoot();

  const observer = new MutationObserver(() => {
    if (!root.isConnected) {
      mountRoot();
    } else {
      const currentStats = article.querySelector("div.stats");
      if (currentStats && root.parentElement !== currentStats) {
        currentStats.appendChild(root);
      }
    }
  });
  observer.observe(article, { childList: true, subtree: true });

  const detailSlider = shadow.querySelector(".bak-detail");
  const detailValue = shadow.querySelector(".bak-detail-value");
  const statusEl = shadow.querySelector(".bak-status");

  const agentMessages = createAgentMessages(
    "System: You are a Habr article summarizer. Only work on habr.com article pages. " +
      "You will be given article paragraphs and a target percent of words to emphasize. " +
      "Return ranked segments for each paragraph by calling the rankSegments tool. " +
      "Do not modify or remove the element with id '__bak-root'."
  );

  const agentContext = { viewRoot: document.body };

  let summaryGenerated = false;
  let summaryActive = false;
  let summaryLoading = false;
  let summaryApplied = false;
  let currentPercent = 100;
  const originalHtml = new Map();
  const summaryHtml = new Map();

  detailSlider?.addEventListener("input", async (event) => {
    const value = Number(event.target.value || 100);
    if (detailValue) detailValue.textContent = `${value}%`;
    if (value >= 100) {
      applySummaryMode(false);
      return;
    }
    if (summaryLoading) return;
    if (!summaryGenerated) {
      setSummaryLoading(true);
      summaryApplied = false;
      summaryHtml.clear();
      await generateSummary();
      summaryGenerated = true;
      setSummaryLoading(false);
    }
    if (!summaryApplied) {
      setStatus("Не удалось выделить ключевые фразы.");
      return;
    }
    currentPercent = value;
    applySummaryMode(true);
  });

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function setSummaryLoading(isLoading) {
    summaryLoading = isLoading;
    if (detailSlider) detailSlider.disabled = isLoading;
    if (detailValue) detailValue.textContent = isLoading ? "Loading..." : `${detailSlider?.value ?? 100}%`;
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

  let rankedItems = null;

  function applySummarySegments(items) {
    const nodes = [...article.querySelectorAll("p")];
    storeOriginal(nodes);
    let applied = 0;
    for (const item of items || []) {
      const idx = item.index;
      const node = nodes[idx];
      if (!node) continue;
      const html = buildSegmentsHtml(item.segments || []);
      summaryHtml.set(idx, html);
      node.innerHTML = html;
      applied += 1;
    }
    summaryApplied = applied > 0;
    return applied;
  }

  function rankSegmentsTool() {
    const inputSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number" },
              segments: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    rank: { type: "number" },
                    text: { type: "string" }
                  },
                  required: ["rank", "text"],
                  additionalProperties: false
                }
              }
            },
            required: ["index", "segments"],
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
        ok: { type: "boolean" }
      },
      required: ["ok"],
      additionalProperties: false
    };
    return new Tool(
      "rankSegments",
      "Return ranked segments for each paragraph.",
      async (args) => {
        rankedItems = args?.items ?? null;
        return { ok: true };
      },
      inputSchema,
      outputSchema
    );
  }

  const tools = [
    rankSegmentsTool()
  ];

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
      const { paragraphs } = extractHabrMarkdown();
      rankedItems = null;
      const prompt =
        "Тебе переданы абзацы статьи Habr. " +
        "Процент яркого текста: " + String(currentPercent) + "%. " +
        "Для каждого абзаца разбей текст на фразы и задай каждой фразе rank 0..9. " +
        "По умолчанию всем фразам ставь rank 1-2, потом поднимай rank только важным фразам. " +
        "Rank 9 — главная мысль (не более 10% слов абзаца), 7-8 — ключевые факты, 4-6 — важные детали, 1-3 — связки, 0 — шум. " +
        "Суммарно rank 9 должен покрывать <=10% слов абзаца, rank 8 <=15%, rank 7 <=20%. " +
        "Сегменты должны полностью покрывать исходный абзац, в исходном порядке. " +
        "Вызови rankSegments с массивом items=[{index, segments:[{rank, text}]}] для всех абзацев. " +
        "Не отвечай текстом, используй только вызов инструмента.\n\n" +
        "Абзацы:\n" +
        paragraphs.map((p, i) => `[#${i}] ${p}`).join("\n");
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
        if (event.type === "keepalive") {
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
      if (rankedItems) {
        const valid = validateRankedItems(rankedItems, paragraphs.length);
        if (valid.length) {
          applySummarySegments(valid);
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
    applyHeatmap();
  }

  function storeOriginal(nodes) {
    for (let i = 0; i < nodes.length; i += 1) {
      if (!originalHtml.has(i)) {
        originalHtml.set(i, nodes[i].innerHTML);
      }
    }
  }

  function applyHeatmap() {
    if (!summaryActive) return;
    const article = getHabrArticleRoot();
    const spans = [...article.querySelectorAll("[data-rank]")];
    const selected = selectBrightSpans(spans, currentPercent);
    for (const span of spans) {
      const rank = Number(span.dataset.rank || "0");
      span.classList.remove(
        "bak-rank-9",
        "bak-rank-dark",
        "bak-rank-mid",
        "bak-rank-light",
        "bak-rank-faint"
      );
      if (selected.has(span)) {
        span.classList.add("bak-rank-9");
        continue;
      }
      if (rank >= 7) {
        span.classList.add("bak-rank-dark");
        continue;
      }
      if (rank >= 4) {
        span.classList.add("bak-rank-mid");
        continue;
      }
      if (rank >= 1) {
        span.classList.add("bak-rank-light");
        continue;
      }
      span.classList.add("bak-rank-faint");
    }
  }

  function countWords(text) {
    const matches = String(text || "").match(/[\p{L}\p{N}]+/gu);
    return matches ? matches.length : 0;
  }

  function selectBrightSpans(spans, percent) {
    const clamped = Math.max(0, Math.min(100, percent));
    if (clamped >= 100) {
      return new Set(spans);
    }
    const withCounts = spans.map((span, idx) => ({
      span,
      rank: Number(span.dataset.rank || "0"),
      words: Number(span.dataset.words || countWords(span.textContent)),
      idx
    }));
    const totalWords = withCounts.reduce((sum, item) => sum + (item.words || 0), 0);
    const targetWords = Math.floor(totalWords * (clamped / 100));
    if (targetWords <= 0) return new Set();
    const sorted = withCounts.slice().sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return a.idx - b.idx;
    });
    const selected = new Set();
    let acc = 0;
    for (const item of sorted) {
      if (!item.words) continue;
      if (acc + item.words > targetWords) continue;
      selected.add(item.span);
      acc += item.words;
      if (acc >= targetWords) break;
    }
    return selected;
  }

  function buildSegmentsHtml(segments) {
    const escape = (text) =>
      String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return (segments || [])
      .map((seg) => {
        const rank = Number(seg.rank ?? 0);
        const text = seg.text ?? "";
        const words = countWords(text);
        return `<span data-rank="${rank}" data-words="${words}">${escape(text)}</span>`;
      })
      .join("");
  }

  function validateRankedItems(items, maxIndex) {
    if (!Array.isArray(items)) return [];
    const sanitized = [];
    for (const item of items) {
      if (!item || typeof item.index !== "number") continue;
      if (item.index < 0 || item.index >= maxIndex) continue;
      if (!Array.isArray(item.segments)) continue;
      const segments = [];
      for (const seg of item.segments) {
        if (!seg || typeof seg.text !== "string") continue;
        const rankNum = Number(seg.rank);
        if (!Number.isFinite(rankNum)) continue;
        const rank = Math.max(0, Math.min(9, Math.round(rankNum)));
        segments.push({ rank, text: seg.text });
      }
      if (segments.length === 0) continue;
      sanitized.push({ index: item.index, segments });
    }
    return sanitized;
  }

  if (detailSlider && detailValue) {
    detailSlider.value = "100";
    detailValue.textContent = "100%";
  }
  currentPercent = 100;
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
    article.tm-article-presenter__content.bak-summary-mode span[data-rank] {
      transition: color 120ms ease;
    }
    article.tm-article-presenter__content.bak-summary-mode .bak-rank-9 {
      color: #0f172a;
      font-weight: 700;
    }
    article.tm-article-presenter__content.bak-summary-mode .bak-rank-dark {
      color: rgba(15, 23, 42, 0.75);
    }
    article.tm-article-presenter__content.bak-summary-mode .bak-rank-mid {
      color: rgba(15, 23, 42, 0.6);
    }
    article.tm-article-presenter__content.bak-summary-mode .bak-rank-light {
      color: rgba(15, 23, 42, 0.45);
    }
    article.tm-article-presenter__content.bak-summary-mode .bak-rank-faint {
      color: rgba(15, 23, 42, 0.15);
    }
    @media (prefers-color-scheme: dark) {
      article.tm-article-presenter__content.bak-summary-mode .bak-rank-9 {
        color: #e2e8f0;
      }
      article.tm-article-presenter__content.bak-summary-mode .bak-rank-dark {
        color: rgba(226, 232, 240, 0.78);
      }
      article.tm-article-presenter__content.bak-summary-mode .bak-rank-mid {
        color: rgba(226, 232, 240, 0.6);
      }
      article.tm-article-presenter__content.bak-summary-mode .bak-rank-light {
        color: rgba(226, 232, 240, 0.48);
      }
      article.tm-article-presenter__content.bak-summary-mode .bak-rank-faint {
        color: rgba(226, 232, 240, 0.2);
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


function getTemplate() {
  return `
    <div class="bak-card">
      <div class="bak-header">
        <div>
          <div class="bak-title">Habr Summary</div>
        </div>
      </div>
      <div class="bak-slider">
        <label>Detail</label>
        <input class="bak-detail" type="range" min="0" max="100" step="10" value="100" />
        <span class="bak-detail-value">100%</span>
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
    .bak-status {
      font-size: 0.75rem;
      color: #64748b;
    }
    .bak-slider {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 0.85rem;
      color: #475569;
    }
    .bak-slider label {
      font-weight: 600;
    }
    .bak-detail {
      flex: 1;
    }
    .bak-detail-value {
      min-width: 44px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    @media (prefers-color-scheme: dark) {
      .bak-card {
        background: #0f172a;
        border-color: rgba(226, 232, 240, 0.16);
        color: #e2e8f0;
      }
      .bak-slider {
        color: rgba(226, 232, 240, 0.75);
      }
    }
  `;
}
