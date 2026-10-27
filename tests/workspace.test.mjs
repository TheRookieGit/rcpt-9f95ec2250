import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const first='00000000-0000-4000-8000-000000000001', second='00000000-0000-4000-8000-000000000002';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check) { for(let n=0;n<150;n++){if(check()) return; await sleep(10);} assert.fail('UI update timed out'); }
function response(json,status=200) { return { ok:status>=200&&status<300,status,json:async()=>json }; }
async function fixture({ records, handler }={}) {
  const requests=[], chats=[], errors=[];
  const state={records:records || [
    {id:first,date:'2026-10-08',merchant:'First',total:10,currency:'USD',file:'test.pdf',page:1,items:[{name:'Coffee',quantity:1,price:10}]},
    {id:second,date:'2026-10-08',merchant:'Second',total:20,currency:'USD',file:'test.pdf',page:1,items:[]}]};
  const console=new VirtualConsole(); console.on('jsdomError',e=>errors.push(e));
  const dom=new JSDOM(html,{url:'https://receipt.test',runScripts:'dangerously',virtualConsole:console,beforeParse(w){
    w.localStorage.setItem('passcode','test-only');
    w.HTMLElement.prototype.scrollTo=function(){};
    w.HTMLElement.prototype.scrollIntoView=function(){};
    w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
    w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
    w.fetch=async(url,options)=>{
      const body=JSON.parse(options.body); requests.push(body);
      const special=handler?.(body,options,state); if(special) return await special;
      if(body.action==='months') {
        const grouped=new Map(); for(const r of state.records){const m=r.date.slice(0,7);grouped.set(m,(grouped.get(m)||0)+1);}
        return response({months:[...grouped].map(([month,count])=>({month,count})).sort((a,b)=>b.month.localeCompare(a.month))});
      }
      if(body.action==='list') return response({results:structuredClone(state.records.filter(r=>r.date.startsWith(body.month)).sort((a,b)=>b.date.localeCompare(a.date)))});
      if(body.action==='edit_receipt') {state.records.find(r=>r.id===body.id).date=body.date;return response({ok:true});}
      if(body.action==='delete_receipt') {state.records=state.records.filter(r=>r.id!==body.id);return response({ok:true});}
      if(body.action==='chat') return await new Promise((resolve,reject)=>chats.push({body,options,resolve,reject}));
      return response({ok:true});
    };
  }});
  const w=dom.window,d=w.document;
  await until(()=>d.getElementById('browseList').getAttribute('aria-busy')==='false');
  return {w,d,state,requests,chats,errors,close:()=>dom.window.close()};
}
function input(f,id,value){const n=f.d.getElementById(id);n.value=value;n.dispatchEvent(new f.w.Event('input',{bubbles:true}));}
const click=(f,id)=>f.d.getElementById(id).click();
function send(f,text){input(f,'q',text);click(f,'go');}

test('every section is a tab and only the selected pane is active',async t=>{
  const f=await fixture();t.after(f.close);
  const tabs=[...f.d.querySelectorAll('#tabs button')].map(b=>b.dataset.tab);
  assert.deepEqual(tabs,['upload','browse','tx','share','budget','chat','more']);
  assert.equal(f.d.body.dataset.tab,'browse');
  assert.equal(f.d.querySelector('#tabs [aria-selected="true"]').dataset.tab,'browse');
  f.d.querySelector('#tabs [data-tab="chat"]').click();
  assert.equal(f.d.body.dataset.tab,'chat');
  assert.equal(f.w.localStorage.getItem('tab'),'chat');
  assert.equal(f.d.getElementById('libraryCount').textContent,'2 张小票');
  assert.equal(f.requests.some(r=>['ledger_months','share_get','reconcile_status'].includes(r.action)),false);
});
const ledger=[
  {id:'a',date:'2026-10-17',amount:50.99,merchant:'Aceking BBQ',descr:'ACEKING',category:'Restaurant',source:'moneywiz',receipts:[{file:'x',page:1,position:0}],flow:'spending',tags:'1/2',notes:'dinner'},
  {id:'b',date:'2026-10-16',amount:1200,merchant:'Payroll',descr:'',category:'Salary',source:'moneywiz',receipts:[],flow:'income',tags:'',notes:''},
  {id:'c',date:'2026-09-30',amount:9.5,merchant:'<b>Cafe</b>',descr:'',category:'Coffee',source:'moneywiz',receipts:[],flow:'spending',tags:'',notes:''}];
