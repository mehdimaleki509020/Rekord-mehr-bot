// Preview-only JSON import of aggregated seller/category sales.
// NO real seller data or API secrets are committed to this repository.
const MAX_BATCH = 80;
const MAX_REQUEST_BYTES = 80000;
const SOURCE_REF = "14050903.xlsb:PH11-PH21:day1-2:taxincluded";
const SUPPORTED_GROUPS = new Set([
 "cookware","tableware","glassware","kitchenware","bath_cleaning",
 "kitchen_tools","travel","storage","disposables"
]);
const validKey = x=>typeof x==="string" && x.length>=1 && x.length<=180 &&
  !/[\x00-\x1f]/.test(x);
const validString = (x,len=140)=>typeof x==="string" && x.trim().length>0 && x.length<=len;
const finite = (x,low,high)=>typeof x==="number" && Number.isFinite(x) && x>=low && x<=high;
const round5 = x=>Math.round(x*100000)/100000;
const cleanError = key=>({ok:false,error:key});

export async function importCoachBatch(env,kind,rows) {
  if (!["profiles","metrics"].includes(kind)) return cleanError("unknown_batch_kind");
  if (!Array.isArray(rows) || rows.length<1 || rows.length>MAX_BATCH)
    return cleanError("invalid_batch_length");
  const statements = [];
  if (kind==="profiles") {
    const seen = new Set();
    for (const r of rows) {
      if (!r || !validKey(r.seller_key) || !validKey(r.store_key) ||
          !validString(r.seller_name) || !validString(r.store) ||
          !r.seller_key.startsWith(r.store_key+":") ||
          !finite(r.mehr_m,0,1e9) || !finite(r.aban_m,0,1e9) ||
          r.days_elapsed !== 30 || r.report_id !== -9003 ||
          seen.has(r.seller_key)) return cleanError("invalid_profile_row");
      seen.add(r.seller_key);
      statements.push(env.DB.prepare(
        "INSERT INTO aban_people(seller_key,store_key,store,seller_name,mehr_m,aban_m,days_elapsed,report_id) " +
        "VALUES(?,?,?,?,?,?,30,-9003) ON CONFLICT(seller_key) DO UPDATE SET " +
        "store_key=excluded.store_key,store=excluded.store,seller_name=excluded.seller_name," +
        "mehr_m=excluded.mehr_m,aban_m=excluded.aban_m,days_elapsed=30,report_id=-9003"
      ).bind(r.seller_key,r.store_key,r.store,r.seller_name,round5(r.mehr_m),round5(r.aban_m)));
    }
  } else {
    const seen = new Set();
    for (const r of rows) {
      if (!r || !validKey(r.seller_key) ||
          !["1405-08","1405-09"].includes(r.period) ||
          r.through_day !== 2 || !SUPPORTED_GROUPS.has(r.group_code) ||
          !finite(r.sales_m,0,1e9) || r.source_ref !== SOURCE_REF ||
          seen.has(r.seller_key+"|"+r.period+"|"+r.group_code))
        return cleanError("invalid_metric_row");
      seen.add(r.seller_key+"|"+r.period+"|"+r.group_code);
      statements.push(env.DB.prepare(
        "INSERT INTO coach_group_sales(seller_key,period,through_day,group_code,sales_m,source_ref) " +
        "VALUES(?,?,2,?,?,?) ON CONFLICT(seller_key,period,group_code) DO UPDATE SET " +
        "through_day=2,sales_m=excluded.sales_m,source_ref=excluded.source_ref,updated_at=CURRENT_TIMESTAMP"
      ).bind(r.seller_key,r.period,r.group_code,round5(r.sales_m),SOURCE_REF));
    }
  }
  await env.DB.batch(statements);
  return {ok:true,kind,accepted:rows.length};
}

export function coachImportPage() {
  return String.raw`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ورود امن فروش غیربرقی به مربی</title><style>body{font:16px Tahoma,Arial,sans-serif;line-height:1.9;max-width:670px;margin:25px auto;padding:16px;color:#253046}input,button{font:inherit;border-radius:8px;padding:11px;margin:7px 0}input{border:1px solid #aaa;display:block;max-width:95%}button{background:#1248a1;color:white;border:0;cursor:pointer}button:disabled{opacity:.5;cursor:wait}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:14px;border-radius:8px}small{color:#555}</style></head><body><h2>ورود اطلاعات فروش به مربی — فقط نسخه آزمایشی</h2><p>فایل آماده‌شده محلی را انتخاب کنید. محتوای آن فقط با اتصال رمزدار HTTPS به پایگاه داده <b>Preview</b> منتقل می‌شود؛ در GitHub ذخیره نمی‌شود.</p><p><b>توجه:</b> فایل حاوی نام و اطلاعات فروش افراد است. آن را در گروه‌های عمومی ارسال نکنید.</p><label>فایل JSON تجمیع فروش</label><input id="file" type="file" accept=".json,application/json"><label>رمز تست Cloudflare (COACH_TEST_TOKEN)</label><input id="secret" type="password" autocomplete="off" spellcheck="false"><button id="go">ورود اطلاعات به پایگاه داده آزمایشی</button><pre id="status" aria-live="polite">آماده دریافت فایل</pre><small>پس از هر خطا می‌توانید همان فایل را دوباره وارد کنید؛ ثبت‌ها تکراری نمی‌شوند. ربات اصلی بله تغییر نمی‌کند.</small><script>const by=id=>document.getElementById(id);by("go").onclick=async()=>{const file=by("file").files[0],password=by("secret").value,button=by("go"),output=by("status");if(!file||!password){output.textContent="فایل و رمز تست هر دو لازم هستند.";return}button.disabled=true;let data;try{if(file.size>2000000)throw Error("فایل بیش از حد بزرگ است");data=JSON.parse(await file.text());const m=data.manifest||{};if(m.source_id!=="14050903.xlsb"||m.through_day!==2||!Array.isArray(data.profiles)||!Array.isArray(data.metrics)||data.profiles.length!==m.profile_count||data.metrics.length!==m.metric_row_count)throw Error("ساختار فایل معتبر نیست");const all=[["profiles",data.profiles],["metrics",data.metrics]];let count=0;for(const [kind,records] of all){for(let i=0;i<records.length;i+=80){const batch=records.slice(i,i+80);const res=await fetch("/coach-import-batch",{method:"POST",headers:{"content-type":"application/json","x-coach-test-token":password},body:JSON.stringify({kind,rows:batch})});let result=await res.json();if(!res.ok||!result.ok)throw Error("خطا در ثبت "+kind+": "+(result.error||res.status));count+=batch.length;output.textContent="تعداد ردیف‌های ثبت‌شده: "+count+" از "+(data.profiles.length+data.metrics.length)}}const final=await fetch("/coach-import-status",{headers:{"x-coach-test-token":password}});const state=await final.json();if(!final.ok)throw Error("بررسی پایانی ناموفق بود");output.textContent="✅ ورود آزمایشی انجام شد.\nپروفایل‌های فروشنده: "+state.profiles+"\nردیف‌های گروه کالا: "+state.metrics+"\nاین اطلاعات فقط در پایگاه داده Preview ذخیره شده است.";}catch(e){output.textContent="⚠️ "+e.message}finally{by("secret").value="";button.disabled=false;data=null}};</script></body></html>`;
}

export const coachImportMaxBytes = MAX_REQUEST_BYTES;
