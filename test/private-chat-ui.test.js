const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');
const {webcrypto}=require('node:crypto');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const ROOM_A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ROOM_B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){await tick();await tick();await tick()}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture(options={}){
 const {window:dom}=parseHTML(fs.readFileSync('public/index.html','utf8')),document=dom.document;
 const storage=options.storage||new Map(),sockets=[],sent=[],requests=[],timers=new Map(),events=new Map(),listeners=new Set();let timerId=0,user=options.user?{id:options.user}:null;
 let onFetch=options.fetch||((url)=>{if(url==='/api/rooms')return Response.json({rooms:[{id:user?.id===B?ROOM_B:ROOM_A}]});if(String(url).startsWith('/api/messages?'))return Response.json({messages:[],nextCursor:null});if(url==='/api/translate')return Response.json({translation:'translated'});throw Error('Unexpected request '+url)});
 for(const [selector,value]of [['languageSelect','zh-TW'],['filterSelect','none'],['testTargetSelect','en']])Object.defineProperty(document.getElementById(selector),'value',{value,writable:true,configurable:true});
 for(const video of document.querySelectorAll('video'))video.play=()=>Promise.resolve();
 class Socket{static OPEN=1;constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this)}send(raw){const message=JSON.parse(raw);this.sent.push(message);sent.push(message)}open(){this.readyState=1;this.onopen?.()}message(value){this.onmessage?.({data:JSON.stringify(value)})}close(code=1000){this.readyState=3;this.onclose?.({code})}}
 const WorldAuth={ready:async()=>({user,configured:true,status:user?'authenticated':'signed-out'}),accessToken:async()=>user?'token-'+user.id:null,user:()=>user?{...user}:null,subscribe(listener){listeners.add(listener);listener({user,configured:true,status:user?'authenticated':'signed-out'});return ()=>listeners.delete(listener)},async signOut(){emit(null)}};
 function emit(next,status=next?'authenticated':'signed-out'){user=next?{id:next}:null;for(const listener of listeners)listener({user,configured:true,status})}
 const CallTools={fetchRTCConfig:async()=>({iceServers:[{urls:'stun:test.example:3478'}],turnConfigured:false}),applyVideoPreset:async()=>({applied:true}),createQualityMonitor:()=>({start(){},stop(){}})};
 const window={WorldAuth,CallTools,addEventListener:(name,callback)=>events.set(name,callback),focus(){}};
 const context=vm.createContext({document,window,CallTools,WebSocket:Socket,RTCPeerConnection:class{},MediaStream:class{},crypto:webcrypto,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},navigator:{},location:{protocol:'https:',host:'test.local'},URL,AbortController,Response,console,alert(){},File:class{},atob:s=>Buffer.from(s,'base64').toString('binary'),setTimeout:(callback,ms)=>{const key=++timerId;timers.set(key,{callback,ms});return key},clearTimeout:key=>timers.delete(key),setInterval:()=>++timerId,clearInterval(){},fetch:async(url,request={})=>{requests.push({url,request});return onFetch(url,request)}});
 vm.runInContext(fs.readFileSync('public/app.js','utf8'),context);
 const run=code=>vm.runInContext(code,context),$=name=>document.getElementById(name);
 async function joined({room=ROOM_A,userId=user?.id,history=[],nextCursor=null,socket=sockets.at(-1)}={}){assert.ok(socket,'authenticated room restore should create a WebSocket');socket.open();socket.message({type:'joined',roomId:room,userId,count:1,roomToken:'room-token',storage:{mode:'postgres'}});socket.message({type:'chat-history',roomId:room,messages:history,nextCursor});await settle();return socket}
 return {run,$,context,storage,sockets,sent,requests,timers,events,joined,emit,setFetch:fn=>onFetch=fn};
}
function message(n,authorId,text,lang='zh-TW',timestamp=n*1000){return {id:id(n),authorId,text,lang,timestamp}}

test('reopening restores verified membership UUID, device preferences and durable-history direction',async()=>{
 const storage=new Map([['olw-room:'+A,ROOM_A],['olw-language','sv'],['olw-profile','kaan']]);
 const own=message(1,A,'My own words','sv'),partner=message(2,B,'I miss you','en');
 for(let opening=0;opening<2;opening++){
  const f=fixture({storage,user:A});await settle();assert.equal(f.requests[0].url,'/api/rooms');assert.equal(f.requests[0].request.headers.Authorization,'Bearer token-'+A);
  const ws=await f.joined({history:[own,partner]});assert.equal(ws.sent[0].type,'join');assert.equal(ws.sent[0].roomId,ROOM_A);assert.equal(ws.sent[0].accessToken,'token-'+A);assert.equal(ws.sent[0].room,undefined);
  assert.equal(f.run('lang'),'sv');assert.equal(f.run('selectedProfile'),'kaan');assert.equal(f.$('chatlog').querySelectorAll('.bubble').length,2);
  const ownBubble=f.$('chatlog').querySelector('[data-message-id="'+own.id+'"]');assert.ok(ownBubble.classList.contains('mine'));assert.equal(ownBubble.querySelector('.translation'),null);
  const translations=f.requests.filter(r=>r.url==='/api/translate');assert.equal(translations.length,1);assert.deepEqual(JSON.parse(translations[0].request.body),{text:partner.text,from:'en',to:'sv'});
  ws.message({type:'chat-history',roomId:ROOM_A,messages:[own,partner],nextCursor:null});await settle();assert.equal(f.$('chatlog').querySelectorAll('.bubble').length,2);
  f.events.get('pagehide')();
 }
});