function ledgerHandler(body){
  if(body.action==='ledger_months') return response({months:[{month:'2026-10',count:2},{month:'2026-09',count:1}]});
  if(body.action==='ledger_list'){
    const list=body.q?ledger.filter(e=>(e.merchant+e.notes+e.category).toLowerCase().includes(body.q.toLowerCase())):ledger.filter(e=>e.date.startsWith(body.month));
    return response({entries:list,truncated:false});
  }
}
test('transactions tab groups by day, filters flows, searches and renders text only',async t=>{
  const f=await fixture({handler:ledgerHandler});t.after(f.close);
  f.d.querySelector('#tabs [data-tab="tx"]').click();
  await until(()=>f.d.querySelectorAll('#txList .tx').length===2);
  assert.match(f.d.getElementById('txList').textContent,/Aceking BBQ/);
  assert.match(f.d.querySelector('[data-tx-id="a"]').textContent,/\$50\.99/);
  assert.match(f.d.querySelector('[data-tx-id="a"]').textContent,/含小票/);
  assert.match(f.d.querySelector('[data-tx-id="b"] .amt').textContent,/^\+\$1,?200\.00$/);
  f.d.querySelector('#txFlow [data-flow="income"]').click();
  await until(()=>f.d.querySelectorAll('#txList .tx').length===1);
  f.d.querySelector('#txFlow [data-flow=""]').click();
  await until(()=>f.d.querySelectorAll('#txList .tx').length===2);
  input(f,'txSearch','cafe');f.d.getElementById('txSearchForm').dispatchEvent(new f.w.Event('submit',{cancelable:true,bubbles:true}));
  await until(()=>f.d.querySelector('[data-tx-id="c"]'));
  assert.equal(f.d.querySelector('#txList b b'),null);
  assert.match(f.d.querySelector('[data-tx-id="c"]').textContent,/<b>Cafe<\/b>/);
  assert.deepEqual(f.requests.filter(r=>r.action==='ledger_list').pop(),{action:'ledger_list',q:'cafe'});
});
const weeks=[
  {start:'2026-10-18',end:'2026-10-24',total:120.5,remaining:279.5,count:1,inProgress:true,settling:false,ignoredCount:2,ignoredTotal:30,warnings:1,lines:[{date:'2026-10-19',descr:'Costco',share:120.5,note:'1/2 × $241.00'}]},
  {start:'2026-10-11',end:'2026-10-17',total:450,remaining:-50,count:0,inProgress:false,settling:true,ignoredCount:0,ignoredTotal:0,warnings:0,lines:[]}];
const snapshot={today:'2026-10-19',budget:400,countCategory:'Restaurant - Mellow',bothCategory:'Restaurant —— BOTHBOTH',ignoreCategory:'Restaurant - Vincent',weeks,
  carry:{balance:81.25,startAmount:100,startWeek:'2026-09-06',weeksCounted:6,weeksTotal:2300,adjustmentsTotal:-50,adjustments:[{date:'2026-10-03',amount:-50,note:'Mellow 转账'}]},
  budgets:[{name:'Monthly Budget',amount:2000,period:'每月',categories:['Groceries'],current:{start:'2026-10-01',end:'2026-10-31',spent:1700},daysLeft:12,
    past:[{start:'2026-09-01',end:'2026-09-30',spent:2100},{start:'2026-08-01',end:'2026-08-31',spent:1500}],spends:[{date:'2026-10-17',payee:'Costco',category:'Groceries',amount:120}]},
    {name:'Pocket',amount:400,period:'每周',categories:[],current:{start:'2026-10-18',end:'2026-10-24',spent:100},daysLeft:5,past:[],spends:[]}]};
