'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');
const {webcrypto,randomUUID}=require('node:crypto');
const APP=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
const HISTORY=fs.readFileSync(require.resolve('../public/private-history.js'),'utf8');
const HTML=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',ROOM='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN='verified-user-access-token-1234567890',TOKEN2='refreshed-user-access-token-1234567890';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve))};
function fixture(t,options={}){
 const {document,window}=parseHTML(HTML),requests=[],sockets=[],peers=[],media=[],storage=new Map(),timers=new Map(),subscribers=new Set(),alerts=[];
 let user=null,token=TOKEN,tokenJob=null,clock=0,signedOut=0;
 for(const select of document.querySelectorAll('select')){let value=select.querySelector('option[selected]')?.getAttribute('value')||select.querySelector('option')?.getAttribute('value')||'';Object.defineProperty(select,'value',{get:()=>value,set:v=>{value=String(v)},configurable:true})}
 for(const el of document.querySelectorAll('video,audio')){el.play=async()=>{};el.pause=()=>{}}
 const snapshot=()=>({user:user?{...user}:null,status:user?'authenticated':'signed-out',configured:true,message:''});
 const auth={user:()=>user?{...user}:null,ready:async()=>snapshot(),accessToken:async()=>tokenJob?tokenJob.promise:user?token:null,subscribe:fn=>{subscribers.add(fn);fn(snapshot());return ()=>subscribers.delete(fn)},signOut:async()=>{signedOut++;user=null;for(const fn of subscribers)fn(snapshot());return {revoked:true}}};
 class WS{
  static OPEN=1;static CLOSED=3;
  constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this)}
  async open(){this.readyState=1;await this.onopen?.()}
  send(raw){this.sent.push(JSON.parse(raw))}
  server(data){this.onmessage?.({data:JSON.stringify(data)})}
  close(code=1000){if(this.readyState===3)return;this.readyState=3;this.onclose?.({code})}
 }
 class Stream{
  constructor(tracks=[]){this.tracks=tracks}
  getTracks(){return this.tracks}
  getAudioTracks(){return this.tracks.filter(x=>x.kind==='audio')}
  getVideoTracks(){return this.tracks.filter(x=>x.kind==='video')}
  removeTrack(track){this.tracks=this.tracks.filter(t=>t!==track)}
  addTrack(track){this.tracks.push(track)}
 }
 class PC{
  constructor(config){this.config=config;this.connectionState='new';this.signalingState='stable';this.senders=[];peers.push(this)}
  addTrack(track){const sender={track,getParameters:()=>({encodings:[{}]}),setParameters:async()=>{},replaceTrack:async(next)=>{sender.track=next}};this.senders.push(sender);return sender}
  getSenders(){return this.senders}
  async createOffer(){return {type:'offer',sdp:'mock-offer'}}
  async createAnswer(){return {type:'answer',sdp:'mock-answer'}}
  async setLocalDescription(value){this.localDescription=value}
  async setRemoteDescription(value){this.remoteDescription=value}
  async addIceCandidate(){}
  async getStats(){return new Map()}
  close(){this.connectionState='closed'}
 }
 const track=kind=>({kind,enabled:true,readyState:'live',stop(){this.readyState='ended'},getSettings:()=>({facingMode:'user'})});
 const navigator={mediaDevices:{getUserMedia:async config=>{const stream=new Stream([track('audio'),...(config.video?[track('video')]:[])]);media.push(stream);return stream}},clipboard:{writeText:async()=>{}}};
 const baseFetch=async(path,request={})=>{
  if(path==='/api/rooms')return Response.json(request.method==='POST'?{room:{id:ROOM},inviteToken:'a'.repeat(64)}:{rooms:[]});
  if(path.startsWith('/api/messages?'))return Response.json({roomId:ROOM,messages:[],nextCursor:null});
  if(path==='/api/translate')return Response.json({translation:'你好'});
  if(path==='/api/rtc-config')return Response.json({iceServers:[{urls:'stun:relay.example.test:3478'},{urls:['turns:relay.example.test:443?transport=tcp'],username:'temporary-user',credential:'temporary-browser-credential'}],turnConfigured:true});
  if(path==='/api/push/key')return Response.json({enabled:true,publicKey:'AQID'});
  if(path==='/api/push/subscribe')return Response.json({ok:true});
  throw Error('Unexpected request '+path);
 };
 let fetcher=options.fetch||baseFetch;
 const context=vm.createContext({document,window,NodeFilter:{SHOW_TEXT:4},navigator,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},WorldAuth:auth,URL,URLSearchParams,Response,AbortController,Date,Intl,crypto:webcrypto,WebSocket:WS,RTCPeerConnection:PC,MediaStream:Stream,location:new URL('https://private.example.test/'),console,alert:value=>alerts.push(value),setTimeout:(fn,ms)=>{const id=++clock;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),setInterval:()=>++clock,clearInterval(){},atob:value=>Buffer.from(value,'base64').toString('binary'),fetch:async(path,request={})=>{requests.push({path,request});return fetcher(path,request)}});
 vm.runInContext(HISTORY,context);vm.runInContext(APP,context);
 t.after(()=>{for(const timer of timers.values())timer.fn=null;timers.clear()});
 return {document,window,requests,sockets,peers,media,storage,timers,alerts,auth,baseFetch,context,run:code=>vm.runInContext(code,context),setFetch:fn=>{fetcher=fn},setTokenJob:job=>{tokenJob=job},setToken:value=>{token=value},signedOut:()=>signedOut,
  async login(id=A){user={id,email:'private@example.test'};for(const fn of subscribers)fn(snapshot());await flush()},
  async enter(){await this.run('onCoverEntry()');await this.document.getElementById('random').onclick();await flush();const ws=sockets.at(-1);assert(ws,'create room must start authenticated WS');await ws.open();ws.server({type:'joined',roomId:ROOM,userId:user.id,count:1});await flush();return ws}
 };
}
function saved(input,authorId=A,extra={}){return {id:input.id,text:input.text,lang:input.lang,roomId:ROOM,authorId,createdAt:'2026-11-11T12:00:00.123456Z',...extra}}

