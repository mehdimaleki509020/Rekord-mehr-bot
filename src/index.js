
import * as XLSX from "xlsx";
import { streamXlsbRows, assertSmallArchive } from "./xlsb-stream.js";
import { validateTargets } from "./validation.js";

const schemas = new WeakMap();
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export default {
  async fetch(request, bindings) {
    const env = { ...bindings };
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "rekord-mehr-bot", version: "2.2.0" });
    }
    if (url.pathname.startsWith("/admin/")) {
      if (!env.ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return json({error:"Unauthorized"},401);
      try { return await adminRequest(request, env, url); }
      catch { return json({error:"Administrative operation failed"},500); }
    }
    if (request.method !== "POST" || !env.WEBHOOK_SECRET || url.pathname !== `/webhook/${env.WEBHOOK_SECRET}`) return new Response("Not found", {status:404});
    if (!env.DB || !botToken(env) || !env.BALE_GROUP_CHAT_ID || !env.BALE_ADMIN_IDS) return json({error:"Configuration incomplete"},503);
    let update;
    try { update = JSON.parse(await limitedText(request, 128 * 1024)); }
    catch { return json({error:"Invalid update"},400); }
    const msg = update.message;
    if (!msg?.chat?.id || !msg.from?.id) return new Response("ok");
    const chatId=String(msg.chat.id);
    const admin=isAdmin(env,msg.from.id);
    if (chatId !== String(env.BALE_GROUP_CHAT_ID) && !(msg.chat.type === "private" && admin)) return new Response("ok");
    await ensureSchema(env);
    if (msg.document?.file_id) {
      if (!admin) { await sendMessage(env,chatId,"بارگذاری گزارش فروش فقط برای مدیر ربات فعال است.",msg.message_id); return new Response("ok"); }
      const doc=msg.document;
      if (Number(doc.file_size||0)>MAX_FILE_BYTES) { await sendMessage(env,chatId,"❌ حجم فایل بیشتر از 20MB است.",msg.message_id); return new Response("ok"); }
      const fileName=doc.file_name||"SalesReport";
      if (!["xlsb","xlsx","xls","csv"].includes(fileName.toLowerCase().split(".").pop())) { await sendMessage(env,chatId,"❌ فایل SalesReport باید XLSB / XLSX / XLS / CSV باشد.",msg.message_id); return new Response("ok"); }
      if (!env.IMPORT_QUEUE) return json({error:"Import queue unavailable"},503);
      await env.IMPORT_QUEUE.send({chatId,replyTo:msg.message_id,fileId:doc.file_id,fileUniqueId:doc.file_unique_id||"",fileName,uploaderId:String(msg.from.id),uploaderName:fullName(msg.from),sourceTime:Number(msg.date||0)});
      // An acknowledgement delivery failure must not enqueue the report a second time.
      await sendMessage(env,chatId,`⏳ فایل «${fileName}» دریافت شد؛ در حال پردازش SalesReport...`,msg.message_id).catch(()=>{});
      return new Response("ok");
    }
    const text=String(msg.text||"").trim();
    if (!text) return new Response("ok");
    await loadTargets(env);
    await handleText(env,msg,text);
    return new Response("ok");
  },
  async queue(batch, bindings) {
    const env={...bindings};
    await ensureSchema(env);
    await loadTargets(env);
    for (const message of batch.messages) {
      try { await processImport(env,message.body); message.ack(); }
      catch(err) {
        if (err instanceof ReportError || Number(message.attempts||1)>=4) {
          const job=message.body||{};
          if(job.chatId) await sendMessage(env,job.chatId,err instanceof ReportError ? `❌ ${err.message}` : "❌ پردازش فایل به علت خطای ارتباطی کامل نشد؛ دوباره ارسال کنید.",job.replyTo).catch(()=>{});
          message.ack();
        } else message.retry({delaySeconds:30});
      }
    }
  }
};

