const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');
const {webcrypto}=require('node:crypto');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture(){
 const {window:dom}=parseHTML(fs.readFileSync('public/index.html','utf8')),document=dom.document;
 const sockets=[],pcs=[],sent=[],requests=[],recognizers=[],mediaRequests=[];let onMedia=async options=>makeMedia(Boolean(options.video)),onFetch=async()=>Response.json({translation:'translated'});
 function track(kind){return {kind,enabled:true,readyState:'live',stopped:false,stop(){this.stopped=true;this.readyState='ended'},getSettings(){return {facingMode:'user'}},async applyConstraints(){}}}
 function makeMedia(video){return new Stream([track('audio'),...(video?[track('video')]:[])])}
 class Stream{constructor(tracks=[]){this.tracks=tracks}getTracks(){return this.tracks}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio')}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video')}removeTrack(t){this.tracks=this.tracks.filter(v=>v!==t)}addTrack(t){this.tracks.push(t)}}
 class Socket{static OPEN=1;constructor(){this.readyState=0;sockets.push(this)}send(raw){sent.push(JSON.parse(raw))}close(){this.readyState=3;this.onclose?.()}open(){this.readyState=1;this.onopen?.()}message(data){this.onmessage?.({data:JSON.stringify(data)})}}
 class Peer{constructor(){this.connectionState='new';this.signalingState='stable';this.senders=[];pcs.push(this)}addTrack(track){const sender={track,getParameters:()=>({encodings:[{}]}),async setParameters(){},async replaceTrack(next){this.track=next}};this.senders.push(sender);return sender}getSenders(){return this.senders}async createOffer(){return {type:'offer',sdp:'offer'}}async createAnswer(){return {type:'answer',sdp:'answer'}}async setLocalDescription(d){this.localDescription=d;this.signalingState=d.type==='offer'?'have-local-offer':'stable'}async setRemoteDescription(d){this.remoteDescription=d;this.signalingState=d.type==='offer'?'have-remote-offer':'stable'}async addIceCandidate(){}close(){this.connectionState='closed'}async getStats(){return new Map()}}
 class Recognition{constructor(){recognizers.push(this)}start(){this.started=(this.started||0)+1}stop(){this.onend?.()}abort(){this.aborted=true}}
 const storage=new Map();const timers=new Map();let timerId=0;
 for(const element of document.querySelectorAll('video'))element.play=()=>Promise.resolve();
 Object.defineProperty(document.getElementById('filterSelect'),'value',{value:'none',writable:true});
 Object.defineProperty(document.getElementById('testTargetSelect'),'value',{value:'en',writable:true});
 const synthesis={cancel(){},speak(){}};
 const CallTools={fetchRTCConfig:async()=>({iceServers:[{urls:'stun:test.example:3478'}],turnConfigured:false}),applyVideoPreset:async()=>({applied:true}),createQualityMonitor:()=>({start(){},stop(){},sample:async()=>null})};
 const WorldAuth={ready:async()=>({user:null,configured:true}),accessToken:async()=>"token-a",subscribe(){},signOut:async()=>{},user:()=>({id:'11111111-1111-4111-8111-111111111111'})};
 const window={WorldAuth,SpeechRecognition:Recognition,CallTools,speechSynthesis:synthesis,addEventListener(){},focus(){}};
 const context=vm.createContext({document,window,CallTools,WebSocket:Socket,RTCPeerConnection:Peer,MediaStream:Stream,SpeechSynthesisUtterance:class{},speechSynthesis:synthesis,crypto:webcrypto,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},navigator:{mediaDevices:{getUserMedia:options=>{mediaRequests.push(options);return onMedia(options)}}},location:{protocol:'https:',host:'test.local'},URL,AbortController,Response,console,alert(){},File:class{},atob:s=>Buffer.from(s,'base64').toString('binary'),setTimeout:(f,ms)=>{const id=++timerId;timers.set(id,{f,ms});return id},clearTimeout:id=>timers.delete(id),setInterval:()=>1,clearInterval(){},fetch:async(url,options)=>{requests.push({url,options});return onFetch(url,options)}});
 vm.runInContext(fs.readFileSync('public/app.js','utf8'),context);
 const run=code=>vm.runInContext(code,context),$=id=>document.getElementById(id);
 async function join(){await run("connect('LOVE2026')");sockets.at(-1).open();sockets.at(-1).message({type:'joined',count:2,roomToken:'test-room-token',roomId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',userId:'11111111-1111-4111-8111-111111111111',storage:{mode:'postgres'}});await flush()}
 async function incoming(mode='audio',id='call-one'){sockets.at(-1).message({type:'call-invite',callId:id,mode});await flush();await $('accept').onclick();pcs.at(-1).connectionState='connected';pcs.at(-1).onconnectionstatechange?.();return pcs.at(-1)}
 return {context,run,$,join,incoming,sockets,pcs,sent,requests,recognizers,mediaRequests,makeMedia,Stream,setMedia:fn=>onMedia=fn,setFetch:fn=>onFetch=fn,timers};
}

test('hangup while permission is pending stops late media without resurrecting a call',async()=>{
 const f=fixture();await f.join();const permission=deferred();f.setMedia(()=>permission.promise);const dial=f.run("dial('video')");assert.equal(f.run('calling'),true);f.run('endCall(true)');const media=f.makeMedia(true);permission.resolve(media);await dial;assert.ok(media.getTracks().every(t=>t.stopped));assert.equal(f.run('stream'),null);assert.equal(f.run('pc'),null);assert.equal(f.run('calling'),false);assert.equal(f.sent.some(m=>m.type==='call-invite'),false);
});
test('old WebSocket close and stale call signals cannot terminate a later session',async()=>{
 const f=fixture();await f.join();const oldClose=f.sockets[0].onclose;await f.run("connect('SECOND26')");const next=f.sockets.at(-1);next.open();next.message({type:'joined',count:2,roomToken:'second-token'});await flush();oldClose();assert.equal(f.run('joined'),true);await f.incoming('audio','new-call');next.message({type:'call-end',callId:'old-call'});await flush();assert.equal(f.run('activeCallId'),'new-call');assert.equal(f.run('calling'),true);f.run('endCall(false)');
});
test('speech is separate from chat, translates only partner speech, and rejects stale results',async()=>{
 const f=fixture();await f.join();await f.incoming('audio');f.$('mic').onclick();const recognition=f.recognizers[0];assert.equal(recognition.started,1);
 recognition.onresult({resultIndex:0,results:[Object.assign([{transcript:'我說的話'}],{isFinal:true})]});assert.ok(f.sent.some(m=>m.type==='speech-caption'&&m.text==='我說的話'));assert.equal(f.$('chatlog').querySelectorAll('.bubble').length,0);assert.equal(f.$('captionOriginal').textContent,'等待對方說話…');
 const provider=deferred();f.setFetch(()=>provider.promise);f.run("receiveSpeech({type:'speech-caption',callId:'call-one',id:'first-sentence',seq:1,text:'Old sentence',lang:'en'})");assert.equal(f.$('captionOriginal').textContent,'Old sentence');const request=JSON.parse(f.requests.at(-1).options.body);assert.equal(request.from,'en');assert.equal(request.to,'zh-TW');
 f.run("receiveSpeech({type:'speech-interim',callId:'call-one',id:'next-sentence',seq:2,text:'New sentence',lang:'en'},true)");provider.resolve(Response.json({translation:'舊翻譯'}));await flush();await flush();assert.equal(f.$('captionOriginal').textContent,'New sentence');assert.ok(!f.$('captionTranslation').textContent.includes('舊翻譯'));assert.equal(f.$('chatlog').querySelectorAll('.bubble').length,0);f.run('endCall(false)');assert.ok(recognition.aborted);
});
test('camera replacement acquired after hangup is stopped and never replaces the closed call UI',async()=>{
 const f=fixture();await f.join();const pc=await f.incoming('video');const replacement=f.makeMedia(true);replacement.tracks=replacement.getVideoTracks();const swap=deferred();pc.getSenders().find(s=>s.track.kind==='video').replaceTrack=()=>swap.promise;f.setMedia(async()=>replacement);const flip=f.$('flip').onclick();await flush();f.run('endCall(false)');swap.resolve();await flip;assert.ok(replacement.getTracks().every(t=>t.stopped));assert.equal(f.$('local').srcObject,null);assert.equal(f.run('stream'),null);
});
test('muting stops recognition and late recognizer callbacks cannot send speech',async()=>{
 const f=fixture();await f.join();await f.incoming('audio');f.$('mic').onclick();const old=f.recognizers[0],oldResult=old.onresult;f.$('mute').onclick();assert.equal(f.run('recognizing'),false);assert.ok(old.aborted);oldResult({resultIndex:0,results:[Object.assign([{transcript:'late'}],{isFinal:true})]});assert.ok(!f.sent.some(m=>m.type==='speech-caption'&&m.text==='late'));f.run('endCall(false)');
});

test('typed messages stay visible during a call and cannot be replaced by an older speech translation',async()=>{
 const f=fixture();await f.join();await f.incoming('audio');const speech=deferred(),chat=deferred();f.setFetch((url,options)=>JSON.parse(options.body).text==='Old speech'?speech.promise:chat.promise);
 f.run("receiveSpeech({type:'speech-caption',callId:'call-one',id:'old-speech',seq:1,text:'Old speech',lang:'en'})");
 const typed=f.run("receiveText({type:'chat',text:'New typed message',lang:'en'})");assert.equal(f.$('captionOriginal').textContent,'New typed message');speech.resolve(Response.json({translation:'舊的語音翻譯'}));await flush();assert.equal(f.$('captionOriginal').textContent,'New typed message');
 chat.resolve(Response.json({translation:'新的文字訊息'}));await typed;assert.equal(f.$('captionTranslation').textContent,'新的文字訊息');assert.equal(f.$('chatlog').querySelectorAll('.bubble').length,1);f.run('endCall(false)');
});

test('a cancelled old translation cannot block subtitles in the next call',async()=>{
 const f=fixture();await f.join();await f.incoming('audio','old-session');const old=deferred();f.setFetch((url,options)=>JSON.parse(options.body).text==='old'?old.promise:Promise.resolve(Response.json({translation:'新的翻譯'})));
 f.run("receiveSpeech({type:'speech-caption',callId:'old-session',id:'old-utterance',seq:1,text:'old',lang:'en'})");f.run('endCall(false)');await f.incoming('audio','next-session');
 f.run("receiveSpeech({type:'speech-caption',callId:'next-session',id:'new-utterance',seq:1,text:'new',lang:'en'})");await flush();await flush();assert.equal(f.$('captionTranslation').textContent,'新的翻譯');
 old.resolve(Response.json({translation:'舊的翻譯'}));await flush();assert.equal(f.$('captionTranslation').textContent,'新的翻譯');f.run('endCall(false)');
});
