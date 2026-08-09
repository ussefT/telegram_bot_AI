// worker_cloud.js
// Telegram bot on Cloudflare Workers — Workers AI + Workers KV.
// No wrangler required: paste this file into the Cloudflare dashboard
// (Workers & Pages -> your worker -> Edit code) and configure, in
// Settings -> Variables and Bindings:
//
//   Secret/variable : BOT_TOKEN   -> your Telegram bot token from @BotFather
//   AI binding      : AI          -> Workers AI
//   KV binding      : KV_MODES    -> stores each user's mode + chat model
//   KV binding      : KV_CHATS    -> stores each user's recent chat history
//
// Then register the webhook (replace <TOKEN> and <WORKER_URL>):
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/"
//
// Modes: /chat (text assistant), /image (text-to-image), /transcribe (speech-to-text).

// ---------- Tunables ----------

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB Telegram file download limit
const MAX_HISTORY_MESSAGES = 16; // keep chat context small & cheap
const TELEGRAM_MAX_MESSAGE = 4096; // Telegram per-message text limit
const TYPING_REFRESH_MS = 4000; // "typing…" expires after ~5s, so refresh it

// Workers AI text models default to max_tokens: 256 when it isn't passed
// explicitly, which is why longer answers (especially code) got cut off
// mid-way. Raise it well above what a chat answer normally needs.
const MAX_OUTPUT_TOKENS = 4096;
// Safety net: if a reply still looks cut off (e.g. an unclosed ``` code
// fence) after MAX_OUTPUT_TOKENS, automatically ask the model to continue
// exactly where it left off, up to this many extra calls.
const MAX_CONTINUATIONS = 3;

// Cloudflare Workers AI is the "main provider" here (free daily Neuron
// allocation, no external API key needed). Model chosen as default:
//   @cf/openai/gpt-oss-120b — Cloudflare's pinned, general-purpose,
//   high-reasoning production text model, good quality/latency balance
//   on the free tier. Users can switch with /model or the menu.
const DEFAULT_CHAT_MODEL = "@cf/openai/gpt-oss-120b";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell"; // fast free-tier text-to-image
// whisper-large-v3-turbo: multi-language + noticeably more accurate than
// whisper-tiny-en, still cheap/fast enough for a chat bot.
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

const VALID_CHAT_MODELS = [
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/zai-org/glm-5.2",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/google/gemma-4-26b-a4b-it",
];

// Labels for the inline "glass" keyboard buttons.
const MODE_LABELS = {
  chat: "💬 Chat",
  image: "🎨 Image",
  transcribe: "🎙️ Transcribe",
};
const MODE_ORDER = ["chat", "image", "transcribe"];

// Registered with Telegram so they appear in the menu button beside the
// message input box, and as a drop-up/drop-down list when typing "/".
const BOT_COMMANDS = [
  { command: "menu", description: "Open the quick action menu" },
  { command: "chat", description: "Switch to chat mode" },
  { command: "image", description: "Switch to image generation mode" },
  { command: "transcribe", description: "Switch to audio transcription mode" },
  { command: "model", description: "Choose the AI chat model" },
  { command: "new", description: "Clear chat history and start fresh" },
  { command: "help", description: "Show help and commands" },
  { command: "start", description: "Show the welcome message" },
];

// Set once per isolate so we don't hammer setMyCommands on every request.
let commandsRegistered = false;

const SYSTEM_PROMPT =
  "You are a helpful, friendly Telegram assistant. Answer clearly and as briefly " +
  "as the question allows. You may use Telegram-friendly Markdown: **bold**, " +
  "_italic_, `inline code`, fenced ```code blocks``` (with a language tag when " +
  "relevant), [links](https://example.com), and \"- \" bullet lists — it will be " +
  "rendered correctly for the user, so use it whenever it improves clarity. " +
  "Do not mention that you are an AI model unless asked.";

// ---------- Entry point ----------

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      const url = new URL(request.url);
      return new Response(
        "Telegram Bot Worker (worker_cloud.js) is running!\n\n" +
          `Webhook URL: ${url.origin}/\n\n` +
          "To register the webhook:\n" +
          `curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=${url.origin}/"\n\n` +
          "To check status:\n" +
          'curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"\n',
        { status: 200 }
      );
    }

    // Every code path below returns 200 OK so Telegram never retry-storms
    // this webhook because of an internal error (requirement: handle errors).
    try {
      if (!commandsRegistered) {
        commandsRegistered = true;
        ctx.waitUntil(ensureBotCommands(env));
      }

      let update;
      try {
        update = await request.json();
      } catch (err) {
        console.error("Failed to parse incoming JSON update:", err);
        return new Response("OK", { status: 200 });
      }

      await handleUpdate(update, env);
      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Unhandled error in fetch handler:", err);
      return new Response("OK", { status: 200 });
    }
  },
};

// ---------- Update routing ----------