class ReportError extends Error {}
function botToken(env) { return env.BALE_BOT_TOKEN || env.BALE_TOKEN || env.BOT_TOKEN; }
function isAdmin(env,id) { return String(env.BALE_ADMIN_IDS||"").split(",").map(x=>x.trim()).includes(String(id)); }
async function limitedBytes(source,limit) {
  if(Number(source.headers.get("content-length")||0)>limit) throw new ReportError("حجم فایل بیش از حد مجاز است.");
  const reader=source.body?.getReader();
  if(!reader) return new Uint8Array();
  const chunks=[]; let size=0;
  while(true) { const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>limit) { await reader.cancel(); throw new ReportError("حجم فایل بیش از حد مجاز است."); } chunks.push(value); }
  const out=new Uint8Array(size); let at=0; for(const c of chunks) { out.set(c,at); at+=c.length; } return out;
}
async function limitedText(source,limit) { return new TextDecoder().decode(await limitedBytes(source,limit)); }
async function loadTargets(env) {
  const rows=(await env.DB.prepare("SELECT * FROM targets").all()).results||[];
  env.targets=rows.map(r=>({store:r.store_name,seller:r.seller_name,baseline:r.baseline_m,t20:r.target20_m,r20:r.reward20_m,t30:r.target30_m,r30:r.reward30_m,t40:r.target40_m,r40:r.reward40_m}));
  validateTargets(env.targets);
  env.targetIndex=buildTargetIndex(env.targets);
}
async function adminRequest(request,env,url) {
  await ensureSchema(env);
  if (url.pathname==="/admin/health" && request.method==="GET") {
    const count=await env.DB.prepare("SELECT COUNT(*) n FROM targets").first();
    const last=await env.DB.prepare("SELECT max_day,matched_targets,created_at FROM uploads ORDER BY id DESC LIMIT 1").first();
    return json({ok:true,targets:count.n,last_upload:last,queue:!!env.IMPORT_QUEUE,token:!!botToken(env),webhook:!!env.WEBHOOK_SECRET,group:!!env.BALE_GROUP_CHAT_ID,admins:!!env.BALE_ADMIN_IDS});
  }
  if (url.pathname==="/admin/targets" && request.method==="POST") {
    let targets;
    try { targets=JSON.parse(await limitedText(request,128*1024)); validateTargets(targets); } catch { return json({error:"Expected 92 valid targets"},400); }
    const existing=(await env.DB.prepare("SELECT seller_key FROM targets").all()).results||[];
    const keys=new Set(targets.map(t=>sellerKey(t.store,t.seller)));
    if(existing.some(t=>!keys.has(t.seller_key))) return json({error:"Roster changes require a reviewed migration"},409);
    await env.DB.batch(targets.map(t=>env.DB.prepare(`INSERT INTO targets(seller_key,store_name,seller_name,baseline_m,target20_m,reward20_m,target30_m,reward30_m,target40_m,reward40_m)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(seller_key) DO UPDATE SET baseline_m=excluded.baseline_m,target20_m=excluded.target20_m,reward20_m=excluded.reward20_m,target30_m=excluded.target30_m,reward30_m=excluded.reward30_m,target40_m=excluded.target40_m,reward40_m=excluded.reward40_m`).bind(sellerKey(t.store,t.seller),t.store,t.seller,t.baseline,t.t20,t.r20,t.t30,t.r30,t.t40,t.r40)));
    return json({ok:true,targets:targets.length});
  }
  if(url.pathname==="/admin/setup" && request.method==="POST") {
    await loadTargets(env);
    if(!env.WEBHOOK_SECRET || !env.IMPORT_QUEUE || !env.BALE_GROUP_CHAT_ID || !env.BALE_ADMIN_IDS) return json({error:"Configuration incomplete"},503);
    const me=await baleApi(env,"getMe");
    const expected=`${url.origin}/webhook/${env.WEBHOOK_SECRET}`;
    await baleApi(env,"setWebhook",{url:expected});
    const info=await baleApi(env,"getWebhookInfo");
    return json({ok:info.url===expected,bot_username:me.username,webhook_matches:info.url===expected,pending_updates:info.pending_update_count||0});
  }
  return json({error:"Not found"},404);
}

