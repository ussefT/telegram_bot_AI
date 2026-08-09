# Telegram Bot on Cloudflare Workers — Complete Setup Guide

> **No wrangler, no Node.js, no CLI required.** This bot is deployed entirely through the Cloudflare Dashboard (your browser). Just copy-paste the worker code, create two KV namespaces, grab a Telegram bot token, and you're live.

`worker_cloud.js` runs a full-featured Telegram bot powered by **Workers AI** (Cloudflare's built-in AI platform — free daily quota, no external API key needed). It supports three modes:

| Mode | Command | What it does |
|------|---------|--------------|
| 💬 **Chat** | `/chat` | Conversational AI assistant with memory (per-user chat history) |
| 🎨 **Image** | `/image` | Generate images from text prompts (Flux) |
| 🎙️ **Transcribe** | `/transcribe` | Speech-to-text for voice / audio messages (Whisper) |

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Install — Prepare the Worker Code](#2-install--prepare-the-worker-code)
3. [Get a Telegram Bot Token](#3-get-a-telegram-bot-token)
4. [Create the Worker & Deploy the Code](#4-create-the-worker--deploy-the-code)
5. [Add KV Namespaces (Storage)](#5-add-kv-namespaces-storage)
6. [Configure Variables & Bindings](#6-configure-variables--bindings)
7. [Register the Webhook](#7-register-the-webhook)
8. [Use the Bot](#8-use-the-bot)
9. [Troubleshooting](#9-troubleshooting)
10. [FAQ](#10-faq)

---

## 1. Prerequisites

You only need two things:

- **A Cloudflare account** (free tier is enough) — sign up at [dash.cloudflare.com](https://dash.cloudflare.com).
- **A Telegram account** — to create the bot via [@BotFather](https://t.me/BotFather).

> The Cloudflare free plan includes a generous daily allocation of Workers AI neurons and free KV reads/writes, so **you don't need a credit card** to run this bot.

---

## 2. Install — Prepare the Worker Code

There is nothing to install locally. The entire "installation" is:

1. Locate the file **`worker_cloud.js`** in this repository/folder.
2. Open it in any text editor.
3. Select **all** of its contents and copy them (`Ctrl+A` → `Ctrl+C` / `Cmd+A` → `Cmd+C`).

You'll paste this code into the Cloudflare dashboard in **Step 4**. The file needs no edits before deployment — all configuration (bot token, KV namespaces, AI binding) is done in the dashboard, not in the code.

---

## 3. Get a Telegram Bot Token

1. Open Telegram and start a chat with **[@BotFather](https://t.me/BotFather)** (the official bot for creating bots).
2. Send the command:
   ```
   /newbot
   ```
3. BotFather will ask for a **display name** (shown in chats, e.g. `My Cloud AI`).
4. Then it will ask for a **username** — this must end in `bot` and be globally unique, e.g. `my_cloud_ai_bot`.
5. On success, BotFather replies with a message containing:
   ```
   Use this token to access the HTTP API:
   1234567890:AAHflkaPz2q...your_token_here
   ```
6. **Copy and store this token securely.** It looks like `123456789:AAxxxxxxx...`. Treat it like a password — anyone who has it can control your bot.

> 💡 Optional but recommended: send `/setdescription` and `/setabouttext` to BotFather to customize your bot's profile.

---

## 4. Create the Worker & Deploy the Code

1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com) and log in.
2. From the left sidebar, open **Workers & Pages**.
3. Click **Create application** → choose **Create Worker**.
4. Give your worker a name, e.g. `telegram-ai-bot`, and click **Deploy**.
5. The dashboard opens the **Quick Edit** code editor with default boilerplate.
6. **Delete all the default code** and paste the entire contents of `worker_cloud.js` in its place.
7. Click **Save and Deploy** (top-right).

> 📌 Note the worker's URL shown in the dashboard — it looks like `https://telegram-ai-bot.<your-subdomain>.workers.dev`. You'll need it for the webhook in Step 7.

> ⚠️ At this point the code is deployed, but the bot **won't work yet** — it still needs the KV namespaces (Step 5) and the `BOT_TOKEN` + `AI` bindings (Step 6). If you visit the worker URL you should see a plain-text status page, which confirms deployment succeeded.

---

## 5. Add KV Namespaces (Storage)

The bot needs **two KV namespaces** to remember per-user settings and chat history:

| Namespace | Purpose |
|-----------|---------|
| `KV_MODES` | Stores each user's current mode (chat/image/transcribe) and chosen chat model |
| `KV_CHATS` | Stores each user's recent chat history (for AI context) |

### Create the namespaces

1. In the **Workers & Pages** section, click **KV** in the left sidebar.
2. Click **Create a namespace**.
3. Give it the name `KV_MODES` and click **Add**.
4. Repeat to create a second namespace named `KV_CHATS`.

> The namespace **name** is just for you to recognize it in your account. What matters is the **variable name** you bind it to in Step 6 — that must be exactly `KV_MODES` and `KV_CHATS`, because the worker code references `env.KV_MODES` and `env.KV_CHATS`.

---

## 6. Configure Variables & Bindings

Now wire everything up so the worker code can access the bot token, the AI platform, and the KV stores.

1. Open your worker (the one you created in Step 4).
2. Go to **Settings** → **Variables and Bindings**.
3. Add each of the following:

### 6a. BOT_TOKEN (secret variable)

1. Click **Add** under **Variables** → choose **Add secret**.
2. **Variable name:** `BOT_TOKEN`
3. **Value:** paste the token from Step 3.
4. Click **Encrypt** / **Deploy**.

> Use a **secret** (not a plain variable) so the token never appears in plain text. The code reads it as `env.BOT_TOKEN`.

### 6b. AI binding (Workers AI)

1. Under **Bindings**, click **Add** → **Workers AI**.
2. **Variable name:** `AI`
3. For the resource, either **attach to an existing resource** (create/use a Workers AI gateway) or select the option to create a new one — the exact label varies by dashboard version; just make sure the variable name is exactly `AI`.
4. Save.

> The code calls `env.AI.run(...)`, so this binding **must** be named `AI`. Workers AI runs on your free daily neuron allocation — no API key is required.

### 6c. KV bindings (two)

1. Under **Bindings**, click **Add** → **KV namespace**.
2. **Variable name:** `KV_MODES`
3. **KV namespace:** select the `KV_MODES` namespace you created.
4. Repeat:
   - **Variable name:** `KV_CHATS` → **KV namespace:** `KV_CHATS`

5. Click **Deploy** / **Save and Deploy** to apply everything.

### Summary table

| Type | Variable name | Value / Resource |
|------|---------------|------------------|
| Secret | `BOT_TOKEN` | Your `123456789:AA...` token |
| Workers AI binding | `AI` | Workers AI (attached resource) |
| KV binding | `KV_MODES` | The `KV_MODES` namespace |
| KV binding | `KV_CHATS` | The `KV_CHATS` namespace |

---

## 7. Register the Webhook

The bot now needs to tell Telegram *where* to deliver updates.

### Get your worker URL

It looks like:
```
https://telegram-ai-bot.<your-subdomain>.workers.dev
```
(You can also open your worker and click **Visit** / the `*.workers.dev` link at the top.)

### Register the webhook

Run this in any terminal (replace `<BOT_TOKEN>` and `<WORKER_URL>` with your values). **Windows users:** use PowerShell or the command prompt; `curl` is built into modern Windows and macOS/Linux.

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>/"
```

Example:

```bash
curl -X POST "https://api.telegram.org/bot1234567890:AAHflkaPz2q.../setWebhook?url=https://telegram-ai-bot.your-subdomain.workers.dev/"
```

**Note the trailing `/` on the worker URL** — the worker's webhook handler lives at the root path.

### Verify the webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

A successful response contains `"ok": true` and an entry like:

```json
{
  "ok": true,
  "result": {
    "url": "https://telegram-ai-bot.your-subdomain.workers.dev/",
    "pending_update_count": 0
  }
}
```

> ✅ Once you see `pending_update_count` and no errors, the bot is **live**. Open your bot in Telegram and send `/start`.

---

## 8. Use the Bot

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message + opens the quick-menu buttons |
| `/menu` | Open the quick action buttons |
| `/chat` | Switch to **chat** mode |
| `/image` | Switch to **image generation** mode |
| `/transcribe` | Switch to **audio transcription** mode |
| `/model <name>` | Switch the AI chat model (or use the button menu) |
| `/new` | Clear your chat history and start fresh |
| `/help` | Show help, all commands, and available models |

You can also open the **⌨️ menu button** beside the message input box for buttons, or type `/` to see the command list.

### Chat mode (💬)
Just send a text message and the AI replies. The bot keeps a rolling conversation history (last 16 messages) per user for context. Use `/new` to start a fresh conversation.

### Image mode (🎨)
Switch with `/image`, then describe what you want:
```
a futuristic city at sunset, cyberpunk style
```
The bot replies with a generated image.

### Transcribe mode (🎙️)
Switch with `/transcribe`, then send a **voice note** or **audio file** (up to 20 MB). The bot converts it to text.

### Switching chat models
Use `/model` (no argument) to open the model picker, or `/model <name>` directly:
```
/model @cf/google/gemma-4-26b-a4b-it
```
Available models:

```
@cf/openai/gpt-oss-120b
@cf/openai/gpt-oss-20b
@cf/zai-org/glm-5.2
@cf/google/gemma-4-26b-a4b-it
@cf/nvidia/nemotron-3-120b-a12b
```

---

## 9. Troubleshooting

| Symptom | Likely cause & fix |
|---------|--------------------|
| Bot never replies to `/start` | Webhook not registered — run `setWebhook` again (Step 7) and check `getWebhookInfo`. |
| `getWebhookInfo` shows `"ok": false` or error | Wrong token, or `url` missing the trailing `/`. Double-check both. |
| Bot replies "internal error" | Binding not configured. Go to Settings → Variables and Bindings and confirm `BOT_TOKEN`, `AI`, `KV_MODES`, `KV_CHATS` all exist with exact names. |
| Image generation fails | Free-tier AI limit reached (wait until the next day) or the prompt tripped a content filter — simplify the description. |
| "File is larger than 20MB" | Telegram's file download limit — send a shorter voice note / smaller audio. |
| Changed code but nothing works | After editing code, click **Save and Deploy** again. Then re-register the webhook (some edits change the worker URL if you rename it). |
| Can't find KV in the dashboard | KV lives under **Workers & Pages → KV** (sidebar). If your account uses the newer dashboard, look for **Workers & Pages → KV Namespaces**. |

### Useful debugging URL

Visiting your worker URL in a browser shows a status page with the exact webhook commands:
```
https://telegram-ai-bot.<your-subdomain>.workers.dev/
```

---

## 10. FAQ

**Do I need wrangler or Node.js?**
No. Everything in this guide is done in the Cloudflare Dashboard and your browser's terminal. No local packages, no `npm install`, no `wrangler deploy`.

**Do I need an OpenAI / Anthropic API key?**
No. All AI runs through **Workers AI**, which is bundled into the Cloudflare account (free daily neuron quota).

**Is there a monthly cost?**
The Cloudflare free plan covers this bot: Workers AI free daily allocation + free KV reads/writes + free worker requests. Heavy usage could exceed free quotas — check the Cloudflare pricing dashboard for exact limits.

**Can I update the code later?**
Yes. Open the worker → **Edit code** → paste the new version → **Save and Deploy**. If you only change the code (not the name), the URL stays the same and the webhook keeps working.

**Where is user data stored?**
In the two KV namespaces (`KV_MODES`, `KV_CHATS`) you created. Deleting the namespaces resets all user modes and histories.

**The bot answers in the wrong style / language?**
The default system prompt is fixed, but it's a normal Workers AI chat — simply ask it to respond in a specific language or style, or use `/new` to reset context.

---

*Built on Cloudflare Workers AI, Workers KV, and the Telegram Bot API. No wrangler required.*
