'use strict';
// Regression simulation of the combined authenticated app. This is not a real
// iPhone Safari or live two-device media test.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {randomUUID}=require('node:crypto');
function existingFixture(filename,names){
 const source=fs.readFileSync(path.join(__dirname,filename),'utf8');
 const prefix=source.slice(0,source.indexOf("\ntest("));
 const fixtureModule=new Module(path.join(__dirname,'.caption-fixture-'+filename),module);
 fixtureModule.filename=path.join(__dirname,'.caption-fixture-'+filename);
 fixtureModule.paths=Module._nodeModulePaths(__dirname);
 fixtureModule._compile(prefix+'\nmodule.exports={'+names.join(',')+'};',fixtureModule.filename);
 return fixtureModule.exports;
}
const client=existingFixture('client-integration.test.js',['fixture','flush','deferred','A','B','ROOM']);
const backend=existingFixture('server.test.js',['fixture','accepted','ROOM']);

function installRecognition(f,{throwStart=false}={}){
 const instances=[];instances.allowStart=()=>{throwStart=false};
 class FakeRecognition{
  constructor(){this.starts=0;this.aborts=0;this.stops=0;instances.push(this)}
  start(){this.starts++;if(throwStart)throw Object.assign(Error('Gesture required'),{name:'NotAllowedError'});queueMicrotask(()=>this.onstart?.())}
  stop(){this.stops++;this.onend?.()}
  abort(){this.aborts++;this.onend?.()}
 }
 f.window.isSecureContext=true;f.window.webkitSpeechRecognition=FakeRecognition;
 return instances;
}
async function connected(t,options={}){
 const f=client.fixture(t,options),recognizers=installRecognition(f,options);await f.login();const ws=await f.enter();
 ws.server({type:'peer-joined',count:2});await client.flush();await f.document.getElementById('audioCall').onclick();
 const callId=ws.sent.find(x=>x.type==='call-invite').callId;ws.server({type:'call-accept',callId});await client.flush();
 const pc=f.peers[0];pc.connectionState='connected';pc.onconnectionstatechange();await client.flush();
 return {f,ws,callId,pc,recognizers};
}
function speechResult(rec,text,{final=true,index=0}={}){
 const result=[{transcript:text}];result.isFinal=final;rec.onresult?.({resultIndex:index,results:[result]});
}

test('merged private app waits for WebRTC before recognition; repeated speech does not create duplicate final rows or own translations',async t=>{
 const f=client.fixture(t),recognizers=installRecognition(f);await f.login();const ws=await f.enter();ws.server({type:'peer-joined',count:2});await client.flush();
 await f.document.getElementById('audioCall').onclick();assert.equal(recognizers.length,0,'no microphone recognizer before connected');
 const callId=ws.sent.find(x=>x.type==='call-invite').callId;ws.server({type:'call-accept',callId});await client.flush();
 f.peers[0].connectionState='connected';f.peers[0].onconnectionstatechange();await client.flush();
 assert.equal(recognizers.length,1);const rec=recognizers[0];assert.equal(rec.lang,'zh-TW');
 speechResult(rec,'我想你了');speechResult(rec,'我想你了');await client.flush();
 const packets=ws.sent.filter(x=>x.type==='speech-caption');assert.equal(packets.length,1);assert.equal(packets[0].callId,callId);assert.equal(packets[0].lang,'zh-TW');
 assert.equal(f.requests.filter(x=>x.path==='/api/translate').length,0,'own microphone must not spend translation calls');
 assert.equal(f.document.querySelectorAll('.captionMine').length,1);
});

