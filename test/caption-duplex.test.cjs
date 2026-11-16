'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {once}=require('node:events');
const {webcrypto}=require('node:crypto');
const {parseHTML}=require('linkedom');
const WebSocket=require('ws');
const {createServer}=require('../server.js');

const flush=async()=>{for(let i=0;i<8;i++)await new Promise(done=>setImmediate(done))};
async function until(predicate,label,timeout=4000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(predicate())return;await new Promise(done=>setTimeout(done,10))}
 assert.fail('Timed out: '+label);
}
async function backend(t){
 const calls=[],clients=[];let providerFailed=false;
 const {server,wss}=createServer({env:{OPENAI_API_KEY:'duplex-fixture-not-a-real-key'},fetch:async(url,request)=>{
  const body=JSON.parse(request.body);calls.push(body);
  if(providerFailed)return {ok:false,status:429,json:async()=>({error:{code:'fixture-quota'}})};
  const text=/into Traditional Chinese/.test(body.messages[0].content)?'我很想你。':'I miss you.';
  return {ok:true,status:200,json:async()=>({choices:[{message:{content:text}}]})};
 }});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{
  for(const client of clients)client.cleanup();for(const socket of wss.clients)socket.terminate();
  wss.close();server.closeAllConnections?.();await new Promise(done=>server.close(done));
 });
 return {origin,calls,clients,failProvider:value=>{providerFailed=value}};
}
function client(app,language,{speechSupported=true}={}){
 const {document}=parseHTML(fs.readFileSync(require.resolve('../public/index.html'),'utf8'));
 const requests=[],sent=[],sockets=[],recognizers=[],peers=[],timers=new Set(),alerts=[];
 for(const select of document.querySelectorAll('select')){
  let value=select.querySelector('option[selected]')?.getAttribute('value')||select.querySelector('option')?.getAttribute('value')||'';
  Object.defineProperty(select,'value',{get:()=>value,set:valueNext=>{value=String(valueNext)},configurable:true});
 }
 for(const video of document.querySelectorAll('video'))video.play=async()=>{};
 Object.defineProperty(document,'hidden',{value:false,writable:true,configurable:true});
 const audio={kind:'audio',enabled:true,readyState:'live',stop(){this.readyState='ended'}};
 const media={getAudioTracks:()=>[audio],getVideoTracks:()=>[],getTracks:()=>[audio]};
 class Recognition{
  constructor(){this.started=false;recognizers.push(this)}
  start(){this.started=true;this.onstart?.()}
  stop(){this.started=false}
  abort(){this.started=false}
  result(text,{final=true,index=0}={}){
   const slot=Object.assign([{transcript:text}],{isFinal:final});
   this.onresult?.({resultIndex:index,results:[...Array.from({length:index},()=>Object.assign([{transcript:''}],{isFinal:true})),slot]});
  }
 }
 class Peer{
  constructor(){this.connectionState='new';this.iceConnectionState='new';this.receivedCandidates=[];peers.push(this)}
  addTrack(track){return {track,getParameters:()=>({encodings:[{}]}),setParameters:async()=>{}}}
  async createOffer(){return {type:'offer',sdp:'synthetic-offer'}}
  async createAnswer(){return {type:'answer',sdp:'synthetic-answer'}}
  async setLocalDescription(value){this.localDescription=value}
  async setRemoteDescription(value){this.remoteDescription=value}
  async addIceCandidate(value){this.receivedCandidates.push(value)}
  async getStats(){return new Map()}
  close(){this.connectionState='closed';this.iceConnectionState='closed'}
 }
 class BrowserSocket extends WebSocket{
  constructor(url){super(url);sockets.push(this)}
  send(raw,...options){sent.push(JSON.parse(String(raw)));return super.send(raw,...options)}
 }
 const window={isSecureContext:true,addEventListener(){},focus(){}};
 if(speechSupported)window.webkitSpeechRecognition=Recognition;
 const storage=new Map([['olw-profile',language==='en'?'kaan':'her'],['olw-lang-'+(language==='en'?'kaan':'her'),language]]);
 const timeout=(fn,ms)=>{const id=setTimeout(()=>{timers.delete(id);fn()},ms);timers.add(id);id.unref?.();return id};
 const interval=(fn,ms)=>{const id=setInterval(fn,ms);timers.add(id);id.unref?.();return id};
 const clear=id=>{clearTimeout(id);clearInterval(id);timers.delete(id)};
 const context=vm.createContext({document,window,NodeFilter:{SHOW_TEXT:4},navigator:{mediaDevices:{getUserMedia:async()=>media}},
  localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
  location:new URL(app.origin),URL,crypto:webcrypto,Date,Intl,AbortController,Response,WebSocket:BrowserSocket,RTCPeerConnection:Peer,console,
  alert:text=>alerts.push(text),setTimeout:timeout,setInterval:interval,clearTimeout:clear,clearInterval:clear,
  fetch:async(path,request={})=>{requests.push({path,body:request.body?JSON.parse(request.body):null});return fetch(new URL(path,app.origin),request)},
 });
 vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'),'utf8'),context);
 const run=code=>vm.runInContext(code,context);
 const fixture={document,requests,sent,sockets,recognizers,peers,audio,alerts,run,
  cleanup(){run('manualDisconnect=true;endCall(false);socket?.close()');for(const timer of timers)clear(timer);for(const socket of sockets)socket.terminate()},
  connect(){run("currentRoom='DUPLEX2026';connect(currentRoom)")},
  connected(){run("pc.connectionState='connected';pc.iceConnectionState='connected';pc.onconnectionstatechange()")},
  enableSpeech(){window.webkitSpeechRecognition=Recognition;run('startSpeechCaptions()')},
 };
 app.clients.push(fixture);return fixture;
}
async function conversation(t,options={}){
 const app=await backend(t),zh=client(app,'zh-TW',{speechSupported:options.chineseSpeech!==false}),en=client(app,'en');
 zh.connect();en.connect();await until(()=>zh.run('joined&&peerOnline')&&en.run('joined&&peerOnline'),'both real WebSocket joins');
 await en.run("dial('audio')");await until(()=>zh.run("mode==='audio'"),'real call invitation');await zh.run("$('accept').onclick()");
 await until(()=>zh.run('remoteReady')&&en.run('remoteReady'),'real offer/answer exchange');
 zh.connected();en.connected();await until(()=>en.recognizers.length===1,'English recognition start');await flush();
 assert.equal(zh.run('captionCallId'),en.run('captionCallId'));
 return {app,zh,en};
}

