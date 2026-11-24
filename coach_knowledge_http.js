import {kbManager,kbCreate,kbList,kbEdit,kbStatus} from "./coach_knowledge.js";
import {knowledgeAdminPage} from "./coach_knowledge_panel.js";
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
export async function knowledgeHttp(req,env,url){
 if(url.pathname!=="/coach-kb-panel"&&!url.pathname.startsWith("/coach-kb-api/"))return null;
 if(env.COACH_PILOT_PREVIEW!=="yes")return json({ok:false,error:"not_found"},404);
 if(req.method==="GET"&&url.pathname==="/coach-kb-panel")return new Response(knowledgeAdminPage(),{
  headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store",
   "content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
   "referrer-policy":"no-referrer","x-content-type-options":"nosniff"}
 });
 if(!env.COACH_TEST_TOKEN||req.headers.get("x-coach-test-token")?.trim()!==String(env.COACH_TEST_TOKEN).trim())
  return json({ok:false,error:"unauthorized"},401);
 const adminId=String(req.headers.get("x-coach-admin-id")||"").trim();
 try{
  if(!await kbManager(env,adminId))return json({ok:false,error:"forbidden"},403);
  if(url.pathname==="/coach-kb-api/rules"&&req.method==="GET")return json({ok:true,rules:await kbList(env,adminId)});
  if(req.method!=="POST")return json({ok:false,error:"method_not_allowed"},405);
  const bodyText=await req.text();if(bodyText.length>12000)return json({ok:false,error:"too_large"},413);
  let data;try{data=JSON.parse(bodyText)}catch{return json({ok:false,error:"invalid_json"},400)}
  if(url.pathname==="/coach-kb-api/create")return json(await kbCreate(env,adminId,data));
  if(url.pathname==="/coach-kb-api/revise")return json(await kbEdit(env,adminId,data.id,data));
  if(url.pathname==="/coach-kb-api/status")return json(await kbStatus(env,adminId,data.id,data.status));
  return json({ok:false,error:"not_found"},404);
 }catch(err){
  const key=String(err?.message||"unknown");
  const status=key==="forbidden"?403:key==="not_found"?404:
    ["invalid_rule","invalid_id","invalid_status","not_editable","public_rule_required","already_revoked","concurrent_change"].includes(key)?400:500;
  if(status===500)console.log("KB API error",String(err?.name||"error"));
  return json({ok:false,error:status===500?"server_error":key},status);
 }
}
