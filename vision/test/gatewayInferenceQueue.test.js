'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const axios=require('axios');
const gateway=require('../gateway/app');
const pause=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function response(url,payload){
  if(url.endsWith('/detect'))return {data:{detections:[],image_size:{width:100,height:100}}};
  if(url.endsWith('/extract'))return {data:{words:[],full_text:payload.image_b64}};
  if(url.endsWith('/merge'))return {data:{elements:[]}};
  throw new Error('Unexpected network target in offline test');
}
test('all visual pipeline callers serialize while health stays available',async()=>{
  const originalPost=axios.post,originalGet=axios.get;
  const release=deferred(),started=deferred(),calls=[];
  axios.post=async(url,payload)=>{calls.push({url,tag:payload.image_b64});if(url.endsWith('/extract')&&payload.image_b64==='first'){started.resolve();await release.promise;}return response(url,payload);};
  axios.get=async()=>({data:{status:'ok'}});
  try{
    const direct=gateway.buildVisualDOM({image_b64:'first'});await started.promise;
    let secondResult,thirdResult;
    const res=assign=>({json:assign,status(){return this;}});
    const second=gateway.processHandler({body:{image_b64:'second'}},res(v=>{secondResult=v;}));
    const third=gateway.processHandler({body:{image_b64:'third'}},res(v=>{thirdResult=v;}));
    await pause();assert.equal(calls.some(c=>c.tag==='second'||c.tag==='third'),false);
    const router=gateway.app._router||gateway.app.router;
    const health=router.stack.find(layer=>layer.route?.path==='/vision/health').route.stack[0].handle;
    let healthResult;await health({},res(v=>{healthResult=v;}));assert.equal(healthResult.checks.length,4);assert.ok(healthResult.checks.every(c=>c.status==='ok'));
    release.resolve();assert.equal((await direct).raw.full_text,'first');await Promise.all([second,third]);
    assert.equal(secondResult.raw.full_text,'second');assert.equal(thirdResult.raw.full_text,'third');
    assert.deepEqual(calls.filter(c=>c.url.endsWith('/extract')).map(c=>c.tag),['first','second','third']);
  }finally{release.resolve();axios.post=originalPost;axios.get=originalGet;}
});
test('an inference failure waits for its peer to drain and does not poison later requests',async()=>{
  const original=axios.post,release=deferred(),started=deferred();const calls=[];
  axios.post=async(url,payload)=>{
    calls.push({url,tag:payload.image_b64});
    if(payload.image_b64==='bad'&&url.endsWith('/detect'))throw new Error('controlled inference failure');
    if(payload.image_b64==='bad'&&url.endsWith('/extract')){started.resolve();await release.promise;}
    return response(url,payload);
  };
  try{
    const failing=gateway.buildVisualDOM({image_b64:'bad'});const rejected=assert.rejects(failing,/controlled inference failure/);await started.promise;
    const following=gateway.buildVisualDOM({image_b64:'after'});await pause();assert.equal(calls.some(c=>c.tag==='after'),false);
    release.resolve();await rejected;assert.equal((await following).raw.full_text,'after');
  }finally{release.resolve();axios.post=original;}
});
