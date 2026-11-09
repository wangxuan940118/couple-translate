const $=id=>document.getElementById(id);
let typingTimer=null,typingClearTimer=null,lastTypingSent=0;
let lastPreviewAt=0,previewTimer=null,previewText='',previewSequence=0;
let lang='zh-TW',socket=null,pc=null,stream=null,recognition=null,recognizing=false,joined=false,peerOnline=false,mode=null,calling=false,remoteReady=false,iceQueue=[],currentRoom='',callTimer=null,speechRestartTimer=null,captionSequence=0,photoBlob=null,photoURL=null;
const show=(id,on)=>$(id).classList.toggle('hidden',!on);
const languages=['zh-TW','en','sv','sr','fr','es','ja','ko','de','tr'];
const other=()=>lang==='zh-TW'?'en':'zh-TW'; // Translation test only; incoming chat always targets the viewer's language.
const status=t=>$('status').textContent=t;
const callStatus=t=>$('callStatus').textContent=t;
const send=m=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(m))};
const safeError=e=>e?.message||String(e);
// Push requires a Home Screen installation on iOS and server VAPID configuration.
const deviceId=(()=>{let id=localStorage.getItem('olw-device');if(!id){id=crypto.randomUUID();localStorage.setItem('olw-device',id)}return id})();
const notifyStatus=message=>{const el=$('notificationStatus');if(el)el.textContent=message};
function notifyIncoming(title,body){if(!('Notification'in window)||Notification.permission!=='granted'||!document.hidden)return;try{const n=new Notification(title,{body,tag:'our-little-world-message'});n.onclick=()=>{window.focus();n.close()}}catch(e){console.warn('Notification unavailable',e)}}
function urlBase64ToUint8Array(base64){const padded=base64+'='.repeat((4-base64.length%4)%4);const raw=atob(padded.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0))}
async function subscribePush(){if(!joined||!currentRoom){notifyStatus('請先進入私人房間，再開啟通知。');return}if(!('Notification'in window)||!('serviceWorker'in navigator)||!('PushManager'in window)){notifyStatus('此裝置或瀏覽器不支援推播。iPhone 請先用 Safari 加入主畫面，再從桌面開啟。');return}
 try{const permission=await Notification.requestPermission();if(permission!=='granted'){notifyStatus('尚未允許通知。');return}const config=await(await fetch('/api/push/key')).json();if(!config.enabled){notifyStatus('通知介面已準備好，但伺服器推播金鑰尚未設定。');return}
 const registration=await navigator.serviceWorker.ready;let subscription=await registration.pushManager.getSubscription();if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(config.publicKey)});
 const result=await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:currentRoom,device:deviceId,subscription:subscription.toJSON()})});if(!result.ok)throw Error('無法儲存通知訂閱');notifyStatus('通知已啟用。提醒：伺服器重啟後需要重新訂閱，正式持久化仍在開發中。');
 }catch(e){notifyStatus('推播設定失敗：'+safeError(e))}}
$('enableNotifications').onclick=subscribePush;
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(e=>console.warn('Service worker registration failed',e));