async function handleText(env, msg, text) {
  const chatId = String(msg.chat?.id ?? "");
  const replyTo = msg.message_id;
  const userId = String(msg.from?.id ?? "");
  const low = normalizeText(text.replace(/^\/(\w+)@\w+/, "/$1"));

  if (["start","شروع رکورد مهر","راهنما","help"].includes(low)) {
    await sendMessage(env, chatId,
`✅ ربات «رکورد غیربرقی مهر» فعال است.

• فایل خام SalesReport را همین‌جا ارسال کنید؛ ربات فروش مهر 92 فروشنده را به‌روزرسانی می‌کند.
• «وضعیت من» یا /me
• «من نام و نام‌خانوادگی» برای اتصال یک‌باره حساب بله به نام فروشنده
• «وضعیت نام فروشنده»
• «گزارش» یا /stats
• «رتبه‌بندی» یا /rank`, replyTo);
    return;
  }

  if (low === "stats" || low === "گزارش") {
    await sendMessage(env, chatId, await buildStats(env), replyTo);
    return;
  }

  if (low === "rank" || low === "رتبه بندی" || low === "رتبه‌بندی") {
    await sendMessage(env, chatId, await buildRank(env), replyTo);
    return;
  }

  if (low === "me" || low === "وضعیت من") {
    const linked = await env.DB.prepare(`
      SELECT t.*, p.sales_m, p.max_day, p.updated_at
      FROM user_links u JOIN targets t ON t.seller_key=u.seller_key
      LEFT JOIN performance p ON p.seller_key=t.seller_key
      WHERE u.user_id=?
    `).bind(userId).first();

    if (linked) {
      await sendMessage(env, chatId, formatSellerStatus(linked), replyTo);
      return;
    }

    const guessed = resolveTargetForPerson(env.targetIndex, fullName(msg.from || {}));
    if (guessed) {
      await linkUser(env, userId, guessed.sellerKey, fullName(msg.from || {}));
      const row = await getTargetStatus(env, guessed.sellerKey);
      await sendMessage(env, chatId, formatSellerStatus(row), replyTo);
    } else {
      await sendMessage(env, chatId, "برای اتصال یک‌باره بنویس:\nمن نام و نام‌خانوادگی\nمثال: من فرزاد مقصودی", replyTo);
    }
    return;
  }

  const meMatch = text.match(/^\s*من\s+(.+?)\s*$/u);
  if (meMatch) {
    const q = meMatch[1];
    const resolved = resolveTargetForPerson(env.targetIndex, q);
    if (!resolved) {
      await sendMessage(env, chatId, `نام «${q}» در فهرست 92 فروشنده پیدا نشد. نام و نام خانوادگی را مطابق فهرست وارد کنید.`, replyTo);
      return;
    }
    await linkUser(env, userId, resolved.sellerKey, fullName(msg.from || {}));
    const row = await getTargetStatus(env, resolved.sellerKey);
    await sendMessage(env, chatId, `✅ حساب بله به «${resolved.seller}» متصل شد.\n\n${formatSellerStatus(row)}`, replyTo);
    return;
  }

  const statusMatch = text.match(/^\s*(?:وضعیت|هدف)\s+(.+?)\s*$/u);
  if (statusMatch) {
    const resolved = resolveTargetForPerson(env.targetIndex, statusMatch[1]);
    if (!resolved) {
      await sendMessage(env, chatId, `فروشنده «${statusMatch[1]}» پیدا نشد.`, replyTo);
      return;
    }
    const row = await getTargetStatus(env, resolved.sellerKey);
    await sendMessage(env, chatId, formatSellerStatus(row), replyTo);
  }
}

