// SPDX-License-Identifier: GPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWorkshopDetails, clearWorkshopDetailsCache } = require('../src/core/workshopDetails');
const ID = '672B0395726428B6';
function deferred() { let resolve, reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
function response(id=ID, version='1.0') {
  const data={props:{pageProps:{asset:{id,name:'Details '+id,currentVersionNumber:version}}}};
  return new Response(`<script id="__NEXT_DATA__">${JSON.stringify(data)}</script>`,{status:200});
}
test('150 concurrent requests for a card share one network operation', async () => {
  clearWorkshopDetailsCache(); let calls=0; const gate=deferred();
  const fetchImpl=async()=>{calls++; await gate.promise; return response();};
  const pending=Array.from({length:150},()=>fetchWorkshopDetails(ID,{fetchImpl}));
  gate.resolve(); const results=await Promise.all(pending);
  assert.equal(calls,1); assert.ok(results.every(x=>x.modId===ID));
});
test('a slow old request cannot overwrite information obtained by a refresh', async () => {
  clearWorkshopDetailsCache(); const gate=deferred(); let calls=0;
  const fetchImpl=async()=>{if(++calls===1){await gate.promise;return response(ID,'1.0');} return response(ID,'2.0');};
  const old=fetchWorkshopDetails(ID,{fetchImpl});
  const fresh=await fetchWorkshopDetails(ID,{fetchImpl,refresh:true});
  gate.resolve(); await old;
  assert.equal(fresh.version,'2.0'); assert.equal((await fetchWorkshopDetails(ID,{fetchImpl})).version,'2.0');
  assert.equal(calls,2);
});
test('details expire after one minute and TTL begins when the response finishes', async () => {
  clearWorkshopDetailsCache(); let clock=1000, calls=0;
  const fetchImpl=async()=>{calls++; clock+=40_000;return response(ID,String(calls));};
  const options={fetchImpl,now:()=>clock};
  await fetchWorkshopDetails(ID,options); clock+=59_999;
  assert.equal((await fetchWorkshopDetails(ID,options)).version,'1');
  clock++; assert.equal((await fetchWorkshopDetails(ID,options)).version,'2'); assert.equal(calls,2);
});
test('failed and malformed responses never prevent a later successful retry', async () => {
  clearWorkshopDetailsCache(); let calls=0;
  const fetchImpl=async()=>{calls++;if(calls===1)throw new Error('offline');return response(calls===2?'646B350F36C6D3E4':ID);};
  await assert.rejects(fetchWorkshopDetails(ID,{fetchImpl}));
  await assert.rejects(fetchWorkshopDetails(ID,{fetchImpl}));
  assert.equal((await fetchWorkshopDetails(ID,{fetchImpl})).modId,ID);assert.equal(calls,3);
});
test('clearing caches while a request is pending prevents stale cache resurrection', async () => {
  clearWorkshopDetailsCache(); const gate=deferred(); let calls=0;
  const fetchImpl=async()=>{if(++calls===1){await gate.promise;return response(ID,'old');}return response(ID,'new');};
  const old=fetchWorkshopDetails(ID,{fetchImpl}); clearWorkshopDetailsCache();
  await fetchWorkshopDetails(ID,{fetchImpl}); gate.resolve();await old;
  assert.equal((await fetchWorkshopDetails(ID,{fetchImpl})).version,'new');assert.equal(calls,2);
});
test('one aborted card request does not abort another caller', async () => {
  clearWorkshopDetailsCache();const controller=new AbortController();let calls=0;
  const fetchImpl=async(_url,{signal})=>{calls++;if(signal.aborted)throw new DOMException('aborted','AbortError');return response();};
  controller.abort();await assert.rejects(fetchWorkshopDetails(ID,{fetchImpl,signal:controller.signal}));
  assert.equal((await fetchWorkshopDetails(ID,{fetchImpl})).modId,ID);assert.equal(calls,2);
});
test('browsing 300 distinct cards bounds the cache and preserves recently viewed cards', async () => {
  clearWorkshopDetailsCache();let calls=0;
  const fetchImpl=async url=>{calls++;return response(url.split('/').at(-1));};
  for(let i=1;i<=300;i++)await fetchWorkshopDetails(i.toString(16).padStart(16,'0'),{fetchImpl});
  await fetchWorkshopDetails((300).toString(16).padStart(16,'0'),{fetchImpl});assert.equal(calls,300);
  await fetchWorkshopDetails('0000000000000001',{fetchImpl});assert.equal(calls,301);
});
