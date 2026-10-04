// SPDX-License-Identifier: GPL-3.0-only
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8');
function runtime(check) {
 const renders=[];const context=vm.createContext({state:{updateStatus:{state:'idle'}},updateStatusRevision:-1,
   acknowledgedMandatoryUpdate:'',api:{checkForUpdates:check},Number,Promise,
   saveSettings:async()=>{},mandatoryUpdateKey:x=>x?.version||'',renderUpdateStatus:()=>renders.push(context.state.updateStatus),
   renderMandatoryUpdateDialog(){},showToast(){},t:x=>x,updateErrorMessage:e=>String(e),
 });
 vm.runInContext(source.slice(source.indexOf('function handleUpdateStatus('),source.indexOf('async function downloadUpdate(')),context);
 return{context,renders};
}
test('late check reply cannot hide the green Install update notification',async()=>{
 let release;const pending=new Promise(r=>release=r);const f=runtime(()=>pending);
 const checking=f.context.checkUpdates(true);
 f.context.handleUpdateStatus({state:'downloaded',revision:5,info:{version:'0.3.66'}});
 release({state:'available',status:{state:'available',revision:4,info:{version:'0.3.66'}}});await checking;
 assert.equal(f.context.state.updateStatus.state,'downloaded');assert.equal(f.context.state.updateStatus.info.version,'0.3.66');
});
test('legacy check responses cannot overwrite newer push/download events',async()=>{
 let release;const pending=new Promise(r=>release=r);const f=runtime(()=>pending);const checking=f.context.checkUpdates(true);
 f.context.handleUpdateStatus({state:'downloaded',info:{version:'0.3.66'}});release({state:'checking'});await checking;
 assert.equal(f.context.state.updateStatus.state,'downloaded');
});
test('a check preserves verified update policy, deadline and version in its status snapshot',async()=>{
 const status={state:'downloaded',revision:12,info:{version:'0.3.66'},mandatory:{version:'0.3.66',mode:'semi-forced',deadline:9000}};
 const f=runtime(async()=>({state:'downloaded',status}));await f.context.checkUpdates(true);
 assert.equal(f.context.state.updateStatus.mandatory.deadline,9000);assert.equal(f.context.state.updateStatus.info.version,'0.3.66');
});

test('a late rejected check cannot erase a newly downloaded installer',async()=>{
 let reject;const pending=new Promise((_resolve,r)=>reject=r);const f=runtime(()=>pending);
 const checking=f.context.checkUpdates(true);
 f.context.handleUpdateStatus({state:'downloaded',revision:5,info:{version:'0.3.66'}});
 reject(new Error('offline'));await checking;
 assert.equal(f.context.state.updateStatus.state,'downloaded');assert.equal(f.context.state.updateStatus.info.version,'0.3.66');
});

test('a failed manual check preserves an already verified installer',async()=>{
 const f=runtime(async()=>{throw new Error('offline');});
 f.context.handleUpdateStatus({state:'downloaded',revision:5,info:{version:'0.3.66'}});
 await f.context.checkUpdates(false);assert.equal(f.context.state.updateStatus.state,'downloaded');
});

test('an idle failed check still reports the network error',async()=>{
 const f=runtime(async()=>{throw new Error('offline');});await f.context.checkUpdates(true);
 assert.equal(f.context.state.updateStatus.state,'error');
});
