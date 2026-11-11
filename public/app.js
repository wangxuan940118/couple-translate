const $=id=>document.getElementById(id);
const translationCache=new Map();
let connectionWatch=null,remoteCaptionSeq=0,captionAbort=null,lastSpeechText='',lastSpeechAt=0;
let typingTimer=null,typingClearTimer=null,lastTypingSent=0;
let lastPreviewAt=0,previewTimer=null,previewText='',previewSequence=0;
let lang=localStorage.getItem('olw-profile')==='kaan'?'en':'zh-TW',socket=null,pc=null,stream=null,recognition=null,recognizing=false,joined=false,peerOnline=false,mode=null,calling=false,remoteReady=false,iceQueue=[],currentRoom='',callTimer=null,speechRestartTimer=null,captionSequence=0,photoBlob=null,photoURL=null;
const show=(id,on)=>$(id).classList.toggle('hidden',!on);
// The cover is deliberately shown on every fresh visit; no automatic skip.
$('coverNext').addEventListener('click',()=>{show('cover',false);show('siteHeader',true);show('setup',true);$('languageSelect').focus()});
// English UI for Kaan; Chinese UI for her. Keep both devices' preferences separate.
const interfacePairs=[
['只屬於我們的小世界','Our little world, just for us'],['進入我們的小世界 ♡','Enter our little world ♡'],
['不同的天空，相同的想念。','Different skies, the same longing.'],['這裡，是只屬於我們的小世界。','This is our little world.'],
['選擇我們的愛心 ♡','Choose your heart ♡'],['房間代碼','Room code'],['產生代碼','Generate code'],
['兩人使用同一組代碼。請勿公開分享。','Use the same room code. Keep it private.'],['進入房間','Enter room'],
['翻譯測試（不影響聊天）','Translation test (does not affect chat)'],['測試翻譯','Test translation'],
['離開房間','Leave room'],['🔔 開啟訊息通知','🔔 Enable notifications'],
['開啟通知後，網站仍在執行時可收到新訊息提醒。背景推播尚待啟用。','Notifications work while the site is open. Background push is not yet enabled.'],
['語音通話','Voice call'],['視訊通話','Video call'],['傳送第一則訊息給你的寶貝 ♡','Send your love the first message ♡'],
['傳送 ♡','Send ♡'],['對方的訊息會自動翻譯成你選擇的語言。聊天紀錄尚未雲端保存；重新整理後會消失。','Incoming messages are translated to your chosen language. Chat history is not saved in the cloud yet.'],
['寶貝正在呼叫你…','Your love is calling…'],['拒接','Decline'],['接聽','Answer'],['語音通話中','Voice call in progress'],
['雙方開啟「語音字幕」後，對話會顯示在這裡','Turn on captions on both phones to see your conversation here'],
['🎧 保留雙方原聲 · 僅顯示翻譯字幕','🎧 Original voices · Translated captions'],
['點「語音字幕」開始辨識','Tap Captions to start recognition'],['靜音','Mute'],['鏡頭','Camera'],['翻轉','Flip'],
['語音字幕','Captions'],['掛斷','Hang up'],['拍照','Photo'],['特效','Effects'],['儲存／分享照片','Save / Share photo'],
['關閉','Close'],['照片只在你的裝置上產生，不會自動傳送給對方。','Photos stay on your device unless you share them.'],
['送出','Send'],['我','Me'],['對方','Partner'],['翻譯中…','Translating…'],
['翻譯暫時無法使用','Translation temporarily unavailable']];
const interfaceOriginal=new WeakMap();
function applyInterfaceLanguage(){
  const english=lang==='en';document.documentElement.lang=english?'en':'zh-Hant';
  const lookup=new Map(interfacePairs);
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  let node;while((node=walker.nextNode())){
    if(node.parentElement?.closest('#chatlog,#callCaption,#testResult,#speechStatus,#callStatus,#status,#typingStatus,#notificationStatus,#setupNotice'))continue;
    const raw=interfaceOriginal.get(node)??node.nodeValue;const trimmed=raw.trim();
    if(!lookup.has(trimmed))continue;
    interfaceOriginal.set(node,raw);node.nodeValue=english?raw.replace(trimmed,lookup.get(trimmed)):raw;
  }
  const placeholders={room:['6–20 位英數字','6–20 letters or numbers'],message:['傳送訊息 · Message…','Type a message…'],callText:['傳送文字訊息…','Type a message…'],searchMessages:['搜尋目前聊天…','Search current messages…'],testPhrase:['輸入要測試的句子','Enter a phrase to test']};
  for(const [id,[zh,en]] of Object.entries(placeholders)){const el=$(id);if(el)el.placeholder=english?en:zh}
  const empty=$('callCaption')?.querySelector('.captionEmpty');if(empty)empty.textContent=english?'Turn on captions on both phones to see your conversation here':'雙方開啟「語音字幕」後，對話會顯示在這裡';
}
let selectedProfile=localStorage.getItem("olw-profile")==="kaan"?"kaan":"her";
function applyCoupleProfile(role){selectedProfile=role;localStorage.setItem("olw-profile",role);lang=localStorage.getItem('olw-lang-'+role)||(role==='kaan'?'en':'zh-TW');$('languageSelect').value=lang;document.querySelectorAll(".heartChoice").forEach(button=>{const active=button.dataset.profile===role;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active))});$("chatlog").dataset.wallpaper=role==="kaan"?"her":"kaan";applyInterfaceLanguage();updateCoupleClocks()}
document.querySelectorAll(".heartChoice").forEach(button=>button.addEventListener("click",()=>applyCoupleProfile(button.dataset.profile)));
applyCoupleProfile(selectedProfile);
// Time zones are IANA identifiers so Sweden's daylight saving time stays correct.
function updateCoupleClocks(){
  const english=lang==='en',locale=english?'en-GB':'zh-TW';
  for(const [prefix,zone] of [['taiwan','Asia/Taipei'],['sweden','Europe/Stockholm']]){
    const date=new Date();
    const clock=$(prefix+'Time'),day=$(prefix+'Date');
    if(!clock||!day)continue;
    clock.textContent=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
    clock.dateTime=date.toISOString();
    day.textContent=new Intl.DateTimeFormat(locale,{timeZone:zone,month:'short',day:'numeric',weekday:'short'}).format(date);
  }
  document.querySelectorAll('.clockName').forEach(el=>{el.textContent=el.dataset[english?'clockEn':'clockZh']});
}
updateCoupleClocks();setInterval(updateCoupleClocks,15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateCoupleClocks()});
const languages=['zh-TW','en','sv','sr','fr','es','ja','ko','de','tr'];
const other=()=>lang==='zh-TW'?'en':'zh-TW'; // Translation test only; incoming chat always targets the viewer's language.
const status=t=>$('status').textContent=t;
const callStatus=t=>$('callStatus').textContent=t;
async function resumeRemoteAudio(){
  const remote=$('remote');
  if(!calling||!remote.srcObject)return;
  try{await remote.play();show('resumeAudio',false)}
  catch{show('resumeAudio',true);callStatus('請點「播放對方聲音」啟用音訊')}
}
$('resumeAudio').onclick=resumeRemoteAudio;
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden&&calling&&$('remote').srcObject)resumeRemoteAudio();
});
const send=m=>{if(socket?.readyState!==WebSocket.OPEN)return false;socket.send(JSON.stringify(m));return true};
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

