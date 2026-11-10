const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events');
const {Readable}=require('node:stream');
const crypto=require('node:crypto');
const {createServer,LANGUAGES,rtcConfiguration}=require('../server');
const USER_A='11111111-1111-4111-8111-111111111111',USER_B='22222222-2222-4222-8222-222222222222';
const CODE_A='LOVE2026',CODE_B='OTHER2026';
const err=(status,code)=>Object.assign(Error(code),{status,code});
// A durable-adapter test double; these tests do not claim a live database was exercised.
function fakePrivateChat(){
 const rooms=new Map(),records=new Map();let writes=0;
 const status=()=>({mode:'postgres',configured:true,healthy:true});
 const member=(user,id)=>{const room=rooms.get(id);if(!room?.members.has(user.id))throw err(403,'FORBIDDEN');return room};
 const api={status,publicConfig:()=>({url:'https://project.example.test',anonKey:'public-anon-key'}),
 async authenticate(token){const id=token==='token-a'?USER_A:token==='token-b'?USER_B:null;if(!id)throw err(401,'AUTH_REQUIRED');return {id,email:id+'@test.invalid',expiresAt:Date.now()+3600000}},
 async joinRoom(user,code){let room=[...rooms.values()].find(room=>room.code===code);if(!room){room={id:crypto.randomUUID(),code,createdAt:Date.now(),updatedAt:Date.now(),members:new Set()};rooms.set(room.id,room)}room.members.add(user.id);return {id:room.id,createdAt:room.createdAt,updatedAt:room.updatedAt}},
 async getRoom(user,id){const room=member(user,id);return {id:room.id,createdAt:room.createdAt,updatedAt:room.updatedAt}},
 async resume(user){return [...rooms.values()].filter(room=>room.members.has(user.id)).map(({id,createdAt,updatedAt})=>({id,createdAt,updatedAt}))},
 async listMessages(user,id,{before,limit=50}={}){member(user,id);let items=[...records.values()].filter(message=>message.roomId===id);if(before)items=items.filter(message=>message.timestamp<Number(before));items.sort((a,b)=>b.timestamp-a.timestamp||b.id.localeCompare(a.id));const page=items.slice(0,limit);return {messages:page.reverse().map(({roomId,...message})=>message),nextCursor:items.length>limit?String(page[0].timestamp):null}},
 async saveMessage(user,id,input){member(user,id);const old=records.get(input.id);if(old){if(old.roomId!==id||old.authorId!==user.id||old.text!==input.text||old.lang!==input.lang)throw err(409,'MESSAGE_ID_CONFLICT');const {roomId,...message}=old;return {...message,duplicate:true}}writes++;const message={...input,authorId:user.id,timestamp:Date.now()+writes,roomId:id};records.set(input.id,message);const {roomId,...saved}=message;return {...saved,duplicate:false}}
 };return api;
}
function fixture(t,options={}){
 const privateChat=options.privateChat||fakePrivateChat(),server=createServer({env:{},privateChat,...options});
 class Peer extends EventEmitter{
  constructor(){super();this.readyState=1;this.messages=[];server.wss.clients.add(this);server.wss.emit('connection',this)}
  send(raw){const data=JSON.parse(raw);this.messages.push(data);this.emit(data.type==='error'?'wire-error':data.type,data)}
  client(value){this.emit('message',Buffer.from(typeof value==='string'?value:JSON.stringify(value)))}
  take(){return this.messages.splice(0)}
  ping(){this.emit('pong')}
  close(code){if(this.readyState===3)return;this.readyState=3;this.closeCode=code;this.emit('close');server.wss.clients.delete(this)}
  terminate(){this.close()}
 }
 t.after(()=>{for(const peer of [...server.wss.clients])peer.close();server.emit('close');server.wss.close()});
 async function join(room=CODE_A,token='token-a',extras={}){const peer=new Peer(),done=new Promise(resolve=>{peer.once('joined',joined=>resolve({joined}));peer.once('wire-error',error=>resolve({joined:error}))});peer.client({type:'join',room,accessToken:token,device:token==='token-a'?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',...extras});const result=await done;await new Promise(r=>setImmediate(r));const messages=peer.take();return {peer,...result,history:messages.find(message=>message.type==='chat-history')}}
 async function request(url,body,headers={},method=body===undefined?'GET':'POST'){
  const req=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);Object.assign(req,{url,method,headers,socket:{remoteAddress:'127.0.0.1'}});
  return new Promise((resolve,reject)=>{const response={destroyed:false,writableEnded:false,writeHead(status,headers){this.status=status;this.headers=headers},end(raw){this.writableEnded=true;try{resolve({status:this.status,headers:this.headers,body:JSON.parse(raw)})}catch{resolve({status:this.status,headers:this.headers,body:raw})}}};try{server.emit('request',req,response)}catch(e){reject(e)}});
 }
 return {server,privateChat,Peer,join,request};
}
async function pair(f){const a=await f.join(),b=await f.join(CODE_A,'token-b');a.peer.take();return {a,b}}
async function accepted(f,id='call-1'){const {a,b}=await pair(f);a.peer.client({type:'call-invite',callId:id,mode:'audio'});b.peer.take();b.peer.client({type:'call-accept',callId:id});a.peer.take();return {a,b,id}}
async function post(peer,text='你好',lang='zh-TW',id=crypto.randomUUID()){const saved=once(peer,'chat-saved');peer.client({type:'chat',id,text,lang});return (await saved)[0]}

test('malformed input, unverified users and second-tab identity cannot impersonate a partner',async t=>{
 const f=fixture(t),{a,b}=await pair(f);a.peer.take();b.peer.take();
 for(const input of ['null','[]','{','42'])a.peer.client(input);
 const outsider=await f.join(CODE_A,'third-user');assert.equal(outsider.joined.code,'AUTH_REQUIRED');assert.equal(outsider.peer.room,undefined);
 await post(a.peer);assert.equal(b.peer.take()[0].text,'你好');assert.deepEqual(outsider.peer.take(),[]);
 a.peer.client({type:'join',room:CODE_B,accessToken:'token-a'});assert.equal(a.peer.take().at(-1).code,'ALREADY_JOINED');
 const replacement=await f.join(CODE_A,'token-a');assert.equal(a.peer.closeCode,4001);assert.equal(replacement.joined.count,2);assert.equal(b.peer.take().filter(m=>m.type==='peer-joined').length,1);
 replacement.peer.close();assert.equal(b.peer.take()[0].type,'peer-left');
});
test('call IDs, roles and accepted state gate signals; speech remains separate from history',async t=>{
 const f=fixture(t),{a,b,id}=await accepted(f);
 a.peer.client({type:'call-invite',callId:'another-call',mode:'video'});assert.equal(a.peer.take()[0].type,'call-busy');
 a.peer.client({type:'offer',callId:'old-call',sdp:{type:'offer',sdp:'v=0'}});b.peer.client({type:'offer',callId:id,sdp:{type:'offer',sdp:'v=0'}});assert.deepEqual(a.peer.take(),[]);assert.deepEqual(b.peer.take(),[]);
 a.peer.client({type:'offer',callId:id,sdp:{type:'offer',sdp:'v=0'}});assert.equal(b.peer.take()[0].type,'offer');
 b.peer.client({type:'answer',callId:id,sdp:{type:'answer',sdp:'v=0'}});assert.equal(a.peer.take()[0].type,'answer');
 a.peer.client({type:'speech-interim',callId:id,id:'sentence-1',seq:1,text:'Hello',lang:'en'});assert.equal(b.peer.take()[0].type,'speech-interim');
 a.peer.client({type:'speech-caption',callId:id,id:'sentence-1',seq:1,text:'Hello there',lang:'en'});assert.equal(b.peer.take()[0].type,'speech-caption');
 a.peer.client({type:'speech-caption',callId:id,id:'sentence-1',seq:1,text:'duplicate',lang:'en'});assert.deepEqual(b.peer.take(),[]);
 a.peer.client({type:'speech-interim',callId:id,id:'sentence-2',seq:2,text:'New',lang:'en'});b.peer.take();a.peer.client({type:'speech-caption',callId:id,id:'old',seq:1,text:'Old',lang:'en'});assert.deepEqual(b.peer.take(),[]);
 const history=await f.request('/api/messages?room='+a.joined.roomId,undefined,{authorization:'Bearer token-a'});assert.deepEqual(history.body.messages,[]);
 a.peer.client({type:'call-end',callId:id});assert.equal(b.peer.take()[0].type,'call-end');a.peer.client({type:'ice',callId:id,candidate:{candidate:'stale'}});assert.deepEqual(b.peer.take(),[]);
});
test('TURN credentials require current authenticated membership and health exposes no secrets',async t=>{
 const secrets={TURN_URLS:'turns:relay.example.test:443?transport=tcp',TURN_USERNAME:'private-user',TURN_PASSWORD:'private-password',BUILD_SHA:'a'.repeat(40)};
 const f=fixture(t,{env:secrets}),a=await f.join();assert.equal((await f.request('/api/rtc-config')).status,401);
 const config=await f.request('/api/rtc-config',undefined,{'x-room-token':a.joined.roomToken});assert.equal(config.status,200);assert.equal(config.body.iceServers[1].credential,secrets.TURN_PASSWORD);
 const health=await f.request('/api/health');assert.equal(health.body.commit,secrets.BUILD_SHA);assert.equal(health.body.storage,'postgres');for(const secret of [secrets.TURN_PASSWORD,secrets.TURN_USERNAME,'relay.example'])assert.ok(!JSON.stringify(health).includes(secret));
 a.peer.close();assert.equal((await f.request('/api/rtc-config',undefined,{'x-room-token':a.joined.roomToken})).status,401);assert.equal(rtcConfiguration({TURN_URLS:'https://not-a-relay'}).turnConfigured,false);
});
test('ten-language translation direction and room-scoped dedup survive secure joins',async t=>{
 let resolveProvider,providerCalls=0;const calls=[];
 const f=fixture(t,{env:{OPENAI_API_KEY:'server-private-key'},fetch:async(url,options)=>{providerCalls++;calls.push(JSON.parse(options.body));if(providerCalls===1)await new Promise(resolve=>{resolveProvider=resolve});return Response.json({choices:[{finish_reason:'stop',message:{content:'translated'}}]})}});
 const {a,b}=await pair(f),headerA={'x-room-token':a.joined.roomToken},headerB={'x-room-token':b.joined.roomToken},body={text:'hello',from:'en',to:'zh-TW'};
 const one=f.request('/api/translate',body,headerA),two=f.request('/api/translate',body,headerB);await new Promise(r=>setImmediate(r));assert.equal(providerCalls,1);resolveProvider();assert.equal((await one).body.translation,'translated');assert.equal((await two).body.translation,'translated');await f.request('/api/translate',body,headerA);assert.equal(providerCalls,1);
 for(const lang of Object.keys(LANGUAGES))assert.equal((await f.request('/api/translate',{text:'words',from:lang,to:'en'},headerA)).status,200);
 assert.ok(calls[0].messages[0].content.includes('from English into Traditional Chinese (Taiwan)'));
 assert.equal((await f.request('/api/translate',{...body,from:'invalid'},headerA)).status,400);assert.equal((await f.request('/api/translate','null',headerA)).status,400);assert.equal((await f.request('/api/translate',body,{'x-room-token':'expired'})).status,401);
});
test('translation failure and pending/failed PostgreSQL saves never block accepted call signals',async t=>{
 let rejectWrite;const store=fakePrivateChat();store.saveMessage=()=>new Promise((resolve,reject)=>{rejectWrite=reject});
 const f=fixture(t,{privateChat:store,env:{OPENAI_API_KEY:'super-private-key'},fetch:async()=>Response.json({error:{message:'super-private-key'}},{status:429})}),{a,b,id}=await accepted(f);
 const error=await f.request('/api/translate',{text:'hello',from:'en',to:'zh-TW'},{'x-room-token':a.joined.roomToken});assert.equal(error.status,429);assert.ok(!JSON.stringify(error).includes('super-private-key'));
 const failed=once(a.peer,'chat-error');a.peer.client({type:'chat',id:crypto.randomUUID(),text:'Hello',lang:'en'});
 a.peer.client({type:'ice',callId:id,candidate:{candidate:'live-during-db-write'}});assert.equal(b.peer.take()[0].candidate.candidate,'live-during-db-write');
 rejectWrite(Error('secret database connection details'));const [saveError]=await failed;assert.equal(saveError.code,'STORAGE_UNAVAILABLE');assert.ok(!saveError.message.includes('secret'));
 a.peer.client({type:'ice',callId:id,candidate:{candidate:'live-after-db-error'}});assert.equal(b.peer.take()[0].type,'ice');
});
test('adapter-backed history restores by verified account across reconnect and server recreation',async t=>{
 const adapter=fakePrivateChat(),f=fixture(t,{privateChat:adapter}),{a,b}=await pair(f),id=crypto.randomUUID();
 await post(a.peer,'I miss you','en',id);b.peer.take();a.peer.take();await post(a.peer,'I miss you','en',id);assert.deepEqual(b.peer.take(),[]);a.peer.close();b.peer.close();
 const reopened=fixture(t,{privateChat:adapter}),returned=await reopened.join('', 'token-a',{roomId:a.joined.roomId});assert.equal(returned.history.messages.length,1);assert.equal(returned.history.messages[0].id,id);assert.equal(returned.history.messages[0].authorId,USER_A);
 const partner=await reopened.join('', 'token-b',{roomId:a.joined.roomId});returned.peer.take();returned.peer.close();await post(partner.peer,'Offline hello','en');partner.peer.close();
 const afterOffline=await reopened.join('', 'token-a',{roomId:a.joined.roomId});assert.equal(afterOffline.history.messages.length,2);assert.equal(afterOffline.history.messages.at(-1).text,'Offline hello');
 const response=await reopened.request('/api/rooms',undefined,{authorization:'Bearer token-a'});assert.equal(response.body.rooms[0].id,a.joined.roomId);
});
test('history APIs reject missing, expired or foreign memberships; pagination is authenticated',async t=>{
 const f=fixture(t),a=await f.join(),other=await f.join(CODE_B,'token-b');await post(a.peer,'First');await post(a.peer,'Second');
 assert.equal((await f.request('/api/messages?room='+a.joined.roomId)).status,401);
 assert.equal((await f.request('/api/messages?room='+a.joined.roomId,undefined,{authorization:'Bearer expired-token'})).status,401);
 assert.equal((await f.request('/api/messages?room='+a.joined.roomId,undefined,{authorization:'Bearer token-b'})).status,403);
 const headers={authorization:'Bearer token-a'},page=await f.request('/api/messages?room='+a.joined.roomId+'&limit=1',undefined,headers);assert.equal(page.body.messages.length,1);assert.equal(page.body.messages[0].text,'Second');assert.ok(page.body.nextCursor);
 const older=await f.request('/api/messages?room='+a.joined.roomId+'&limit=1&before='+page.body.nextCursor,undefined,headers);assert.equal(older.body.messages[0].text,'First');
 assert.equal((await f.request('/api/messages?room='+other.joined.roomId,undefined,headers)).status,403);
 const leaked=await f.request('/api/auth/config');assert.equal(leaked.body.anonKey,'public-anon-key');assert.ok(!JSON.stringify(leaked).includes('service_role'));
 a.peer.user.expiresAt=Date.now()-1;a.peer.client({type:'typing'});assert.equal(a.peer.closeCode,4003);assert.equal((await f.request('/api/rtc-config',undefined,{'x-room-token':a.joined.roomToken})).status,200); // public STUN config has no credentials
});
test('missing database configuration fails closed without memory or file history fallback',async t=>{
 const server=createServer({env:{}}),f=fixture(t,{privateChat:{status:()=>({mode:'postgres',configured:false,healthy:null}),publicConfig:()=>null,authenticate:async()=>{throw err(503,'PRIVATE_CHAT_NOT_CONFIGURED')}}});t.after(()=>{server.emit('close');server.wss.close()});
 const a=await f.join();assert.equal(a.joined.code,'PRIVATE_CHAT_NOT_CONFIGURED');assert.equal(a.peer.room,undefined);const health=await f.request('/api/health');assert.equal(health.body.storageStatus.configured,false);assert.equal(health.body.storage,'postgres');assert.equal((await f.request('/api/rooms',undefined,{authorization:'Bearer token-a'})).status,503);
});

test('verified same-account token refresh extends the session without disturbing an accepted call',async t=>{
 const store=fakePrivateChat(),original=store.authenticate;let renewedExpiry;
 store.authenticate=async token=>token==='fresh-token-a'?{...await original('token-a'),expiresAt:renewedExpiry=Date.now()+7200000}:original(token);
 const f=fixture(t,{privateChat:store}),{a,b,id}=await accepted(f),roomToken=a.joined.roomToken;
 const refreshed=once(a.peer,'auth-refreshed');a.peer.client({type:'refresh-auth',accessToken:'fresh-token-a'});const [ack]=await refreshed;
 assert.equal(ack.userId,USER_A);assert.equal(ack.expiresAt,renewedExpiry);assert.equal(a.peer.roomToken,roomToken);assert.equal(a.peer.readyState,1);assert.deepEqual(b.peer.take(),[]);
 a.peer.client({type:'ice',callId:id,candidate:{candidate:'call-stays-live-after-refresh'}});assert.equal(b.peer.take()[0].candidate.candidate,'call-stays-live-after-refresh');
});
test('invalid or account-switching token refresh closes the session and releases its call',async t=>{
 for(const token of ['third-user','token-b']){
  const f=fixture(t),{a,b,id}=await accepted(f),required=once(a.peer,'auth-required');
  a.peer.client({type:'refresh-auth',accessToken:token});await required;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.peer.closeCode,4003);assert.ok(b.peer.take().some(message=>message.type==='call-end'&&message.callId===id));
  a.peer.client({type:'ice',callId:id,candidate:{candidate:'closed-session'}});assert.deepEqual(b.peer.take(),[]);
 }
});
test('a late token refresh cannot revive a closed or replaced socket',async t=>{
 const store=fakePrivateChat(),original=store.authenticate;let resolveRefresh,lookupCount=0;
 store.authenticate=token=>{if(token!=='slow-refresh')return original(token);lookupCount++;return new Promise(resolve=>{resolveRefresh=resolve})};
 const f=fixture(t,{privateChat:store}),{a,b}=await accepted(f);
 a.peer.client({type:'refresh-auth',accessToken:'slow-refresh'});a.peer.client({type:'refresh-auth',accessToken:'slow-refresh'});assert.equal(lookupCount,1);
 a.peer.close();b.peer.take();const replacement=await f.join('', 'token-a',{roomId:a.joined.roomId});b.peer.take();
 resolveRefresh({...await original('token-a'),expiresAt:Date.now()+7200000});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(a.peer.authTimer._destroyed,true);assert.ok(!a.peer.take().some(message=>message.type==='auth-refreshed'));assert.equal(replacement.peer.readyState,1);assert.equal(replacement.joined.count,2);assert.deepEqual(b.peer.take(),[]);
});
test('a transient authentication-provider failure preserves the still-valid session and call',async t=>{
 const store=fakePrivateChat(),original=store.authenticate;store.authenticate=async token=>{if(token==='provider-offline')throw err(503,'AUTH_UNAVAILABLE');return original(token)};
 const f=fixture(t,{privateChat:store}),{a,b,id}=await accepted(f),retry=once(a.peer,'auth-refresh-error');a.peer.client({type:'refresh-auth',accessToken:'provider-offline'});const [error]=await retry;
 assert.equal(error.code,'AUTH_UNAVAILABLE');assert.equal(a.peer.readyState,1);a.peer.client({type:'ice',callId:id,candidate:{candidate:'valid-session-during-auth-outage'}});assert.equal(b.peer.take()[0].type,'ice');
});
test('token refresh rechecks database membership and ends a revoked session',async t=>{
 const store=fakePrivateChat(),f=fixture(t,{privateChat:store}),{a,b,id}=await accepted(f);
 store.getRoom=async()=>{throw err(403,'ROOM_FORBIDDEN')};const required=once(a.peer,'auth-required');a.peer.client({type:'refresh-auth',accessToken:'token-a'});await required;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(a.peer.closeCode,4003);assert.ok(b.peer.take().some(message=>message.type==='call-end'&&message.callId===id));
});
