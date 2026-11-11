'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events');
const {Readable}=require('node:stream');
const crypto=require('node:crypto');
const {createServer}=require('../server');
const {createPrivateStore}=require('../lib/private-store');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const ROOM='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_A='valid-user-a-token-1234567890',TOKEN_B='valid-user-b-token-1234567890';
const PUB='sb_publishable_abcdefghijklmnopqrstuvwxyz012345';
const error=(status,code)=>Object.assign(Error(code),{status,code});
const row=(extra={})=>({id:crypto.randomUUID(),room_id:ROOM,sender_id:A,kind:'text',body:'Hello',source_lang:'en',device_id:null,created_at:'2026-11-11T00:00:00.123456+00:00',deleted_at:null,...extra});
function fakeStore(){
 const memberships=new Map([[ROOM,new Set([A,B])],[OTHER,new Set([A])]]),messages=new Map(),invites=new Map();let sequence=0;
 const room=id=>({id,ownerId:A,createdAt:'2026-11-11T00:00:00.000000Z',updatedAt:'2026-11-11T00:00:00.000000Z'});
 const member=(user,id)=>{if(!memberships.get(id)?.has(user.id))throw error(403,'ROOM_FORBIDDEN')};
 const store={status:()=>({mode:'postgres',configured:true,schemaVerified:true,dataPathVerified:true}),authConfig:async()=>({enabled:true,url:'https://project.supabase.co',publishableKey:PUB,otpLength:8}),readiness:async()=>({ready:true,configured:true,schemaVersion:1,dataPathVerified:false}),
 async authenticate(token){const id=token===TOKEN_A?A:token===TOKEN_B?B:null;if(!id)throw error(401,'AUTH_REQUIRED');return {id,email:id+'@test.invalid',expiresAt:Date.now()+3600000,accessToken:token}},
 async getRoom(user,id){member(user,id);return room(id)},
 async listRooms(user){return [...memberships].filter(([,users])=>users.has(user.id)).map(([id])=>room(id))},
 async createRoom(user){const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');memberships.set(id,new Set([user.id]));invites.set(token,{roomId:id,target:user.id===A?B:A});return {room:room(id),inviteToken:token}},
 async renewInvite(user,id){member(user,id);const token=crypto.randomBytes(32).toString('hex');invites.set(token,{roomId:id,target:user.id===A?B:A});return {roomId:id,inviteToken:token}},
 async redeemInvite(user,token){const invite=invites.get(token);if(!invite||invite.target!==user.id)throw error(404,'INVITE_INVALID');memberships.get(invite.roomId).add(user.id);invites.delete(token);return room(invite.roomId)},
 async listMessages(user,id,{before,limit=50}={}){member(user,id);let page=[...messages.values()].filter(message=>message.roomId===id);if(before){const cursor=JSON.parse(Buffer.from(before,'base64url').toString());page=page.filter(message=>message.createdAt<cursor.t||message.createdAt===cursor.t&&message.id<cursor.id)}page.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));const selected=page.slice(0,limit),last=selected.at(-1);return {messages:selected.reverse(),nextCursor:page.length>limit?Buffer.from(JSON.stringify({t:last.createdAt,id:last.id})).toString('base64url'):null}},
 async saveMessage(user,id,input){member(user,id);const previous=messages.get(input.id);if(previous){if(previous.roomId!==id||previous.authorId!==user.id||previous.text!==input.text||previous.lang!==input.lang)throw error(409,'MESSAGE_CONFLICT');return {...previous,duplicate:true}}const createdAt='2026-11-11T00:00:00.'+String(++sequence).padStart(6,'0')+'Z',message={id:input.id,roomId:id,authorId:user.id,text:input.text,lang:input.lang,timestamp:Date.parse(createdAt),createdAt,kind:'text',deletedAt:null};messages.set(input.id,message);return {...message,duplicate:false}}
 };return store;
}
function fixture(t,options={}){
 const store=options.store||fakeStore(),server=createServer({env:{},store,...options});
 class Peer extends EventEmitter{
  constructor(){super();this.readyState=1;this.messages=[];server.wss.clients.add(this);server.wss.emit('connection',this)}
  send(raw){const data=JSON.parse(raw);this.messages.push(data);this.emit(data.type==='error'?'wire-error':data.type,data)}
  client(data){this.emit('message',Buffer.from(typeof data==='string'?data:JSON.stringify(data)))}
  take(){return this.messages.splice(0)}
  ping(){this.emit('pong')}
  close(code){if(this.readyState===3)return;this.readyState=3;this.closeCode=code;this.emit('close');server.wss.clients.delete(this)}
  terminate(){this.close()}
 }
 t.after(()=>{for(const peer of [...server.wss.clients])peer.close();server.emit('close');server.wss.close()});
 async function join(user='a',roomId=ROOM,extra={}){const peer=new Peer(),done=new Promise(resolve=>{peer.once('joined',message=>resolve(message));peer.once('wire-error',message=>resolve(message))});peer.client({type:'join',roomId,accessToken:user==='a'?TOKEN_A:user==='b'?TOKEN_B:'invalid-token',device:crypto.randomUUID(),lang:user==='b'?'en':'zh-TW',...extra});const joined=await done;await new Promise(resolve=>setImmediate(resolve));return {peer,joined,history:peer.take().find(message=>message.type==='chat-history')}}
 async function request(url,body,headers={},method=body===undefined?'GET':'POST'){
  const req=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);Object.assign(req,{url,method,headers,socket:{remoteAddress:'127.0.0.1'}});
  return new Promise(resolve=>{const res={destroyed:false,writableEnded:false,writeHead(status,headers){this.status=status;this.headers=headers},end(raw){this.writableEnded=true;let parsed;try{parsed=JSON.parse(raw)}catch{parsed=raw}resolve({status:this.status,body:parsed,headers:this.headers})}};server.emit('request',req,res)});
 }
 return {server,store,Peer,join,request};
}
const auth=user=>({authorization:'Bearer '+(user==='b'?TOKEN_B:TOKEN_A)});
async function post(peer,text='Hello',lang='en',id=crypto.randomUUID()){const saved=once(peer,'caption-saved');peer.client({type:'caption',id,text,lang});return (await saved)[0]}
async function accepted(f){const a=await f.join(),b=await f.join('b');a.peer.take();const callId=crypto.randomUUID();a.peer.client({type:'call-invite',callId,mode:'audio'});b.peer.take();b.peer.client({type:'call-accept',callId});a.peer.take();return {a,b,callId}}

