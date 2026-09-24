import ROWS from "./targets.json";

const TARGETS = ROWS.map(([store,name,baseline_m,target20_m,target30_m,target40_m]) => ({store,name,baseline_m,target20_m,target30_m,target40_m}));
const REPO="mehdimaleki509020/Rekord-mehr-bot";
const AUD="rekord-mehr-bot-processor";
const ISS="https://token.actions.githubusercontent.com";
const WREF=`${REPO}/.github/workflows/process-report.yml@refs/heads/main`;
let ready=false, seeded=false, jwks={until:0,keys:[]};

const norm=v=>String(v??"").normalize("NFKC").replace(/[يى]/g,"ی").replace(/ك/g,"ک").replace(/[ۀة]/g,"ه").replace(/[أإٱ]/g,"ا").replace(/ؤ/g,"و").replace(/[‌‎‏]/g," ").replace(/\s+/g," ").trim().toLowerCase();
const key=v=>norm(v).replace(/[^0-9A-Za-z\u0600-\u06FF]/g,"");
const token=e=>e.BALE_TOKEN||e.BALE_BOT_TOKEN||e.BOT_TOKEN||"";
const J=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json; charset=utf-8"}});
const fm=n=>Number(n||0).toLocaleString("fa-IR",{maximumFractionDigits:1});
const fp=n=>Number.isFinite(n)?`${(n*100).toLocaleString("fa-IR",{maximumFractionDigits:1})}٪`:"—";

async function api(e,m,b){const t=token(e);if(!t)throw Error("BALE TOKEN NOT FOUND");const r=await fetch(`https://tapi.bale.ai/bot${t}/${m}`,b===undefined?{}:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});const x=await r.json().catch(()=>({ok:false}));if(!r.ok||x.ok===false)throw Error(`Bale ${m}: ${x.description||r.status}`);return x}
const send=(e,c,text)=>c?api(e,"sendMessage",{chat_id:c,text}):null;

