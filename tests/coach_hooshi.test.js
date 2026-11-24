import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const worker = readFileSync(new URL("../worker_aban.js", import.meta.url),"utf8");
const coach = readFileSync(new URL("../coach_hooshi.js", import.meta.url),"utf8");
test("coach feature is disabled by default",()=>assert.match(worker,/env\.COACH_ENABLED !== "true"/));
test("coach uses secret and private chat",()=>{assert.match(coach,/env\.HOOSHI_API_KEY/);assert.match(coach,/message\.chat\?\.type !== "private"/);});
test("coach cannot fabricate stock or missing metrics",()=>{assert.match(coach,/درباره آن‌ها عددسازی نکن/);assert.match(coach,/categoryContext/);});
test("coach does not expose secret in source",()=>assert.doesNotMatch(coach,/sk-[A-Za-z0-9]{20}/));

test("seller can delete own chat without a provider key or approved registration", async () => {
  const { coachMessage } = await import("../coach_hooshi.js");
  const statements = [];
  const DB = {
    prepare(sql) {
      const stmt = {bind(...args) {this.args=args;return this;},async run() {statements.push({sql,args:this.args||[]});return {};}};
      stmt.sql=sql;
      return stmt;
    },
    async batch(items) {
      for (const stmt of items) await stmt.run();
    }
  };
  const result = await coachMessage({DB},{
    from:{id:"12345"},chat:{id:"12345",type:"private"},text:"پاکسازی مربی"
  },async()=>{throw Error("must not check registration for deletion")});
  assert.match(result,/پاک شد/);
  assert.ok(statements.some(x=>x.sql.includes("DELETE FROM coach_messages") && x.args[0]==="12345"));
  assert.ok(statements.some(x=>x.sql.includes("DELETE FROM coach_sessions") && x.args[0]==="12345"));
});

test("approved seller can continue coaching with an unprefixed product answer only in Preview", async () => {
  const { coachMessage } = await import("../coach_hooshi.js");
  const oldFetch = globalThis.fetch;
  const requests = [];
  const statements = [];
  globalThis.fetch = async (_url,options) => {
    const body=JSON.parse(options.body);
    requests.push(body);
    return {ok:true,async json(){return {choices:[{message:{content:"برای سرویس قابلمه، ابتدا نیاز مشتری را مشخص کن."}}]}}};
  };
  const DB={
    prepare(sql){
      return {
        sql, args:[],
        bind(...args){this.args=args;return this;},
        async run(){statements.push({sql,args:this.args});return {success:true};},
        async first(){
          if (sql.includes("RETURNING requests")) return {requests:1};
          return null;
        },
        async all(){
          if (sql.includes("SELECT role,content FROM coach_messages")) return {
            results:[{role:"assistant",content:"امروز روی کدام گروه کالا تمرکز می‌کنی؟"}]
          };
          return {results:[]};
        }
      };
    },
    async batch(items){
      for (const item of items) await item.run();
      return [];
    }
  };
  const seller={seller_key:"sample:person",store:"شعبه آزمایشی",mehr_m:100,aban_m:150,days_elapsed:30};
  try{
    const msg={from:{id:122333},chat:{id:122333,type:"private"},text:"سرویس‌های قابلمه"};
    const answer=await coachMessage({
      DB,COACH_PILOT_PREVIEW:"yes",HOOSHI_API_KEY:"mock-key"
    },msg,async()=>seller);
    assert.match(answer,/سرویس قابلمه/);
    assert.equal(requests.length,1);
    const turns=requests[0].messages;
    assert.equal(turns.at(-1).content,"سرویس‌های قابلمه");
    assert.match(turns.at(-2).content,/کدام گروه کالا/);
    assert.ok(statements.some(x=>x.sql.includes("INSERT INTO coach_messages") && x.args.includes("سرویس‌های قابلمه")));
    const ignored=await coachMessage({DB,HOOSHI_API_KEY:"mock-key"},msg,async()=>seller);
    assert.equal(ignored,null,"Production must never route arbitrary personal messages");
    const group=await coachMessage({DB,COACH_PILOT_PREVIEW:"yes",HOOSHI_API_KEY:"mock-key"},
      {...msg,chat:{id:-123,type:"group"}},async()=>seller);
    assert.match(group,/فقط در گفت‌وگوی خصوصی/);
  } finally{
    globalThis.fetch=oldFetch;
  }
});

test("reasoning budget exhaustion retries once without leaking seller data to logs", async () => {
  const { coachMessage } = await import("../coach_hooshi.js");
  const oldFetch=globalThis.fetch, oldLog=console.log;
  const sent=[], logs=[], dbWrites=[];
  globalThis.fetch=async (_,options)=>{
    const request=JSON.parse(options.body);
    sent.push(request);
    return {ok:true,async json(){
      if(sent.length===1) return {
        choices:[{finish_reason:"length",message:{content:""}}],
        usage:{completion_tokens:1200,completion_tokens_details:{reasoning_tokens:1200}}
      };
      return {choices:[{finish_reason:"stop",message:{content:"برای پخت برنج ابتدا ظرفیت مناسب قابلمه را با توجه به مقدار برنج بررسی کنید."}}]};
    }};
  };
  console.log=(...args)=>logs.push(JSON.stringify(args));
  const DB={
    prepare(sql){
      return {
        args:[],bind(...args){this.args=args;return this;},
        async run(){dbWrites.push({sql,args:this.args});return {success:true};},
        async first(){return sql.includes("RETURNING requests")?{requests:1}:null;},
        async all(){return {results:sql.includes("SELECT role,content FROM coach_messages")?
          [{role:"assistant",content:"برای چه غذایی می‌خواهید قابلمه؟"}]:[]};}
      };
    },async batch(items){for(const stmt of items)await stmt.run();}
  };
  try{
    const answer=await coachMessage({
      DB,COACH_PILOT_PREVIEW:"yes",HOOSHI_API_KEY:"fake-secret"
    },{from:{id:12345},chat:{id:12345,type:"private"},text:"برنج"},
    async()=>({seller_key:"sample:person",store:"فروشگاه ساختگی",mehr_m:200,aban_m:220,days_elapsed:30}));
    assert.match(answer,/پخت برنج/);
    assert.equal(sent.length,2);
    assert.equal(sent[0].max_tokens,1200);
    assert.equal(sent[1].max_tokens,1800);
    assert.equal(sent[1].messages.at(-1).content,"برنج");
    assert.match(sent[1].messages.at(-2).content,/چه غذایی/);
    assert.ok(dbWrites.some(x=>x.sql.includes("INSERT INTO coach_messages")&&x.args.includes("برنج")));
    assert.ok(logs.some(x=>x.includes("Hooshi empty completion")));
    assert.ok(logs.every(x=>!x.includes("فروشگاه ساختگی")&&!x.includes("fake-secret")));
  } finally{globalThis.fetch=oldFetch;console.log=oldLog;}
});

