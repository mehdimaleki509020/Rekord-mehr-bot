import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {ensureOps,opsContext,opsHttp,opsUpload,dispatchOps,validateOpsRow} from "../coach_ops.js";
import worker from "../worker_aban.js";

function fixture(){
 const db=new DatabaseSync(":memory:");
 const DB={
  prepare(sql){
   const s=db.prepare(sql);
   return {args:[],bind(...args){this.args=args;return this;},
    async first(){return s.get(...this.args)||null;},
    async all(){return {results:s.all(...this.args)};},
    async run(){let r=s.run(...this.args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
   };
  },
  async batch(items){
   db.exec("BEGIN");
   try{let out=[];for(const s of items)out.push(await s.run());db.exec("COMMIT");return out;}
   catch(e){db.exec("ROLLBACK");throw e;}
  }
 };
 return {env:{DB,COACH_PILOT_PREVIEW:"yes",BALE_TEST_BOT_TOKEN:"fictional-preview-token"},db};
}
const row=(kind,over={})=>({kind,store_key:"testbranch",seller_key:kind==="sales"?"testbranch:person":"",group_code:kind==="sales"||kind==="inventory"?"cookware":"all",sku:kind==="inventory"?"SKU-A":"",period:"1405-09",date_from:"1405-09-01",date_to:"1405-09-01",value:12,label:kind==="inventory"?"کالای نمونه":"",...over});
async function queued(env,id){
 await ensureOps(env);
 await env.DB.prepare("INSERT INTO coach_ops_reports(bale_id,file_id,file_name,file_path,file_size,admin_id,chat_id) VALUES(?,?,?,?,?,?,?)").bind("file"+id,"fid"+id,"sample.xlsx","docs/sample.xlsx",100,"123","123").run();
}
const base="https://test.invalid/coach-ops-processor/";
async function req(env,path,data={},lease="",opts={}){
 const request=new Request(base+path,{method:"POST",headers:{"content-type":"application/json","x-coach-ops-lease":lease},body:JSON.stringify(data)});
 const res=await opsHttp(request,env,new URL(request.url),{authorize:async()=>true,send:async()=>{},...opts});
 return {status:res.status,body:await res.json()};
}
async function ready(env,id,kind,rows,hash=String(id).padStart(64,"0")){
 await queued(env,id);
 const job=(await req(env,"pending")).body.job;
 const start=await req(env,"jobs/"+job.id+"/begin",{kind,hash,count:rows.length},job.lease);
 if(start.body.duplicate)return start.body;
 const root="jobs/"+job.id+"/";
 assert.equal(start.status,200);
 assert.equal((await req(env,root+"batch",{rows},job.lease)).status,200);
 assert.equal((await req(env,root+"finish",{},job.lease)).status,200);
 return job;
}
const person={store_key:"testbranch",seller_key:"testbranch:person"};
test("operations routes are closed in production and anonymous access is denied",async()=>{
 for(const [env,status] of [[{},404],[{COACH_PILOT_PREVIEW:"yes"},401]]){
  const r=await worker.fetch(new Request(base+"pending",{method:"POST"}),env);
  assert.equal(r.status,status);
 }
});
test("dispatch never selects main, and no production dispatch",async()=>{
 let calls=[];
 const f=async(url,opts)=>{calls.push({url,opts});return {ok:true};};
 assert.equal((await dispatchOps({GITHUB_ACTIONS_TOKEN:"fake"},f)).ok,false);
 assert.equal((await dispatchOps({COACH_PILOT_PREVIEW:"yes"},f)).reason,"not_configured");
 assert.equal((await dispatchOps({COACH_PILOT_PREVIEW:"yes",GITHUB_ACTIONS_TOKEN:"fake"},f)).ok,true);
 assert.equal(calls.length,1);
 assert.equal(JSON.parse(calls[0].opts.body).ref,"feature/hooshi-coach-bale-new-preview");
});
test("private approved manager receives file exactly once; non-admin is denied",async()=>{
 const {env,db}=fixture();let sent=[],gets=0,dispatches=0;
 const msg={from:{id:123},chat:{id:123,type:"private"},document:{file_id:"a",file_unique_id:"u",file_name:"report.xlsb",file_size:100}};
 const config={isAdmin:async()=>true,getFile:async()=>{gets++;return {result:{file_path:"docs/file.xlsb"}};},send:async(_e,_c,t)=>sent.push(t),dispatch:async()=>{dispatches++;return {ok:true};}};
 await opsUpload(env,{...msg,chat:{id:-123,type:"group"}},config);
 await opsUpload(env,msg,{...config,isAdmin:async()=>false});
 assert.equal(gets,0);
 await opsUpload(env,msg,config);await opsUpload(env,msg,config);
 assert.equal(gets,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM coach_ops_reports").get().n,1);
 assert.match(sent.at(-1),/قبلاً/);
 db.close();
});
test("staged data is invisible until fully validated; bad lease and incomplete finish rejected",async()=>{
 const {env,db}=fixture();
 await queued(env,1);
 const job=(await req(env,"pending")).body.job,root="jobs/"+job.id+"/";
 assert.equal((await req(env,root+"begin",{kind:"sales",hash:"1".repeat(64),count:2},"wrong")).status,409);
 assert.equal((await req(env,root+"begin",{kind:"sales",hash:"1".repeat(64),count:2},job.lease)).status,200);
 await req(env,root+"batch",{rows:[row("sales")]},job.lease);
 assert.equal((await req(env,root+"finish",{},job.lease)).status,409);
 assert.equal((await opsContext(env,person,"cookware")).hasSales,false);
 assert.equal((await req(env,root+"batch",{rows:[row("sales",{seller_key:"otherbranch:other"})]},job.lease)).status,422);
 await req(env,root+"batch",{rows:[row("sales",{seller_key:""})]},job.lease);
 assert.equal((await req(env,root+"finish",{},job.lease)).status,200);
 assert.equal((await opsContext(env,person)).hasSales,true);
 db.close();
});
test("irregular uploads: old and duplicate reports do not replace newer snapshots; corrections do",async()=>{
 const {env,db}=fixture();
 const sales=(day,value)=>[row("sales",{date_to:day,value}),row("sales",{date_to:day,value:value+500,seller_key:""}),row("sales",{date_to:day,value:77777,seller_key:"testbranch:otherperson"})];
 await ready(env,1,"sales",sales("1405-09-19",123));
 await ready(env,2,"sales",sales("1405-09-05",9));
 await ready(env,3,"sales",sales("1405-09-19",456));
 const dupe=await ready(env,4,"sales",sales("1405-09-19",456),String(3).padStart(64,"0"));
 assert.equal(dupe.duplicate,true);
 const result=await opsContext(env,person);
 assert.match(result.text,/1405-09-19/);
 assert.match(result.text,/۴۵۶/);
 assert.doesNotMatch(result.text,/۱۲۳|۷۷٬۷۷۷|۹۵۶|1405-09-05/);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM coach_ops_reports WHERE status='ready'").get().n,3);
 db.close();
});
test("branch-scoped historical inventory and dated traffic; no old stock revived and no monthly target confusion",async()=>{
 const {env,db}=fixture();
 await ready(env,1,"inventory",[row("inventory",{date_from:"1405-09-03",date_to:"1405-09-03",sku:"OLD-SKU",value:30})]);
 await ready(env,2,"inventory",[row("inventory",{date_from:"1405-09-14",date_to:"1405-09-14",sku:"NEW-SKU",value:5}),row("inventory",{store_key:"otherbranch",date_from:"1405-09-14",date_to:"1405-09-14",sku:"SECRET-SKU",value:9})]);
 await ready(env,3,"traffic",[row("traffic",{date_from:"1405-09-10",date_to:"1405-09-10",value:190})]);
 await ready(env,4,"plan",[row("plan",{date_to:"1405-09-30",value:500})]);
 const r=await opsContext(env,person,"cookware");
 assert.match(r.text,/NEW-SKU/);assert.doesNotMatch(r.text,/OLD-SKU|SECRET-SKU/);
 assert.match(r.text,/1405-09-14/);assert.match(r.text,/موجودی قطعی امروز نیست/);
 assert.match(r.text,/1405-09-10/);assert.match(r.text,/پاخور روزانه کل شعبه/);
 assert.match(r.text,/تارگت فردی نیست/);
 db.close();
});
test("row validator rejects mixed units, dates and cross-branch identities",()=>{
 assert.equal(validateOpsRow(row("sales",{value:-0.5}),"sales"),true);
 assert.equal(validateOpsRow(row("inventory",{value:1.5}),"inventory"),false);
 assert.equal(validateOpsRow(row("traffic",{date_to:"1405-09-31"}),"traffic"),false);
 assert.equal(validateOpsRow(row("sales",{seller_key:"elsewhere:person"}),"sales"),false);
 assert.equal(validateOpsRow(row("plan",{value:-1}),"plan"),false);
});