async function init(e){
 if(!e.DB)throw Error("D1 binding DB is missing");
 if(!ready){await e.DB.batch([
  e.DB.prepare("CREATE TABLE IF NOT EXISTS sellers(seller_key TEXT PRIMARY KEY,store TEXT,store_key TEXT,seller_name TEXT,baseline_m REAL,target20_m REAL,target30_m REAL,target40_m REAL)"),
  e.DB.prepare("CREATE TABLE IF NOT EXISTS links(user_id TEXT PRIMARY KEY,seller_key TEXT,linked_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
  e.DB.prepare("CREATE TABLE IF NOT EXISTS sales(seller_key TEXT PRIMARY KEY,sales_m REAL DEFAULT 0,invoices INTEGER DEFAULT 0,rows_n INTEGER DEFAULT 0,report_id INTEGER,period_year INTEGER,period_month INTEGER,days_elapsed INTEGER,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)"),
  e.DB.prepare("CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT,file_id TEXT,file_name TEXT,file_size INTEGER,file_path TEXT,uploader_user_id TEXT,uploader_chat_id TEXT,status TEXT DEFAULT 'pending',created_at TEXT DEFAULT CURRENT_TIMESTAMP,started_at TEXT,processed_at TEXT,matched_sellers INTEGER,sales_m REAL,note TEXT)"),
  e.DB.prepare("CREATE INDEX IF NOT EXISTS reports_status ON reports(status,id)"),
  e.DB.prepare("CREATE TABLE IF NOT EXISTS admins(user_id TEXT PRIMARY KEY,first_name TEXT,username TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)"),\n  e.DB.prepare("CREATE TABLE IF NOT EXISTS supervisors(user_id TEXT PRIMARY KEY,store TEXT,store_key TEXT,display_name TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)")
 ]);await e.DB.prepare("DELETE FROM sales WHERE period_year=1405 AND period_month=6").run();ready=true}
 if(!seeded){const c=await e.DB.prepare("SELECT COUNT(*) c FROM sellers").first();if(Number(c?.c||0)<TARGETS.length){const q=e.DB.prepare("INSERT OR REPLACE INTO sellers(seller_key,store,store_key,seller_name,baseline_m,target20_m,target30_m,target40_m) VALUES(?,?,?,?,?,?,?,?)");const a=TARGETS.map(t=>q.bind(key(t.name),t.store,key(t.store),t.name,t.baseline_m,t.target20_m,t.target30_m,t.target40_m));for(let i=0;i<a.length;i+=40)await e.DB.batch(a.slice(i,i+40))}seeded=true}
}

function reward(s,v){if(v>=s.target40_m)return [5,null];if(v>=s.target30_m)return [3,s.target40_m];if(v>=s.target20_m)return [1,s.target30_m];return [0,s.target20_m]}
async function myStatus(e,s){const x=await e.DB.prepare("SELECT * FROM sales WHERE seller_key=?").bind(s.seller_key).first();const v=Number(x?.sales_m||0),g=s.baseline_m?v/s.baseline_m-1:NaN,[rw,nxt]=reward(s,v),days=Number(x?.days_elapsed||0),proj=days?v*30/days:0;let t=`📊 ${s.seller_name} | ${s.store}\nفروش مهر تا امروز: ${fm(v)} میلیون تومان\nمبنای شهریور: ${fm(s.baseline_m)} میلیون تومان\nرشد مهر نسبت به شهریور: ${fp(g)}\nپاداش فعلی: ${fm(rw)} میلیون تومان`;if(nxt)t+=`\nفاصله تا پله بعد: ${fm(Math.max(0,nxt-v))} میلیون تومان`;if(days)t+=`\nپیش‌بینی ۳۰روزه: ${fm(proj)} میلیون تومان\nدوره: ${x.period_year}/${x.period_month} تا روز ${days}`;else t+="\n⚠️ هنوز گزارش فروش جدید پردازش نشده است.";return t}
async function board(e,store=""){let q="SELECT s.*,COALESCE(x.sales_m,0) sales_m FROM sellers s LEFT JOIN sales x ON x.seller_key=s.seller_key",p=[];if(store){q+=" WHERE s.store_key=?";p=[key(store)]}const r=(await e.DB.prepare(q).bind(...p).all()).results||[];if(!r.length)return "فروشگاهی پیدا نشد.";r.forEach(x=>x.g=x.baseline_m?x.sales_m/x.baseline_m-1:0);r.sort((a,b)=>b.g-a.g);return `${store?`🏆 رتبه‌بندی مهر ${r[0].store}`:"🏆 رتبه‌بندی مهر شبکه"}\n`+r.slice(0,10).map((x,i)=>`${i+1}) ${x.seller_name} — ${fp(x.g)} — ${fm(x.sales_m)}م`).join("\n")}
async function branch(e,store){
 const k=key(store),r=(await e.DB.prepare("SELECT s.*,COALESCE(x.sales_m,0) sales_m FROM sellers s LEFT JOIN sales x ON x.seller_key=s.seller_key WHERE s.store_key=?").bind(k).all()).results||[];
 if(!r.length)return `فروشگاه «${store}» پیدا نشد.`;
 const sales=r.reduce((a,x)=>a+Number(x.sales_m||0),0),b=r.reduce((a,x)=>a+Number(x.baseline_m||0),0);
 let n20=0,n30=0,n40=0,near=0;
 for(const x of r){
  const v=Number(x.sales_m||0);
  if(v>=Number(x.target40_m||0))n40++;
  else if(v>=Number(x.target30_m||0))n30++;
  else if(v>=Number(x.target20_m||0))n20++;
  const nxt=v<Number(x.target20_m||0)?Number(x.target20_m||0):v<Number(x.target30_m||0)?Number(x.target30_m||0):v<Number(x.target40_m||0)?Number(x.target40_m||0):0;
  if(nxt>0&&nxt-v<=Math.max(30,nxt*0.05))near++;
 }
 return `🏬 وضعیت مهر ${r[0].store}\nفروش مهر: ${fm(sales)} میلیون تومان\nرشد مهر نسبت به شهریور: ${fp(b?sales/b-1:0)}\nفروشندگان: ${r.length}\nپله ۲۰٪: ${n20} نفر\nپله ۳۰٪: ${n30} نفر\nپله ۴۰٪: ${n40} نفر\nنزدیک پله بعدی: ${near} نفر\n\n`+await board(e,r[0].store)
}

async function supervisorOf(e,userId){return await e.DB.prepare("SELECT * FROM supervisors WHERE user_id=?").bind(String(userId)).first()}
async function assignSupervisor(e,adminUser,m,store){
 if(!(await admin(e,adminUser,false)))return "⛔ فقط مدیر طرح می‌تواند سرپرست ثبت کند.";
 const target=m.reply_to_message?.from;
 if(!target?.id)return "برای ثبت سرپرست، در گروه روی یکی از پیام‌های همان سرپرست Reply کنید و بنویسید: ثبت سرپرست [نام شعبه]";
 const k=key(store),s=await e.DB.prepare("SELECT store FROM sellers WHERE store_key=? LIMIT 1").bind(k).first();
 if(!s)return `فروشگاه «${store}» پیدا نشد.`;
 const display=[target.first_name,target.last_name].filter(Boolean).join(" ")||target.username||String(target.id);
 await e.DB.prepare("INSERT OR REPLACE INTO supervisors(user_id,store,store_key,display_name) VALUES(?,?,?,?)").bind(String(target.id),s.store,k,display).run();
 return `✅ ${display} به‌عنوان سرپرست ${s.store} ثبت شد.`
}

async function link(e,userId,name){const k=key(name);let s=await e.DB.prepare("SELECT * FROM sellers WHERE seller_key=?").bind(k).first();if(!s){const all=(await e.DB.prepare("SELECT * FROM sellers").all()).results||[];const hits=all.filter(x=>x.seller_key.includes(k)||k.includes(x.seller_key));if(hits.length===1)s=hits[0]}if(!s)return null;await e.DB.prepare("INSERT OR REPLACE INTO links(user_id,seller_key) VALUES(?,?)").bind(String(userId),s.seller_key).run();return s}
async function admin(e,u,claim=false){const ids=String(e.ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);if(ids.includes(String(u.id)))return true;if(await e.DB.prepare("SELECT 1 x FROM admins WHERE user_id=?").bind(String(u.id)).first())return true;if(!claim)return false;const c=await e.DB.prepare("SELECT COUNT(*) c FROM admins").first();if(Number(c?.c||0))return false;await e.DB.prepare("INSERT INTO admins(user_id,first_name,username) VALUES(?,?,?)").bind(String(u.id),u.first_name||"",u.username||"").run();return true}

async function queueFile(e,m){const c=m.chat?.id,u=m.from||{},d=m.document;if(String(m.chat?.type||"")!=="private")return send(e,c,"🔒 فایل SalesReport را فقط در چت خصوصی ربات ارسال کنید.");if(!(await admin(e,u,true)))return send(e,c,"⛔ فقط مدیر طرح می‌تواند فایل فروش را بارگذاری کند.");const name=d.file_name||"SalesReport.xlsb";if(!name.toLowerCase().endsWith(".xlsb"))return send(e,c,"فایل باید گزارش خام SalesReport با پسوند .xlsb باشد.");if(Number(d.file_size||0)>20*1024*1024)return send(e,c,"حجم فایل بیشتر از ۲۰ مگابایت است.");const f=await api(e,"getFile",{file_id:d.file_id}),path=f?.result?.file_path;if(!path)throw Error("Bale getFile returned no file_path");const z=await e.DB.prepare("INSERT INTO reports(file_id,file_name,file_size,file_path,uploader_user_id,uploader_chat_id,status) VALUES(?,?,?,?,?,?,'pending')").bind(String(d.file_id||""),name,Number(d.file_size||0),path,String(u.id||""),String(c||"")).run();return send(e,c,`✅ فایل «${name}» دریافت شد.\nپردازش خودکار آغاز می‌شود. کد گزارش: ${z.meta?.last_row_id||"—"}`)}

async function hook(req,e){const up=await req.json(),m=up.message;if(!m)return new Response("OK");const c=m.chat?.id,u=m.from||{},txt=String(m.text||m.caption||"").trim();if(m.document){await queueFile(e,m);return new Response("OK")}
 const isAdmin=await admin(e,u,false),sup=await supervisorOf(e,u.id);
 if(txt==="/start"||txt==="شروع"){
  let msg="✅ ربات «رکورد غیربرقی مهر» فعال است.";
  if(isAdmin)msg+="\n\nنقش شما: مدیر طرح\n• وضعیت شعبه [نام شعبه]\n• رتبه‌بندی\n• آخرین گزارش\n• ثبت سرپرست [نام شعبه] (با Reply روی پیام سرپرست)\n• ارسال SalesReport.xlsb در چت خصوصی";
  else if(sup)msg+=`\n\nنقش شما: سرپرست ${sup.store}\n• وضعیت شعبه\n• تیم من`;
  else msg+="\n\nفروشنده:\n• ثبت نام [نام و نام خانوادگی]\n• وضعیت من";
  await send(e,c,msg);return new Response("OK")
 }
 if(/^ثبت سرپرست\s+/u.test(txt)){await send(e,c,await assignSupervisor(e,u,m,txt.replace(/^ثبت سرپرست\s+/u,"").trim()));return new Response("OK")}
 if(txt==="وضعیت من"){
  if(sup){await send(e,c,await branch(e,sup.store));return new Response("OK")}
  if(isAdmin){await send(e,c,"برای مدیر از دستور «وضعیت شعبه [نام شعبه]» یا «رتبه‌بندی» استفاده کنید.");return new Response("OK")}
  let l=await e.DB.prepare("SELECT seller_key FROM links WHERE user_id=?").bind(String(u.id)).first();
  if(!l){const auto=await link(e,u.id,`${u.first_name||""} ${u.last_name||""}`);if(auto)l={seller_key:auto.seller_key}}
  if(!l)await send(e,c,"ابتدا ثبت کنید: ثبت نام [نام و نام خانوادگی]");else{const s=await e.DB.prepare("SELECT * FROM sellers WHERE seller_key=?").bind(l.seller_key).first();await send(e,c,await myStatus(e,s))}
  return new Response("OK")
 }
 if(txt==="ثبت نام"||txt==="ثبت‌نام"){await send(e,c,"نام و نام خانوادگی را هم وارد کنید؛ مثال: ثبت نام فرزاد مقصودی");return new Response("OK")}
 if(/^ثبت[ ‌-]?نام\s+/u.test(txt)){
  if(isAdmin||sup){await send(e,c,"این حساب نقش مدیریتی/سرپرستی دارد و به‌عنوان فروشنده ثبت نمی‌شود.");return new Response("OK")}
  const s=await link(e,u.id,txt.replace(/^ثبت[ ‌-]?نام\s+/u,""));await send(e,c,s?`✅ ${s.seller_name} | ${s.store} ثبت شد.`:"نام دقیق پیدا نشد. نام و نام خانوادگی را مطابق لیست فروشندگان وارد کنید.");return new Response("OK")
 }
 if(txt==="تیم من"||txt==="وضعیت شعبه"){
  if(sup){await send(e,c,await branch(e,sup.store));return new Response("OK")}
  if(isAdmin){await send(e,c,"نام شعبه را هم وارد کنید؛ مثال: وضعیت شعبه ارومیه");return new Response("OK")}
  await send(e,c,"⛔ این دستور مخصوص سرپرست یا مدیر طرح است.");return new Response("OK")
 }
 if(txt.startsWith("وضعیت شعبه ")){
  if(sup){await send(e,c,await branch(e,sup.store));return new Response("OK")}
  if(!isAdmin){await send(e,c,"⛔ این دستور مخصوص سرپرست یا مدیر طرح است.");return new Response("OK")}
  const st=txt.slice("وضعیت شعبه".length).trim();await send(e,c,await branch(e,st));return new Response("OK")
 }
 if(txt==="رتبه‌بندی"||txt==="رتبه بندی"){
  if(!isAdmin){await send(e,c,sup?await board(e,sup.store):"⛔ رتبه‌بندی کامل فقط برای سرپرست و مدیر طرح است.");return new Response("OK")}
  await send(e,c,await board(e));return new Response("OK")
 }
 if(txt==="آخرین گزارش"){
  if(!isAdmin){await send(e,c,"⛔ این دستور مخصوص مدیر طرح است.");return new Response("OK")}
  const r=await e.DB.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT 1").first();await send(e,c,r?`آخرین گزارش #${r.id}\n${r.file_name}\nوضعیت: ${r.status}\nفروشندگان تطبیق‌شده: ${r.matched_sellers??"—"}\nفروش: ${r.sales_m!=null?fm(r.sales_m)+" میلیون تومان":"—"}`:"هنوز گزارشی ثبت نشده است.");return new Response("OK")
 }
 return new Response("OK")
}

const b64=s=>{s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a};
const dec=s=>JSON.parse(new TextDecoder().decode(b64(s)));
async function keys(){if(jwks.until>Date.now())return jwks.keys;const r=await fetch(`${ISS}/.well-known/jwks`);if(!r.ok)throw Error("OIDC JWKS unavailable");const x=await r.json();jwks={keys:x.keys||[],until:Date.now()+21600000};return jwks.keys}
async function auth(req){const h=req.headers.get("authorization")||"";if(!h.startsWith("Bearer "))return null;const p=h.slice(7).split(".");if(p.length!==3)return null;let hd,x;try{hd=dec(p[0]);x=dec(p[1])}catch{return null}const now=Math.floor(Date.now()/1000),aud=Array.isArray(x.aud)?x.aud:[x.aud];if(x.iss!==ISS||!aud.includes(AUD)||x.repository!==REPO||x.ref!=="refs/heads/main"||x.workflow_ref!==WREF||!x.exp||x.exp<now)return null;const j=(await keys()).find(k=>k.kid===hd.kid);if(!j)return null;try{const k=await crypto.subtle.importKey("jwk",j,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);return await crypto.subtle.verify({name:"RSASSA-PKCS1-v1_5"},k,b64(p[2]),new TextEncoder().encode(`${p[0]}.${p[1]}`))?x:null}catch{return null}}

async function proc(req,e,url){if(!(await auth(req)))return J({ok:false,error:"unauthorized"},401);
 if(req.method==="GET"&&url.pathname==="/processor/pending"){await e.DB.prepare("UPDATE reports SET status='pending',started_at=NULL WHERE status='processing' AND started_at < datetime('now','-30 minutes')").run();const r=await e.DB.prepare("SELECT id,file_name,file_size,created_at FROM reports WHERE status='pending' ORDER BY id LIMIT 1").first();if(!r)return J({ok:true,job:null});await e.DB.prepare("UPDATE reports SET status='processing',started_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(r.id).run();return J({ok:true,job:r})}
 let m=url.pathname.match(/^\/processor\/jobs\/(\d+)\/file$/);if(req.method==="GET"&&m){const r=await e.DB.prepare("SELECT * FROM reports WHERE id=?").bind(Number(m[1])).first();if(!r?.file_path)return J({error:"not_found"},404);const z=await fetch(`https://tapi.bale.ai/file/bot${token(e)}/${r.file_path}`);if(!z.ok)return J({error:`bale_${z.status}`},502);return new Response(z.body,{headers:{"content-type":"application/octet-stream"}})}
 m=url.pathname.match(/^\/processor\/jobs\/(\d+)\/result$/);if(req.method==="POST"&&m){const id=Number(m[1]),r=await e.DB.prepare("SELECT * FROM reports WHERE id=?").bind(id).first();if(!r)return J({error:"not_found"},404);const b=await req.json(),py=Number(b.period_year||0),pm=Number(b.period_month||0),tot=Array.isArray(b.totals)?b.totals:[];if(py!==1405||pm!==7){await e.DB.prepare("UPDATE reports SET status='reference',processed_at=CURRENT_TIMESTAMP,matched_sellers=?,sales_m=?,note=?,file_path=NULL WHERE id=?").bind(Number(b.matched_sellers||0),Number(b.sales_m||0),`دوره ${py}/${pm} مرجع است و در فروش مهر لحاظ نشد.`,id).run();await send(e,r.uploader_chat_id,`ℹ️ گزارش ${py}/${pm} پردازش شد، اما چون مربوط به مهر ۱۴۰۵ نیست در فروش جاری و پاداش‌ها لحاظ نشد.\nاین فایل فقط به‌عنوان مرجع نگه‌داری شد.\nفروشندگان تطبیق‌شده: ${Number(b.matched_sellers||0)} از ۹۲`);return J({ok:true,saved:0,reference:true,period_year:py,period_month:pm})}const q=e.DB.prepare("INSERT OR REPLACE INTO sales(seller_key,sales_m,invoices,rows_n,report_id,period_year,period_month,days_elapsed,updated_at) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)");const a=[];for(const x of tot){const k=key(x.seller_name||"");if(k)a.push(q.bind(k,Number(x.sales_m||0),Number(x.invoice_count||0),Number(x.row_count||0),id,py,pm,Number(b.days_elapsed||0)))}for(let i=0;i<a.length;i+=40)await e.DB.batch(a.slice(i,i+40));await e.DB.prepare("UPDATE reports SET status='done',processed_at=CURRENT_TIMESTAMP,matched_sellers=?,sales_m=?,note=?,file_path=NULL WHERE id=?").bind(Number(b.matched_sellers||0),Number(b.sales_m||0),String(b.note||"").slice(0,3000),id).run();await send(e,r.uploader_chat_id,`✅ گزارش فروش مهر پردازش شد.\nفروشندگان تطبیق‌شده: ${Number(b.matched_sellers||0)} از ۹۲\nفروش مهر افراد طرح: ${fm(b.sales_m)} میلیون تومان\nدوره: ${py}/${pm} تا روز ${b.days_elapsed}`);return J({ok:true,saved:a.length})}
 m=url.pathname.match(/^\/processor\/jobs\/(\d+)\/error$/);if(req.method==="POST"&&m){const b=await req.json().catch(()=>({})),id=Number(m[1]);await e.DB.prepare("UPDATE reports SET status='error',processed_at=CURRENT_TIMESTAMP,note=? WHERE id=?").bind(String(b.error||"processor error").slice(0,1000),id).run();return J({ok:true})}
 return J({error:"not_found"},404)
}

export default {async fetch(req,e){const u=new URL(req.url);try{await init(e);if(u.pathname.startsWith("/processor/"))return proc(req,e,u);if(req.method==="GET"&&u.pathname==="/"){const r=await e.DB.prepare("SELECT id,status,processed_at FROM reports ORDER BY id DESC LIMIT 1").first();return J({ok:true,service:"Rekord Mehr Bot",targets:92,last_report:r||null})}if(req.method==="GET"&&u.pathname==="/setup"){const w=`${u.origin}/webhook`,x=await api(e,"setWebhook",{url:w});return J({ok:true,webhook_url:w,bale:x})}if(req.method==="GET"&&u.pathname==="/debug"){const x=await api(e,"getWebhookInfo");const c=await e.DB.prepare("SELECT (SELECT COUNT(*) FROM sellers) sellers,(SELECT COUNT(*) FROM links) links,(SELECT COUNT(*) FROM reports) reports").first();return J({ok:true,webhook:x.result||x,counts:c})}if(req.method==="POST"&&u.pathname==="/webhook")return hook(req,e);return new Response("Not Found",{status:404})}catch(err){console.log(err?.stack||String(err));return J({ok:false,error:String(err?.message||err)},500)}}};