test('merged private app translates partner English into Traditional Chinese and partner Chinese into English',async t=>{
 const {f,ws,callId}=await connected(t);f.setFetch(async(url,options)=>url==='/api/translate'?Response.json({translation:JSON.parse(options.body).to==='en'?'I miss you':'我想你了'}):f.baseFetch(url,options));
 const first={type:'speech-caption',callId,id:randomUUID(),revision:1,device:randomUUID(),text:'I miss you',lang:'en'};
 ws.server(first);await client.flush();
 let translations=f.requests.filter(x=>x.path==='/api/translate');assert.equal(translations.length,1);assert.deepEqual(JSON.parse(translations[0].request.body),{text:'I miss you',from:'en',to:'zh-TW'});assert.equal(translations[0].request.headers.Authorization,'Bearer verified-user-access-token-1234567890');
 assert(f.document.getElementById('callCaption').textContent.includes('我想你了'));
 ws.server(first);await client.flush();assert.equal(f.requests.filter(x=>x.path==='/api/translate').length,1,'repeated final delivery must not translate twice');
 f.run("lang='en'");ws.server({type:'speech-caption',callId,id:randomUUID(),revision:1,device:randomUUID(),text:'我想你',lang:'zh-TW'});await client.flush();
 translations=f.requests.filter(x=>x.path==='/api/translate');assert.equal(translations.length,2);assert.deepEqual(JSON.parse(translations[1].request.body),{text:'我想你',from:'zh-TW',to:'en'});assert(f.document.getElementById('callCaption').textContent.includes('I miss you'));
});

test('merged permission failure has a retry button, preserves original media, and cannot be overwritten by partner status',async t=>{
 const {f,ws,callId,recognizers}=await connected(t);const rec=recognizers.at(-1);
 rec.onerror({error:'not-allowed'});await client.flush();const local=f.document.getElementById('speechStatus').textContent;
 assert.match(local,/權限|permission|Safari/i);assert(!f.document.getElementById('speechRetry').classList.contains('hidden'));
 ws.server({type:'speech-status',callId,active:true,device:randomUUID()});await client.flush();assert.equal(f.document.getElementById('speechStatus').textContent,local);assert.match(f.document.getElementById('speechPeerStatus').textContent,/開啟|ready|on/i);
 assert(f.media[0].getAudioTracks().every(x=>x.readyState==='live'&&x.enabled));assert.notEqual(f.peers[0].connectionState,'closed');
 f.document.getElementById('speechRetry').onclick();await client.flush();assert(f.run('recognizing'));assert(recognizers.at(-1).starts>=1);
 f.document.getElementById('hangup').onclick();assert(f.media[0].getTracks().every(x=>x.readyState==='ended'));assert.equal(f.peers[0].connectionState,'closed');
});

test('merged app ignores old-call captions and late translation results after hangup',async t=>{
 const pending=client.deferred(),{f,ws,callId}=await connected(t);f.setFetch((url,options)=>url==='/api/translate'?pending.promise:f.baseFetch(url,options));
 ws.server({type:'speech-caption',callId:randomUUID(),id:randomUUID(),revision:1,device:randomUUID(),text:'Wrong call',lang:'en'});await client.flush();assert.equal(f.requests.filter(x=>x.path==='/api/translate').length,0);
 ws.server({type:'speech-caption',callId,id:randomUUID(),revision:1,device:randomUUID(),text:'Still pending',lang:'en'});await client.flush();assert.equal(f.requests.filter(x=>x.path==='/api/translate').length,1);
 f.document.getElementById('hangup').onclick();pending.resolve(Response.json({translation:'late private result'}));await client.flush();assert(!f.document.getElementById('callCaption').textContent.includes('late private result'));assert.equal(f.run('calling'),false);
});

