import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { importCoachBatch, coachImportPage, coachImportMaxBytes } from "../coach_import.js";

const profile={
  seller_key:"shobe:fard",store_key:"shobe",store:"شعبه آزمایشی",
  seller_name:"فروشنده فرضی",mehr_m:400,aban_m:450,days_elapsed:30,report_id:-9003
};
const metric={
  seller_key:"shobe:fard",period:"1405-09",through_day:2,
  group_code:"cookware",sales_m:25,
  source_ref:"14050903.xlsb:PH11-PH21:day1-2:taxincluded"
};
function mockDB() {
  const calls=[],batches=[];
  return {calls,batches,prepare(sql){
    return {bind(...args){calls.push({sql,args});return this;}};
  },async batch(items){batches.push(items);return items.map(()=>({success:true}))}};
}
test("preview importer rejects unknown group and incorrect day without side effects",async()=>{
 const DB=mockDB();
 let result=await importCoachBatch({DB},"metrics",[{...metric,through_day:3}]);
 assert.equal(result.ok,false);
 result=await importCoachBatch({DB},"metrics",[{...metric,group_code:"unknown"}]);
 assert.equal(result.ok,false);
 assert.equal(DB.calls.length,0);
});
test("preview importer accepts well-formed seller and category batch",async()=>{
 const DB=mockDB();
 const a=await importCoachBatch({DB},"profiles",[profile]);
 const b=await importCoachBatch({DB},"metrics",[metric]);
 assert.equal(a.ok,true);assert.equal(b.ok,true);
 assert.equal(DB.calls.length,2);
 assert.ok(DB.calls.every(x=>/\?/.test(x.sql)));
});
test("preview importer rejects duplicate keys, out-of-range amounts and oversized batches",async()=>{
 const DB=mockDB();
 assert.equal((await importCoachBatch({DB},"profiles",[profile,profile])).ok,false);
 assert.equal((await importCoachBatch({DB},"metrics",[{...metric,sales_m:-5}])).ok,false);
 assert.equal((await importCoachBatch({DB},"metrics",Array(81).fill(metric))).ok,false);
 assert.equal(DB.batches.length,0); // no SQL was executed
});
test("import form is local-file based and never embeds private sales",()=>{
 const html=coachImportPage();
 assert.match(html,/type="file"/);
 assert.match(html,/coach-import-batch/);
 assert.match(html,/type="password"/);
 assert.ok(coachImportMaxBytes>=10000);
 assert.doesNotMatch(html,/رمز تصادفی شما|HOOSHI_API_KEY.*Bearer/);
});

test("real upload-page inline JavaScript must parse in browser",()=>{
 const html=coachImportPage();
 const start=html.indexOf("<script>");
 const end=html.indexOf("</script>",start);
 assert.ok(start>=0 && end>start,"HTML should embed its uploader script");
 const inline=html.slice(start+"<script>".length,end);
 assert.doesNotThrow(()=>new Script(inline,{filename:"coach-import-page-inline.js"}));
 assert.ok(inline.includes('fetch("/coach-import-batch"'));
});

test("uploader preflights a private token before reading the local file",()=>{
 const html=coachImportPage();
 assert.ok(html.indexOf('fetch("/coach-import-status"')>=0);
 assert.ok(html.indexOf('fetch("/coach-import-status"')<html.indexOf("await file.text()"));
 assert.match(html,/رمز COACH_TEST_TOKEN این Preview/);
 assert.match(html,/value\.trim\(\)/);
});
