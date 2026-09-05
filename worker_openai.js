// Single-file Telegram AI bot for Cloudflare Workers (no wrangler needed).
// Paste this file in Dashboard: Workers & Pages > Create Worker > Deploy > Edit code.
//
// Bindings needed:
//   - KV namespace: USER_SETTINGS
//   - Secret/var: TELEGRAM_TOKEN (plain secret string; a KV holding key "TOKEN" also works)
//   - Optional: Workers AI binding named AI (for free default model)
//   - Optional var: ACTIVATE_SECRET — if set, /activate requires ?secret=VALUE
//
// Then open: https://<worker>.workers.dev/activate   (sets webhook + commands)
// Commands: /start /help /setBaseURL /setAPIkey /setModelmanuel /useDefaultModel /Model /style /test
// Only inline keyboards are used. No reply (hard) keyboard is ever created.

const DEFAULT_CF_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const PAGE_SIZE = 8;
const MAX_HIST = 20;

const STYLES = {
    normal:  { label: '💬 Normal',      sys: '' },
    code:    { label: '💻 Programming', sys: 'You are a senior performance-obsessed programmer. Answer with correct code first, then only performance notes (complexity, hot paths). No fluff, no beginner tutorial.' },
    student: { label: '🎓 Student',     sys: 'Explain everything in full detail for a student: step by step, simple words, examples, and why each step matters.' },
    sci:     { label: '🔬 Scientist',   sys: 'Answer with full scientific detail and rigor: assumptions, method, evidence level, uncertainties. No simplification.' },
    trans:   { label: '🌍 Translate',   sys: 'You are an advanced translator. Auto-detect source language, translate accurately preserving tone and formatting, then add one short nuance note only if something is ambiguous.' },
};

const MENU = [
    [{ text: '🌐 Set Base URL', callback_data: 'cmd:base' }, { text: '🔑 Set API Key', callback_data: 'cmd:key' }],
[{ text: '🔌 OpenAI', callback_data: 'prov:openai' }, { text: '🅰️ Anthropic', callback_data: 'prov:anthropic' }],
[{ text: '🤖 Models', callback_data: 'pg:0' }, { text: '✍️ Set Model manual', callback_data: 'cmd:manual' }],
[{ text: '☁️ Use Default Model', callback_data: 'cmd:def' }, { text: '🧪 Test Model', callback_data: 'cmd:test' }],
[{ text: '🎨 Style', callback_data: 'cmd:style' }, { text: '❓ Help', callback_data: 'cmd:help' }],
];

// Anthropic Messages API: POST {base}/messages, headers x-api-key + anthropic-version: 2023-06-01,
// body {model, max_tokens, system?, messages:[{role:user|assistant, content}]}, reply {content:[{text}], usage:{input_tokens, output_tokens}}
const isAnth = u => (u.provider || 'openai') === 'anthropic';
const provTag = u => isAnth(u) ? '🅰️ Anthropic' : '🔌 OpenAI';
const anthHeaders = u => ({ 'content-type': 'application/json', 'x-api-key': u.apiKey, 'anthropic-version': '2023-06-01' });
function toAnthropic(reqMsgs) {
    const sys = reqMsgs.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const messages = reqMsgs.filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: String(m.content ?? '') })).filter(m => m.content);
    return { system: sys || undefined, messages: messages.length ? messages : [{ role: 'user', content: 'Hi' }] };
}
const anthText = j => Array.isArray(j?.content) ? j.content.map(b => typeof b?.text === 'string' ? b.text : '').filter(Boolean).join('\n') : '';
const anthUsage = j => ({ prompt_tokens: j?.usage?.input_tokens || 0, completion_tokens: j?.usage?.output_tokens || 0, total_tokens: (j?.usage?.input_tokens || 0) + (j?.usage?.output_tokens || 0) });

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === '/activate') return activate(req, url, env);
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) return new Response('OK. Open /activate to link Telegram.', { status: 200 });
        if (req.method !== 'POST') return new Response('Not found', { status: 404 });
        try {
            const token = await getToken(env);
            if (!token) return new Response('Missing TELEGRAM_TOKEN', { status: 500 });
            // Reject forged Telegram updates once a webhook secret exists
            const saved = await loadSecret(env);
            if (saved && req.headers.get('x-telegram-bot-api-secret-token') !== saved) {
                console.error('webhook rejected: bad secret from', req.headers.get('cf-connecting-ip'));
                return new Response('Forbidden', { status: 403 });
            }
            const update = await req.json().catch(() => ({}));
            // ponytail: ACK fast via waitUntil so Telegram doesn't retry (double Thinking…), dedupe update_id
            const uid = update?.update_id;
            if (uid != null) {
                const k = 'upd:' + uid;
                if (mem.get(k)) return new Response('OK');
                mem.set(k, 1);
                if (mem.size > 1000) mem.delete(mem.keys().next().value); // ponytail: cap isolate cache, KV remains source of truth
                try { if (await kvGet(env, k)) return new Response('OK'); } catch {}
                if (ctx?.waitUntil) ctx.waitUntil(kvPut(env, k, 1, { expirationTtl: 300 }));
                else kvPut(env, k, 1, { expirationTtl: 300 }).catch(() => {});
            }
            const p = handleUpdate(update, env, token).catch(e => console.error('webhook async:', e?.stack || e));
            if (ctx?.waitUntil) ctx.waitUntil(p); else await p;
        } catch (e) { console.error('webhook fatal:', e?.stack || e); }
        return new Response('OK');
    },
};