test('private APIs fail closed without configuration and liveness does not claim readiness',async t=>{
 const store=createPrivateStore({env:{},fetch:async()=>{throw Error('must not request')}}),f=fixture(t,{store,env:{BUILD_SHA:'a'.repeat(40)}});
 assert.equal((await f.request('/api/health')).body.commit,'a'.repeat(40));assert.equal((await f.request('/api/health')).body.configured,false);assert.equal((await f.request('/api/ready')).status,503);
 assert.deepEqual((await f.request('/api/auth-config')).body,{enabled:false,url:null,publishableKey:null,otpLength:8});assert.equal((await f.request('/api/rooms',undefined,auth())).status,503);
 const denied=await f.join();assert.equal(denied.joined.code,'PRIVATE_CHAT_NOT_CONFIGURED');assert.equal(denied.peer.room,undefined);
});
test('verified REST session, room creation and recipient-bound invite redeem replace anonymous codes',async t=>{
 const f=fixture(t);for(const path of ['/api/session','/api/rooms','/api/messages?room='+ROOM,'/api/push/key','/api/rtc-config'])assert.equal((await f.request(path)).status,401);
 const session=await f.request('/api/session',undefined,auth());assert.deepEqual(session.body.user,{id:A,email:A+'@test.invalid'});assert.ok(!JSON.stringify(session).includes(TOKEN_A));
 const created=await f.request('/api/rooms',{},auth());assert.equal(created.status,201);assert.match(created.body.inviteToken,/^[0-9a-f]{64}$/);const id=created.body.room.id;
 assert.equal((await f.request('/api/messages?room='+id,undefined,auth('b'))).status,403);assert.equal((await f.request('/api/invites/redeem',{token:created.body.inviteToken},auth())).status,404);
 const redeemed=await f.request('/api/invites/redeem',{token:created.body.inviteToken},auth('b'));assert.equal(redeemed.body.room.id,id);assert.equal((await f.request('/api/messages?room='+id,undefined,auth('b'))).status,200);
 const denied=await f.join('b',OTHER);assert.equal(denied.joined.code,'ROOM_FORBIDDEN');assert.equal(denied.peer.closeCode,4003);
});
test('captions persist before ACK, work while partner is offline, and restore through adapter after recreation',async t=>{
 const store=fakeStore(),f=fixture(t,{store}),a=await f.join();const id=crypto.randomUUID(),ack=await post(a.peer,'晚安 ❤️','zh-TW',id);assert.equal(ack.persisted,true);assert.equal(ack.peerOnline,false);assert.equal(ack.message.authorId,A);a.peer.close();
 const restarted=fixture(t,{store}),b=await restarted.join('b');assert.equal(b.history.messages[0].id,id);assert.equal(b.history.messages[0].text,'晚安 ❤️');await post(b.peer,'Offline hello','en');b.peer.close();
 const returned=await restarted.join();assert.equal(returned.history.messages.length,2);assert.equal(returned.history.messages.at(-1).authorId,B);
 // This is an adapter double, not proof that a real external database survived deployment.
});
test('stable UUID retries ACK once-persisted content and never duplicate live messages',async t=>{
 const f=fixture(t),a=await f.join(),b=await f.join('b');a.peer.take();const id=crypto.randomUUID();await post(a.peer,'I miss you','en',id);assert.equal(b.peer.take().filter(message=>message.type==='caption').length,1);await post(a.peer,'I miss you','en',id);assert.deepEqual(b.peer.take(),[]);
 const failed=once(a.peer,'caption-error');a.peer.client({type:'caption',id,text:'Different','lang':'en'});assert.equal((await failed)[0].persisted,false);assert.equal((await f.request('/api/messages?room='+ROOM,undefined,auth())).body.messages.length,1);
});
test('multiple devices remain allowed for the two users; own devices sync text without false delivery receipts',async t=>{
 const f=fixture(t),a=await f.join(),a2=await f.join(),b=await f.join('b');a.peer.take();a2.peer.take();assert.equal(b.joined.count,2);assert.equal(b.joined.deviceCount,3);assert.equal(b.joined.peerUsers[0].userId,A);
 const ack=await post(a.peer);assert.equal(a2.peer.take()[0].authorId,A);assert.equal(b.peer.take()[0].authorId,A);a.peer.take();a2.peer.client({type:'caption-received',id:ack.id});assert.deepEqual(a.peer.take(),[]);
 b.peer.client({type:'caption-received',id:ack.id});assert.equal(a.peer.take()[0].type,'caption-received');assert.equal(a2.peer.take()[0].byUserId,B);
});
test('first accepting partner device wins; SDP, ICE and speech never leak to unselected devices',async t=>{
 const f=fixture(t),a=await f.join(),a2=await f.join(),b=await f.join('b'),b2=await f.join('b');for(const peer of [a,a2,b,b2])peer.peer.take();
 const callId=crypto.randomUUID();a.peer.client({type:'call-invite',callId,mode:'video'});assert.equal(b.peer.take()[0].type,'call-invite');assert.equal(b2.peer.take()[0].type,'call-invite');assert.deepEqual(a2.peer.take(),[]);
 b.peer.client({type:'call-accept',callId});assert.equal(a.peer.take()[0].targetDevice,b.peer.device);assert.equal(b2.peer.take()[0].type,'call-cancelled');b2.peer.client({type:'call-accept',callId});assert.deepEqual(a.peer.take(),[]);
 a.peer.client({type:'offer',callId,sdp:{type:'offer',sdp:'v=0'}});assert.equal(b.peer.take()[0].type,'offer');assert.deepEqual(b2.peer.take(),[]);assert.deepEqual(a2.peer.take(),[]);
 b2.peer.client({type:'ice',callId,candidate:{candidate:'wrong-device'}});assert.deepEqual(a.peer.take(),[]);
 a.peer.client({type:'speech-caption',callId,id:'speech-1',seq:1,text:'Hello',lang:'en'});assert.equal(b.peer.take()[0].type,'speech-caption');assert.deepEqual(a2.peer.take(),[]);assert.deepEqual(b2.peer.take(),[]);
 const history=await f.request('/api/messages?room='+ROOM,undefined,auth());assert.deepEqual(history.body.messages,[]);
});
test('pending database writes and failed translations cannot block accepted media signals',async t=>{
 const store=fakeStore();let rejectWrite;store.saveMessage=()=>new Promise((resolve,reject)=>{rejectWrite=reject});const f=fixture(t,{store,env:{OPENAI_API_KEY:'never-expose-this-key'},fetch:async()=>Response.json({error:{message:'never-expose-this-key'}},{status:429})}),{a,b,callId}=await accepted(f);
 const failed=once(a.peer,'caption-error');a.peer.client({type:'caption',id:crypto.randomUUID(),text:'Hello',lang:'en'});a.peer.client({type:'ice',callId,candidate:{candidate:'during-db-save'}});assert.equal(b.peer.take()[0].candidate.candidate,'during-db-save');
 rejectWrite(Error('private database host or password'));assert.ok(!(await failed)[0].message.includes('private database'));
 const translated=await f.request('/api/translate',{text:'Hello',from:'en',to:'zh-TW'},auth());assert.equal(translated.status,429);assert.ok(!JSON.stringify(translated).includes('never-expose-this-key'));
 a.peer.client({type:'ice',callId,candidate:{candidate:'after-provider-failure'}});assert.equal(b.peer.take()[0].candidate.candidate,'after-provider-failure');
});
test('same-user authentication refresh keeps room, devices and call; late results cannot revive a closed socket',async t=>{
 const store=fakeStore(),f=fixture(t,{store}),{a,b,callId}=await accepted(f),token=a.joined.roomToken;
 const refreshed=once(a.peer,'auth-refreshed');a.peer.client({type:'auth-refresh',accessToken:TOKEN_A});await refreshed;assert.equal(a.peer.roomToken,token);a.peer.client({type:'ice',callId,candidate:{candidate:'still-live'}});assert.equal(b.peer.take()[0].type,'ice');
 assert.equal(a.peer.take().filter(message=>message.type==='auth-refreshed').length,1);
 const original=store.authenticate;let resolve;store.authenticate=token=>token==='slow'?new Promise(done=>{resolve=done}):original(token);a.peer.client({type:'auth-refresh',accessToken:'slow'});a.peer.close();b.peer.take();resolve(await original(TOKEN_A));await new Promise(done=>setImmediate(done));assert.ok(!a.peer.take().some(message=>message.type==='auth-refreshed'));assert.deepEqual(b.peer.take(),[]);
});
test('translation and private history cannot be invoked anonymously or with another room membership',async t=>{
 let count=0;const f=fixture(t,{env:{OPENAI_API_KEY:'private-translation-key'},fetch:async()=>{count++;return Response.json({choices:[{finish_reason:'stop',message:{content:'Hej'}}]})}}),input={text:'Hello',from:'en',to:'sv'};
 assert.equal((await f.request('/api/translate',input)).status,401);assert.equal(count,0);assert.equal((await f.request('/api/translate',input,auth())).body.translation,'Hej');assert.equal(count,1);
 assert.equal((await f.request('/api/messages?room='+OTHER,undefined,auth('b'))).status,403);assert.equal((await f.request('/api/translate',input,{...auth(),'x-room-token':'fake'})).status,401);assert.equal(count,1);
});

