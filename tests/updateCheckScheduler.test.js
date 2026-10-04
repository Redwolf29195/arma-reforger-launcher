// SPDX-License-Identifier: GPL-3.0-only
const test=require('node:test');
const assert=require('node:assert/strict');
const { createUpdateCheckScheduler, PERIOD_MS }=require('../src/main/updateCheckScheduler');
function fixture(overrides={}) {
  let clock=0, count=0, id=0, state='idle', allowed=true;const timers=new Map(),errors=[];
  const scheduler=createUpdateCheckScheduler({
    check:async()=>{count++;},getState:()=>state,enabled:()=>allowed,now:()=>clock,
    setTimer:(fn,delay)=>{timers.set(++id,{fn,at:clock+delay});return id;},
    clearTimer:key=>timers.delete(key),onError:error=>errors.push(error),...overrides
  });
  return{scheduler,timers,errors,get count(){return count;},setState:x=>state=x,setEnabled:x=>allowed=x,
    async advance(ms){clock+=ms;for(const [key,value]of[...timers])if(value.at<=clock){timers.delete(key);await value.fn();}}
  };
}
test('checks at startup and every minute without requiring a server push',async()=>{
 const f=fixture();f.scheduler.start();await f.advance(1500);assert.equal(f.count,1);
 for(let i=0;i<120;i++)await f.advance(PERIOD_MS);
 assert.equal(f.count,121);assert.equal(f.timers.size,1);f.scheduler.stop();assert.equal(f.timers.size,0);
});
test('focus checks are throttled and do not overlap periodic checks',async()=>{
 const f=fixture();f.scheduler.start();await Promise.all(Array.from({length:100},()=>f.scheduler.focus()));assert.equal(f.count,1);
 await f.scheduler.focus();assert.equal(f.count,1);await f.advance(15_000);await f.scheduler.focus();assert.equal(f.count,2);f.scheduler.stop();
});
test('does not reset the update notification or a verified installer while busy',async()=>{
 const f=fixture();f.scheduler.start();for(const state of ['checking','available','downloading','verifying','downloaded']){
 f.setState(state);await f.advance(PERIOD_MS);await f.scheduler.focus();}
 assert.equal(f.count,0);f.setState('current');await f.advance(PERIOD_MS);assert.equal(f.count,1);f.scheduler.stop();
});
test('disabled distributions never make periodic or focus update requests',async()=>{
 const f=fixture();f.setEnabled(false);f.scheduler.start();await f.advance(PERIOD_MS);await f.scheduler.focus();assert.equal(f.count,0);f.scheduler.stop();
});
test('a network failure is retried on the next minute and stopping cancels future work',async()=>{
 let calls=0;const f=fixture({check:async()=>{if(++calls===1)throw new Error('offline');}});f.scheduler.start();
 await f.advance(1500);assert.equal(f.errors.length,1);await f.advance(PERIOD_MS);assert.equal(calls,2);
 f.scheduler.stop();await f.advance(PERIOD_MS*5);await f.scheduler.focus();assert.equal(calls,2);
});