test('merged private server sends captions and recognition status only to accepted partner with canonical device identity',async t=>{
 const f=backend.fixture(t),{a,b,callId}=await backend.accepted(f),a2=await f.join(),b2=await f.join('b');
 a.peer.take();b.peer.take();a2.peer.take();b2.peer.take();const spoof=randomUUID();
 a.peer.client({type:'speech-status',callId,active:true,device:spoof});let received=b.peer.take();assert.equal(received.length,1);assert.equal(received[0].type,'speech-status');assert.equal(received[0].device,a.peer.device);assert.notEqual(received[0].device,spoof);
 assert.deepEqual(a.peer.take(),[]);assert.deepEqual(a2.peer.take(),[]);assert.deepEqual(b2.peer.take(),[]);
 const id=randomUUID();a.peer.client({type:'caption-preview',callId,id,revision:2,device:spoof,text:'I miss',lang:'en'});received=b.peer.take();assert.equal(received[0].id,id);assert.equal(received[0].revision,2);assert.equal(received[0].device,a.peer.device);
 a.peer.client({type:'speech-caption',callId,id,revision:3,text:'I miss you',lang:'en'});received=b.peer.take();assert.equal(received[0].text,'I miss you');assert.equal(received[0].revision,3);
 a.peer.client({type:'caption-preview',callId,id,revision:2,text:'old words',lang:'en'});a.peer.client({type:'speech-caption',callId,id,revision:3,text:'I miss you',lang:'en'});assert.deepEqual(b.peer.take(),[],'stale interim and duplicate final must not relay');
 a.peer.client({type:'speech-caption',callId,id:randomUUID(),revision:1,text:'Next utterance',lang:'en'});assert.equal(b.peer.take()[0].text,'Next utterance','new utterance revisions restart at one');
 a.peer.client({type:'speech-status',callId:randomUUID(),active:true});a.peer.client({type:'speech-status',callId,active:'yes'});a.peer.client({type:'speech-caption',callId,id:randomUUID(),revision:1,text:'wrong language',lang:'bogus'});assert.deepEqual(b.peer.take(),[]);
});

test('merged recognizer continues after an utterance/session ends without reviving old callbacks',async t=>{
 const {f,ws,recognizers}=await connected(t),first=recognizers.at(-1);speechResult(first,'第一句');await client.flush();
 assert.equal(ws.sent.filter(x=>x.type==='speech-caption').length,1);first.onend();
 const restart=[...f.timers].filter(([,timer])=>timer.ms>0&&timer.ms<=4000).sort((a,b)=>a[1].ms-b[1].ms)[0];assert(restart,'natural recognition end must schedule a restart');f.timers.delete(restart[0]);restart[1].fn();await client.flush();
 const second=recognizers.at(-1);assert.notEqual(second,first);speechResult(first,'stale callback');speechResult(second,'第二句');await client.flush();
 assert.equal(ws.sent.filter(x=>x.type==='speech-caption').length,2);assert(!ws.sent.some(x=>x.text==='stale callback'));assert(f.media[0].getAudioTracks().every(x=>x.readyState==='live'));
});

test('merged startup failure clears recognition state and direct retry starts one fresh session',async t=>{
 const {f,recognizers}=await connected(t,{throwStart:true});assert.equal(f.run('recognizing'),false);assert(!f.document.getElementById('speechRetry').classList.contains('hidden'));assert.match(f.document.getElementById('speechStatus').textContent,/Safari|權限|permission/i);
 const before=recognizers.length;recognizers.allowStart();f.document.getElementById('speechRetry').onclick();await client.flush();assert.equal(recognizers.length,before+1);assert.equal(f.run('recognizing'),true);assert(f.document.getElementById('speechRetry').classList.contains('hidden'));assert.notEqual(f.peers[0].connectionState,'closed');
});

test('combined cream DOM keeps OTP, private history and existing art while adding distinct caption recovery controls',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),css=fs.readFileSync(path.join(__dirname,'../public/style.css'),'utf8');
 for(const id of ['emailAuth','emailAuthRequest','emailAuthVerify','emailAuthLogout','copyPrivateInvite','loadOlderMessages','speechStatus','speechPeerStatus','speechRetry'])assert(html.includes('id="'+id+'"'),id+' lost during merge');
 assert(html.includes('<script src="/email-auth.js"></script><script src="/private-history.js"></script><script src="/app.js"></script>'));
 assert(html.includes('/C086FD38-3250-4591-891E-8B5024BCE2D0.png'));assert(html.includes('/public/0432BDF0-48D5-4477-AFA7-20533B57C4D0.png'));
 assert(html.includes('<meta name="color-scheme" content="light">'));assert(css.includes(':root{color-scheme:light;--paper:#faf8f5;'));assert(css.includes('/* Verified Email entry and private-room history; existing app layout is retained. */'));
});