$('languageSelect').onchange=e=>{lang=e.target.value};
$('random').onclick=()=>{const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',nums=new Uint32Array(10);crypto.getRandomValues(nums);$('room').value=Array.from(nums,n=>chars[n%chars.length]).join('')};
function appendChat(who,text,translation){const log=$('chatlog');log.querySelector('.empty')?.remove();const p=document.createElement('div');p.className='bubble '+(who==='我'?'mine':'theirs');const title=document.createElement('small');title.textContent=who;p.append(title);const line=document.createElement('div');line.textContent=text;p.append(line);if(translation&&translation!==text){const sub=document.createElement('div');sub.className='translation';sub.textContent=translation;p.append(sub)}log.append(p);log.scrollTop=log.scrollHeight;filterChat();return p}
function filterChat(){const query=$('searchMessages').value.trim().toLocaleLowerCase();$('chatlog').querySelectorAll('.bubble').forEach(el=>{el.classList.toggle('hidden',Boolean(query)&&!el.textContent.toLocaleLowerCase().includes(query))})}
$('searchMessages').oninput=filterChat;
function sendTyping(){if(!joined)return;const now=Date.now();if(now-lastTypingSent>1600){send({type:'typing'});lastTypingSent=now}}
$('message').addEventListener('input',sendTyping);
$('callText').addEventListener('input',sendTyping);
async function translate(text,from,to){if(from===to)return text;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);try{const r=await fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,from,to}),signal:controller.signal});const d=await r.json();if(!r.ok)throw Error(d.error||'翻譯服務暫時無法使用');if(typeof d.translation!=='string'||!d.translation.trim())throw Error('翻譯結果為空');return d.translation}finally{clearTimeout(timeout)}}
async function postText(text){text=text.trim();if(!text||!joined)return;appendChat('我',text);send({type:'caption',text,lang});}
function speakTranslated(text){if(!$('readAloud').checked||!('speechSynthesis'in window))return;try{speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang=lang==='en'?'en-US':lang==='sr'?'sr-RS':lang;utterance.rate=.92;speechSynthesis.speak(utterance)}catch(e){console.warn('Speech playback unavailable',e)}}
async function receiveText(m){const seq=++captionSequence;const bubble=appendChat('寶貝',m.text);notifyIncoming('卡安 ❤️',m.to===lang&&typeof m.translated==='string'&&m.translated.trim()?m.translated:m.text);if(calling)$('callCaption').textContent=m.text;try{const t=(typeof m.translated==='string'&&m.translated.trim()&&m.to===lang)?m.translated:await translate(m.text,m.lang,lang);if(t!==m.text){const sub=document.createElement('div');sub.className='translation';sub.textContent=t;bubble.append(sub)}if(calling&&seq===captionSequence)$('callCaption').textContent=t;if(calling)speakTranslated(t)}catch{const sub=document.createElement('div');sub.className='translation';sub.textContent='翻譯暫時無法使用';bubble.append(sub)}}
$('testTranslate').onclick=async()=>{const button=$('testTranslate');const phrase=$('testPhrase').value.trim();if(!phrase)return;$('testResult').textContent='正在翻譯…';button.disabled=true;try{const result=await translate(phrase,lang,$('testTargetSelect').value);$('testResult').textContent='翻譯：'+result}catch(e){$('testResult').textContent='測試失敗：'+(e.name==='AbortError'?'翻譯逾時':safeError(e))}finally{button.disabled=false}};
$('manual').onsubmit=e=>{e.preventDefault();postText($('message').value);$('message').value=''};
$('callSend').onclick=()=>{postText($('callText').value);$('callText').value=''};
$('callText').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('callSend').click()}};
$('join').onclick=()=>{const room=$('room').value.trim().toUpperCase();if(!/^[A-Z0-9]{6,20}$/.test(room)){ $('setupNotice').textContent='請輸入 6–20 位英數字房間代碼';return}currentRoom=room;$('setupNotice').textContent='';connect(room)};
function connect(room){socket?.close();joined=false;peerOnline=false;socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);socket.onopen=()=>send({type:'join',room,device:deviceId});socket.onmessage=e=>{try{handle(JSON.parse(e.data))}catch(err){console.error(err)}};socket.onerror=()=>status('網路連線失敗');socket.onclose=()=>{if(joined){joined=false;peerOnline=false;status('連線已中斷，請重新進入');endCall(false)}}}
async function handle(m){switch(m.type){
case 'joined':joined=true;peerOnline=m.count===2;show('setup',false);show('home',true);status(peerOnline?'♡ 你們都在線上':'等待寶貝加入…');break;
case 'peer-joined':peerOnline=true;status('♡ 你們都在線上');break;
case 'peer-left':peerOnline=false;status('寶貝已離開房間');endCall(false);show('incomingCall',false);break;
case 'typing':$('typingStatus').textContent='對方正在輸入…';clearTimeout(typingClearTimer);typingClearTimer=setTimeout(()=>$('typingStatus').textContent='',2500);break;
case 'caption-preview':if(calling&&typeof m.text==='string')$('callCaption').textContent=m.text+' …';break;
case 'caption':$('typingStatus').textContent='';if(typeof m.text==='string'&&languages.includes(m.lang))receiveText(m);break;
case 'call-invite':if(calling||mode){send({type:'call-decline'});break}mode=m.mode==='video'?'video':'audio';$('incomingMode').textContent=mode==='video'?'視訊通話':'語音通話';$('incomingTitle').textContent='寶貝正在呼叫你…';show('incomingCall',true);notifyIncoming('卡安 ❤️','正在呼叫你 · '+(mode==='video'?'視訊通話':'語音通話'));break;
case 'call-accept':if(calling){clearTimeout(callTimer);callStatus('正在連線…');await makeOffer()}break;
case 'call-decline':if(calling){alert('對方暫時無法接聽');endCall(false)}break;
case 'call-end':endCall(false);break;
case 'offer':if(calling&&pc){await pc.setRemoteDescription(m.sdp);remoteReady=true;await flushIce();await pc.setLocalDescription(await pc.createAnswer());send({type:'answer',sdp:pc.localDescription})}break;
case 'answer':if(calling&&pc){await pc.setRemoteDescription(m.sdp);remoteReady=true;await flushIce()}break;
case 'ice':if(calling&&pc){if(remoteReady)await pc.addIceCandidate(m.candidate).catch(()=>{});else iceQueue.push(m.candidate)}break;
case 'error':alert(m.message||'房間連線失敗');if(!joined){socket?.close();show('setup',true);show('home',false)}break;
}}
async function flushIce(){for(const c of iceQueue.splice(0))await pc.addIceCandidate(c).catch(()=>{})}
async function setupCall(which){mode=which;calling=true;remoteReady=false;iceQueue=[];show('call',true);show('home',false);$('filterSelect').value='soft';applyFilter();show('cameraExtras',which==='video');show('incomingCall',false);show('audioBackdrop',which==='audio');show('local',which==='video');$('camera').disabled=which==='audio';$('flip').disabled=which==='audio';callStatus('正在準備通話…');try{stream=await navigator.mediaDevices.getUserMedia({audio:true,video:which==='video'});$('local').srcObject=stream;pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});stream.getTracks().forEach(track=>pc.addTrack(track,stream));pc.ontrack=e=>{$('remote').srcObject=e.streams[0];callStatus('♡ 通話中')};pc.onicecandidate=e=>{if(e.candidate)send({type:'ice',candidate:e.candidate})};pc.onconnectionstatechange=()=>{if(pc?.connectionState==='connected')callStatus('♡ 通話中');else if(pc&&['failed','disconnected'].includes(pc.connectionState))callStatus('連線不穩，請重試')};return true}catch(e){alert('無法使用相機或麥克風：'+safeError(e));endCall(false);return false}}
async function makeOffer(){if(!pc)return;await pc.setLocalDescription(await pc.createOffer());send({type:'offer',sdp:pc.localDescription})}
async function dial(which){if(!joined||!peerOnline){alert('請等寶貝進入同一個房間後再撥打');return}if(calling||mode)return;if(!await setupCall(which))return;callStatus('正在呼叫寶貝…');send({type:'call-invite',mode:which});callTimer=setTimeout(()=>{if(calling&&pc?.connectionState!=='connected'){alert('對方尚未接聽');endCall(true)}},45000)}
$('audioCall').onclick=()=>dial('audio');$('videoCall').onclick=()=>dial('video');
$('decline').onclick=()=>{send({type:'call-decline'});mode=null;show('incomingCall',false)};
$('accept').onclick=async()=>{const which=mode;if(!which)return;if(await setupCall(which)){callStatus('正在接聽…');send({type:'call-accept'})}else send({type:'call-decline'})};
function endCall(notify=true){clearTimeout(callTimer);clearTimeout(speechRestartTimer);clearTimeout(previewTimer);previewText='';if('speechSynthesis'in window)speechSynthesis.cancel();recognizing=false;$('speechStatus').textContent='點「語音字幕」開始辨識';try{recognition?.stop()}catch{}recognition=null;if(notify&&joined)send({type:'call-end'});pc?.close();pc=null;stream?.getTracks().forEach(t=>t.stop());stream=null;$('local').srcObject=null;$('remote').srcObject=null;calling=false;mode=null;remoteReady=false;iceQueue=[];closePhoto();show('call',false);show('incomingCall',false);show('home',joined);$('mic').querySelector('small').textContent='語音字幕'}
$('hangup').onclick=()=>endCall(true);
$('leave').onclick=()=>{endCall(true);socket?.close();joined=false;peerOnline=false;show('home',false);show('setup',true)};
$('mute').onclick=()=>{const t=stream?.getAudioTracks()[0];if(!t)return;t.enabled=!t.enabled;$('mute').querySelector('small').textContent=t.enabled?'靜音':'取消靜音'};
$('camera').onclick=()=>{const t=stream?.getVideoTracks()[0];if(!t)return;t.enabled=!t.enabled;$('camera').querySelector('small').textContent=t.enabled?'關閉鏡頭':'開啟鏡頭'};
$('flip').onclick=async()=>{const old=stream?.getVideoTracks()[0];if(!old)return;try{const facing=old.getSettings().facingMode==='environment'?'user':'environment';const next=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing}},audio:false});const track=next.getVideoTracks()[0];const sender=pc?.getSenders().find(s=>s.track?.kind==='video');if(sender)await sender.replaceTrack(track);stream.removeTrack(old);old.stop();stream.addTrack(track);$('local').srcObject=stream}catch(e){alert('無法切換鏡頭：'+safeError(e))}};
function stopRecognition(){recognizing=false;clearTimeout(speechRestartTimer);clearTimeout(previewTimer);previewText='';try{recognition?.stop()}catch{}$('mic').querySelector('small').textContent='語音字幕';$('speechStatus').textContent='語音字幕已停止'}
$('mic').onclick=()=>{if(recognizing){stopRecognition();return}const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SpeechRecognition){$('speechStatus').textContent='此瀏覽器不支援語音辨識，可使用文字訊息';return}
recognition=new SpeechRecognition();recognition.lang=lang==='en'?'en-US':lang==='sr'?'sr-RS':lang;recognition.continuous=true;recognition.interimResults=true;
recognition.onresult=e=>{let interim='';for(let i=e.resultIndex;i<e.results.length;i++){const result=e.results[i];const text=result[0]?.transcript?.trim();if(!text)continue;if(result.isFinal){clearTimeout(previewTimer);previewText='';postText(text)}else interim=text}if(interim){$('callCaption').textContent=interim+' …';$('speechStatus').textContent='正在辨識你的語音…';previewText=interim;const now=Date.now();if(now-lastPreviewAt>1100){lastPreviewAt=now;send({type:'caption-preview',text:interim})}else if(!previewTimer){previewTimer=setTimeout(()=>{previewTimer=null;if(recognizing&&calling&&previewText){lastPreviewAt=Date.now();send({type:'caption-preview',text:previewText})}},1100)}}else $('speechStatus').textContent='正在聆聽，停頓後傳送字幕'};
recognition.onend=()=>{if(recognizing&&calling){clearTimeout(speechRestartTimer);speechRestartTimer=setTimeout(()=>{if(recognizing&&calling){try{recognition.start()}catch(e){$('speechStatus').textContent='辨識暫停，請重新開啟'}}},500)}};
recognition.onerror=e=>{if(['not-allowed','service-not-allowed','audio-capture','language-not-supported'].includes(e.error)){stopRecognition();$('speechStatus').textContent='語音辨識不可用：'+e.error}else if(e.error!=='no-speech')$('speechStatus').textContent='辨識暫停：'+e.error};
try{recognizing=true;recognition.start();$('mic').querySelector('small').textContent='停止字幕';$('speechStatus').textContent='正在聆聽，停頓後傳送字幕'}catch(e){stopRecognition();$('speechStatus').textContent='無法啟動辨識：'+safeError(e)}};

