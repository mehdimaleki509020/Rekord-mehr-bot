import test from "node:test";
import assert from "node:assert/strict";
import { sellerTarget, sellerBonus, supervisorBonus } from "../azar_rules.js";
import { sellerMessage, branchMessage, networkMessage, winnersMessages, withSavedAbanBaseline } from "../worker_azar.js";

test("Azar floor is a bonus CALCULATION baseline rather than an immediate payout", () => {
  assert.equal(sellerTarget(0), 400);
  assert.equal(sellerTarget(200), 400);
  assert.equal(sellerTarget(400), 400);
  assert.equal(sellerTarget(500), 500);
  assert.equal(sellerBonus(0, 399), 0);
  assert.equal(sellerBonus(0, 400), 0);
  assert.equal(sellerBonus(100, 450), 1.5);
  assert.equal(sellerBonus(200, 600), 6);
  assert.equal(sellerBonus(500, 800), 9);
  assert.equal(sellerBonus(1000, 1500), 15);
  assert.equal(sellerBonus(900, 900), 0);
  assert.equal(sellerBonus(0, 1400), 20); // cap
});

test("supervisor must have STRICT store-level growth and respect 3% growth cap", () => {
  assert.equal(supervisorBonus(4000, 3900, [15, 10]), 0);
  assert.equal(supervisorBonus(4000, 4000, [15, 10]), 0);
  assert.equal(supervisorBonus(4000, 4050, [15, 5]), 1.5);
  assert.equal(supervisorBonus(4000, 4500, [15, 5]), 6);
  assert.equal(supervisorBonus(4000, 4500, []), 0);
});

test("individual Azar panel shows approved baseline, cumulative sales and bonus", () => {
  const output = sellerMessage({seller_name:"علی رضایی",store:"اراک",aban_m:200,azar_m:600,days_elapsed:4});
  assert.match(output,/رکورد رشد آذر/);
  assert.match(output,/مبنای محاسبه جایزه: ۴۰۰ میلیون تومان/);
  assert.match(output,/فروش تا ۴ آذر: ۶۰۰ میلیون تومان/);
  assert.match(output,/جایزه: ۶ میلیون تومان/);
});

test("supervisor panel shows zero despite seller bonus if total branch did not grow", () => {
  const output = branchMessage({store:"ارومیه",aban_m:2000,azar_m:1999,days_elapsed:4}, [
    {seller_name:"فروشنده",aban_m:500,azar_m:800}
  ]);
  assert.match(output,/جایزه سوپروایزر: ۰ میلیون تومان/);
  assert.match(output,/فروشنده:/);
  assert.match(output,/۹ میلیون تومان/);
});

test("manager network and winners use Azar numbers", () => {
  const net=networkMessage([{store:"کرمان",azar_m:1500,days_elapsed:4},{store:"ساری",azar_m:800,days_elapsed:4}]);
  assert.match(net,/آذر/);
  assert.match(net,/۲٫۳ میلیارد تومان/);
  const wins=winnersMessages([
    {store:"کرمان",seller_name:"علی",aban_m:500,azar_m:800,days_elapsed:4},
    {store:"ساری",seller_name:"سارا",aban_m:50,azar_m:400,days_elapsed:4},
  ]).join("\n");
  assert.match(wins,/۱ نفر/);
  assert.match(wins,/علی/);
  assert.doesNotMatch(wins,/سارا/);
});

test("only the CLOSED archived Aban figures determine Azar baselines", () => {
  const archivedPeople=[{store:"کرمان",store_key:"کرمان",seller_name:"علی رضایی",seller_key:"کرمان:علیرضایی",aban_m:500}];
  const archivedStores=[{store:"کرمان",store_key:"کرمان",aban_m:2000,days_elapsed:30}];
  const report={aban_rows:1,azar_rows:2,period_month:9,days_elapsed:3,
    sellers:[{store:"کرمان",store_key:"کرمان",seller_name:"علی رضایی",seller_key:"کرمان:علیرضایی",aban_m:999,azar_m:800},
             {store:"کرمان",store_key:"کرمان",seller_name:"نیلوفر",seller_key:"کرمان:نیلوفر",aban_m:0,azar_m:500}],
    stores:[{store:"کرمان",store_key:"کرمان",aban_m:9999,azar_m:2500}]};
  const out=withSavedAbanBaseline(report,archivedPeople,archivedStores);
  assert.equal(out.stores[0].aban_m,2000);
  assert.equal(out.sellers.find(x=>x.seller_name==="علی رضایی").aban_m,500);
  assert.equal(out.sellers.find(x=>x.seller_name==="نیلوفر").aban_m,0);
  assert.equal(out.sellers.length,2);
});

test("Azar import refuses partial Aban archive", () => {
  assert.throws(()=>withSavedAbanBaseline({sellers:[],stores:[]},[],[]),/قطعی آبان/);
  assert.throws(()=>withSavedAbanBaseline({sellers:[],stores:[]},[],[{store_key:"کرمان",aban_m:100,days_elapsed:24}]),/قطعی آبان/);
});