async function processImport(env, job) {
  if (!isAdmin(env,job.uploaderId)) throw new ReportError("اجازه بارگذاری گزارش وجود ندارد.");
  const file = await baleApi(env, "getFile", { file_id: job.fileId });
  const path = file?.file_path;
  if (!path || !/^[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes("..")) throw new ReportError("بله مسیر فایل را برنگرداند.");

  const resp = await fetch(`https://tapi.bale.ai/file/bot${botToken(env)}/${path}`);
  if (!resp.ok) throw new Error(`دانلود فایل از بله ناموفق بود (${resp.status})`);
  const bytes = await limitedBytes(resp,MAX_FILE_BYTES);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
  const receiptKey=`${env.CAMPAIGN_YEAR||1405}:${env.CAMPAIGN_MONTH||7}:${hash}`;
  const previous=await env.DB.prepare("SELECT * FROM import_receipts WHERE receipt_key=?").bind(receiptKey).first();
  if(previous) {
    if(!previous.notified) { await sendMessage(env,job.chatId,previous.summary,job.replyTo); await env.DB.prepare("UPDATE import_receipts SET notified=1 WHERE receipt_key=?").bind(receiptKey).run(); }
    return;
  }

  const year=Number(env.CAMPAIGN_YEAR||1405),month=Number(env.CAMPAIGN_MONTH||7);
  let result;
  if(job.fileName.toLowerCase().endsWith('.xlsb')) {
    try { result=aggregateXlsb(bytes,year,month,env.targetIndex); }
    catch(e) { if(e instanceof ReportError)throw e;throw new ReportError("فایل XLSB قابل پردازش نیست یا از محدودیت ساختار مجاز عبور کرده است."); }
  } else {
    if(bytes.length>2*1024*1024)throw new ReportError("برای گزارش بزرگ، همان فایل خام XLSB را ارسال کنید.");
    try { assertSmallArchive(bytes); } catch { throw new ReportError("ساختار فایل بزرگ یا نامعتبر است؛ همان فایل خام XLSB را ارسال کنید."); }
  let sheetNames;
  try {
    const meta = XLSX.read(bytes, { type: "array", bookSheets: true });
    sheetNames = meta.SheetNames || [];
  } catch (e) {
    throw new ReportError("فایل Excel قابل خواندن نیست.");
  }
  if (!sheetNames.length) throw new ReportError("فایل هیچ Sheet قابل خواندنی ندارد.");

  // Parse one sheet at a time and aggregate in chunks. This avoids creating a
  // second in-memory copy of a large SalesReport (important for Workers' 128MB limit).
  let parsed = null;
  for (const sheetName of sheetNames) {
    let workbook;
    try {
      workbook = XLSX.read(bytes, {
        type: "array",
        sheets: [sheetName],
        dense: true,
        cellDates: false,
        cellFormula: false,
        cellHTML: false,
        cellNF: false,
        cellStyles: false,
        cellText: false,
        bookVBA: false
      });
    } catch (_) {
      continue;
    }
    const sheet = workbook.Sheets[sheetName];
    const candidate = parseSalesSheet(sheet);
    if (candidate && (!parsed || candidate.score > parsed.score)) {
      parsed = { ...candidate, sheetName, sheet };
      if (candidate.score === 7) break;
    }
  }
  if (!parsed) throw new ReportError("ستون‌های موردنیاز SalesReport پیدا نشد.");

    result=aggregateCampaignSheet(parsed.sheet,parsed.headerRow,year,month,env.targetIndex);
  }
  if (result.periodRows === 0) throw new ReportError(`در فایل، داده‌ای برای ماه ${month} سال ${year} پیدا نشد.`);

  if(!result.matchedCount || !result.nonElectricRows) throw new ReportError("هیچ فروشنده واجد شرایطی شناسایی نشد؛ گزارش قبلی حفظ شد.");
  const last=await env.DB.prepare("SELECT max_day, source_time FROM import_receipts WHERE year=? AND month=? ORDER BY max_day DESC,source_time DESC LIMIT 1").bind(year,month).first();
  if(last && (result.maxDay<last.max_day || (result.maxDay===last.max_day && Number(job.sourceTime||0)<last.source_time))) throw new ReportError("این فایل از گزارش ثبت‌شده قدیمی‌تر است؛ گزارش قبلی حفظ شد.");
  const now=new Date().toISOString();
  const summary=buildImportSummary(env,result,job.fileName);
  const statements=[env.DB.prepare(`INSERT INTO uploads(file_id,file_unique_id,file_name,chat_id,message_id,uploader_id,uploader_name,year,month,max_day,matched_targets,source_rows,non_electric_rows,total_sales_m,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(job.fileId,job.fileUniqueId||"",job.fileName,String(job.chatId),Number(job.replyTo||0),job.uploaderId||"",job.uploaderName||"",year,month,result.maxDay,result.matchedCount,result.periodRows,result.nonElectricRows,result.totalMatchedSales,now)];
  for(const t of env.targets) {
    const key=sellerKey(t.store,t.seller);
    statements.push(env.DB.prepare(`INSERT INTO performance(seller_key,sales_m,max_day,year,month,updated_at,source_upload_id)
      VALUES(?,?,?,?,?,?,(SELECT MAX(id) FROM uploads)) ON CONFLICT(seller_key) DO UPDATE SET sales_m=excluded.sales_m,max_day=excluded.max_day,year=excluded.year,month=excluded.month,updated_at=excluded.updated_at,source_upload_id=excluded.source_upload_id`).bind(key,result.salesByKey.get(key)||0,result.maxDay,year,month,now));
  }
  statements.push(env.DB.prepare("INSERT INTO import_receipts(receipt_key,year,month,max_day,source_time,summary,notified) VALUES(?,?,?,?,?,?,0)").bind(receiptKey,year,month,result.maxDay,Number(job.sourceTime||0),summary));
  // Queue concurrency is one. One transactional batch prevents partial roster writes.
  await env.DB.batch(statements);
  await sendMessage(env,job.chatId,summary,job.replyTo);
  await env.DB.prepare("UPDATE import_receipts SET notified=1 WHERE receipt_key=?").bind(receiptKey).run();
}

function parseSalesSheet(sheet) {
  if (!sheet?.["!ref"]) return null;
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (range.e.r < 1) return null;
  const sample = XLSX.utils.sheet_to_json(sheet, {
    header: 1, raw: true, defval: null, blankrows: true,
    range: { s: { r: 0, c: 0 }, e: { r: Math.min(range.e.r, 39), c: range.e.c } }
  });
  const wanted = ["شماره ماه","سال","ph11","مشاور فروش","مبلغ کل صحیح","روز","نام فروشگاه"];
  let best = null;
  for (let r=0; r<sample.length; r++) {
    const row = sample[r] || [];
    const map = new Map();
    for (let c=0;c<row.length;c++) {
      const h = normalizeHeader(row[c]);
      if (h) map.set(h,c);
    }
    let score=0;
    for (const w of wanted) if (findHeaderIndex(map,w) >= 0) score++;
    if (!best || score > best.score) best = { score, row:r };
  }
  if (!best || best.score < 7) return null;
  return { score: best.score, headerRow: best.row, range };
}

function aggregateCampaignSheet(sheet, headerRow, year, month, index) {
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const headerRows = XLSX.utils.sheet_to_json(sheet, {
    header: 1, raw: true, defval: null, blankrows: true,
    range: { s: { r: headerRow, c: 0 }, e: { r: headerRow, c: range.e.c } }
  });
  const hdr = headerRows[0] || [];
  const accumulator=createAccumulator(hdr,year,month,index);
  for(let start=headerRow+1;start<=range.e.r;start+=2500) {
    const rows=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:null,blankrows:false,range:{s:{r:start,c:0},e:{r:Math.min(range.e.r,start+2499),c:range.e.c}}});
    for(const row of rows) accumulator.add(row);
  }
  return accumulator.finish();
}
function createAccumulator(hdr,year,month,index) {
  const map = new Map();
  hdr.forEach((v,i)=>{ const n=normalizeHeader(v); if(n) map.set(n,i); });

  const ix = {
    month: mustIndex(map,"شماره ماه"),
    year: mustIndex(map,"سال"),
    ph11: mustIndex(map,"ph11"),
    seller: mustIndex(map,"مشاور فروش"),
    amount: mustIndex(map,"مبلغ کل صحیح"),
    day: mustIndex(map,"روز"),
    store: mustIndex(map,"نام فروشگاه")
  };

  const salesByKey = new Map();
  const matchedTargetKeys = new Set();
  let maxDay=0, periodRows=0, nonElectricRows=0, totalMatchedSales=0;
  return { add(row) {
      if (num(row[ix.year]) !== year || num(row[ix.month]) !== month) return;
      periodRows++;
      const day=num(row[ix.day]);
      if(!Number.isInteger(day) || day<1 || day>30) throw new ReportError("روز گزارش مهر باید بین 1 و 30 باشد.");
      maxDay = Math.max(maxDay,day);
      if (normalizeText(row[ix.ph11]) !== normalizeText("خانگی غیر برقی")) return;
      nonElectricRows++;

      const rawSeller = row[ix.seller];
      const rawStore = row[ix.store];
      if (!String(rawSeller ?? "").trim()) return;

      const target = resolveTarget(index, rawStore, rawSeller);
      if (!target) return;

      const amountRial = num(row[ix.amount]);
      if(!Number.isFinite(amountRial) || String(row[ix.amount]??"").trim()==="") throw new ReportError("مبلغ نامعتبر در ردیف فروش پیدا شد؛ گزارش قبلی حفظ شد.");
      const amountMillionToman = amountRial / 10_000_000;
      const key = target.sellerKey;
      salesByKey.set(key, (salesByKey.get(key) || 0) + amountMillionToman);
      matchedTargetKeys.add(key);
      totalMatchedSales += amountMillionToman;
  }, finish() {
  return {
    salesByKey,
    matchedCount: matchedTargetKeys.size,
    maxDay,
    periodRows,
    nonElectricRows,
    totalMatchedSales
  };

  }};
}

function resolveTarget(index, rawStore, rawSeller) {
  const store = normalizeName(rawStore);
  const candidates = index.byStore.get(store) || [];
  if (!candidates.length) return null;

  const n = normalizeName(rawSeller);
  const c = compactName(rawSeller);
  const s = tokenSetKey(rawSeller);

  let m = candidates.filter(x => x.nameNorm === n);
  if (m.length === 1) return m[0];
  m = candidates.filter(x => x.compact === c);
  if (m.length === 1) return m[0];
  m = candidates.filter(x => x.tokenSet === s);
  if (m.length === 1) return m[0];

  // Handles repeated full names such as "مهدیه دلخواسته مهدیه دلخواسته".
  m = candidates.filter(x => c.length > x.compact.length && c.length % x.compact.length === 0 && x.compact.repeat(c.length/x.compact.length) === c);
  if (m.length === 1) return m[0];
  return null;
}

function resolveTargetForPerson(index, name) {
  const n = normalizeName(name), c = compactName(name), s = tokenSetKey(name);
  let m = index.all.filter(x => x.nameNorm === n);
  if (m.length === 1) return m[0];
  m = index.all.filter(x => x.compact === c);
  if (m.length === 1) return m[0];
  m = index.all.filter(x => x.tokenSet === s);
  if (m.length === 1) return m[0];

  return null;
}

function buildTargetIndex(targets) {
  const byStore = new Map(), all=[];
  for (const t of targets) {
    const x = {
      ...t,
      sellerKey: sellerKey(t.store,t.seller),
      storeNorm: normalizeName(t.store),
      nameNorm: normalizeName(t.seller),
      compact: compactName(t.seller),
      tokenSet: tokenSetKey(t.seller)
    };
    if (!byStore.has(x.storeNorm)) byStore.set(x.storeNorm,[]);
    byStore.get(x.storeNorm).push(x);
    all.push(x);
  }
  return { byStore, all };
}

async function ensureSchema(env) {
  if(!env.DB) throw new Error("Database unavailable");
  if(!schemas.has(env.DB)) {
    const promise=env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS targets(seller_key TEXT PRIMARY KEY,store_name TEXT NOT NULL,seller_name TEXT NOT NULL,baseline_m REAL NOT NULL,target20_m REAL NOT NULL,reward20_m REAL NOT NULL,target30_m REAL NOT NULL,reward30_m REAL NOT NULL,target40_m REAL NOT NULL,reward40_m REAL NOT NULL)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS performance(seller_key TEXT PRIMARY KEY,sales_m REAL NOT NULL DEFAULT 0,max_day INTEGER NOT NULL DEFAULT 0,year INTEGER,month INTEGER,updated_at TEXT,source_upload_id INTEGER)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_links(user_id TEXT PRIMARY KEY,seller_key TEXT NOT NULL,bale_name TEXT,updated_at TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS uploads(id INTEGER PRIMARY KEY AUTOINCREMENT,file_id TEXT,file_unique_id TEXT,file_name TEXT,chat_id TEXT,message_id INTEGER,uploader_id TEXT,uploader_name TEXT,year INTEGER,month INTEGER,max_day INTEGER,matched_targets INTEGER,source_rows INTEGER,non_electric_rows INTEGER,total_sales_m REAL,created_at TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS import_receipts(receipt_key TEXT PRIMARY KEY,year INTEGER,month INTEGER,max_day INTEGER,source_time INTEGER,summary TEXT,notified INTEGER NOT NULL DEFAULT 0)`)
    ]).catch(e=>{schemas.delete(env.DB);throw e;});
    schemas.set(env.DB,promise);
  }
  await schemas.get(env.DB);
}

