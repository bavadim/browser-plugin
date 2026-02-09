import {
  createOpenAIResponsesAdapter,
  createAgentMessages,
  isAgentError,
  runAgent,
  Tool,
  Skill,
  withStatus
} from "browseragentkit";
import { createChatUi } from "browseragentkit/ui";

const ROOT_ID = "__bak-root";
const SKILL_ID = "bak-skill-habr-article";
const STORAGE_KEY = "bak_settings_v1";
const HISTORY_KEY = "bak_history_v1";
const UNDO_KEY = "bak_undo_v1";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.1-codex-mini";

const api = globalThis.chrome ?? globalThis.browser;

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
  const settingsBtn = shadow.querySelector(".bak-settings-btn");
  const runBtn = shadow.querySelector(".bak-run");
  const undoBtn = shadow.querySelector(".bak-undo");
  const clearBtn = shadow.querySelector(".bak-clear");
  const promptInput = shadow.querySelector(".bak-input");
  const chatLog = shadow.querySelector(".bak-log");
  const statusEl = shadow.querySelector(".bak-status");

  const chatUi = chatLog ? createChatUi({ container: chatLog }) : null;

  const agentMessages = createAgentMessages(
    "System: You are a Habr article assistant. Only work on habr.com article pages. " +
      "Use the provided tools to: extract the article as Markdown, rank paragraphs, " +
      "highlight key paragraphs, and insert a TTS player. " +
      "Do not modify or remove the element with id '__bak-root'. " +
      "Avoid arbitrary DOM edits outside the tools."
  );

  ensureSkillTag();

  const skills = [
    Skill.fromDomSelector(`//script[@id='${SKILL_ID}']`, document)
  ];

  const tools = [
    articleExtractMdTool(),
    highlightKeywordsTool(),
    insertTtsPlayerTool()
  ];

  const agentContext = { viewRoot: document.body };

  const history = [];
  const undoStack = [];

  restoreHistory();
  restoreUndo();

  closeBtn?.addEventListener("click", () => toggle(false));
  settingsBtn?.addEventListener("click", () => {
    api?.runtime?.openOptionsPage?.();
  });

  runBtn?.addEventListener("click", async () => {
    const prompt = promptInput?.value?.trim();
    if (!prompt) return;

    const adapter = await getAdapter();
    if (!adapter) {
      addAssistantMessage("Missing model settings. Open Settings to add base URL and API key.");
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

  async function maybeAutoRun() {
    try {
      if (!location?.hostname?.endsWith("habr.com")) return;
      if (!location?.pathname?.includes("/articles/")) return;
      if (globalThis.__bakAutoRunDone) return;
      globalThis.__bakAutoRunDone = true;
      const adapter = await getAdapter();
      if (!adapter) {
        addAssistantMessage("Настройки модели не заполнены. Откройте Settings.");
        return;
      }
      addAssistantMessage("Авто-режим: выделяю ключевые абзацы и добавляю озвучку.");
      const prompt =
        "Ты на странице статьи Habr. Выдели 5 самых важных абзацев и вставь плеер озвучки. " +
        "Сначала вызови articleExtractMd, затем выбери важные абзацы. " +
        "Для каждого важного абзаца верни 3-6 ключевых слов/фраз. " +
        "Вызови highlightKeywords с parameters: indices, className='bak-highlight', " +
        "keywords=[{index, words:[...]}]. Этот инструмент подсветит ключевые слова " +
        "и свернет все неважные абзацы/картинки. " +
        "После этого вызови insertTtsPlayer с markdown статьи и lang='ru-RU'.";
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
      setStatus("");
    } catch (error) {
      addAssistantMessage(`${String(error)}`);
    }
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
    skill.textContent = `---\nname: habr.article\n---\n# Goal\nWork only on Habr article pages. Extract the article in Markdown, rank paragraphs for importance, highlight key paragraphs with keywords, collapse unimportant blocks, and insert a TTS player.\n\n# Steps\n1) Call articleExtractMd to get title, markdown, and paragraphs.\n2) Ask the model to rank paragraphs and pick the top N.\n3) For each important paragraph, pick 3-6 keywords/phrases.\n4) Call highlightKeywords with indices, className, and keywords.\n5) Call insertTtsPlayer with the markdown to add a Russian TTS player before the first paragraph.\n\n# Rules\n- Do not modify or remove the element with id '__bak-root'.\n- Use only the provided tools for DOM changes.\n- Confirm what changed in a short response.`;
    document.documentElement.appendChild(skill);
  }

  globalThis.__bakPageAgent = {
    toggle
  };

  maybeAutoRun();
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

  function ensureHighlightStyle(className) {
    const styleId = "__bak-highlight-style";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
    .${className} {
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-left-width: 4px;
      border-radius: 10px;
      padding: 8px 10px;
      margin: 10px 0;
      background: rgba(15, 23, 42, 0.02);
      box-shadow: 0 6px 14px rgba(15, 23, 42, 0.06);
    }
    .bak-kw {
      font-weight: 600;
      text-decoration: underline dotted;
      text-underline-offset: 2px;
    }
    .bak-collapsed {
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .bak-collapsed.bak-hidden {
      display: none;
    }
    .bak-collapse-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.78rem;
      color: inherit;
      background: rgba(15, 23, 42, 0.06);
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 999px;
      padding: 4px 10px;
      margin: 6px 0;
      cursor: pointer;
    }
    @media (prefers-color-scheme: dark) {
      .${className} {
        border-color: rgba(226, 232, 240, 0.18);
        background: rgba(226, 232, 240, 0.04);
        box-shadow: 0 6px 14px rgba(2, 6, 23, 0.35);
      }
      .bak-collapse-toggle {
        background: rgba(226, 232, 240, 0.08);
        border-color: rgba(226, 232, 240, 0.2);
      }
    }
    `;
    document.head.appendChild(style);
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightKeywordsInElement(element, words) {
    if (!element || !words || words.length === 0) return;
    const normalized = words
      .map((w) => String(w || "").trim())
      .filter(Boolean)
      .map((w) => escapeRegExp(w));
    if (!normalized.length) return;
    const regex = new RegExp(`(${normalized.join("|")})`, "gi");
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node?.nodeValue?.trim()) textNodes.push(node);
    }
    for (const node of textNodes) {
      const text = node.nodeValue;
      if (!regex.test(text)) continue;
      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      text.replace(regex, (match, _g, offset) => {
        if (offset > lastIndex) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex, offset)));
        }
        const mark = document.createElement("span");
        mark.className = "bak-kw";
        mark.textContent = match;
        frag.appendChild(mark);
        lastIndex = offset + match.length;
        return match;
      });
      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      node.parentNode?.replaceChild(frag, node);
    }
  }

function ensureTtsStyle() {
  const styleId = "__bak-tts-style";
  if (document.getElementById(styleId)) return;
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    .bak-tts-card {
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      padding: 12px 14px;
      margin: 12px 0 18px;
      background: #ffffff;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
      font-family: "Space Grotesk", "IBM Plex Sans", "Segoe UI", sans-serif;
    }
    .bak-tts-title {
      font-weight: 700;
      font-size: 0.95rem;
      margin-bottom: 8px;
      color: #0f172a;
    }
    .bak-tts-controls {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .bak-tts-controls button {
      background: #0f172a;
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 6px 10px;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.85rem;
    }
    .bak-tts-controls button.secondary {
      background: #334155;
    }
    .bak-tts-controls button.ghost {
      background: #e2e8f0;
      color: #0f172a;
    }
    .bak-tts-status {
      font-size: 0.78rem;
      color: #64748b;
      margin-top: 6px;
    }
  `;
  document.head.appendChild(style);
}

function markdownToText(md) {
  let text = md || "";
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/`[^`]*`/g, "");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/\n{2,}/g, "\n");
  return text.trim();
}

function splitSentences(text) {
  const sentences = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (".!?…".includes(ch) && (!next || /\s/.test(next))) {
      const sentence = text.slice(start, i + 1).trim();
      if (sentence) sentences.push(sentence);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences.length ? sentences : [text];
}

function chunkText(text, maxLen = 2200) {
  const sentences = splitSentences(text);
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if ((current + " " + sentence).trim().length <= maxLen) {
      current = (current + " " + sentence).trim();
      continue;
    }
    if (current) chunks.push(current);
    if (sentence.length > maxLen) {
      for (let i = 0; i < sentence.length; i += maxLen) {
        chunks.push(sentence.slice(i, i + maxLen));
      }
      current = "";
    } else {
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function selectVoice(lang) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) {
      resolve(undefined);
      return;
    }
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      const byLang = voices.find((v) => v.lang === lang || v.lang?.startsWith(lang));
      resolve(byLang ?? voices[0]);
    };
    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length) {
      pick();
      return;
    }
    const onVoices = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", onVoices);
      pick();
    };
    window.speechSynthesis.addEventListener("voiceschanged", onVoices);
    setTimeout(() => {
      window.speechSynthesis.removeEventListener("voiceschanged", onVoices);
      pick();
    }, 1000);
  });
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

  function highlightKeywordsTool() {
    const inputSchema = {
      type: "object",
      properties: {
        indices: { type: "array", items: { type: "number" } },
        className: { type: "string" },
        keywords: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number" },
              words: { type: "array", items: { type: "string" } }
            },
            required: ["index", "words"],
            additionalProperties: false
          }
        }
      },
      required: ["indices", "className", "keywords"],
      additionalProperties: false
    };
    const outputSchema = {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        highlighted: { type: "number" },
        collapsed: { type: "number" }
      },
      required: ["ok", "highlighted", "collapsed"],
      additionalProperties: false
    };
    return new Tool(
      "highlightKeywords",
      "Highlight keywords in important Habr paragraphs and collapse unimportant blocks.",
      async (args) => {
        const { indices, className, keywords } = args;
        const article = getHabrArticleRoot();
        const nodes = [...article.querySelectorAll("p")];
        const cls = className?.trim() || "bak-highlight";
        ensureHighlightStyle(cls);
        const important = new Set(indices || []);
        const keywordMap = new Map();
        for (const item of keywords || []) {
          keywordMap.set(item.index, item.words || []);
        }
        let count = 0;
        let collapsed = 0;
        const collapsedGroup = [];
        const flushGroup = () => {
          if (collapsedGroup.length === 0) return;
          const group = collapsedGroup.slice();
          const toggle = document.createElement("button");
          toggle.className = "bak-collapse-toggle";
          toggle.textContent = "Показать скрытое";
          let expanded = false;
          toggle.addEventListener("click", () => {
            expanded = !expanded;
            for (const el of group) {
              el.classList.toggle("bak-hidden", !expanded);
              if (!expanded) {
                el.classList.add("bak-collapsed");
              } else {
                el.classList.remove("bak-collapsed");
              }
            }
            toggle.textContent = expanded ? "Скрыть" : "Показать скрытое";
          });
          const first = group[0];
          first.parentElement?.insertBefore(toggle, first);
          collapsedGroup.length = 0;
        };

        const addToGroup = (el) => {
          if (!el) return;
          if (el.classList.contains("bak-hidden")) return;
          el.classList.add("bak-collapsed", "bak-hidden");
          collapsedGroup.push(el);
          collapsed += 1;
        };

        for (let idx = 0; idx < nodes.length; idx += 1) {
          const node = nodes[idx];
          if (!node) continue;
          if (important.has(idx)) {
            flushGroup();
            node.classList.add(cls);
            highlightKeywordsInElement(node, keywordMap.get(idx) || []);
            count += 1;
            continue;
          }

          const prev = node.previousElementSibling;
          if (prev && (prev.tagName === "FIGURE" || prev.tagName === "IMG")) {
            addToGroup(prev);
          }
          addToGroup(node);
          const next = node.nextElementSibling;
          if (next && (next.tagName === "FIGURE" || next.tagName === "IMG")) {
            addToGroup(next);
          }
        }
        flushGroup();
        return { ok: count > 0, highlighted: count, collapsed };
      },
      inputSchema,
      outputSchema
    );
  }

function insertTtsPlayerTool() {
  const inputSchema = {
    type: "object",
    properties: {
      markdown: { type: "string" },
      lang: { type: "string" }
    },
    required: ["markdown", "lang"],
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
    "insertTtsPlayer",
    "Insert a TTS player for the Habr article before the first paragraph.",
    async (args) => {
      const { markdown, lang } = args;
      const article = getHabrArticleRoot();
      const firstP = article.querySelector("p");
      if (!firstP) {
        throw new Error("No paragraphs found in the Habr article.");
      }
      ensureTtsStyle();
      const existing = document.getElementById("__bak-tts-player");
      if (existing) existing.remove();

      const container = document.createElement("div");
      container.id = "__bak-tts-player";
      container.className = "bak-tts-card";

      const title = document.createElement("div");
      title.className = "bak-tts-title";
      title.textContent = "Озвучка статьи";

      const controls = document.createElement("div");
      controls.className = "bak-tts-controls";

      const playBtn = document.createElement("button");
      playBtn.textContent = "Play";
      const pauseBtn = document.createElement("button");
      pauseBtn.textContent = "Pause";
      pauseBtn.className = "secondary";
      const stopBtn = document.createElement("button");
      stopBtn.textContent = "Stop";
      stopBtn.className = "ghost";
      const progress = document.createElement("span");
      progress.className = "bak-tts-progress";
      progress.textContent = "0/0";

      const status = document.createElement("div");
      status.className = "bak-tts-status";
      status.textContent = "Нажмите Play для озвучки.";

      controls.append(playBtn, pauseBtn, stopBtn, progress);
      container.append(title, controls, status);

      firstP.parentElement?.insertBefore(container, firstP);

      if (!("speechSynthesis" in window)) {
        status.textContent = "Speech Synthesis не поддерживается в этом браузере.";
        return { ok: false };
      }

      const text = markdownToText(markdown);
      const chunks = chunkText(text);
      progress.textContent = `0/${chunks.length}`;

      let currentIndex = 0;
      let voice;
      let isPlaying = false;

      const speakNext = async () => {
        if (currentIndex >= chunks.length) {
          status.textContent = "Готово.";
          isPlaying = false;
          return;
        }
        if (!voice) {
          voice = await selectVoice(lang);
        }
        const utter = new SpeechSynthesisUtterance(chunks[currentIndex]);
        if (voice) utter.voice = voice;
        utter.lang = lang;
        utter.onend = () => {
          currentIndex += 1;
          progress.textContent = `${currentIndex}/${chunks.length}`;
          if (isPlaying) speakNext();
        };
        utter.onerror = () => {
          status.textContent = "Ошибка озвучки.";
          isPlaying = false;
        };
        window.speechSynthesis.speak(utter);
      };

      playBtn.addEventListener("click", async () => {
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
          status.textContent = "Воспроизведение...";
          isPlaying = true;
          return;
        }
        if (window.speechSynthesis.speaking) {
          return;
        }
        status.textContent = "Воспроизведение...";
        isPlaying = true;
        await speakNext();
      });

      pauseBtn.addEventListener("click", () => {
        if (!window.speechSynthesis.speaking) return;
        window.speechSynthesis.pause();
        status.textContent = "Пауза.";
      });

      stopBtn.addEventListener("click", () => {
        window.speechSynthesis.cancel();
        currentIndex = 0;
        progress.textContent = `0/${chunks.length}`;
        status.textContent = "Остановлено.";
        isPlaying = false;
      });

      return { ok: true };
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
          <div class="bak-title">Page Agent</div>
          <div class="bak-subtitle">Customize this page</div>
        </div>
        <div class="bak-header-actions">
          <button class="bak-settings-btn" title="Settings">⚙</button>
          <button class="bak-close" title="Close">×</button>
        </div>
      </div>
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
    .bak-close, .bak-settings-btn {
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
