import test from "node:test";
import assert from "node:assert/strict";
import { formatCoachCategoryContext, CATEGORY_LABELS } from "../coach_metrics.js";

test("missing Azar category data never invents a weak product group", () => {
  const text = formatCoachCategoryContext([]);
  assert.match(text, /هنوز ثبت نشده/);
  assert.match(text, /عدد یا علت قطعی نساز/);
});

test("comparable month snapshots disclose verified cookware decline", () => {
  const text = formatCoachCategoryContext([
    {period:"1405-08",group_code:"cookware",sales_m:120,through_day:10},
    {period:"1405-09",group_code:"cookware",sales_m:95,through_day:10}
  ]);
  assert.match(text, /پخت‌وپز/);
  assert.match(text, /افت ۲۵ میلیون/);
  assert.match(text, /تا همین روز/);
  assert.doesNotMatch(text, /نرخ رشد\/افت قابل استناد نیست/);
});

test("non-comparable days prevent false growth or decline", () => {
  const text = formatCoachCategoryContext([
    {period:"1405-08",group_code:"cookware",sales_m:120,through_day:30},
    {period:"1405-09",group_code:"cookware",sales_m:25,through_day:3}
  ]);
  assert.match(text, /دوره‌ها هم‌طول نیستند/);
  assert.doesNotMatch(text, /افت ۹۵/);
});

test("unknown product group and missing baseline are labeled cautiously", () => {
  const text = formatCoachCategoryContext([
    {period:"1405-09",group_code:"tableware",sales_m:12,through_day:3},
    {period:"1405-09",group_code:"unknown",sales_m:20,through_day:3}
  ]);
  assert.match(text,/غذاخوری/);
  assert.match(text,/داده قابل‌مقایسه آبان/);
  assert.doesNotMatch(text,/unknown/);
  assert.ok(Object.isFrozen(CATEGORY_LABELS));
});
