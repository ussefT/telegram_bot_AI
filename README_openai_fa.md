# ربات تلگرام هوش مصنوعی — کلادفلر ورکر (OpenAI / Anthropic / Workers AI)

یک فایل تنها (`worker_openai.js:1`) که هر ربات تلگرام را به ربات چت هوش مصنوعی تبدیل می‌کند. بدون `wrangler` و بدون بیلد — فقط کد را در داشبورد کلادفلر پیست کنید.

## ربات چه کارهایی می‌کند

- **چت مستقیم** — هر پیام متنی = پاسخ هوش مصنوعی. تاریخچه ۲۰ پیام آخر برای هر کاربر نگه‌داری می‌شود (`MAX_HIST=20` در `worker_openai.js:16`).
- **دو ارائه‌دهنده** — OpenAI (`/chat/completions` + Bearer) و Anthropic (`/messages` + `x-api-key`). تغییر با `/provider` یا دکمه‌های `🔌 OpenAI` / `🅰️ Anthropic` (`worker_openai.js:28`).
- **کلید شخصی یا رایگان** — آدرس Base URL و کلید API خودتان را وارد کنید، یا با `☁️ Use Default Model` از مدل رایگان کلادفلر (`@cf/meta/llama-3.1-8b-instruct` در `worker_openai.js:14`) با بایندینگ `AI` استفاده کنید.
- **لیست مدل‌ها** — دستور `/Model` با `GET {baseUrl}/models` لیست مدل‌ها را می‌گیرد، صفحه‌بندی ۸ تایی (`PAGE_SIZE=8`)، کش ۱۰ دقیقه در KV (`worker_openai.js:152`). با تپ کردن انتخاب + تست خودکار.
- **مدل دستی** — `/setModelmanuel` برای وارد کردن دستی نام مدل (مثلاً برای پراکسی‌ها).
- **تست زنده** — `🧪 Test Model` / `/test` یک درخواست کوچک `Say OK` می‌فرستد تا سالم بودن کلید و مدل را تأیید کند (`worker_openai.js:372`).
- **۵ سبک پاسخ** — `normal` (معمولی) / `code` (برنامه‌نویسی) / `student` (دانش‌آموزی) / `sci` (علمی) / `trans` (ترجمه) که به عنوان system prompt تزریق می‌شوند (`worker_openai.js:18`). تغییر با `/style`.
- **شمارنده توکن و پیام** — تعداد پیام‌ها `msgs` و توکن‌های تجمعی `p/c/t` زیر هر پاسخ و در `statusLine()` نمایش داده می‌شود (`worker_openai.js:309`).
- **تبدیل Markdown به HTML** — کد، بولد، ایتالیک و لینک برای تلگرام تبدیل می‌شود (`mdToHtml()` در `worker_openai.js:205`) و پیام‌های بلند با امنیت ۴۰۹۶ کاراکتر تکه‌تکه می‌شوند (`splitHtml()` در `worker_openai.js:187`).
- **امنیت** — `secret_token` تصادفی روی وبهوک (`worker_openai.js:101`)، تأیید هدر `X-Telegram-Bot-API-Secret-Token` (`worker_openai.js:59`)، `ACTIVATE_SECRET` اختیاری، محدودیت ۳۰ ثانیه بین فعال‌سازی‌ها، و جلوگیری از تکرار `update_id` (حافظه + KV).

تمام رابط کاربری فقط با **دکمه‌های inline** است — هیچ کیبورد معمولی ساخته نمی‌شود (`worker_openai.js:12`، `MENU` در `worker_openai.js:26`).

## راه‌اندازی قدم‌به‌قدم (بدون wrangler، فقط داشبورد)

### ۱. ساخت ورکر