const effects={none:'none',mono:'grayscale(1)',soft:'brightness(1.07) contrast(.94) saturate(1.06)',bright:'brightness(1.18) contrast(1.05)',vintage:'sepia(.45) contrast(.9) saturate(.75)'};
function applyFilter(){const effect=effects[$('filterSelect').value]||'none';$('local').style.filter=effect}
$('filterSelect').onchange=applyFilter;
function closePhoto(){show('photoPreview',false);if(photoURL)URL.revokeObjectURL(photoURL);photoURL=null;photoBlob=null;$('photoImage').removeAttribute('src')}
$('closePhoto').onclick=closePhoto;
$('snapshot').onclick=()=>{const video=$('local');if(!calling||mode!=='video'||!video.videoWidth){alert('請先開啟視訊，等待自己的畫面出現');return}try{const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const ctx=canvas.getContext('2d');if(!ctx)throw Error('無法使用拍照功能');ctx.filter=effects[$('filterSelect').value]||'none';ctx.drawImage(video,0,0,canvas.width,canvas.height);canvas.toBlob(blob=>{if(!blob){alert('照片建立失敗');return}closePhoto();photoBlob=blob;photoURL=URL.createObjectURL(blob);$('photoImage').src=photoURL;show('photoPreview',true)},'image/jpeg',.92)}catch(e){alert('拍照失敗：'+safeError(e))}};
$('savePhoto').onclick=async()=>{if(!photoBlob)return;const file=new File([photoBlob],'our-little-world-'+Date.now()+'.jpg',{type:'image/jpeg'});try{if(navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:'Our Little World'});return}}catch(e){if(e.name==='AbortError')return}const a=document.createElement('a');a.href=photoURL;a.download=file.name;document.body.append(a);a.click();a.remove();$('photoHint').textContent='如果 iPhone 沒有直接儲存，請長按照片選擇「儲存到照片」。'};
window.addEventListener('beforeunload',()=>{stream?.getTracks().forEach(t=>t.stop());socket?.close()});
