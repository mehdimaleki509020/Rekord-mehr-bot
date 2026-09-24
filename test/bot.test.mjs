import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as XLSX from 'xlsx';
import worker, { ensureSchema, loadTargets, processImport, buildTargetIndex, resolveTarget, resolveTargetForPerson, aggregateCampaignSheet, parseSalesSheet, formatSellerStatus } from '../src/index.js';
import { validateTargets } from '../src/validation.js';

const targets=Array.from({length:92},(_,i)=>({store:'شعبه تست',seller:`فروشنده آزمایشی ${i}`,baseline:100,t20:120,r20:1,t30:130,r30:3,t40:140,r40:5}));
const headers=['شماره ماه','سال','PH11','مشاور فروش','مبلغ کل صحیح','روز','نام فروشگاه'];
const row=(amount,day=5,extra={})=>[extra.month??7,extra.year??1405,extra.category??'خانگي غير برقي',extra.seller??targets[0].seller,amount,day,extra.store??targets[0].store];
function bytes(rows,bookType='xlsx') { const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([headers,...rows]),'Sales'); return XLSX.write(wb,{type:'buffer',bookType}); }
function dbAdapter() {
  const sql=new DatabaseSync(':memory:');
  const wrap=(query,args=[])=>({query,args,bind(...values){return wrap(query,values);},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){const r=sql.prepare(query).run(...args);return {success:true,meta:{last_row_id:Number(r.lastInsertRowid)}};}});
  return {sql,prepare:wrap,async batch(stmts){sql.exec('BEGIN');try {const results=[]; for(const stmt of stmts) results.push(await stmt.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
}
async function setup() {
  const env={DB:dbAdapter(),BALE_TOKEN:'test-token',BALE_ADMIN_IDS:'1',BALE_GROUP_CHAT_ID:'-1',WEBHOOK_SECRET:'test-webhook',ADMIN_TOKEN:'test-admin'};
  const r=await worker.fetch(new Request('https://bot.test/admin/targets',{method:'POST',headers:{Authorization:'Bearer test-admin'},body:JSON.stringify(targets)}),env);
  assert.equal(r.status,200);
  await loadTargets(env); return env;
}
function fakeBale(data) {
  const original=globalThis.fetch;const sent=[];let failSend=false;
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes('/file/bot')) return new Response(data);
    const method=String(url).split('/').pop();
    if(method==='getFile') return Response.json({ok:true,result:{file_path:'files/report.xlsx'}});
    if(method==='sendMessage') { if(failSend) {failSend=false;throw new Error('temporary');} sent.push(Object.fromEntries(options.body));return Response.json({ok:true,result:{message_id:123}}); }
    throw new Error('Unexpected request');
  };
  return {sent,setData(v){data=v;},failNextSend(){failSend=true;},restore(){globalThis.fetch=original;}};
}
const job={chatId:'-1',replyTo:10,fileId:'test-file',fileName:'SalesReport.xlsx',uploaderId:'1',sourceTime:1000};

test('roster validation rejects non-finite amounts and duplicates',()=>{
  assert.equal(validateTargets(targets).length,92);
  assert.throws(()=>validateTargets(targets.map((t,i)=>i? t:{...t,t20:NaN})));
  assert.throws(()=>validateTargets([...targets.slice(1),targets[1]]));
});
for(const type of ['xlsx','xlsb','xls','csv']) test(`raw ${type}: filters campaign/category, preserves returns and rial conversion`,()=>{
  const wb=XLSX.read(bytes([row(2e9),row(-5e8),row(9e10,5,{month:6}),row(9e10,5,{category:'برقی'})],type),{type:'buffer',dense:true});
  const sheet=wb.Sheets[wb.SheetNames[0]], parsed=parseSalesSheet(sheet);
  const result=aggregateCampaignSheet(sheet,parsed.headerRow,1405,7,buildTargetIndex(targets));
  assert.equal(result.totalMatchedSales,150);assert.equal(result.maxDay,5);assert.equal(result.matchedCount,1);
});
test('invalid date, missing column and invalid amount are rejected',()=>{
  const index=buildTargetIndex(targets);
  for(const data of [row('bad'),row(10,31),row('',5)]) {
    assert.throws(()=>aggregateCampaignSheet(XLSX.utils.aoa_to_sheet([headers,data]),0,1405,7,index));
  }
  assert.equal(parseSalesSheet(XLSX.utils.aoa_to_sheet([headers.slice(0,6),row(1).slice(0,6)])),null);
});
test('name normalization supports Arabic variants and reversal without partial-name guesses',()=>{
  const index=buildTargetIndex([{...targets[0],seller:'علی کریمی'}]);
  assert.ok(resolveTarget(index,'شعبه تست','كريمي علي'));
  assert.ok(resolveTarget(index,'شعبه تست','علی کریمی علی کریمی'));
  assert.equal(resolveTarget(index,'شعبه تست','علی'),null);
  assert.equal(resolveTargetForPerson(index,'علی کریم'),null);
});
test('protected endpoints, group restriction and upload permission',async()=>{
  assert.equal((await worker.fetch(new Request('https://bot.test/admin/health'),{})).status,401);
  assert.equal((await worker.fetch(new Request('https://bot.test/webhook',{method:'POST',body:'{}'}),{})).status,404);
  const env=await setup();let queued=0;env.IMPORT_QUEUE={send:async()=>queued++};
  const api=fakeBale(bytes([row(1)]));
  try {
    const req=(user,chat=-1)=>new Request('https://bot.test/webhook/test-webhook',{method:'POST',body:JSON.stringify({message:{message_id:1,from:{id:user},chat:{id:chat,type:'group'},document:{file_id:'f',file_name:'test.xlsx'}}})});
    await worker.fetch(req(2),env);assert.equal(queued,0);
    await worker.fetch(req(1,-2),env);assert.equal(queued,0);
    await worker.fetch(req(1),env);assert.equal(queued,1);
  } finally {api.restore();}
});
test('all 92 performance rows commit atomically; repeats and older reports cannot replace them',async()=>{
  const env=await setup(),api=fakeBale(bytes([row(1.2e9,10)]));
  try {
    await processImport(env,job);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM performance').first()).n,92);
    assert.equal((await env.DB.prepare('SELECT SUM(sales_m) n FROM performance').first()).n,120);
    await processImport(env,job);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM uploads').first()).n,1);
    api.setData(bytes([row(1e9,9)]));await assert.rejects(processImport(env,{...job,sourceTime:2000}),/قدیمی/);
    assert.equal((await env.DB.prepare('SELECT SUM(sales_m) n FROM performance').first()).n,120);
    api.setData(bytes([row(1.3e9,10)]));await processImport(env,{...job,sourceTime:2000});
    api.setData(bytes([row(1.5e9,10)]));await assert.rejects(processImport(env,job),/قدیمی/);
    assert.equal((await env.DB.prepare('SELECT SUM(sales_m) n FROM performance').first()).n,130);
  } finally {api.restore();}
});
test('failed batch rolls back upload and every seller; notification failure retries without double import',async()=>{
  const env=await setup(),api=fakeBale(bytes([row(1.4e9,10)]));
  try {
    env.DB.sql.exec("CREATE TRIGGER fail_performance BEFORE INSERT ON performance BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    await assert.rejects(processImport(env,job));
    assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM uploads').first()).n,0);
    env.DB.sql.exec('DROP TRIGGER fail_performance');api.failNextSend();
    await assert.rejects(processImport(env,job));
    await processImport(env,job);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM uploads').first()).n,1);
    assert.equal(api.sent.length,1);
  }finally{api.restore();}
});
test('slash commands and bot mentions answer; status before import includes targets',async()=>{
  const env=await setup(),api=fakeBale(bytes([row(1)]));
  try {
    for(const text of ['/start','/help','/stats','/rank','/me','/start@rekord_bot']) {
      const r=await worker.fetch(new Request('https://bot.test/webhook/test-webhook',{method:'POST',body:JSON.stringify({message:{message_id:1,from:{id:1},chat:{id:-1,type:'group'},text}})}),env);assert.equal(r.status,200);
    }
    assert.equal(api.sent.length,6);
    assert.ok(api.sent.every(m=>m.text.startsWith('\u200f')));
    const status=formatSellerStatus({seller_name:'تست',store_name:'تست',max_day:0,target20_m:120,target30_m:130,target40_m:140});
    assert.match(status,/120/);assert.match(status,/1 \/ 3 \/ 5/);
    for(const [sales,reward] of [[119,0],[120,1],[130,3],[140,5]]) {
      const s=formatSellerStatus({seller_name:'تست',store_name:'تست',baseline_m:100,max_day:10,sales_m:sales,target20_m:120,target30_m:130,target40_m:140,reward20_m:1,reward30_m:3,reward40_m:5});
      assert.ok(s.includes(`پاداش بر مبنای فروش فعلی: ${reward} میلیون`));
    }
  }finally{api.restore();}
});

test('streaming XLSB agrees with SheetJS for strings, compact numbers, and decimals',async()=>{
  const {aggregateXlsb}=await import('../src/index.js');
  const rows=[row(2e9),row(-5e8),row(12.25),row(-90),row(2e9,3,{month:6})];
  for(const bookSST of [true,false]) {
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([headers,...rows]),'Sales');
    const data=XLSX.write(wb,{type:'buffer',bookType:'xlsb',bookSST,compression:true});
    const result=aggregateXlsb(data,1405,7,buildTargetIndex(targets));
    const reread=XLSX.read(data,{type:'buffer',dense:true});
    const expected=aggregateCampaignSheet(reread.Sheets.Sales,0,1405,7,buildTargetIndex(targets));
    assert.deepEqual(result,expected);
  }
});

test('streaming XLSB import runs through the transactional consumer',async()=>{
  const env=await setup(),api=fakeBale(bytes([row(1.2e9)],'xlsb'));
  try {await processImport(env,{...job,fileName:'SalesReport.xlsb'});assert.equal((await env.DB.prepare('SELECT SUM(sales_m) n FROM performance').first()).n,120);}
  finally{api.restore();}
});