test('canonical auth methods connect room, restore history and acknowledge offline durable text before showing saved',async t=>{
 const f=fixture(t);await flush();await f.login();const ws=await f.enter();
 assert.equal(ws.sent[0].accessToken,TOKEN);assert.equal(ws.sent[0].roomId,ROOM);assert.equal(f.run('validSession()'),true);
 assert(f.requests.filter(x=>x.path.startsWith('/api/')).every(x=>x.request.headers.Authorization==='Bearer '+TOKEN));
 const old={id:randomUUID(),roomId:ROOM,authorId:A,text:'Own original',lang:'en',createdAt:'2026-11-10T00:00:00Z'};
 ws.server({type:'chat-history',roomId:ROOM,messages:[old]});await flush();assert(f.document.getElementById('chatlog').textContent.includes('Own original'));
 assert.equal(f.requests.filter(x=>x.path==='/api/translate').length,0,'own history must not translate');
 const input=f.document.getElementById('message');input.value='離線也保存';await f.document.getElementById('manual').onsubmit({preventDefault(){}});
 const pending=ws.sent.find(x=>x.type==='caption');assert(pending);assert.equal(input.value,'');
 assert(f.document.getElementById('chatlog').textContent.includes('等待伺服器確認保存'));
 assert.equal(f.storage.has('olw-outbox:'+A+':'+ROOM),true);
 ws.server({type:'caption-saved',persisted:true,message:saved(pending),peerOnline:false});await flush();
 assert(f.document.getElementById('chatlog').textContent.includes('已保存 · 等待對方收到'));
 assert.equal(f.storage.has('olw-outbox:'+A+':'+ROOM),false);
 await f.auth.signOut();await flush();assert.equal(ws.readyState,3);assert.equal(f.document.getElementById('chatlog').textContent,'');assert.equal(f.run('validSession()'),false);
 ws.server({type:'chat-history',roomId:ROOM,messages:[{...old,text:'late private data'}]});await flush();assert.equal(f.document.getElementById('chatlog').textContent,'');
});