$('languageSelect').onchange=e=>{lang=e.target.value;localStorage.setItem('olw-lang-'+selectedProfile,lang);applyInterfaceLanguage();updateCoupleClocks()};
$('random').onclick=()=>{const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',nums=new Uint32Array(10);crypto.getRandomValues(nums);$('room').value=Array.from(nums,n=>chars[n%chars.length]).join('')};
function appendChat(who,text,translation){const log=$('chatlog');log.querySelector('.empty')?.remove();const p=document.createElement('div');p.className='bubble '+(who==='我'?'mine':'theirs');const title=document.createElement('small');title.textContent=who;p.append(title);const line=document.createElement('div');line.textContent=text;p.append(line);if(translation&&translation!==text){const sub=document.createElement('div');sub.className='translation';sub.textContent=translation;p.append(sub)}log.append(p);log.scrollTop=log.scrollHeight;filterChat();return p}
function filterChat(){const query=$('searchMessages').value.trim().toLocaleLowerCase();$('chatlog').querySelectorAll('.bubble').forEach(el=>{el.classList.toggle('hidden',Boolean(query)&&!el.textContent.toLocaleLowerCase().includes(query))})}
$('searchMessages').oninput=filterChat;
function sendTyping(){if(!joined)return;const now=Date.now();if(now-lastTypingSent>1600){send({type:'typing'});lastTypingSent=now}}
$('message').addEventListener('input',sendTyping);
$('callText').addEventListener('input',sendTyping);
async function translate(text,from,to){if(from===to)return text;const cacheKey=from+'|'+to+'|'+text; if(translationCache.has(cacheKey))return translationCache.get(cacheKey);const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);try{const r=await fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,from,to}),signal:controller.signal});const d=await r.json();if(!r.ok)throw Error(d.error||'翻譯服務暫時無法使用');if(typeof d.translation!=='string'||!d.translation.trim())throw Error('翻譯結果為空');translationCache.set(cacheKey,d.translation);if(translationCache.size>120)translationCache.delete(translationCache.keys().next().value);return d.translation}finally{clearTimeout(timeout)}}
const pendingMessages=new Map();
const receivedMessages=new Set();
function deliveryText(state){return lang==='en'?({pending:'Sending…',sent:'Sent · waiting for delivery',delivered:'Delivered ✓',failed:'Not delivered · tap to retry'})[state]:({pending:'傳送中…',sent:'已傳送 · 等待對方收到',delivered:'已送達 ✓',failed:'未送達 · 點此重試'})[state]}
function deliveryState(id,state){
  const item=pendingMessages.get(id);if(!item)return;
  clearTimeout(item.timer);item.state=state;
  item.indicator.textContent=deliveryText(state);
  item.indicator.disabled=state!=='failed';
  if(state==='delivered'){pendingMessages.delete(id);return}
  if(state==='sent')item.timer=setTimeout(()=>deliveryState(id,'failed'),12000);
}
function attemptDelivery(id){
  const item=pendingMessages.get(id);if(!item)return;
  if(!joined||!peerOnline||!send({type:'caption',id,text:item.text,lang:item.sourceLang})){deliveryState(id,'failed');return}
  deliveryState(id,'sent');
}
async function postText(text){
  text=text.trim();if(!text||!joined)return;
  const id=crypto.randomUUID();
  const bubble=appendChat('我',text);
  const indicator=document.createElement('button');indicator.type='button';indicator.className='deliveryStatus';bubble.append(indicator);
  pendingMessages.set(id,{text,sourceLang:lang,indicator,state:'pending',timer:null});
  indicator.onclick=()=>{if(pendingMessages.get(id)?.state==='failed')attemptDelivery(id)};
  deliveryState(id,'pending');attemptDelivery(id);
  const target=lang==='zh-TW'?'en':'zh-TW';
  const pendingTranslation=document.createElement('div');pendingTranslation.className='translation';pendingTranslation.textContent=lang==='en'?'Translating…':'翻譯中…';bubble.insertBefore(pendingTranslation,indicator);
  try{const translated=await translate(text,lang,target);pendingTranslation.textContent=translated||text}catch{pendingTranslation.textContent=lang==='en'?'Translation temporarily unavailable':'翻譯暫時無法使用'}
}
async function receiveText(m){
  if(m.id){
    if(receivedMessages.has(m.id)){send({type:'caption-received',id:m.id});return}
    receivedMessages.add(m.id);
    if(receivedMessages.size>300)receivedMessages.delete(receivedMessages.values().next().value);
  }
  const bubble=appendChat('寶貝',m.text);
  const targetLang=lang,sourceLang=m.lang;
  const pendingTranslation=document.createElement('div');
  pendingTranslation.className='translation';
  bubble.append(pendingTranslation);
  if(m.id)send({type:'caption-received',id:m.id});
  const supplied=(m.to===targetLang&&typeof m.translated==='string')?m.translated.trim():'';
  notifyIncoming('卡安 ❤️',supplied||m.text);
  async function renderTranslation(){
    pendingTranslation.textContent=targetLang==='en'?'Translating…':'翻譯中…';
    pendingTranslation.classList.remove('translationFailed');
    pendingTranslation.removeAttribute('role');
    if(sourceLang===targetLang){pendingTranslation.remove();return}
    try{
      const translated=supplied||await translate(m.text,sourceLang,targetLang);
      pendingTranslation.textContent=translated||m.text;
    }catch(e){
      pendingTranslation.classList.add('translationFailed');
      pendingTranslation.setAttribute('role','button');
      pendingTranslation.tabIndex=0;
      pendingTranslation.textContent=targetLang==='en'?'Translation failed · Tap to retry':'翻譯失敗 · 點此重試';
    }
  }
  pendingTranslation.onclick=()=>{if(pendingTranslation.classList.contains('translationFailed'))renderTranslation()};
  pendingTranslation.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&pendingTranslation.classList.contains('translationFailed')){e.preventDefault();renderTranslation()}};
  await renderTranslation();
}
// Bilingual caption feed: each participant transcribes their OWN microphone and
// shares the transcript. Never label the local microphone as remote speech.
let callCaptionEpoch=0;
const captionNodes=new Map();
function resetCallCaptions(){
  callCaptionEpoch++;captionNodes.clear();
  if(typeof previewVersion!=='undefined'){previewVersion.local++;previewVersion.remote++;}
  const feed=$('callCaption');feed.replaceChildren();
  const hint=document.createElement('p');hint.className='captionEmpty';
  hint.textContent='雙方開啟「語音字幕」後，對話會顯示在這裡';
  feed.append(hint);
}
function captionBubble(id,who,original,translated){
  const feed=$('callCaption');
  feed.querySelector('.captionEmpty')?.remove();
  let bubble=captionNodes.get(id);
  if(!bubble){
    bubble=document.createElement('div');bubble.className='captionBubble '+(who==='我'?'captionMine':'captionTheirs');
    const label=document.createElement('small');label.textContent=who;
    const source=document.createElement('div');source.className='captionOriginal';
    const translation=document.createElement('div');translation.className='captionTranslation';
    bubble.append(label,source,translation);feed.append(bubble);captionNodes.set(id,bubble);
    if(captionNodes.size>35){const oldest=captionNodes.keys().next().value;captionNodes.get(oldest)?.remove();captionNodes.delete(oldest)}
  }
  bubble.querySelector('.captionOriginal').textContent=original;
  const translationNode=bubble.querySelector('.captionTranslation');
  translationNode.textContent=translated||'';
  translationNode.classList.toggle('hidden',!translated);
  feed.scrollTop=feed.scrollHeight;
}
async function addSpeechCaption(text,sourceLang,who,id){
  if(!calling||!text.trim())return;
  const epoch=callCaptionEpoch;
  const target=who==='我'?(sourceLang==='zh-TW'?'en':'zh-TW'):lang;
  captionBubble(id,who,text,sourceLang===target?'':'翻譯中…');
  if(sourceLang===target)return;
  try{
    const translated=await translate(text,sourceLang,target);
    if(calling&&epoch===callCaptionEpoch&&captionNodes.has(id))captionBubble(id,who,text,translated);
  }catch{
    if(calling&&epoch===callCaptionEpoch&&captionNodes.has(id))captionBubble(id,who,text,'翻譯暫時無法使用');
  }
}
const previewVersion={local:0,remote:0};
function clearSpeechPreview(side){
  previewVersion[side]++;
  const id=side+'-preview';
  captionNodes.get(id)?.remove();
  captionNodes.delete(id);
}
async function updateSpeechPreview(side,text,sourceLang){
  if(!calling||!text.trim())return;
  const id=side+'-preview',who=side==='local'?'我':'對方';
  const target=side==='local'?(sourceLang==='zh-TW'?'en':'zh-TW'):lang;
  const epoch=callCaptionEpoch,version=++previewVersion[side];
  captionBubble(id,who,text+' …',sourceLang===target?'':'翻譯中…');
  if(sourceLang===target)return;
  // Speech recognition emits many interim revisions; debounce API calls to avoid
  // translating stale fragments and unnecessarily spending translation credits.
  await new Promise(resolve=>setTimeout(resolve,650));
  if(!calling||epoch!==callCaptionEpoch||version!==previewVersion[side]||!captionNodes.has(id))return;
  try{
    const translated=await translate(text,sourceLang,target);
    if(calling&&epoch===callCaptionEpoch&&version===previewVersion[side]&&captionNodes.has(id))
      captionBubble(id,who,text+' …',translated);
  }catch{
    if(calling&&epoch===callCaptionEpoch&&version===previewVersion[side]&&captionNodes.has(id))
      captionBubble(id,who,text+' …','翻譯暫時無法使用');
  }
}
function receiveSpeechCaption(m){
  if(!calling||typeof m.text!=='string')return;
  clearSpeechPreview('remote');
  addSpeechCaption(m.text.trim(),m.lang,'對方','remote-'+(++remoteCaptionSeq));
}
$('testTranslate').onclick=async()=>{const button=$('testTranslate');const phrase=$('testPhrase').value.trim();if(!phrase)return;$('testResult').textContent='正在翻譯…';button.disabled=true;try{const result=await translate(phrase,lang,$('testTargetSelect').value);$('testResult').textContent='翻譯：'+result}catch(e){$('testResult').textContent='測試失敗：'+(e.name==='AbortError'?'翻譯逾時':safeError(e))}finally{button.disabled=false}};
$('manual').onsubmit=e=>{e.preventDefault();postText($('message').value);$('message').value=''};
$('callSend').onclick=()=>{postText($('callText').value);$('callText').value=''};
$('callText').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('callSend').click()}};
$('join').onclick=()=>{const room=$('room').value.trim().toUpperCase();if(!/^[A-Z0-9]{6,20}$/.test(room)){ $('setupNotice').textContent='請輸入 6–20 位英數字房間代碼';return}currentRoom=room;$('setupNotice').textContent='';connect(room)};
let reconnectTimer=null,reconnectAttempt=0,manualDisconnect=false;
function connect(room,retry=false){
 if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null}
 if(!retry){manualDisconnect=false;reconnectAttempt=0}
 const previous=socket;
 const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);
 socket=ws;
 if(previous&&previous!==ws)previous.close();
 if(!retry){joined=false;peerOnline=false}
 ws.onopen=()=>{if(socket===ws)send({type:'join',room,device:deviceId})};
 ws.onmessage=e=>{if(socket!==ws)return;try{handle(JSON.parse(e.data))}catch(err){console.error(err)}};
 ws.onerror=()=>{if(socket===ws)status('網路連線失敗，正在嘗試重新連線…')};
 ws.onclose=()=>{
  if(socket!==ws||manualDisconnect)return;
  for(const id of pendingMessages.keys())deliveryState(id,'failed');
  const wasJoined=joined;joined=false;peerOnline=false;
  if(wasJoined){endCall(false);show('incomingCall',false)}
  const wait=Math.min(15000,1000*Math.pow(2,Math.min(reconnectAttempt++,4)));
  status('連線中斷，'+Math.ceil(wait/1000)+' 秒後自動重連…');
  reconnectTimer=setTimeout(()=>{reconnectTimer=null;if(!manualDisconnect&&currentRoom===room)connect(room,true)},wait);
 };
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!manualDisconnect&&currentRoom&&socket?.readyState===WebSocket.CLOSED){if(reconnectTimer)clearTimeout(reconnectTimer);reconnectTimer=null;connect(currentRoom,true)}});
async function handle(m){switch(m.type){
case 'joined':{const alreadyInside=!$('setup').classList.contains('hidden');joined=true;reconnectAttempt=0;peerOnline=m.count>1;show('setup',false);setNestView(alreadyInside?'nest':nestView);status(peerOnline?'♡ 房間已有其他裝置連線':'等待寶貝加入…');break;}
case 'peer-joined':peerOnline=m.count>1;status('♡ 房間已有其他裝置連線');break;
case 'peer-left':peerOnline=m.count>1;for(const id of pendingMessages.keys())deliveryState(id,'failed');status(peerOnline?'♡ 仍有其他裝置在線上':'其他裝置已離開房間');endCall(false);show('incomingCall',false);break;
case 'typing':$('typingStatus').textContent='對方正在輸入…';clearTimeout(typingClearTimer);typingClearTimer=setTimeout(()=>$('typingStatus').textContent='',2500);break;
case 'speech-status':if(calling){const partner=m.active?(lang==='en'?'Partner captions ready':'對方字幕已開啟'):(lang==='en'?'Partner captions are off. Ask them to tap Captions.':'對方字幕未開啟，請對方點「語音字幕」');$('speechStatus').textContent=partner;}break;
case 'caption-preview':if(calling&&typeof m.text==='string'&&languages.includes(m.lang))updateSpeechPreview('remote',m.text.trim().slice(0,300),m.lang);break;
case 'speech-caption':if(typeof m.text==='string'&&languages.includes(m.lang))receiveSpeechCaption(m);break;
case 'caption-received':if(typeof m.id==='string')deliveryState(m.id,'delivered');break;
case 'caption-undelivered':if(typeof m.id==='string')deliveryState(m.id,'failed');break;
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
async function setupCall(which){mode=which;calling=true;remoteReady=false;iceQueue=[];show('call',true);show('home',false);resetCallCaptions();$('filterSelect').value='soft';applyFilter();show('cameraExtras',which==='video');show('incomingCall',false);show('audioBackdrop',which==='audio');show('local',which==='video');$('camera').disabled=which==='audio';$('flip').disabled=which==='audio';callStatus('正在準備通話…');try{stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:which==='video'?{width:{ideal:640},height:{ideal:360},frameRate:{ideal:15,max:20},facingMode:'user'}:false});$('local').srcObject=stream;pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}],bundlePolicy:'max-bundle'});stream.getTracks().forEach(track=>{const sender=pc.addTrack(track,stream);if(track.kind==='video'){const params=sender.getParameters();if(params.encodings?.length){params.encodings[0].maxBitrate=450000;params.encodings[0].maxFramerate=15;sender.setParameters(params).catch(()=>{})}}});pc.ontrack=e=>{const remote=$('remote');remote.srcObject=e.streams[0];remote.autoplay=true;remote.playsInline=true;remote.muted=false;callStatus('♡ 通話中');resumeRemoteAudio();autoStartCallCaptions()};pc.onicecandidate=e=>{if(e.candidate)send({type:'ice',candidate:e.candidate})};pc.onconnectionstatechange=()=>{if(!pc)return;if(pc.connectionState==='connected'){callStatus('♡ 通話中');autoStartCallCaptions();}else if(pc.connectionState==='failed')callStatus('連線失敗，請掛斷後重新撥打');else if(pc.connectionState==='disconnected')callStatus('連線暫時中斷，正在等待網路恢復…')};connectionWatch=setInterval(async()=>{if(!pc||pc.connectionState!=='connected')return;try{const stats=await pc.getStats();let lost=0,received=0,rtt=null;stats.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='audio'){lost+=s.packetsLost||0;received+=s.packetsReceived||0}if(s.type==='candidate-pair'&&s.state==='succeeded'&&s.currentRoundTripTime!=null)rtt=s.currentRoundTripTime});if(received>30&&(lost/(lost+received)>.1||rtt>1))callStatus('網路品質不穩，建議切換 Wi-Fi／行動網路')}catch{}},7000);return true}catch(e){alert('無法使用相機或麥克風：'+safeError(e));endCall(false);return false}}
async function makeOffer(){if(!pc)return;await pc.setLocalDescription(await pc.createOffer());send({type:'offer',sdp:pc.localDescription})}
async function dial(which){if(!joined||!peerOnline){alert('請等寶貝進入同一個房間後再撥打');return}if(calling||mode)return;if(!await setupCall(which))return;callStatus('正在呼叫寶貝…');send({type:'call-invite',mode:which});callTimer=setTimeout(()=>{if(calling&&pc?.connectionState!=='connected'){alert('對方尚未接聽');endCall(true)}},45000)}
$('audioCall').onclick=()=>dial('audio');$('videoCall').onclick=()=>dial('video');
$('decline').onclick=()=>{send({type:'call-decline'});mode=null;show('incomingCall',false)};
$('accept').onclick=async()=>{const which=mode;if(!which)return;if(await setupCall(which)){callStatus('正在接聽…');send({type:'call-accept'})}else send({type:'call-decline'})};
function endCall(notify=true){show('resumeAudio',false);callCaptionEpoch++;remoteCaptionSeq++;clearInterval(connectionWatch);connectionWatch=null;clearTimeout(callTimer);clearTimeout(speechRestartTimer);clearTimeout(previewTimer);previewText='';clearSpeechPreview('local');clearSpeechPreview('remote');recognizing=false;$('speechStatus').textContent='點「語音字幕」開始辨識';try{recognition?.stop()}catch{}recognition=null;if(notify&&joined)send({type:'call-end'});pc?.close();pc=null;stream?.getTracks().forEach(t=>t.stop());stream=null;$('local').srcObject=null;$('remote').srcObject=null;calling=false;mode=null;remoteReady=false;iceQueue=[];closePhoto();show('call',false);show('incomingCall',false);show('home',joined&&nestView==='chat');$('mic').querySelector('small').textContent='語音字幕'}
$('hangup').onclick=()=>endCall(true);
$('leave').onclick=()=>{manualDisconnect=true;clearTimeout(reconnectTimer);reconnectTimer=null;currentRoom='';endCall(true);socket?.close();joined=false;peerOnline=false;show('home',false);show('littleNest',false);show('nestNav',false);show('setup',true)};
$('mute').onclick=()=>{const t=stream?.getAudioTracks()[0];if(!t)return;t.enabled=!t.enabled;$('mute').querySelector('small').textContent=t.enabled?'靜音':'取消靜音'};
$('camera').onclick=()=>{const t=stream?.getVideoTracks()[0];if(!t)return;t.enabled=!t.enabled;$('camera').querySelector('small').textContent=t.enabled?'關閉鏡頭':'開啟鏡頭'};
$('flip').onclick=async()=>{const old=stream?.getVideoTracks()[0];if(!old)return;try{const facing=old.getSettings().facingMode==='environment'?'user':'environment';const next=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing}},audio:false});const track=next.getVideoTracks()[0];const sender=pc?.getSenders().find(s=>s.track?.kind==='video');if(sender)await sender.replaceTrack(track);stream.removeTrack(old);old.stop();stream.addTrack(track);$('local').srcObject=stream}catch(e){alert('無法切換鏡頭：'+safeError(e))}};
function autoStartCallCaptions(){if(!calling||recognizing)return;const supported=window.SpeechRecognition||window.webkitSpeechRecognition;if(!supported){$('speechStatus').textContent='此瀏覽器不支援自動字幕，請使用支援語音辨識的瀏覽器';send({type:'speech-status',active:false});return}try{$('mic').click()}catch(e){$('speechStatus').textContent='無法自動啟動字幕，請點「語音字幕」';send({type:'speech-status',active:false})}}
function stopRecognition(){send({type:'speech-status',active:false});recognizing=false;clearTimeout(speechRestartTimer);clearTimeout(previewTimer);previewText='';clearSpeechPreview('local');try{recognition?.stop()}catch{}$('mic').querySelector('small').textContent='語音字幕';$('speechStatus').textContent='語音字幕已停止'}
$('mic').onclick=()=>{if(recognizing){stopRecognition();return}const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SpeechRecognition){$('speechStatus').textContent='此瀏覽器不支援語音辨識，可使用文字訊息';return}
recognition=new SpeechRecognition();recognition.lang=lang==='en'?'en-US':lang==='sr'?'sr-RS':lang;recognition.continuous=true;recognition.interimResults=true;
recognition.onresult=e=>{let interim='';for(let i=e.resultIndex;i<e.results.length;i++){const result=e.results[i];const text=result[0]?.transcript?.trim();if(!text)continue;if(result.isFinal){clearTimeout(previewTimer);previewText='';const now=Date.now();clearSpeechPreview('local');if(text!==lastSpeechText||now-lastSpeechAt>4000){lastSpeechText=text;lastSpeechAt=now;addSpeechCaption(text,lang,'我','local-'+now);send({type:'speech-caption',text,lang})}}else interim=text}if(interim){$('speechStatus').textContent='正在辨識你的語音…';previewText=interim;const now=Date.now();if(now-lastPreviewAt>1100){lastPreviewAt=now;updateSpeechPreview('local',interim,lang);send({type:'caption-preview',text:interim,lang})}else if(!previewTimer){previewTimer=setTimeout(()=>{previewTimer=null;if(recognizing&&calling&&previewText){lastPreviewAt=Date.now();updateSpeechPreview('local',previewText,lang);send({type:'caption-preview',text:previewText,lang})}},1100)}}else $('speechStatus').textContent='正在聆聽，停頓後傳送字幕'};
recognition.onend=()=>{if(recognizing&&calling){clearTimeout(speechRestartTimer);speechRestartTimer=setTimeout(()=>{if(recognizing&&calling){try{recognition.start()}catch(e){$('speechStatus').textContent='辨識暫停，請重新開啟'}}},500)}};
recognition.onerror=e=>{if(['not-allowed','service-not-allowed','audio-capture','language-not-supported'].includes(e.error)){stopRecognition();$('speechStatus').textContent='語音辨識不可用：'+e.error+'，請確認麥克風權限並點「語音字幕」';}else if(e.error!=='no-speech'){$('speechStatus').textContent='辨識暫停：'+e.error;send({type:'speech-status',active:false})}};
try{recognizing=true;recognition.start();send({type:'speech-status',active:true});$('mic').querySelector('small').textContent='停止字幕';$('speechStatus').textContent='正在聆聽，停頓後傳送字幕'}catch(e){stopRecognition();$('speechStatus').textContent='無法啟動辨識：'+safeError(e)+'，請手動點「語音字幕」'}};

