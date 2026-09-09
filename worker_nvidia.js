/**
 * worker_n.js
 * ---------------------------------------------------------------------------
 * Fixed for Cloudflare Workers Free Plan.
 * Changes made:
 * 1. Removed ctx.waitUntil to bypass the 30-second wall-clock limit.
 * 2. Added a KV Lock to prevent Telegram webhook retries from duplicating messages.
 * 3. Added Stall Detection and Stream Error handling to prevent silent cutoffs.
 * 4. z-ai/glm-5.2 streams with stall detection (see consumeSSEStream).
 * 5. Elapsed-time progress ticker on Thinking… for non-streaming models;
 *    stream previews are fire-and-forget so slow Telegram edits can't stall reads.
 * ---------------------------------------------------------------------------
 */

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const NVIDIA_FREE_MODELS = [
    "openai/gpt-oss-20b",
"meta/muse-glimmer-30b",
"moonshotai/kimi-k3",
"deepseek-ai/deepseek-v4-pro-0813",
"deepseek-ai/deepseek-v4-flash-0731",
"nemotron-3-ultra-550b-a55b",
"nvidia/nemotron-3-super-120b-a12b",
"google/gemma-4-31b-it",
];

const DEFAULT_MODEL = NVIDIA_FREE_MODELS[0];

// ponytail: per-chat saved custom models — /model <id> appends here instead
// of replacing a single slot, so several customs survive side by side.
const MAX_CUSTOM_MODELS = 10;

const MODEL_API_ID_OVERRIDES = {
    "nemotron-3-ultra-550b-a55b": "nvidia/nemotron-3-ultra-550b-a55b",
};

const BOT_COMMANDS = [
    { command: "start", description: "Start the bot / show welcome message" },
{ command: "help", description: "Show help and usage hints" },
{ command: "model", description: "Choose model or save custom: /model <id>" },
{ command: "removemodel", description: "Remove a saved model: /removemodel <id>" },
{ command: "params", description: "Tune AI params (temperature, tokens…)" },
{ command: "set", description: "Set a param exactly: /set <key> <value>" },
{ command: "test", description: "Test the current model with a tiny prompt" },
{ command: "keys", description: "List API keys, rotation mode, pick key" },
{ command: "addapi", description: "Add another NVIDIA API key" },
{ command: "removeapi", description: "Remove a key: /removeapi <n>" },
];

// Multi-key rotation: roundrobin cycles keys, failover sticks to the last
// working key, manual always uses the chosen key only.
const KEY_MODES = ["roundrobin", "failover", "manual"];
const MAX_API_KEYS = 5;

// Every NVIDIA var from the API examples, optional per chat. null = removed
// (omitted from the request, not sent as 0). stream is always true/false.
// Wire rule (see MODEL_SPECS): each model sends ONLY the keys its API
// example uses — anything else the user set is omitted, never sent.
const DEFAULT_PARAMS = {
    temperature: 1,
    top_p: 0.95,
    max_tokens: 16384,
    seed: 42,
    stream: true,
    reasoning_effort: null,
    thinking: null,
    // ponytail: local-only, never sent to NVIDIA — how long we wait for an
    // answer (seconds). Reuses the /params + /set system, no new command.
    timeout: 45,
};

const PARAM_CYCLES = {
    temperature: [0, 0.7, 1],
    top_p: [0.9, 0.95, 1],
    max_tokens: [4096, 8192, 16384, 32768],
    timeout: [30, 45, 60, 90, 120],
    reasoning_effort: [null, "low", "medium", "high", "max"],
};

const SETTABLE_KEYS = Object.keys(DEFAULT_PARAMS);

