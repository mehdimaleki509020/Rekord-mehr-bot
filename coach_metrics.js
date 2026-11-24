// Additive coach-only data model. Values in MILLION TOMAN.
// No uploads are permitted through public or Bale chat endpoints.
// A trusted, separately-reviewed importer will populate this table later.
export const CATEGORY_LABELS = Object.freeze({
  cookware:"پخت‌وپز",
  tableware:"غذاخوری",
  serving:"سرو و پذیرایی",
  glassware:"بلور و شیشه",
  organizers:"نظم‌دهنده",
  other:"سایر گروه‌های غیربرقی",
});

export async function ensureCoachMetricsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS coach_group_sales(
    seller_key TEXT NOT NULL,
    period TEXT NOT NULL,
    through_day INTEGER NOT NULL CHECK(through_day BETWEEN 1 AND 31),
    group_code TEXT NOT NULL,
    sales_m REAL NOT NULL CHECK(sales_m>=0),
    source_ref TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (seller_key, period, group_code)
  )`).run();
}

const n = v => Number(v || 0);
const fmt = v => n(v).toLocaleString("fa-IR",{maximumFractionDigits:2});

export function formatCoachCategoryContext(rows, currentPeriod="1405-09", priorPeriod="1405-08") {
  const current = (rows || []).filter(x=>x.period===currentPeriod && CATEGORY_LABELS[x.group_code]);
  const prior = (rows || []).filter(x=>x.period===priorPeriod && CATEGORY_LABELS[x.group_code]);
  if (!current.length) return [
    "آمار تأییدشده فروش تفکیکی گروه‌های کالا در آذر ۱۴۰۵ هنوز ثبت نشده است.",
    "از ضعف یا رشد هیچ گروه کالایی عدد یا علت قطعی نساز؛ تنها راهکار عمومی یا سؤال تشخیصی بده."
  ].join("\n");
  const previous = new Map(prior.map(x=>[x.group_code,x]));
  const parts = [
    "داده‌های واقعی تفکیکی فروش گروه‌ها (مبالغ به میلیون تومان):",
    "این داده‌ها مجموع فروش را نشان می‌دهند، نه علت عملکرد یا موجودی کالا.",
  ];
  for(const item of current) {
    const label = CATEGORY_LABELS[item.group_code];
    const last = previous.get(item.group_code);
    let line = label+": آذر "+fmt(item.sales_m)+" میلیون تومان تا روز "+n(item.through_day)+".";
    if (last && n(last.through_day)===n(item.through_day)) {
      const diff = n(item.sales_m)-n(last.sales_m);
      line += " آبان تا همین روز "+fmt(last.sales_m)+
        " میلیون؛ "+(diff<0?"افت ":"رشد ")+fmt(Math.abs(diff))+" میلیون.";
    } else if (last) {
      line += " آبان تا روز "+n(last.through_day)+
        " ثبت شده و دوره‌ها هم‌طول نیستند؛ نرخ رشد/افت قابل استناد نیست.";
    } else {
      line += " داده قابل‌مقایسه آبان برای این گروه موجود نیست.";
    }
    parts.push(line);
  }
  parts.push("فقط تفاوت فروش قابل استناد است؛ علت افت را بدون داده پاخور، موجودی، فاکتور یا مشاهده فروشنده قطعی اعلام نکن.");
  return parts.join("\n");
}

export async function coachCategoryContext(env, sellerKey) {
  if (!sellerKey) return formatCoachCategoryContext([]);
  await ensureCoachMetricsTable(env);
  const rows = (await env.DB.prepare(
    "SELECT period,through_day,group_code,sales_m FROM coach_group_sales WHERE seller_key=? AND period IN ('1405-09','1405-08') ORDER BY group_code,period"
  ).bind(String(sellerKey)).all()).results || [];
  return formatCoachCategoryContext(rows);
}