// ---------- setup / security ----------
async function activate(req, url, env) {
    try {
        const ip = req.headers.get('cf-connecting-ip') || 'unknown';
        // Optional shared secret: set var ACTIVATE_SECRET, then open /activate?secret=VALUE
        if (typeof env.ACTIVATE_SECRET === 'string' && env.ACTIVATE_SECRET) {
            const a = url.searchParams.get('secret') || '', b = env.ACTIVATE_SECRET;
            if (a.length !== b.length || ![...a].every((c, i) => c === b[i])) {
                console.error('activate denied (bad secret) from', ip);
                return new Response('Forbidden', { status: 403 });
            }
        }
        // Throttle: max one activation per 30s (KV + memory, prevents spam/DoS)
        const now = Date.now(), last = (await kvGet(env, 'act_ts')) || mem.get('act_ts') || 0;
        if (now - (+last) < 30000) return new Response('Wait 30s between activations.', { status: 429 });
        mem.set('act_ts', now); await kvPut(env, 'act_ts', now);

        const token = await getToken(env);
        if (!token) return new Response('Missing TELEGRAM_TOKEN binding/secret.', { status: 500 });
        const secret = (typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : String(Math.random())) + '-tg';
        const base = url.origin;
        const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: base + '/', secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }),
        }).then(r => r.json());
        if (!r.ok) { console.error('setWebhook failed:', JSON.stringify(r)); return Response.json(r, { status: 500 }); }
        mem.set('tg_secret', secret); await kvPut(env, 'tg_secret', secret);
        const cmds = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ commands: [
                { command: 'start', description: 'Start + menu' }, { command: 'help', description: 'Show help' },
                { command: 'provider', description: 'OpenAI or Anthropic' },
                { command: 'setBaseURL', description: 'Set Base URL' }, { command: 'setAPIkey', description: 'Set API key' },
                { command: 'setModelmanuel', description: 'Type model name manually' }, { command: 'useDefaultModel', description: 'Use free Cloudflare model' },
                { command: 'Model', description: 'List models + pick' }, { command: 'style', description: 'Answer style' },
                { command: 'test', description: 'Test current model' },
            ]}),
        }).then(r => r.json());
        console.log('activated from', ip, 'for', base, JSON.stringify(cmds));
        return new Response('✅ Bot activated for ' + base + '. Open Telegram and send /start');
    } catch (e) { console.error('activate error:', e?.stack || e); return new Response('Activate failed: ' + e.message, { status: 500 }); }
}

async function getToken(env) {
    const t = env.TELEGRAM_TOKEN;
    if (!t) return '';
    if (typeof t === 'string') return t.trim();
    try { if (typeof t.get === 'function') return ((await t.get('TOKEN')) || '').trim(); } catch (e) { console.error('token KV read:', e.message); }
    return '';
}

