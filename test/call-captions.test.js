'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {webcrypto,randomUUID}=require('node:crypto');
const {parseHTML}=require('linkedom');
const APP=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
const HTML=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
const CALL='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve))};
function fixture(options={}){
 const {document}=parseHTML(HTML),window={addEventListener(){},focus(){}},timers=new Map(),requests=[],sent=[],instances=[],tracks=[],alerts=[];
 let clock=100000,nextTimer=0,fetcher=options.fetch;
 for(const select of document.querySelectorAll('select')){let value=select.querySelector('option[selected]')?.getAttribute('value')||select.querySelector('option')?.getAttribute('value')||'';Object.defineProperty(select,'value',{get:()=>value,set:v=>{value=String(v)},configurable:true})}
 for(const video of document.querySelectorAll('video'))video.play=async()=>{};
 Object.defineProperty(document,'hidden',{value:false,writable:true,configurable:true});
 class FakeDate extends Date{constructor(...args){super(...(args.length?args:[clock]))}static now(){return clock}}
 class Recognition{
  constructor(){this.started=0;this.aborted=0;this.stopped=0;instances.push(this);if(options.constructorError)throw options.constructorError}
  start(){this.started++;if(options.startError)throw options.startError}
  stop(){this.stopped++}
  abort(){this.aborted++}
 }
 window.isSecureContext=options.secure!==false;
 if(options.supported!==false)window.webkitSpeechRecognition=Recognition;
 const audio={kind:'audio',enabled:true,readyState:'live',stop(){this.readyState='ended'}},media={getAudioTracks:()=>[audio],getVideoTracks:()=>[],getTracks:()=>[audio]};
 tracks.push(audio);
 const storage=new Map([['olw-profile',options.lang==='en'?'kaan':'her']]);
 class WS{static OPEN=1;static CLOSED=3;readyState=1;send(raw){sent.push(JSON.parse(raw))}close(){this.readyState=3}}
 const timer=(fn,ms,interval=false)=>{const id=++nextTimer;timers.set(id,{fn,ms,at:clock+ms,interval});return id};
 const context=vm.createContext({document,window,NodeFilter:{SHOW_TEXT:4},navigator:{mediaDevices:{getUserMedia:async()=>media}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value))},location:new URL('https://private.example.test/'),URL,crypto:webcrypto,Date:FakeDate,Intl,AbortController,Response,WebSocket:WS,console,alert:text=>alerts.push(text),setTimeout:(fn,ms)=>timer(fn,ms),setInterval:(fn,ms)=>timer(fn,ms,true),clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),fetch:async(path,request={})=>{requests.push({path,request});if(fetcher)return fetcher(path,request);const body=JSON.parse(request.body);return Response.json({translation:body.to==='en'?'I miss you':'我想你了'})}});
 vm.runInContext(APP,context);
 const run=code=>vm.runInContext(code,context);
 run("calling=true;joined=true;peerOnline=true;captionCallId='"+CALL+"';socket=new WebSocket();pc={connectionState:'connected',close(){this.connectionState='closed'}};");
 context.fixtureMedia=media;run('stream=fixtureMedia;resetCallCaptions()');
 async function advance(ms){const target=clock+ms;let turns=0;while(true){const ready=[...timers.entries()].filter(([,x])=>x.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!ready)break;if(++turns>1000)throw Error('timerloop');clock=ready[1].at;timers.delete(ready[0]);if(ready[1].interval)timers.set(ready[0],{...ready[1],at:clock+ready[1].ms});ready[1].fn();await flush()}clock=target;await flush()}
 function result(rec,text,final=true,index=0){const slot=[{transcript:text}];slot.isFinal=final;const results=Array.from({length:index},()=>{const old=[{transcript:''}];old.isFinal=true;return old});results.push(slot);rec.onresult?.({resultIndex:index,results})}
 return {document,window,run,requests,sent,instances,audio,timers,alerts,advance,result,setFetch:fn=>fetcher=fn,context};
}
function packet(overrides={}){return {id:randomUUID(),revision:1,callId:CALL,device:'remote-device',text:'I miss you',lang:'en',...overrides}}
function deliver(f,message,final=true){f.context.message=message;f.run('receiveSpeechCaption(message,'+final+')')}

