// Private managerial knowledge. Available ONLY in isolated Coach Preview.
const trim=x=>String(x??"").trim();
const text=x=>trim(x).slice(0,3000);
const scopes=new Set(["network","store","category","store_category"]);
const levels=new Set(["mandatory","preference","hypothesis"]);
export async function ensureKB(env){
 await env.DB.batch([
 env.DB.prepare("CREATE TABLE IF NOT EXISTS coach_kb(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,proposed_rule TEXT NOT NULL,public_rule TEXT NOT NULL DEFAULT '',private_note TEXT NOT NULL DEFAULT '',scope TEXT NOT NULL DEFAULT 'network',store_key TEXT NOT NULL DEFAULT '',category_code TEXT NOT NULL DEFAULT '',level TEXT NOT NULL DEFAULT 'preference',status TEXT NOT NULL DEFAULT 'draft',valid_until TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,approved_by TEXT NOT NULL DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP, CHECK(status IN ('draft','approved','revoked')))"),
 env.DB.prepare("CREATE TABLE IF NOT EXISTS coach_kb_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,rule_id INTEGER,actor_id TEXT,action TEXT,at TEXT DEFAULT CURRENT_TIMESTAMP)"),
 env.DB.prepare("CREATE TABLE IF NOT EXISTS coach_kb_conversation(admin_id TEXT PRIMARY KEY,pending_title TEXT NOT NULL DEFAULT '')")
 ]);
}
export async function kbManager(env,id){
 if(env.COACH_PILOT_PREVIEW!=="yes"||!/^[0-9]{4,20}$/.test(String(id||"")))return false;
 await ensureKB(env);
 return Boolean(await env.DB.prepare("SELECT user_id FROM coach_pilot_admins WHERE user_id=?").bind(String(id)).first());
}
function norm(r){
 if(!r||typeof r!=="object")throw Error("invalid_rule");
 const out={title:text(r.title).slice(0,120),proposed_rule:text(r.proposed_rule),public_rule:text(r.public_rule),private_note:text(r.private_note),scope:trim(r.scope||"network"),store_key:trim(r.store_key),category_code:trim(r.category_code),level:trim(r.level||"preference"),valid_until:trim(r.valid_until)};
 if(!out.title||!out.proposed_rule||!scopes.has(out.scope)||!levels.has(out.level)||
    (out.valid_until&&!/^20\d{2}-\d{2}-\d{2}$/.test(out.valid_until))||
    (out.scope.includes("store")&&!out.store_key)||(out.scope.includes("category")&&!out.category_code)||
    out.store_key.length>100||out.category_code.length>100)throw Error("invalid_rule");
 return out;
}
async function audit(env,id,actor,action){await env.DB.prepare("INSERT INTO coach_kb_audit(rule_id,actor_id,action) VALUES(?,?,?)").bind(id,String(actor),action).run();}
export async function kbCreate(env,id,input){
 if(!await kbManager(env,id))throw Error("forbidden");
 const r=norm(input);
 const p=await env.DB.prepare("INSERT INTO coach_kb(title,proposed_rule,public_rule,private_note,scope,store_key,category_code,level,valid_until,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(r.title,r.proposed_rule,r.public_rule,r.private_note,r.scope,r.store_key,r.category_code,r.level,r.valid_until,String(id)).run();
 const rid=Number(p.meta?.last_row_id);
 if(!Number.isSafeInteger(rid)||rid<1)throw Error("insert_failed");
 await audit(env,rid,id,"created");
 return {ok:true,id:rid,status:"draft"};
}
export async function kbList(env,id){
 if(!await kbManager(env,id))throw Error("forbidden");
 return (await env.DB.prepare("SELECT id,title,proposed_rule,public_rule,private_note,scope,store_key,category_code,level,status,valid_until,created_at FROM coach_kb ORDER BY id DESC LIMIT 150").all()).results||[];
}
export async function kbEdit(env,id,rid,input){
 if(!await kbManager(env,id))throw Error("forbidden");
 const r=norm(input),n=Number(rid);
 if(!Number.isSafeInteger(n)||n<1)throw Error("invalid_id");
 const changed=await env.DB.prepare("UPDATE coach_kb SET title=?,proposed_rule=?,public_rule=?,private_note=?,scope=?,store_key=?,category_code=?,level=?,valid_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'").bind(r.title,r.proposed_rule,r.public_rule,r.private_note,r.scope,r.store_key,r.category_code,r.level,r.valid_until,n).run();
 if(!changed.meta?.changes)throw Error("not_editable");
 await audit(env,n,id,"edited");return {ok:true,id:n,status:"draft"};
}
export async function kbStatus(env,id,rid,status){
 if(!await kbManager(env,id))throw Error("forbidden");
 const n=Number(rid);
 if(!Number.isSafeInteger(n)||n<1||!["approved","revoked"].includes(status))throw Error("invalid_status");
 const existing=await env.DB.prepare("SELECT status,public_rule FROM coach_kb WHERE id=?").bind(n).first();
 if(!existing)throw Error("not_found");
 if(status==="approved"&&existing.status!=="draft")throw Error("not_editable");
 if(status==="approved"&&!trim(existing.public_rule))throw Error("public_rule_required");
 if(status==="revoked"&&existing.status==="revoked")throw Error("already_revoked");
 const res=await env.DB.prepare("UPDATE coach_kb SET status=?,approved_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?").bind(status,String(id),n,existing.status).run();
 if(!res.meta?.changes)throw Error("concurrent_change");
 await audit(env,n,id,status);return {ok:true,id:n,status};
}
// Only reviewed public_rule is ever given to the outside AI service.
export async function kbContext(env,{store_key="",category_code=""}={}){
 if(env.COACH_PILOT_PREVIEW!=="yes")return "";
 await ensureKB(env);
 const store=trim(store_key),cat=trim(category_code);
 const rows=(await env.DB.prepare("SELECT id,public_rule,level FROM coach_kb WHERE status='approved' AND (valid_until='' OR valid_until>=date('now')) AND (scope='network' OR (scope='store' AND store_key=?) OR (scope='category' AND category_code=?) OR (scope='store_category' AND store_key=? AND category_code=?)) ORDER BY CASE level WHEN 'mandatory' THEN 0 WHEN 'preference' THEN 1 ELSE 2 END,id DESC LIMIT 8").bind(store,cat,store,cat).all()).results||[];
 if(!rows.length)return "";
 return ["قواعد داخلی تأییدشده که فقط برای این فروشنده و این گروه مرتبط‌اند:",
 ...rows.map(x=>"KB-"+Number(x.id)+" ["+x.level+"]: "+text(x.public_rule)),
 "فرضیه‌ها واقعیت قطعی نیستند؛ موجودی و قیمت و سلامت کالا را بدون داده معتبر اعلام نکن."].join("\n");
}
export function kbCategory(question){
 const t=trim(question).replace(/[يى]/g,"ی");
 if(/قابلمه|ماهی.?تابه|تابه|استیل|چدن|گرانیت|برنج|پخت.?و.?پز/.test(t))return "cookware";
 if(/چینی|آرکوپال|اپال|پذیرایی/.test(t))return "tableware";
 if(/بلور|شیشه|لیوان|کریستال/.test(t))return "glassware";
 if(/نظم.?دهنده|نگهداری/.test(t))return "storage";
 return "";
}
export async function kbChat(env,message){
 if(env.COACH_PILOT_PREVIEW!=="yes"||message.chat?.type!=="private")return null;
 const id=String(message.from?.id||""),msg=trim(message.text);
 if(!msg)return null;
 const isCommand=msg==="دانش جدید"||msg==="لغو دانش"||msg.startsWith("دانش:")||msg.startsWith("عنوان:")||msg.startsWith("یادداشت:");
 if(!await kbManager(env,id))return isCommand?"ثبت دانش فقط برای مدیر پایلوت مجاز است.":null;
 const active=await env.DB.prepare("SELECT pending_title FROM coach_kb_conversation WHERE admin_id=?").bind(id).first();
 if(!isCommand&&!active)return null;
 if(msg==="لغو دانش"){await env.DB.prepare("DELETE FROM coach_kb_conversation WHERE admin_id=?").bind(id).run();return "ثبت دانش ناتمام لغو شد.";}
 if(msg==="دانش جدید"){
  await env.DB.prepare("INSERT INTO coach_kb_conversation(admin_id,pending_title) VALUES(?,'') ON CONFLICT(admin_id) DO UPDATE SET pending_title=''").bind(id).run();
  return "عنوان نکته را به زبان فارسی بنویسید.";
 }
 if(msg.startsWith("دانش:")){
  const note=text(msg.slice(5));if(!note)return "بعد از «دانش:» نکته را بنویسید.";
  const r=await kbCreate(env,id,{title:note.slice(0,75),proposed_rule:note,private_note:note});
  return "پیش‌نویس دانش شماره "+r.id+" ثبت شد. برای قابل‌استفاده‌شدن باید در پنل، متن مجاز به انتشار را جداگانه تأیید کنید.";
 }
 if(active&&!active.pending_title){
  const title=text(msg.replace(/^عنوان:/,"")).slice(0,120);
  if(!title)return "عنوان را بنویسید.";
  await env.DB.prepare("UPDATE coach_kb_conversation SET pending_title=? WHERE admin_id=?").bind(title,id).run();
  return "اکنون توضیح و ملاحظات محرمانه را به زبان خودتان بنویسید.";
 }
 if(active?.pending_title){
  const note=text(msg.replace(/^یادداشت:/,""));if(!note)return "متن یادداشت را بنویسید.";
  const r=await kbCreate(env,id,{title:active.pending_title,proposed_rule:note,private_note:note});
  await env.DB.prepare("DELETE FROM coach_kb_conversation WHERE admin_id=?").bind(id).run();
  return "پیش‌نویس "+r.id+" ثبت شد؛ هنوز به هوشی منتقل نمی‌شود. در پنل تأیید کنید.";
 }
 return null;
}