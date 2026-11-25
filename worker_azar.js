import { sellerTarget, sellerBonus, supervisorBonus } from "./azar_rules.js";

const REPO = "mehdimaleki509020/Rekord-mehr-bot";
const AUD = "rekord-mehr-bot-processor";
const ISS = "https://token.actions.githubusercontent.com";
const WORKFLOW = REPO + "/.github/workflows/process-report.yml@refs/heads/main";
const DISPATCH_URL = "https://api.github.com/repos/" + REPO +
  "/actions/workflows/process-report.yml/dispatches";
let initialized = false;
let jwks = { until: 0, keys: [] };

const norm = (value) => String(value ?? "").normalize("NFKC")
  .replace(/[يىئ]/g, "ی").replace(/ك/g, "ک").replace(/[ۀة]/g, "ه")
  .replace(/[أإٱآ]/g, "ا").replace(/ؤ/g, "و")
  .replace(/[‌‎‏ـ]/g, " ").replace(/\p{M}/gu, "")
  .replace(/\s+/g, " ").trim().toLowerCase();
const key = (value) => norm(value).replace(/[^0-9A-Za-z\u0600-\u06FF]/g, "");
const nameKey = (value) => {
  const words = norm(value).split(" ").filter(Boolean);
  for (let size = 1; size <= Math.floor(words.length / 2); size++) {
    if (words.length % size !== 0) continue;
    if (words.every((word, index) => word === words[index % size])) {
      return key(words.slice(0, size).join(" "));
    }
  }
  return key(value);
};
const token = (env) => env.BALE_TOKEN || env.BALE_BOT_TOKEN || env.BOT_TOKEN || "";
export async function secretWebhookPath(env) {
  if (!token(env)) throw Error("BALE TOKEN NOT FOUND");
  // Bale does not provide a documented signed-update header. A long,
  // undisclosed URL path prevents arbitrary public POSTs impersonating admins.
  const input = new TextEncoder().encode("rekord-bale-webhook-v1:" + token(env));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return "/webhook/" + Array.from(digest.slice(0, 20), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8" },
});
const money = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1000) return (v / 1000).toLocaleString("fa-IR", { maximumFractionDigits: 2 }) + " میلیارد تومان";
  return v.toLocaleString("fa-IR", { maximumFractionDigits: 2 }) + " میلیون تومان";
};

async function bale(env, method, payload) {
  if (!token(env)) throw Error("BALE TOKEN NOT FOUND");
  const options = payload === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  };
  const response = await fetch("https://tapi.bale.ai/bot" + token(env) + "/" + method, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw Error("Bale " + method + ": " + (data.description || response.status));
  return data;
}
const send = (env, chat, text) => chat ? bale(env, "sendMessage", { chat_id: chat, text }) : Promise.resolve();