function buildImportSummary(env, result, fileName) {
  const stats={hit20:0,hit30:0,hit40:0,total_sales:result.totalMatchedSales};
  for(const t of env.targets) {
    const sales=result.salesByKey.get(sellerKey(t.store,t.seller))||0;
    if(sales>=t.t20) stats.hit20++;
    if(sales>=t.t30) stats.hit30++;
    if(sales>=t.t40) stats.hit40++;
  }
  return [
    "✅ SalesReport با موفقیت پردازش شد.",
    `📄 ${fileName}`,
    `📅 فروش مهر تا روز ${result.maxDay || 0}`,
    `👥 فروشندگان شناسایی‌شده: ${result.matchedCount}/92`,
    `💰 فروش غیربرقی 92 نفر: ${fmt1(stats.total_sales)} میلیون تومان`,
    "",
    `🏅 رسیده به سطح 20٪: ${stats.hit20 || 0} نفر`,
    `🥈 رسیده به سطح 30٪: ${stats.hit30 || 0} نفر`,
    `🥇 رسیده به سطح 40٪: ${stats.hit40 || 0} نفر`,
    "",
    "برای وضعیت شخصی: «وضعیت من»",
    "برای رتبه‌بندی: /rank"
  ].join("\n");
}

async function buildStats(env) {
  const last = await env.DB.prepare("SELECT * FROM uploads ORDER BY id DESC LIMIT 1").first();
  if (!last) return "هنوز فایل SalesReport مهر بارگذاری نشده است.";

  const rows = await env.DB.prepare(`
    SELECT t.*, COALESCE(p.sales_m,0) sales_m, COALESCE(p.max_day,0) max_day
    FROM targets t LEFT JOIN performance p ON p.seller_key=t.seller_key
  `).all();
  const list = rows.results || [];
  const day = Number(last.max_day || 0);
  let total=0, h20=0,h30=0,h40=0,reward=0;
  for (const r of list) {
    const s=Number(r.sales_m||0); total+=s;
    if (s>=r.target40_m){h40++;h30++;h20++;reward+=r.reward40_m;}
    else if (s>=r.target30_m){h30++;h20++;reward+=r.reward30_m;}
    else if (s>=r.target20_m){h20++;reward+=r.reward20_m;}
  }
  return [
    `📊 گزارش رکورد مهر — تا روز ${day}`,
    `👥 پوشش فایل: ${last.matched_targets}/92 فروشنده`,
    `💰 فروش تجمیعی: ${fmt1(total)} میلیون تومان`,
    `🏅 سطح 20٪: ${h20} نفر`,
    `🥈 سطح 30٪: ${h30} نفر`,
    `🥇 سطح 40٪: ${h40} نفر`,
    `🎁 پاداش بر مبنای فروش فعلی: ${fmt1(reward)} میلیون تومان`,
    `🕒 آخرین به‌روزرسانی: ${shortDate(last.created_at)}`
  ].join("\n");
}

