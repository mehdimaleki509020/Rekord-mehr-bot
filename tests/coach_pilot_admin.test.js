import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import worker from "../worker_aban.js";
import { pilotAdminSetupPage } from "../coach_pilot_admin.js";

test("pilot manager page JavaScript is valid and does not publish credentials",()=>{
 const html=pilotAdminSetupPage();
 const a=html.indexOf("<script>"),b=html.indexOf("</script>",a);
 assert.ok(a>=0&&b>a);
 assert.doesNotThrow(()=>new Script(html.slice(a+8,b),{filename:"coach-pilot-admin.js"}));
 assert.match(html,/coach-pilot-admin-setup/);
 assert.doesNotMatch(html,/Bearer [A-Za-z0-9]{10,}/);
});
test("manager approval requires Preview and the existing secret",async()=>{
 const req=()=>new Request("https://preview.example/coach-pilot-admin-setup",{
   method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({user_id:"999111222"})
 });
 const a=await worker.fetch(req(),{COACH_PILOT_PREVIEW:"yes",COACH_TEST_TOKEN:"dummy"});
 assert.equal(a.status,401);
 const b=await worker.fetch(req(),{COACH_TEST_TOKEN:"dummy"});
 assert.equal(b.status,404);
});
test("pilot manager page only runs in Preview",async()=>{
 const req=()=>new Request("https://preview.example/coach-pilot-admin-page");
 const a=await worker.fetch(req(),{COACH_PILOT_PREVIEW:"yes"});
 assert.equal(a.status,200);
 const b=await worker.fetch(req(),{});
 assert.equal(b.status,404);
});