test('async token work is cancelled before REST or WS can leak into a different auth generation',async t=>{
 const f=fixture(t);await f.login();await f.run('onCoverEntry()');const pending=deferred();f.setTokenJob(pending);
 const creation=f.document.getElementById('random').onclick();await flush();await f.auth.signOut();pending.resolve(TOKEN);await creation;await flush();
 assert.equal(f.requests.filter(x=>x.path==='/api/rooms'&&x.request.method==='POST').length,0);
 assert.equal(f.sockets.length,0);assert.equal(f.document.getElementById('chatlog').textContent,'');
 const g=fixture(t);await g.login();const ws=await g.enter();const wait=deferred();g.setTokenJob(wait);ws.close();await flush();
 const reconnect=[...g.timers.values()].find(x=>x.ms===1000);assert(reconnect);reconnect.fn();const replacement=g.sockets.at(-1),opening=replacement.open();await flush();await g.auth.signOut();wait.resolve(TOKEN);await opening;assert.equal(replacement.sent.length,0);
});

test('server save failures retain retryable unconfirmed text; refresh errors do not end an active room',async t=>{
 const f=fixture(t);await f.login();const ws=await f.enter();await f.run("postText('Do not claim saved')");const input=ws.sent.find(x=>x.type==='caption');
 ws.server({type:'caption-error',id:input.id,persisted:false,message:'資料庫尚未保存'});await flush();
 assert(f.document.getElementById('chatlog').textContent.includes('尚未確認保存'));
 assert(f.storage.has('olw-outbox:'+A+':'+ROOM));assert.equal(f.run('pendingMessages.get('+JSON.stringify(input.id)+').saved'),false);
 ws.server({type:'auth-refresh-error'});await flush();assert.equal(ws.readyState,1);assert(f.document.getElementById('status').textContent.includes('登入服務暫時無法連線'));
 ws.server({type:'auth-required'});await flush();assert.equal(ws.readyState,3);assert.equal(f.signedOut(),1);assert.equal(f.document.getElementById('chatlog').textContent,'');
});

test('rotated access tokens refresh an existing socket and authorize viewer-language translation',async t=>{
 const f=fixture(t);await f.login();const ws=await f.enter();f.setToken(TOKEN2);await f.login();
 assert(ws.sent.some(x=>x.type==='auth-refresh'&&x.accessToken===TOKEN2));
 ws.server({type:'caption',...saved({id:randomUUID(),text:'Hello',lang:'en'},B)});await flush();
 const request=f.requests.find(x=>x.path==='/api/translate');assert(request);assert.equal(request.request.headers.Authorization,'Bearer '+TOKEN2);assert.deepEqual(JSON.parse(request.request.body),{text:'Hello',from:'en',to:'zh-TW'});
 assert(f.document.getElementById('chatlog').textContent.includes('你好'));
});

test('actual TURN configuration and call IDs reach WebRTC signaling independently of translation',async t=>{
 const translation=deferred(),f=fixture(t,{fetch:(path,options)=>path==='/api/translate'?translation.promise:f.baseFetch(path,options)});await f.login();const ws=await f.enter();ws.server({type:'peer-joined',count:2});await flush();
 await f.document.getElementById('audioCall').onclick();const invite=ws.sent.find(x=>x.type==='call-invite');assert(invite);assert.equal(typeof invite.callId,'string');
 const rtc=f.requests.find(x=>x.path==='/api/rtc-config');assert.equal(rtc.request.headers.Authorization,'Bearer '+TOKEN);
 assert(f.peers[0].config.iceServers.some(x=>x.urls.includes('turns:relay.example.test:443?transport=tcp')));
 assert.equal(f.requests.filter(x=>x.path==='/api/translate').length,0);
 ws.server({type:'caption',...saved({id:randomUUID(),text:'Provider stays pending',lang:'en'},B)});await flush();assert(f.requests.some(x=>x.path==='/api/translate'));
 ws.server({type:'call-accept',callId:invite.callId});await flush();assert(ws.sent.some(x=>x.type==='offer'&&x.callId===invite.callId&&x.sdp.type==='offer'));
 f.peers[0].onicecandidate({candidate:{candidate:'mock-ice'}});assert(ws.sent.some(x=>x.type==='ice'&&x.callId===invite.callId));
 translation.resolve(Response.json({error:'provider unavailable'},{status:502}));await flush();assert.notEqual(f.peers[0].connectionState,'closed','translation failure must not close media');
 assert(!f.document.body.textContent.includes('temporary-browser-credential'));
 ws.server({type:'call-busy',callId:invite.callId});await flush();assert(f.media[0].getTracks().every(x=>x.readyState==='ended'));assert.equal(f.peers[0].connectionState,'closed');assert(f.document.getElementById('status').textContent.includes('正在通話'));
});