// ---------- KV store ----------
const mem = new Map();
async function kvGet(env, k) { try { if (env.USER_SETTINGS?.get) return await env.USER_SETTINGS.get(k, 'json'); } catch (e) { console.error('KV get:', e.message); } return null; }
async function kvPut(env, k, v, opt) { try { if (env.USER_SETTINGS?.put) await env.USER_SETTINGS.put(k, JSON.stringify(v), opt); } catch (e) { console.error('KV put:', e.message); } }
async function loadSecret(env) { return mem.get('tg_secret') || await kvGet(env, 'tg_secret'); }
async function loadUser(env, id) {
    const j = await kvGet(env, 'user:' + id);
    if (j) return j;
    return mem.get('user:' + id) || {};
}
async function saveUser(env, id, s) {
    mem.set('user:' + id, s); await kvPut(env, 'user:' + id, s);
}
async function loadModels(env, id) {
    const j = await kvGet(env, 'models:' + id);
    if (Array.isArray(j)) return j;
    return mem.get('models:' + id) || null;
}
async function saveModels(env, id, list) {
    mem.set('models:' + id, list); await kvPut(env, 'models:' + id, list, { expirationTtl: 600 });
}

// ---------- telegram ----------
const tg = (token, method, payload, ms = 15000) => {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), ms);
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: ctl.signal,
    }).then(r => r.json()).catch(e => ({ ok: false, description: String(e?.message || e) })).finally(() => clearTimeout(to));
};
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

const send = (token, chat_id, text, reply_to, extraKb) =>
sendChunks(token, chat_id, text, reply_to, extraKb);
const edit = (token, chat_id, message_id, text, kb) =>
tg(token, 'editMessageText', { chat_id, message_id, text: text.slice(0, 4000) || '…', parse_mode: 'HTML', reply_markup: kb ? { inline_keyboard: kb } : undefined });
const answerCb = (token, id, text) =>
tg(token, 'answerCallbackQuery', { callback_query_id: id, text: (text || '').slice(0, 190) });

async function sendChunks(token, chat_id, html, reply_to, extraKb) {
    const parts = splitHtml(html || '…');
    for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1;
        const payload = { chat_id, text: parts[i], parse_mode: 'HTML',
            ...(reply_to && i === 0 ? { reply_to_message_id: reply_to } : {}),
            ...(last && extraKb ? { reply_markup: { inline_keyboard: extraKb } } : {}) };
            if (parts.length > 1) payload.text = `<i>(${i + 1}/${parts.length})</i>\n` + payload.text;
            const r = await tg(token, 'sendMessage', payload);
            if (!r.ok && /parse entities|can't parse/i.test(r.description || '')) // ponytail: plain-text fallback if AI HTML breaks parse
                await tg(token, 'sendMessage', { chat_id, text: stripTags(parts[i]).slice(0, 4000),
                    ...(last && extraKb ? { reply_markup: { inline_keyboard: extraKb } } : {}) });
                if (!r.ok) console.error('sendMessage failed:', JSON.stringify(r).slice(0, 500));
    }
}
// Telegram-safe split: ≤4096 chars, prefer newline, never cut inside <tag>, keep <pre> blocks valid
function splitHtml(s) {
    const out = []; let t = s, pre = false;
    while (t.length > 4096) {
        let i = t.lastIndexOf('\n', 4000); if (i < 500) i = 4000;
        const lt = t.lastIndexOf('<', i); // don't cut inside a tag
        if (lt > 0 && t.indexOf('>', lt) > i) i = lt;
        let chunk = t.slice(0, i);
        const opens = (chunk.match(/<pre>/g) || []).length, closes = (chunk.match(/<\/pre>/g) || []).length;
        if (pre) chunk = '<pre>' + chunk;
        if (opens + (pre ? 1 : 0) > closes) { chunk += '</pre>'; pre = true; } else pre = false;
        out.push(chunk); t = t.slice(i);
    }
    out.push((pre ? '<pre>' : '') + t); return out;
}
const stripTags = s => s.replace(/<[^>]+>/g, '');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ponytail: same token footer as worker_n.js — exact usage when the
// provider returns it, "~" estimates (chars/4) otherwise, "" if not countable.
function estimateTokens(s) {
    if (!s) return 0;
    return Math.max(1, Math.ceil(String(s).length / 4));
}
function normalizeUsage(u) {
    if (!u) return null;
    const p = u.prompt_tokens ?? u.promptTokens ?? u.input_tokens ?? u.inputTokens ?? u.prompt ?? null;
    const c = u.completion_tokens ?? u.completionTokens ?? u.output_tokens ?? u.outputTokens ?? u.completion ?? u.generated_tokens ?? null;
    const t = u.total_tokens ?? u.totalTokens ?? ((p != null && c != null) ? p + c : null);
    if (p == null && c == null && t == null) return null;
    return { prompt_tokens: p, completion_tokens: c, total_tokens: t };
}
function formatUsageFooter(usage, promptText, content, reasoning) {
    const u = normalizeUsage(usage) || usage;
    let sent = u?.prompt_tokens, received = u?.completion_tokens, total = u?.total_tokens;
    // ponytail: all-zero usage = provider omitted it — estimate instead of "0/0/0"
    if ((sent || 0) === 0 && (received || 0) === 0 && (total || 0) === 0) { sent = received = total = null; }
    let approx = false;
    if (sent == null && received == null && total == null) {
        if (!promptText && !content && !reasoning) return '';
        sent = estimateTokens(promptText);
        received = estimateTokens((content || '') + (reasoning || ''));
        total = sent + received;
        approx = true;
    } else {
        sent = sent ?? estimateTokens(promptText);
        received = received ?? estimateTokens((content || '') + (reasoning || ''));
        total = total ?? (sent + received);
    }
    const t = approx ? '~' : '';
    return `\n\n📊 <code>↑ ${t}${sent} sent • ↓ ${t}${received} received • Σ ${t}${total} total</code>`;
}