test('English remote captions translate to Traditional Chinese and local speech never consumes translation',async()=>{
 const f=fixture();f.run("addSpeechCaption('我想你','zh-TW','我','local-one')");await flush();assert.equal(f.requests.length,0);
 deliver(f,packet());await flush();assert.equal(f.requests.length,1);assert.deepEqual(JSON.parse(f.requests[0].request.body),{text:'I miss you',from:'en',to:'zh-TW'});assert.match(f.document.getElementById('callCaption').textContent,/I miss you/);assert.match(f.document.getElementById('callCaption').textContent,/我想你了/);
});
test('Chinese remote captions translate to English for the English user',async()=>{
 const f=fixture({lang:'en'});deliver(f,packet({text:'我想你',lang:'zh-TW'}));await flush();assert.deepEqual(JSON.parse(f.requests[0].request.body),{text:'我想你',from:'zh-TW',to:'en'});assert.match(f.document.getElementById('callCaption').textContent,/I miss you/);
});
test('interim and final use the same bubble; duplicates, stale revisions, own device and old calls are ignored',async()=>{
 const f=fixture(),id=randomUUID();deliver(f,packet({id,text:'I',revision:1}),false);assert.equal(f.document.querySelectorAll('.captionTheirs').length,1);
 deliver(f,packet({id,text:'I miss you',revision:2}),true);await flush();deliver(f,packet({id,text:'I miss you',revision:2}),true);deliver(f,packet({id,text:'stale',revision:1}),false);
 const self=f.run('deviceId');deliver(f,packet({device:self}));deliver(f,packet({callId:randomUUID()}));await f.advance(1000);
 assert.equal(f.document.querySelectorAll('.captionTheirs').length,1);assert.equal(f.requests.length,1);assert.doesNotMatch(f.document.getElementById('callCaption').textContent,/stale/);
});
test('continuous recognition restarts a fresh instance after Safari ends and ignores callbacks from the old instance',async()=>{
 const f=fixture();f.run('autoStartCallCaptions()');assert.equal(f.instances.length,1);const first=f.instances[0];first.onstart();f.result(first,'第一句',true);
 const staleResult=first.onresult,staleError=first.onerror;first.onend();await f.advance(800);assert.equal(f.instances.length,2);const next=f.instances[1];next.onstart();f.result(next,'第二句',true);staleResult({resultIndex:0,results:[]});staleError({error:'not-allowed'});
 assert.equal(f.run('speechWanted'),true);assert.equal(f.run('recognition===null'),false);assert.equal(f.sent.filter(x=>x.type==='speech-caption').length,2);assert.equal(f.requests.length,0);
});
test('repeat phrases from distinct recognition result indexes remain distinct; final replay is deduplicated',async()=>{
 const f=fixture();f.run('startSpeechCaptions()');const rec=f.instances[0];rec.onstart();f.result(rec,'Hello',true,0);f.result(rec,'Hello',true,0);f.result(rec,'Hello',true,1);
 assert.equal(f.sent.filter(x=>x.type==='speech-caption').length,2);assert.notEqual(f.sent.filter(x=>x.type==='speech-caption')[0].id,f.sent.filter(x=>x.type==='speech-caption')[1].id);
});
test('permission failure reports a reason and retry button without stopping original audio',async()=>{
 const f=fixture();f.run('startSpeechCaptions()');f.instances[0].onerror({error:'not-allowed'});assert.equal(f.run('speechWanted'),false);assert.match(f.document.getElementById('speechStatus').textContent,/Safari.*允許/);assert(!f.document.getElementById('speechRetry').classList.contains('hidden'));assert.equal(f.audio.readyState,'live');assert.equal(f.run('pc.connectionState'),'connected');
 f.document.getElementById('speechRetry').onclick();assert.equal(f.instances.length,2);f.instances[1].onstart();assert(f.document.getElementById('speechRetry').classList.contains('hidden'));
});
test('partner status cannot overwrite local permission errors',async()=>{
 const f=fixture();f.run('speechFailure("audio-capture")');const own=f.document.getElementById('speechStatus').textContent;f.context.message={type:'speech-status',active:true,callId:CALL,device:'partner'};await f.run('handle(message)');assert.equal(f.document.getElementById('speechStatus').textContent,own);assert.match(f.document.getElementById('speechPeerStatus').textContent,/對方字幕已開啟/);
});
test('startup timeout and synchronous start failure produce explicit recoverable states',async()=>{
 const f=fixture();f.run('startSpeechCaptions()');await f.advance(8001);assert.equal(f.run('speechWanted'),false);assert.match(f.document.getElementById('speechStatus').textContent,/啟動逾時/);assert.equal(f.instances[0].aborted,1);
 const g=fixture({startError:Object.assign(Error('blocked'),{name:'NotAllowedError'})});g.run('startSpeechCaptions()');assert.equal(g.run('speechWanted'),false);assert(!g.document.getElementById('speechRetry').classList.contains('hidden'));
});
test('unsupported and insecure browsers have clear errors and do not claim recognition is active',()=>{
 for(const options of [{supported:false},{secure:false}]){const f=fixture(options);f.run('startSpeechCaptions()');assert.equal(f.run('speechWanted'),false);assert.equal(f.instances.length,0);assert(!f.document.getElementById('speechRetry').classList.contains('hidden'));assert(!f.sent.some(x=>x.active===true))}
});
test('hangup invalidates callbacks, cancels scheduled restart and releases microphone',async()=>{
 const f=fixture();f.run('startSpeechCaptions()');const rec=f.instances[0];rec.onstart();const old=rec.onend;rec.onend();f.run('endCall(false)');old();await f.advance(5000);assert.equal(f.instances.length,1);assert.equal(f.audio.readyState,'ended');assert.equal(f.run('speechWanted'),false);assert.equal(f.run('recognition'),null);
});
test('translation outages keep originals and media independent; concurrency is bounded',async()=>{
 const pending=[];const f=fixture({fetch:(path,request)=>new Promise((resolve,reject)=>{pending.push({resolve,reject,request});request.signal.addEventListener('abort',()=>reject(Object.assign(Error('abort'),{name:'AbortError'})),{once:true})})});
 for(let i=0;i<8;i++)deliver(f,packet({text:'Sentence '+i}));await flush();assert.equal(f.requests.length,2);assert.equal(f.run('captionTranslationRunning'),2);assert.equal(f.run('pc.connectionState'),'connected');assert.equal(f.audio.readyState,'live');
 pending[0].resolve(Response.json({error:'provider unavailable'},{status:502}));await flush();assert.match(f.document.getElementById('callCaption').textContent,/Sentence 0/);assert.equal(f.document.querySelector('.captionTranslation[data-state="error"]').textContent,'翻譯暫時無法使用，點此重試');assert.equal(f.requests.length,3);f.run('endCall(false)');await flush();assert.equal(f.run('captionTranslationRunning'),0);
});
test('late interim translation cannot overwrite finalized caption revision',async()=>{
 const pending=[];const f=fixture({fetch:(path,request)=>new Promise(resolve=>pending.push({resolve,request}))}),id=randomUUID();
 deliver(f,packet({id,text:'I miss',revision:1}),false);await f.advance(901);assert.equal(pending.length,1);deliver(f,packet({id,text:'I miss you',revision:2}),true);await flush();pending[0].resolve(Response.json({translation:'過期片段'}));await flush();assert.doesNotMatch(f.document.getElementById('callCaption').textContent,/過期片段/);assert.equal(pending.length,2);pending[1].resolve(Response.json({translation:'我想你了'}));await flush();assert.equal(f.document.querySelectorAll('.captionTheirs').length,1);assert.match(f.document.getElementById('callCaption').textContent,/我想你了/);
});
test('two isolated real client contexts exchange recognized Chinese and English into correct viewer translations',async()=>{
 const a=fixture(),b=fixture({lang:'en'});for(const f of[a,b]){f.run('startSpeechCaptions()');f.instances[0].onstart()}
 a.result(a.instances[0],'我想你了');b.result(b.instances[0],'I miss you');
 const fromA=a.sent.find(x=>x.type==='speech-caption'),fromB=b.sent.find(x=>x.type==='speech-caption');deliver(b,fromA);deliver(a,fromB);await flush();
 assert.deepEqual(JSON.parse(a.requests[0].request.body),{text:'I miss you',from:'en',to:'zh-TW'});assert.deepEqual(JSON.parse(b.requests[0].request.body),{text:'我想你了',from:'zh-TW',to:'en'});
 assert.equal(a.document.querySelectorAll('.captionMine').length,1);assert.equal(a.document.querySelectorAll('.captionTheirs').length,1);
});