const effects={none:'none',mono:'grayscale(1)',soft:'brightness(1.07) contrast(.94) saturate(1.06)',bright:'brightness(1.18) contrast(1.05)',vintage:'sepia(.45) contrast(.9) saturate(.75)'};
function applyFilter(){const effect=effects[$('filterSelect').value]||'none';$('local').style.filter=effect}
$('filterSelect').onchange=applyFilter;
function closePhoto(){show('photoPreview',false);if(photoURL)URL.revokeObjectURL(photoURL);photoURL=null;photoBlob=null;$('photoImage').removeAttribute('src')}
$('closePhoto').onclick=closePhoto;
$('snapshot').onclick=()=>{const video=$('local');if(!calling||mode!=='video'||!video.videoWidth){alert('請先開啟視訊，等待自己的畫面出現');return}try{const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const ctx=canvas.getContext('2d');if(!ctx)throw Error('無法使用拍照功能');ctx.filter=effects[$('filterSelect').value]||'none';ctx.drawImage(video,0,0,canvas.width,canvas.height);canvas.toBlob(blob=>{if(!blob){alert('照片建立失敗');return}closePhoto();photoBlob=blob;photoURL=URL.createObjectURL(blob);$('photoImage').src=photoURL;show('photoPreview',true)},'image/jpeg',.92)}catch(e){alert('拍照失敗：'+safeError(e))}};
$('savePhoto').onclick=async()=>{if(!photoBlob)return;const file=new File([photoBlob],'our-little-world-'+Date.now()+'.jpg',{type:'image/jpeg'});try{if(navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:'Our Little World'});return}}catch(e){if(e.name==='AbortError')return}const a=document.createElement('a');a.href=photoURL;a.download=file.name;document.body.append(a);a.click();a.remove();$('photoHint').textContent='如果 iPhone 沒有直接儲存，請長按照片選擇「儲存到照片」。'};
window.addEventListener('beforeunload',()=>{stream?.getTracks().forEach(t=>t.stop());socket?.close()});