// Minimal markdown → Telegram HTML (code, bold, italic, strike, spoiler, links, headings)
function mdToHtml(src) {
    let s = esc(src || '');
    const stash = [];
    s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, l, c) => { stash.push(`<pre><code${l ? ` class="language-${l}"` : ''}>${c.replace(/^\n+|\n+$/g, '')}</code></pre>`); return `\u0000${stash.length - 1}\u0000`; });
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { stash.push(`<code>${c}</code>`); return `\u0000${stash.length - 1}\u0000`; });
    s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    s = s.replace(/\*\*([\s\S]+?)\*\*|__([\s\S]+?)__/g, (_, a, b) => `<b>${a ?? b}</b>`);
    s = s.replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');
    s = s.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="tg-spoiler">$1</span>');
    s = s.replace(/(^|[\s(>])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/(^|[\s(>])_([^_\n]+)_/g, '$1<i>$2</i>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[+n]);
}

// ---------- updates ----------
async function handleUpdate(u, env, token) {
    if (u.callback_query) return onCallback(u.callback_query, env, token);
    const m = u.message || u.edited_message;
    if (!m?.chat?.id) return;
    const chatId = m.chat.id, msgId = m.message_id;
    const text = (m.text || '').trim();
    if (!text) return;
    const user = await loadUser(env, chatId);

    if (user.awaiting) { // waiting for a value
        const v = text;
        if (user.awaiting === 'baseUrl') {
            user.baseUrl = v.replace(/\/+$/, '').replace(/\/chat\/completions\/?$/i, '').replace(/\/messages\/?$/i, '');
            user.awaiting = null; await saveUser(env, chatId, user);
            if (user.apiKey) return autoModels(env, token, chatId, msgId, user);
            await send(token, chatId, '✅ Base URL saved. Now tap <b>🔑 Set API Key</b>.', msgId, MENU);
            return;
        }
        if (user.awaiting === 'apiKey') {
            user.apiKey = v; user.awaiting = null; await saveUser(env, chatId, user);
            if (user.baseUrl) return autoModels(env, token, chatId, msgId, user);
            await send(token, chatId, '✅ API key saved. Now tap <b>🌐 Set Base URL</b>.', msgId, MENU);
            return;
        }
        if (user.awaiting === 'manualModel') {
            user.model = v; user.useDefault = false; user.awaiting = null; await saveUser(env, chatId, user);
            return testAndConfirm(env, token, chatId, msgId, user, null);
        }
    }

    const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
    switch (cmd) {
        case '/start': return send(token, chatId, `<b>🤖 AI Chat Bot</b>\nSet Base URL + API key, pick a model, then just chat.\nCurrent: ${statusLine(user)}`, msgId, MENU);
        case '/help': return help(token, chatId, msgId);
        case '/setbaseurl': user.awaiting = 'baseUrl'; await saveUser(env, chatId, user);
        return send(token, chatId, '🌐 Send your Base URL (e.g. <code>https://api.openai.com/v1</code>).', msgId);
        case '/setapikey': user.awaiting = 'apiKey'; await saveUser(env, chatId, user);
        return send(token, chatId, '🔑 Send your API key (stored in KV only).', msgId);
        case '/setmodelmanuel': user.awaiting = 'manualModel'; await saveUser(env, chatId, user);
        return send(token, chatId, '✍️ Send the exact model id (e.g. <code>gpt-4o-mini</code>). I will test it right away.', msgId);
        case '/usedefaultmodel': user.useDefault = true; user.model = null; await saveUser(env, chatId, user);
        return send(token, chatId, `☁️ Default Cloudflare model enabled (<code>${DEFAULT_CF_MODEL}</code>). Send any message to chat.`, msgId, MENU);
        case '/model': return autoModels(env, token, chatId, msgId, user);
        case '/provider': return provMenu(token, chatId, msgId, user);
        case '/openai': user.provider = 'openai'; await saveUser(env, chatId, user);
        return send(token, chatId, `🔌 Provider: <b>OpenAI</b> (/chat/completions + Bearer). ${user.baseUrl ? 'Tap 🤖 Models to list.' : 'Set Base URL + key first.'}`, msgId, MENU);
        case '/anthropic': user.provider = 'anthropic'; await saveUser(env, chatId, user);
        return send(token, chatId, `🅰️ Provider: <b>Anthropic</b> (/messages + x-api-key). ${user.baseUrl ? 'Tap 🤖 Models to list.' : 'Set Base URL + key first.'}`, msgId, MENU);
        case '/style': return styleMenu(token, chatId, msgId, user);
        case '/test': return testAndConfirm(env, token, chatId, msgId, user, null);
        default:
            if (cmd.startsWith('/')) return send(token, chatId, 'Unknown command. Tap ❓ Help.', msgId, MENU);
            return chat(env, token, chatId, msgId, user, text);
    }
}

async function onCallback(q, env, token) {
    const chatId = q.message?.chat?.id, msgId = q.message?.message_id, data = q.data || '';
    if (!chatId) return;
    const user = await loadUser(env, chatId);
    const [kind, val] = data.split(':');
    if (kind === 'cmd') {
        await answerCb(token, q.id);
        const map = { base: '/setBaseURL', key: '/setAPIkey', manual: '/setModelmanuel', def: '/useDefaultModel', help: '/help', style: '/style', test: '/test', prov: '/provider' };
        return handleUpdate({ message: { chat: { id: chatId }, message_id: msgId, text: map[val] || '/help' } }, env, token);
    }
    if (kind === 'prov') {
        user.provider = val === 'anthropic' ? 'anthropic' : 'openai'; user.useDefault = false; await saveUser(env, chatId, user);
        await answerCb(token, q.id, provTag(user));
        return send(token, chatId, `${provTag(user)} selected. Base URL + key ${user.baseUrl && user.apiKey ? 'kept — tap 🤖 Models to list.' : 'needed: tap 🌐/🔑 first.'}`, msgId, MENU);
    }
    if (kind === 'pg') return showModels(env, token, chatId, msgId, user, +val || 0, q.id);
    if (kind === 's') {
        const list = await loadModels(env, chatId);
        const model = list?.[+val];
        await answerCb(token, q.id, model ? 'Selected ' + model : 'Expired, reopen Models');
        if (!model) return showModels(env, token, chatId, msgId, user, 0);
        user.model = model; user.useDefault = false; await saveUser(env, chatId, user);
        return testAndConfirm(env, token, chatId, msgId, user, q.id);
    }
    if (kind === 'st') {
        if (!STYLES[val]) return answerCb(token, q.id, 'Unknown style');
        user.style = val; await saveUser(env, chatId, user);
        await answerCb(token, q.id, STYLES[val].label);
        return edit(token, chatId, msgId, `🎨 Style: <b>${STYLES[val].label}</b>. Send any message to chat.`, MENU);
    }
    await answerCb(token, q.id);
}

function statusLine(u) {
    const st = STYLES[u.style || 'normal'].label;
    const t = u.tokens || { p: 0, c: 0, t: 0 };
    const base = (u.useDefault || (!u.baseUrl && !u.apiKey && !u.model)) ? `☁️ default <code>${DEFAULT_CF_MODEL}</code>`
    : `${provTag(u)} 🌐 ${u.baseUrl ? esc(u.baseUrl) : '—'} | 🔑 ${u.apiKey ? 'set' : '—'} | 🤖 ${u.model ? `<code>${esc(u.model)}</code>` : '—'}`;
    return `${base}\n🎨 ${st} | 📩 #${u.msgs || 0} | 🎟️ <code>${t.p || 0}/${t.c || 0}/${t.t || 0}</code>`;
}

function provMenu(token, chatId, msgId, user) {
    const p = user.provider || 'openai';
    return send(token, chatId, '<b>🔌 Pick API type</b>', msgId, [
        [{ text: (p === 'openai' ? '✅ ' : '') + '🔌 OpenAI', callback_data: 'prov:openai' }, { text: (p === 'anthropic' ? '✅ ' : '') + '🅰️ Anthropic', callback_data: 'prov:anthropic' }],
                [{ text: '🏠 Menu', callback_data: 'cmd:help' }],
    ]);
}

function help(token, chatId, msgId) {
    return send(token, chatId,
                `<b>❓ Help</b>\n/start — menu\n/provider — OpenAI or Anthropic\n/setBaseURL — e.g. <code>https://api.openai.com/v1</code> or <code>https://api.anthropic.com/v1</code>\n/setAPIkey — your key\n/Model — auto-list models, tap to select (auto-tested)\n/setModelmanuel — type model id by hand (auto-tested)\n/test — re-test current model\n/style — answer style (code, student, scientist, translate, normal)\n/useDefaultModel — free Cloudflare AI\n\nAny other text = chat. Usage + counter appear under every AI reply.`, msgId, MENU);
}

function styleMenu(token, chatId, msgId, user) {
    const kb = Object.entries(STYLES).map(([k, v]) => [{ text: ((user.style || 'normal') === k ? '✅ ' : '') + v.label, callback_data: 'st:' + k }]);
    kb.push([{ text: '🏠 Menu', callback_data: 'cmd:help' }]);
    return send(token, chatId, '<b>🎨 Pick answer style</b>', msgId, kb);
}

// ---------- models + test ----------
async function autoModels(env, token, chatId, msgId, user) {
    if (!user.baseUrl || !user.apiKey)
        return send(token, chatId, '⚠️ Set <b>Base URL</b> and <b>API key</b> first.', msgId, MENU);
    await send(token, chatId, '⏳ Fetching models…', msgId);
    try {
        const r = await fetch(user.baseUrl + '/models', { headers: isAnth(user) ? anthHeaders(user) : { Authorization: 'Bearer ' + user.apiKey } });
        const body = await r.text();
        if (!r.ok) { console.error('models error:', r.status, body.slice(0, 1000)); return send(token, chatId, `⚠️ Models request failed (<b>${r.status}</b>): <code>${esc(body.slice(0, 500))}</code>`, msgId, MENU); }
        const ids = (JSON.parse(body).data || []).map(m => m.id).filter(Boolean).sort();
        if (!ids.length) return send(token, chatId, '⚠️ No models returned by API.', msgId, MENU);
        await saveModels(env, chatId, ids);
        return showModels(env, token, chatId, msgId, user, 0);
    } catch (e) { console.error('models fetch:', e?.stack || e); return send(token, chatId, `⚠️ Could not reach Base URL: <code>${esc(e.message)}</code>`, msgId, MENU); }
}

async function showModels(env, token, chatId, msgId, user, page, cbId) {
    let list = await loadModels(env, chatId);
    if (!list) { // fetch on demand (e.g. pressed Models before setting both)
        if (!user.baseUrl || !user.apiKey) { if (cbId) await answerCb(token, cbId); return send(token, chatId, '⚠️ Set Base URL + API key first.', msgId, MENU); }
        if (cbId) await answerCb(token, cbId, 'Loading…');
        return autoModels(env, token, chatId, msgId, user);
    }
    if (cbId) await answerCb(token, cbId);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page), pages - 1);
    const slice = list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    const kb = slice.map((m, i) => [{ text: (user.model === m ? '✅ ' : '') + String(m).slice(0, 40), callback_data: 's:' + (page * PAGE_SIZE + i) }]);
    kb.push([{ text: '◀️', callback_data: 'pg:' + ((page - 1 + pages) % pages) }, { text: `${page + 1}/${pages}`, callback_data: 'pg:' + page }, { text: '▶️', callback_data: 'pg:' + ((page + 1) % pages) }]);
    kb.push([{ text: '🏠 Menu', callback_data: 'cmd:help' }]);
    const html = `<b>🤖 Pick a model</b> (${list.length}) — page ${page + 1}/${pages}\nTap to select (auto-tested).`;
    try { await edit(token, chatId, msgId, html, kb); }
    catch { await send(token, chatId, html, msgId, kb); }
}

