import { sellerTarget, sellerBonus, supervisorBonus } from "./aban_rules.js";

const REPO = "mehdimaleki509020/Rekord-mehr-bot";
const AUD = "rekord-mehr-bot-processor";
const ISS = "https://token.actions.githubusercontent.com";
const WORKFLOW = REPO + "/.github/workflows/process-report.yml@refs/heads/main";
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

async function init(env) {
  if (initialized) return;
  if (!env.DB) throw Error("D1 binding DB is missing");
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS aban_people(seller_key TEXT PRIMARY KEY,store_key TEXT NOT NULL,store TEXT NOT NULL,seller_name TEXT NOT NULL,mehr_m REAL NOT NULL,aban_m REAL NOT NULL,days_elapsed INTEGER NOT NULL,report_id INTEGER NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS aban_people_store ON aban_people(store_key)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS aban_stores(store_key TEXT PRIMARY KEY,store TEXT NOT NULL,mehr_m REAL NOT NULL,aban_m REAL NOT NULL,days_elapsed INTEGER NOT NULL,report_id INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS aban_links(user_id TEXT PRIMARY KEY,seller_key TEXT NOT NULL,linked_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
    // Old tables remain intact, allowing previously registered Mehr users to migrate automatically.
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sellers(seller_key TEXT PRIMARY KEY,store TEXT,store_key TEXT,seller_name TEXT,baseline_m REAL,target20_m REAL,target30_m REAL,target40_m REAL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS links(user_id TEXT PRIMARY KEY,seller_key TEXT,linked_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT,file_id TEXT,file_name TEXT,file_size INTEGER,file_path TEXT,uploader_user_id TEXT,uploader_chat_id TEXT,status TEXT DEFAULT 'pending',created_at TEXT DEFAULT CURRENT_TIMESTAMP,started_at TEXT,processed_at TEXT,matched_sellers INTEGER,sales_m REAL,note TEXT)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS reports_status ON reports(status,id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS admins(user_id TEXT PRIMARY KEY,first_name TEXT,username TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS supervisors(user_id TEXT PRIMARY KEY,store TEXT,store_key TEXT,display_name TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS bot_migrations(id TEXT PRIMARY KEY,applied_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
  ]);
  // One-time recovery for report 22, which was processed successfully by
  // GitHub Actions but failed on the old D1 parameter limit. Do not repeat
  // this recovery after another error; the migration marker is permanent.
  const recoveryId = "retry-report-22-after-d1-bind-fix";
  const migrated = await env.DB.prepare("SELECT id FROM bot_migrations WHERE id=?").bind(recoveryId).first();
  if (!migrated) {
    await env.DB.batch([
      env.DB.prepare("UPDATE reports SET status='pending',started_at=NULL,processed_at=NULL,note='Retry after D1 parameter fix' WHERE id=22 AND status='error' AND file_path IS NOT NULL"),
      env.DB.prepare("INSERT OR IGNORE INTO bot_migrations(id) VALUES(?)").bind(recoveryId),
    ]);
  }
  initialized = true;
}

export function sellerMessage(person) {
  const sold = Number(person.aban_m || 0);
  const target = sellerTarget(person.mehr_m);
  const bonus = sellerBonus(person.mehr_m, sold);
  const date = person.days_elapsed ? " تا " + Number(person.days_elapsed).toLocaleString("fa-IR") + " آبان" : " تا آخرین گزارش";
  return [
    "🏆 لیگ آبان | " + person.seller_name + " | " + person.store,
    "🎯 تارگت آبان: " + money(target),
    "📊 فروش" + date + ": " + money(sold),
    "💰 جایزه: " + money(bonus),
  ].join("\n");
}

export function branchMessage(branch, people) {
  const date = branch.days_elapsed ? " تا " + Number(branch.days_elapsed).toLocaleString("fa-IR") + " آبان" : " تا آخرین گزارش";
  const rewards = people.map((p) => sellerBonus(p.mehr_m, p.aban_m));
  const prize = supervisorBonus(branch.mehr_m, branch.aban_m, rewards);
  const lines = [
    "🏆 لیگ آبان | سوپروایزر " + branch.store,
    "🎯 حداقل تارگت: " + money(branch.mehr_m),
    "📊 فروش" + date + ": " + money(branch.aban_m),
    "💰 جایزه سوپروایزر: " + money(prize),
    "",
    "👥 فروشندگان (تارگت | فروش | جایزه):",
  ];
  people.sort((a, b) => Number(b.aban_m) - Number(a.aban_m));
  for (const p of people) {
    lines.push(p.seller_name + ": " + money(sellerTarget(p.mehr_m)) + " | " +
      money(p.aban_m) + " | " + money(sellerBonus(p.mehr_m, p.aban_m)));
  }
  return lines.join("\n");
}

async function hasData(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM aban_stores").first();
  return Number(row?.n || 0) > 0;
}

async function mine(env, userId) {
  const link = await env.DB.prepare("SELECT seller_key FROM aban_links WHERE user_id=?").bind(String(userId)).first();
  if (link) return env.DB.prepare("SELECT * FROM aban_people WHERE seller_key=?").bind(link.seller_key).first();
  const old = await env.DB.prepare("SELECT s.store_key,s.seller_name FROM links l JOIN sellers s ON s.seller_key=l.seller_key WHERE l.user_id=?")
    .bind(String(userId)).first();
  if (!old) return null;
  const newKey = key(old.store_key) + ":" + nameKey(old.seller_name);
  const person = await env.DB.prepare("SELECT * FROM aban_people WHERE seller_key=?").bind(newKey).first();
  if (person) await env.DB.prepare("INSERT OR REPLACE INTO aban_links(user_id,seller_key) VALUES(?,?)")
    .bind(String(userId), person.seller_key).run();
  return person;
}

async function status(env, userId) {
  if (!(await hasData(env))) return "⏳ هنوز گزارش فروش آبان همراه با اطلاعات کامل مهر بارگذاری نشده است.";
  const person = await mine(env, userId);
  if (!person) return "برای ثبت نام بنویسید:\nثبت نام [نام و نام خانوادگی]\nاگر همنام دارید: ثبت نام [نام] | [نام شعبه]";
  return sellerMessage(person);
}

async function branchStatus(env, store) {
  const storeKey = key(store);
  const branch = await env.DB.prepare("SELECT * FROM aban_stores WHERE store_key=?").bind(storeKey).first();
  if (!branch) return "⏳ اطلاعات فروشگاه «" + store + "» در گزارش آبان یافت نشد.";
  const people = (await env.DB.prepare("SELECT * FROM aban_people WHERE store_key=?").bind(storeKey).all()).results || [];
  return branchMessage(branch, people);
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
  if (!(await hasData(env))) return "ابتدا گزارش فروش آبان باید بارگذاری و پردازش شود.";
  const parts = input.split("|").map((value) => value.trim());
  const wantedName = nameKey(parts[0]);
  const wantedStore = parts[1] ? key(parts[1]) : "";
  if (!wantedName) return "لطفاً نام و نام خانوادگی را وارد کنید.";
  const all = (await env.DB.prepare("SELECT * FROM aban_people").all()).results || [];
  let matches = all.filter((row) => nameKey(row.seller_name) === wantedName &&
    (!wantedStore || row.store_key === wantedStore));
  if (matches.length === 0) matches = all.filter((row) =>
    (nameKey(row.seller_name).includes(wantedName) || wantedName.includes(nameKey(row.seller_name))) &&
    (!wantedStore || row.store_key === wantedStore));
  if (matches.length !== 1) return matches.length > 1 ?
    "چند فروشنده با این نام پیدا شد. بنویسید: ثبت نام [نام کامل] | [نام شعبه]" :
    "نام پیدا نشد؛ نام و فروشگاه را مطابق گزارش فروش وارد کنید.";
  const person = matches[0];
  await env.DB.prepare("INSERT OR REPLACE INTO aban_links(user_id,seller_key) VALUES(?,?)")
    .bind(String(userId), person.seller_key).run();
  return sellerMessage(person);
}

async function assignSupervisor(env, user, message, storeName) {
  if (!(await admin(env, user))) return "⛔ مخصوص مدیر طرح است.";
  const target = message.reply_to_message?.from;
  if (!target?.id) return "روی پیام سوپروایزر Reply کنید و بنویسید: ثبت سرپرست [نام فروشگاه]";
  const store = await env.DB.prepare("SELECT * FROM aban_stores WHERE store_key=?").bind(key(storeName)).first();
  if (!store) return "فروشگاه پیدا نشد؛ ابتدا گزارش فروش آبان را بارگذاری کنید.";
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
  await send(env, chat, "✅ گزارش دریافت شد. پردازش در صف قرار گرفت. شماره: " + row.meta?.last_row_id);
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

  if (text === "/start" || text === "شروع" || text === "وضعیت من") {
    if (sup) await send(env, chat, await branchStatus(env, sup.store));
    else if (isAdmin) await send(env, chat, [
      "مدیریت لیگ آبان 🏆", "وضعیت شعبه [نام فروشگاه]",
      "ثبت سرپرست [نام فروشگاه] (Reply به پیام او)",
      "آخرین گزارش", "ارسال روزانه SalesReport.xlsb در گفت‌وگوی خصوصی",
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
  if (text === "آخرین گزارش" && isAdmin) {
    const last = await env.DB.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT 1").first();
    await send(env, chat, last ? "گزارش #" + last.id + "\n" + last.file_name +
      "\nوضعیت: " + last.status + "\nتعداد فروشندگان: " + (last.matched_sellers ?? "—") :
      "هنوز گزارشی بارگذاری نشده است.");
    return new Response("OK");
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
function statementsForSnapshot(env, data, reportId) {
  const people = [], stores = [], peopleKeys = new Set(), storeKeys = new Set();
  for (const s of data.stores) {
    const id = key(s.store);
    if (!id || id !== s.store_key || storeKeys.has(id)) throw Error("Invalid or duplicate store key");
    storeKeys.add(id);
    stores.push([id, s.store, finiteAmount(s.mehr_m), finiteAmount(s.aban_m),
      Number(data.days_elapsed || 0), reportId]);
  }
  for (const p of data.sellers) {
    const storeKey = key(p.store), personKey = storeKey + ":" + nameKey(p.seller_name);
    if (!storeKeys.has(storeKey) || personKey !== p.seller_key ||
      peopleKeys.has(personKey)) throw Error("Invalid or duplicate seller");
    peopleKeys.add(personKey);
    people.push([personKey, storeKey, p.store, p.seller_name,
      finiteAmount(p.mehr_m), finiteAmount(p.aban_m), Number(data.days_elapsed || 0), reportId]);
  }
  return [
    env.DB.prepare("DELETE FROM aban_people"),
    env.DB.prepare("DELETE FROM aban_stores"),
    ...insertMany(env, "aban_stores",
      ["store_key", "store", "mehr_m", "aban_m", "days_elapsed", "report_id"], stores),
    ...insertMany(env, "aban_people",
      ["seller_key", "store_key", "store", "seller_name", "mehr_m", "aban_m", "days_elapsed", "report_id"], people),
    env.DB.prepare("UPDATE reports SET status='done',processed_at=CURRENT_TIMESTAMP,matched_sellers=?,sales_m=?,note=?,file_path=NULL WHERE id=?")
      .bind(people.length, finiteAmount(data.sales_m), "آبان ۱۴۰۵ | روز " + data.days_elapsed +
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
    const data = await request.json();
    if (data.period_year !== 1405 || data.period_month !== 8 ||
        !Array.isArray(data.sellers) || !Array.isArray(data.stores) ||
        data.stores.length === 0 || Number(data.mehr_rows || 0) === 0 ||
        Number(data.aban_rows || 0) === 0 || data.sellers.length > 5000) {
      return json({ error: "invalid_aban_snapshot" }, 422);
    }
    const last = await env.DB.prepare("SELECT MAX(days_elapsed) AS day FROM aban_stores").first();
    if (Number(last?.day || 0) > Number(data.days_elapsed || 0)) {
      return json({ error: "report_is_older_than_current_snapshot" }, 409);
    }
    await env.DB.batch(statementsForSnapshot(env, data, reportId));
    await send(env, report.uploader_chat_id, [
      "✅ گزارش آبان پردازش و جایگزین شد.",
      "فروش تا روز " + data.days_elapsed + " آبان: " + money(data.sales_m),
      "فروشندگان: " + data.sellers.length + " | فروشگاه‌ها: " + data.stores.length,
      "تارگت‌ها بر اساس فروش کامل مهر محاسبه شدند.",
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
        return json({ ok: true, service: "Rekord Gheyrbarghi Aban", period: "1405/08", last_report: latest || null });
      }
      if (request.method === "GET" && url.pathname === "/setup") {
        const address = url.origin + "/webhook";
        const result = await bale(env, "setWebhook", { url: address });
        return json({ ok: true, webhook_url: address, bale: result });
      }
      if (request.method === "GET" && url.pathname === "/debug") {
        const info = await bale(env, "getWebhookInfo");
        const counts = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM aban_people) AS people,(SELECT COUNT(*) FROM aban_stores) AS stores,(SELECT COUNT(*) FROM aban_links) AS links,(SELECT COUNT(*) FROM reports) AS reports").first();
        return json({ ok: true, webhook: info.result || info, counts });
      }
      if (request.method === "POST" && url.pathname === "/webhook") return hook(request, env);
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.log(err?.stack || String(err));
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  },
};