async function buildRank(env) {
  const rows = await env.DB.prepare(`
    SELECT t.*, COALESCE(p.sales_m,0) sales_m, COALESCE(p.max_day,0) max_day
    FROM targets t LEFT JOIN performance p ON p.seller_key=t.seller_key
  `).all();
  const list = (rows.results || []).filter(r=>Number(r.max_day||0)>0);
  if (!list.length) return "هنوز SalesReport مهر بارگذاری نشده است.";

  const ranked = list.map(r=>{
    const day=Number(r.max_day||1), sales=Number(r.sales_m||0);
    const pace20 = r.target20_m > 0 ? (sales / (r.target20_m * day / 30)) : 0;
    const proj = sales/day*30;
    const growth = r.baseline_m>0 ? (proj/r.baseline_m-1)*100 : 0;
    return {...r,pace20,proj,growth};
  }).sort((a,b)=>b.pace20-a.pace20).slice(0,10);

  const lines=["🏆 رتبه‌بندی مسیر تحقق سطح 20٪"];
  ranked.forEach((r,i)=>lines.push(`${i+1}. ${r.seller_name} — ${r.store_name} — ${Math.round(r.pace20*100)}٪ مسیر — پیش‌بینی رشد ${signed(r.growth)}٪`));
  return lines.join("\n");
}