test('changing language during an active call replaces the recognizer with a captured source language',async()=>{
 const f=fixture();f.run('startSpeechCaptions()');const first=f.instances[0];first.onstart();f.document.getElementById('languageSelect').onchange({target:{value:'en'}});assert.equal(first.aborted,1);assert.equal(f.instances.length,2);assert.equal(f.instances[1].lang,'en-US');f.instances[1].onstart();f.result(f.instances[1],'Hello');assert.equal(f.sent.filter(x=>x.type==='speech-caption').at(-1).lang,'en');
});
test('recognition constructor failures are recoverable and repeated rapid endings do not spin forever',async()=>{
 const f=fixture({constructorError:Error('unavailable')});f.run('startSpeechCaptions()');assert.equal(f.run('speechWanted'),false);assert(!f.document.getElementById('speechRetry').classList.contains('hidden'));
 const g=fixture();g.run('startSpeechCaptions()');for(let i=0;i<5;i++){const current=g.instances.at(-1);current.onstart();current.onend();await g.advance(g.run('Math.min(4000,350*Math.pow(2,Math.min(speechFailureCount,3)))'))}assert.equal(g.run('speechWanted'),false);assert.match(g.document.getElementById('speechStatus').textContent,/反覆停止/);assert.equal(g.instances.length,5);
});
test('a silent Safari hang restarts even when abort never emits onend; background pause keeps call audio alive',async()=>{
 const f=fixture();f.run('startSpeechCaptions()');f.instances[0].onstart();await f.advance(70351);assert.equal(f.instances.length,2);assert.equal(f.instances[0].aborted,1);f.document.hidden=true;f.run("speechFailure('background')");assert.equal(f.run('speechWanted'),false);assert.equal(f.audio.readyState,'live');assert.match(f.document.getElementById('speechStatus').textContent,/背景/);
});