test('stalled TURN lookup falls back within five seconds; late configuration cannot revive hung-up media',async t=>{
 const pending=deferred(),f=fixture(t,{fetch:(path,options)=>path==='/api/rtc-config'?pending.promise:f.baseFetch(path,options)});await f.login();const ws=await f.enter();ws.server({type:'peer-joined',count:2});await flush();
 const dialing=f.document.getElementById('audioCall').onclick();await flush();const timeout=[...f.timers.values()].find(x=>x.ms===5000);assert(timeout);timeout.fn();await dialing;
 assert.equal(f.peers.length,1);assert(f.peers[0].config.iceServers.every(x=>String(x.urls).startsWith('stun:')));
 f.document.getElementById('hangup').onclick();pending.resolve(Response.json({iceServers:[{urls:'turns:late.example.test',username:'late',credential:'late'}]}));await flush();
 assert.equal(f.peers.length,1);assert(f.media[0].getTracks().every(x=>x.readyState==='ended'));assert.equal(f.run('calling'),false);
});

test('push endpoints use fresh Bearer token and server room contract',async t=>{
 const f=fixture(t);await f.login();await f.enter();
 const subscription={toJSON:()=>({endpoint:'https://push.example.test/private',keys:{auth:'test',p256dh:'test'}})};
 const navigator=f.run('navigator');navigator.serviceWorker={ready:Promise.resolve({pushManager:{getSubscription:async()=>subscription}})};
 const Notification={permission:'granted',requestPermission:async()=> 'granted'};f.context.Notification=Notification;f.window.Notification=Notification;f.window.PushManager=function(){};
 await f.document.getElementById('enableNotifications').onclick();
 const requests=f.requests.filter(x=>x.path.startsWith('/api/push/'));assert.equal(requests.length,2);assert(requests.every(x=>x.request.headers.Authorization==='Bearer '+TOKEN));
 assert.equal(JSON.parse(requests[1].request.body).room,ROOM);assert.equal(JSON.parse(requests[1].request.body).roomId,undefined);
});

test('private history adapter awaits canonical token API and refuses an aborted request before fetch',async()=>{
 let tokenJob=deferred(),requests=0;const context=vm.createContext({URL,URLSearchParams,WorldAuth:{accessToken:()=>tokenJob.promise},fetch:async(path,options)=>{requests++;assert.equal(options.headers.Authorization,'Bearer '+TOKEN);return Response.json({rooms:[]})}});
 vm.runInContext(HISTORY,context);const client=context.WorldHistory.createClient(),first=client.rooms();assert.equal(requests,0);tokenJob.resolve(TOKEN);await first;assert.equal(requests,1);
 tokenJob=deferred();const abort=new AbortController(),cancelled=client.rooms(abort.signal);abort.abort();tokenJob.resolve(TOKEN);await assert.rejects(cancelled,{name:'AbortError'});assert.equal(requests,1);
});


test('late history responses and pending sender receipts cannot reveal data or claim storage across logout',async t=>{
 const f=fixture(t);await f.login();const ws=await f.enter();await f.run("postText('Receipt is not a database ACK')");const input=ws.sent.find(x=>x.type==='caption');
 ws.server({type:'caption-received',id:input.id});await flush();assert.equal(f.run('pendingMessages.get('+JSON.stringify(input.id)+').saved'),false);assert(f.document.getElementById('chatlog').textContent.includes('等待伺服器確認保存'));
 const history=deferred();f.setFetch((path,options)=>path.startsWith('/api/messages?')?history.promise:f.baseFetch(path,options));const loading=f.run('loadHistory(false)');await flush();
 await f.auth.signOut();await f.login(B);history.resolve(Response.json({roomId:ROOM,messages:[saved({id:randomUUID(),text:'Old account private history',lang:'zh-TW'},A)],nextCursor:null}));await loading;await flush();
 assert.equal(f.document.getElementById('chatlog').textContent,'');assert.equal(f.storage.has('olw-outbox:'+A+':'+ROOM),false);assert.equal(f.run('currentUser.id'),B);assert.equal(f.run('pendingMessages.size'),0);
});
