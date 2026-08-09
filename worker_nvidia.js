/**
 * worker_n.js
 * ---------------------------------------------------------------------------
 * Fixed for Cloudflare Workers Free Plan.
 * Changes made:
 * 1. Removed ctx.waitUntil to bypass the 30-second wall-clock limit.
 * 2. Added a KV Lock to prevent Telegram webhook retries from duplicating messages.
 * 3. Added Stall Detection and Stream Error handling to prevent silent cutoffs.
 * 4. Disabled streaming for z-ai/glm-5.2 to avoid known NVIDIA NIM stalls.
 * ---------------------------------------------------------------------------
 */

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const NVIDIA_FREE_MODELS = [
  "minimaxai/minimax-m2.7",
  "minimaxai/minimax-m3",
  "z-ai/glm-5.2",
  "deepseek-ai/deepseek-v4-pro",
  "deepseek-ai/deepseek-v4-flash",
  "moonshotai/kimi-k2.6",
  "nemotron-3-ultra-550b-a55b",
];

const DEFAULT_MODEL = NVIDIA_FREE_MODELS[0];

const MODEL_API_ID_OVERRIDES = {
  "nemotron-3-ultra-550b-a55b": "nvidia/nemotron-3-ultra-550b-a55b",
};

const BOT_COMMANDS = [
  { command: "start", description: "Start the bot / show welcome message" },
  { command: "help", description: "Show help and usage hints" },
  { command: "model", description: "Choose the AI model to chat with" },
  { command: "addapi", description: "Add your own NVIDIA API key" },
  { command: "removeapi", description: "Remove your saved API key" },
];

const ASK_API_KEY_PROMPT =
  "🔑 Please reply to THIS message with your NVIDIA API key.\n" +
  "It will be stored only for your chat and used instead of the bot's default key.\n" +
  "Send /removeapi anytime to delete it.";

const MAX_CHUNK_LEN = 3900;
const PROVIDER_TIMEOUT_MS = 90000; // 90s ceiling for NVIDIA responses

let uiConfigured = false;

class ProviderError extends Error {}

// ────────────────────────────────────────────────────────────────────────
// Small utilities
// ────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ────────────────────────────────────────────────────────────────────────
// LaTeX -> Unicode
// ────────────────────────────────────────────────────────────────────────

const GREEK_MAP = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ",
  nu: "ν", xi: "ξ", omicron: "ο", pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
  upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const SUP_MAP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "n": "ⁿ", "i": "ⁱ" };
const SUB_MAP = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋" };

const LATEX_SYMBOLS = [
  [/\\times/g, "×"], [/\\cdot/g, "·"], [/\\div/g, "÷"], [/\\pm/g, "±"], [/\\mp/g, "∓"],
  [/\\leq/g, "≤"], [/\\geq/g, "≥"], [/\\neq/g, "≠"], [/\\approx/g, "≈"], [/\\equiv/g, "≡"],
  [/\\infty/g, "∞"], [/\\partial/g, "∂"], [/\\nabla/g, "∇"], [/\\sum/g, "∑"], [/\\prod/g, "∏"],
  [/\\int/g, "∫"], [/\\sqrt/g, "√"], [/\\in/g, "∈"], [/\\notin/g, "∉"], [/\\subset/g, "⊂"],
  [/\\subseteq/g, "⊆"], [/\\rightarrow/g, "→"], [/\\leftarrow/g, "←"], [/\\Rightarrow/g, "⇒"],
  [/\\leftrightarrow/g, "↔"], [/\\forall/g, "∀"], [/\\exists/g, "∃"], [/\\emptyset/g, "∅"],
  [/\\cup/g, "∪"], [/\\cap/g, "∩"], [/\\ldots/g, "…"], [/\\cdots/g, "⋯"], [/\\degree/g, "°"],
];