async function handleUpdate(update, env) {
  if (update && update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const message = update && update.message;
  if (!message) return;

  const chatId = message.chat && message.chat.id;
  const userId = message.from && message.from.id;
  const messageId = message.message_id;

  if (!chatId || !userId) {
    console.error("Update missing chat_id or user_id:", JSON.stringify(update));
    return;
  }

  try {
    const text = typeof message.text === "string" ? message.text.trim() : null;

    if (text && text.startsWith("/")) {
      await handleCommand(text, chatId, userId, env);
      return;
    }

    const mode = await getMode(userId, env);

    if (message.voice || message.audio || message.document || message.video || message.video_note) {
      if (mode !== "transcribe") {
        await sendMessage(
          env,
          chatId,
          "I received a file, but you're not in transcribe mode. Send /transcribe to switch."
        );
        return;
      }
      await handleTranscribe(message, chatId, messageId, env);
      return;
    }

    if (text) {
      if (mode === "image") {
        await handleImage(text, chatId, messageId, env);
      } else if (mode === "transcribe") {
        await sendMessage(
          env,
          chatId,
          "You are in transcribe mode. Please send a voice or audio file instead of text."
        );
      } else {
        await handleChat(text, chatId, userId, messageId, env);
      }
      return;
    }

    await sendMessage(env, chatId, "Sorry, I can't handle this type of message yet.");
  } catch (err) {
    console.error("Error while handling update:", err);
    await sendErrorMessage(
      env,
      chatId,
      "⚠️ An internal error occurred while processing your request. Please try again in a moment."
    );
  }
}

// ---------- Commands ----------

async function handleCommand(text, chatId, userId, env) {
  const command = text.split(/\s+/)[0].toLowerCase();

  if (command === "/start") {
    await ensureBotCommands(env);
    await sendMessage(
      env,
      chatId,
      "👋 *Welcome!* I run on Cloudflare Workers AI and can operate in three modes:\n\n" +
        "💬 /chat — chat with an AI text assistant.\n" +
        "🎨 /image — generate images from text prompts.\n" +
        "🎙️ /transcribe — transcribe voice or audio files to text.\n\n" +
        "Tap /menu for buttons, or the ⌨️ menu button beside the message box.\n" +
        "Use `/model <name>` to switch the chat model. /help lists everything.",
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard("chat") }
    );
    return;
  }

  if (command === "/help") {
    await sendMessage(
      env,
      chatId,
      "*Commands*\n\n" +
        "/start — Welcome message.\n" +
        "/menu — Open the quick action buttons.\n" +
        "/chat — Switch to chat mode.\n" +
        "/image — Switch to image generation mode.\n" +
        "/transcribe — Switch to audio transcription mode.\n" +
        "/model `<model-name>` — Switch chat model.\n" +
        "/new — Clear chat history and start fresh.\n\n" +
        "*Available chat models*\n" +
        VALID_CHAT_MODELS.map((m) => "• `" + m + "`").join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (command === "/menu") {
    const currentMode = await getMode(userId, env);
    await sendMessage(env, chatId, mainMenuText(currentMode), {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(currentMode),
    });
    return;
  }

  if (command === "/chat" || command === "/image" || command === "/transcribe") {
    const newMode = command.slice(1);
    await setMode(userId, newMode, env);
    await sendMessage(env, chatId, mainMenuText(newMode), {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(newMode),
    });
    return;
  }

  if (command === "/new") {
    await saveHistory(userId, [], env);
    await sendMessage(env, chatId, "🧹 Chat history cleared. Starting fresh.");
    return;
  }

  if (command === "/model") {
    const args = text.split(/\s+/);
    const modelInput = args[1];
    const currentModel = await getChatModel(userId, env);

    if (!modelInput) {
      await sendMessage(env, chatId, modelMenuText(currentModel), {
        parse_mode: "Markdown",
        reply_markup: modelMenuKeyboard(currentModel),
      });
      return;
    }

    if (VALID_CHAT_MODELS.includes(modelInput)) {
      await setChatModel(userId, modelInput, env);
      await sendMessage(env, chatId, "✅ Chat model switched to: `" + modelInput + "`", {
        parse_mode: "Markdown",
      });
    } else {
      await sendMessage(
        env,
        chatId,
        "❌ Invalid model name. Current model: `" + currentModel + "`\n\n*Valid models*\n" +
          VALID_CHAT_MODELS.map((m) => "• `" + m + "`").join("\n"),
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  await sendMessage(env, chatId, "Unknown command. Try /help or tap /menu for a list of options.");
}

// ---------- Inline "soft glass" keyboards ----------
// Telegram has no native glassmorphism styling, so the "glass" look is
// simulated with rounded/soft icon glyphs, a checkmark on the active item,
// and grouped rows — giving buttons a translucent, pill-like feel.

function mainMenuText(currentMode) {
  const label = MODE_LABELS[currentMode] || currentMode;
  return "◈ *Quick menu*\n\n" + `Current mode: ${label}\n\n` + "Tap a button to switch mode, or choose a chat model.";
}

function mainMenuKeyboard(currentMode) {
  const button = (mode) => ({
    text: (mode === currentMode ? "✅ " : "◌ ") + MODE_LABELS[mode],
    callback_data: "mode:" + mode,
  });
  return {
    inline_keyboard: [
      MODE_ORDER.map(button),
      [{ text: "🤖 Choose model", callback_data: "menu:models" }],
      [{ text: "🧹 New chat", callback_data: "menu:new" }],
    ],
  };
}

function modelMenuText(currentModel) {
  return `◈ *Choose a chat model*\n\nCurrent: \`${currentModel}\`\n\nTap a model below to switch:`;
}

function modelMenuKeyboard(currentModel) {
  const rows = VALID_CHAT_MODELS.map((m) => [
    {
      text: (m === currentModel ? "✅ " : "◌ ") + m.replace("@cf/", ""),
      callback_data: "model:" + m,
    },
  ]);
  rows.push([{ text: "« Back to menu", callback_data: "menu:back" }]);
  return { inline_keyboard: rows };
}

// Registers the Telegram command list (shown as a drop-up/drop-down list
// beside the message input when the "/" menu button is tapped) and sets
// the chat menu button itself. Cheap and idempotent.
async function ensureBotCommands(env) {
  try {
    await fetch(telegramApiUrl(env, "setMyCommands"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    await fetch(telegramApiUrl(env, "setChatMenuButton"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ menu_button: { type: "commands" } }),
    });
  } catch (err) {
    console.error("Failed to register bot commands/menu button:", err);
  }
}

// ---------- Inline keyboard taps ----------

async function handleCallbackQuery(cq, env) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const userId = cq.from && cq.from.id;
  const messageId = cq.message && cq.message.message_id;
  const data = typeof cq.data === "string" ? cq.data : "";

  if (!chatId || !userId) {
    await answerCallbackQuery(env, cq.id);
    return;
  }

  try {
    if (data.startsWith("mode:")) {
      const mode = data.slice("mode:".length);
      if (!MODE_ORDER.includes(mode)) {
        await answerCallbackQuery(env, cq.id, "Unknown mode.", true);
        return;
      }
      await setMode(userId, mode, env);
      await answerCallbackQuery(env, cq.id, `Mode: ${MODE_LABELS[mode]}`);
      await editMessageText(env, chatId, messageId, mainMenuText(mode), {
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(mode),
      });
      return;
    }

    if (data === "menu:models") {
      const currentModel = await getChatModel(userId, env);
      await answerCallbackQuery(env, cq.id);
      await editMessageText(env, chatId, messageId, modelMenuText(currentModel), {
        parse_mode: "Markdown",
        reply_markup: modelMenuKeyboard(currentModel),
      });
      return;
    }

    if (data === "menu:new") {
      await saveHistory(userId, [], env);
      await answerCallbackQuery(env, cq.id, "Chat history cleared.");
      return;
    }

    if (data.startsWith("model:")) {
      const model = data.slice("model:".length);
      if (!VALID_CHAT_MODELS.includes(model)) {
        await answerCallbackQuery(env, cq.id, "Invalid model.", true);
        return;
      }
      await setChatModel(userId, model, env);
      await answerCallbackQuery(env, cq.id, "Model updated.");
      await editMessageText(env, chatId, messageId, modelMenuText(model), {
        parse_mode: "Markdown",
        reply_markup: modelMenuKeyboard(model),
      });
      return;
    }

    if (data === "menu:back") {
      const mode = await getMode(userId, env);
      await answerCallbackQuery(env, cq.id);
      await editMessageText(env, chatId, messageId, mainMenuText(mode), {
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(mode),
      });
      return;
    }

    await answerCallbackQuery(env, cq.id);
  } catch (err) {
    console.error("Error handling callback query:", err);
    await answerCallbackQuery(env, cq.id, "Something went wrong. Try again.", true);
    await sendErrorMessage(env, chatId, "⚠️ Something went wrong handling that button. Please try again.");
  }
}

async function answerCallbackQuery(env, callbackQueryId, text, showAlert) {
  try {
    await fetch(telegramApiUrl(env, "answerCallbackQuery"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
        ...(showAlert ? { show_alert: true } : {}),
      }),
    });
  } catch (err) {
    console.error("answerCallbackQuery error:", err);
  }
}

// ---------- Per-user mode & model storage (KV_MODES) ----------

async function getChatModel(userId, env) {
  try {
    const model = await env.KV_MODES.get(`model:${userId}`);
    return model || DEFAULT_CHAT_MODEL;
  } catch (err) {
    console.error("KV_MODES.get (model) error:", err);
    return DEFAULT_CHAT_MODEL;
  }
}

async function setChatModel(userId, model, env) {
  try {
    await env.KV_MODES.put(`model:${userId}`, model);
  } catch (err) {
    console.error("KV_MODES.put (model) error:", err);
  }
}

async function getMode(userId, env) {
  try {
    const mode = await env.KV_MODES.get(`mode:${userId}`);
    return mode || "chat";
  } catch (err) {
    console.error("KV_MODES.get (mode) error:", err);
    return "chat";
  }
}

async function setMode(userId, mode, env) {
  try {
    await env.KV_MODES.put(`mode:${userId}`, mode);
  } catch (err) {
    console.error("KV_MODES.put (mode) error:", err);
  }
}

// ---------- Chat history storage (KV_CHATS) ----------

async function loadHistory(userId, env) {
  try {
    const raw = await env.KV_CHATS.get(`chat:${userId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Failed to load/parse chat history from KV_CHATS:", err);
    return [];
  }
}

async function saveHistory(userId, history, env) {
  try {
    const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
    await env.KV_CHATS.put(`chat:${userId}`, JSON.stringify(trimmed));
  } catch (err) {
    console.error("KV_CHATS.put error:", err);
  }
}

// ---------- /chat mode ----------

async function handleChat(userText, chatId, userId, replyToId, env) {
  const history = await loadHistory(userId, env);
  const model = await getChatModel(userId, env);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText },
  ];

  // Requirement: show "typing…" while the model works, and send a visible
  // "Thinking…" placeholder that gets replaced by the real answer (or a
  // friendly error) once the call finishes.
  await sendChatAction(env, chatId, "typing");
  const placeholder = await sendMessage(env, chatId, "🤔 Thinking…", {
    reply_to_message_id: replyToId,
  });
  const placeholderMsgId = extractMessageId(placeholder);
  const stopTyping = keepTyping(env, chatId);

  let reply;
  try {
    const result = await env.AI.run(model, { messages, max_tokens: MAX_OUTPUT_TOKENS });
    reply = extractChatReply(result);
    if (!reply) {
      throw new Error("Empty response from AI model");
    }

    // Workers AI caps output at MAX_OUTPUT_TOKENS. Long/code-heavy answers
    // can still hit that ceiling and stop mid-sentence or mid-code-block.
    // Detect that and transparently ask the model to continue until the
    // reply looks complete (or we hit MAX_CONTINUATIONS).
    let continuations = 0;
    while (looksTruncated(reply) && continuations < MAX_CONTINUATIONS) {
      continuations++;
      const continueMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: userText },
        { role: "assistant", content: reply },
        {
          role: "user",
          content:
            "Continue exactly where you left off. Do not repeat any earlier text and do not add any preamble, acknowledgement, or closing remarks — output only the missing continuation.",
        },
      ];
      const continueResult = await env.AI.run(model, {
        messages: continueMessages,
        max_tokens: MAX_OUTPUT_TOKENS,
      });
      const continuation = extractChatReply(continueResult);
      if (!continuation) break;
      reply += continuation;
    }
  } catch (err) {
    console.error("Workers AI chat model error:", err);
    stopTyping();
    const reason = describeAiError(err, model);
    await replaceMessage(env, chatId, placeholderMsgId, "⚠️ " + reason);
    return;
  }

  stopTyping();

  const updatedHistory = [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: reply },
  ];
  await saveHistory(userId, updatedHistory, env);

  // Requirement: render the AI's Markdown correctly in Telegram (bold, code
  // blocks, lists, links, etc.) instead of raw "**text**"/backticks.
  const formattedReply = toTelegramMarkdownV2(reply);

  if (formattedReply.length <= TELEGRAM_MAX_MESSAGE) {
    const edited = await editMessageText(env, chatId, placeholderMsgId, formattedReply, {
      parse_mode: "MarkdownV2",
    });
    if (!edited) {
      const editedPlain = await editMessageText(env, chatId, placeholderMsgId, reply);
      if (!editedPlain) {
        await sendMarkdownSafe(env, chatId, reply, { reply_to_message_id: replyToId });
      }
    }
  } else {
    if (placeholderMsgId) {
      await deleteMessage(env, chatId, placeholderMsgId);
    }
    await sendMarkdownSafe(env, chatId, reply, { reply_to_message_id: replyToId });
  }
}

function extractChatReply(result) {
  if (!result) return null;
  if (typeof result === "string") return result;
  if (typeof result.response === "string") return result.response;
  if (result.result && typeof result.result.response === "string") {
    return result.result.response;
  }
  if (Array.isArray(result.choices) && result.choices[0]) {
    const choice = result.choices[0];
    if (choice.message && typeof choice.message.content === "string") {
      return choice.message.content;
    }
  }
  return null;
}

// Heuristic: does this reply look like it was cut off by the token limit?
// The strongest signal is an odd number of ``` fences (an unclosed code
// block) — exactly what caused the "half a code block" symptom. As a
// secondary signal, a long reply that doesn't end on any normal closing
// punctuation is also likely to have been cut off mid-sentence.
function looksTruncated(text) {
  if (!text) return false;

  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) return true;

  const trimmed = text.trimEnd();
  if (trimmed.length < 40) return false;
  const lastChar = trimmed[trimmed.length - 1];
  const endsCleanly = /[.!?:;,`"')\]}•。！？]/.test(lastChar);
  return !endsCleanly;
}

// Turn a Workers AI / fetch error into a short, user-visible reason.
function describeAiError(err, model) {
  let detail = "unknown error";
  if (err) {
    if (typeof err.message === "string" && err.message) {
      detail = err.message;
    } else if (typeof err === "string") {
      detail = err;
    }
  }
  return `AI request failed (${model}): ${String(detail).slice(0, 200)}`;
}

// Repeatedly re-send the "typing…" chat action while the model is running.
// Returns a function to stop refreshing once the result is ready.
function keepTyping(env, chatId) {
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      await sendChatAction(env, chatId, "typing");
      await sleep(TYPING_REFRESH_MS);
    }
  };
  tick(); // fire and forget; runs in the background while we await the model
  return () => {
    stopped = true;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Markdown formatting for Telegram (MarkdownV2) ----------

// Converts common AI/GFM-style Markdown (**bold**, # headings, ```lang code```,
// `inline code`, *italic*/_italic_, ~~strike~~, [text](url), "- " lists) into
// Telegram's MarkdownV2 syntax, escaping every other special character so
// Telegram doesn't reject the message with a "can't parse entities" error.
function toTelegramMarkdownV2(input) {
  if (!input) return "";

  const codeBlocks = [];
  const inlineCodes = [];
  const linkUrls = [];

  let text = String(input);

  // 1) Fenced code blocks first, so nothing inside them gets reformatted.
  text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || "").trim(), code: code.replace(/\n$/, "") });
    return `\u0000B${idx}\u0000`;
  });

  // 2) Inline code spans.
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\u0000I${idx}\u0000`;
  });

  // 3) Headings (#, ##, ...) become a bold line.
  text = text.replace(/^ {0,3}#{1,6}\s+(.+)$/gm, (_, content) => `\u0001${content.trim()}\u0001`);

  // 4) Bold: **text** / __text__
  text = text.replace(/\*\*([^\n\u0000-\u0006]+?)\*\*/g, (_, c) => `\u0001${c}\u0001`);
  text = text.replace(/__([^\n\u0000-\u0006]+?)__/g, (_, c) => `\u0001${c}\u0001`);

  // 5) Strikethrough: ~~text~~
  text = text.replace(/~~([^\n\u0000-\u0006]+?)~~/g, (_, c) => `\u0002${c}\u0002`);

  // 6) Italic: *text* / _text_ (word-bounded so snake_case isn't mangled).
  text = text.replace(
    /(^|[\s([{])\*([^\s*\u0000-\u0006][^*\n\u0000-\u0006]*?)\*(?=$|[\s.,!?;:)\]}])/g,
    (_, pre, c) => `${pre}\u0003${c}\u0003`
  );
  text = text.replace(
    /(^|[\s([{])_([^\s_\u0000-\u0006][^_\n\u0000-\u0006]*?)_(?=$|[\s.,!?;:)\]}])/g,
    (_, pre, c) => `${pre}\u0003${c}\u0003`
  );

  // 7) Links: [text](url) — pull out the URL so it isn't over-escaped.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const idx = linkUrls.length;
    linkUrls.push(url);
    return `\u0004${label}\u0005${idx}\u0006`;
  });

  // 8) Bullet list markers -> a plain bullet character.
  text = text.replace(/^ {0,3}[-*]\s+/gm, "\u2022 ");

  // 9) Escape everything else that MarkdownV2 treats as special.
  text = escapeMarkdownV2(text);

  // 10) Restore formatting markers as real MarkdownV2 syntax.
  text = text.replace(/\u0001([\s\S]*?)\u0001/g, "*$1*");
  text = text.replace(/\u0002([\s\S]*?)\u0002/g, "~$1~");
  text = text.replace(/\u0003([\s\S]*?)\u0003/g, "_$1_");
  text = text.replace(/\u0004([\s\S]*?)\u0005(\d+)\u0006/g, (_, label, idx) => {
    const url = linkUrls[Number(idx)] || "";
    return `[${label}](${escapeMarkdownV2LinkUrl(url)})`;
  });

  // 11) Restore inline code and fenced code blocks.
  text = text.replace(/\u0000I(\d+)\u0000/g, (_, idx) => {
    const code = inlineCodes[Number(idx)] || "";
    return "`" + escapeCodeContent(code) + "`";
  });
  text = text.replace(/\u0000B(\d+)\u0000/g, (_, idx) => {
    const block = codeBlocks[Number(idx)] || { lang: "", code: "" };
    return "```" + block.lang + "\n" + escapeCodeContent(block.code) + "\n```";
  });

  return text;
}

function escapeMarkdownV2(text) {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (ch) => "\\" + ch);
}

// Inside a link's (url) part, MarkdownV2 only requires escaping backslash and ")".
function escapeMarkdownV2LinkUrl(url) {
  return url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

// Inside code spans/blocks, MarkdownV2 only requires escaping backslash and backtick.
function escapeCodeContent(code) {
  return code.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

// ---------- Markdown-safe message sending ----------

/**
 * Sends a message rendered with Telegram's MarkdownV2 parse mode.
 * If the message is longer than Telegram's limit, it is split into multiple
 * messages at line/space boundaries. Each chunk falls back to plain text if
 * Markdown parsing fails, so the user always gets a reply either way.
 */
async function sendMarkdownSafe(env, chatId, text, extraOptions) {
  const chunks = splitForTelegram(text);
  let lastResponse = null;
  for (const chunk of chunks) {
    const formatted = toTelegramMarkdownV2(chunk);
    try {
      const response = await sendMessage(env, chatId, formatted, {
        parse_mode: "MarkdownV2",
        ...(extraOptions || {}),
      });
      lastResponse = response;
      if (!response || !response.ok) {
        const description =
          response && response.parsedBody && response.parsedBody.description
            ? String(response.parsedBody.description)
            : "";
        if (description.toLowerCase().includes("parse")) {
          console.log("Markdown parse failed, falling back to plain text for:", chunk.slice(0, 80));
          lastResponse = await sendMessage(env, chatId, chunk, omitKey(extraOptions || {}, "parse_mode"));
        }
      }
    } catch (err) {
      console.error("sendMarkdownSafe error:", err);
      lastResponse = await sendMessage(env, chatId, chunk, omitKey(extraOptions || {}, "parse_mode"));
    }
    if (extraOptions && extraOptions.reply_to_message_id) {
      extraOptions = omitKey(extraOptions, "reply_to_message_id");
    }
  }
  return lastResponse;
}

function omitKey(obj, key) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k !== key) out[k] = obj[k];
  }
  return out;
}

// Render one chunk's lines back into text, reopening/closing a ``` fence
// around it so a code block that spans multiple Telegram messages still
// renders as valid, separately-highlighted code blocks in each message.
function renderChunk(startInFence, startLang, lines, endInFence) {
  let s = startInFence ? "```" + startLang + "\n" : "";
  s += lines.join("\n");
  if (endInFence) s += "\n```";
  return s;
}

// Split text into chunks no longer than TELEGRAM_MAX_MESSAGE. Unlike a naive
// character-count split, this tracks ``` fenced code blocks so a split never
// lands inside a fence leaving it unclosed (which used to render as a
// half-finished, garbled code block in Telegram) — instead the fence is
// closed at the end of one message and reopened at the start of the next.
function splitForTelegram(text) {
  if (!text) return [""];
  if (text.length <= TELEGRAM_MAX_MESSAGE) return [text];

  const maxLineLen = TELEGRAM_MAX_MESSAGE - 8; // headroom for fence markers
  const lines = text.split("\n");
  const chunks = [];

  let chunkStartInFence = false;
  let chunkStartLang = "";
  let currentLines = [];
  let inFence = false;
  let fenceLang = "";

  const flush = () => {
    if (currentLines.length === 0) return;
    chunks.push(renderChunk(chunkStartInFence, chunkStartLang, currentLines, inFence));
    currentLines = [];
    chunkStartInFence = inFence;
    chunkStartLang = fenceLang;
  };

  for (let rawLine of lines) {
    // Hard-split a single very long line so it can never exceed the limit alone.
    let remaining = rawLine;
    while (remaining.length > maxLineLen) {
      flush();
      currentLines.push(remaining.slice(0, maxLineLen));
      flush();
      remaining = remaining.slice(maxLineLen);
    }
    rawLine = remaining;

    const isFenceLine = /^```/.test(rawLine.trim());
    const nextInFence = isFenceLine ? !inFence : inFence;
    const nextFenceLang = isFenceLine && !inFence ? rawLine.trim().slice(3).trim() : nextInFence ? fenceLang : "";

    const rendered = renderChunk(chunkStartInFence, chunkStartLang, currentLines.concat([rawLine]), nextInFence);
    if (rendered.length > TELEGRAM_MAX_MESSAGE && currentLines.length > 0) {
      flush();
    }
    currentLines.push(rawLine);
    inFence = nextInFence;
    fenceLang = nextFenceLang;
  }
  flush();

  return chunks.length ? chunks : [text];
}

// ---------- /image mode ----------

async function handleImage(prompt, chatId, replyToId, env) {
  await sendChatAction(env, chatId, "upload_photo");
  const placeholder = await sendMessage(env, chatId, "🎨 Generating image…", {
    reply_to_message_id: replyToId,
  });
  const placeholderMsgId = extractMessageId(placeholder);
  const stopTyping = keepTyping(env, chatId);

  try {
    const result = await env.AI.run(IMAGE_MODEL, { prompt });
    const photo = await resolveImageOutput(result);
    if (!photo) {
      console.error("Unrecognized image model response shape:", JSON.stringify(result)?.slice(0, 500));
      throw new Error("Unrecognized response shape from image model");
    }
    stopTyping();
    if (placeholderMsgId) {
      await deleteMessage(env, chatId, placeholderMsgId);
    }
    await sendPhoto(env, chatId, photo, prompt.slice(0, 200), replyToId);
  } catch (err) {
    stopTyping();
    console.error("Workers AI image model error:", err);
    const shortReason = err && err.message ? String(err.message).slice(0, 200) : "unknown error";
    await replaceMessage(
      env,
      chatId,
      placeholderMsgId,
      "⚠️ Image generation failed: " + shortReason + " Please try a simpler description."
    );
  }
}

// Normalize Workers AI image output into a Blob suitable for Telegram upload.
async function resolveImageOutput(result) {
  if (!result) return null;

  if (result instanceof ReadableStream) {
    const response = new Response(result);
    const buf = await response.arrayBuffer();
    return new Blob([buf], { type: "image/png" });
  }

  if (result instanceof ArrayBuffer) {
    return new Blob([result], { type: "image/png" });
  }

  if (result instanceof Uint8Array) {
    return new Blob([result], { type: "image/png" });
  }

  if (typeof result.image === "string") {
    return new Blob([base64ToArrayBuffer(result.image)], { type: "image/jpeg" });
  }

  if (result.result && typeof result.result.image === "string") {
    return new Blob([base64ToArrayBuffer(result.result.image)], { type: "image/jpeg" });
  }

  if (Array.isArray(result.images) && typeof result.images[0] === "string") {
    return new Blob([base64ToArrayBuffer(result.images[0])], { type: "image/jpeg" });
  }

  return null;
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// Encode raw bytes to base64 without relying on Node's Buffer (which needs
// the "nodejs_compat" flag). btoa/atob are natively available in Workers.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // avoid call-stack limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------- /transcribe mode ----------

async function handleTranscribe(message, chatId, replyToId, env) {
  const fileId = getAudioFileId(message);
  if (!fileId) {
    await sendMessage(
      env,
      chatId,
      "You are in transcribe mode. Please send a voice or audio file instead of text."
    );
    return;
  }

  await sendChatAction(env, chatId, "typing");
  const placeholder = await sendMessage(env, chatId, "🎙️ Transcribing…", {
    reply_to_message_id: replyToId,
  });
  const placeholderMsgId = extractMessageId(placeholder);
  const stopTyping = keepTyping(env, chatId);

  let fileInfo;
  try {
    fileInfo = await getFile(fileId, env);
  } catch (err) {
    console.error("Telegram getFile error:", err);
    stopTyping();
    await replaceMessage(
      env,
      chatId,
      placeholderMsgId,
      "⚠️ There was a problem reading the file from Telegram. Please try again."
    );
    return;
  }

  if (!fileInfo || !fileInfo.ok || !fileInfo.result) {
    console.error("Unexpected getFile response:", JSON.stringify(fileInfo));
    stopTyping();
    await replaceMessage(
      env,
      chatId,
      placeholderMsgId,
      "⚠️ There was a problem reading the file from Telegram. Please try again."
    );
    return;
  }

  const { file_path, file_size } = fileInfo.result;

  if (typeof file_size === "number" && file_size > MAX_FILE_SIZE) {
    stopTyping();
    await replaceMessage(env, chatId, placeholderMsgId, "⚠️ File is larger than 20MB. Please send a smaller audio file.");
    return;
  }

  if (!file_path) {
    stopTyping();
    await replaceMessage(env, chatId, placeholderMsgId, "⚠️ Could not locate the audio file. Please try again.");
    return;
  }

  let audioBuffer;
  try {
    const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file_path}`;
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      throw new Error(`Failed to download file, status ${fileResponse.status}`);
    }
    audioBuffer = await fileResponse.arrayBuffer();

    if (audioBuffer.byteLength > MAX_FILE_SIZE) {
      stopTyping();
      await replaceMessage(env, chatId, placeholderMsgId, "⚠️ File is larger than 20MB. Please send a smaller audio file.");
      return;
    }
  } catch (err) {
    console.error("Error downloading audio file from Telegram:", err);
    stopTyping();
    await replaceMessage(
      env,
      chatId,
      placeholderMsgId,
      "⚠️ There was a problem downloading the audio file. Please try again."
    );
    return;
  }

  try {
    const input = { audio: arrayBufferToBase64(audioBuffer) };
    const result = await env.AI.run(WHISPER_MODEL, input);
    const transcriptionText = extractTranscription(result);

    if (!transcriptionText) {
      throw new Error("Empty transcription result from AI model");
    }

    stopTyping();
    if (placeholderMsgId) {
      await deleteMessage(env, chatId, placeholderMsgId);
    }
    // Transcriptions can be long — split across multiple Telegram messages.
    await sendMarkdownSafe(env, chatId, "📝 *Transcription:*\n\n" + transcriptionText, {
      reply_to_message_id: replyToId,
    });
  } catch (err) {
    stopTyping();
    console.error("Workers AI whisper model error:", err);
    await replaceMessage(
      env,
      chatId,
      placeholderMsgId,
      "⚠️ Transcription failed: " + (err && err.message ? String(err.message).slice(0, 200) : "unknown error")
    );
  }
}

