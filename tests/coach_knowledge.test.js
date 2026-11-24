import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import {readFileSync} from "node:fs";
import {kbChat,kbCreate,kbStatus,kbContext,kbList,kbCategory} from "../coach_knowledge.js";
import {knowledgeHttp} from "../coach_knowledge_http.js";
import {knowledgeAdminPage} from "../coach_knowledge_panel.js";
function mock() {
 const rules=[],logs=[],flows=new Map();let seq=0;
 const DB={prepare(sql){
  return {args:[],bind(...a){this.args=a;return this;},
   async run(){
    const a=this.args;
    if(sql.startsWith("INSERT INTO coach_kb(")){const obj={id:++seq,title:a[0],proposed_rule:a[1],public_rule:a[2],private_note:a[3],scope:a[4],store_key:a[5],category_code:a[6],level:a[7],valid_until:a[8],status:"draft"};rules.push(obj);return {meta:{last_row_id:obj.id,changes:1}};}
    if(sql.startsWith("INSERT INTO coach_kb_audit")){logs.push(a);return {meta:{changes:1}};}
    if(sql.startsWith("UPDATE coach_kb SET status")){let r=rules.find(x=>x.id===a[2]&&x.status===a[3]);if(!r)return {meta:{changes:0}};r.status=a[0];return {meta:{changes:1}};}
    if(sql.startsWith("INSERT INTO coach_kb_conversation")){flows.set(a[0],{pending_title:""});return {};}
    if(sql.startsWith("UPDATE coach_kb_conversation")){flows.set(a[1],{pending_title:a[0]});return {};}
    if(sql.startsWith("DELETE FROM coach_kb_conversation")){flows.delete(a[0]);return {};}
    return {meta:{changes:0}};
   },
   async first(){
    const a=this.args;
    if(sql.includes("FROM coach_pilot_admins"))return a[0]==="933748174"?{user_id:a[0]}:null;
    if(sql.includes("SELECT pending_title FROM coach_kb_conversation"))return flows.get(a[0])||null;
    if(sql.includes("SELECT status,public_rule FROM coach_kb"))return rules.find(x=>x.id===a[0])||null;
    return null;
   },
   async all(){
    const a=this.args;
    if(sql.includes("SELECT id,public_rule,level FROM coach_kb")){
      return {results:rules.filter(x=>x.status==="approved"&&(x.scope==="network"||
        (x.scope==="store"&&x.store_key===a[0])||(x.scope==="category"&&x.category_code===a[1])||
        (x.scope==="store_category"&&x.store_key===a[2]&&x.category_code===a[3])))
       .map(x=>({id:x.id,public_rule:x.public_rule,level:x.level}))};
    }
    if(sql.includes("FROM coach_kb ORDER BY"))return {results:rules};
    return {results:[]};
   }
  };
 },async batch(statements){for(const x of statements)await x.run();}};
 return {env:{COACH_PILOT_PREVIEW:"yes",COACH_TEST_TOKEN:"only-test",DB},rules,logs};
}
test("private manager chat creates draft only; ordinary seller cannot write",async()=>{
 const {env,rules}=mock();
 const m=txt=>({from:{id:"933748174"},chat:{type:"private",id:"933748174"},text:txt});
 assert.match(await kbChat(env,m("دانش جدید")),/عنوان/);
 assert.match(await kbChat(env,m("اولویت معرفی استیل")),/توضیح/);
 assert.match(await kbChat(env,m("دلیل حساس تجاری مربوط به تأمین‌کننده")),/پیش‌نویس/);
 assert.equal(rules.length,1);
 assert.equal(rules[0].status,"draft");
 assert.equal(rules[0].public_rule,"");
 assert.equal(await kbChat(env,{...m("سلام"),from:{id:"99991111"}}),null);
 assert.match(await kbChat(env,{...m("دانش: اطلاعات"),from:{id:"99991111"}}),/فقط برای مدیر/);
});
test("only approved public rule reaches AI; private and draft excluded, revoke removes",async()=>{
 const {env}=mock();
 await assert.rejects(kbCreate(env,"12345678",{title:"bad",proposed_rule:"note"}),/forbidden/);
 const draft=await kbCreate(env,"933748174",{title:"راهنمای قابلمه",proposed_rule:"قرارداد محرمانه",private_note:"حاشیه سود محرمانه 30%",public_rule:"ابتدا نیاز مشتری را بپرس",scope:"store_category",store_key:"ساری",category_code:"cookware"});
 assert.equal(await kbContext(env,{store_key:"ساری",category_code:"cookware"}),"");
 await kbStatus(env,"933748174",draft.id,"approved");
 const value=await kbContext(env,{store_key:"ساری",category_code:"cookware"});
 assert.match(value,/نیاز مشتری/);
 assert.doesNotMatch(value,/محرمانه|حاشیه سود|قرارداد/);
 assert.equal(await kbContext(env,{store_key:"تهران",category_code:"cookware"}),"");
 await kbStatus(env,"933748174",draft.id,"revoked");
 assert.equal(await kbContext(env,{store_key:"ساری",category_code:"cookware"}),"");
});
test("manager approval requires human-reviewed public rule",async()=>{
 const {env}=mock();
 const r=await kbCreate(env,"933748174",{title:"الف",proposed_rule:"خصوصی"});
 await assert.rejects(kbStatus(env,"933748174",r.id,"approved"),/public_rule_required/);
});
test("panel secret and verified manager are both required",async()=>{
 const {env}=mock(),u=new URL("https://preview.example/coach-kb-api/rules");
 const q=(headers={})=>new Request(u,{headers});
 assert.equal((await knowledgeHttp(q(),env,u)).status,401);
 assert.equal((await knowledgeHttp(q({"x-coach-test-token":"only-test","x-coach-admin-id":"77777777"}),env,u)).status,403);
 assert.equal((await knowledgeHttp(q({"x-coach-test-token":"only-test","x-coach-admin-id":"933748174"}),env,u)).status,200);
 assert.equal((await knowledgeHttp(q(),{...env,COACH_PILOT_PREVIEW:"no"},u)).status,404);
});
test("panel browser script parses safely; RTL and text-only DOM",()=>{
 const html=knowledgeAdminPage(),a=html.indexOf("<script>"),b=html.indexOf("</script>",a);
 assert.ok(a>=0&&b>a);
 assert.doesNotThrow(()=>new Script(html.slice(a+8,b)));
 assert.match(html,/dir="rtl"/);
 assert.match(html,/textContent/);
 assert.doesNotMatch(html,/innerHTML\s*=/);
});
test("knowledge matching follows known category names",()=>{
 assert.equal(kbCategory("سرویس قابلمه"),"cookware");
 assert.equal(kbCategory("سرویس چینی"),"tableware");
 assert.equal(kbCategory("ظروف نامشخص"),"");
});
test("worker and coach integrate the safe knowledge modules",()=>{
 const worker=readFileSync(new URL("../worker_aban.js",import.meta.url),"utf8");
 const coach=readFileSync(new URL("../coach_hooshi.js",import.meta.url),"utf8");
 assert.match(worker,/knowledgeHttp\(request,env,url\)/);
 assert.match(worker,/kbChat\(env,message\)/);
 assert.match(coach,/await kbContext\(env/);
 assert.match(coach,/env\.COACH_PILOT_PREVIEW === "yes"/);
});
