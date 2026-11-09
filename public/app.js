const $=id=>document.getElementById(id);
let lang='zh-TW',socket=null,pc=null,stream=null,recognition=null,recognizing=false,joined=false,peerOnline=false,mode=null,calling=false,remoteReady=false,iceQueue=[],currentRoom='',callTimer=null,speechRestartTimer=null,captionSequence=0;
const show=(id,on)=>$(id).classList.toggle('hidden',!on);
const other=()=>lang==='zh-TW'?'en':'zh-TW';
const status=t=>$('status').textContent=t;
const callStatus=t=>$('callStatus').textContent=t;
const send=m=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(m))};
const safeError=e=>e?.message||String(e);
$('zh').onclick=()=>choose('zh-TW');$('en').onclick=()=>choose('en');
function choose(l){lang=l;$('zh').classList.toggle('selected',l==='zh-TW');$('en').classList.toggle('selected',l==='en')}
$('random').onclick=()=>{const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',nums=new Uint32Array(10);crypto.getRandomValues(nums);$('room').value=Array.from(nums,n=>chars[n%chars.length]).join('')};
function appendChat(who,text,translation){const log=$('chatlog');log.querySelector('.empty')?.remove();const p=document.createElement('div');p.className='bubble '+(who==='我'?'mine':'theirs');const title=document.createElement('small');title.textContent=who;p.append(title);const line=document.createElement('div');line.textContent=text;p.append(line);if(translation&&translation!==text){const sub=document.createElement('div');sub.className='translation';sub.textContent=translation;p.append(sub)}log.append(p);log.scrollTop=log.scrollHeight;return p}
async function translate(text,from,to){if(from===to)return text;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);try{const r=await fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,from,to}),signal:controller.signal});const d=await r.json();if(!r.ok)throw Error(d.error||'翻譯服務暫時無法使用');if(typeof d.translation!=='string'||!d.translation.trim())throw Error('翻譯結果為空');return d.translation}finally{clearTimeout(timeout)}}
async function postText(text){text=text.trim();if(!text||!joined)return;send({type:'caption',text,lang});const bubble=appendChat('我',text);if(calling)$('callCaption').textContent=text;try{const translated=await translate(text,lang,other());if(translated!==text){const sub=document.createElement('div');sub.className='translation';sub.textContent=translated;bubble.append(sub)}}catch{const sub=document.createElement('div');sub.className='translation';sub.textContent='翻譯暫時無法使用（原文已送出）';bubble.append(sub)}}
function speakTranslated(text){if(!$('readAloud').checked||!('speechSynthesis'in window))return;try{speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang=lang==='zh-TW'?'zh-TW':'en-US';utterance.rate=.92;speechSynthesis.speak(utterance)}catch(e){console.warn('Speech playback unavailable',e)}}
async function receiveText(m){const seq=++captionSequence;const bubble=appendChat('寶貝',m.text);if(calling)$('callCaption').textContent=m.text;try{const t=await translate(m.text,m.lang,lang);const sub=document.createElement('div');sub.className='translation';sub.textContent=t;bubble.append(sub);if(calling&&seq===captionSequence)$('callCaption').textContent=t;if(calling)speakTranslated(t)}catch{const sub=document.createElement('div');sub.className='translation';sub.textContent='翻譯暫時無法使用';bubble.append(sub)}}
$('testTranslate').onclick=async()=>{const button=$('testTranslate');const phrase=$('testPhrase').value.trim();if(!phrase)return;$('testResult').textContent='正在翻譯…';button.disabled=true;try{const result=await translate(phrase,lang,other());$('testResult').textContent=(other()==='en'?'英文：':'中文：')+result}catch(e){$('testResult').textContent='測試失敗：'+(e.name==='AbortError'?'翻譯逾時':safeError(e))}finally{button.disabled=false}};
$('manual').onsubmit=e=>{e.preventDefault();postText($('message').value);$('message').value=''};
$('callSend').onclick=()=>{postText($('callText').value);$('callText').value=''};
$('callText').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('callSend').click()}};
$('join').onclick=()=>{const room=$('room').value.trim().toUpperCase();if(!/^[A-Z0-9]{6,20}$/.test(room)){ $('setupNotice').textContent='請輸入 6–20 位英數字房間代碼';return}currentRoom=room;$('setupNotice').textContent='';connect(room)};
function connect(room){socket?.close();joined=false;peerOnline=false;socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);socket.onopen=()=>send({type:'join',room});socket.onmessage=e=>{try{handle(JSON.parse(e.data))}catch(err){console.error(err)}};socket.onerror=()=>status('網路連線失敗');socket.onclose=()=>{if(joined){joined=false;peerOnline=false;status('連線已中斷，請重新進入');endCall(false)}}}
async function handle(m){switch(m.type){
case 'joined':joined=true;peerOnline=m.count===2;show('setup',false);show('home',true);status(peerOnline?'♡ 你們都在線上':'等待寶貝加入…');break;
case 'peer-joined':peerOnline=true;status('♡ 你們都在線上');break;
case 'peer-left':peerOnline=false;status('寶貝已離開房間');endCall(false);show('incomingCall',false);break;
case 'caption':if(typeof m.text==='string'&&['en','zh-TW'].includes(m.lang))receiveText(m);break;
case 'call-invite':if(calling||mode){send({type:'call-decline'});break}mode=m.mode==='video'?'video':'audio';$('incomingMode').textContent=mode==='video'?'視訊通話':'語音通話';$('incomingTitle').textContent='寶貝正在呼叫你…';show('incomingCall',true);break;
case 'call-accept':if(calling){clearTimeout(callTimer);callStatus('正在連線…');await makeOffer()}break;
case 'call-decline':if(calling){alert('對方暫時無法接聽');endCall(false)}break;
case 'call-end':endCall(false);break;
case 'offer':if(calling&&pc){await pc.setRemoteDescription(m.sdp);remoteReady=true;await flushIce();await pc.setLocalDescription(await pc.createAnswer());send({type:'answer',sdp:pc.localDescription})}break;
case 'answer':if(calling&&pc){await pc.setRemoteDescription(m.sdp);remoteReady=true;await flushIce()}break;
case 'ice':if(calling&&pc){if(remoteReady)await pc.addIceCandidate(m.candidate).catch(()=>{});else iceQueue.push(m.candidate)}break;
case 'error':alert(m.message||'房間連線失敗');if(!joined){socket?.close();show('setup',true);show('home',false)}break;
}}
async function flushIce(){for(const c of iceQueue.splice(0))await pc.addIceCandidate(c).catch(()=>{})}
async function setupCall(which){mode=which;calling=true;remoteReady=false;iceQueue=[];show('call',true);show('home',false);show('incomingCall',false);show('audioBackdrop',which==='audio');show('local',which==='video');$('camera').disabled=which==='audio';$('flip').disabled=which==='audio';callStatus('正在準備通話…');try{stream=await navigator.mediaDevices.getUserMedia({audio:true,video:which==='video'});$('local').srcObject=stream;pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});stream.getTracks().forEach(track=>pc.addTrack(track,stream));pc.ontrack=e=>{$('remote').srcObject=e.streams[0];callStatus('♡ 通話中')};pc.onicecandidate=e=>{if(e.candidate)send({type:'ice',candidate:e.candidate})};pc.onconnectionstatechange=()=>{if(pc?.connectionState==='connected')callStatus('♡ 通話中');else if(pc&&['failed','disconnected'].includes(pc.connectionState))callStatus('連線不穩，請重試')};return true}catch(e){alert('無法使用相機或麥克風：'+safeError(e));endCall(false);return false}}
async function makeOffer(){if(!pc)return;await pc.setLocalDescription(await pc.createOffer());send({type:'offer',sdp:pc.localDescription})}
async function dial(which){if(!joined||!peerOnline){alert('請等寶貝進入同一個房間後再撥打');return}if(calling||mode)return;if(!await setupCall(which))return;callStatus('正在呼叫寶貝…');send({type:'call-invite',mode:which});callTimer=setTimeout(()=>{if(calling&&pc?.connectionState!=='connected'){alert('對方尚未接聽');endCall(true)}},45000)}
$('audioCall').onclick=()=>dial('audio');$('videoCall').onclick=()=>dial('video');
$('decline').onclick=()=>{send({type:'call-decline'});mode=null;show('incomingCall',false)};
$('accept').onclick=async()=>{const which=mode;if(!which)return;if(await setupCall(which)){callStatus('正在接聽…');send({type:'call-accept'})}else send({type:'call-decline'})};
function endCall(notify=true){clearTimeout(callTimer);clearTimeout(speechRestartTimer);if('speechSynthesis'in window)speechSynthesis.cancel();recognizing=false;$('speechStatus').textContent='點「語音字幕」開始辨識';try{recognition?.stop()}catch{}recognition=null;if(notify&&joined)send({type:'call-end'});pc?.close();pc=null;stream?.getTracks().forEach(t=>t.stop());stream=null;$('local').srcObject=null;$('remote').srcObject=null;calling=false;mode=null;remoteReady=false;iceQueue=[];show('call',false);show('incomingCall',false);show('home',joined);$('mic').querySelector('small').textContent='語音字幕'}
$('hangup').onclick=()=>endCall(true);
$('leave').onclick=()=>{endCall(true);socket?.close();joined=false;peerOnline=false;show('home',false);show('setup',true)};
$('mute').onclick=()=>{const t=stream?.getAudioTracks()[0];if(!t)return;t.enabled=!t.enabled;$('mute').querySelector('small').textContent=t.enabled?'靜音':'取消靜音'};
$('camera').onclick=()=>{const t=stream?.getVideoTracks()[0];if(!t)return;t.enabled=!t.enabled;$('camera').querySelector('small').textContent=t.enabled?'關閉鏡頭':'開啟鏡頭'};
$('flip').onclick=async()=>{const old=stream?.getVideoTracks()[0];if(!old)return;try{const facing=old.getSettings().facingMode==='environment'?'user':'environment';const next=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing}},audio:false});const track=next.getVideoTracks()[0];const sender=pc?.getSenders().find(s=>s.track?.kind==='video');if(sender)await sender.replaceTrack(track);stream.removeTrack(old);old.stop();stream.addTrack(track);$('local').srcObject=stream}catch(e){alert('無法切換鏡頭：'+safeError(e))}};
function stopRecognition(){recognizing=false;clearTimeout(speechRestartTimer);try{recognition?.stop()}catch{}$('mic').querySelector('small').textContent='語音字幕';$('speechStatus').textContent='語音字幕已停止'}
$('mic').onclick=()=>{if(recognizing){stopRecognition();return}const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SpeechRecognition){$('speechStatus').textContent='此瀏覽器不支援語音辨識，可使用文字訊息';return}
recognition=new SpeechRecognition();recognition.lang=lang==='zh-TW'?'zh-TW':'en-US';recognition.continuous=true;recognition.interimResults=true;
recognition.onresult=e=>{let interim='';for(let i=e.resultIndex;i<e.results.length;i++){const result=e.results[i];const text=result[0]?.transcript?.trim();if(!text)continue;if(result.isFinal)postText(text);else interim=text}if(interim){$('callCaption').textContent=interim+' …';$('speechStatus').textContent='正在辨識你的語音…'}else $('speechStatus').textContent='正在聆聽，停頓後傳送字幕'};
recognition.onend=()=>{if(recognizing&&calling){clearTimeout(speechRestartTimer);speechRestartTimer=setTimeout(()=>{if(recognizing&&calling){try{recognition.start()}catch(e){$('speechStatus').textContent='辨識暫停，請重新開啟'}}},500)}};
recognition.onerror=e=>{if(['not-allowed','service-not-allowed','audio-capture','language-not-supported'].includes(e.error)){stopRecognition();$('speechStatus').textContent='語音辨識不可用：'+e.error}else if(e.error!=='no-speech')$('speechStatus').textContent='辨識暫停：'+e.error};
try{recognizing=true;recognition.start();$('mic').querySelector('small').textContent='停止字幕';$('speechStatus').textContent='正在聆聽，停頓後傳送字幕'}catch(e){stopRecognition();$('speechStatus').textContent='無法啟動辨識：'+safeError(e)}};

window.addEventListener('beforeunload',()=>{stream?.getTracks().forEach(t=>t.stop());socket?.close()});
