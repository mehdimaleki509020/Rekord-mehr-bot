import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {CHAT_OPERATIONAL_RULES,chatPolicyContext} from "../coach_chat_policies.js";
test("new chat-directed policy bank begins empty, no confidential notes seeded",()=>{
 assert.deepEqual([...CHAT_OPERATIONAL_RULES],[]);
 assert.equal(chatPolicyContext({category_code:"cookware",store:"ساری"}),"");
});
test("policy matching is Preview-only and no raw managerial Page content is imported",()=>{
 const coach=readFileSync(new URL("../coach_hooshi.js",import.meta.url),"utf8");
 const src=readFileSync(new URL("../coach_chat_policies.js",import.meta.url),"utf8");
 assert.match(coach,/chatPolicyContext\(/);
 assert.match(coach,/env\.COACH_PILOT_PREVIEW === "yes"/);
 assert.match(coach,/liveChatPolicyContext/);
 assert.doesNotMatch(src,/HOOSHI_API_KEY|COACH_TEST_TOKEN|حاشیه سود محرمانه/);
});