/* 2.0 nest: no changes to the existing welcome screen, chat wallpaper or call engine. */
let nestView='nest';
function nestTranslate(){const en=lang==='en';const labels={nestTitle:['我們的小窩 ♡','Our Little Nest ♡'],nestTaiwanLabel:['台灣','Taiwan'],nestSwedenLabel:['瑞典','Sweden'],nestAnniversaryLabel:['OUR STORY · 我們的紀念日','OUR STORY · Anniversary'],nestDateLabel:['選擇紀念日','Choose your anniversary'],nestDateHint:['目前只儲存在這支手機，尚未與另一半同步','Saved on this device only; not yet shared with your partner'],nestChatLabel:['進入聊天','Open chat'],nestCallLabel:['語音通話','Voice call'],nestNavHome:['小窩','Nest'],nestNavChat:['聊天','Chat'],nestNavCall:['通話','Call']};for(const [id,pair] of Object.entries(labels)){const el=$(id);if(el)el.textContent=pair[en?1:0]}}
function nestClockUpdate(){const locale=lang==='en'?'en-GB':'zh-TW',now=new Date();for(const [key,zone] of [['Taiwan','Asia/Taipei'],['Sweden','Europe/Stockholm']]){$('nest'+key+'Time').textContent=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hour12:false}).format(now);$('nest'+key+'Date').textContent=new Intl.DateTimeFormat(locale,{timeZone:zone,month:'short',day:'numeric',weekday:'short'}).format(now)}}
function nestDaysUpdate(){const raw=$('nestDate').value;if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)){$('nestDays').textContent='♡ Day —';return}const start=new Date(raw+'T12:00:00');if(Number.isNaN(start.getTime()))return;const today=new Date();const days=Math.floor((Date.UTC(today.getFullYear(),today.getMonth(),today.getDate())-Date.UTC(start.getFullYear(),start.getMonth(),start.getDate()))/86400000)+1;$('nestDays').textContent=days>=1?'♡ Day '+days:(lang==='en'?'In '+(1-days)+' days':'還有 '+(1-days)+' 天')}
function setNestView(view){if(!joined)return;nestView=view;show('littleNest',view==='nest');show('home',view==='chat');show('nestNav',true);for(const [id,v] of [['nestTabHome','nest'],['nestTabChat','chat'],['nestTabCall','chat']])$(id).classList.toggle('active',v===view&&(id!=='nestTabCall'));nestTranslate();nestClockUpdate();nestDaysUpdate()}
$('nestTabHome').onclick=()=>setNestView('nest');
$('nestTabChat').onclick=()=>setNestView('chat');
$('nestTabCall').onclick=()=>{setNestView('chat');$('audioCall').click()};
$('nestLeave').onclick=()=>$('leave').click();
$('nestToChat').onclick=()=>setNestView('chat');
$('nestToCall').onclick=()=>{setNestView('chat');$('audioCall').click()};
$('nestDate').value=localStorage.getItem('olw-nest-anniversary')||'';
$('nestDate').addEventListener('change',()=>{localStorage.setItem('olw-nest-anniversary',$('nestDate').value);nestDaysUpdate()});
setInterval(()=>{nestClockUpdate();nestDaysUpdate()},30000);nestClockUpdate();nestDaysUpdate();
