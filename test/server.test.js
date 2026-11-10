const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Readable}=require('node:stream');
const {createServer,LANGUAGES,rtcConfiguration}=require('../server');
function fixture(t,options={}){
 const server=createServer({env:{},...options});
 class Peer extends EventEmitter{
  constructor(){super();this.readyState=1;this.messages=[];server.wss.clients.add(this);server.wss.emit('connection',this)}
  send(raw){this.messages.push(JSON.parse(raw))}
  client(value){this.emit('message',Buffer.from(typeof value==='string'?value:JSON.stringify(value)))}
  take(){return this.messages.splice(0)}
  ping(){this.emit('pong')}
  close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');server.wss.clients.delete(this)}
  terminate(){this.close()}
 }
 t.after(()=>{for(const peer of [...server.wss.clients])peer.close();server.emit('close');server.wss.close()});
 function join(room='LOVE2026'){const peer=new Peer();peer.client({type:'join',room});return {peer,joined:peer.take()[0]}}
 async function request(url,body,headers={},method=body===undefined?'GET':'POST'){
  const req=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);Object.assign(req,{url,method,headers,socket:{remoteAddress:'127.0.0.1'}});
  return new Promise((resolve,reject)=>{const response={destroyed:false,writableEnded:false,writeHead(status,headers){this.status=status;this.headers=headers},end(raw){this.writableEnded=true;try{resolve({status:this.status,headers:this.headers,body:JSON.parse(raw)})}catch{resolve({status:this.status,headers:this.headers,body:raw})}}};try{server.emit('request',req,response)}catch(e){reject(e)}});
 }
 return {server,Peer,join,request};
}
function pair(f){const a=f.join(),b=f.join();a.peer.take();return {a,b}}
function accepted(f,id='call-1'){const {a,b}=pair(f);a.peer.client({type:'call-invite',callId:id,mode:'audio'});b.peer.take();b.peer.client({type:'call-accept',callId:id});a.peer.take();return {a,b,id}}