function convertLatex(raw) {
  let s = raw;
  for (const [name, glyph] of Object.entries(GREEK_MAP)) {
    s = s.replace(new RegExp(`\\\\${name}\\b`, "g"), glyph);
  }
  for (const [re, glyph] of LATEX_SYMBOLS) s = s.replace(re, glyph);
  s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1/$2)");
  s = s.replace(/√\{([^{}]*)\}/g, "√($1)");
  s = s.replace(/\^\{([^{}]+)\}/g, (_, g) => g.split("").map((c) => SUP_MAP[c] || c).join(""));
  s = s.replace(/\^([0-9a-zA-Z+\-])/g, (_, c) => SUP_MAP[c] || `^${c}`);
  s = s.replace(/_\{([^{}]+)\}/g, (_, g) => g.split("").map((c) => SUB_MAP[c] || c).join(""));
  s = s.replace(/_([0-9+\-])/g, (_, c) => SUB_MAP[c] || `_${c}`);
  s = s.replace(/\\left|\\right/g, "");
  s = s.replace(/\\text\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\mathrm\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\,|\\;|\\:|\\!/g, " ");
  s = s.replace(/\\\\/g, "\n");
  s = s.replace(/[{}]/g, "");
  return s.trim();
}

function renderMathSegments(text) {
  let out = text;
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => `\n${convertLatex(expr)}\n`);
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => `\n${convertLatex(expr)}\n`);
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => convertLatex(expr));
  out = out.replace(/(^|[^$])\$(?!\$)([^$\n]+?)\$(?!\$)/g, (_, before, expr) => `${before}${convertLatex(expr)}`);
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Markdown -> HTML
// ────────────────────────────────────────────────────────────────────────

function markdownToTelegramHtml(raw) {
  if (!raw) return "";
  const codeBlocks = [];
  const inlineCodes = [];

  let text = raw.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang || "", code });
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });

  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return `\u0000IC${inlineCodes.length - 1}\u0000`;
  });

  text = renderMathSegments(text);
  text = escapeHtml(text);

  text = text.replace(/^ {0,3}#{1,6}\s+(.+)$/gm, (_, t) => `<b>${t.trim()}</b>`);
  text = text.replace(/\*\*([^\n*]+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^\n_]+?)__/g, "<b>$1</b>");
  text = text.replace(/\*([^\n*]+?)\*/g, "<i>$1</i>");
  text = text.replace(/(?<![A-Za-z0-9])_([^\n_]+?)_(?![A-Za-z0-9])/g, "<i>$1</i>");
  text = text.replace(/~~([^\n~]+?)~~/g, "<s>$1</s>");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/^ {0,3}[-*]\s+/gm, "• ");

  text = text.replace(/\u0000IC(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(inlineCodes[Number(i)])}</code>`);
  text = text.replace(/\u0000CB(\d+)\u0000/g, (_, i) => {
    const { lang, code } = codeBlocks[Number(i)];
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`;
  });

  return text.trim();
}

function buildFinalHtml(content, reasoning) {
  const answerHtml = markdownToTelegramHtml(content && content.trim() ? content : "_(the model returned no text)_");
  if (reasoning && reasoning.trim()) {
    const reasoningHtml = markdownToTelegramHtml(reasoning);
    return (
      `🤔 <b>Thought process</b> <i>(tap to reveal)</i>\n` +
      `<tg-spoiler>${reasoningHtml}</tg-spoiler>\n\n` +
      `💬 <b>Answer</b>\n${answerHtml}`
    );
  }
  return answerHtml;
}