test('two real app clients exchange English interim subtitles and Chinese replies over WebSocket and HTTP',async t=>{
 const {app,zh,en}=await conversation(t,{chineseSpeech:false});
 en.recognizers[0].result('I really miss you',{final:false});
 await until(()=>zh.document.querySelector('.captionTheirs .captionOriginal')?.textContent==='I really miss you','English interim reaches Chinese client');
 assert.equal(app.calls.length,0,'the original arrives before a translation pause or provider response');
 assert.equal(zh.recognizers.length,0,'incoming subtitles work without local speech recognition');
 await until(()=>zh.document.querySelector('.captionTheirs .captionTranslation')?.textContent.includes('我很想你。'),'English to Traditional Chinese translation');
 assert.deepEqual(zh.requests.filter(request=>request.path==='/api/translate').map(request=>request.body),[{text:'I really miss you',from:'en',to:'zh-TW'}]);
 assert.equal(en.requests.filter(request=>request.path==='/api/translate').length,0,'the sender never translates its own voice');
 assert.equal(en.document.querySelectorAll('.captionTheirs').length,0,'the sender does not render its own speech as partner speech');
 assert(en.sent.some(packet=>packet.type==='caption-preview'&&packet.lang==='en'));
 assert(!en.sent.some(packet=>packet.type==='speech-caption'),'English interim delivery does not require a finalized result');
 zh.enableSpeech();assert.equal(zh.recognizers.length,1);zh.recognizers[0].result('我也很想你');
 await until(()=>en.document.querySelector('.captionTheirs .captionTranslation')?.textContent==='I miss you.','Chinese to English translation');
 assert.deepEqual(en.requests.filter(request=>request.path==='/api/translate').map(request=>request.body),[{text:'我也很想你',from:'zh-TW',to:'en'}]);
 assert.equal(zh.audio.readyState,'live');assert.equal(en.audio.readyState,'live');
 assert.equal(zh.document.querySelectorAll('#chatlog .bubble').length,0);assert.equal(en.document.querySelectorAll('#chatlog .bubble').length,0);
});

test('provider failure leaves real call signaling and subsequent subtitle transport working',async t=>{
 const {app,zh,en}=await conversation(t);app.failProvider(true);
 en.recognizers[0].result('Provider failure must not stop the call');
 await until(()=>zh.document.querySelector('.captionTheirs .captionTranslation')?.dataset.state==='error','provider error shown with original retained');
 assert.equal(zh.document.querySelector('.captionTheirs .captionOriginal').textContent,'Provider failure must not stop the call');
 assert.equal(zh.run('pc.connectionState'),'connected');assert.equal(en.run('pc.connectionState'),'connected');
 assert.equal(zh.audio.readyState,'live');assert.equal(en.audio.readyState,'live');
 en.run("send({type:'ice',candidate:{candidate:'synthetic-candidate-after-provider-error'}})");
 await until(()=>zh.peers[0].receivedCandidates.length===1,'ICE still relayed after provider error');
 app.failProvider(false);en.recognizers[0].result('Captions continue after the provider recovers',{index:1});
 await until(()=>[...zh.document.querySelectorAll('.captionTheirs')].some(bubble=>bubble.querySelector('.captionOriginal').textContent==='Captions continue after the provider recovers'&&bubble.querySelector('.captionTranslation').textContent==='我很想你。'),'a later subtitle translates after provider recovery');
 assert.equal(en.run('speechWanted'),true);assert.equal(zh.run('calling'),true);assert.equal(en.run('calling'),true);
 assert.equal(en.document.querySelectorAll('.captionTheirs').length,0);
});