test('history pagination preserves order, deduplicates overlap and uses authenticated REST',async()=>{
 const f=fixture({user:A});await settle();const m1=message(1,A,'older own'),m2=message(2,A,'second'),m3=message(3,A,'third'),m4=message(4,A,'newest');
 await f.joined({history:[m3,m4],nextCursor:'older-cursor'});assert.ok(!f.$('historyMore').classList.contains('hidden'));
 f.setFetch((url,request)=>{assert.ok(String(url).startsWith('/api/messages?room='+ROOM_A));assert.ok(String(url).includes('before=older-cursor'));assert.equal(request.headers.Authorization,'Bearer token-'+A);return Response.json({messages:[m1,m2,m3],nextCursor:null})});
 await f.run('loadOlderHistory()');assert.deepEqual([...f.$('chatlog').querySelectorAll('.bubble')].map(el=>el.dataset.messageId),[m1.id,m2.id,m3.id,m4.id]);assert.ok(f.$('historyMore').classList.contains('hidden'));assert.equal(f.requests.filter(r=>r.url==='/api/translate').length,0);
});

test('outbox waits for persistence acknowledgement and reuses IDs after reconnect without duplicate bubbles',async()=>{
 const f=fixture({user:A});await settle();let ws=await f.joined();assert.equal(f.run("postText('pending message')"),true);let chats=f.sent.filter(m=>m.type==='chat');assert.equal(chats.length,1);const pendingId=chats[0].id;
 assert.equal(f.run('outbox.size'),1);assert.ok(f.$('chatlog').textContent.includes('等待儲存確認'));assert.ok(!f.$('chatlog').textContent.includes('已儲存'));
 ws.close(1006);assert.ok(f.$('chatlog').textContent.includes('等待連線'));assert.equal(JSON.parse(f.storage.get('olw-pending:'+A+':'+ROOM_A))[0].id,pendingId);
 assert.equal(f.run("postText('offline second')"),true);assert.equal(f.sent.filter(m=>m.type==='chat').length,1);
 await f.run('connect(reconnectTarget)');ws=await f.joined();chats=f.sent.filter(m=>m.type==='chat');assert.equal(chats.filter(m=>m.id===pendingId).length,2);assert.equal(f.$('chatlog').querySelectorAll('.bubble').length,2);
 const confirmed={id:pendingId,authorId:A,text:'pending message',lang:'zh-TW',timestamp:Date.now()};ws.message({type:'chat-saved',id:pendingId,roomId:ROOM_A,message:confirmed});ws.message({type:'chat-saved',id:pendingId,roomId:ROOM_A,message:confirmed});ws.message({type:'chat',...confirmed});await settle();
 const bubble=f.$('chatlog').querySelector('[data-message-id="'+pendingId+'"]');assert.ok(bubble.querySelector('.messageMeta').textContent.includes('已儲存'));assert.equal(f.$('chatlog').querySelectorAll('[data-message-id="'+pendingId+'"]').length,1);assert.equal(f.run('outbox.has('+JSON.stringify(pendingId)+')'),false);assert.equal(f.requests.filter(r=>r.url==='/api/translate').length,0);
});

test('message write failure stays retryable with the same ID instead of claiming success',async()=>{
 const f=fixture({user:A});await settle();const ws=await f.joined();f.run("postText('retry me')");const outgoing=f.sent.find(m=>m.type==='chat');ws.message({type:'chat-error',id:outgoing.id,message:'database unavailable'});await settle();
 const bubble=f.$('chatlog').querySelector('[data-message-id="'+outgoing.id+'"]');assert.ok(bubble.querySelector('.messageMeta').textContent.includes('傳送失敗'));assert.ok(!bubble.querySelector('.messageMeta').textContent.includes('已儲存'));
 bubble.querySelector('.messageMeta').onclick();assert.equal(f.sent.filter(m=>m.type==='chat'&&m.id===outgoing.id).length,2);assert.ok(bubble.querySelector('.messageMeta').textContent.includes('等待儲存確認'));assert.equal(f.$('chatlog').querySelectorAll('.bubble').length,1);
});

