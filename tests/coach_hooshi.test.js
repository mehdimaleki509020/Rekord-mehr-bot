import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const worker = readFileSync(new URL("../worker_aban.js", import.meta.url),"utf8");
const coach = readFileSync(new URL("../coach_hooshi.js", import.meta.url),"utf8");
test("coach feature is disabled by default",()=>assert.match(worker,/env\.COACH_ENABLED !== "true"/));
test("coach uses secret and private chat",()=>{assert.match(coach,/env\.HOOSHI_API_KEY/);assert.match(coach,/message\.chat\?\.type !== "private"/);});
test("coach cannot fabricate stock or missing metrics",()=>{assert.match(coach,/درباره آن‌ها عددسازی نکن/);assert.match(coach,/categoryContext/);});
test("coach does not expose secret in source",()=>assert.doesNotMatch(coach,/sk-[A-Za-z0-9]{20}/));