test('malformed WS input cannot crash rooms; room capacity and isolation stay enforced',t=>{
 const f=fixture(t),a=f.join(),b=f.join(),other=f.join('OTHER2026');a.peer.take();b.peer.take();
 for(const input of ['null','[]','{','42'])a.peer.client(input);
 const c=f.join();assert.equal(c.joined.message,'Room is full');
 a.peer.client({type:'chat',id:'message-one',text:'你好',lang:'zh-TW'});assert.equal(b.peer.take()[0].text,'你好');assert.deepEqual(other.peer.take(),[]);assert.deepEqual(a.peer.take(),[]);
 a.peer.client({type:'join',room:'OTHER2026'});assert.equal(a.peer.take()[0].message,'Already joined a room');
 a.peer.close();assert.equal(b.peer.take()[0].type,'peer-left');c.peer.client({type:'join',room:'LOVE2026'});assert.equal(c.peer.take()[0].type,'joined');
});
test('call identities, accepted state and sender role gate every signal and speech stays separate',t=>{
 const f=fixture(t),{a,b,id}=accepted(f);const outsider=f.join('OTHER2026');
 a.peer.client({type:'call-invite',callId:'another-call',mode:'video'});assert.equal(a.peer.take()[0].type,'call-busy');
 a.peer.client({type:'offer',callId:'old-call',sdp:{type:'offer',sdp:'v=0'}});b.peer.client({type:'offer',callId:id,sdp:{type:'offer',sdp:'v=0'}});assert.deepEqual(a.peer.take(),[]);assert.deepEqual(b.peer.take(),[]);
 a.peer.client({type:'offer',callId:id,sdp:{type:'offer',sdp:'v=0'}});assert.equal(b.peer.take()[0].type,'offer');
 b.peer.client({type:'answer',callId:id,sdp:{type:'answer',sdp:'v=0'}});assert.equal(a.peer.take()[0].type,'answer');
 a.peer.client({type:'speech-interim',callId:id,id:'sentence-1',seq:1,text:'Hello',lang:'en'});assert.equal(b.peer.take()[0].type,'speech-interim');
 a.peer.client({type:'speech-caption',callId:id,id:'sentence-1',seq:1,text:'Hello there',lang:'en'});assert.equal(b.peer.take()[0].type,'speech-caption');
 a.peer.client({type:'speech-caption',callId:id,id:'sentence-1',seq:1,text:'duplicate',lang:'en'});assert.deepEqual(b.peer.take(),[]);
 a.peer.client({type:'speech-interim',callId:id,id:'sentence-2',seq:2,text:'New',lang:'en'});b.peer.take();a.peer.client({type:'speech-caption',callId:id,id:'old',seq:1,text:'Old',lang:'en'});assert.deepEqual(b.peer.take(),[]);assert.deepEqual(outsider.peer.take(),[]);
 a.peer.client({type:'call-end',callId:id});assert.equal(b.peer.take()[0].type,'call-end');a.peer.client({type:'ice',callId:id,candidate:{candidate:'stale'}});assert.deepEqual(b.peer.take(),[]);
});
test('TURN credentials require current room membership and never appear in health',async t=>{
 const secrets={TURN_URLS:'turns:relay.example.test:443?transport=tcp',TURN_USERNAME:'private-user',TURN_PASSWORD:'private-password',BUILD_SHA:'a'.repeat(40)};
 const f=fixture(t,{env:secrets}),a=f.join();assert.equal((await f.request('/api/rtc-config')).status,401);
 const config=await f.request('/api/rtc-config',undefined,{'x-room-token':a.joined.roomToken});assert.equal(config.status,200);assert.equal(config.body.turnConfigured,true);assert.equal(config.body.iceServers[1].credential,secrets.TURN_PASSWORD);
 const health=await f.request('/api/health');assert.equal(health.body.commit,secrets.BUILD_SHA);assert.ok(!JSON.stringify(health).includes(secrets.TURN_PASSWORD));assert.ok(!JSON.stringify(health).includes(secrets.TURN_USERNAME));assert.ok(!JSON.stringify(health).includes('relay.example'));
 a.peer.close();assert.equal((await f.request('/api/rtc-config',undefined,{'x-room-token':a.joined.roomToken})).status,401);
 assert.equal(rtcConfiguration({TURN_URLS:'https://not-a-relay'}).turnConfigured,false);
});
test('translation validates ten languages, preserves direction and deduplicates only inside a room',async t=>{
 let resolveProvider,providerCalls=0;const calls=[];
 const f=fixture(t,{env:{OPENAI_API_KEY:'server-private-key'},fetch:async(url,options)=>{providerCalls++;calls.push(JSON.parse(options.body));if(providerCalls===1)await new Promise(resolve=>{resolveProvider=resolve});return Response.json({choices:[{finish_reason:'stop',message:{content:'translated'}}]})}});
 const {a,b}=pair(f),headerA={'x-room-token':a.joined.roomToken},headerB={'x-room-token':b.joined.roomToken},body={text:'hello',from:'en',to:'zh-TW'};
 const one=f.request('/api/translate',body,headerA),two=f.request('/api/translate',body,headerB);await new Promise(r=>setImmediate(r));assert.equal(providerCalls,1);resolveProvider();assert.equal((await one).body.translation,'translated');assert.equal((await two).body.translation,'translated');assert.equal((await f.request('/api/translate',body,headerA)).status,200);assert.equal(providerCalls,1);
 const other=f.join('OTHER2026');await f.request('/api/translate',body,{'x-room-token':other.joined.roomToken});assert.equal(providerCalls,2);
 for(const lang of Object.keys(LANGUAGES))assert.equal((await f.request('/api/translate',{text:'words',from:lang,to:'en'},headerA)).status,200);
 assert.ok(calls[0].messages[0].content.includes('from English into Traditional Chinese (Taiwan)'));
 assert.equal((await f.request('/api/translate',{...body,from:'invalid'},headerA)).status,400);assert.equal((await f.request('/api/translate',{...body,text:''},headerA)).status,400);assert.equal((await f.request('/api/translate','null',headerA)).status,400);
 assert.equal((await f.request('/api/translate',body,{'x-room-token':'expired'})).status,401);
});
test('translation API failure never ends accepted calls and does not expose provider secrets',async t=>{
 const f=fixture(t,{env:{OPENAI_API_KEY:'super-private-key'},fetch:async()=>Response.json({error:{message:'super-private-key'}},{status:429})});const {a,b,id}=accepted(f);
 const error=await f.request('/api/translate',{text:'hello',from:'en',to:'zh-TW'},{'x-room-token':a.joined.roomToken});assert.equal(error.status,429);assert.ok(!JSON.stringify(error).includes('super-private-key'));
 a.peer.client({type:'ice',callId:id,candidate:{candidate:'still-live'}});assert.equal(b.peer.take()[0].type,'ice');
 const missing=fixture(t);assert.equal((await missing.request('/api/translate',{text:'same',from:'en',to:'en'})).body.translation,'same');assert.equal((await missing.request('/api/translate',{text:'hello',from:'en',to:'zh-TW'})).status,503);
});
