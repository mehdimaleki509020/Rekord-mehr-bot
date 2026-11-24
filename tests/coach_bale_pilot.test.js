import test from "node:test";
import assert from "node:assert/strict";
import worker,{ secretWebhookPath } from "../worker_aban.js";
import { balePilotSetupPage } from "../coach_bale_setup.js";
import { Script } from "node:vm";

const env={COACH_PILOT_PREVIEW:"yes",COACH_ENABLED:"true",BALE_TOKEN:"PRODUCTION_TOKEN_MUST_NOT_BE_USED"};
test("preview never falls back to Production Bale token", async()=>{
  await assert.rejects(secretWebhookPath(env),/BALE TOKEN NOT FOUND/);
  const path=await secretWebhookPath({...env,BALE_TEST_BOT_TOKEN:"fake-test-only"});
  assert.match(path,/^\/webhook\/[a-f0-9]{40}$/);
});
test("Production setup and debug are disabled in Preview", async()=>{
  for(const path of ["/setup","/debug","/processor/report"]){
    const r=await worker.fetch(new Request("https://preview.example"+path),env);
    assert.equal(r.status,404);
  }
});
test("Bale Preview setup rejects missing shared secret before external network",async()=>{
  const r=await worker.fetch(new Request("https://preview.example/coach-bale-test-setup",
    {method:"POST"}),env);
  assert.equal(r.status,401);
});
test("Bale Preview setup readiness contains no tokens",async()=>{
  const r=await worker.fetch(new Request("https://preview.example/coach-bale-test-ready"),
    {...env,BALE_TEST_BOT_TOKEN:"private-test-token",COACH_TEST_BOT_USERNAME:"sample_test_bot"});
  assert.equal(r.status,200);
  const result=await r.json();
  assert.equal(result.test_bot_token_present,true);
  assert.equal(result.expected_bot_username_present,true);
  assert.doesNotMatch(JSON.stringify(result),/private-test-token|PRODUCTION_TOKEN_MUST_NOT_BE_USED/);
});
test("Bale pilot browser setup JavaScript compiles and does not reveal tokens",()=>{
  const html=balePilotSetupPage();
  const a=html.indexOf("<script>"),b=html.indexOf("</script>",a);
  assert.ok(a>=0 && b>a);
  assert.doesNotThrow(()=>new Script(html.slice(a+8,b),{filename:"bale-pilot-setup.js"}));
  assert.match(html,/BALE_TEST_BOT_TOKEN/);
  assert.match(html,/coach-bale-test-setup/);
});
