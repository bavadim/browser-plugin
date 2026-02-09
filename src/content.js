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
  const ttsPlayButton = shadow.querySelector(".bak-tts-play");
  const ttsStopButton = shadow.querySelector(".bak-tts-stop");
  const ttsProgress = shadow.querySelector(".bak-tts-progress");
  const ttsTime = shadow.querySelector(".bak-tts-time");

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
  let ttsState = "idle";
  let ttsAudio = null;
  let ttsAudioUrl = null;
  let ttsCleanText = null;
  let ttsHref = location.href;

  const TTS_MODEL = "gpt-4o-mini-tts";
  const TTS_VOICE = "alloy";
  const MAX_TTS_CHARS = 3500;
  const MAX_HTML_CHARS = 20000;
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

  function setTtsState(nextState) {
    ttsState = nextState;
    if (!ttsPlayButton) return;
    if (ttsState === "loading") {
      ttsPlayButton.disabled = true;
      ttsPlayButton.textContent = "Loading...";
      if (ttsStopButton) ttsStopButton.disabled = true;
      return;
    }
    ttsPlayButton.disabled = false;
    ttsPlayButton.textContent = ttsState === "playing" ? "Pause" : "Play";
    if (ttsStopButton) ttsStopButton.disabled = ttsState === "idle";
  }

  function resetTtsAudioUrl() {
    if (ttsAudioUrl) {
      URL.revokeObjectURL(ttsAudioUrl);
    }
    ttsAudioUrl = null;
    if (ttsAudio) {
      ttsAudio.pause();
      ttsAudio.src = "";
    }
  }

  function ensureTtsAudio() {
    if (ttsAudio) return;
    ttsAudio = new Audio();
    ttsAudio.preload = "auto";
    ttsAudio.addEventListener("ended", () => {
      if (ttsAudio) {
        ttsAudio.currentTime = 0;
      }
      setTtsState("paused");
      updateTtsProgress();
    });
    ttsAudio.addEventListener("timeupdate", updateTtsProgress);
    ttsAudio.addEventListener("loadedmetadata", updateTtsProgress);
  }

  function sanitizeCleanText(text) {
    return String(text || "")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\s+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractHabrHtml() {
    const article = getHabrArticleRoot();
    const clone = article.cloneNode(true);
    clone.querySelectorAll("script,style,nav,aside,footer,form,button,svg").forEach((node) => node.remove());
    clone.querySelectorAll("a").forEach((anchor) => {
      const text = document.createTextNode(anchor.textContent || "");
      anchor.replaceWith(text);
    });
    return clone.innerHTML;
  }

  function splitTextIntoChunks(text, maxChars) {
    const normalized = String(text || "").trim();
    if (!normalized) return [];
    const sentences = normalized.split(/(?<=[.!?])\s+/);
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
      if (!sentence) continue;
      if ((current + " " + sentence).trim().length > maxChars && current) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current = `${current} ${sentence}`.trim();
      }
    }
    if (current) chunks.push(current.trim());
    return chunks;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function updateTtsProgress() {
    if (!ttsAudio) return;
    const current = Number.isFinite(ttsAudio.currentTime) ? ttsAudio.currentTime : 0;
    const duration = Number.isFinite(ttsAudio.duration) ? ttsAudio.duration : 0;
    if (ttsProgress) {
      const max = duration > 0 ? duration : 1;
      ttsProgress.max = String(max);
      ttsProgress.value = String(Math.min(current, max));
    }
    if (ttsTime) {
      ttsTime.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    }
  }

  if (ttsProgress) {
    ttsProgress.addEventListener("input", () => {
      if (!ttsAudio) return;
      const next = Number(ttsProgress.value || "0");
      if (Number.isFinite(next)) {
        ttsAudio.currentTime = next;
        updateTtsProgress();
      }
    });
  }

  async function createResponseText(prompt, model, baseURL, apiKey) {
    const url = `${String(baseURL || "").replace(/\/+$/, "")}/responses`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, input: prompt })
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM error: ${response.status} ${errText}`);
    }
    const data = await response.json();
    if (data && typeof data.output_text === "string") {
      return data.output_text;
    }
    const output = Array.isArray(data?.output) ? data.output : [];
    const chunks = [];
    for (const item of output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const part of content) {
        if (typeof part?.text === "string") {
          chunks.push(part.text);
        }
      }
    }
    return chunks.join("").trim();
  }

  async function getCleanArticleText() {
    if (ttsCleanText && ttsHref === location.href) {
      return ttsCleanText;
    }
    const settings = await loadSettings();
    const baseURL = settings?.baseUrl?.trim() || DEFAULT_BASE_URL;
    const apiKey = settings?.apiKey?.trim() || "";
    const model = settings?.model?.trim() || DEFAULT_MODEL;
    if (!apiKey) {
      setStatus("Настройки модели не заполнены. Откройте Settings.");
      return null;
    }
    const rawHtml = extractHabrHtml();
    let source = rawHtml;
    let sourceType = "HTML";
    if (rawHtml.length > MAX_HTML_CHARS) {
      const { markdown } = extractHabrMarkdown();
      source = markdown;
      sourceType = "Markdown";
    }
    const prompt =
      "Ты редактор, готовишь текст для озвучки. " +
      "Нельзя выводить HTML, только чистый текст. " +
      "Нельзя оставлять ссылки, URL, якоря, email, соц-хендлы. " +
      "Нельзя добавлять факты или придумывать текст.\n\n" +
      "Задача: переписать материал в чистый связный текст для озвучки.\n" +
      "Требования:\n" +
      "1) Удали навигацию, меню, “читать далее”, кнопки, хлебные крошки, рекламные блоки, “Related/Читайте также”.\n" +
      "2) Удали все URL и якоря, вместо них оставь обычный текст без ссылок.\n" +
      "3) Убери мусорные элементы (повторы, обрывки фраз, списки ссылок, подписи кнопок).\n" +
      "4) Сохрани структуру: заголовки и абзацы, списки, но без HTML.\n" +
      "5) Сохрани порядок и смысл, не добавляй ничего от себя.\n" +
      "Формат: чистый текст. Каждый абзац с новой строки.\n\n" +
      `Источник (${sourceType}):\n` +
      "```\n" +
      source +
      "\n```";
    const cleaned = sanitizeCleanText(await createResponseText(prompt, model, baseURL, apiKey));
    if (!cleaned) {
      throw new Error("LLM вернул пустой текст.");
    }
    ttsCleanText = cleaned;
    ttsHref = location.href;
    return cleaned;
  }

  async function generateTtsAudio(text) {
    const settings = await loadSettings();
    const baseURL = settings?.baseUrl?.trim() || DEFAULT_BASE_URL;
    const apiKey = settings?.apiKey?.trim() || "";
    if (!apiKey) {
      setStatus("Настройки модели не заполнены. Откройте Settings.");
      return null;
    }
    const chunks = splitTextIntoChunks(text, MAX_TTS_CHARS);
    if (!chunks.length) {
      throw new Error("Нет текста для озвучки.");
    }
    const blobs = [];
    for (let i = 0; i < chunks.length; i += 1) {
      setStatus(`Генерирую озвучку ${i + 1}/${chunks.length}...`);
      const url = `${String(baseURL || "").replace(/\/+$/, "")}/audio/speech`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: TTS_MODEL,
          voice: TTS_VOICE,
          input: chunks[i],
          response_format: "mp3"
        })
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`TTS error: ${response.status} ${errText}`);
      }
      const buffer = await response.arrayBuffer();
      blobs.push(new Blob([buffer], { type: "audio/mpeg" }));
    }
    const blob = new Blob(blobs, { type: "audio/mpeg" });
    return URL.createObjectURL(blob);
  }

  ttsPlayButton?.addEventListener("click", async () => {
    try {
      if (ttsState === "loading") return;
      ensureTtsAudio();
      if (!ttsAudio) return;
      if (ttsHref !== location.href) {
        ttsCleanText = null;
        ttsHref = location.href;
        resetTtsAudioUrl();
      }
      if (ttsState === "playing") {
        ttsAudio.pause();
        setTtsState("paused");
        updateTtsProgress();
        return;
      }
      if (ttsAudioUrl) {
        await ttsAudio.play();
        setTtsState("playing");
        return;
      }
      setTtsState("loading");
      setStatus("Готовлю текст для озвучки...");
      const text = await getCleanArticleText();
      if (!text) {
        setTtsState("idle");
        return;
      }
      const audioUrl = await generateTtsAudio(text);
      if (!audioUrl) {
        setTtsState("idle");
        return;
      }
      resetTtsAudioUrl();
      ttsAudioUrl = audioUrl;
      ttsAudio.src = audioUrl;
      await ttsAudio.play();
      setTtsState("playing");
      updateTtsProgress();
      setStatus("");
    } catch (error) {
      setTtsState("idle");
      setStatus(String(error));
    }
  });

  ttsStopButton?.addEventListener("click", () => {
    if (!ttsAudio) return;
    ttsAudio.pause();
    ttsAudio.currentTime = 0;
    setTtsState("paused");
    updateTtsProgress();
  });

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
  setTtsState("idle");
  updateTtsProgress();
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
      <div class="bak-tts">
        <button class="bak-tts-play" type="button">Play</button>
        <button class="bak-tts-stop" type="button">Stop</button>
        <span class="bak-tts-label">AI-озвучка</span>
      </div>
      <div class="bak-tts-progress-row">
        <input class="bak-tts-progress" type="range" min="0" max="1" step="0.1" value="0" />
        <span class="bak-tts-time">0:00 / 0:00</span>
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
    .bak-tts {
      display: flex;
      justify-content: flex-start;
      align-items: center;
      gap: 8px;
    }
    .bak-tts-play {
      appearance: none;
      border: 1px solid #e2e8f0;
      background: #f8fafc;
      color: #0f172a;
      font-weight: 600;
      font-size: 0.8rem;
      padding: 6px 12px;
      border-radius: 10px;
      cursor: pointer;
    }
    .bak-tts-play:hover {
      background: #e2e8f0;
    }
    .bak-tts-play:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .bak-tts-stop {
      appearance: none;
      border: 1px solid #e2e8f0;
      background: #ffffff;
      color: #0f172a;
      font-weight: 600;
      font-size: 0.8rem;
      padding: 6px 12px;
      border-radius: 10px;
      cursor: pointer;
    }
    .bak-tts-stop:hover {
      background: #e2e8f0;
    }
    .bak-tts-stop:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .bak-tts-label {
      font-size: 0.72rem;
      color: #64748b;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .bak-tts-progress-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .bak-tts-progress {
      flex: 1;
      height: 4px;
      accent-color: #0f172a;
    }
    .bak-tts-time {
      min-width: 84px;
      text-align: right;
      font-size: 0.75rem;
      color: #64748b;
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
      .bak-tts-play {
        background: #111827;
        border-color: rgba(226, 232, 240, 0.16);
        color: #e2e8f0;
      }
      .bak-tts-play:hover {
        background: #1f2937;
      }
      .bak-tts-stop {
        background: #0b1220;
        border-color: rgba(226, 232, 240, 0.16);
        color: #e2e8f0;
      }
      .bak-tts-stop:hover {
        background: #1f2937;
      }
      .bak-tts-label {
        color: rgba(226, 232, 240, 0.6);
      }
      .bak-tts-progress {
        accent-color: #e2e8f0;
      }
      .bak-tts-time {
        color: rgba(226, 232, 240, 0.6);
      }
    }
  `;
}
