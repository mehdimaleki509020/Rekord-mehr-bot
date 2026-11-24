// ONLY reviewed, non-confidential operational rules belong here.
// The original managerial notes and their version history live privately in
// ChatGPT Page "بانک دانش زنده مدیر کتگوری غیربرقی — انتخاب من".
// Edited via ChatGPT after the manager sends rules or corrections in chat/voice.
// No seller data, supplier terms, admin secrets or personal evaluations allowed.
export const CHAT_OPERATIONAL_RULES = Object.freeze([]);

export function chatPolicyContext({store_key="",store="",category_code="",now="2026-11-24"}={}) {
  const branch=String(store_key||store||"").trim();
  const category=String(category_code||"").trim();
  const active=CHAT_OPERATIONAL_RULES.filter(r=>
    r && r.active===true && typeof r.public_rule==="string" && r.public_rule.trim() &&
    (!r.valid_from || r.valid_from<=now) &&
    (!r.valid_until || r.valid_until>=now) &&
    (r.scope==="network" ||
      (r.scope==="store" && r.store_key===branch) ||
      (r.scope==="category" && r.category_code===category) ||
      (r.scope==="store_category" && r.store_key===branch && r.category_code===category))
  ).slice(0,12);
  if (!active.length) return "";
  return [
    "قواعد اجرایی مدیریتی مصوب که از گفت‌وگوهای مدیر ثبت شده‌اند:",
    ...active.map(r=>String(r.id)+" ["+String(r.level||"preference")+"]: "+r.public_rule.slice(0,650)),
    "فقط این متن‌های اجرایی مجازند. اطلاعات داخلی، فرضیات تأییدنشده و نسخه‌های منسوخ را وارد پاسخ نکن.",
    "الزام‌های مربوط به ایمنی، صداقت و قوانین را بر ترجیحات تجاری مقدم بدان."
  ].join("\n");
}