function jwt(payload){return Buffer.from(JSON.stringify({alg:'HS256'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url')+'.not-a-real-signature'}
function storeFixture(options={}){
 const calls=[],token=jwt({sub:A,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600}),env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:PUB,PRIVATE_USER_IDS:A+','+B,...options.env};
 const fetch=async(url,request)=>{calls.push({url,request});if(options.fetch)return options.fetch(url,request);if(url.endsWith('/auth/v1/settings'))return Response.json({});if(url.endsWith('/auth/v1/user'))return Response.json({id:A,email:'a@test.invalid',email_confirmed_at:'2026-11-11T00:00:00Z'});if(url.endsWith('/olw_schema_version'))return Response.json({version:1});return Response.json([])};
 return {store:createPrivateStore({env,fetch,now:options.now}),calls,token,env};
}
test('public configuration rejects secret, wrong-project and rejected project keys without exposing them',async()=>{
 for(const key of ['sb_secret_this-must-never-be-exposed',jwt({role:'service_role',ref:'project'}),jwt({role:'anon',ref:'wrong-project'})]){const f=storeFixture({env:{SUPABASE_PUBLISHABLE_KEY:key}});assert.equal((await f.store.authConfig()).enabled,false);assert.ok(!JSON.stringify(await f.store.authConfig()).includes(key));assert.equal(f.calls.length,0)}
 const wrong=storeFixture({fetch:async()=>Response.json({error:'private upstream details'},{status:401})});assert.deepEqual(await wrong.store.authConfig(),{enabled:false,url:null,publishableKey:null,otpLength:8});
 const valid=storeFixture();assert.equal((await valid.store.authConfig()).publishableKey,PUB);assert.equal(valid.calls[0].request.headers.apikey,PUB);assert.equal(valid.calls[0].request.headers.Authorization,undefined);
});
test('store verifies Supabase user before trusting JWT expiry or allowed identity; token never serializes',async()=>{
 const f=storeFixture(),user=await f.store.authenticate(f.token);assert.equal(user.id,A);assert.equal(user.accessToken,f.token);assert.ok(!JSON.stringify(user).includes(f.token));assert.equal(f.calls[1].request.headers.Authorization,'Bearer '+f.token);
 await assert.rejects(f.store.authenticate(jwt({sub:B,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})),error=>error.status===401);
 const third=storeFixture({fetch:async url=>url.endsWith('/settings')?Response.json({}):Response.json({id:C,email:'third@test.invalid',email_confirmed_at:'yes'})});await assert.rejects(third.store.authenticate(third.token),error=>error.status===403);
});
test('store hashes newly generated invites and sends raw redeem token only to the bound SQL RPC',async()=>{
 const f=storeFixture({fetch:async(url,request)=>{if(url.endsWith('/settings'))return Response.json({});if(url.endsWith('/user'))return Response.json({id:A,email:'a@test.invalid',email_confirmed_at:'yes'});if(url.endsWith('/olw_private_create_room')||url.endsWith('/olw_private_redeem_invite'))return Response.json({id:ROOM,created_by:A,created_at:'2026-11-11T00:00:00Z'});throw Error('unexpected')}}),user=await f.store.authenticate(f.token),created=await f.store.createRoom(user),body=JSON.parse(f.calls.at(-1).request.body);
 assert.equal(created.room.ownerId,A);assert.match(created.inviteToken,/^[a-f0-9]{64}$/);assert.equal(body.p_invitee_id,B);assert.equal(body.p_invite_hash,crypto.createHash('sha256').update(created.inviteToken).digest('hex'));assert.ok(!f.calls.at(-1).request.body.includes(created.inviteToken));
 await f.store.redeemInvite(user,created.inviteToken);assert.deepEqual(JSON.parse(f.calls.at(-1).request.body),{p_token:created.inviteToken});assert.ok(!f.calls.some(call=>call.url.includes(f.token)||call.url.includes(created.inviteToken)));
});
test('pagination preserves PostgreSQL microseconds and legacy unknown source languages',async()=>{
 const older=row({created_at:'2026-11-11T00:00:00.123455+00:00',source_lang:null}),newer=row();const f=storeFixture({fetch:async(url,request)=>{if(url.endsWith('/settings'))return Response.json({});if(url.endsWith('/user'))return Response.json({id:A,email:'a@test.invalid',email_confirmed_at:'yes'});return Response.json([newer,older])}}),user=await f.store.authenticate(f.token),page=await f.store.listMessages(user,ROOM,{limit:1});
 const decoded=JSON.parse(Buffer.from(page.nextCursor,'base64url').toString());assert.equal(decoded.t,newer.created_at);assert.equal(page.messages[0].createdAt,newer.created_at);
 await f.store.listMessages(user,ROOM,{limit:1,before:page.nextCursor});assert.equal(JSON.parse(f.calls.at(-1).request.body).p_before_at,newer.created_at);
 const legacy=await f.store.listMessages(user,ROOM,{limit:2});assert.equal(legacy.messages[0].lang,null);assert.equal(legacy.messages[0].text,older.body);
});
test('anonymous schema readiness probes do not claim a verified private data path',async()=>{
 const f=storeFixture();assert.deepEqual(await f.store.readiness(),{ready:true,configured:true,schemaVersion:1,dataPathVerified:false});assert.equal(f.calls.at(-1).request.headers.Authorization,undefined);assert.deepEqual(JSON.parse(f.calls.at(-1).request.body),{});assert.ok(f.store.status().schemaVerified);
 const missing=storeFixture({fetch:async url=>url.endsWith('/settings')?Response.json({}):Response.json({message:'private diagnostics'},{status:404})});assert.equal((await missing.store.readiness()).ready,false);assert.equal(missing.store.status().schemaVerified,false);
});