// GitHub cron is best-effort and may run hours late. When a fine-grained
// Actions:write token is configured as a Worker secret, dispatch immediately.
// The scheduled job remains a fallback if dispatch fails or is not configured.
export async function dispatchProcessor(env, requestFetch = fetch) {
  const secret = String(env.GITHUB_ACTIONS_TOKEN || "").trim();
  if (!secret) return { ok: false, reason: "not_configured" };
  try {
    const response = await requestFetch(DISPATCH_URL, {
      method: "POST",
      headers: {
        authorization: "Bearer " + secret,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "rekord-mehr-bot",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (!response.ok) {
      console.log("GitHub dispatch failed with HTTP", response.status);
      return { ok: false, reason: "github_http_" + response.status };
    }
    return { ok: true };
  } catch (err) {
    console.log("GitHub dispatch connection failed:", String(err?.name || "network_error"));
    return { ok: false, reason: "network_error" };
  }
}

async function init(env) {
  if (initialized) return;
  if (!env.DB) throw Error("D1 binding DB is missing");
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS azar_people(seller_key TEXT PRIMARY KEY,store_key TEXT NOT NULL,store TEXT NOT NULL,seller_name TEXT NOT NULL,aban_m REAL NOT NULL,azar_m REAL NOT NULL,days_elapsed INTEGER NOT NULL,report_id INTEGER NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS azar_people_store ON azar_people(store_key)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS azar_stores(store_key TEXT PRIMARY KEY,store TEXT NOT NULL,aban_m REAL NOT NULL,azar_m REAL NOT NULL,days_elapsed INTEGER NOT NULL,report_id INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS azar_links(user_id TEXT PRIMARY KEY,seller_key TEXT NOT NULL,linked_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
    // Old tables remain intact, allowing previously registered Aban users to migrate automatically.
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sellers(seller_key TEXT PRIMARY KEY,store TEXT,store_key TEXT,seller_name TEXT,baseline_m REAL,target20_m REAL,target30_m REAL,target40_m REAL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS links(user_id TEXT PRIMARY KEY,seller_key TEXT,linked_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT,file_id TEXT,file_name TEXT,file_size INTEGER,file_path TEXT,uploader_user_id TEXT,uploader_chat_id TEXT,status TEXT DEFAULT 'pending',created_at TEXT DEFAULT CURRENT_TIMESTAMP,started_at TEXT,processed_at TEXT,matched_sellers INTEGER,sales_m REAL,note TEXT)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS reports_status ON reports(status,id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS admins(user_id TEXT PRIMARY KEY,first_name TEXT,username TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS supervisors(user_id TEXT PRIMARY KEY,store TEXT,store_key TEXT,display_name TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS bot_migrations(id TEXT PRIMARY KEY,applied_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
  ]);
  // Never requeue archived Aban failures when Azar processing starts.
  initialized = true;
}

export function sellerMessage(person) {
  const sold = Number(person.azar_m || 0);
  const target = sellerTarget(person.aban_m);
  const bonus = sellerBonus(person.aban_m, sold);
  const date = person.days_elapsed ? " تا " + Number(person.days_elapsed).toLocaleString("fa-IR") + " آذر" : " تا آخرین گزارش";
  return [
    "🏆 رکورد رشد آذر | " + person.seller_name + " | " + person.store,
    "🎯 مبنای محاسبه جایزه: " + money(target),
    "📊 فروش" + date + ": " + money(sold),
    "💰 جایزه: " + money(bonus),
  ].join("\n");
}

export function branchMessage(branch, people) {
  const date = branch.days_elapsed ? " تا " + Number(branch.days_elapsed).toLocaleString("fa-IR") + " آذر" : " تا آخرین گزارش";
  const rewards = people.map((p) => sellerBonus(p.aban_m, p.azar_m));
  const prize = supervisorBonus(branch.aban_m, branch.azar_m, rewards);
  const lines = [
    "🏆 رکورد رشد آذر | سوپروایزر " + branch.store,
    "🎯 فروش آبان شعبه: " + money(branch.aban_m),
    "📊 فروش" + date + ": " + money(branch.azar_m),
    "💰 جایزه سوپروایزر: " + money(prize),
    "",
    "👥 فروشندگان (مبنای پاداش | فروش آذر | جایزه):",
  ];
  people.sort((a, b) => Number(b.azar_m) - Number(a.azar_m));
  for (const p of people) {
    lines.push(p.seller_name + ": " + money(sellerTarget(p.aban_m)) + " | " +
      money(p.azar_m) + " | " + money(sellerBonus(p.aban_m, p.azar_m)));
  }
  return lines.join("\n");
}

export function networkMessage(branches) {
  if (!branches.length) return "⏳ هنوز گزارشی برای شبکه بارگذاری نشده است.";
  const sorted = [...branches].sort((a, b) =>
    Number(b.azar_m || 0) - Number(a.azar_m || 0) ||
    String(a.store).localeCompare(String(b.store), "fa"));
  const total = sorted.reduce((sum, store) => sum + Number(store.azar_m || 0), 0);
  const day = Math.max(0, ...sorted.map((store) => Number(store.days_elapsed || 0)));
  const date = day ? " تا " + day.toLocaleString("fa-IR") + " آذر" : " تا آخرین گزارش";
  return [
    "📊 شبکه غیربرقی | فروش" + date,
    "کل فروش: " + money(total),
    "",
    ...sorted.map((store, index) =>
      (index + 1).toLocaleString("fa-IR") + ") " + store.store + ": " + money(store.azar_m)),
  ].join("\n");
}

// A private, read-only manager report. Use the same target and award functions
// as the seller panels, so displayed winners always match the bot's rules.
export function winnersMessages(people) {
  const winners = people.map((person) => ({
    ...person,
    award: sellerBonus(person.aban_m, person.azar_m),
  })).filter((person) => person.award > 0)
    .sort((a, b) => b.award - a.award || Number(b.azar_m) - Number(a.azar_m) ||
      String(a.seller_name).localeCompare(String(b.seller_name), "fa"));
  const day = Math.max(0, ...people.map((person) => Number(person.days_elapsed || 0)));
  const date = day ? " تا " + day.toLocaleString("fa-IR") + " آذر" : " تا آخرین گزارش";
  if (!winners.length) return [[
    "🏆 فهرست پاداش فروشندگان" + date,
    "هنوز هیچ فروشنده‌ای به تارگت دریافت پاداش نرسیده است.",
  ].join("\n")];

  const perPage = 20;
  const pageCount = Math.ceil(winners.length / perPage);
  const total = winners.reduce((sum, person) => sum + person.award, 0);
  const pages = [];
  for (let start = 0; start < winners.length; start += perPage) {
    const page = Math.floor(start / perPage) + 1;
    const lines = [
      "🏆 مشمولان پاداش آذر" + date + " | صفحه " +
        page.toLocaleString("fa-IR") + " از " + pageCount.toLocaleString("fa-IR"),
    ];
    if (page === 1) lines.push(
      "👥 تعداد مشمولان: " + winners.length.toLocaleString("fa-IR") + " نفر",
      "💰 مجموع پاداش فعلی: " + money(total),
      "",
    );
    for (const [index, person] of winners.slice(start, start + perPage).entries()) {
      lines.push((start + index + 1).toLocaleString("fa-IR") + ") " +
        person.seller_name + " | " + person.store +
        " | پاداش: " + money(person.award));
    }
    if (page === pageCount) lines.push("\nمبالغ تا پایان ماه موقت هستند.");
    pages.push(lines.join("\n"));
  }
  return pages;
}

async function hasData(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM azar_stores").first();
  return Number(row?.n || 0) > 0;
}

async function mine(env, userId) {
  const link = await env.DB.prepare("SELECT seller_key FROM azar_links WHERE user_id=?").bind(String(userId)).first();
  if (link) {
    const current = await env.DB.prepare("SELECT * FROM azar_people WHERE seller_key=?").bind(link.seller_key).first();
    if (current) return current;
  }
  const previous = await env.DB.prepare("SELECT seller_key FROM aban_links WHERE user_id=?")
    .bind(String(userId)).first();
  if (previous) {
    const current = await env.DB.prepare("SELECT * FROM azar_people WHERE seller_key=?").bind(previous.seller_key).first();
    if (current) {
      await env.DB.prepare("INSERT OR REPLACE INTO azar_links(user_id,seller_key) VALUES(?,?)")
        .bind(String(userId),current.seller_key).run();
      return current;
    }
  }
  const old = await env.DB.prepare("SELECT s.store_key,s.seller_name FROM links l JOIN sellers s ON s.seller_key=l.seller_key WHERE l.user_id=?")
    .bind(String(userId)).first();
  if (!old) return null;
  const newKey = key(old.store_key) + ":" + nameKey(old.seller_name);
  const person = await env.DB.prepare("SELECT * FROM azar_people WHERE seller_key=?").bind(newKey).first();
  if (person) await env.DB.prepare("INSERT OR REPLACE INTO azar_links(user_id,seller_key) VALUES(?,?)")
    .bind(String(userId), person.seller_key).run();
  return person;
}

async function status(env, userId) {
  if (!(await hasData(env))) return "⏳ هنوز گزارش فروش آذر پردازش نشده است.";
  const person = await mine(env, userId);
  if (!person) return "برای ثبت نام بنویسید:\nثبت نام [نام و نام خانوادگی]\nاگر همنام دارید: ثبت نام [نام] | [نام شعبه]";
  return sellerMessage(person);
}

async function branchStatus(env, store) {
  const storeKey = key(store);
  const branch = await env.DB.prepare("SELECT * FROM azar_stores WHERE store_key=?").bind(storeKey).first();
  if (!branch) return "⏳ اطلاعات فروشگاه «" + store + "» در گزارش آذر یافت نشد.";
  const people = (await env.DB.prepare("SELECT * FROM azar_people WHERE store_key=?").bind(storeKey).all()).results || [];
  return branchMessage(branch, people);
}

async function networkStatus(env) {
  const branches = (await env.DB.prepare(
    "SELECT store,azar_m,days_elapsed FROM azar_stores ORDER BY azar_m DESC,store ASC"
  ).all()).results || [];
  return networkMessage(branches);
}

async function winnersStatus(env) {
  const people = (await env.DB.prepare(
    "SELECT seller_name,store,aban_m,azar_m,days_elapsed FROM azar_people"
  ).all()).results || [];
  if (!people.length) return ["⏳ هنوز اطلاعات فروشندگان آذر ثبت نشده است."];
  return winnersMessages(people);
}

async function resolveBranchName(env, text) {
  const names = (await env.DB.prepare("SELECT store,store_key FROM azar_stores").all()).results || [];
  const wanted = key(text);
  const exact = names.find((row) => row.store_key === wanted);
  if (exact) return { store: exact.store };
  if (!wanted || wanted.length < 2) return null;
  const matches = names.filter((row) => row.store_key.includes(wanted));
  if (matches.length === 1) return { store: matches[0].store };
  if (matches.length > 1) return { ambiguous: matches.map((row) => row.store) };
  return null;
}

async function supervisorOf(env, userId) {
  return env.DB.prepare("SELECT * FROM supervisors WHERE user_id=?").bind(String(userId)).first();
}

async function admin(env, user, claim = false) {
  const ids = String(env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.includes(String(user.id))) return true;
  if (await env.DB.prepare("SELECT 1 AS x FROM admins WHERE user_id=?").bind(String(user.id)).first()) return true;
  if (!claim) return false;
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM admins").first();
  if (Number(count?.n || 0)) return false;
  await env.DB.prepare("INSERT INTO admins(user_id,first_name,username) VALUES(?,?,?)")
    .bind(String(user.id), user.first_name || "", user.username || "").run();
  return true;
}

async function register(env, userId, input) {
  if (!(await hasData(env))) return "ابتدا گزارش فروش آذر باید بارگذاری و پردازش شود.";
  const parts = input.split("|").map((value) => value.trim());
  const wantedName = nameKey(parts[0]);
  const wantedStore = parts[1] ? key(parts[1]) : "";
  if (!wantedName) return "لطفاً نام و نام خانوادگی را وارد کنید.";
  const all = (await env.DB.prepare("SELECT * FROM azar_people").all()).results || [];
  let matches = all.filter((row) => nameKey(row.seller_name) === wantedName &&
    (!wantedStore || row.store_key === wantedStore));
  if (matches.length === 0) matches = all.filter((row) =>
    (nameKey(row.seller_name).includes(wantedName) || wantedName.includes(nameKey(row.seller_name))) &&
    (!wantedStore || row.store_key === wantedStore));
  if (matches.length !== 1) return matches.length > 1 ?
    "چند فروشنده با این نام پیدا شد. بنویسید: ثبت نام [نام کامل] | [نام شعبه]" :
    "نام پیدا نشد؛ نام و فروشگاه را مطابق گزارش فروش وارد کنید.";
  const person = matches[0];
  await env.DB.prepare("INSERT OR REPLACE INTO azar_links(user_id,seller_key) VALUES(?,?)")
    .bind(String(userId), person.seller_key).run();
  return sellerMessage(person);
}

async function assignSupervisor(env, user, message, storeName) {
  if (!(await admin(env, user))) return "⛔ مخصوص مدیر طرح است.";
  const target = message.reply_to_message?.from;
  if (!target?.id) return "روی پیام سوپروایزر Reply کنید و بنویسید: ثبت سرپرست [نام فروشگاه]";
  const store = await env.DB.prepare("SELECT * FROM azar_stores WHERE store_key=?").bind(key(storeName)).first();
  if (!store) return "فروشگاه پیدا نشد؛ ابتدا گزارش فروش آذر را بارگذاری کنید.";
  const display = [target.first_name, target.last_name].filter(Boolean).join(" ") || target.username || String(target.id);
  await env.DB.prepare("INSERT OR REPLACE INTO supervisors(user_id,store,store_key,display_name) VALUES(?,?,?,?)")
    .bind(String(target.id), store.store, store.store_key, display).run();
  return "✅ " + display + " به عنوان سوپروایزر " + store.store + " ثبت شد.";
}

async function upload(env, message) {
  const chat = message.chat?.id;
  if (message.chat?.type !== "private") return;
  if (!(await admin(env, message.from || {}, true))) {
    await send(env, chat, "⛔ فقط مدیر طرح می‌تواند فایل گزارش را ارسال کند.");
    return;
  }
  const file = message.document;
  const name = file.file_name || "SalesReport.xlsb";
  if (!name.toLowerCase().endsWith(".xlsb")) {
    await send(env, chat, "گزارش باید فایل SalesReport.xlsb باشد.");
    return;
  }
  if (Number(file.file_size || 0) > 20 * 1024 * 1024) {
    await send(env, chat, "حجم فایل باید کمتر از ۲۰ مگابایت باشد.");
    return;
  }
  const result = await bale(env, "getFile", { file_id: file.file_id });
  if (!result?.result?.file_path) throw Error("Bale getFile returned no file_path");
  const row = await env.DB.prepare("INSERT INTO reports(file_id,file_name,file_size,file_path,uploader_user_id,uploader_chat_id,status) VALUES(?,?,?,?,?,?,'pending')")
    .bind(String(file.file_id), name, Number(file.file_size || 0), result.result.file_path,
      String(message.from?.id || ""), String(chat)).run();
  const dispatch = await dispatchProcessor(env);
  await send(env, chat, "✅ گزارش دریافت شد. شماره: " + row.meta?.last_row_id +
    (dispatch.ok ? "\n🚀 دستور پردازش فوری ارسال شد." :
      "\n⏳ در صف پردازش قرار گرفت؛ اجرای فوری " +
      (dispatch.reason === "not_configured" ? "هنوز فعال نشده است." : "ناموفق بود و زمان‌بندی پشتیبان فعال است.")));
}

async function hook(request, env) {
  const update = await request.json();
  const message = update.message;
  if (!message) return new Response("OK");
  if (message.document) {
    await upload(env, message);
    return new Response("OK");
  }
  const chat = message.chat?.id;
  const user = message.from || {};
  const text = String(message.text || "").trim();
  const sup = await supervisorOf(env, user.id);
  const isAdmin = await admin(env, user);

  // Personal sales, registration and management details are private only.
  const privateCommands = text === "/start" || text === "شروع" ||
    text === "وضعیت من" || text === "ثبت نام" || text === "ثبت‌نام" ||
    /^ثبت[ ‌-]?نام\\s+/u.test(text) || text === "تیم من" ||
    text === "وضعیت شعبه" || text.startsWith("وضعیت شعبه ") ||
    text === "شبکه" || text === "برندگان" || text === "برندگان آذر";
  if (privateCommands && message.chat?.type !== "private") {
    await send(env, chat, "🔒 برای حفظ محرمانگی اطلاعات، این دستور را در گفت‌وگوی خصوصی ربات ارسال کنید.");
    return new Response("OK");
  }
  if (text === "/start" || text === "شروع" || text === "وضعیت من") {
    if (sup) await send(env, chat, await branchStatus(env, sup.store));
    else if (isAdmin) await send(env, chat, [
      "🏆 رکورد رشد آذر | مدیر طرح",
      "• برای فروش کل و رتبه شعب: شبکه",
      "• برای جزئیات یک شعبه: فقط نام فروشگاه را بنویسید",
      "• فروشندگان مشمول پاداش: برندگان آذر",
      "• برای اجرای دستی صف: پردازش فوری",
      "• آخرین گزارش",
      "• ارسال فایل تجمعی SalesReport.xlsb تا روز گزارش (شامل آذر) در گفت‌وگوی خصوصی",
    ].join("\n"));
    else await send(env, chat, await status(env, user.id));
    return new Response("OK");
  }
  if (/^ثبت[ ‌-]?نام\s+/u.test(text)) {
    if (sup || isAdmin) await send(env, chat, "این حساب نقش مدیریتی دارد.");
    else await send(env, chat, await register(env, user.id, text.replace(/^ثبت[ ‌-]?نام\s+/u, "")));
    return new Response("OK");
  }
  if (text === "ثبت نام" || text === "ثبت‌نام") {
    await send(env, chat, "بنویسید: ثبت نام [نام و نام خانوادگی]");
    return new Response("OK");
  }
  if (/^ثبت سرپرست\s+/u.test(text)) {
    await send(env, chat, await assignSupervisor(env, user, message, text.replace(/^ثبت سرپرست\s+/u, "")));
    return new Response("OK");
  }
  if (text === "تیم من" || text === "وضعیت شعبه") {
    await send(env, chat, sup ? await branchStatus(env, sup.store) : "برای مدیر: وضعیت شعبه [نام فروشگاه]");
    return new Response("OK");
  }
  if (text.startsWith("وضعیت شعبه ")) {
    if (sup) await send(env, chat, await branchStatus(env, sup.store));
    else if (isAdmin) await send(env, chat, await branchStatus(env, text.slice("وضعیت شعبه".length).trim()));
    else await send(env, chat, "⛔ این دستور مخصوص سوپروایزر و مدیر است.");
    return new Response("OK");
  }
  if (text === "شبکه" && isAdmin) {
    await send(env, chat, await networkStatus(env));
    return new Response("OK");
  }
  if (text === "برندگان آذر" || text === "برندگان") {
    if (!isAdmin) await send(env, chat, "⛔ این گزارش مخصوص مدیر طرح است.");
    else if (message.chat?.type !== "private") await send(env, chat,
      "برای دریافت فهرست مشمولان در گفت‌وگوی خصوصی ربات بنویسید: برندگان آذر");
    else for (const page of await winnersStatus(env)) await send(env, chat, page);
    return new Response("OK");
  }
  if (text === "پردازش فوری") {
    if (!isAdmin) await send(env, chat, "⛔ مخصوص مدیر طرح است.");
    else if (message.chat?.type !== "private") await send(env, chat,
      "این دستور را در گفت‌وگوی خصوصی ربات ارسال کنید.");
    else {
      const pending = await env.DB.prepare("SELECT id FROM reports WHERE status='pending' ORDER BY id LIMIT 1").first();
      if (!pending) await send(env, chat, "✅ در حال حاضر گزارشی در صف نیست.");
      else {
        const result = await dispatchProcessor(env);
        await send(env, chat, result.ok ?
          "🚀 درخواست پردازش گزارش شماره " + pending.id + " ارسال شد." :
          result.reason === "not_configured" ?
            "⏳ اجرای فوری هنوز فعال نشده است؛ توکن GitHub باید به تنظیمات ربات اضافه شود." :
            "⚠️ اجرای فوری موفق نشد؛ گزارش همچنان در صف و منتظر زمان‌بندی پشتیبان است.");
      }
    }
    return new Response("OK");
  }
  if (text === "آخرین گزارش" && isAdmin) {
    const last = await env.DB.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT 1").first();
    await send(env, chat, last ? "گزارش #" + last.id + "\n" + last.file_name +
      "\nوضعیت: " + last.status + "\nتعداد فروشندگان: " + (last.matched_sellers ?? "—") :
      "هنوز گزارشی بارگذاری نشده است.");
    return new Response("OK");
  }
  if (isAdmin && message.chat?.type === "private") {
    const matched = await resolveBranchName(env, text);
    if (matched?.store) await send(env, chat, await branchStatus(env, matched.store));
    else if (matched?.ambiguous) await send(env, chat,
      "نام فروشگاه مبهم است. یکی از این نام‌ها را کامل بنویسید:\n" + matched.ambiguous.join("\n"));
  }
  return new Response("OK");
}

const decode64 = (str) => {
  let text = str.replace(/-/g, "+").replace(/_/g, "/");
  while (text.length % 4) text += "=";
  const bytes = atob(text);
  return Uint8Array.from(bytes, (c) => c.charCodeAt(0));
};
const decode = (str) => JSON.parse(new TextDecoder().decode(decode64(str)));
async function signingKeys() {
  if (jwks.until > Date.now()) return jwks.keys;
  const response = await fetch(ISS + "/.well-known/jwks");
  if (!response.ok) throw Error("OIDC JWKS unavailable");
  const info = await response.json();
  jwks = { until: Date.now() + 6 * 3600 * 1000, keys: info.keys || [] };
  return jwks.keys;
}
async function authorize(request) {
  const bearer = request.headers.get("authorization") || "";
  if (!bearer.startsWith("Bearer ")) return false;
  const parts = bearer.slice(7).split(".");
  if (parts.length !== 3) return false;
  let header, claims;
  try { header = decode(parts[0]); claims = decode(parts[1]); } catch { return false; }
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (header.alg !== "RS256" || claims.iss !== ISS || !audiences.includes(AUD) ||
      claims.repository !== REPO || claims.ref !== "refs/heads/main" ||
      claims.workflow_ref !== WORKFLOW || !claims.exp || claims.exp < now) return false;
  const jwk = (await signingKeys()).find((value) => value.kid === header.kid);
  if (!jwk) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" },
      cryptoKey, decode64(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch { return false; }
}

function finiteAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || Math.abs(amount) > 1e10) throw Error("Invalid sales amount");
  return amount;
}
export function insertMany(env, table, columns, records) {
  const statements = [];
  // Cloudflare D1 allows at most 100 bound parameters in each SQL statement.
  const chunkSize = Math.max(1, Math.floor(100 / columns.length));
  for (let pos = 0; pos < records.length; pos += chunkSize) {
    const group = records.slice(pos, pos + chunkSize);
    const placeholders = "(" + columns.map(() => "?").join(",") + ")";
    const sql = "INSERT INTO " + table + "(" + columns.join(",") + ") VALUES " +
      group.map(() => placeholders).join(",");
    statements.push(env.DB.prepare(sql).bind(...group.flat()));
  }
  return statements;
}

// Restore the CLOSED Aban baseline from the archived Aban tables, never from
// partial month-8 rows in an Azar report. The archive is read-only here.
// Include old sellers/stores with zero Azar sales so no user link disappears.
export function withSavedAbanBaseline(data, archivedPeople, archivedStores) {
  if (!archivedStores.length || !archivedStores.some((s) => Number(s.days_elapsed || 0) >= 30)) {
    throw Error("مبنای قطعی آبان در ربات موجود نیست. ابتدا آرشیو کامل آبان باید تأیید شود.");
  }
  const originalPeople = new Map(archivedPeople.map((p) => [p.seller_key, p]));
  const originalsByIdentity = new Map();
  const identity = (p) => p.store_key + ":" + norm(p.seller_name).split(" ").sort().join("|");
  for (const p of archivedPeople) {
    const sig = identity(p);
    if (!originalsByIdentity.has(sig)) originalsByIdentity.set(sig, p);
    else originalsByIdentity.set(sig, null); // Do not guess identity for homonyms.
  }
  const originalStores = new Map(archivedStores.map((s) => [s.store_key, s]));
  const stores = new Map(archivedStores.map((p) => [p.store_key, {
    store: p.store, store_key: p.store_key,
    aban_m: Number(p.aban_m || 0), azar_m: 0,
  }]));
  for (const current of data.stores) {
    const old = originalStores.get(current.store_key);
    stores.set(current.store_key, {
      ...current, aban_m: Number(old?.aban_m || 0),
    });
  }
  const people = new Map(archivedPeople.map((p) => [p.seller_key, {
    store: p.store, store_key: p.store_key, seller_name: p.seller_name,
    seller_key: p.seller_key, aban_m: Number(p.aban_m || 0), azar_m: 0,
  }]));
  for (const current of data.sellers) {
    const old = originalPeople.get(current.seller_key) || originalsByIdentity.get(identity(current));
    const sellerKey = old?.seller_key || current.seller_key;
    people.set(sellerKey, {
      ...current,
      seller_key: sellerKey,
      seller_name: old?.seller_name || current.seller_name,
      aban_m: Number(old?.aban_m || 0),
    });
  }
  return {
    ...data,
    sellers: [...people.values()], stores: [...stores.values()],
    seller_count: people.size, store_count: stores.size,
    aban_baseline_restored: true,
  };
}
function statementsForSnapshot(env, data, reportId) {
  const people = [], stores = [], peopleKeys = new Set(), storeKeys = new Set();
  for (const s of data.stores) {
    const id = key(s.store);
    if (!id || id !== s.store_key || storeKeys.has(id)) throw Error("Invalid or duplicate store key");
    storeKeys.add(id);
    stores.push([id, s.store, finiteAmount(s.aban_m), finiteAmount(s.azar_m),
      Number(data.days_elapsed || 0), reportId]);
  }
  for (const p of data.sellers) {
    const storeKey = key(p.store), personKey = storeKey + ":" + nameKey(p.seller_name);
    if (!storeKeys.has(storeKey) || personKey !== p.seller_key ||
      peopleKeys.has(personKey)) throw Error("Invalid or duplicate seller");
    peopleKeys.add(personKey);
    people.push([personKey, storeKey, p.store, p.seller_name,
      finiteAmount(p.aban_m), finiteAmount(p.azar_m), Number(data.days_elapsed || 0), reportId]);
  }
  return [
    env.DB.prepare("DELETE FROM azar_people"),
    env.DB.prepare("DELETE FROM azar_stores"),
    ...insertMany(env, "azar_stores",
      ["store_key", "store", "aban_m", "azar_m", "days_elapsed", "report_id"], stores),
    ...insertMany(env, "azar_people",
      ["seller_key", "store_key", "store", "seller_name", "aban_m", "azar_m", "days_elapsed", "report_id"], people),
    env.DB.prepare("UPDATE reports SET status='done',processed_at=CURRENT_TIMESTAMP,matched_sellers=?,sales_m=?,note=?,file_path=NULL WHERE id=?")
      .bind(people.length, finiteAmount(data.sales_m), "آذر ۱۴۰۵ | روز " + data.days_elapsed +
        " | فروشندگان " + people.length + " | شعب " + stores.length, reportId),
  ];
}

async function processor(request, env, url) {
  if (!(await authorize(request))) return json({ ok: false, error: "unauthorized" }, 401);
  if (request.method === "GET" && url.pathname === "/processor/pending") {
    await env.DB.prepare("UPDATE reports SET status='pending',started_at=NULL WHERE status='processing' AND started_at < datetime('now','-30 minutes')").run();
    const report = await env.DB.prepare("SELECT id,file_name,file_size FROM reports WHERE status='pending' ORDER BY id LIMIT 1").first();
    if (!report) return json({ ok: true, job: null });
    await env.DB.prepare("UPDATE reports SET status='processing',started_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(report.id).run();
    return json({ ok: true, job: report });
  }
  let match = url.pathname.match(/^\/processor\/jobs\/(\d+)\/file$/);
  if (request.method === "GET" && match) {
    const report = await env.DB.prepare("SELECT file_path FROM reports WHERE id=?").bind(Number(match[1])).first();
    if (!report?.file_path) return json({ error: "not_found" }, 404);
    const response = await fetch("https://tapi.bale.ai/file/bot" + token(env) + "/" + report.file_path);
    if (!response.ok) return json({ error: "bale_" + response.status }, 502);
    return new Response(response.body, { headers: { "content-type": "application/octet-stream" } });
  }
  match = url.pathname.match(/^\/processor\/jobs\/(\d+)\/result$/);
  if (request.method === "POST" && match) {
    const reportId = Number(match[1]);
    const report = await env.DB.prepare("SELECT * FROM reports WHERE id=?").bind(reportId).first();
    if (!report || report.status !== "processing") return json({ error: "invalid_report_state" }, 409);
    let data = await request.json();
    if (data.period_year !== 1405 || data.period_month !== 9 ||
        !Array.isArray(data.sellers) || !Array.isArray(data.stores) ||
        data.stores.length === 0 || Number(data.azar_rows || 0) === 0 ||
        data.sellers.length > 5000 || Number(data.days_elapsed || 0) < 1 ||
        Number(data.days_elapsed || 0) > 30) {
      return json({ error: "invalid_azar_snapshot" }, 422);
    }
    const last = await env.DB.prepare("SELECT MAX(days_elapsed) AS day FROM azar_stores").first();
    if (Number(last?.day || 0) > Number(data.days_elapsed || 0)) {
      return json({ error: "report_is_older_than_current_snapshot" }, 409);
    }
    const [peopleResult, storeResult] = await Promise.all([
      env.DB.prepare("SELECT * FROM aban_people").all(),
      env.DB.prepare("SELECT * FROM aban_stores").all(),
    ]);
    data = withSavedAbanBaseline(data, peopleResult.results || [], storeResult.results || []);
    await env.DB.batch(statementsForSnapshot(env, data, reportId));
    await send(env, report.uploader_chat_id, [
      "✅ گزارش آذر پردازش و جایگزین شد.",
      "فروش تا روز " + data.days_elapsed + " آذر: " + money(data.sales_m),
      "فروشندگان: " + data.sellers.length + " | فروشگاه‌ها: " + data.stores.length,
      data.aban_baseline_restored ? "مبنای قطعی آبان از آرشیو حفظ شد." :
        "مبنای فروش آبان از آرشیو مستقل بازیابی شد.",
    ].join("\n")).catch((err) => console.log("Upload notice failed:", String(err)));
    return json({ ok: true, saved_sellers: data.sellers.length, saved_stores: data.stores.length });
  }
  match = url.pathname.match(/^\/processor\/jobs\/(\d+)\/error$/);
  if (request.method === "POST" && match) {
    const data = await request.json().catch(() => ({}));
    await env.DB.prepare("UPDATE reports SET status='error',processed_at=CURRENT_TIMESTAMP,note=? WHERE id=?")
      .bind(String(data.error || "processor error").slice(0, 1000), Number(match[1])).run();
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      await init(env);
      if (url.pathname.startsWith("/processor/")) return processor(request, env, url);
      if (request.method === "GET" && url.pathname === "/") {
        const latest = await env.DB.prepare("SELECT id,status,processed_at FROM reports ORDER BY id DESC LIMIT 1").first();
        return json({ ok: true, service: "Rekord Gheyrbarghi Azar", period: "1405/09", last_report: latest || null });
      }
      if (request.method === "GET" && url.pathname === "/setup") {
        const address = url.origin + await secretWebhookPath(env);
        const result = await bale(env, "setWebhook", { url: address });
        // Never disclose the shared webhook address through a public endpoint.
        return json({ ok: true, webhook_configured: true, bale_ok: result.ok !== false });
      }
      if (request.method === "GET" && url.pathname === "/debug") {
        const info = await bale(env, "getWebhookInfo");
        const counts = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM azar_people) AS people,(SELECT COUNT(*) FROM azar_stores) AS stores,(SELECT COUNT(*) FROM azar_links) AS links,(SELECT COUNT(*) FROM reports) AS reports").first();
        const web = info.result || info;
        return json({ ok: true, webhook: {
          configured: Boolean(web.url), pending_update_count: web.pending_update_count ?? null,
        }, counts });
      }
      if (request.method === "POST" && url.pathname === await secretWebhookPath(env)) {
        return hook(request, env);
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.log(err?.stack || String(err));
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  },
};