۱. وارد [داشبورد کلادفلر](https://dash.cloudflare.com) شوید → **Workers & Pages** → **Create Worker** → **Deploy**.
۲. روی **Edit code** بزنید → کد پیش‌فرض را پاک کنید → کل محتوای `worker_openai.js` را پیست کنید → **Save & Deploy**.

### ۲. ساخت و اتصال KV

KV تنها محل ذخیره است. اطلاعات هر کاربر (`user:{chatId}`)، لیست مدل‌ها (`models:{chatId}`)، رمز وبهوک (`tg_secret`) و ... همه آنجاست.

۱. داشبورد → **Storage & databases** → **KV** → **Create namespace** → مثلاً نام `USER_SETTINGS` بگذارید.
۲. برگردید به ورکر → **Settings** → **Bindings** → **Add binding** → **KV namespace** →
   - نام متغیر (Variable name): دقیقاً `USER_SETTINGS` باشد (`worker_openai.js:135`)
   - نام KV: همان که ساختید را انتخاب کنید → **Add**.
۳. دوباره **Deploy** کنید (بایندینگ بدون دیپلوی جدید اعمال نمی‌شود).

> اگر KV وصل نباشد ربات اجرا می‌شود ولی چیزی ذخیره نمی‌ماند (به حافظه موقت `mem` در `worker_openai.js:134` می‌افتد و با ریستارت از بین می‌رود).

### ۳. تنظیم توکن و متغیرها

در ورکر → **Settings** → **Variables**:

| نام | نوع | ضروری؟ | مقدار |
|-----|-----|--------|-------|
| `TELEGRAM_TOKEN` | Secret | **بله** | توکن ربات از [@BotFather](https://t.me/BotFather) با `/newbot`. می‌تواند یک KV با کلید `TOKEN` هم باشد (`worker_openai.js:125`). |
| `ACTIVATE_SECRET` | Variable/Secret | خیر | اگر تنظیم شود، آدرس `/activate?secret=VALUE` باید برابر آن باشد (`worker_openai.js:87`). برای جلوگیری از فعال‌سازی توسط دیگران. |
| `AI` | Workers AI binding | خیر | **Settings → Bindings → Add → Workers AI** → نام `AI`. مدل رایگان پیش‌فرض را فعال می‌کند وقتی کاربر Base URL/کلید ندارد (`worker_openai.js:7`). |

بعد از افزودن → **Deploy**.

### ۴. فعال‌سازی (ست کردن وبهوک)

در مرورگر باز کنید:

```
https://<your-worker>.workers.dev/activate
```

اگر `ACTIVATE_SECRET` گذاشتید:

```
https://<your-worker>.workers.dev/activate?secret=YOUR_SECRET
```

پیام `✅ Bot activated for https://...` را باید ببینید. این مرحله `setWebhook` و `setMyCommands` را صدا می‌زند (`worker_openai.js:103`).

- آدرس وبهوک: `https://<worker>/` همراه `secret_token` و `allowed_updates: [message, callback_query]`.
- اگر `Wait 30s between activations` دیدید → محدودیت ۳۰ ثانیه‌ای (`worker_openai.js:96`)، کمی صبر کنید.
- در تلگرام ربات را باز کنید → `/start` باید منو را نشان دهد.

> هر بار که ورکر را دوباره دیپلوی کردید یا `TELEGRAM_TOKEN` را عوض کردید، دوباره `/activate` را باز کنید.

## طرز استفاده

### دستورات

| دستور | کاربرد |
|-------|--------|
| `/start` | منو + وضعیت فعلی (`statusLine()` در `worker_openai.js:309`) |
| `/help` | راهنما (`worker_openai.js:325`) |
| `/provider` | تغییر OpenAI ↔ Anthropic |
| `/setBaseURL` | تنظیم Base URL مثلاً `https://api.openai.com/v1` یا `https://api.anthropic.com/v1` (اضافه‌ی `/chat/completions` خودکار حذف می‌شود، `worker_openai.js:232`) |
| `/setAPIkey` | تنظیم کلید API (فقط در KV هر کاربر `user:{id}.apiKey` ذخیره می‌شود) |
| `/Model` | لیست خودکار مدل‌ها، صفحه‌بندی شده |
| `/setModelmanuel` | وارد کردن دستی نام مدل مثلاً `gpt-4o-mini` یا `claude-3-5-sonnet-20241022` |
| `/useDefaultModel` | استفاده از مدل رایگان کلادفلر |
| `/style` | انتخاب سبک پاسخ |
| `/test` | تست زنده مدل فعلی |

منوی inline (`MENU` در `worker_openai.js:26`) همین دستورات را دارد: `🌐 Set Base URL`، `🔑 Set API Key`، `🔌/🅰️ Provider`، `🤖 Models`، `✍️ Set Model manual`، `☁️ Use Default`، `🧪 Test`، `🎨 Style`، `❓ Help`.

### جریان معمول

۱. `/start` → دکمه **🌐 Set Base URL** → ارسال `https://api.openai.com/v1`
۲. دکمه **🔑 Set API Key** → ارسال `sk-...` (برای آنتروپیک `sk-ant-...`)
۳. در صورت نیاز ارائه‌دهنده را با `/provider` عوض کنید
۴. **🤖 Models** → صبر برای `Fetching models…` → یک مدل را انتخاب کنید → تست خودکار (`✅ Working!` یا `❌ Failed` همراه جزئیات HTTP)
۵. حالا هر پیامی بفرستید به `chat()` در `worker_openai.js:406` می‌رود.

برای پراکسی‌ها / سرویس‌های سازگار با OpenAI (مثل OpenRouter، Groq و ...) کافیست Base URL سازگار آن‌ها را وارد کنید.

### داخل KV چه ذخیره می‌شود

| کلید | انقضا | محتوا |
|------|-------|--------|
| `user:{chatId}` | دائمی | `{ baseUrl, apiKey, model, provider, style, awaiting, hist[20], msgs, tokens{p,c,t} }` (`loadUser` در `worker_openai.js:138`) |
| `models:{chatId}` | ۶۰۰ ثانیه | آرایه `string[]` نام مدل‌ها (`worker_openai.js:152`) |
| `tg_secret` | دائمی | رمز وبهوک |
| `act_ts` | دائمی | زمان آخرین فعال‌سازی (برای throttle) |
| `upd:{update_id}` | ۳۰۰ ثانیه | جلوگیری از پردازش تکراری تلگرام |

برای دیدن: داشبورد → KV → `USER_SETTINGS` → مرور کلیدها. برای ریست یک کاربر، کلید `user:{id}` را حذف کنید.

## رفع مشکل

- `Missing TELEGRAM_TOKEN` → سکرت ست نشده یا نام اشتباه است (باید دقیقاً `TELEGRAM_TOKEN` باشد).
- `Forbidden` روی وبهوک → عدم تطابق `tg_secret`، دوباره `/activate` را بزنید.
- `AI API is not working (no answer in 55s)` → تایم‌اوت ارائه‌دهنده، نگهبان در `worker_openai.js:424`، با `/test` یا مدل دیگر امتحان کنید.
- `Failed: HTTP 401/403` → کلید اشتباه یا Base URL نادرست.
- `Failed: HTTP 404` → نام مدل اشتباه.
- دو بار `Thinking…` → با `waitUntil` و dedupe `update_id` حل شده (`worker_openai.js:65`)، اگر ورکر قبل از `return new Response('OK')` خطا دهد دوباره رخ می‌دهد.

## هزینه

- پلن رایگان Workers و KV برای ربات‌های کوچک کافی است. Workers AI هم سهمیه رایگان دارد. هزینه‌ی کلید خارجی را OpenAI/Anthropic حساب می‌کند.

## فایل

- `worker_openai.js` — تنها فایل پروژه، ۴۶۸ خط، بدون وابستگی.