// Minimal live test: tiny chat/completions call so user knows key+model work
async function testModel(env, user) {
    const testPrompt = 'Say OK';
    if (user.useDefault || (!user.baseUrl && !user.apiKey)) {
        if (!env.AI) return { ok: false, detail: 'no AI binding', usage: null, prompt: testPrompt, reply: '' };
        try {
            const r = await env.AI.run(DEFAULT_CF_MODEL, { messages: [{ role: 'user', content: testPrompt }] });
            const reply = typeof r?.response === 'string' ? r.response : '';
            return { ok: true, detail: 'default CF model answers', usage: normalizeUsage(r?.usage), prompt: testPrompt, reply };
        }
        catch (e) { console.error('default test:', e.message); return { ok: false, detail: e.message.slice(0, 200), usage: null, prompt: testPrompt, reply: '' }; }
    }
    if (!user.baseUrl || !user.apiKey || !user.model) return { ok: false, detail: 'incomplete setup', usage: null, prompt: testPrompt, reply: '' };
    try {
        const r = isAnth(user)
        ? await fetch(user.baseUrl + '/messages', { method: 'POST', headers: anthHeaders(user),
            body: JSON.stringify({ model: user.model, max_tokens: 10, messages: [{ role: 'user', content: testPrompt }] }) })
        : await fetch(user.baseUrl + '/chat/completions', {
            method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + user.apiKey },
            body: JSON.stringify({ model: user.model, messages: [{ role: 'user', content: testPrompt }], max_tokens: 5 }),
        });
        const t = await r.text();
        if (!r.ok) { console.error('model test:', r.status, t.slice(0, 500)); return { ok: false, detail: `HTTP ${r.status}: ${t.slice(0, 200)}`, usage: null, prompt: testPrompt, reply: '' }; }
        let usage = null, reply = 'model answers';
        try {
            const j = JSON.parse(t);
            reply = isAnth(user) ? (anthText(j) || reply) : (j.choices?.[0]?.message?.content || reply);
            usage = isAnth(user) ? anthUsage(j) : (j.usage || null);
        } catch {}
        return { ok: true, detail: 'model answers', usage, prompt: testPrompt, reply };
    } catch (e) { console.error('model test fetch:', e.message); return { ok: false, detail: e.message.slice(0, 200), usage: null, prompt: testPrompt, reply: '' }; }
}