test("empty non-length completion retries only once and never writes misleading chat history",async()=>{
  const { coachMessage }=await import("../coach_hooshi.js");
  const oldFetch=globalThis.fetch,oldLog=console.log;
  const logs=[],writes=[],calls=[];
  console.log=(...x)=>logs.push(x);
  globalThis.fetch=async(_url,options)=>{
    calls.push(JSON.parse(options.body));
    return {ok:true,async json(){return {choices:[{finish_reason:"stop",message:{content:null}}]}}};
  };
  const DB={
    prepare(sql){return {args:[],bind(...a){this.args=a;return this;},
      async run(){writes.push(sql);},
      async first(){return sql.includes("RETURNING requests")?{requests:1}:null;},
      async all(){return {results:[]}}};},
    async batch(items){for(const x of items)await x.run();}
  };
  try{
    const result=await coachMessage({DB,HOOSHI_API_KEY:"mock",COACH_PILOT_PREVIEW:"yes"},
      {from:{id:123},chat:{id:123,type:"private"},text:"برنج"},
      async()=>({seller_key:"example:person",store:"شعبه فرضی",mehr_m:120,aban_m:140,days_elapsed:30}));
    assert.match(result,/پاسخ هوشی در این نوبت کامل نشد/);
    assert.equal(calls.length,2);
    assert.ok(!writes.some(x=>x.includes("INSERT INTO coach_messages")));
  } finally{globalThis.fetch=oldFetch;console.log=oldLog;}
});

test("failed Hooshi completion refunds exactly one quota slot and keeps user identity",async()=>{
 const {coachMessage}=await import("../coach_hooshi.js");
 const originalFetch=globalThis.fetch, originalLog=console.log;
 const statements=[], limits=[];
 globalThis.fetch=async()=>({ok:true,async json(){return {choices:[{finish_reason:"stop",message:{content:null}}]}}});
 console.log=()=>{};
 const DB={
   prepare(sql){return {sql,args:[],bind(...a){this.args=a;return this;},
     async run(){statements.push({sql,args:this.args});return {};},
     async first(){if(sql.includes("RETURNING requests")){limits.push(this.args[1]);return {requests:13};}return null;},
     async all(){return {results:[]}}};},
   async batch(items){for(const x of items)await x.run();}
 };
 try{
   const response=await coachMessage({DB,COACH_PILOT_PREVIEW:"yes",HOOSHI_API_KEY:"mock"},
     {from:{id:12345},chat:{id:12345,type:"private"},text:"برنج"},
     async()=>({seller_key:"example:seller",store:"شعبه",mehr_m:1,aban_m:2,days_elapsed:30}));
   assert.match(response,/پاسخ هوشی در این نوبت کامل نشد/);
   assert.deepEqual(limits,[60],"existing 12-message balance must no longer block coaching");
   const refunds=statements.filter(x=>x.sql.includes("requests=MAX(0,requests-1)"));
   assert.equal(refunds.length,1);
   assert.equal(refunds[0].args[0],"12345");
   assert.ok(!statements.some(x=>x.sql.includes("INSERT INTO coach_messages")));
 }finally{globalThis.fetch=originalFetch;console.log=originalLog;}
});
test("successful coaching does not refund quota",async()=>{
 const {coachMessage}=await import("../coach_hooshi.js");
 const originalFetch=globalThis.fetch;
 const statements=[];
 globalThis.fetch=async()=>({ok:true,async json(){return {choices:[{finish_reason:"stop",message:{content:"برای برنج، نوع پخت را مشخص کنید."}}]}}});
 const DB={
  prepare(sql){return {sql,args:[],bind(...a){this.args=a;return this;},
    async run(){statements.push(sql);return {};},
    async first(){return sql.includes("RETURNING requests")?{requests:14}:null;},
    async all(){return {results:[]}}};},
  async batch(items){for(const x of items)await x.run();}
 };
 try{
   const response=await coachMessage({DB,COACH_PILOT_PREVIEW:"yes",HOOSHI_API_KEY:"mock"},
     {from:{id:12346},chat:{id:12346,type:"private"},text:"برنج"},
     async()=>({seller_key:"example:seller2",store:"شعبه",mehr_m:1,aban_m:2,days_elapsed:30}));
   assert.match(response,/برای برنج/);
   assert.ok(!statements.some(x=>x.includes("requests=MAX(0,requests-1)")));
 }finally{globalThis.fetch=originalFetch;}
});