async function getTargetStatus(env, key) {
  return env.DB.prepare(`
    SELECT t.*, COALESCE(p.sales_m,0) sales_m, COALESCE(p.max_day,0) max_day, p.updated_at
    FROM targets t LEFT JOIN performance p ON p.seller_key=t.seller_key WHERE t.seller_key=?
  `).bind(key).first();
}

function formatSellerStatus(r) {
  if (!r) return "فروشنده پیدا نشد.";
  const sales=Number(r.sales_m||0), day=Number(r.max_day||0);
  if (!day) return `👤 ${r.seller_name} — ${r.store_name}\n🎯 هدف‌ها: ${fmt0(r.target20_m)} / ${fmt0(r.target30_m)} / ${fmt0(r.target40_m)} میلیون تومان\n🎁 پاداش‌ها: 1 / 3 / 5 میلیون تومان\nهنوز SalesReport مهر بارگذاری نشده است.`;

  let reward=0, level="هنوز به سطح 20٪ نرسیده";
  let next=Number(r.target20_m);
  if (sales>=Number(r.target40_m)){reward=Number(r.reward40_m);level="سطح 40٪";next=null;}
  else if (sales>=Number(r.target30_m)){reward=Number(r.reward30_m);level="سطح 30٪";next=Number(r.target40_m);}
  else if (sales>=Number(r.target20_m)){reward=Number(r.reward20_m);level="سطح 20٪";next=Number(r.target30_m);}

  const proj=sales/day*30;
  const growth=(proj/Number(r.baseline_m)-1)*100;
  const lines=[
    `👤 ${r.seller_name} — ${r.store_name}`,
    `📅 فروش تا روز ${day} مهر: ${fmt1(sales)} میلیون تومان`,
    `🎯 هدف‌ها: ${fmt0(r.target20_m)} / ${fmt0(r.target30_m)} / ${fmt0(r.target40_m)} میلیون`,
    `📈 پیش‌بینی پایان ماه با همین ریتم: ${fmt1(proj)} میلیون (${signed(growth)}٪ نسبت به شهریور)`,
    `🏅 وضعیت فعلی: ${level}`,
    `🎁 پاداش بر مبنای فروش فعلی: ${fmt1(reward)} میلیون تومان`
  ];
  if (next) {
    const gap=Math.max(0,next-sales), remain=Math.max(0,30-day);
    lines.push(`➡️ فاصله تا پله بعد: ${fmt1(gap)} میلیون`);
    if(remain>0) lines.push(`⚡ فروش روزانه لازم تا پایان ماه: ${fmt1(gap/remain)} میلیون`);
  } else lines.push("🔥 بالاترین پله پاداش محقق شده است.");
  return lines.join("\n");
}

async function linkUser(env, userId, key, baleName) {
  await env.DB.prepare(`
    INSERT INTO user_links(user_id,seller_key,bale_name,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET seller_key=excluded.seller_key,bale_name=excluded.bale_name,updated_at=excluded.updated_at
  `).bind(userId,key,baleName||"",new Date().toISOString()).run();
}