function splitHtmlSafely(html, maxLen = MAX_CHUNK_LEN) {
  if (!html) return [""];
  if (html.length <= maxLen) return [html];

  const rawChunks = [];
  let current = "";
  for (const line of html.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen && current) {
      rawChunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
    while (current.length > maxLen) {
      rawChunks.push(current.slice(0, maxLen));
      current = current.slice(maxLen);
    }
  }
  if (current) rawChunks.push(current);

  const tagRegex = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let openStack = [];
  const fixedChunks = [];
  for (const chunk of rawChunks) {
    const prefix = openStack.map((t) => `<${t.name}${t.attr}>`).join("");
    const localStack = [...openStack];
    let m;
    tagRegex.lastIndex = 0;
    while ((m = tagRegex.exec(chunk)) !== null) {
      const closing = m[1] === "/";
      const name = m[2];
      const attr = m[3] || "";
      if (!closing) {
        localStack.push({ name, attr });
      } else {
        for (let i = localStack.length - 1; i >= 0; i--) {
          if (localStack[i].name === name) {
            localStack.splice(i, 1);
            break;
          }
        }
      }
    }
    const suffix = [...localStack].reverse().map((t) => `</${t.name}>`).join("");
    fixedChunks.push(prefix + chunk + suffix);
    openStack = localStack;
  }
  return fixedChunks;
}

// ────────────────────────────────────────────────────────────────────────
// Per-model NVIDIA request payloads
// ────────────────────────────────────────────────────────────────────────

function apiModelId(modelId) {
  return MODEL_API_ID_OVERRIDES[modelId] || modelId;
}

function buildRequestPayload(modelId, message) {
  const messages = [{ role: "user", content: message }];
  const apiId = apiModelId(modelId);

  switch (modelId) {
    case "z-ai/glm-5.2":
      return {
        stream: false, // Disabled streaming to avoid known NIM stalls for GLM-5.2
        body: {
          model: apiId,
          messages,
          temperature: 1,
          top_p: 1,
          max_tokens: 8192, // Reduced to avoid context/token limit errors on Free tier
          stream: false,
        },
      };

    case "moonshotai/kimi-k2.6":
      return {
        stream: true,
        body: {
          model: apiId,
          messages,
          chat_template_kwargs: { enable_thinking: true },
          max_tokens: 4096,
          temperature: 1,
          top_p: 0.95,
          stream: true,
        },
      };

    case "nemotron-3-ultra-550b-a55b":
      return {
        stream: true,
        body: {
          model: apiId,
          messages,
          temperature: 1,
          top_p: 0.95,
          max_tokens: 8192,
          reasoning_budget: 8192,
          chat_template_kwargs: { enable_thinking: true },
          stream: true,
        },
      };

    case "deepseek-ai/deepseek-v4-flash":
      return {
        stream: false,
        body: {
          model: apiId,
          messages,
          temperature: 1,
          top_p: 0.95,
          max_tokens: 8192,
          chat_template_kwargs: { thinking: true, reasoning_effort: "high" },
          stream: false,
        },
      };

    default:
      return {
        stream: false,
        body: {
          model: apiId,
          messages,
          temperature: 1,
          top_p: 0.95,
          max_tokens: 8192,
          stream: false,
        },
      };
  }
}

async function readWithTimeout(reader, timeoutMs) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError("The AI stream stalled for too long and was aborted.")), timeoutMs);
  });
  
  try {
    const result = await Promise.race([reader.read(), timeoutPromise]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function consumeSSEStream(body, onPartial) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";

  while (true) {
    // Use a timeout wrapper to detect if NVIDIA stops sending data (stalls)
    const { value, done } = await readWithTimeout(reader, 20000);
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      // Catch API errors returned inside the stream (prevents silent cutoffs)
      if (json.error) {
        throw new ProviderError(`NVIDIA Stream Error: ${json.error.message || JSON.stringify(json.error)}`);
      }

      const delta = json?.choices?.[0]?.delta || {};
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      else if (delta.reasoning) reasoning += delta.reasoning;

      if (onPartial) {
        try {
          await onPartial({ content, reasoning });
        } catch {
          /* ignore preview errors */
        }
      }
    }
  }

  return { content, reasoning: reasoning || null };
}