const shareHandler=body=>body.action==='share_get'?response({snapshot,updatedAt:new Date().toISOString()}):null;
test('weekly share navigates weeks, flags overspending and copies the same text as the Mac',async t=>{
  const f=await fixture({handler:shareHandler});t.after(f.close);
  let copied='';Object.defineProperty(f.w.navigator,'clipboard',{value:{writeText:async x=>{copied=x;}}});
  f.d.querySelector('#tabs [data-tab="share"]').click();
  await until(()=>f.d.getElementById('weekPrev'));
  assert.match(f.d.getElementById('shareBody').textContent,/10-18 ~ 10-24/);
  assert.equal(f.d.getElementById('weekNext').disabled,true);
  assert.match(f.d.getElementById('shareBody').textContent,/进行中/);
  assert.match(f.d.getElementById('shareBody').textContent,/\$81\.25/);
  f.d.getElementById('shareCopy').click();await until(()=>copied);
  assert.equal(copied,['区间：2026-10-18 ~ 2026-10-24（周日–周六）','⏳ 这一周还没结束，数据截至今天 2026-10-19','',' 1.  $120.50   Costco  [10-19]  (1/2 × $241.00)','','合计：$120.50（1 笔）','剩余：$279.50（预算 $400）','已忽略 Restaurant - Vincent：2 笔（$30.00）'].join('\n'));
  f.d.getElementById('weekPrev').click();
  assert.match(f.d.getElementById('shareBody').textContent,/10-11 ~ 10-17/);
  assert.match(f.d.querySelector('#shareBody .big.bad').textContent,/-\$50\.00/);
  assert.equal(f.requests.filter(r=>r.action==='share_get').length,1);
});
test('budgets show progress, expand into history and compare the weekly share',async t=>{
  const f=await fixture({handler:shareHandler});t.after(f.close);
  f.d.querySelector('#tabs [data-tab="budget"]').click();
  await until(()=>f.d.querySelectorAll('#budgetBody .budget').length===2);
  const first=f.d.querySelectorAll('#budgetBody .budget')[0];
  assert.match(first.textContent,/\$1,700\.00/);assert.match(first.textContent,/剩余 \$300\.00/);
  assert.equal(first.querySelector('.meter i').className,'warn');
  first.querySelector('.head').click();
  assert.equal(f.d.querySelectorAll('#budgetBody .bars .bar').length,3);
  assert.match(f.d.querySelector('#budgetBody .detail').textContent,/过去 7 期中 1 期超支/);
  f.d.querySelectorAll('#budgetBody .budget')[1].querySelector('.head').click();
  assert.match(f.d.getElementById('budgetBody').textContent,/同一周的每周分摊：\$120\.50/);
});
test('missing Mac data and failures are explained, with a way to retry',async t=>{
  let fail=true;
  const f=await fixture({handler:b=>b.action==='share_get'?(fail?response({error:'服务器出错了'},500):response({snapshot:null,updatedAt:null})):null});t.after(f.close);
  f.d.querySelector('#tabs [data-tab="share"]').click();
  await until(()=>/服务器出错了/.test(f.d.getElementById('shareBody').textContent));
  fail=false;f.d.querySelector('#shareBody button').click();
  await until(()=>/Mac 还没有同步每周分摊/.test(f.d.getElementById('shareBody').textContent));
  assert.match(f.d.getElementById('budgetBody').textContent,/Mac 还没有同步预算/);
});
test('reconcile status and remembered rules are listed read-only',async t=>{
  const f=await fixture({handler:b=>b.action==='reconcile_status'?response({moneywizCount:10,matched:7,receiptOnlyCount:1,receiptOnly:[{id:'r',date:'2026-10-01',amount:12.5,merchant:'Cash Cafe'}]})
    :b.action==='lessons_list'?response({lessons:[{id:1,text:'饭团外卖的截图也是小票',created:'2026-10-05',pulled:true},{id:2,text:'<i>x</i>',created:'2026-10-06',pulled:false}]}):null});t.after(f.close);
  f.d.querySelector('#tabs [data-tab="more"]').click();
  await until(()=>f.d.querySelectorAll('#moreBody .lesson').length===2);
  assert.match(f.d.getElementById('moreBody').textContent,/Cash Cafe/);
  assert.equal(f.d.querySelectorAll('#moreBody .stat b')[1].textContent,'7');
  assert.match(f.d.getElementById('moreBody').textContent,/等待 Mac 同步/);
  assert.equal(f.d.querySelector('#moreBody i'),null);
  assert.equal(f.d.querySelector('#moreBody .lesson button'),null);
});
test('logging out clears the passcode and the loaded data',async t=>{
  const f=await fixture({handler:shareHandler});t.after(f.close);
  f.d.querySelector('#tabs [data-tab="share"]').click();await until(()=>f.d.getElementById('weekPrev'));
  click(f,'logout');
  assert.equal(f.w.localStorage.getItem('passcode'),null);
  assert.equal(f.d.getElementById('login').classList.contains('hidden'),false);
});
test('typed date is validated and saved for one receipt only',async t=>{
  const f=await fixture();t.after(f.close);
  f.d.querySelector('[data-receipt-id="'+first+'"] [aria-label^="修改"]').click();
  input(f,'receiptDate','2026-02-30');click(f,'dateSave');
  assert.match(f.d.getElementById('dateError').textContent,/有效日期/);
  assert.equal(f.requests.some(r=>r.action==='edit_receipt'),false);
  input(f,'receiptDate','20260930');
  assert.equal(f.d.getElementById('receiptCalendar').value,'2026-09-30');
  click(f,'dateSave');
  await until(()=>!f.d.getElementById('dateDialog').open&&f.d.getElementById('browseSummary').textContent.includes('9月30日'));
  assert.equal(f.state.records.find(r=>r.id===first).date,'2026-09-30');
  assert.equal(f.state.records.find(r=>r.id===second).date,'2026-10-08');
});
test('delete requires confirmation and sends only the single receipt id',async t=>{
  const f=await fixture();t.after(f.close);
  f.d.querySelector('[data-receipt-id="'+first+'"] .delete').click();
  assert.equal(f.state.records.length,2);
  assert.match(f.d.getElementById('deleteDialog').textContent,/PDF 源文件都会保留/);
  click(f,'deleteCancel');assert.equal(f.state.records.length,2);
  f.d.querySelector('[data-receipt-id="'+first+'"] .delete').click();click(f,'deleteSave');
  await until(()=>f.d.getElementById('libraryCount').textContent==='1 张小票');
  assert.deepEqual(f.requests.find(r=>r.action==='delete_receipt'),{action:'delete_receipt',id:first});
  assert.equal(f.state.records[0].id,second);
});
test('failed edit stays open and does not optimistically change the receipt',async t=>{
  const f=await fixture({handler:body=>body.action==='edit_receipt'?response({error:'保存失败'},500):null});t.after(f.close);
  f.d.querySelector('[data-receipt-id="'+first+'"] [aria-label^="修改"]').click();
  input(f,'receiptDate','2026-09-30');click(f,'dateSave');
  await until(()=>f.d.getElementById('dateError').textContent==='保存失败');
  assert.equal(f.d.getElementById('dateDialog').open,true);
  assert.equal(f.state.records[0].date,'2026-10-08');
  assert.equal(f.d.getElementById('dateSave').disabled,false);
});
test('stop aborts the fetch, preserves the draft, and ignores a late reply',async t=>{
  const f=await fixture();t.after(f.close);
  send(f,'first');await until(()=>f.chats.length===1);
  input(f,'q','next draft');click(f,'go');
  assert.equal(f.chats[0].options.signal.aborted,true);
  assert.equal(f.d.getElementById('q').value,'next draft');
  assert.match(f.d.getElementById('chatLog').textContent,/已停止/);
  send(f,'second');await until(()=>f.chats.length===2);
  f.chats[0].resolve(response({answer:'stale reply',onTopic:true,results:[]}));await sleep(20);
  assert.equal(f.d.getElementById('go').textContent,'停止');
  assert.equal(f.d.getElementById('chatLog').textContent.includes('stale reply'),false);
  f.chats[1].resolve(response({answer:'current reply',onTopic:true,results:[]}));
  await until(()=>f.d.getElementById('go').textContent==='发送');
  assert.match(f.d.getElementById('chatLog').textContent,/current reply/);
  send(f,'third');await until(()=>f.chats.length===3);
  assert.deepEqual(f.chats[2].body.history,[{q:'second',a:'current reply'}]);
  click(f,'go');
});
test('Escape cancels, and Enter while waiting does not accidentally send or stop',async t=>{
  const f=await fixture();t.after(f.close);
  send(f,'first');await until(()=>f.chats.length===1);
  const event=new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
  f.d.getElementById('q').dispatchEvent(event);assert.equal(event.defaultPrevented,true);
  f.d.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(f.chats[0].options.signal.aborted,true);
  assert.equal(f.d.getElementById('go').textContent,'发送');
});
test('last receipt deletion leaves an empty navigable calendar',async t=>{
  const f=await fixture({records:[{id:first,date:'2026-10-08',merchant:'First',total:1,items:[]}]});t.after(f.close);
  f.d.querySelector('.delete').click();click(f,'deleteSave');
  await until(()=>f.d.getElementById('libraryCount').textContent==='0 张小票');
  assert.equal(f.d.querySelectorAll('#cal button').length,31);
  assert.equal(f.d.querySelectorAll('#cal .has').length,0);
});
test('a slower old month cannot replace a newer selection',async t=>{
  let resolveOld;
  const f=await fixture({handler:body=>body.action==='list'&&body.month==='2026-08'?new Promise(r=>resolveOld=r):null});t.after(f.close);
  input(f,'jump','2026-08-01');click(f,'jumpForm');
  const old=f.w.eval("pickMonth('2026-08')");
  await until(()=>!!resolveOld);
  await f.w.eval("pickMonth('2026-09')");
  resolveOld(response({results:[{id:'old',date:'2026-08-01',merchant:'Old month',items:[]}]}));await old;
  assert.match(f.d.getElementById('browseSummary').textContent,/9月/);
  assert.equal(f.d.getElementById('browseList').textContent.includes('Old month'),false);
});
test('merchant and item strings are rendered as text',async t=>{
  const f=await fixture({records:[{id:first,date:'2026-10-08',merchant:'<img src=x onerror=alert(1)>',items:[{name:'<script>bad()</script>',quantity:1,price:1}]}]});t.after(f.close);
  assert.match(f.d.querySelector('.merchant').textContent,/<img/);
  assert.equal(f.d.querySelector('#browseList img'),null);
  assert.equal(f.d.querySelector('#browseList script'),null);
});
test('the calendar is always shown and its title opens a year of months with counts',async t=>{
  const f=await fixture({records:[
    {id:first,date:'2026-10-08',merchant:'First',total:1,items:[]},
    {id:second,date:'2026-08-03',merchant:'August',total:2,items:[]}]});t.after(f.close);
  assert.equal(f.d.getElementById('calTitle').textContent,'2026年10月');
  assert.equal(f.d.querySelectorAll('#cal .has').length,1);
  click(f,'monthBtn');
  const picker=f.d.getElementById('monthPicker');
  assert.equal(picker.classList.contains('hidden'),false);
  const months=[...picker.querySelectorAll('.grid button')];
  assert.equal(months.length,12);
  assert.match(months[7].textContent,/8月1 张/);
  assert.equal(months[6].classList.contains('none'),true);
  months[7].click();
  assert.equal(picker.classList.contains('hidden'),true);
  await until(()=>f.d.getElementById('browseList').textContent.includes('August'));
  assert.equal(f.d.getElementById('calTitle').textContent,'2026年8月');
  click(f,'calNext');
  await until(()=>f.d.getElementById('calTitle').textContent==='2026年9月'&&f.d.getElementById('browseList').textContent.includes('这个月没有小票'));
});
test('a jump to an invalid date is flagged under the field, and a day filter can return to the whole month',async t=>{
  const f=await fixture();t.after(f.close);
  input(f,'jump','2026-02-30');f.d.getElementById('jumpForm').requestSubmit();
  assert.equal(f.d.getElementById('jumpError').classList.contains('hidden'),false);
  input(f,'jump','10-8');f.d.getElementById('jumpForm').requestSubmit();
  await until(()=>f.d.getElementById('browseSummary').textContent.includes('10月8日'));
  assert.equal(f.d.getElementById('wholeMonth').classList.contains('hidden'),false);
  click(f,'wholeMonth');
  await until(()=>f.d.getElementById('browseSummary').textContent==='2026年10月 · 2 张');
});
test('a receipt shows three items until tapped',async t=>{
  const items=['A','B','C','D','E'].map(name=>({name,quantity:1,price:1}));
  const f=await fixture({records:[{id:first,date:'2026-10-08',merchant:'Long',total:5,currency:'USD',items}]});t.after(f.close);
  const paper=f.d.querySelector('.paper');
  assert.equal(paper.querySelectorAll('.r-item').length,3);
  assert.match(paper.textContent,/另有 2 项/);
  paper.click();
  assert.equal(f.d.querySelectorAll('.paper .r-item').length,5);
  assert.equal(paper.getAttribute('aria-expanded'),'true');
});

