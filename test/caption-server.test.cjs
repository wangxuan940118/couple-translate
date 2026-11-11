const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {once}=require('node:events');
const WebSocket=require('ws');
const {createServer}=require('../server.js');

async function fixture(t,options={}){
 const {server,wss}=createServer({env:{OPENAI_API_KEY:'fixture-key-not-real'},...options});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve))});
 return {origin,async peer(room='FIXTURE1'){
  const socket=new WebSocket(origin.replace('http:','ws:'));const messages=[],waiters=[];
  socket.on('message',raw=>{const m=JSON.parse(raw);messages.push(m);for(const waiter of [...waiters])if(waiter.predicate(m)){waiters.splice(waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(m)}});
  const wait=predicate=>{const old=messages.find(predicate);if(old)return Promise.resolve(old);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(Error('Timed out waiting for expected test packet'))},1500)};waiters.push(waiter)})};
  await once(socket,'open');const device=randomUUID();socket.send(JSON.stringify({type:'join',room,device}));await wait(m=>m.type==='joined');
  return {socket,messages,device,wait,send:m=>socket.send(JSON.stringify(m))};
 },translate:async(body,raw=false)=>fetch(origin+'/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:raw?body:JSON.stringify(body)})};
}
const success=text=>({ok:true,status:200,json:async()=>({choices:[{message:{content:text}}]})});

test('two-way caption/status packets preserve utterance identity and canonical sender without echo',async t=>{
 const app=await fixture(t),a=await app.peer(),b=await app.peer();const callId=randomUUID(),id=randomUUID();
 a.send({type:'caption-preview',id,revision:1,device:b.device,callId,text:'你好',lang:'zh-TW',unexpected:'discard'});
 const preview=await b.wait(m=>m.type==='caption-preview');
 assert.deepEqual(preview,{type:'caption-preview',id,revision:1,device:a.device,callId,text:'你好',lang:'zh-TW'});
 a.send({type:'speech-caption',id,revision:2,callId,text:'你好呀',lang:'zh-TW'});
 assert.equal((await b.wait(m=>m.type==='speech-caption')).revision,2);
 b.send({type:'speech-caption',id:randomUUID(),revision:0,callId,text:'Hello there',lang:'en'});
 assert.equal((await a.wait(m=>m.type==='speech-caption')).lang,'en');
 a.send({type:'speech-status',active:true,device:b.device,callId,extra:'discard'});
 assert.deepEqual(await b.wait(m=>m.type==='speech-status'),{type:'speech-status',active:true,device:a.device,callId});
 assert.equal(a.messages.some(m=>m.type==='caption-preview'||(m.type==='speech-status'&&m.device===a.device)),false);
});

test('invalid speech language, lengths, IDs and revisions are ignored without breaking socket',async t=>{
 const app=await fixture(t),a=await app.peer(),b=await app.peer();
 for(const value of [null,[],{type:'caption-preview',text:'hello',lang:'invalid'},
  {type:'caption-preview',text:'x'.repeat(301),lang:'en'},{type:'speech-caption',text:'x'.repeat(1001),lang:'en'},
  {type:'speech-caption',text:'hello',lang:'en',id:'invalid!'},
  {type:'speech-caption',text:'hello',lang:'en',revision:-1},
  {type:'speech-caption',text:'hello',lang:'en',revision:0.5},
  {type:'speech-caption',text:'hello',lang:'en',callId:'not-a-uuid'},
  {type:'speech-status',active:'true'}])a.send(value);
 a.send({type:'typing'});await b.wait(m=>m.type==='typing');
 assert.equal(b.messages.some(m=>['caption-preview','speech-caption','speech-status'].includes(m.type)),false);
});

test('speech packets remain isolated to joined room; unjoined sockets cannot inject them',async t=>{
 const app=await fixture(t),a=await app.peer(),b=await app.peer(),outsider=await app.peer('FIXTURE2');
 a.send({type:'speech-caption',id:randomUUID(),text:'Only our room',lang:'en'});
 await b.wait(m=>m.type==='speech-caption');
 a.send({type:'typing'});await b.wait(m=>m.type==='typing');
 assert.equal(outsider.messages.some(m=>m.type==='speech-caption'),false);
 const raw=new WebSocket(app.origin.replace('http:','ws:'));t.after(()=>raw.terminate());await once(raw,'open');
 raw.send(JSON.stringify({type:'speech-caption',text:'Blocked',lang:'en'}));
 a.send({type:'caption-preview',text:'Still connected',lang:'en'});await b.wait(m=>m.type==='caption-preview');
 assert.equal(a.messages.some(m=>m.text==='Blocked'),false);
});

test('chat acknowledgements and existing SDP/ICE signals still work alongside speech',async t=>{
 const app=await fixture(t),a=await app.peer(),b=await app.peer(),callId=randomUUID(),id=randomUUID();
 a.send({type:'caption',id,text:'Chat fixture',lang:'en'});
 assert.equal((await b.wait(m=>m.type==='caption')).text,'Chat fixture');
 b.send({type:'caption-received',id});assert.equal((await a.wait(m=>m.type==='caption-received')).id,id);
 for(const packet of [{type:'call-invite',mode:'audio',callId},{type:'offer',sdp:{type:'offer',sdp:'fixture'},callId},{type:'answer',sdp:{type:'answer',sdp:'fixture'},callId},{type:'ice',candidate:{candidate:'fixture'},callId}]){
  a.send(packet);assert.deepEqual(await b.wait(m=>m.type===packet.type),packet);
 }
});

