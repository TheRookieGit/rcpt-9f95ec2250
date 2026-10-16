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

test('archive, browse and chat share one page without tabs',async t=>{
  const f=await fixture();t.after(f.close);
  for(const id of ['paneUpload','paneBrowse','paneChat'])assert.equal(f.d.getElementById(id).classList.contains('hidden'),false);
  assert.equal(f.d.querySelector('nav'),null);
  assert.equal(f.d.getElementById('libraryCount').textContent,'2 张小票');
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
  click(f,'calToggle');assert.equal(f.d.querySelectorAll('#cal button').length,31);
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