test('drafted events are edited, queued for the Mac, and say when the Mac is away',async t=>{
  let status='pending', mac={online:false,state:'sleeping',seenAt:new Date(Date.now()-10*60000).toISOString()};
  const f=await fixture({handler(body){
    if(body.action==='event_add') return response({id:7,mac,message:'Mac 正在睡眠（上次在线 10 分钟前），Mac 醒来并打开 AutoReceipt 后会自动添加，不用在这里等。'});
    if(body.action==='event_status') return response({status,result:status==='added'?'SweetHoney Dessert':'',mac,message:''});
  }});t.after(f.close);
  f.d.querySelector('#tabs [data-tab="chat"]').click();
  send(f,'周二 9 点半去 sweet honey');
  await until(()=>f.chats.length===1);
  const alt={title:'SweetHoney Dessert SLC',location:'',calendarId:'u',calendar:'Utah 2026',duration:45,timeZone:'',count:2,last:'2026-08-05'};
  const based={title:'SweetHoney Dessert',location:'4284 Spring Mountain Rd',calendarId:'p',calendar:'Personal',duration:30,timeZone:'',count:1,last:'2026-09-01'};
  f.chats[0].resolve(response({answer:'起草好了，请确认。',onTopic:true,scope:'待确认 1 个新 event · 日历',results:[],
    calendars:[{id:'p',title:'Personal',source:'iCloud',color:'#1BADF8'},{id:'u',title:'Utah 2026',source:'iCloud',color:'#63DA38'}],
    drafts:[{title:'SweetHoney Dessert',location:'4284 Spring Mountain Rd',calendarId:'p',day:'2026-10-27',start:'09:30',end:'10:00',allDay:false,
      timeZone:'America/Los_Angeles',alertMinutes:null,notes:'',basedOn:based,alternatives:[based,alt]}]}));
  await until(()=>f.d.querySelector('.evbox .ev'));
  const box=f.d.querySelector('.evbox');
  assert.match(box.textContent,/请确认 1 个新 event/);
  assert.equal(box.querySelector('select[aria-label="日历"]').value,'p');
  assert.equal(box.querySelector('select[aria-label="提醒"]').value,'','No alert by default');
  // Switching to the other past event takes its title and calendar; moving the start keeps the length.
  [...box.querySelectorAll('.ev-hist .chip')].find(b=>b.textContent.includes('SLC')).click();
  const ev=()=>f.d.querySelector('.evbox .ev');
  assert.equal(ev().querySelector('textarea').value,'SweetHoney Dessert SLC');
  assert.equal(ev().querySelector('select[aria-label="日历"]').value,'u');
  const start=ev().querySelector('input[aria-label="开始"]'); start.value='14:00'; start.dispatchEvent(new f.w.Event('change'));
  assert.equal(ev().querySelector('input[aria-label="结束"]').value,'14:30');
  const alert=ev().querySelector('select[aria-label="提醒"]'); alert.value='15'; alert.dispatchEvent(new f.w.Event('change'));
  [...f.d.querySelectorAll('.evbox .btn')].find(b=>b.textContent.startsWith('添加')).click();
  await until(()=>f.requests.some(r=>r.action==='event_add'));
  const sent=f.requests.find(r=>r.action==='event_add').events[0];
  assert.deepEqual({t:sent.title,c:sent.calendarId,s:sent.start,e:sent.end,a:sent.alertMinutes,z:sent.timeZone},
    {t:'SweetHoney Dessert SLC',c:'u',s:'14:00',e:'14:30',a:15,z:'America/Los_Angeles'});
  await until(()=>/Mac 正在睡眠/.test(f.d.querySelector('.evbox').textContent));
  assert.equal(f.d.querySelector('.evbox .ev textarea').disabled,true,'Submitted drafts are no longer editable');
  // The follow-up question carries the drafts, so "改到 10 点" knows what it changes.
  status='added'; mac={online:true,state:'online',seenAt:new Date().toISOString()};
  for(let n=0;n<400 && !/已添加到 Mac 的日历/.test(f.d.querySelector('.evbox').textContent);n++) await sleep(10);
  assert.match(f.d.querySelector('.evbox').textContent,/已添加 1 个 event/);
  send(f,'改到 10 点');
  await until(()=>f.chats.length===2);
  assert.match(f.chats[1].body.history[0].a,/Event drafts[\s\S]*SweetHoney Dessert SLC \| 2026-10-27 14:00-14:30/);
});

test('changes from the phone say when the Mac cannot pick them up now',async t=>{
  const away={online:false,state:'quit',seenAt:new Date(Date.now()-3*3600000).toISOString()};
  const f=await fixture({handler(body,_,state){
    if(body.action==='edit_receipt'){state.records.find(r=>r.id===body.id).date=body.date;return response({ok:true,mac:away});}
  }});t.after(f.close);
  f.d.querySelector('.receipt-card .r-acts button[title="修改日期"]').click();
  input(f,'receiptDate','2026-10-09');
  f.d.getElementById('dateForm').requestSubmit();
  await until(()=>/Mac 上的 AutoReceipt 已退出（上次在线 3 小时前）/.test(f.d.getElementById('notice').textContent));
});