const ASK_API_KEY_PROMPT =
"🔑 Please reply to THIS message with your NVIDIA API key.\n" +
"It will be added to your chat's key list (up to 5) and used instead of the bot's default key.\n" +
"Send /keys to manage keys, /removeapi <n> to delete one.";

    // ponytail: keys identify only by last-4 in chat — never print a full key.
    function maskKey(k) {
        const s = String(k || "");
        return s.length <= 8 ? "…" + s.slice(-4) : s.slice(0, 4) + "…" + s.slice(-4);
    }

    function sanitizeKeySettings(parsed) {
        const out = {
            apiKeys: [],
            keyMode: "roundrobin",
            keyIndex: 0,
            keyCursor: 0,
            keyPrimary: 0,
            keyStats: {},
            // ponytail: pending-key state — set when /addapi or ➕ asks for a key,
            // so the next pasted key is saved even if the user doesn't hit reply.
            awaitingKey: false,
        };
        if (parsed && parsed.awaitingKey === true) out.awaitingKey = true;
        if (!parsed || typeof parsed !== "object") return out;
        // migrate legacy single-key field
        const list = Array.isArray(parsed.apiKeys) && parsed.apiKeys.length
        ? parsed.apiKeys
        : (parsed.apiKey ? [parsed.apiKey] : []);
        out.apiKeys = list.filter((k) => typeof k === "string" && k.trim()).slice(0, MAX_API_KEYS);
        if (KEY_MODES.includes(parsed.keyMode)) out.keyMode = parsed.keyMode;
        if (Number.isInteger(parsed.keyIndex) && parsed.keyIndex >= 0) out.keyIndex = parsed.keyIndex;
        if (Number.isInteger(parsed.keyCursor) && parsed.keyCursor >= 0) out.keyCursor = parsed.keyCursor;
        if (Number.isInteger(parsed.keyPrimary) && parsed.keyPrimary >= 0) out.keyPrimary = parsed.keyPrimary;
        if (parsed.keyStats && typeof parsed.keyStats === "object") out.keyStats = parsed.keyStats;
        return out;
    }

    // ordered key list for this chat: user keys first, bot default last (if set)
    function effectiveKeys(settings, env) {
        const keys = settings.apiKeys.map((k, i) => ({ key: k, label: `#${i + 1} ${maskKey(k)}`, mine: true, idx: i }));
        if (env.NVIDIA_API_KEY) keys.push({ key: env.NVIDIA_API_KEY, label: "bot default", mine: false, idx: -1 });
        return keys;
    }

    function orderKeysForMode(keys, settings) {
        if (!keys.length) return [];
        if (settings.keyMode === "manual") {
            const pick = keys.find((k) => k.mine && k.idx === settings.keyIndex) || keys[0];
            return [pick];
        }
        if (settings.keyMode === "failover") {
            const prim = settings.keyPrimary;
            const mine = keys.filter((k) => k.mine);
            const rest = keys.filter((k) => !k.mine);
            const pi = mine.findIndex((k) => k.idx === prim);
            const ordered = pi >= 0 ? [...mine.slice(pi), ...mine.slice(0, pi)] : mine;
            return [...ordered, ...rest];
        }
        // roundrobin
        const start = settings.keyCursor % keys.length;
        return [...keys.slice(start), ...keys.slice(0, start)];
    }

    function bumpKeyStats(settings, label, ok) {
        try {
            const s = settings.keyStats[label] || { ok: 0, fail: 0 };
            if (ok) s.ok++;
            else s.fail++;
            settings.keyStats[label] = s;
        } catch { /* ignore */ }
    }

    const MAX_CHUNK_LEN = 3900;
    // ponytail: default only — the real budget comes from /params timeout
    // (see runPrompt); never cap per-key attempts back down to this.
    const PROVIDER_TIMEOUT_MS = 45000; // 45s default when no user setting
    const STALL_TIMEOUT_MS = 20000; // 20s without SSE bytes = abort

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

    // ────────────────────────────────────────────────────────────────────────
    // Markdown -> HTML
    // ────────────────────────────────────────────────────────────────────────

    function markdownToTelegramHtml(raw) {
        if (!raw) return "";
        const codeBlocks = [];
        const inlineCodes = [];
        const mathBlocks = [];

        let text = raw.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
            codeBlocks.push({ lang: lang || "", code });
            return `\u0000CB${codeBlocks.length - 1}\u0000`;
        });

        text = text.replace(/`([^`\n]+)`/g, (_, code) => {
            inlineCodes.push(code);
            return `\u0000IC${inlineCodes.length - 1}\u0000`;
        });

        // ponytail: stash math BEFORE markdown so * _ ~ [ ] inside equations
        // are never eaten by bold/italic/link rules; restore after as Unicode.
        const stash = (expr) => {
            mathBlocks.push(convertLatex(expr));
            return `\u0000MA${mathBlocks.length - 1}\u0000`;
        };
        text = text
            .replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => `\n${stash(expr)}\n`)
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => `\n${stash(expr)}\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => stash(expr))
            .replace(/(^|[^$])\$(?!\$)([^$\n]+?)\$(?!\$)/g, (m, before, expr) => `${before}\u0000MA${(mathBlocks.push(convertLatex(expr)), mathBlocks.length - 1)}\u0000`);

        text = escapeHtml(text);

        text = text.replace(/^ {0,3}#{1,6}\s+(.+)$/gm, (_, t) => `<b>${t.trim()}</b>`);
        text = text.replace(/\*\*([^\n*]+?)\*\*/g, "<b>$1</b>");
        text = text.replace(/__([^\n_]+?)__/g, "<b>$1</b>");
        text = text.replace(/\*([^\n*]+?)\*/g, "<i>$1</i>");
        text = text.replace(/(?<![A-Za-z0-9])_([^\n_]+?)_(?![A-Za-z0-9])/g, "<i>$1</i>");
        text = text.replace(/~~([^\n~]+?)~~/g, "<s>$1</s>");
        text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
        text = text.replace(/^ {0,3}[-*]\s+/gm, "• ");

        text = text.replace(/\u0000MA(\d+)\u0000/g, (_, i) => escapeHtml(mathBlocks[Number(i)] ?? ""));
        text = text.replace(/\u0000IC(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(inlineCodes[Number(i)])}</code>`);
        text = text.replace(/\u0000CB(\d+)\u0000/g, (_, i) => {
            const { lang, code } = codeBlocks[Number(i)];
            const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
            return `<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`;
        });

        return text.trim();
    }

    function buildFinalHtml(content, reasoning, usage, promptText, extra = "", model = "") {
        const answerHtml = markdownToTelegramHtml(content && content.trim() ? content : "_(the model returned no text)_");
        const modelLine = model ? `\n🤖 <code>${escapeHtml(model)}</code>` : "";
        const footer = formatUsageFooter(usage, promptText, content, reasoning) + modelLine + (extra || "");
        if (reasoning && reasoning.trim()) {
            const reasoningHtml = markdownToTelegramHtml(reasoning);
            return (
                `🤔 <b>Thought process</b> <i>(tap to reveal)</i>\n` +
                `<tg-spoiler>${reasoningHtml}</tg-spoiler>\n\n` +
                `💬 <b>Answer</b>\n${answerHtml}${footer}`
            );
        }
        return answerHtml + footer;
    }

    // 🔑 line under answers when several keys exist or a failover happened
    function keyLine(keyLabel, tryNo, tryTotal) {
        if (tryTotal <= 1 && tryNo <= 1) return "";
        return `\n🔑 <code>${escapeHtml(keyLabel)}</code> • try ${tryNo}/${tryTotal}`;
    }

    // ponytail: ~4 chars/token fallback; "~" prefix marks estimates when the
    // provider omits usage. Empty only if there is nothing to count.
    function estimateTokens(s) {
        if (!s) return 0;
        return Math.max(1, Math.ceil(String(s).length / 4));
    }

    function formatUsageFooter(usage, promptText, content, reasoning) {
        let sent = usage?.prompt_tokens;
        let received = usage?.completion_tokens;
        let total = usage?.total_tokens;
        let approx = false;
        if (sent == null && received == null && total == null) {
            if (!promptText && !content && !reasoning) return "";
            sent = estimateTokens(promptText);
            received = estimateTokens((content || "") + (reasoning || ""));
            total = sent + received;
            approx = true;
        } else {
            sent = sent ?? estimateTokens(promptText);
            received = received ?? estimateTokens((content || "") + (reasoning || ""));
            total = total ?? (sent + received);
        }
        const t = approx ? "~" : "";
        return `\n\n📊 <code>↑ ${t}${sent} sent • ↓ ${t}${received} received • Σ ${t}${total} total</code>`;
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

    // Exact wire shape per API.txt — each model sends ONLY the keys its
    // example uses. Extra keys (e.g. seed to gemma, top_p to kimi) make
    // NVIDIA return 400, which is why stream:false looked "broken".
    // thinking maps to chat_template_kwargs.<thinkKey>; reasoning_effort is
    // top-level for kimi, nested in chat_template_kwargs for deepseek-flash.
    const MODEL_SPECS = {
        "google/gemma-4-31b-it": { top: ["temperature", "top_p", "max_tokens"], thinkKey: "enable_thinking" },
        "moonshotai/kimi-k3": { top: ["temperature", "max_tokens", "seed"], effort: "top" },
        "deepseek-ai/deepseek-v4-pro-0813": { top: ["temperature", "top_p", "max_tokens", "seed"], thinkKey: "thinking" },
        "deepseek-ai/deepseek-v4-flash-0731": { top: ["temperature", "top_p", "max_tokens"], thinkKey: "thinking", effort: "nested" },
        "meta/muse-glimmer-30b": { top: ["temperature", "top_p", "max_tokens"] },
        "openai/gpt-oss-20b": { top: ["temperature", "top_p", "max_tokens"] },
    };
    const DEFAULT_SPEC = { top: ["temperature", "top_p", "max_tokens", "seed"] };

    function buildRequestPayload(modelId, message, userParams, isTest = false) {
        // ponytail: text-only — content is always a plain string, never image_url parts.
        const messages = [{ role: "user", content: String(message || "") }];
        const apiId = apiModelId(modelId);
        const p = { ...DEFAULT_PARAMS, ...(userParams || {}) };
        const spec = MODEL_SPECS[modelId] || DEFAULT_SPEC;
        const body = { model: apiId, messages };
        const maxTok = isTest ? 10 : p.max_tokens;
        for (const k of spec.top) {
            if (k === "max_tokens") {
                if (maxTok != null) body.max_tokens = maxTok;
                continue;
            }
            // ponytail: null = omit entirely, never send 0
            if (p[k] != null) body[k] = p[k];
        }
        if (spec.thinkKey && p.thinking != null) {
            body.chat_template_kwargs = { [spec.thinkKey]: p.thinking };
        }
        if (spec.effort === "top" && p.reasoning_effort != null) {
            body.reasoning_effort = p.reasoning_effort;
        } else if (spec.effort === "nested" && p.reasoning_effort != null) {
            body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), reasoning_effort: p.reasoning_effort };
        }
        const wantStream = !!p.stream;
        body.stream = wantStream;
        // ponytail: stream_options only with stream:true — sending it with
        // stream:false makes NVIDIA reject the request.
        if (wantStream) body.stream_options = { include_usage: true };
        return { stream: wantStream, body };
    }
    // NOTE: stream always comes from /params (default on).

    // Working params straight from API.txt — applied automatically on every
    // model switch, then the user can still change anything via /params /set.
    // stream/timeout are the user's own prefs, never overwritten here.
    const MODEL_AUTO_PARAMS = {
        "google/gemma-4-31b-it": { temperature: 1, top_p: 0.95, max_tokens: 16384, seed: null, thinking: true, reasoning_effort: null },
        "moonshotai/kimi-k3": { temperature: 1, top_p: null, max_tokens: 16384, seed: 0, thinking: null, reasoning_effort: "max" },
        "deepseek-ai/deepseek-v4-pro-0813": { temperature: 1, top_p: 0.95, max_tokens: 16384, seed: 42, thinking: false, reasoning_effort: null },
        "deepseek-ai/deepseek-v4-flash-0731": { temperature: 1, top_p: 0.95, max_tokens: 16384, seed: null, thinking: true, reasoning_effort: "high" },
        "meta/muse-glimmer-30b": { temperature: 1, top_p: 0.95, max_tokens: 8192, seed: null, thinking: null, reasoning_effort: null },
        "openai/gpt-oss-20b": { temperature: 1, top_p: 1, max_tokens: 4096, seed: null, thinking: null, reasoning_effort: null },
    };
    const DEFAULT_AUTO_PARAMS = { temperature: 1, top_p: 0.95, max_tokens: 16384, seed: 42, thinking: null, reasoning_effort: null };

    function applyModelAutoParams(params, modelId) {
        const p = sanitizeParams(params);
        const auto = MODEL_AUTO_PARAMS[modelId] || DEFAULT_AUTO_PARAMS;
        const keepStream = p.stream;
        const keepTimeout = p.timeout;
        Object.assign(p, auto);
        p.stream = keepStream;
        p.timeout = keepTimeout;
        return p;
    }

    function autoParamsLine(modelId, p) {
        const spec = MODEL_SPECS[modelId] || DEFAULT_SPEC;
        const parts = spec.top.map((k) => `${k}=${fmtParam(p[k])}`);
        if (spec.thinkKey) parts.push(`thinking=${fmtParam(p.thinking)}`);
        if (spec.effort) parts.push(`reasoning_effort=${fmtParam(p.reasoning_effort)}`);
        return parts.join(", ");
    }

    async function readWithTimeout(reader, timeoutMs) {
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            // ponytail: cancel the pending read so the next loop iteration
            // doesn't stack a second read on a stuck stream.
            timer = setTimeout(() => {
                try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
                reject(new ProviderError("The AI stream stalled for too long and was aborted."));
            }, timeoutMs);
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
        let usage = null;

        while (true) {
            // Use a timeout wrapper to detect if NVIDIA stops sending data (stalls)
            const { value, done } = await readWithTimeout(reader, STALL_TIMEOUT_MS);
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
                const addText = (v) => {
                    if (typeof v === "string") return v;
                    if (Array.isArray(v)) return v.map((b) => (typeof b === "string" ? b : b?.text || "")).filter(Boolean).join("\n");
                    return "";
                };
                content += addText(delta.content);
                reasoning += addText(delta.reasoning_content) || addText(delta.reasoning);
                // ponytail: usage arrives in a final chunk with no choices — keep it
                if (json.usage) usage = json.usage;

                if (onPartial) {
                    try {
                        await onPartial({ content, reasoning });
                    } catch {
                        /* ignore preview errors */
                    }
                }
            }
        }

        // ponytail: a stream can end without trailing newline — don't drop the last data: line
        if (buffer.trim().startsWith("data:")) {
            const payload = buffer.trim().slice(5).trim();
            if (payload && payload !== "[DONE]") {
                try {
                    const json = JSON.parse(payload);
                    if (json.usage) usage = json.usage;
                    const delta = json?.choices?.[0]?.delta || {};
                    const addText = (v) => {
                        if (typeof v === "string") return v;
                        if (Array.isArray(v)) return v.map((b) => (typeof b === "string" ? b : b?.text || "")).filter(Boolean).join("\n");
                        return "";
                    };
                    content += addText(delta.content);
                    reasoning += addText(delta.reasoning_content) || addText(delta.reasoning);
                } catch {
                    /* ignore */
                }
            }
        }

        return { content, reasoning: reasoning || null, usage };
    }

    async function postNvidia(body, stream, apiKey, signal) {
        return fetch(NVIDIA_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                Accept: stream ? "text/event-stream" : "application/json",
            },
            body: JSON.stringify(body),
                     signal,
        });
    }

    // err.info = { kind, status }: kind ∈ timeout|stall|http|network|empty|stream.
    // Short human reason for the failure card (exact cause, not a guess).
    function shortReason(err) {
        const info = err?.info || {};
        if (info.kind === "timeout") return `⏱️ no answer in ${Math.round((info.ms || PROVIDER_TIMEOUT_MS) / 1000)}s (timeout)`;
        if (info.kind === "stall") return "📡 stream stalled (no data 20s)";
        if (info.kind === "network") return `🌐 unreachable (${err.message || "network"})`;
        if (info.kind === "empty") return "📭 empty reply from model";
        if (info.kind === "stream") return `📡 stream error (${err.message || "cut off"})`;
        const st = info.status;
        if (st === 429) return "⏳ rate-limited (429, key quota hit)";
        if (st === 401 || st === 403) return `🔑 key rejected (HTTP ${st})`;
        if (st === 404) return "❓ model not found (404)";
        if (st) return `⚠️ HTTP ${st}`;
        return `⚠️ ${err?.message || "failed"}`;
    }

    function failKind(status) {
        if (status === 429) return "rate-limit";
        if (status === 401 || status === 403) return "bad-key";
        return "error";
    }

    async function callNvidia(modelId, message, apiKey, onPartial, userParams, isTest = false, timeoutMs = PROVIDER_TIMEOUT_MS) {
        let { stream, body } = buildRequestPayload(modelId, message, userParams, isTest);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let response;
        try {
            response = await postNvidia(body, stream, apiKey, controller.signal);
            // ponytail: custom models may reject stream:true — retry once non-stream
            if (!response.ok && stream) {
                let peek = "";
                try { peek = await response.text(); } catch { /* ignore */ }
                if (/stream/i.test(peek)) {
                    body = { ...body, stream: false };
                    delete body.stream_options;
                    stream = false;
                    response = await postNvidia(body, false, apiKey, controller.signal);
                } else {
                    response._peeked = peek;
                }
            }
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === "AbortError") {
                const e = new ProviderError(`NVIDIA API did not respond in time (${Math.round(timeoutMs / 1000)}s timeout).`);
                e.info = { kind: "timeout", ms: timeoutMs };
                throw e;
            }
            const e = new ProviderError(`Could not reach the NVIDIA API from Cloudflare (${err.message}).`);
            e.info = { kind: "network" };
            throw e;
        }

        if (!response.ok) {
            clearTimeout(timeoutId);
            let details = response._peeked || "";
            if (!details) {
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
            }
            const e = new ProviderError(`NVIDIA API error (HTTP ${response.status}): ${details || "no further details"}`);
            e.info = { kind: "http", status: response.status };
            throw e;
        }

        try {
            let result;
            if (stream && response.body) {
                // ponytail: streaming can stall or cut off mid-answer — deliver
                // the partial text received so far instead of a failure card.
                const partial = { content: "", reasoning: "" };
                const track = (p) => {
                    partial.content = p.content || "";
                    partial.reasoning = p.reasoning || "";
                    if (onPartial) return onPartial(p);
                };
                    try {
                        result = await consumeSSEStream(response.body, track);
                    } catch (streamErr) {
                        if (partial.content || partial.reasoning) {
                            result = { content: partial.content, reasoning: partial.reasoning || null, usage: null, partial: true, partialError: streamErr.message };
                        } else {
                            throw streamErr;
                        }
                    }
            } else {
                const data = await response.json();
                const choice = data?.choices?.[0];
                const msg = choice?.message || {};
                // ponytail: some providers return content as [{type:"text",text}] — join it
                const contentOf = (c) => Array.isArray(c)
                ? c.map((b) => (typeof b === "string" ? b : b?.text || "")).filter(Boolean).join("\n")
                : (c || "");
                result = {
                    content: contentOf(msg.content) || contentOf(choice?.text),
                    reasoning: msg.reasoning_content || msg.reasoning || null,
                    usage: data?.usage || null,
                };
            }
            clearTimeout(timeoutId);
            if (!result.content && !result.reasoning) {
                const e = new ProviderError("NVIDIA API returned an empty response.");
                e.info = { kind: "empty" };
                throw e;
            }
            return result;
        } catch (err) {
            clearTimeout(timeoutId);
            if (err instanceof ProviderError) {
                if (err.message.includes("stalled")) err.info = err.info || { kind: "stall" };
                if (err.message.includes("Stream Error")) err.info = err.info || { kind: "stream" };
                throw err;
            }
            const e = new ProviderError(`Failed to read the NVIDIA API response (${err.message}).`);
            e.info = { kind: "network" };
            throw e;
        }
    }

    // Multi-key fan-out: tries keys in mode order inside one total budget so the
    // webhook never outlives the worker. Returns attempts[] for the failure card
    // and the winning key label for the success footer.
    async function callNvidiaMulti(modelId, message, keys, opts = {}) {
        const { onPartial = null, userParams = null, isTest = false, budgetMs = PROVIDER_TIMEOUT_MS, settings = null } = opts;
        const deadline = Date.now() + budgetMs;
        const attempts = [];
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const left = deadline - Date.now();
            if (left < 8000) {
                attempts.push({ label: k.label, ok: false, reason: "⏱️ skipped (no time left in budget)", kind: "timeout" });
                break;
            }
            const t0 = Date.now();
            try {
                const r = await callNvidia(modelId, message, k.key, onPartial, userParams, isTest, left);
                attempts.push({ label: k.label, ok: true, ms: Date.now() - t0 });
                if (settings) {
                    bumpKeyStats(settings, k.label, true);
                    if (settings.keyMode === "roundrobin" && k.mine) settings.keyCursor = k.idx + 1;
                    if (settings.keyMode === "failover" && k.mine) settings.keyPrimary = k.idx;
                }
                return { ...r, attempts, keyLabel: k.label, tryNo: attempts.length, tryTotal: keys.length };
            } catch (err) {
                const reason = shortReason(err);
                attempts.push({ label: k.label, ok: false, reason, kind: failKind(err?.info?.status), ms: Date.now() - t0, detail: String(err.message || "").slice(0, 200) });
                if (settings) bumpKeyStats(settings, k.label, false);
                // manual mode = the chosen key only, never fall through to others
                if (settings && settings.keyMode === "manual") break;
            }
        }
        const e = new ProviderError(
            `All ${attempts.length} key${attempts.length === 1 ? "" : "s"} failed: ` +
            attempts.map((a) => `${a.label} → ${a.reason}`).join("; ")
        );
        e.info = { kind: "http", status: attempts.find((a) => a.kind === "rate-limit") ? 429 : 0 };
        e.attempts = attempts;
        throw e;
    }

    // ────────────────────────────────────────────────────────────────────────
    // KV Settings
    // ────────────────────────────────────────────────────────────────────────

    // Any saved model id is accepted: listed ones use tuned payloads, custom
    // ones fall through to the default payload. Basic sanity check only.
    function isValidModelId(id) {
        return typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\s<>]/.test(id);
    }

    function sanitizeCustomModels(raw, currentModel) {
        const list = Array.isArray(raw) ? raw : [];
        const out = list.filter(isValidModelId).filter((m) => !NVIDIA_FREE_MODELS.includes(m)).slice(0, MAX_CUSTOM_MODELS);
        // migrate: a previously saved single custom model stays in the list
        if (isValidModelId(currentModel) && !NVIDIA_FREE_MODELS.includes(currentModel) && !out.includes(currentModel)) {
            out.unshift(currentModel);
        }
        return out.slice(0, MAX_CUSTOM_MODELS);
    }

    function sanitizeParams(raw) {
        const out = { ...DEFAULT_PARAMS };
        if (!raw || typeof raw !== "object") return out;
        for (const k of SETTABLE_KEYS) {
            if (raw[k] !== undefined) out[k] = raw[k];
        }
        return out;
    }

    async function getUserSettings(env, chatId) {
        const blank = () => ({
            model: DEFAULT_MODEL,
            customModels: [],
            params: { ...DEFAULT_PARAMS },
            ...sanitizeKeySettings(null),
        });
        try {
            const raw = await env.USER_SETTING_N.get(`user:${chatId}`);
            if (!raw) return blank();
            const parsed = JSON.parse(raw);
            const model = isValidModelId(parsed.model) ? parsed.model : DEFAULT_MODEL;
            return {
                model,
                customModels: sanitizeCustomModels(parsed.customModels, model),
                params: sanitizeParams(parsed.params),
                ...sanitizeKeySettings(parsed),
            };
        } catch (err) {
            console.error("KV get error:", err);
            return blank();
        }
    }

    async function saveUserSettings(env, chatId, settings) {
        try {
            await env.USER_SETTING_N.put(`user:${chatId}`, JSON.stringify(settings));
        } catch (err) {
            console.error("KV put error:", err);
        }
    }

    // Exact-cause failure card: one diagnosis line per key tried, no buttons.
    function buildFailHtml(model, attempts, isTest) {
        const lines = (attempts || []).map((a, i) => `${i + 1}. <code>${escapeHtml(a.label)}</code> — ${escapeHtml(a.reason)}`);
        return (
            `⚠️ <b>Request unsuccessful${isTest ? " (model test)" : ""}</b>\n` +
            `Model: <code>${escapeHtml(model)}</code>\n\n` +
            `<b>Diagnosis</b>\n` +
            (lines.length ? lines.join("\n") + "\n" : "No attempt details available.\n") +
            `\nJust send your message again to retry. ` +
            `If keys keep failing with 429, add another key via /keys`
        );
    }

    // ────────────────────────────────────────────────────────────────────────
    // Telegram Bot API
    // ────────────────────────────────────────────────────────────────────────

    function tgUrl(env, method) {
        return `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`;
    }

    async function tgCall(env, method, payload, timeoutMs = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(tgUrl(env, method), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                                    signal: controller.signal,
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || (data && data.ok === false)) {
                console.error(`Telegram API error on ${method}:`, data || res.status);
            }
            return data;
        } catch (err) {
            console.error(`Telegram network error on ${method}:`, err);
            return null;
        } finally {
            clearTimeout(timer);
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
        // ponytail: never leave the "Thinking…" placeholder stuck — if edits
        // fail (bad HTML, deleted msg), fall back to plain edit, then new send.
        if (!messageId) {
            let res = await sendMessage(env, chatId, html);
            if (!res || res.ok === false) {
                res = await tgCall(env, "sendMessage", { chat_id: chatId, text: stripHtml(html) });
            }
            return res;
        }
        let res = await editMessageText(env, chatId, messageId, html);
        if (res?.ok) return res;
        if (String(res?.description || "").includes("message is not modified")) return { ok: true };
        res = await tgCall(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: stripHtml(html) });
        if (res?.ok) return res;
        if (String(res?.description || "").includes("message is not modified")) return { ok: true };
        // last resort: placeholder is uneditable (deleted?) — send as new message
        return sendPlainMessage(env, chatId, stripHtml(html));
    }

    function startTypingLoop(env, chatId) {
        const state = { stopped: false };
        // ponytail: sendChatAction expires after ~5s; refresh every 4s.
        // fire-and-forget per tick so a slow Telegram RTT can't stall the loop.
        (async () => {
            while (!state.stopped) {
                try { await sendChatAction(env, chatId, "typing"); } catch { /* ignore */ }
                for (let i = 0; i < 8 && !state.stopped; i++) await sleep(500);
            }
        })().catch((err) => console.error("Typing loop error:", err));
        return state;
    }

    function fmtParam(v) {
        if (v === null || v === undefined) return "—";
        if (typeof v === "boolean") return v ? "on" : "off";
        return String(v);
    }

    function buildParamsText(params, model) {
        const p = sanitizeParams(params);
        const spec = (model && MODEL_SPECS[model]) || null;
        const note = spec
            ? `\n<i>Model <code>${escapeHtml(model)}</code> sends only: ${[...spec.top, ...(spec.thinkKey ? ["thinking"] : []), ...(spec.effort ? ["reasoning_effort"] : []), "stream"].join(", ")} — others omitted.</i>\n`
            : `\n`;
        return (
            `🎛️ <b>AI parameters</b> <i>(tap a button to cycle, /set for exact)</i>\n` +
            note +
            `\n<code>temperature</code> = <b>${fmtParam(p.temperature)}</b>\n` +
            `<code>top_p</code> = <b>${fmtParam(p.top_p)}</b>\n` +
            `<code>max_tokens</code> = <b>${fmtParam(p.max_tokens)}</b>\n` +
            `<code>seed</code> = <b>${fmtParam(p.seed)}</b> <i>(tap: 42 → 0 → —, — = omitted)</i>\n` +
            `<code>stream</code> = <b>${fmtParam(p.stream)}</b>\n` +
            `<code>timeout</code> = <b>${fmtParam(p.timeout)}s</b> <i>(max wait for an answer)</i>\n` +
            `<code>thinking</code> = <b>${fmtParam(p.thinking)}</b> <i>(chat_template_kwargs)</i>\n` +
            `<code>reasoning_effort</code> = <b>${fmtParam(p.reasoning_effort)}</b> <i>(low/medium/high/max)</i>\n\n` +
            `Example: <code>/set temperature 0.7</code> • <code>/set seed 0</code> • ❌ buttons or <code>/set seed remove</code> <i>(remove = omit from request)</i>`
        );
    }

    function buildParamsKeyboard(params) {
        const p = sanitizeParams(params);
        return {
            inline_keyboard: [
                [
                    { text: `🌡️ temp: ${fmtParam(p.temperature)}`, callback_data: "param:temperature" },
                    { text: `🎯 top_p: ${fmtParam(p.top_p)}`, callback_data: "param:top_p" },
                ],
                [
                    { text: `📏 tokens: ${fmtParam(p.max_tokens)}`, callback_data: "param:max_tokens" },
                    { text: `🌱 seed: ${fmtParam(p.seed)}`, callback_data: "param:seed" },
                ],
                [
                    { text: `🌊 stream: ${fmtParam(p.stream)}`, callback_data: "param:stream" },
                    { text: `🧠 thinking: ${fmtParam(p.thinking)}`, callback_data: "param:thinking" },
                ],
                [{ text: `⏱️ timeout: ${fmtParam(p.timeout)}s (tap to cycle)`, callback_data: "param:timeout" }],
                [
                    { text: `🏋️ effort: ${fmtParam(p.reasoning_effort)}`, callback_data: "param:reasoning_effort" },
                ],
                [
                    { text: "❌ seed", callback_data: "param:clear:seed" },
                    { text: "❌ thinking", callback_data: "param:clear:thinking" },
                    { text: "❌ effort", callback_data: "param:clear:reasoning_effort" },
                ],
                [{ text: "♻️ Reset defaults", callback_data: "param:reset" }],
            ],
        };
    }

    function cycleParam(key, params) {
        const p = sanitizeParams(params);
        if (key === "stream") {
            // ponytail: stream is strictly true/false, never removed
            p.stream = p.stream === false ? true : false;
            return p;
        }
        if (key === "thinking") {
            // on -> off -> removed -> on
            p.thinking = p.thinking === true ? false : p.thinking === false ? null : true;
            return p;
        }
        if (key === "seed") {
            // ponytail: 42 → 0 → removed → 42, so seed 0 is reachable by tapping
            if (p.seed == null) p.seed = 42;
            else if (p.seed === 42) p.seed = 0;
            else p.seed = null;
            return p;
        }
        if (PARAM_CYCLES[key]) {
            const cyc = PARAM_CYCLES[key];
            const i = cyc.findIndex((v) => String(v) === String(p[key]));
            p[key] = cyc[(i + 1) % cyc.length];
            return p;
        }
        return p;
    }

    function parseSetValue(key, raw) {
        const v = (raw || "").trim().toLowerCase();
        // ponytail: "remove" omits the key from the request (never sends 0)
        if (["remove", "delete", "omit", "none", "null", "auto"].includes(v)) {
            return key === "stream" ? undefined : null;
        }
        if (key === "stream" || key === "thinking") {
            if (["on", "true", "1", "yes"].includes(v)) return true;
            if (["off", "false", "0", "no"].includes(v)) return false;
            return undefined;
        }
        if (key === "reasoning_effort") {
            if (["low", "medium", "high", "max"].includes(v)) return v;
            return undefined;
        }
        const num = Number(raw);
        if (!Number.isFinite(num)) return undefined;
        if (key === "temperature" && (num < 0 || num > 2)) return undefined;
        if (key === "top_p" && (num <= 0 || num > 1)) return undefined;
        if (key === "max_tokens" && (num < 1 || num > 131072)) return undefined;
        if (key === "seed" && (!Number.isInteger(num) || num < 0)) return undefined;
        if (key === "timeout" && (!Number.isInteger(num) || num < 15 || num > 180)) return undefined;
        return num;
    }

    function buildModelKeyboard(currentModel, customModels = []) {
        const rows = NVIDIA_FREE_MODELS.map((model, index) => [
            {
                text: `${model === currentModel ? "✅ " : ""}${model}`,
                callback_data: `model:${index}`,
            },
        ]);
        // ponytail: saved customs persist side by side — tap to select, 🗑️ to remove
        customModels.filter((m) => !NVIDIA_FREE_MODELS.includes(m)).forEach((model, ci) => {
            rows.push([
                {
                    text: `${model === currentModel ? "✅ " : ""}${model}`,
                    callback_data: `model:c${ci}`,
                },
                { text: "🗑️", callback_data: `model:del:${ci}` },
            ]);
        });
        return { inline_keyboard: rows };
    }

    function buildWelcomeText(model) {
        return (
            `<b>Welcome to the NVIDIA AI Chat Bot</b>\n` +
            `Your Telegram interface to NVIDIA-hosted AI models. Type any question and receive the answer right here.\n\n` +
            `<b>Getting started</b>\n` +
            `• Send any message to chat with the AI.\n` +
            `• /model – select a model, or set a custom one: <code>/model my/model-id</code>\n` +
            `• /test – verify the current model and API key before chatting\n` +
            `• /params – adjust temperature, max tokens, streaming, reasoning and more\n` +
            `• /keys – manage API keys (up to 5) with automatic failover on errors\n` +
            `• Open the ☰ menu next to the message box for the full command list.\n\n` +
            `<b>Current model:</b> <code>${escapeHtml(model)}</code>\n\n` +
            `Send /help at any time for detailed usage.`
        );
    }

    function buildHelpText(model, hasCustomKey) {
        return (
            `<b>Help &amp; Commands</b>\n\n` +
            `<b>Chat</b>\n` +
            `• Send any message to chat with the AI.\n` +
            `• /model – select a model, or set a custom one: <code>/model my/model-id</code>\n` +
            `• /removemodel – remove a saved custom model: <code>/removemodel my/model-id</code>\n` +
            `• /test – verify the current model and API key with a short probe\n\n` +
            `<b>Parameters</b>\n` +
            `• /params – adjust via buttons: temperature, top_p, max_tokens, seed, stream, timeout, thinking, reasoning_effort (only each model's own keys are sent)\n` +
            `• /set – set an exact value: <code>/set temperature 0.7</code>, <code>/set stream off</code>, <code>/set seed remove</code>\n\n` +
            `<b>API keys</b>\n` +
            `• /keys – masked key list, rotation mode (roundrobin / failover / manual), tap to select or delete\n` +
            `• /addapi – add a key: <code>/addapi nvapi-…</code> (on 429 or failure the next key is tried automatically)\n` +
            `• /removeapi – remove a key: <code>/removeapi 2</code>\n\n` +
            `<b>Status</b>\n` +
            `• Current model: <code>${escapeHtml(model)}</code>\n` +
            `• API key: ${hasCustomKey ? "your own key" : "bot default key"}\n\n` +
            `<b>Notes</b>\n` +
            `• Only text messages are supported; images and files are declined.\n` +
            `• Math such as <code>$x^2 + y^2 = z^2$</code> is rendered as readable Unicode.\n` +
            `• Long answers are split across multiple messages automatically.\n` +
            `• Every answer shows token usage; multi-key answers also show the key used.`
        );
    }

    async function handleModelCommand(env, chatId, replyToId) {
        const settings = await getUserSettings(env, chatId);
        await sendMessage(env, chatId, "🧠 <b>Choose an AI model:</b>\nTap a model to select it, 🗑️ to remove a saved one.\n⚙️ Params auto-tune to the model (change anytime with /params).\nAdd with <code>/model &lt;id&gt;</code> — saved models stay in this list.", {
            reply_markup: buildModelKeyboard(settings.model, settings.customModels),
                          ...replyToOptions(replyToId),
        });
    }

    async function handleParamsCommand(env, chatId, replyToId) {
        const settings = await getUserSettings(env, chatId);
        await sendMessage(env, chatId, buildParamsText(settings.params, settings.model), {
            reply_markup: buildParamsKeyboard(settings.params),
                          ...replyToOptions(replyToId),
        });
    }

    async function handleSetCommand(env, chatId, args, replyToId) {
        const [key, ...rest] = (args || "").split(/\s+/);
        const value = rest.join(" ").trim();
        if (!key || !value) {
            await sendMessage(env, chatId, `ℹ️ Usage: <code>/set &lt;key&gt; &lt;value&gt;</code>\nKeys: <code>${SETTABLE_KEYS.join("</code>, <code>")}</code>\nOr tap through /params.`, replyToOptions(replyToId));
            return;
        }
        if (!SETTABLE_KEYS.includes(key)) {
            await sendMessage(env, chatId, `❌ Unknown key <code>${escapeHtml(key)}</code>. Keys: <code>${SETTABLE_KEYS.join("</code>, <code>")}</code>`, replyToOptions(replyToId));
            return;
        }
        const parsed = parseSetValue(key, value);
        if (parsed === undefined) {
            await sendMessage(env, chatId, `❌ Bad value for <code>${escapeHtml(key)}</code>. Try /params to see valid options.`, replyToOptions(replyToId));
            return;
        }
        const settings = await getUserSettings(env, chatId);
        settings.params = sanitizeParams(settings.params);
        settings.params[key] = parsed;
        await saveUserSettings(env, chatId, settings);
        await sendMessage(env, chatId, `✅ <code>${escapeHtml(key)}</code> = <b>${fmtParam(parsed)}</b>`, {
            reply_markup: buildParamsKeyboard(settings.params),
                          ...replyToOptions(replyToId),
        });
    }

    function buildKeysText(settings, env) {
        const keys = effectiveKeys(settings, env);
        const lines = keys.map((k) => {
            const st = settings.keyStats[k.label] || { ok: 0, fail: 0 };
            const active = settings.keyMode === "manual" && k.mine && k.idx === settings.keyIndex ? " ✅<i>(in use)</i>" : "";
            const src = k.mine ? "you" : "bot";
            return `${k.mine ? `#${k.idx + 1}` : "•"} <code>${escapeHtml(k.label)}</code> (${src}) ok:${st.ok} fail:${st.fail}${active}`;
        });
        return (
            `🔑 <b>API keys</b> (${settings.apiKeys.length}/${MAX_API_KEYS} yours${env.NVIDIA_API_KEY ? " + bot default" : ""})\n` +
            (lines.length ? lines.join("\n") + "\n" : "No keys — add one with /addapi.\n") +
            `\nMode: <b>${settings.keyMode}</b> <i>(roundrobin = cycle, failover = stick to last working, manual = chosen key only)</i>\n` +
            `429 / fail → next key is tried automatically; each attempt is listed on failure.`
        );
    }

    function buildKeysKeyboard(settings, env) {
        const rows = [];
        rows.push(KEY_MODES.map((m) => ({
            text: `${settings.keyMode === m ? "✅ " : ""}${m}`,
            callback_data: `key:mode:${m}`,
        })));
        settings.apiKeys.forEach((k, i) => {
            const picked = settings.keyMode === "manual" && settings.keyIndex === i;
            rows.push([
                { text: `${picked ? "✅ " : ""}use #${i + 1} ${maskKey(k)}`, callback_data: `key:use:${i}` },
                      { text: `🗑️ del #${i + 1}`, callback_data: `key:del:${i}` },
            ]);
        });
        rows.push([{ text: "➕ Add key", callback_data: "key:add" }]);
        return { inline_keyboard: rows };
    }

    async function handleKeysCommand(env, chatId, replyToId) {
        const settings = await getUserSettings(env, chatId);
        await sendMessage(env, chatId, buildKeysText(settings, env), {
            reply_markup: buildKeysKeyboard(settings, env),
                          ...replyToOptions(replyToId),
        });
    }

    async function handleAddApiCommand(env, chatId, args, replyToId) {
        const key = (args || "").trim().split(/\s+/)[0] || "";
        const settings = await getUserSettings(env, chatId);
        if (key) {
            // ponytail: NVIDIA keys look like nvapi-… — reject anything else so a
            // mistyped message is never stored (and leaked) as a "key".
            if (!/^nvapi-[A-Za-z0-9_-]{8,}$/i.test(key)) {
                settings.awaitingKey = false;
                await saveUserSettings(env, chatId, settings);
                await sendMessage(env, chatId, "❌ That doesn't look like an NVIDIA key (it starts with <code>nvapi-</code>). Try again with <code>/addapi nvapi-…</code>.", replyToOptions(replyToId));
                return;
            }
            if (settings.apiKeys.includes(key)) {
                settings.awaitingKey = false;
                await saveUserSettings(env, chatId, settings);
                await sendMessage(env, chatId, "ℹ️ That key is already in your list.", replyToOptions(replyToId));
                return;
            }
            if (settings.apiKeys.length >= MAX_API_KEYS) {
                settings.awaitingKey = false;
                await saveUserSettings(env, chatId, settings);
                await sendMessage(env, chatId, `❌ List full (${MAX_API_KEYS}). Remove one with /removeapi <n> or /keys first.`, replyToOptions(replyToId));
                return;
            }
            settings.apiKeys.push(key);
            settings.awaitingKey = false;
            await saveUserSettings(env, chatId, settings);
            await sendMessage(env, chatId, `✅ Key <code>${escapeHtml(maskKey(key))}</code> added as #${settings.apiKeys.length}. 429/fail → next key is tried automatically.`, replyToOptions(replyToId));
            return;
        }
        settings.awaitingKey = true;
        await saveUserSettings(env, chatId, settings);
        await sendMessage(env, chatId, ASK_API_KEY_PROMPT, { reply_markup: { force_reply: true }, ...replyToOptions(replyToId) });
    }

    async function handleRemoveApiCommand(env, chatId, args, replyToId) {
        const settings = await getUserSettings(env, chatId);
        const n = Number((args || "").trim());
        if (!settings.apiKeys.length) {
            await sendMessage(env, chatId, "ℹ️ You have no custom keys. The bot's default key is being used.", replyToOptions(replyToId));
            return;
        }
        if (!args.trim()) {
            await sendMessage(env, chatId,
                              `🗑️ Your keys:\n${settings.apiKeys.map((k, i) => `#${i + 1} <code>${escapeHtml(maskKey(k))}</code>`).join("\n")}\n\nSend <code>/removeapi &lt;n&gt;</code> to delete one, or manage with /keys.`,
                              replyToOptions(replyToId));
            return;
        }
        if (!Number.isInteger(n) || n < 1 || n > settings.apiKeys.length) {
            await sendMessage(env, chatId, `❌ Pick 1–${settings.apiKeys.length}.`, replyToOptions(replyToId));
            return;
        }
        const [gone] = settings.apiKeys.splice(n - 1, 1);
        if (settings.keyIndex >= settings.apiKeys.length) settings.keyIndex = 0;
        if (settings.keyPrimary >= settings.apiKeys.length) settings.keyPrimary = 0;
        await saveUserSettings(env, chatId, settings);
        await sendMessage(env, chatId, `🗑️ Removed <code>${escapeHtml(maskKey(gone))}</code>. ${settings.apiKeys.length ? "Remaining keys renumbered — see /keys." : "Bot default key will be used."}`, replyToOptions(replyToId));
    }

    // Tiny live check: "Say OK" through the current model so the user knows
    // the model id + key work before starting a real chat.
    async function handleTestCommand(env, chatId, replyToId) {
        const settings = await getUserSettings(env, chatId);
        const keys = orderKeysForMode(effectiveKeys(settings, env), settings);
        if (!keys.length) {
            await sendMessage(
                env,
                chatId,
                "⚠️ No NVIDIA API key is configured. Ask the bot owner to set the NVIDIA_API_KEY secret, or add your own with /addapi.",
                replyToOptions(replyToId)
            );
            return;
        }
        const notice = await sendMessage(env, chatId, `🧪 Testing <code>${escapeHtml(settings.model)}</code>…`, replyToOptions(replyToId));
        const noticeId = notice?.result?.message_id || null;
        // ponytail: same keep-alive as chat — without typing/ticker a slow
        // model looks dead on "Testing…" and a Worker kill leaves it stuck.
        const typing = startTypingLoop(env, chatId);
        const startedAt = Date.now();
        const tSec = Math.min(180, Math.max(15, Number(settings.params?.timeout) || 45));
        let progressTimer = null;
        try {
            if (noticeId) {
                progressTimer = setInterval(() => {
                    const s = Math.round((Date.now() - startedAt) / 1000);
                    editMessageText(env, chatId, noticeId, `🧪 Testing <code>${escapeHtml(settings.model)}</code>… ⏳ ${s}s / ${tSec}s`).catch(() => {});
                }, 6000);
            }
        } catch {
            /* ignore */
        }
        const stopAll = () => {
            typing.stopped = true;
            if (progressTimer) {
                clearInterval(progressTimer);
                progressTimer = null;
            }
        };
        const testPrompt = "Reply with exactly: OK";
        try {
            // ponytail: /test forces max_tokens:10 + params so a slow custom
            // model (e.g. kimi-k3) answers in seconds, not past the 45s kill window.
            const r = await runPrompt(env, chatId, testPrompt, settings, keys, { isTest: true });
            await saveUserSettings(env, chatId, settings);
            stopAll();
            const partialNote = r.partial ? `\n\n⚠️ <i>Stream cut off — showing partial answer.</i>` : "";
            const tookSec = Math.round((Date.now() - startedAt) / 1000);
            const preview = String(r.content || "").trim().slice(0, 200);
            await sendFormattedChunk(
                env,
                chatId,
                `✅ <b>Working!</b> <code>${escapeHtml(settings.model)}</code>\nReply: ${escapeHtml(preview) || "—"}\nSend any message to chat.${formatUsageFooter(r.usage, testPrompt, r.content, null)}${keyLine(r.keyLabel, r.tryNo, r.tryTotal)}${partialNote}\n⏱️ <i>answered in ${tookSec}s</i>`,
                                     noticeId
            );
        } catch (err) {
            stopAll();
            await saveUserSettings(env, chatId, settings).catch(() => {});
            const attempts = err.attempts || [{ label: keys[0]?.label || "key", ok: false, reason: shortReason(err) }];
            const html = buildFailHtml(settings.model, attempts, true);
            if (noticeId) {
                const res = await editMessageText(env, chatId, noticeId, html);
                if (!res?.ok) await sendMessage(env, chatId, html, replyToOptions(replyToId));
            } else {
                await sendMessage(env, chatId, html, replyToOptions(replyToId));
            }
        }
    }

    async function handleCallbackQuery(update, env) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat?.id;
        const data = cq.data || "";

        if (!chatId) {
            await answerCallbackQuery(env, cq.id, "");
            return;
        }

        if (data.startsWith("param:")) {
            const [, sub, val] = data.split(":");
            const settings = await getUserSettings(env, chatId);
            if (sub === "reset") {
                settings.params = { ...DEFAULT_PARAMS };
                await saveUserSettings(env, chatId, settings);
                await answerCallbackQuery(env, cq.id, "Params reset");
            } else if (sub === "clear") {
                // ponytail: ❌ buttons omit the key from the request (same as
                // /set <key> remove) — no typing needed; stream/timeout can't clear
                if (val === "stream" || val === "timeout" || !SETTABLE_KEYS.includes(val)) {
                    await answerCallbackQuery(env, cq.id, "That one can't be removed.", true);
                    return;
                }
                settings.params = sanitizeParams(settings.params);
                settings.params[val] = null;
                await saveUserSettings(env, chatId, settings);
                await answerCallbackQuery(env, cq.id, `${val} removed (omitted)`);
            } else if (!SETTABLE_KEYS.includes(sub)) {
                await answerCallbackQuery(env, cq.id, "Unknown param.", true);
                return;
            } else {
                settings.params = cycleParam(sub, settings.params);
                await saveUserSettings(env, chatId, settings);
                await answerCallbackQuery(env, cq.id, `${sub} = ${fmtParam(settings.params[sub])}`);
            }
            await tgCall(env, "editMessageText", {
                chat_id: chatId,
                message_id: cq.message.message_id,
                text: buildParamsText(settings.params, settings.model),
                         parse_mode: "HTML",
                         disable_web_page_preview: true,
                         reply_markup: buildParamsKeyboard(settings.params),
            });
            return;
        }

        if (data.startsWith("key:")) {
            const [, action, val] = data.split(":");
            const settings = await getUserSettings(env, chatId);
            if (action === "mode" && KEY_MODES.includes(val)) {
                settings.keyMode = val;
                await saveUserSettings(env, chatId, settings);
                await answerCallbackQuery(env, cq.id, `Mode: ${val}`);
            } else if (action === "use") {
                const i = Number(val);
                if (!Number.isInteger(i) || !settings.apiKeys[i]) {
                    await answerCallbackQuery(env, cq.id, "Unknown key.", true);
                    return;
                }
                settings.keyMode = "manual";
                settings.keyIndex = i;
                await saveUserSettings(env, chatId, settings);
                await answerCallbackQuery(env, cq.id, `Manual: key #${i + 1}`);
            } else if (action === "del") {
                const i = Number(val);
                if (!Number.isInteger(i) || !settings.apiKeys[i]) {
                    await answerCallbackQuery(env, cq.id, "Unknown key.", true);
                    return;
                }
                const [gone] = settings.apiKeys.splice(i, 1);
                if (settings.keyIndex >= settings.apiKeys.length) settings.keyIndex = 0;
                if (settings.keyPrimary >= settings.apiKeys.length) settings.keyPrimary = 0;
                await saveUserSettings(env, chatId, settings);
                await answerCallbackQuery(env, cq.id, `Removed ${maskKey(gone)}`);
            } else if (action === "add") {
                await answerCallbackQuery(env, cq.id, "");
                // ponytail: remember we asked — the key is saved even if the user
                // pastes it as a plain message instead of using reply.
                settings.awaitingKey = true;
                await saveUserSettings(env, chatId, settings);
                await sendMessage(env, chatId, ASK_API_KEY_PROMPT, { reply_markup: { force_reply: true } });
                return;
            } else {
                await answerCallbackQuery(env, cq.id, "");
                return;
            }
            await tgCall(env, "editMessageText", {
                chat_id: chatId,
                message_id: cq.message.message_id,
                text: buildKeysText(settings, env),
                         parse_mode: "HTML",
                         disable_web_page_preview: true,
                         reply_markup: buildKeysKeyboard(settings, env),
            });
            return;
        }

        if (data.startsWith("model:")) {
            const parts = data.split(":");
            const settings = await getUserSettings(env, chatId);
            // model:del:<ci> — remove a saved custom model
            if (parts[1] === "del") {
                const ci = Number(parts[2]);
                const gone = settings.customModels[ci];
                if (gone == null) {
                    await answerCallbackQuery(env, cq.id, "Unknown model.", true);
                    return;
                }
                settings.customModels.splice(ci, 1);
                if (settings.model === gone) {
                    settings.model = DEFAULT_MODEL;
                    // ponytail: fell back to default — retune params so requests stay valid
                    settings.params = applyModelAutoParams(settings.params, DEFAULT_MODEL);
                }
                await saveUserSettings(env, chatId, settings);
                await answerCallbackQuery(env, cq.id, `Removed ${gone}`);
                await tgCall(env, "editMessageReplyMarkup", {
                    chat_id: chatId,
                    message_id: cq.message.message_id,
                    reply_markup: buildModelKeyboard(settings.model, settings.customModels),
                });
                return;
            }
            const tag = parts[1];
            let model = null;
            if (typeof tag === "string" && tag.startsWith("c")) {
                model = settings.customModels[Number(tag.slice(1))];
            } else {
                model = NVIDIA_FREE_MODELS[Number(tag)];
            }
            if (!model) {
                await answerCallbackQuery(env, cq.id, "Unknown model.", true);
                return;
            }
            settings.model = model;
            // ponytail: auto-tune params to this model's API shape on every
            // switch — user can still change anything via /params or /set.
            settings.params = applyModelAutoParams(settings.params, model);
            await saveUserSettings(env, chatId, settings);
            await answerCallbackQuery(env, cq.id, `Model set, params auto-tuned`);
            await tgCall(env, "editMessageReplyMarkup", {
                chat_id: chatId,
                message_id: cq.message.message_id,
                reply_markup: buildModelKeyboard(model, settings.customModels),
            });
            return;
        }

        await answerCallbackQuery(env, cq.id, "");
    }

    // Shared runner: one prompt, one provider budget inside the worker window.
    async function runPrompt(env, chatId, prompt, settings, keys, { isTest = false, onPartial = null } = {}) {
        // ponytail: timeout comes from /params (default 45s), clamped so one
        // update never outlives the worker.
        const tSec = Math.min(180, Math.max(15, Number(settings.params?.timeout) || PROVIDER_TIMEOUT_MS / 1000));
        return callNvidiaMulti(settings.model, prompt, keys, {
            onPartial,
            userParams: settings.params,
            isTest,
            budgetMs: tSec * 1000,
            settings,
        });
    }

    async function handleChatMessage(env, chatId, text, replyToId) {
        const settings = await getUserSettings(env, chatId);
        const keys = orderKeysForMode(effectiveKeys(settings, env), settings);

        if (!keys.length) {
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
        const startedAt = Date.now();
        const tSec = Math.min(180, Math.max(15, Number(settings.params?.timeout) || 45));
        // ponytail: tick elapsed time for ALL models (not just non-streaming) —
        // a stalled stream with no deltas otherwise looks dead on "Thinking…".
        let progressTimer = null;
        let lastPreviewAt = 0;
        try {
            if (thinkingId) {
                progressTimer = setInterval(() => {
                    // skip if a stream preview just updated — don't fight it
                    if (Date.now() - lastPreviewAt < 6000) return;
                    const s = Math.round((Date.now() - startedAt) / 1000);
                    editMessageText(env, chatId, thinkingId, `🤔 <i>Thinking… ⏳ ${s}s / ${tSec}s</i>`).catch(() => {});
                }, 6000);
            }
        } catch {
            /* ignore */
        }
        const stopAll = () => {
            typing.stopped = true;
            if (progressTimer) {
                clearInterval(progressTimer);
                progressTimer = null;
            }
        };

        let lastEditAt = 0;
        // ponytail: fire-and-forget (not awaited) so a slow Telegram edit can't
        // stall stream consumption and trip the 20s stall detector.
        const onPartial = ({ content, reasoning }) => {
            const now = Date.now();
            if (!thinkingId || now - lastEditAt < 2000) return;
            lastEditAt = now;
            lastPreviewAt = now;
            try {
                const preview = buildFinalHtml(content, reasoning, null, null, "", settings.model);
                const trimmed = preview.length > MAX_CHUNK_LEN ? `${preview.slice(0, MAX_CHUNK_LEN)}…` : preview;
                editMessageText(env, chatId, thinkingId, trimmed || "🤔 <i>Thinking…</i>").catch(() => {});
            } catch {
                /* ignore preview errors */
            }
        };

        try {
            const r = await runPrompt(env, chatId, text, settings, keys, { onPartial });
            await saveUserSettings(env, chatId, settings);
            stopAll();

            const partialNote = r.partial ? `\n\n⚠️ <i>Stream cut off — showing partial answer.</i>` : "";
            const tookSec = Math.round((Date.now() - startedAt) / 1000);
            const html = buildFinalHtml(r.content, r.reasoning, r.usage, text, keyLine(r.keyLabel, r.tryNo, r.tryTotal) + partialNote + `\n⏱️ <i>answered in ${tookSec}s</i>`, settings.model);
            const chunks = splitHtmlSafely(html, MAX_CHUNK_LEN);

            await sendFormattedChunk(env, chatId, chunks[0] || "🤷 No response received.", thinkingId);
            for (let i = 1; i < chunks.length; i++) {
                await sendFormattedChunk(env, chatId, chunks[i], null);
            }
        } catch (err) {
            stopAll();
            console.error("AI generation error:", err);
            await saveUserSettings(env, chatId, settings).catch(() => {});

            const attempts = err.attempts || [{ label: keys[0]?.label || "key", ok: false, reason: shortReason(err) }];

            const html = buildFailHtml(settings.model, attempts, false);
            if (thinkingId) {
                const res = await editMessageText(env, chatId, thinkingId, html);
                if (!res?.ok) await sendMessage(env, chatId, html, replyToOptions(replyToId));
            } else {
                await sendMessage(env, chatId, html, replyToOptions(replyToId));
            }
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

            // ponytail: text-only bot — free plan has no image storage, so photos,
            // stickers, files, etc. are rejected outright and never reach KV/payload.
            if (message.photo || message.sticker || message.document || message.video || message.audio || message.voice || message.video_note || typeof message.text !== "string") {
                await sendMessage(env, chatId, "🙏 Text only — I can't receive or send images on this plan. Please type your question.", replyToOptions(replyToId));
                return;
            }

            const text = message.text.trim();

            if (message.reply_to_message && message.reply_to_message.text === ASK_API_KEY_PROMPT) {
                await handleAddApiCommand(env, chatId, text, replyToId);
                return;
            }

            // ponytail: pending-key state — only a key-shaped message is saved;
            // anything else clears the flag and flows to normal chat, so a
            // question typed after tapping ➕ is never eaten as a key.
            if (!text.startsWith("/")) {
                const pending = await getUserSettings(env, chatId);
                if (pending.awaitingKey) {
                    if (/^nvapi-[A-Za-z0-9_-]{8,}$/i.test(text)) {
                        await handleAddApiCommand(env, chatId, text, replyToId);
                        return;
                    }
                    pending.awaitingKey = false;
                    await saveUserSettings(env, chatId, pending);
                }
                // ponytail: never leak a pasted NVIDIA key to the model as a question
                if (/^nvapi-[A-Za-z0-9_-]{8,}$/i.test(text)) {
                    await sendMessage(env, chatId, "🔑 That looks like an API key — I did <b>not</b> send it to the AI.\nSave it with <code>/addapi &lt;key&gt;</code> or tap ➕ in /keys.", replyToOptions(replyToId));
                    return;
                }
            }

            if (text.startsWith("/")) {
                const [rawCmd, ...rest] = text.split(/\s+/);
                const command = rawCmd.split("@")[0].toLowerCase();
                const args = rest.join(" ").trim();
                // ponytail: user chose a command instead of pasting the key — drop
                // the pending state so a later question isn't eaten as a key.
                if (command !== "/addapi") {
                    try {
                        const s = await getUserSettings(env, chatId);
                        if (s.awaitingKey) {
                            s.awaitingKey = false;
                            await saveUserSettings(env, chatId, s);
                        }
                    } catch { /* ignore */ }
                }

                switch (command) {
                    case "/start": {
                        await configureBotUi(env).catch(() => {});
                        const settings = await getUserSettings(env, chatId);
                        await sendMessage(env, chatId, buildWelcomeText(settings.model), replyToOptions(replyToId));
                        return;
                    }
                    case "/help": {
                        const settings = await getUserSettings(env, chatId);
                        await sendMessage(env, chatId, buildHelpText(settings.model, settings.apiKeys.length > 0), replyToOptions(replyToId));
                        return;
                    }
                    case "/model": {
                        // ponytail: /model <id> appends to the saved list (never
                        // replaces it); bare /model opens the menu with 🗑️ buttons
                        const custom = (args || "").split(/\s+/)[0] || "";
                        if (custom) {
                            if (!isValidModelId(custom)) {
                                await sendMessage(env, chatId, "❌ Invalid model id. Use letters, numbers and <code>/ - _ : .</code> only, no spaces.", replyToOptions(replyToId));
                                return;
                            }
                            const settings = await getUserSettings(env, chatId);
                            settings.model = custom;
                            // ponytail: auto-tune params to this model's API shape —
                            // user can still change anything via /params or /set.
                            settings.params = applyModelAutoParams(settings.params, custom);
                            if (!NVIDIA_FREE_MODELS.includes(custom) && !settings.customModels.includes(custom)) {
                                settings.customModels.push(custom);
                                while (settings.customModels.length > MAX_CUSTOM_MODELS) settings.customModels.shift();
                            }
                            await saveUserSettings(env, chatId, settings);
                            await sendMessage(env, chatId, `✅ Model set to: <code>${escapeHtml(custom)}</code>\n⚙️ Auto params: <code>${escapeHtml(autoParamsLine(custom, settings.params))}</code> <i>(change anytime with /params or /set)</i>\nSaved to your list (${settings.customModels.length}/${MAX_CUSTOM_MODELS} customs) — manage with /model (🗑️ to remove).\nIf the provider rejects it, pick a listed model with /model.`, replyToOptions(replyToId));
                            return;
                        }
                        await handleModelCommand(env, chatId, replyToId);
                        return;
                    }
                    case "/params":
                        await handleParamsCommand(env, chatId, replyToId);
                        return;
                    case "/set":
                        await handleSetCommand(env, chatId, args, replyToId);
                        return;
                    case "/keys":
                        await handleKeysCommand(env, chatId, replyToId);
                        return;
                    case "/addapi":
                        await handleAddApiCommand(env, chatId, args, replyToId);
                        return;
                    case "/test":
                        await handleTestCommand(env, chatId, replyToId);
                        return;
                    case "/removeapi":
                        await handleRemoveApiCommand(env, chatId, args, replyToId);
                        return;
                    case "/removemodel": {
                        const target = (args || "").split(/\s+/)[0] || "";
                        const settings = await getUserSettings(env, chatId);
                        if (!target) {
                            await sendMessage(env, chatId,
                                              settings.customModels.length
                                              ? `🗑️ Saved models:\n${settings.customModels.map((m) => `• <code>${escapeHtml(m)}</code>`).join("\n")}\n\nSend <code>/removemodel &lt;id&gt;</code>, or tap 🗑️ in /model.`
                                              : "ℹ️ No saved custom models — nothing to remove. Add one with <code>/model &lt;id&gt;</code>.",
                                              replyToOptions(replyToId));
                            return;
                        }
                        const i = settings.customModels.indexOf(target);
                        if (i < 0) {
                            await sendMessage(env, chatId, `❌ <code>${escapeHtml(target)}</code> is not in your saved list. See /model.`, replyToOptions(replyToId));
                            return;
                        }
                        settings.customModels.splice(i, 1);
                        if (settings.model === target) {
                            settings.model = DEFAULT_MODEL;
                            // ponytail: fell back to default — retune params so requests stay valid
                            settings.params = applyModelAutoParams(settings.params, DEFAULT_MODEL);
                        }
                        await saveUserSettings(env, chatId, settings);
                        await sendMessage(env, chatId, `🗑️ Removed <code>${escapeHtml(target)}</code>.${settings.model === DEFAULT_MODEL ? ` Back to default <code>${escapeHtml(DEFAULT_MODEL)}</code>.` : ""}`, replyToOptions(replyToId));
                        return;
                    }
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