test('translation targets are explicit and support both zh-TW→en and en→zh-TW, including long speech',async t=>{
 const requests=[];const app=await fixture(t,{fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return success(requests.length===1?'Hello':'你好')}});
 assert.deepEqual(await (await app.translate({text:'你好',from:'zh-TW',to:'en'})).json(),{translation:'Hello'});
 assert.deepEqual(await (await app.translate({text:'Hello',from:'en',to:'zh-TW'})).json(),{translation:'你好'});
 assert.match(requests[0].messages[0].content,/Traditional Chinese \(Taiwan\) into English/);
 assert.match(requests[1].messages[0].content,/English into Traditional Chinese \(Taiwan\)/);
 const long=await app.translate({text:'x'.repeat(1000),from:'en',to:'zh-TW'});assert.equal(long.status,200);
 assert.equal(requests.at(-1).messages[1].content.length,1000);
});

test('invalid translation requests fail clearly; same-language text avoids provider; missing key is explicit',async t=>{
 let calls=0;const app=await fixture(t,{fetch:async()=>{calls++;return success('unused')}});
 for(const body of [{text:'',from:'en',to:'zh-TW'},{text:'x'.repeat(1001),from:'en',to:'zh-TW'},{text:'hi',from:'wrong',to:'en'},null]){
  const r=await app.translate(body);assert.equal(r.status,400);assert.equal((await r.json()).code,'INVALID_TRANSLATION');
 }
 assert.equal((await app.translate('{bad',true)).status,400);
 assert.deepEqual(await (await app.translate({text:' hello ',from:'en',to:'en'})).json(),{translation:'hello'});assert.equal(calls,0);
 const missing=await fixture(t,{env:{}});const r=await missing.translate({text:'hello',from:'en',to:'zh-TW'});assert.equal(r.status,503);assert.equal((await r.json()).code,'TRANSLATION_NOT_CONFIGURED');
});

test('provider access/quota errors are useful and never expose provider body or request details',async t=>{
 let status=401;const app=await fixture(t,{fetch:async()=>({ok:false,status,json:async()=>({error:{code:'PRIVATE_PROVIDER_DETAILS',message:'PRIVATE_PROVIDER_DETAILS'}})})});
 let r=await app.translate({text:'hello',from:'en',to:'zh-TW'});let d=await r.json();assert.equal(r.status,502);assert.equal(d.code,'TRANSLATION_ACCESS');assert.doesNotMatch(JSON.stringify(d),/PRIVATE_PROVIDER|fixture-key/);
 status=429;r=await app.translate({text:'hello',from:'en',to:'zh-TW'});d=await r.json();assert.equal(r.status,429);assert.equal(d.code,'TRANSLATION_QUOTA');
});

test('a pending or failed translation does not block call signaling or caption delivery',async t=>{
 let release,started;const entered=new Promise(resolve=>started=resolve);
 const app=await fixture(t,{fetch:async()=>{started();await new Promise(resolve=>release=resolve);throw Error('provider unavailable')}});
 const a=await app.peer(),b=await app.peer();const pending=app.translate({text:'hello',from:'en',to:'zh-TW'});await entered;
 a.send({type:'ice',candidate:{candidate:'fixture-candidate'}});assert.equal((await b.wait(m=>m.type==='ice')).candidate.candidate,'fixture-candidate');
 a.send({type:'speech-caption',text:'Original remains available',lang:'en',id:randomUUID()});assert.equal((await b.wait(m=>m.type==='speech-caption')).text,'Original remains available');
 release();const r=await pending;assert.equal(r.status,502);assert.equal((await r.json()).code,'TRANSLATION_NETWORK');
 a.send({type:'call-accept'});assert.equal((await b.wait(m=>m.type==='call-accept')).type,'call-accept');
});

test('translation has a separate 120/min limit rather than failing after 30 calls',async t=>{
 const app=await fixture(t,{fetch:async()=>success('translated')});
 for(let i=0;i<120;i++){const r=await app.translate({text:'fixture '+i,from:'en',to:'zh-TW'});assert.equal(r.status,200,'request '+i);await r.arrayBuffer()}
 const r=await app.translate({text:'over limit',from:'en',to:'zh-TW'});assert.equal(r.status,429);assert.equal((await r.json()).code,'TRANSLATION_RATE_LIMIT');
 assert.equal((await fetch(app.origin+'/api/push/key')).status,200);
});

test('provider timeout is bounded and leaves the socket connected',async t=>{
 const app=await fixture(t,{fetch:async(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))});
 const a=await app.peer(),b=await app.peer();const before=Date.now();const r=await app.translate({text:'hello',from:'en',to:'zh-TW'});
 assert.equal(r.status,504);assert.equal((await r.json()).code,'TRANSLATION_TIMEOUT');assert.ok(Date.now()-before<13000);
 a.send({type:'speech-status',active:true});assert.equal((await b.wait(m=>m.type==='speech-status')).active,true);
});