async function baleApi(env, method, payload={}) {
  const body = new URLSearchParams();
  for (const [k,v] of Object.entries(payload)) if (v !== undefined && v !== null) body.set(k,String(v));
  const r=await fetch(`https://tapi.bale.ai/bot${botToken(env)}/${method}`,{method:"POST",body});
  const p=await r.json().catch(()=>null);
  if(!r.ok || !p?.ok) throw new Error(p?.description || `Bale ${method} failed (${r.status})`);
  return p.result;
}

async function sendMessage(env, chatId, text, replyTo) {
  const p={chat_id:String(chatId),text:String(text).split("\n").map(line=>"\u200f"+line).join("\n")};
  if(replyTo) p.reply_to_message_id=String(replyTo);
  return baleApi(env,"sendMessage",p);
}

function normalizeHeader(v) {
  return normalizeText(v).replace(/\s+/g," ");
}
function findHeaderIndex(map, wanted) {
  const w=normalizeHeader(wanted);
  if(map.has(w)) return map.get(w);
  for(const [k,i] of map.entries()) if(k.replace(/\s/g,"")===w.replace(/\s/g,"")) return i;
  return -1;
}
function mustIndex(map,w) {
  const i=findHeaderIndex(map,w);
  if(i<0) throw new ReportError(`ستون «${w}» پیدا نشد.`);
  return i;
}
function normalizeText(v) {
  return String(v ?? "")
    .normalize("NFKC")
    .replace(/[يى]/g,"ی").replace(/ك/g,"ک").replace(/[ۀة]/g,"ه")
    .replace(/ؤ/g,"و").replace(/[إأٱآ]/g,"ا")
    .replace(/[\u200c\u200d\u200e\u200f\u2066-\u2069]/g," ")
    .replace(/[\u064b-\u065f\u0670\u06d6-\u06ed]/g,"")
    .replace(/[-–—_./\\,،؛:;()]+/g," ")
    .replace(/\s+/g," ").trim().toLowerCase();
}
function normalizeName(v){ return normalizeText(v); }
function compactName(v){ return normalizeName(v).replace(/\s/g,""); }
function tokenSetKey(v){ return [...new Set(normalizeName(v).split(" ").filter(Boolean))].sort().join(" "); }
function sellerKey(store,seller){ return `${normalizeName(store)}|${normalizeName(seller)}`; }
function num(v) {
  if(typeof v==="number") return Number.isFinite(v)?v:NaN;
  const s=String(v??"").replace(/[٬,]/g,"").replace(/[۰-۹]/g,ch=>"۰۱۲۳۴۵۶۷۸۹".indexOf(ch)).replace(/[٠-٩]/g,ch=>"٠١٢٣٤٥٦٧٨٩".indexOf(ch));
  const n=Number(s); return Number.isFinite(n)?n:NaN;
}
function fullName(frm){ return [frm.first_name||"",frm.last_name||""].filter(Boolean).join(" ").trim(); }
function fmt1(n){ return new Intl.NumberFormat("en-US",{maximumFractionDigits:1,minimumFractionDigits:0}).format(Number(n||0)); }
function fmt0(n){ return new Intl.NumberFormat("en-US",{maximumFractionDigits:0}).format(Number(n||0)); }
function signed(n){ const x=Math.round(Number(n||0)); return `${x>=0?"+":""}${x}`; }
function shortDate(s){ return s ? String(s).replace("T"," ").slice(0,16) : "-"; }
function safeError(e){ return String(e?.message||e||"خطای نامشخص").slice(0,500); }
function json(x,status=200){return new Response(JSON.stringify(x),{status,headers:{"content-type":"application/json; charset=utf-8"}});}

export { parseSalesSheet, aggregateCampaignSheet, buildTargetIndex, resolveTarget, resolveTargetForPerson, formatSellerStatus, normalizeText, sellerKey, processImport, ensureSchema, loadTargets, handleText, ReportError };

function aggregateXlsb(bytes,year,month,index) {
  let accumulator=null;
  streamXlsbRows(bytes,()=>{
    if(accumulator)return null;
    let selected=false;
    return (row,rowNumber)=>{
      if(selected){accumulator.add(row);return;}
      if(rowNumber>=40)return;
      try {accumulator=createAccumulator(row,year,month,index);selected=true;}catch(e){if(!(e instanceof ReportError))throw e;}
    };
  });
  if(!accumulator)throw new ReportError("ستون‌های موردنیاز SalesReport پیدا نشد.");
  return accumulator.finish();
}
export { aggregateXlsb };
