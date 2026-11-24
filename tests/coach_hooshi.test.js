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