function getAudioFileId(message) {
  if (message.voice && message.voice.file_id) return message.voice.file_id;
  if (message.audio && message.audio.file_id) return message.audio.file_id;
  if (message.document && message.document.file_id) return message.document.file_id;
  if (message.video && message.video.file_id) return message.video.file_id;
  if (message.video_note && message.video_note.file_id) return message.video_note.file_id;
  return null;
}

function extractTranscription(result) {
  if (!result) return null;
  if (typeof result.text === "string") return result.text;
  if (result.result && typeof result.result.text === "string") return result.result.text;
  return null;
}

// ---------- Telegram helper functions ----------

function telegramApiUrl(env, method) {
  return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
}

// Returns a plain result object rather than the raw fetch Response, so we
// can safely attach the parsed JSON body (calling `.json()` on a Response
// consumes its stream, and the DOM `Response` type doesn't declare a
// `parsedBody` field, which TypeScript/checkJs would otherwise flag).
async function sendMessage(env, chatId, text, extraOptions) {
  try {
    const body = Object.assign({ chat_id: chatId, text }, extraOptions || {});

    const response = await fetch(telegramApiUrl(env, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      console.error(`Telegram sendMessage failed (${response.status}):`, parsed ? JSON.stringify(parsed) : "<no body>");
    }
    return { ok: response.ok, status: response.status, parsedBody: parsed };
  } catch (err) {
    console.error("Telegram sendMessage request error:", err);
    return null;
  }
}

async function sendPhoto(env, chatId, photo, caption, replyToId) {
  try {
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    if (caption) formData.append("caption", caption);
    if (replyToId) formData.append("reply_to_message_id", String(replyToId));
    formData.append("photo", photo, "image.jpg");

    const response = await fetch(telegramApiUrl(env, "sendPhoto"), {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errText = await safeText(response);
      console.error(`Telegram sendPhoto failed (${response.status}):`, errText);
      throw new Error(`sendPhoto failed with status ${response.status}`);
    }
    return response;
  } catch (err) {
    console.error("Telegram sendPhoto request error:", err);
    throw err;
  }
}

// Send a chat action such as "typing" or "upload_photo".
async function sendChatAction(env, chatId, action) {
  try {
    await fetch(telegramApiUrl(env, "sendChatAction"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch (err) {
    // Non-fatal: the typing indicator is purely cosmetic.
    console.error("sendChatAction error:", err);
  }
}

// Edit the text of an existing message. Returns true if the edit succeeded.
async function editMessageText(env, chatId, messageId, text, options) {
  if (!messageId) return false;
  try {
    const body = Object.assign({ chat_id: chatId, message_id: messageId, text }, options || {});
    const response = await fetch(telegramApiUrl(env, "editMessageText"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errText = await safeText(response);
      console.error(`editMessageText failed (${response.status}):`, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error("editMessageText request error:", err);
    return false;
  }
}

// Delete a message (used to remove "Thinking…"/"Generating…" placeholders).
async function deleteMessage(env, chatId, messageId) {
  if (!messageId) return;
  try {
    await fetch(telegramApiUrl(env, "deleteMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch (err) {
    console.error("deleteMessage error:", err);
  }
}

// Pull message_id out of a Telegram API response (JSON attached by sendMessage).
function extractMessageId(response) {
  return response &&
    response.ok &&
    response.parsedBody &&
    response.parsedBody.result &&
    typeof response.parsedBody.result.message_id === "number"
    ? response.parsedBody.result.message_id
    : null;
}

// Replace a placeholder message with final text (used for replies & errors).
async function replaceMessage(env, chatId, messageId, text, options) {
  const edited = await editMessageText(env, chatId, messageId, text, options);
  if (!edited) {
    await sendMessage(env, chatId, text, options);
  }
}

async function sendErrorMessage(env, chatId, text) {
  return sendMessage(env, chatId, text);
}

async function getFile(fileId, env) {
  const response = await fetch(`${telegramApiUrl(env, "getFile")}?file_id=${encodeURIComponent(fileId)}`);
  if (!response.ok) {
    const errText = await safeText(response);
    console.error(`Telegram getFile failed (${response.status}):`, errText);
    throw new Error(`getFile failed with status ${response.status}`);
  }
  return response.json();
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}
