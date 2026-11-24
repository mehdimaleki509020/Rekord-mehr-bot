import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const worker = readFileSync(new URL("../worker_aban.js", import.meta.url),"utf8");
const coach = readFileSync(new URL("../coach_hooshi.js", import.meta.url),"utf8");
test("coach feature is disabled by default",()=>assert.match(worker,/env\.COACH_ENABLED !== "true"/));
test("coach uses secret and private chat",()=>{assert.match(coach,/env\.HOOSHI_API_KEY/);assert.match(coach,/message\.chat\?\.type !== "private"/);});
test("coach cannot fabricate category or Azar data",()=>assert.match(coach,/فروش آذر در این نسخه در دسترس نیست/));
test("coach does not expose secret in source",()=>assert.doesNotMatch(coach,/sk-[A-Za-z0-9]{20}/));
