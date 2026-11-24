import test from "node:test";
import assert from "node:assert/strict";
import { coachPreviewSmoke } from "../coach_hooshi.js";

test("preview smoke refuses disabled or unconfigured AI", async () => {
  assert.deepEqual(await coachPreviewSmoke({COACH_ENABLED:"false",HOOSHI_API_KEY:"test"}), {ok:false,error:"preview_not_configured"});
  assert.deepEqual(await coachPreviewSmoke({COACH_ENABLED:"true"}), {ok:false,error:"preview_not_configured"});
});

test("preview smoke sends only fictional data and handles provider response", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = {url,options};
    return {ok:true,json:async()=>({choices:[{message:{content:"تارگت ۵۰۰ میلیون و فاصله ۵۰ میلیون تومان است."}}]})};
  };
  try {
    const result = await coachPreviewSmoke({COACH_ENABLED:"true",HOOSHI_API_KEY:"mock-secret"});
    assert.equal(result.ok,true);
    assert.match(result.answer,/۵۰/);
    assert.match(captured.url,/chat\/completions/);
    assert.equal(captured.options.headers.authorization,"Bearer mock-secret");
    const payload = JSON.parse(captured.options.body);
    assert.match(payload.messages[1].content,/۴۰۰/);
    assert.match(payload.messages[1].content,/۴۵۰/);
    assert.doesNotMatch(payload.messages[1].content,/seller_name|user_id|شماره تلفن/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preview smoke hides upstream error details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ok:false,status:401});
  try {
    assert.deepEqual(await coachPreviewSmoke({COACH_ENABLED:"true",HOOSHI_API_KEY:"mock"}), {ok:false,error:"provider_http_401"});
  } finally {globalThis.fetch = originalFetch;}
});
