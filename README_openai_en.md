
# Telegram AI Bot — Cloudflare Worker (OpenAI / Anthropic / Workers AI)

Single-file Cloudflare Worker (`worker_openai.js:1`) that turns any Telegram bot into a ChatGPT/Claude chat bot. No `wrangler`, no build step — paste in Dashboard and go.

## What it can do

- **Chat** — any text message = AI reply. Keeps last 20 messages per user (`MAX_HIST=20` at `worker_openai.js:16`).
- **Two providers** — OpenAI (`/chat/completions` + Bearer) and Anthropic (`/messages` + `x-api-key`). Switch via `/provider` or inline buttons `🔌 OpenAI` / `🅰️ Anthropic` (`worker_openai.js:28`).
- **BYOK or free** — use your own Base URL + API key, or `☁️ Use Default Model` (`@cf/meta/llama-3.1-8b-instruct`, `worker_openai.js:14`) via Workers AI binding `AI`.
- **Model picker** — `/Model` fetches `GET {baseUrl}/models`, paginated 8 per page (`PAGE_SIZE=8`), cached 10 min in KV (`worker_openai.js:152`). Tap to select + auto-test.
- **Manual model** — `/setModelmanuel` for custom/proxy model IDs.
- **Live test** — `🧪 Test Model` / `/test` sends a tiny `Say OK` request to verify key + model (`worker_openai.js:372`).
- **5 answer styles** — `normal` / `code` / `student` / `sci` / `trans` injected as system prompt (`worker_openai.js:18`). Switch via `/style`.
- **Token & msg counters** — per-user `msgs` + cumulative `p/c/t` tokens shown under every reply and in `statusLine()` (`worker_openai.js:309`).
- **Markdown → HTML** — code blocks, bold, italic, links converted for Telegram (`mdToHtml()` at `worker_openai.js:205`), split safely at 4096 chars (`splitHtml()` at `worker_openai.js:187`).
- **Security** — random `secret_token` on webhook (`worker_openai.js:101`), `X-Telegram-Bot-API-Secret-Token` verification (`worker_openai.js:59`), `ACTIVATE_SECRET` optional gate, 30s activation throttle, `update_id` dedupe (memory+KV) to prevent double `Thinking…`.

All UI is **inline keyboards only** — no reply keyboard ever (`worker_openai.js:12`, `MENU` at `worker_openai.js:26`).

## Setup (Dashboard, no wrangler)

### 1. Create the Worker
1. Cloudflare Dashboard → **Workers & Pages** → **Create Worker** → **Deploy**.
2. Click **Edit code** → delete default code → paste entire `worker_openai.js` → **Save & Deploy**.

### 2. Create & Bind KV

KV is the only storage. Every user (`user:{chatId}`), model list (`models:{chatId}`), webhook secret (`tg_secret`), etc. lives there.

1. Dashboard → **Storage & databases** → **KV** → **Create namespace** → name it e.g. `USER_SETTINGS`.
2. Back to your Worker → **Settings** → **Bindings** → **Add binding** → **KV namespace** →
   - Variable name: `USER_SETTINGS` (must match exactly, `worker_openai.js:135`)
   - KV namespace: select the one you just created → **Add**.
3. **Deploy** again (bindings need a new deployment).

> No KV binding = bot still runs but nothing persists (falls back to in-memory `mem` at `worker_openai.js:134`, lost on isolate restart).

### 3. Set Secrets / Variables

Worker → **Settings** → **Variables**:

| Name | Type | Required | Value |
|------|------|----------|-------|
| `TELEGRAM_TOKEN` | Secret | **Yes** | Bot token from [@BotFather](https://t.me/BotFather) (`/newbot`). Can also be a KV namespace containing key `TOKEN` (`worker_openai.js:125`). |
| `ACTIVATE_SECRET` | Variable/Secret | No | If set, `/activate?secret=VALUE` must match (`worker_openai.js:87`). Protects activation from strangers. |
| `AI` | Workers AI binding | No | **Settings → Bindings → Add → Workers AI** → variable `AI`. Enables free default model when user hasn't set Base URL/key (`worker_openai.js:7`). |

After adding secrets → **Deploy**.

### 4. Activate (set webhook)

Open in browser:

```
https://<your-worker>.workers.dev/activate
```

If `ACTIVATE_SECRET` is set:

```
https://<your-worker>.workers.dev/activate?secret=YOUR_SECRET
```

You should see `✅ Bot activated for https://...`. This calls `setWebhook` + `setMyCommands` (`worker_openai.js:103`).

- Webhook URL: `https://<worker>/` with `secret_token` + `allowed_updates: [message, callback_query]`.
- If you see `Wait 30s between activations` → throttled (`worker_openai.js:96`), wait and retry.
- Verify in Telegram: open bot → `/start` should show the menu.

> Re-run `/activate` if you redeploy or change `TELEGRAM_TOKEN`.

## Usage

### Commands

| Command | What it does |
|---------|--------------|
| `/start` | Menu + current status (`statusLine()` at `worker_openai.js:309`) |
| `/help` | Help text (`worker_openai.js:325`) |
| `/provider` | Switch OpenAI ↔ Anthropic |
| `/setBaseURL` | Set Base URL e.g. `https://api.openai.com/v1` or `https://api.anthropic.com/v1` (trailing `/chat/completions` stripped, `worker_openai.js:232`) |
| `/setAPIkey` | Set API key (stored in KV only, per user `user:{id}.apiKey`) |
| `/Model` | Auto-list models from API, paginated |
| `/setModelmanuel` | Type model ID manually (e.g. `gpt-4o-mini`, `claude-3-5-sonnet-20241022`) |
| `/useDefaultModel` | Use free Cloudflare model, clears custom model |
| `/style` | Pick answer style |
| `/test` | Live-test current model |

Inline menu (`MENU` at `worker_openai.js:26`) mirrors these: `🌐 Set Base URL`, `🔑 Set API Key`, `🔌/🅰️ Provider`, `🤖 Models`, `✍️ Set Model manual`, `☁️ Use Default`, `🧪 Test`, `🎨 Style`, `❓ Help`.

### Typical flow

1. `/start` → tap **🌐 Set Base URL** → send `https://api.openai.com/v1`
2. Tap **🔑 Set API Key** → send `sk-...` (or `sk-ant-...` for Anthropic)
3. Pick provider if needed (`/provider`)
4. Tap **🤖 Models** → wait `Fetching models…` → pick one → auto-tested (`✅ Working!` or `❌ Failed` with HTTP detail)
5. Just chat — any message goes to `chat()` at `worker_openai.js:406`.

For proxies / compatible APIs (OpenRouter, Groq, etc.) just set their OpenAI-compatible Base URL.

### What is stored in KV

| Key | TTL | Content |
|-----|-----|---------|
| `user:{chatId}` | forever | `{ baseUrl, apiKey, model, provider, style, awaiting, hist[20], msgs, tokens{p,c,t} }` (`loadUser` at `worker_openai.js:138`) |
| `models:{chatId}` | 600s | `string[]` model IDs (`worker_openai.js:152`) |
| `tg_secret` | forever | webhook secret_token |
| `act_ts` | forever | last activation unix ms (throttle) |
| `upd:{update_id}` | 300s | dedupe Telegram retries |

Inspect via Dashboard → KV → `USER_SETTINGS` → browse keys. Delete `user:{id}` to reset a user.

## Troubleshooting

- `Missing TELEGRAM_TOKEN` → secret not set or wrong name (must be `TELEGRAM_TOKEN`, case-sensitive).
- `Forbidden` on webhook → `tg_secret` mismatch, re-run `/activate`.
- `AI API is not working (no answer in 55s)` → provider timeout, watchdog at `worker_openai.js:424`, try `/test` or another model.
- `Failed: HTTP 401/403` → wrong API key or Base URL.
- `Failed: HTTP 404` → wrong model id.
- Double `Thinking…` → fixed by `waitUntil` + `update_id` dedupe (`worker_openai.js:65`), ensure Worker not erroring before `return new Response('OK')`.

## Cost

- Cloudflare Workers free tier + KV free tier is enough for small bots. Workers AI has its own free quota. External API keys are billed by OpenAI/Anthropic.

## File

- `worker_openai.js` — the only file. 468 lines. No dependencies.