test('sign-out and another account cannot resurrect a stale room response or old pending contents',async()=>{
 const oldRooms=deferred(),storage=new Map([['olw-pending:'+A+':'+ROOM_A,JSON.stringify([{id:id(9),roomId:ROOM_A,authorId:A,text:'private old draft',lang:'zh-TW',timestamp:9}])]]);
 const f=fixture({storage,user:A,fetch:(url,request)=>{if(url==='/api/rooms')return request.headers.Authorization==='Bearer token-'+A?oldRooms.promise:Response.json({rooms:[{id:ROOM_B}]});throw Error('Unexpected request '+url)}});await settle();assert.equal(f.sockets.length,0);
 f.emit(null);f.emit(B);await settle();assert.equal(f.sockets.length,1);const ws=await f.joined({room:ROOM_B,userId:B});oldRooms.resolve(Response.json({rooms:[{id:ROOM_A}]}));await settle();
 assert.equal(f.sockets.length,1);assert.equal(ws.sent[0].roomId,ROOM_B);assert.equal(f.run('currentUserId'),B);assert.equal(f.run('currentRoom'),ROOM_B);assert.equal(f.run('outbox.size'),0);assert.ok(!f.$('chatlog').textContent.includes('private old draft'));
});

test('late history from a signed-out account cannot appear in the next account',async()=>{
 const f=fixture({user:A});await settle();await f.joined({history:[message(1,A,'account A message')],nextCursor:'old-page'});const oldPage=deferred();
 f.setFetch(url=>url==='/api/rooms'?Response.json({rooms:[{id:ROOM_B}]}):oldPage.promise);const loading=f.run('loadOlderHistory()');await tick();f.emit(null);f.emit(B);await settle();await f.joined({room:ROOM_B,userId:B,history:[message(2,B,'account B message')]});oldPage.resolve(Response.json({messages:[message(3,A,'STALE PRIVATE CONTENT')],nextCursor:null}));await loading;
 assert.ok(f.$('chatlog').textContent.includes('account B message'));assert.ok(!f.$('chatlog').textContent.includes('account A message'));assert.ok(!f.$('chatlog').textContent.includes('STALE PRIVATE CONTENT'));
});

test('unauthenticated UI cannot open a socket, enqueue a message or fetch private history',async()=>{
 const f=fixture();await settle();assert.equal(f.sockets.length,0);assert.equal(f.requests.length,0);await f.run("connect('LOVE2026')");assert.equal(f.sockets.length,0);assert.equal(f.run("postText('not allowed')"),false);assert.equal(f.run('records.size'),0);assert.equal(f.run('outbox.size'),0);assert.ok(f.$('setup').classList.contains('hidden'));
});

test('duplicate-tab close code 4001 stops automatic reconnect loops',async()=>{
 const f=fixture({user:A});await settle();const ws=await f.joined();ws.close(4001);assert.equal(f.run('wantReconnect'),false);assert.ok(f.$('status').textContent.includes('另一個分頁'));
 for(const name of ['online','pageshow']){f.events.get(name)();await settle()}assert.equal(f.sockets.length,1);assert.ok(![...f.timers.values()].some(t=>t.ms===1000));
});

test('server acknowledgement timestamp reorders an optimistic message using authoritative history order',async()=>{
 const f=fixture({user:A});await settle();const now=Date.now(),partner=message(1,B,'existing partner message','zh-TW',now-100000);const ws=await f.joined({history:[partner]});f.run("postText('client clock is ahead')");const outgoing=f.sent.find(m=>m.type==='chat');
 const confirmed={id:outgoing.id,authorId:A,text:outgoing.text,lang:'zh-TW',timestamp:now-200000};ws.message({type:'chat-saved',id:outgoing.id,roomId:ROOM_A,message:confirmed});await settle();
 assert.deepEqual([...f.$('chatlog').querySelectorAll('.bubble')].map(el=>el.dataset.messageId),[outgoing.id,partner.id]);
});

test('repeated history taps share translation work without duplicating rendered translation lines',async()=>{
 const provider=deferred(),f=fixture({user:A,fetch:url=>url==='/api/rooms'?Response.json({rooms:[{id:ROOM_A}]}):provider.promise});await settle();const incoming=message(1,B,'foreign history','en');await f.joined({history:[incoming]});const bubble=f.$('chatlog').querySelector('[data-message-id="'+incoming.id+'"]');bubble.onclick();bubble.onclick();
 assert.equal(f.requests.filter(r=>r.url==='/api/translate').length,1);provider.resolve(Response.json({translation:'歷史譯文'}));await settle();assert.equal(bubble.querySelectorAll('.translation').length,1);
});
