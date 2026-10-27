import test from "node:test";
import assert from "node:assert/strict";
import { sellerTarget, sellerBonus, supervisorBonus } from "../aban_rules.js";
import { sellerMessage, branchMessage, insertMany } from "../worker_aban.js";

test("individual targets have a 500 million floor", () => {
  assert.equal(sellerTarget(0), 500);
  assert.equal(sellerTarget(200), 500);
  assert.equal(sellerTarget(400), 500);
  assert.equal(sellerTarget(500), 600);
  assert.equal(sellerTarget(700), 840);
});

test("seller receives one percent of all Aban sales only after target is reached", () => {
  assert.equal(sellerBonus(400, 499), 0);
  assert.equal(sellerBonus(400, 500), 5);
  assert.equal(sellerBonus(700, 839), 0);
  assert.equal(sellerBonus(700, 840), 8.4);
  assert.equal(sellerBonus(0, 900), 9);
});

test("supervisor must avoid decline in total branch sales", () => {
  assert.equal(supervisorBonus(4000, 3900, [10, 5]), 0);
  assert.equal(supervisorBonus(4000, 4000, [10, 5]), 4.5);
  assert.equal(supervisorBonus(4000, 4200, [10, 5]), 4.5);
});

test("seller screen contains only the three requested amounts", () => {
  const message = sellerMessage({
    seller_name: "علی رضایی", store: "کرمانشاه", mehr_m: 700, aban_m: 900, days_elapsed: 7,
  });
  assert.match(message, /تارگت آبان/);
  assert.match(message, /فروش تا ۷ آبان/);
  assert.match(message, /جایزه/);
  assert.doesNotMatch(message, /شهریور|پیش‌بینی|سطح ۱|رتبه/);
});

test("supervisor screen includes individual target, sales, award and no-decline gate", () => {
  const branch = { store: "کرمانشاه", mehr_m: 2000, aban_m: 1900, days_elapsed: 7 };
  const people = [{ seller_name: "علی رضایی", mehr_m: 400, aban_m: 600 }];
  const text = branchMessage(branch, people);
  assert.match(text, /حداقل تارگت/);
  assert.match(text, /سوپروایزر: ۰ میلیون تومان/);
  assert.match(text, /علی رضایی:/);
  assert.match(text, /۶ میلیون تومان/);
});

test("D1 inserts never exceed 100 bound parameters per SQL statement", () => {
  const sizes = [];
  const fakeDb = {
    DB: {
      prepare(sql) {
        assert.match(sql, /^INSERT INTO aban_people/);
        return {
          bind(...values) { sizes.push(values.length); return { sql }; },
        };
      },
    },
  };
  const columns = ["seller_key", "store_key", "store", "seller_name", "mehr_m", "aban_m", "days_elapsed", "report_id"];
  const rows = Array.from({ length: 170 }, (_, i) => [String(i), "a", "A", "Seller", 100, 200, 4, 22]);
  const statements = insertMany(fakeDb, "aban_people", columns, rows);
  assert.equal(statements.length, 15);
  assert.ok(sizes.every((n) => n <= 100), "D1 bound parameter limit exceeded");
  assert.equal(sizes.reduce((a, b) => a + b, 0), 170 * 8);
});