async function testAndConfirm(env, token, chatId, msgId, user, cbId) {
    if (cbId) await answerCb(token, cbId, 'Testing…');
    const name = user.useDefault ? DEFAULT_CF_MODEL : user.model;
    if (!name) return send(token, chatId, '⚠️ No model selected yet. Use 🤖 Models first.', msgId, MENU);
    await send(token, chatId, `🧪 Testing <code>${esc(name)}</code>…`, msgId);
    const t = await testModel(env, user);
    console.log('model test:', name, t.ok, t.detail);
    const footer = t.ok ? formatUsageFooter(t.usage, t.prompt, t.reply, null) : '';
    return send(token, chatId,
                t.ok ? `✅ <b>Working!</b> <code>${esc(name)}</code> — ${esc(t.detail)}\nSend any message to chat.${footer}` : `❌ <b>Failed:</b> <code>${esc(name)}</code>\n<code>${esc(t.detail)}</code>\nCheck Base URL / key / model.`,
                msgId, MENU);
}

// ---------- chat ----------
async function chat(env, token, chatId, msgId, user, text) {
    await tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const think = await tg(token, 'sendMessage', { chat_id: chatId, text: '⏳ Thinking…', reply_to_message_id: msgId });
    const thinkId = think?.result?.message_id;
    let settled = false; let watchdog;
    const done = async (html, kb) => { // ponytail: edit placeholder in place so it's never stuck; fallback to delete+send
        if (settled) return; settled = true; clearTimeout(watchdog);
        try {
            const full = html + '';
            if (thinkId && full.length <= 4000) {
                const r = await tg(token, 'editMessageText', { chat_id: chatId, message_id: thinkId, text: full.slice(0, 4000) || '…', parse_mode: 'HTML', reply_markup: kb ? { inline_keyboard: kb } : undefined });
                if (r?.ok) return r;
            }
        } catch {}
        if (thinkId) await tg(token, 'deleteMessage', { chat_id: chatId, message_id: thinkId }).catch(() => {});
        return send(token, chatId, html, msgId, kb);
    };
    // ponytail: watchdog — AI API hanging => tell user it's not working instead of stuck Thinking…
    watchdog = setTimeout(() => done(`❌ AI API is not working right now (no answer in 55s).\nTry again or /test another model.`, MENU), 55000);
    const hist = [...(user.hist || []), { role: 'user', content: text }].slice(-MAX_HIST);
    const styleSys = STYLES[user.style || 'normal'].sys;
    const reqMsgs = styleSys ? [{ role: 'system', content: styleSys }, ...hist] : hist;
    try {
        let reply, usage = null, modelName = user.model || DEFAULT_CF_MODEL;
        if (user.useDefault || (!user.baseUrl && !user.apiKey && !user.model)) {
            if (!env.AI) return done('⚠️ No Base URL/key set and no <b>AI</b> binding. Bind Workers AI as <code>AI</code> or tap 🌐/🔑 to set your API.', MENU);
            const r = await env.AI.run(DEFAULT_CF_MODEL, { messages: reqMsgs });
            reply = typeof r?.response === 'string' ? r.response : JSON.stringify(r);
            usage = r?.usage || null; modelName = DEFAULT_CF_MODEL;
        } else {
            if (!user.baseUrl || !user.apiKey || !user.model)
                return done(`⚠️ Incomplete setup: ${statusLine(user)}\nUse /Model to pick one or /useDefaultModel.`, MENU);
            const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 50000);
            let r;
            try {
                r = isAnth(user)
                ? await fetch(user.baseUrl + '/messages', { method: 'POST', headers: anthHeaders(user),
                    body: JSON.stringify({ model: user.model, max_tokens: 1024, ...toAnthropic(reqMsgs) }), signal: ctl.signal })
                : await fetch(user.baseUrl + '/chat/completions', {
                    method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + user.apiKey },
                    body: JSON.stringify({ model: user.model, messages: reqMsgs }), signal: ctl.signal,
                });
            } catch (e) { clearTimeout(to); console.error('chat fetch:', e.message); return done(`⚠️ Model timeout / unreachable after 50s: <code>${esc(e.message)}</code>\nTry again or /test another model.`, MENU); }
            clearTimeout(to);
            const body = await r.text();
            if (!r.ok) { console.error('chat error:', r.status, body.slice(0, 1000)); return done(`⚠️ API Error (<b>${r.status}</b>): <code>${esc(body.slice(0, 800))}</code>`, MENU); }
            let j; try { j = JSON.parse(body); } catch { return done('⚠️ API returned non-JSON.', MENU); }
            if (j.error) { console.error('api error obj:', JSON.stringify(j.error).slice(0, 500)); return done(`⚠️ API Error: <code>${esc(j.error.message || JSON.stringify(j.error))}</code>`, MENU); }
            if (isAnth(user)) { reply = anthText(j) || '⚠️ Empty reply from model.'; usage = anthUsage(j); }
            else { reply = j.choices?.[0]?.message?.content || '⚠️ Empty reply from model.'; usage = j.usage || null; }
        }
        // Counters: per-user message # + cumulative tokens (footer style matches worker_n.js)
        user.msgs = (user.msgs || 0) + 1;
        const nu = normalizeUsage(usage);
        const hasUsage = nu && ((nu.prompt_tokens || 0) !== 0 || (nu.completion_tokens || 0) !== 0 || (nu.total_tokens || 0) !== 0);
        const eu = hasUsage ? nu : null;
        const p = eu?.prompt_tokens ?? estimateTokens(text);
        const c = eu?.completion_tokens ?? estimateTokens(reply);
        const t = eu?.total_tokens ?? (p + c);
        const prev = user.tokens || { p: 0, c: 0, t: 0 };
        user.tokens = { p: prev.p + p, c: prev.c + c, t: prev.t + t };
        user.hist = [...hist, { role: 'assistant', content: reply }].slice(-MAX_HIST);
        try { await withTimeout(saveUser(env, chatId, user), 5000); } catch (e) { console.error('saveUser slow, reply anyway:', e.message); }
        const tokenFooter = formatUsageFooter(eu, text, reply, null);
        const footer = `\n\n<i>────────</i>\n<i>📩 #${user.msgs} • 🤖 <code>${esc(modelName)}</code></i>${tokenFooter}\n📊 <code>Σ total ↑ ${user.tokens.p} sent • ↓ ${user.tokens.c} received • Σ ${user.tokens.t} total</code>`;
        console.log('chat ok:', modelName, `tok=${p}/${c}/${t}`, `msg#${user.msgs}`);
        clearTimeout(watchdog); await done(mdToHtml(reply) + footer);
    } catch (e) { console.error('chat fatal:', e?.stack || e); clearTimeout(watchdog); await done(`❌ AI API is not working: <code>${esc(e.message)}</code>`, MENU); }
}