async function callNvidia(modelId, message, apiKey, onPartial) {
  const { stream, body } = buildRequestPayload(modelId, message);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(NVIDIA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new ProviderError("NVIDIA API did not respond in time (timeout). Please try again.");
    }
    throw new ProviderError(`Could not reach the NVIDIA API from Cloudflare (${err.message}).`);
  }

  if (!response.ok) {
    clearTimeout(timeoutId);
    let details = "";
    try {
      const errJson = await response.json();
      details = errJson?.error?.message || errJson?.message || JSON.stringify(errJson);
    } catch {
      try {
        details = await response.text();
      } catch {
        /* ignore */
      }
    }
    throw new ProviderError(`NVIDIA API error (HTTP ${response.status}): ${details || "no further details"}`);
  }

  try {
    let result;
    if (stream && response.body) {
      result = await consumeSSEStream(response.body, onPartial);
    } else {
      const data = await response.json();
      const choice = data?.choices?.[0];
      const msg = choice?.message || {};
      result = {
        content: msg.content || choice?.text || "",
        reasoning: msg.reasoning_content || msg.reasoning || null,
      };
    }
    clearTimeout(timeoutId);
    if (!result.content && !result.reasoning) {
      throw new ProviderError("NVIDIA API returned an empty response.");
    }
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`Failed to read the NVIDIA API response (${err.message}).`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// KV Settings
// ────────────────────────────────────────────────────────────────────────

async function getUserSettings(env, chatId) {
  try {
    const raw = await env.USER_SETTING_N.get(`user:${chatId}`);
    if (!raw) return { model: DEFAULT_MODEL, apiKey: null };
    const parsed = JSON.parse(raw);
    return {
      model: NVIDIA_FREE_MODELS.includes(parsed.model) ? parsed.model : DEFAULT_MODEL,
      apiKey: parsed.apiKey || null,
    };
  } catch (err) {
    console.error("KV get error:", err);
    return { model: DEFAULT_MODEL, apiKey: null };
  }
}

async function saveUserSettings(env, chatId, settings) {
  try {
    await env.USER_SETTING_N.put(`user:${chatId}`, JSON.stringify(settings));
  } catch (err) {
    console.error("KV put error:", err);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Telegram Bot API
// ────────────────────────────────────────────────────────────────────────

function tgUrl(env, method) {
  return `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`;
}

async function tgCall(env, method, payload) {
  try {
    const res = await fetch(tgUrl(env, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && data.ok === false)) {
      console.error(`Telegram API error on ${method}:`, data || res.status);
    }
    return data;
  } catch (err) {
    console.error(`Telegram network error on ${method}:`, err);
    return null;
  }
}

function sendMessage(env, chatId, text, extra = {}) {
  return tgCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

function sendPlainMessage(env, chatId, text, extra = {}) {
  return tgCall(env, "sendMessage", { chat_id: chatId, text, ...extra });
}

function editMessageText(env, chatId, messageId, text, extra = {}) {
  return tgCall(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

function sendChatAction(env, chatId, action = "typing") {
  return tgCall(env, "sendChatAction", { chat_id: chatId, action });
}

function replyToOptions(messageId) {
  return messageId ? { reply_to_message_id: messageId, allow_sending_without_reply: true } : {};
}

function answerCallbackQuery(env, id, text, showAlert = false) {
  return tgCall(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert: showAlert });
}

async function configureBotUi(env) {
  await tgCall(env, "setMyCommands", { commands: BOT_COMMANDS });
  await tgCall(env, "setChatMenuButton", { menu_button: { type: "commands" } });
}

async function sendFormattedChunk(env, chatId, html, messageId) {
  let res = messageId
    ? await editMessageText(env, chatId, messageId, html)
    : await sendMessage(env, chatId, html);

  if (!res || res.ok === false) {
    const plain = stripHtml(html);
    res = messageId
      ? await tgCall(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: plain })
      : await tgCall(env, "sendMessage", { chat_id: chatId, text: plain });
  }
  return res;
}

function startTypingLoop(env, chatId) {
  const state = { stopped: false };
  (async () => {
    while (!state.stopped) {
      await sendChatAction(env, chatId, "typing");
      await sleep(4000);
    }
  })().catch((err) => console.error("Typing loop error:", err));
  return state;
}

function buildModelKeyboard(currentModel) {
  return {
    inline_keyboard: NVIDIA_FREE_MODELS.map((model, index) => [
      {
        text: `${model === currentModel ? "✅ " : ""}${model}`,
        callback_data: `model:${index}`,
      },
    ]),
  };
}

function buildWelcomeText(model) {
  return (
    `👋 <b>Welcome to the NVIDIA AI Chat Bot!</b>\n\n` +
    `I forward your messages to NVIDIA's hosted AI models and reply right here in Telegram.\n\n` +
    `<b>Quick start</b>\n` +
    `• Just type a message to chat with the AI.\n` +
    `• /model – choose which AI model answers you.\n` +
    `• /addapi – use your own NVIDIA API key (optional).\n` +
    `• /removeapi – remove your saved API key.\n` +
    `• Tap the ☰ icon next to the message box to open/close the full command list.\n\n` +
    `<b>Current model:</b> <code>${escapeHtml(model)}</code>\n\n` +
    `Send /help anytime to see this again. Now just say hi! 🚀`
  );
}

function buildHelpText(model, hasCustomKey) {
  return (
    `ℹ️ <b>Help &amp; Commands</b>\n\n` +
    `/start – Show the welcome message\n` +
    `/help – Show this help message\n` +
    `/model – Choose which AI model replies to you (opens a menu)\n` +
    `/addapi – Save your own NVIDIA API key for your chat\n` +
    `/removeapi – Remove your saved API key and use the bot's default key\n\n` +
    `<b>Current model:</b> <code>${escapeHtml(model)}</code>\n` +
    `<b>API key:</b> ${hasCustomKey ? "your own key ✅" : "bot's default key"}\n\n` +
    `<b>Tips</b>\n` +
    `• Tap the ☰ icon beside the message box to open/close the full command list.\n` +
    `• Math like <code>$x^2 + y^2 = z^2$</code> or <code>\\frac{a}{b}</code> is converted to readable Unicode.\n` +
    `• Long answers are split into multiple messages automatically.\n\n` +
    `Just type your question to start chatting!`
  );
}

async function handleModelCommand(env, chatId, replyToId) {
  const settings = await getUserSettings(env, chatId);
  await sendMessage(env, chatId, "🧠 <b>Choose an AI model:</b>\nTap a model below to select it.", {
    reply_markup: buildModelKeyboard(settings.model),
    ...replyToOptions(replyToId),
  });
}

async function handleAddApiCommand(env, chatId, args, replyToId) {
  const key = (args || "").trim();
  if (key) {
    const settings = await getUserSettings(env, chatId);
    settings.apiKey = key;
    await saveUserSettings(env, chatId, settings);
    await sendMessage(env, chatId, "✅ Your API key has been saved and will be used for your next messages.", replyToOptions(replyToId));
    return;
  }
  await sendMessage(env, chatId, ASK_API_KEY_PROMPT, { reply_markup: { force_reply: true }, ...replyToOptions(replyToId) });
}

async function handleRemoveApiCommand(env, chatId, replyToId) {
  const settings = await getUserSettings(env, chatId);
  if (!settings.apiKey) {
    await sendMessage(env, chatId, "ℹ️ You don't have a custom API key saved. The bot's default key is being used.", replyToOptions(replyToId));
    return;
  }
  settings.apiKey = null;
  await saveUserSettings(env, chatId, settings);
  await sendMessage(env, chatId, "🗑️ Your API key has been removed. The bot's default key will be used from now on.", replyToOptions(replyToId));
}

async function handleCallbackQuery(update, env) {
  const cq = update.callback_query;
  const chatId = cq.message?.chat?.id;
  const data = cq.data || "";

  if (!chatId) {
    await answerCallbackQuery(env, cq.id, "");
    return;
  }

  if (data.startsWith("model:")) {
    const idx = Number(data.split(":")[1]);
    const model = NVIDIA_FREE_MODELS[idx];
    if (!model) {
      await answerCallbackQuery(env, cq.id, "Unknown model.", true);
      return;
    }
    const settings = await getUserSettings(env, chatId);
    settings.model = model;
    await saveUserSettings(env, chatId, settings);
    await answerCallbackQuery(env, cq.id, `Model set to ${model}`);
    await tgCall(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: cq.message.message_id,
      reply_markup: buildModelKeyboard(model),
    });
    return;
  }

  await answerCallbackQuery(env, cq.id, "");
}

async function handleChatMessage(env, chatId, text, replyToId) {
  const settings = await getUserSettings(env, chatId);
  const apiKey = settings.apiKey || env.NVIDIA_API_KEY;

  if (!apiKey) {
    await sendMessage(
      env,
      chatId,
      "⚠️ No NVIDIA API key is configured. Ask the bot owner to set the NVIDIA_API_KEY secret, or add your own with /addapi.",
      replyToOptions(replyToId)
    );
    return;
  }

  const thinkingRes = await sendMessage(env, chatId, "🤔 <i>Thinking…</i>", replyToOptions(replyToId));
  const thinkingId = thinkingRes?.result?.message_id || null;
  const typing = startTypingLoop(env, chatId);

  let lastEditAt = 0;
  const onPartial = async ({ content, reasoning }) => {
    const now = Date.now();
    if (!thinkingId || now - lastEditAt < 1500) return;
    lastEditAt = now;
    const preview = buildFinalHtml(content, reasoning);
    const trimmed = preview.length > MAX_CHUNK_LEN ? `${preview.slice(0, MAX_CHUNK_LEN)}…` : preview;
    await editMessageText(env, chatId, thinkingId, trimmed || "🤔 <i>Thinking…</i>").catch(() => {});
  };

  try {
    const { content, reasoning } = await callNvidia(settings.model, text, apiKey, onPartial);
    typing.stopped = true;

    const html = buildFinalHtml(content, reasoning);
    const chunks = splitHtmlSafely(html, MAX_CHUNK_LEN);

    await sendFormattedChunk(env, chatId, chunks[0] || "🤷 No response received.", thinkingId);
    for (let i = 1; i < chunks.length; i++) {
      await sendFormattedChunk(env, chatId, chunks[i], null);
    }
  } catch (err) {
    typing.stopped = true;
    console.error("AI generation error:", err);

    const isProviderIssue = err instanceof ProviderError;
    const friendlyHtml = isProviderIssue
      ? `⚠️ <b>The AI provider did not respond correctly.</b>\n${escapeHtml(err.message)}\n\nPlease try again in a moment, or try a different model with /model.`
      : `⚠️ <b>Something went wrong while contacting the AI provider.</b>\n${escapeHtml(err.message || String(err))}\n\nPlease try again.`;

    await sendFormattedChunk(env, chatId, friendlyHtml, thinkingId);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Update dispatcher
// ────────────────────────────────────────────────────────────────────────

async function handleUpdate(update, env) {
  try {
    if (!uiConfigured) {
      uiConfigured = true;
      await configureBotUi(env).catch((err) => console.error("configureBotUi failed:", err));
    }

    if (update.callback_query) {
      await handleCallbackQuery(update, env);
      return;
    }

    const message = update.message || update.edited_message;
    if (!message || !message.chat) return;
    const chatId = message.chat.id;
    const replyToId = message.message_id;

    if (typeof message.text !== "string") {
      await sendMessage(env, chatId, "🙏 I can currently only understand text messages.", replyToOptions(replyToId));
      return;
    }

    const text = message.text.trim();

    if (message.reply_to_message && message.reply_to_message.text === ASK_API_KEY_PROMPT) {
      await handleAddApiCommand(env, chatId, text, replyToId);
      return;
    }

    if (text.startsWith("/")) {
      const [rawCmd, ...rest] = text.split(/\s+/);
      const command = rawCmd.split("@")[0].toLowerCase();
      const args = rest.join(" ").trim();

      switch (command) {
        case "/start": {
          await configureBotUi(env).catch(() => {});
          const settings = await getUserSettings(env, chatId);
          await sendMessage(env, chatId, buildWelcomeText(settings.model), replyToOptions(replyToId));
          return;
        }
        case "/help": {
          const settings = await getUserSettings(env, chatId);
          await sendMessage(env, chatId, buildHelpText(settings.model, !!settings.apiKey), replyToOptions(replyToId));
          return;
        }
        case "/model":
          await handleModelCommand(env, chatId, replyToId);
          return;
        case "/addapi":
          await handleAddApiCommand(env, chatId, args, replyToId);
          return;
        case "/removeapi":
          await handleRemoveApiCommand(env, chatId, replyToId);
          return;
        default:
          await sendMessage(
            env,
            chatId,
            `❓ Unknown command <code>${escapeHtml(command)}</code>.\nTap the ☰ menu icon or send /help to see available commands.`,
            replyToOptions(replyToId)
          );
          return;
      }
    }

    if (!text) return;
    await handleChatMessage(env, chatId, text, replyToId);
  } catch (err) {
    console.error("handleUpdate fatal error:", err);
    try {
      const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
      if (chatId) {
        await sendPlainMessage(env, chatId, "⚠️ An unexpected error occurred in the bot. Please try again in a moment.");
      }
    } catch (innerErr) {
      console.error("Failed to notify user of fatal error:", innerErr);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Worker entry point
// ────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET") {
        if (url.pathname === "/register-webhook") {
          const webhookUrl = `${url.origin}/`;
          const result = await tgCall(env, "setWebhook", {
            url: webhookUrl,
            allowed_updates: ["message", "callback_query"],
          });
          await configureBotUi(env).catch(() => {});
          return new Response(JSON.stringify({ webhookUrl, result }, null, 2), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/remove-webhook") {
          const result = await tgCall(env, "deleteWebhook", {});
          return new Response(JSON.stringify({ result }, null, 2), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          "NVIDIA Telegram bot worker is running.\nVisit /register-webhook once to connect this Worker to your Telegram bot.",
          { status: 200 }
        );
      }

      if (request.method !== "POST") {
        return new Response("OK");
      }

      let update;
      try {
        update = await request.json();
      } catch (err) {
        console.error("Invalid JSON body from Telegram:", err);
        return new Response("OK");
      }

      // PREVENT DUPLICATE PROCESSING & BYPASS 30s waitUntil LIMIT
      // Telegram retries webhooks if they don't return 200 OK within ~60 seconds.
      // Cloudflare Free plan strictly kills background tasks (waitUntil) after 30 seconds.
      // By NOT using waitUntil and instead awaiting the update, we keep the incoming
      // HTTP request open, which has NO hard wall-time limit on Cloudflare.
      // The KV lock ensures that if Telegram retries, the duplicate update is ignored.
      const lockKey = `update_lock:${update.update_id}`;
      const existingLock = await env.USER_SETTING_N.get(lockKey);
      if (existingLock) {
        return new Response("OK"); // Already being processed
      }
      // Lock for 3 minutes (longer than max generation time)
      await env.USER_SETTING_N.put(lockKey, "1", { expirationTtl: 180 });

      try {
        await handleUpdate(update, env);
      } catch (err) {
        console.error("handleUpdate fatal error:", err);
      }
      
      return new Response("OK");
    } catch (err) {
      console.error("Top-level worker error:", err);
      return new Response("OK");
    }
  },
};
