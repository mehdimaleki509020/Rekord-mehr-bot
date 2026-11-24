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
