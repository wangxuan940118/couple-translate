const $=id=>document.getElementById(id);
const translationCache=new Map();
let connectionWatch=null,remoteCaptionSeq=0,captionAbort=null,lastSpeechText='',lastSpeechAt=0;
let typingTimer=null,typingClearTimer=null,lastTypingSent=0;
let lastPreviewAt=0,previewTimer=null,previewText='',previewSequence=0;
let lang=localStorage.getItem('olw-profile')==='kaan'?'en':'zh-TW',socket=null,pc=null,stream=null,recognition=null,recognizing=false,joined=false,peerOnline=false,mode=null,calling=false,remoteReady=false,iceQueue=[],currentRoom='',callTimer=null,speechRestartTimer=null,captionSequence=0,photoBlob=null,photoURL=null;
const show=(id,on)=>$(id).classList.toggle('hidden',!on);
// The cover is deliberately shown on every fresh visit; no automatic skip.
$('coverNext').addEventListener('click',onCoverEntry);
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
  const placeholders={room:['私人邀請連結或房間 ID','Private invitation link or room ID'],message:['傳送訊息 · Message…','Type a message…'],callText:['傳送文字訊息…','Type a message…'],searchMessages:['搜尋目前聊天…','Search current messages…'],testPhrase:['輸入要測試的句子','Enter a phrase to test']};
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
const callSignalTypes=new Set(['call-invite','call-accept','call-decline','call-end','offer','answer','ice','speech-caption','speech-interim','caption-preview','speech-status','call-busy','call-unavailable','call-cancelled']);
const send=m=>{if(socket?.readyState!==WebSocket.OPEN)return false;if(callSignalTypes.has(m.type)){const id=m.callId||activeCallId;if(!id)return false;m={...m,callId:id}}socket.send(JSON.stringify(m));return true};
const safeError=e=>e?.message||String(e);
// Push requires a Home Screen installation on iOS and server VAPID configuration.
const deviceId=(()=>{let id=localStorage.getItem('olw-device');if(!id){id=crypto.randomUUID();localStorage.setItem('olw-device',id)}return id})();
const notifyStatus=message=>{const el=$('notificationStatus');if(el)el.textContent=message};
function notifyIncoming(title,body){if(!('Notification'in window)||Notification.permission!=='granted'||!document.hidden)return;try{const n=new Notification(title,{body,tag:'our-little-world-message'});n.onclick=()=>{window.focus();n.close()}}catch(e){console.warn('Notification unavailable',e)}}
function urlBase64ToUint8Array(base64){const padded=base64+'='.repeat((4-base64.length%4)%4);const raw=atob(padded.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0))}
async function subscribePush(){
 if(!joined||!currentRoom||!validSession()){notifyStatus('請先進入私人房間，再開啟通知。');return}
 if(!('Notification'in window)||!('serviceWorker'in navigator)||!('PushManager'in window)){notifyStatus('此裝置或瀏覽器不支援推播。iPhone 請先用 Safari 加入主畫面，再從桌面開啟。');return}
 const epoch=authGeneration,room=currentRoom,uid=currentUser.id;
 const current=()=>epoch===authGeneration&&room===currentRoom&&currentUser?.id===uid&&validSession();
 try{
  const permission=await Notification.requestPermission();if(!current())return;if(permission!=='granted'){notifyStatus('尚未允許通知。');return}
  const token=await privateAccessToken(epoch,uid);if(!current())return;
  const response=await fetch('/api/push/key',{headers:{Authorization:'Bearer '+token},cache:'no-store'});if(!current())return;
  if(!response.ok)throw Object.assign(Error('無法取得推播設定'),{status:response.status});const config=await response.json();if(!current())return;
  if(!config.enabled){notifyStatus('通知介面已準備好，但伺服器推播金鑰尚未設定。');return}
  const registration=await navigator.serviceWorker.ready;if(!current())return;let subscription=await registration.pushManager.getSubscription();if(!current())return;
  if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(config.publicKey)});if(!current())return;
  const currentToken=await privateAccessToken(epoch,uid);if(!current())return;
  const result=await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+currentToken},body:JSON.stringify({room,device:deviceId,subscription:subscription.toJSON()})});if(!current())return;
  if(!result.ok)throw Object.assign(Error('無法儲存通知訂閱'),{status:result.status});notifyStatus('通知已啟用。提醒：伺服器重啟後需要重新訂閱，正式持久化仍在開發中。');
 }catch(e){if(!current())return;if([401,403].includes(e.status)){await requireSignIn('推播登入驗證失敗，請重新登入');return}notifyStatus('推播設定失敗：'+safeError(e))}
}
$('enableNotifications').onclick=subscribePush;
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(e=>console.warn('Service worker registration failed',e));

$('languageSelect').onchange=e=>{lang=e.target.value;localStorage.setItem('olw-lang-'+selectedProfile,lang);applyInterfaceLanguage();updateCoupleClocks();if(calling){stopRecognition('',false);startSpeechCaptions()}};

function appendChat(who,text,translation){const log=$('chatlog');log.querySelector('.empty')?.remove();const p=document.createElement('div');p.className='bubble '+(who==='我'?'mine':'theirs');const title=document.createElement('small');title.textContent=who;p.append(title);const line=document.createElement('div');line.textContent=text;p.append(line);if(translation&&translation!==text){const sub=document.createElement('div');sub.className='translation';sub.textContent=translation;p.append(sub)}log.append(p);log.scrollTop=log.scrollHeight;filterChat();return p}
function filterChat(){const query=$('searchMessages').value.trim().toLocaleLowerCase();$('chatlog').querySelectorAll('.bubble').forEach(el=>{el.classList.toggle('hidden',Boolean(query)&&!el.textContent.toLocaleLowerCase().includes(query))})}
$('searchMessages').oninput=filterChat;
function sendTyping(){if(!joined)return;const now=Date.now();if(now-lastTypingSent>1600){send({type:'typing'});lastTypingSent=now}}
$('message').addEventListener('input',sendTyping);
$('callText').addEventListener('input',sendTyping);
async function translate(text,from,to,options={}){
 if(from===to)return text;if(!validSession())throw Error('請先以 Email 驗證登入');
 const epoch=authGeneration,uid=currentUser.id,cacheKey=uid+'|'+from+'|'+to+'|'+text;if(translationCache.has(cacheKey))return translationCache.get(cacheKey);
 const controller=new AbortController();translationControllers.add(controller);const externalAbort=()=>controller.abort();if(options.signal?.aborted)controller.abort();else options.signal?.addEventListener('abort',externalAbort,{once:true});const timeout=setTimeout(()=>controller.abort(),options.timeoutMs||12000);
 try{
  const token=await privateAccessToken(epoch,uid);if(controller.signal.aborted)throw Object.assign(Error('翻譯已取消'),{name:'AbortError'});
  const r=await fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({text,from,to}),signal:controller.signal});const d=await r.json();
  if(epoch!==authGeneration||currentUser?.id!==uid||!validSession())throw Error('登入狀態已變更');
  if(!r.ok)throw Object.assign(Error(d.error||'翻譯服務暫時無法使用'),{status:r.status});if(typeof d.translation!=='string'||!d.translation.trim())throw Error('翻譯結果為空');
  translationCache.set(cacheKey,d.translation);if(translationCache.size>120)translationCache.delete(translationCache.keys().next().value);return d.translation;
 }finally{clearTimeout(timeout);translationControllers.delete(controller);options.signal?.removeEventListener('abort',externalAbort)}
}
const pendingMessages=new Map(),receivedMessages=new Set(),messageNodes=new Map(),messageRecords=new Map();
let historyAbort=null,historyLoading=false,nextHistoryCursor=null,historyRoom=null;
let translationJobs=[],activeTranslations=0;
const historyClient=WorldHistory.createClient({getAccessToken:()=>privateAccessToken()});
function deliveryText(state){return lang==='en'?({queued:'Waiting for connection',saving:'Waiting for server save…',saved:'Saved · waiting for partner',delivered:'Saved · delivered ✓',failed:'Not saved · tap to retry'})[state]:({queued:'等待連線後保存',saving:'等待伺服器確認保存…',saved:'已保存 · 等待對方收到',delivered:'已保存 · 已送達 ✓',failed:'尚未確認保存 · 點此重試'})[state]}
function deliveryState(id,state){
 const item=pendingMessages.get(id);if(!item)return;clearTimeout(item.timer);
 if(state==='delivered'){item.delivered=true;if(!item.saved)return}
 item.state=state;item.indicator.textContent=deliveryText(state);item.indicator.disabled=!['failed','queued'].includes(state);
 if(state==='saving')item.timer=setTimeout(()=>{if(!item.saved)deliveryState(id,'failed')},12000);
 if(state==='delivered'&&item.saved)pendingMessages.delete(id);
}
function outboxKey(){return currentUser&&currentRoom?'olw-outbox:'+currentUser.id+':'+currentRoom:null}
function saveOutbox(){const key=outboxKey();if(!key)return;try{const rows=[...pendingMessages].filter(([,x])=>!x.saved&&x.userId===currentUser.id&&x.roomId===currentRoom).map(([id,x])=>({id,text:x.text,lang:x.sourceLang,createdAt:x.createdAt}));if(rows.length)localStorage.setItem(key,JSON.stringify(rows));else localStorage.removeItem(key)}catch{status('待傳訊息仍在本頁，裝置儲存空間不足；請勿關閉頁面')}}
function sortMessages(){const log=$('chatlog');for(const record of [...messageRecords.values()].sort(WorldHistory.order)){const node=messageNodes.get(record.id);if(node)log.append(node)}}
function pumpTranslations(){
 while(activeTranslations<2&&translationJobs.length){const job=translationJobs.shift();if(job.epoch!==authGeneration||job.room!==currentRoom)continue;activeTranslations++;
  translate(job.record.text,job.record.lang,job.target).then(text=>{if(job.epoch===authGeneration&&job.room===currentRoom&&messageNodes.get(job.record.id)===job.bubble)job.node.textContent=text}).catch(()=>{if(job.epoch!==authGeneration||job.room!==currentRoom)return;job.node.textContent=lang==='en'?'Translation failed · tap to retry':'翻譯失敗 · 點此重試';job.node.classList.add('translationFailed');job.node.setAttribute('role','button');job.node.tabIndex=0;const retry=()=>{job.node.classList.remove('translationFailed');job.node.removeAttribute('role');job.node.textContent='翻譯中…';translationJobs.push(job);pumpTranslations()};job.node.onclick=retry;job.node.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();retry()}}}).finally(()=>{activeTranslations--;pumpTranslations()});
 }
}
function renderMessage(raw){
 const record=WorldHistory.message(raw);if(!record||!currentUser||record.roomId!==currentRoom||!record.authorId)return null;
 if(messageNodes.has(record.id)){messageRecords.set(record.id,record);return messageNodes.get(record.id)}
 const mine=record.authorId===currentUser.id;const bubble=appendChat(mine?'我':'寶貝',record.deletedAt?'（訊息已移除）':record.text);bubble.dataset.messageId=record.id;messageNodes.set(record.id,bubble);messageRecords.set(record.id,record);
 if(!record.lang&&!record.deletedAt){const note=document.createElement('div');note.className='translationUnspecified';note.textContent=lang==='en'?'Original · language not specified':'原文 · 未標註語言';bubble.append(note)}
 else if(!mine&&!record.deletedAt&&languages.includes(record.lang)&&record.lang!==lang){const node=document.createElement('div');node.className='translation';node.textContent=lang==='en'?'Waiting for translation…':'等待翻譯…';bubble.append(node);translationJobs.push({record,node,bubble,target:lang,epoch:authGeneration,room:currentRoom});pumpTranslations()}
 sortMessages();return bubble;
}
function addPending(row){
 if(pendingMessages.has(row.id))return;const bubble=renderMessage({id:row.id,text:row.text,lang:row.lang,createdAt:row.createdAt,roomId:currentRoom,authorId:currentUser.id});if(!bubble)return;
 const indicator=document.createElement('button');indicator.type='button';indicator.className='deliveryStatus';bubble.append(indicator);
 const item={text:row.text,sourceLang:row.lang,createdAt:row.createdAt,indicator,userId:currentUser.id,roomId:currentRoom,saved:false,delivered:false,timer:null};pendingMessages.set(row.id,item);indicator.onclick=()=>attemptDelivery(row.id);deliveryState(row.id,'queued');
}
function restoreOutbox(){const key=outboxKey();if(!key)return;try{const rows=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(rows))for(const row of rows.slice(0,100)){if(WorldHistory.isRoomId(row.id)&&typeof row.text==='string'&&languages.includes(row.lang))addPending(row)}}catch{}for(const [id,item]of pendingMessages)if(!item.saved)attemptDelivery(id)}
function attemptDelivery(id){
 const item=pendingMessages.get(id);if(!item||item.saved||!currentUser||item.userId!==currentUser.id||item.roomId!==currentRoom)return;
 if(!joined||!send({type:'caption',id,text:item.text,lang:item.sourceLang})){deliveryState(id,'queued');return}deliveryState(id,'saving');
}
async function postText(text){
 text=text.trim();if(!text||!validSession()||!currentRoom)return false;if([...pendingMessages.values()].filter(x=>!x.saved).length>=100){status('待傳訊息已達上限，請先連線保存');return false}
 const row={id:crypto.randomUUID(),text,lang,createdAt:new Date().toISOString()};addPending(row);saveOutbox();attemptDelivery(row.id);return true;
}
function acknowledgeSaved(m){
 const record=WorldHistory.message(m.message||m);if(!record||record.roomId!==currentRoom||record.authorId!==currentUser?.id)return;
 const item=pendingMessages.get(record.id);renderMessage(record);sortMessages();if(item){item.saved=true;deliveryState(record.id,item.delivered?'delivered':'saved');saveOutbox()}
}
function receiveText(m){
 const record=WorldHistory.message(m);if(!record||record.roomId!==currentRoom)return;const existed=messageNodes.has(record.id);renderMessage(record);
 if(record.authorId!==currentUser?.id){send({type:'caption-received',id:record.id});if(!existed)notifyIncoming('Our Little World',record.text)}
}
async function loadHistory(older=false){
 if(!currentUser||!currentRoom||historyLoading||older&&!nextHistoryCursor)return;const epoch=authGeneration,room=currentRoom,userId=currentUser.id;historyLoading=true;const abort=new AbortController();historyAbort=abort;
 const log=$('chatlog'),top=log.scrollTop,height=log.scrollHeight;$('loadOlderMessages').disabled=true;
 try{const data=await historyClient.messages(room,older?nextHistoryCursor:null,abort.signal);if(epoch!==authGeneration||currentUser?.id!==userId||currentRoom!==room)return;const rows=Array.isArray(data.messages)?data.messages:[];for(const row of rows)renderMessage({...row,roomId:row.roomId||row.room_id||room});nextHistoryCursor=data.nextCursor||null;historyRoom=room;show('loadOlderMessages',Boolean(nextHistoryCursor));sortMessages();log.scrollTop=older?top+(log.scrollHeight-height):log.scrollHeight}
 catch(e){if(epoch===authGeneration&&e.name!=='AbortError')status('歷史紀錄暫時無法載入，通話仍可使用；請稍後重試')}
 finally{if(epoch===authGeneration&&currentRoom===room){historyLoading=false;$('loadOlderMessages').disabled=false}}
}
$('loadOlderMessages').onclick=()=>loadHistory(true);

// Bilingual caption feed: each participant transcribes their OWN microphone and
// shares the transcript. Never label the local microphone as remote speech.
let callCaptionEpoch=0;
const receivedSpeechIds=new Map();
const captionTranslationQueue=new Map(),captionActiveRequests=new Map();
let captionTranslationRunning=0;
const captionNodes=new Map();
function resetCallCaptions(){
  callCaptionEpoch++;cancelCaptionTranslations();captionNodes.clear();receivedSpeechIds.clear();
  resetSpeechLifecycle();
  if($('speechPeerStatus'))$('speechPeerStatus').textContent=lang==='en'?'Waiting for partner captions…':'等待對方啟動字幕…';
  if(typeof previewVersion!=='undefined'){previewVersion.local++;previewVersion.remote++;}
  const feed=$('callCaption');feed.replaceChildren();
  const hint=document.createElement('p');hint.className='captionEmpty';
  hint.textContent='雙方開啟「語音字幕」後，對話會顯示在這裡';
  feed.append(hint);
}
function captionBubble(id,who,original,translated,state='success'){
  const feed=$('callCaption');feed.querySelector('.captionEmpty')?.remove();
  let bubble=captionNodes.get(id);
  if(!bubble){
    bubble=document.createElement('div');bubble.className='captionBubble '+(who==='我'?'captionMine':'captionTheirs');
    const label=document.createElement('small');label.textContent=who==='我'?(lang==='en'?'Me':'我'):(lang==='en'?'Partner':'對方');
    const source=document.createElement('div');source.className='captionOriginal';source.dataset.label=lang==='en'?'Original · 原文':'原文 · Original';
    const translation=document.createElement('div');translation.className='captionTranslation';translation.dataset.label=lang==='en'?'Translation · 翻譯':'翻譯 · Translation';
    bubble.append(label,source,translation);feed.append(bubble);captionNodes.set(id,bubble);
    if(captionNodes.size>35){const oldest=captionNodes.keys().next().value;captionNodes.get(oldest)?.remove();captionNodes.delete(oldest);captionTranslationQueue.delete(oldest);captionActiveRequests.get(oldest)?.abort()}
  }
  bubble.querySelector('.captionOriginal').textContent=original;
  const translationNode=bubble.querySelector('.captionTranslation');translationNode.textContent=translated||'';translationNode.dataset.state=state;
  translationNode.classList.toggle('hidden',!translated);feed.scrollTop=feed.scrollHeight;
  return bubble;
}
function cancelCaptionTranslations(){
  captionTranslationQueue.clear();for(const controller of captionActiveRequests.values())controller.abort();
}
function queueCaptionTranslation(id,text,sourceLang,final=true){
  if(!calling||!captionNodes.has(id)||sourceLang===lang)return;
  const job={id,text,sourceLang,target:lang,epoch:callCaptionEpoch,version:Symbol(),final};
  captionNodes.get(id).captionVersion=job.version;captionTranslationQueue.set(id,job);
  // Keep the queue bounded during provider outages. Older originals remain visible.
  if(captionTranslationQueue.size>18){const oldest=captionTranslationQueue.keys().next().value,skipped=captionTranslationQueue.get(oldest);captionTranslationQueue.delete(oldest);if(captionNodes.has(oldest))captionBubble(oldest,'對方',skipped.text,lang==='en'?'Translation delayed · original kept':'翻譯延遲，原文已保留','error')}
  pumpCaptionTranslations();
}
function pumpCaptionTranslations(){
  while(captionTranslationRunning<2){
    const available=[...captionTranslationQueue.values()].filter(job=>!captionActiveRequests.has(job.id));
    const job=available.find(item=>item.final)||available[0];if(!job)return;
    captionTranslationQueue.delete(job.id);
    if(!calling||job.epoch!==callCaptionEpoch||!captionNodes.has(job.id))continue;
    const controller=new AbortController();captionActiveRequests.set(job.id,controller);captionTranslationRunning++;
    const current=()=>calling&&job.epoch===callCaptionEpoch&&job.target===lang&&captionNodes.get(job.id)?.captionVersion===job.version;
    translate(job.text,job.sourceLang,job.target,{signal:controller.signal,timeoutMs:8000}).then(translated=>{
      if(current())captionBubble(job.id,'對方',job.text,translated,'success');
    }).catch(error=>{
      if(!current()||controller.signal.aborted)return;
      const message=error.name==='AbortError'?(lang==='en'?'Translation timed out · call continues':'翻譯逾時，通話仍會繼續'):(lang==='en'?'Translation unavailable · tap to retry':'翻譯暫時無法使用，點此重試');
      const bubble=captionBubble(job.id,'對方',job.text,message,'error');const line=bubble.querySelector('.captionTranslation');
      line.setAttribute('role','button');line.tabIndex=0;const retry=()=>{if(line.dataset.state!=='error'||!calling)return;line.dataset.state='pending';line.textContent=lang==='en'?'Translating…':'翻譯中…';queueCaptionTranslation(job.id,job.text,job.sourceLang,true)};
      line.onclick=retry;line.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();retry()}};
    }).finally(()=>{if(captionActiveRequests.get(job.id)===controller)captionActiveRequests.delete(job.id);captionTranslationRunning--;pumpCaptionTranslations()});
  }
}
function addSpeechCaption(text,sourceLang,who,id){
  if(!calling||!text.trim())return;
  // Only the listener translates the OTHER microphone. Local speech stays original.
  const remote=who!=='我',needsTranslation=remote&&sourceLang!==lang;
  captionBubble(id,who,text,needsTranslation?(lang==='en'?'Translating…':'翻譯中…'):'',needsTranslation?'pending':'untranslated');
  if(needsTranslation)queueCaptionTranslation(id,text,sourceLang,true);
}
const previewVersion={local:0,remote:0};
function clearSpeechPreview(side){previewVersion[side]++;}
function updateSpeechPreview(side,text,sourceLang,id=side+'-preview'){
  if(!calling||!text.trim())return;
  const who=side==='local'?'我':'對方',needsTranslation=side==='remote'&&sourceLang!==lang;
  const bubble=captionBubble(id,who,text,needsTranslation?(lang==='en'?'Translating…':'翻譯中…'):'',needsTranslation?'pending':'untranslated');
  bubble.captionVersion=Symbol();captionTranslationQueue.delete(id);
  if(!needsTranslation)return;
  const epoch=callCaptionEpoch,version=++previewVersion[side];
  setTimeout(()=>{if(calling&&epoch===callCaptionEpoch&&version===previewVersion[side]&&captionNodes.has(id))queueCaptionTranslation(id,text,sourceLang,false)},900);
}
function validSpeechPacket(message){
  return calling&&typeof message.text==='string'&&languages.includes(message.lang)&&message.device!==deviceId&&
    (activeCallId?message.callId===activeCallId:!message.callId);
}
function receiveSpeechCaption(message,final=true){
  if(!validSpeechPacket(message))return;
  const stableId=typeof message.id==='string'&&/^[a-zA-Z0-9-]{8,80}$/.test(message.id)?message.id:null;
  const id=stableId?'remote-'+stableId:(final?'remote-'+(++remoteCaptionSeq):'remote-preview');
  const revision=Number.isSafeInteger(message.revision)?message.revision:0;
  const previous=receivedSpeechIds.get(id);
  if(previous&&(revision<previous.revision||(revision===previous.revision&&(!final||previous.final))))return;
  if(previous?.final&&!final)return;
  receivedSpeechIds.set(id,{revision,final});if(receivedSpeechIds.size>120)receivedSpeechIds.delete(receivedSpeechIds.keys().next().value);
  if(final){clearSpeechPreview('remote');addSpeechCaption(message.text.trim(),message.lang,'對方',id)}
  else updateSpeechPreview('remote',message.text.trim().slice(0,300),message.lang,id);
}
$('testTranslate').onclick=async()=>{const button=$('testTranslate');const phrase=$('testPhrase').value.trim();if(!phrase)return;$('testResult').textContent='正在翻譯…';button.disabled=true;try{const result=await translate(phrase,lang,$('testTargetSelect').value);$('testResult').textContent='翻譯：'+result}catch(e){$('testResult').textContent='測試失敗：'+(e.name==='AbortError'?'翻譯逾時':safeError(e))}finally{button.disabled=false}};
$('manual').onsubmit=async e=>{e.preventDefault();const text=$('message').value;if(await postText(text)&&$('message').value===text)$('message').value=''};
$('callSend').onclick=async()=>{const text=$('callText').value;if(await postText(text)&&$('callText').value===text)$('callText').value=''};
$('callText').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('callSend').click()}};
let reconnectTimer=null,reconnectAttempt=0,manualDisconnect=false,authGeneration=0,currentUser=null,lastAccessToken='',coverEntered=false,restoreBusy=null,privateInvite='';
let activeCallId=null,callGeneration=0,callInitiator=false;
const translationControllers=new Set();
function validSession(){return Boolean(currentUser&&WorldAuth.user()?.id===currentUser.id)}
async function privateAccessToken(epoch=authGeneration,uid=currentUser?.id){
 if(!uid||!validSession())throw Object.assign(Error('請先以 Email 驗證登入'),{status:401});
 const token=await WorldAuth.accessToken();
 if(epoch!==authGeneration||currentUser?.id!==uid||WorldAuth.user()?.id!==uid)throw Object.assign(Error('登入狀態已變更，操作已取消'),{name:'AbortError'});
 if(typeof token!=='string'||token.length<20||token.length>8192||/\s/.test(token))throw Object.assign(Error('登入已失效，請重新驗證'),{status:401});return token;
}
async function requireSignIn(text){
 const uid=currentUser?.id;disconnectPrivate(true);currentUser=null;lastAccessToken='';
 if(coverEntered){show('emailAuth',true);show('setup',false)}status(text);$('emailAuthNotice').textContent=text;
 // Disconnect first, so late HTTP/WS/media results cannot revive the old session.
 if(uid)try{await WorldAuth.signOut()}catch{}
}
async function refreshConnectionAuth(epoch,uid){
 try{const token=await privateAccessToken(epoch,uid);if(epoch!==authGeneration||currentUser?.id!==uid)return;
  if(joined&&socket?.readyState===WebSocket.OPEN){if(token!==lastAccessToken)send({type:'auth-refresh',accessToken:token});lastAccessToken=token;}
 }catch(e){if(epoch===authGeneration&&currentUser?.id===uid&&[401,403].includes(e.status))void requireSignIn('登入驗證失敗，請重新登入')}
}
function roomIdOf(room){return room?.id||room?.roomId||room?.room_id}
function rememberRoom(){if(currentUser&&currentRoom)localStorage.setItem('olw-last-room:'+currentUser.id,currentRoom)}
function clearRoomState(forgetOutbox=false){
 if(forgetOutbox&&outboxKey())try{localStorage.removeItem(outboxKey())}catch{}
 historyAbort?.abort();historyAbort=null;historyLoading=false;nextHistoryCursor=null;historyRoom=null;translationJobs=[];for(const controller of translationControllers)controller.abort();translationCache.clear();
 for(const item of pendingMessages.values())clearTimeout(item.timer);pendingMessages.clear();receivedMessages.clear();messageNodes.clear();messageRecords.clear();$('chatlog').replaceChildren();$('typingStatus').textContent='';show('loadOlderMessages',false);
}
function disconnectPrivate(forgetOutbox=false){
 manualDisconnect=true;restoreBusy=null;clearTimeout(reconnectTimer);reconnectTimer=null;authGeneration++;endCall(false);const old=socket;socket=null;old?.close();clearRoomState(forgetOutbox);joined=false;peerOnline=false;currentRoom='';privateInvite='';show('copyPrivateInvite',false);show('home',false);show('littleNest',false);show('nestNav',false);
}
async function onCoverEntry(){
 coverEntered=true;show('cover',false);show('siteHeader',true);await WorldAuth.ready();if(validSession()){show('emailAuth',false);show('setup',true);await restoreMembership()}else{show('setup',false);show('emailAuth',true)}
}
async function restoreMembership(){
 if(!validSession()||!coverEntered||restoreBusy===authGeneration)return;restoreBusy=authGeneration;const epoch=authGeneration,uid=currentUser.id;
 try{const data=await historyClient.rooms();if(epoch!==authGeneration||currentUser?.id!==uid)return;const rooms=Array.isArray(data.rooms)?data.rooms:[];const incoming=WorldHistory.parseRoom(location.href);
  if(incoming?.token){const result=await historyClient.redeemInvite(incoming.token);if(epoch!==authGeneration||currentUser?.id!==uid)return;const id=roomIdOf(result.room||result);if(id){await enterPrivateRoom(id);return}}
  const saved=localStorage.getItem('olw-last-room:'+uid);const room=rooms.find(r=>roomIdOf(r)===saved)||rooms[0];if(room)await enterPrivateRoom(roomIdOf(room));
 }catch(e){if(epoch===authGeneration)$('setupNotice').textContent=e.message}finally{if(restoreBusy===epoch)restoreBusy=null}
}
async function enterPrivateRoom(id){
 if(!validSession()||!WorldHistory.isRoomId(id))return;if(currentRoom!==id){endCall(false);clearRoomState();authGeneration++;currentRoom=id}rememberRoom();$('room').value=id;$('setupNotice').textContent='';connect(id);
}
$('random').onclick=async()=>{
 if(!validSession()){$('setupNotice').textContent='請先以 Email 驗證登入';return}const epoch=authGeneration;$('random').disabled=true;
 try{const data=await historyClient.createRoom();if(epoch!==authGeneration||!validSession())return;const id=roomIdOf(data.room||data);if(!WorldHistory.isRoomId(id))throw Error('伺服器未回傳私人房間');const token=data.inviteToken||data.invite?.token;if(/^[a-f0-9]{64}$/i.test(token||'')){privateInvite=location.origin+location.pathname+'#invite='+token;show('copyPrivateInvite',true);$('privateRoomInfo').textContent='私人房間已建立。請私下分享邀請連結給另一位使用者。'}await enterPrivateRoom(id)}catch(e){$('setupNotice').textContent=e.message}finally{$('random').disabled=false}
};
$('copyPrivateInvite').onclick=async()=>{if(!privateInvite)return;try{await navigator.clipboard.writeText(privateInvite);$('privateRoomInfo').textContent='已複製私人邀請連結，請只分享給對方'}catch{$('privateRoomInfo').textContent='無法使用剪貼簿；請在支援複製功能的瀏覽器重試'}};
$('join').onclick=async()=>{
 if(!validSession()){$('setupNotice').textContent='請先以 Email 驗證登入';return}const parsed=WorldHistory.parseRoom($('room').value);if(!parsed){$('setupNotice').textContent='請貼上完整私人邀請連結，或你已加入的房間 ID';return}const epoch=authGeneration;$('join').disabled=true;
 try{let id;if(parsed.token){const data=await historyClient.redeemInvite(parsed.token);id=roomIdOf(data.room||data)}else{const data=await historyClient.rooms();if(!(data.rooms||[]).some(r=>roomIdOf(r)===parsed.roomId))throw Error('此房間不屬於你的帳號，請使用對方的私人邀請連結');id=parsed.roomId}if(epoch===authGeneration&&validSession())await enterPrivateRoom(id)}catch(e){$('setupNotice').textContent=e.message}finally{$('join').disabled=false}
};
function connect(room,retry=false){
 if(!validSession()||room!==currentRoom)return;if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null}if(!retry){manualDisconnect=false;reconnectAttempt=0}const epoch=authGeneration,uid=currentUser.id;const previous=socket;const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);socket=ws;if(previous&&previous!==ws)previous.close();if(!retry){joined=false;peerOnline=false}
 ws.onopen=async()=>{
  try{const token=await privateAccessToken(epoch,uid);if(socket!==ws||epoch!==authGeneration||currentUser?.id!==uid||currentRoom!==room||ws.readyState!==WebSocket.OPEN)return;
   lastAccessToken=token;send({type:'join',roomId:room,accessToken:token,device:deviceId,lang});
  }catch(e){if(socket!==ws||epoch!==authGeneration)return;if([401,403].includes(e.status)){void requireSignIn('登入已失效，請重新驗證');return}status('登入服務暫時無法連線，正在等待恢復…');ws.close()}
 };
 let signalWork=Promise.resolve();ws.onmessage=e=>{if(socket!==ws||epoch!==authGeneration)return;let data;try{data=JSON.parse(e.data)}catch{return}signalWork=signalWork.then(()=>{if(socket===ws&&epoch===authGeneration)return handle(data)}).catch(()=>status('通訊事件處理失敗，請稍後重試'))};
 ws.onerror=()=>{if(socket===ws)status('網路連線失敗，正在嘗試重新連線…')};
 ws.onclose=e=>{if(socket!==ws||manualDisconnect)return;joined=false;peerOnline=false;for(const [id,item]of pendingMessages)if(!item.saved)deliveryState(id,'queued');endCall(false);
  if(e.code===4001||e.code===4401){void requireSignIn('登入已失效，請重新驗證');return}if(e.code===4003){manualDisconnect=true;show('setup',true);show('home',false);show('littleNest',false);show('nestNav',false);$('setupNotice').textContent='沒有此私人房間的權限，請重新確認邀請';return}
  const wait=Math.min(15000,1000*Math.pow(2,Math.min(reconnectAttempt++,4)));status('連線中斷，'+Math.ceil(wait/1000)+' 秒後自動重連…');reconnectTimer=setTimeout(()=>{reconnectTimer=null;if(!manualDisconnect&&currentRoom===room&&validSession())connect(room,true)},wait);
 };
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!manualDisconnect&&currentRoom&&validSession()&&socket?.readyState===WebSocket.CLOSED){clearTimeout(reconnectTimer);reconnectTimer=null;connect(currentRoom,true)}});
function onAuthSnapshot(snapshot){
 const user=snapshot.user,old=currentUser;if(!user){if(old)disconnectPrivate(true);currentUser=null;lastAccessToken='';if(coverEntered){show('emailAuth',true);show('setup',false)}return}
 if(old&&old.id!==user.id)disconnectPrivate(true);currentUser=user;
 if(old?.id===user.id){if(snapshot.status==='authenticated')void refreshConnectionAuth(authGeneration,user.id);return}
 authGeneration++;lastAccessToken='';show('emailAuth',false);if(coverEntered){show('setup',true);void restoreMembership()}
}

async function handle(m){
 if(m.type==='auth-required'){await requireSignIn('登入已到期，請重新驗證；未確認的訊息不會標成已保存');return}
 if(!validSession()||m.roomId&&m.roomId!==currentRoom)return;
 if(callSignalTypes.has(m.type)&&m.type!=='call-invite'&&m.callId!==activeCallId)return;
 switch(m.type){
 case 'joined':{if(m.userId&&m.userId!==currentUser.id)return;const first=!joined;joined=true;reconnectAttempt=0;peerOnline=m.count>1;show('setup',false);setNestView(first&&historyRoom!==currentRoom?'nest':nestView);status(peerOnline?'♡ 對方已連線':'等待對方加入…');restoreOutbox();loadHistory(false);void refreshConnectionAuth(authGeneration,currentUser.id);break}
 case 'chat-history':for(const row of m.messages||[])renderMessage({...row,roomId:row.roomId||currentRoom});sortMessages();break;
 case 'auth-refreshed':if(m.userId&&m.userId!==currentUser.id)await requireSignIn('登入身分已改變，請重新驗證');break;
 case 'auth-refresh-error':status('登入服務暫時無法連線；目前通話可繼續，登入到期後需重新驗證');break;
 case 'peer-joined':peerOnline=m.count>1;status(peerOnline?'♡ 對方已連線':'已登入自己的另一台裝置');break;
 case 'peer-left':peerOnline=m.count>1;status(peerOnline?'♡ 對方仍在線上':'對方暫時離線，訊息仍可保存');if(!peerOnline&&calling)endCall(false);break;
 case 'typing':$('typingStatus').textContent='對方正在輸入…';clearTimeout(typingClearTimer);typingClearTimer=setTimeout(()=>$('typingStatus').textContent='',2500);break;
 case 'speech-status':if(calling&&typeof m.active==='boolean'&&m.device!==deviceId){const partner=m.active?(lang==='en'?'Partner captions ready':'對方字幕已開啟'):(lang==='en'?'Partner captions are off. Ask them to tap Captions.':'對方字幕未開啟，請對方點「語音字幕」');if($('speechPeerStatus'))$('speechPeerStatus').textContent=partner;}break;
 case 'speech-interim':case 'caption-preview':receiveSpeechCaption(m,false);break;
 case 'speech-caption':receiveSpeechCaption(m,true);break;
 case 'caption-saved':if(m.persisted===true)acknowledgeSaved(m);break;
 case 'caption-error':if(typeof m.id==='string'&&pendingMessages.has(m.id)&&!pendingMessages.get(m.id).saved){deliveryState(m.id,'failed');saveOutbox()}status(m.message||'訊息尚未確認保存，請點訊息狀態重試');break;
 case 'caption-received':if(typeof m.id==='string')deliveryState(m.id,'delivered');break;
 case 'caption-undelivered':if(typeof m.id==='string'&&!pendingMessages.get(m.id)?.saved)deliveryState(m.id,'failed');break;
 case 'caption':$('typingStatus').textContent='';receiveText(m);break;
 case 'call-invite':if(!WorldHistory.isRoomId(m.callId))break;if(calling||mode){send({type:'call-decline',callId:m.callId});break}activeCallId=m.callId;callInitiator=false;mode=m.mode==='video'?'video':'audio';$('incomingMode').textContent=mode==='video'?'視訊通話':'語音通話';$('incomingTitle').textContent='寶貝正在呼叫你…';show('incomingCall',true);notifyIncoming('Our Little World','對方正在呼叫你');break;
 case 'call-accept':if(calling&&callInitiator){clearTimeout(callTimer);callStatus('正在連線…');await makeOffer()}break;
 case 'call-busy':if(m.callId===activeCallId){endCall(false);status('對方正在通話，請稍後再撥');callStatus('對方正在通話，請稍後再撥')}break;
 case 'call-decline':if(calling){alert('對方暫時無法接聽');endCall(false)}break;
 case 'call-unavailable':case 'call-cancelled':if(m.callId===activeCallId){callStatus(m.reason==='answered-elsewhere'?'已在另一台裝置接聽':'對方目前無法接聽');endCall(false)}break;
 case 'call-end':endCall(false);break;
 case 'offer':if(calling&&pc&&!callInitiator){const peer=pc,g=callGeneration;await peer.setRemoteDescription(m.sdp);if(peer!==pc||g!==callGeneration)return;remoteReady=true;await flushIce(peer,g);if(peer!==pc||g!==callGeneration)return;await peer.setLocalDescription(await peer.createAnswer());if(peer===pc&&g===callGeneration)send({type:'answer',sdp:peer.localDescription})}break;
 case 'answer':if(calling&&pc&&callInitiator){const peer=pc,g=callGeneration;await peer.setRemoteDescription(m.sdp);if(peer!==pc||g!==callGeneration)return;remoteReady=true;await flushIce(peer,g)}break;
 case 'ice':if(calling&&pc){if(remoteReady)await pc.addIceCandidate(m.candidate).catch(()=>{});else iceQueue.push(m.candidate)}break;
 case 'error':if(m.id&&pendingMessages.has(m.id)){deliveryState(m.id,'failed');status(m.message||'訊息尚未保存，請稍後重試');break}status(m.message||'私人房間連線失敗');if(!joined){manualDisconnect=true;socket?.close();show('setup',true);show('home',false);show('littleNest',false);show('nestNav',false)}break;
 }
}
async function flushIce(peer=pc,g=callGeneration){for(const candidate of iceQueue.splice(0)){if(peer!==pc||g!==callGeneration)return;await peer.addIceCandidate(candidate).catch(()=>{})}}
let rtcConfigAbort=null;
async function callRTCConfiguration(generation,callId){
 const fallback={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}],turnConfigured:false};
 const controller=new AbortController();rtcConfigAbort?.abort();rtcConfigAbort=controller;let timer;
 const current=()=>generation===callGeneration&&callId===activeCallId&&calling&&validSession()&&!controller.signal.aborted;
 const request=(async()=>{
  const token=await privateAccessToken();if(!current())throw Object.assign(Error('通話已取消'),{name:'AbortError'});
  const response=await fetch('/api/rtc-config',{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:controller.signal});
  if(!response.ok)throw Object.assign(Error('通話中繼設定暫時無法取得'),{status:response.status});const config=await response.json();if(!current())throw Object.assign(Error('通話已取消'),{name:'AbortError'});
  if(!Array.isArray(config.iceServers)||!config.iceServers.length||config.iceServers.length>16)throw Error('無效的中繼設定');
  const iceServers=config.iceServers.map(server=>{
   const urls=typeof server?.urls==='string'?[server.urls]:server?.urls;
   if(!Array.isArray(urls)||!urls.length||urls.length>16||!urls.every(url=>typeof url==='string'&&url.length<1024&&/^(stun|stuns|turn|turns):/.test(url)&&!/\s/.test(url)))throw Error('無效的中繼設定');
   const relay=urls.some(url=>/^turns?:/.test(url));if(relay&&(typeof server.username!=='string'||!server.username||typeof server.credential!=='string'||!server.credential))throw Error('中繼驗證設定不完整');
   return {urls,...(relay?{username:server.username,credential:server.credential}:{})};
  });return {iceServers,turnConfigured:iceServers.some(server=>server.urls.some(url=>/^turns?:/.test(url)))};
 })();
 try{return await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('取得中繼設定逾時'))},5000)})])}
 catch(error){if(generation===callGeneration&&callId===activeCallId&&[401,403].includes(error.status)){void requireSignIn('通話登入驗證已失效，請重新登入');throw error}
  if(generation===callGeneration&&callId===activeCallId&&calling)callStatus('暫時使用直接連線；跨網路通話可能需要中繼服務');return fallback;
 }finally{clearTimeout(timer);if(rtcConfigAbort===controller)rtcConfigAbort=null}
}
async function setupCall(which){
 const generation=++callGeneration,callId=activeCallId;mode=which;calling=true;remoteReady=false;iceQueue=[];show('call',true);show('home',false);resetCallCaptions();$('filterSelect').value='soft';applyFilter();show('cameraExtras',which==='video');show('incomingCall',false);show('audioBackdrop',which==='audio');show('local',which==='video');$('camera').disabled=which==='audio';$('flip').disabled=which==='audio';callStatus('正在準備通話…');
 try{const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:which==='video'?{width:{ideal:640},height:{ideal:360},frameRate:{ideal:15,max:20},facingMode:'user'}:false});if(generation!==callGeneration||callId!==activeCallId||!calling||!validSession()){media.getTracks().forEach(track=>track.stop());return false}
  stream=media;$('local').srcObject=media;const config=await callRTCConfiguration(generation,callId);if(generation!==callGeneration||callId!==activeCallId||!calling||!validSession()){media.getTracks().forEach(track=>track.stop());return false}const peer=new RTCPeerConnection({...config,bundlePolicy:'max-bundle'});pc=peer;
  media.getTracks().forEach(track=>{const sender=peer.addTrack(track,media);if(track.kind==='video'){const params=sender.getParameters();if(params.encodings?.length){params.encodings[0].maxBitrate=450000;params.encodings[0].maxFramerate=15;sender.setParameters(params).catch(()=>{})}}});
  peer.ontrack=e=>{if(pc!==peer||generation!==callGeneration)return;const remote=$('remote');remote.srcObject=e.streams[0];remote.autoplay=true;remote.playsInline=true;remote.muted=false;callStatus('♡ 通話中');resumeRemoteAudio()};peer.onicecandidate=e=>{if(pc===peer&&generation===callGeneration&&e.candidate)send({type:'ice',candidate:e.candidate})};peer.onconnectionstatechange=()=>{if(pc!==peer||generation!==callGeneration)return;if(peer.connectionState==='connected'){callStatus('♡ 通話中');autoStartCallCaptions()}else if(peer.connectionState==='failed')callStatus('連線失敗，請掛斷後重新撥打');else if(peer.connectionState==='disconnected')callStatus('連線暫時中斷，正在等待網路恢復…')};
  connectionWatch=setInterval(async()=>{if(pc!==peer||generation!==callGeneration||peer.connectionState!=='connected')return;try{const stats=await peer.getStats();if(pc!==peer||generation!==callGeneration)return;let lost=0,received=0,rtt=null;stats.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='audio'){lost+=s.packetsLost||0;received+=s.packetsReceived||0}if(s.type==='candidate-pair'&&s.state==='succeeded'&&s.currentRoundTripTime!=null)rtt=s.currentRoundTripTime});if(received>30&&(lost/(lost+received)>.1||rtt>1))callStatus('網路品質不穩，建議切換 Wi-Fi／行動網路')}catch{}},7000);return true;
 }catch(e){if(generation===callGeneration){alert('無法使用相機或麥克風：'+safeError(e));endCall(false)}return false}
}
async function makeOffer(){const peer=pc,g=callGeneration;if(!peer||peer.signalingState&&peer.signalingState!=='stable')return;const offer=await peer.createOffer();if(peer!==pc||g!==callGeneration)return;await peer.setLocalDescription(offer);if(peer===pc&&g===callGeneration)send({type:'offer',sdp:peer.localDescription})}
async function dial(which){if(!validSession()||!joined||!peerOnline){alert('請等對方登入並進入同一個私人房間後再撥打');return}if(calling||mode)return;activeCallId=crypto.randomUUID();callInitiator=true;const id=activeCallId;if(!await setupCall(which)||activeCallId!==id)return;callStatus('正在呼叫對方…');send({type:'call-invite',mode:which});callTimer=setTimeout(()=>{if(calling&&activeCallId===id&&pc?.connectionState!=='connected'){alert('對方尚未接聽');endCall(true)}},45000)}
$('audioCall').onclick=()=>dial('audio');$('videoCall').onclick=()=>dial('video');
$('decline').onclick=()=>{send({type:'call-decline'});endCall(false)};
$('accept').onclick=async()=>{const which=mode;if(!which)return;if(await setupCall(which)){callStatus('正在接聽…');send({type:'call-accept'})}else send({type:'call-decline'})};
function endCall(notify=true){callGeneration++;rtcConfigAbort?.abort();rtcConfigAbort=null;show('resumeAudio',false);callCaptionEpoch++;cancelCaptionTranslations();stopRecognition('',false);remoteCaptionSeq++;clearInterval(connectionWatch);connectionWatch=null;clearTimeout(callTimer);clearTimeout(speechRestartTimer);clearTimeout(previewTimer);previewText='';clearSpeechPreview('local');clearSpeechPreview('remote');recognizing=false;$('speechStatus').textContent='點「語音字幕」開始辨識';recognition=null;if(notify&&joined)send({type:'call-end'});activeCallId=null;callInitiator=false;pc?.close();pc=null;stream?.getTracks().forEach(t=>t.stop());stream=null;$('local').srcObject=null;$('remote').srcObject=null;calling=false;mode=null;remoteReady=false;iceQueue=[];closePhoto();show('call',false);show('incomingCall',false);show('home',joined&&nestView==='chat');$('mic').querySelector('small').textContent='語音字幕'}
$('hangup').onclick=()=>endCall(true);
$('leave').onclick=()=>{disconnectPrivate(false);show('setup',validSession())};
$('mute').onclick=()=>{const t=stream?.getAudioTracks()[0];if(!t)return;t.enabled=!t.enabled;$('mute').querySelector('small').textContent=t.enabled?'靜音':'取消靜音';if(!t.enabled)stopRecognition(speechMessage('麥克風已靜音，字幕已停止','Microphone muted; captions stopped'),true)};
$('camera').onclick=()=>{const t=stream?.getVideoTracks()[0];if(!t)return;t.enabled=!t.enabled;$('camera').querySelector('small').textContent=t.enabled?'關閉鏡頭':'開啟鏡頭'};
$('flip').onclick=async()=>{const old=stream?.getVideoTracks()[0],media=stream,peer=pc,g=callGeneration;if(!old)return;let next;try{const facing=old.getSettings().facingMode==='environment'?'user':'environment';next=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing}},audio:false});const track=next.getVideoTracks()[0];if(g!==callGeneration||media!==stream||peer!==pc){next.getTracks().forEach(t=>t.stop());return}const sender=peer?.getSenders().find(s=>s.track?.kind==='video');if(sender)await sender.replaceTrack(track);if(g!==callGeneration||media!==stream||peer!==pc){next.getTracks().forEach(t=>t.stop());return}media.removeTrack(old);old.stop();media.addTrack(track);$('local').srcObject=media;applyFilter()}catch(e){next?.getTracks().forEach(t=>t.stop());if(g===callGeneration)alert('無法切換鏡頭：'+safeError(e))}};
// Safari can end a continuous recognition session after one utterance. Every restart
// is fenced to one live call and one recognizer; stale callbacks never restart it.
let speechWanted=false,speechGeneration=0,speechAutoAttempted=false,speechFailureCount=0;
let speechStartupTimer=null,speechWatchdogTimer=null,speechLastActivity=0,speechSessionStarted=0;
let speechPreviewSlot=null;
function speechMessage(zh,en){return lang==='en'?en:zh}
function localSpeechStatus(message,retry=false){
  $('speechStatus').textContent=message;
  const button=$('speechRetry');if(button){button.textContent=speechMessage('重新啟動字幕','Restart captions');button.classList.toggle('hidden',!retry);button.disabled=!calling}
}
function speechPresence(active){send({type:'speech-status',active,device:deviceId,callId:activeCallId})}
function resetSpeechLifecycle(){stopRecognition('',false);speechAutoAttempted=false;speechFailureCount=0;lastSpeechText='';lastSpeechAt=0;localSpeechStatus(speechMessage('通話接通後會嘗試啟動字幕；也可點「語音字幕」','Captions start after connection; tap Captions if needed'))}
function stopRecognition(message=speechMessage('語音字幕已停止','Captions stopped'),retry=false){
  speechWanted=false;recognizing=false;speechGeneration++;clearTimeout(speechRestartTimer);clearTimeout(speechStartupTimer);clearInterval(speechWatchdogTimer);clearTimeout(previewTimer);
  speechRestartTimer=null;speechStartupTimer=null;speechWatchdogTimer=null;previewTimer=null;previewText='';speechPreviewSlot=null;
  const previous=recognition;recognition=null;
  if(previous){previous.onstart=null;previous.onresult=null;previous.onerror=null;previous.onend=null;previous.onaudiostart=null;previous.onspeechstart=null;previous.onspeechend=null;try{previous.abort()}catch{try{previous.stop()}catch{}}}
  $('mic').querySelector('small').textContent=speechMessage('語音字幕','Captions');speechPresence(false);if(message||retry)localSpeechStatus(message,retry);else if($('speechRetry'))$('speechRetry').classList.add('hidden');
}
function speechFailure(code){
  const messages={
    'not-allowed':['Safari 未允許語音辨識。請在網站設定允許麥克風，並直接點「重新啟動字幕」。','Safari denied speech recognition. Allow the microphone in website settings, then tap Restart captions.'],
    'service-not-allowed':['此裝置的語音辨識服務未允許使用。請檢查「設定 → Siri」與麥克風權限，再重新啟動字幕。','Speech recognition is blocked on this device. Check Siri and microphone settings, then restart captions.'],
    'audio-capture':['語音辨識無法取得麥克風，可能與通話麥克風衝突。通話仍保留原聲；請重新啟動字幕。','Speech recognition could not access the microphone and may conflict with the call. Original audio continues; restart captions.'],
    'language-not-supported':['此裝置不支援目前的辨識語言。請確認繁體中文或英文設定。','This device does not support the selected recognition language. Check the Chinese or English setting.'],
    'network':['語音辨識服務連線失敗。請確認網路，再重新啟動字幕；通話不受翻譯影響。','The speech recognition service could not connect. Check the network and restart captions; the call continues.'],
    'startup-timeout':['語音辨識啟動逾時。請直接點「重新啟動字幕」授權；通話會繼續。','Speech recognition startup timed out. Tap Restart captions to grant access; the call continues.'],
    'stalled':['語音辨識反覆停止，請重新啟動字幕。通話原聲仍會繼續。','Speech recognition stopped repeatedly. Restart captions; original call audio continues.'],
    'unsupported':['此瀏覽器不支援語音辨識。iPhone 請改用 Safari；若仍不支援，目前無法自動產生字幕。','This browser does not support speech recognition. On iPhone use Safari; automatic captions are unavailable if support is still missing.'],
    'insecure':['語音字幕需要 HTTPS 安全連線，請使用網站的完整 HTTPS 網址。','Captions require HTTPS. Open the full secure website URL.'],
    'background':['切到背景後 iPhone 可能暫停語音辨識。回到頁面後請重新啟動字幕。','iPhone may pause recognition in the background. Return to this page and restart captions.']
  };
  const pair=messages[code]||['語音辨識無法啟動，請重新啟動字幕。','Speech recognition could not start. Restart captions.'];
  stopRecognition(speechMessage(...pair),true);
}
function autoStartCallCaptions(){
  if(!calling||pc?.connectionState!=='connected'||speechAutoAttempted||speechWanted)return;
  speechAutoAttempted=true;startSpeechCaptions();
}
function startSpeechCaptions(){
  if(!calling)return;
  if(speechWanted||recognition)return;
  if(window.isSecureContext===false){speechFailure('insecure');return}
  if(!(window.SpeechRecognition||window.webkitSpeechRecognition)){speechFailure('unsupported');return}
  if(!stream?.getAudioTracks().some(track=>track.enabled&&track.readyState!=='ended')){localSpeechStatus(speechMessage('請先開啟通話麥克風，再重新啟動字幕。','Unmute the call microphone, then restart captions.'),true);return}
  if(pc?.connectionState!=='connected'){localSpeechStatus(speechMessage('等待通話接通後再啟動字幕。','Wait for the call to connect before starting captions.'),true);return}
  speechAutoAttempted=true;speechWanted=true;recognizing=true;speechFailureCount=0;beginRecognitionSession();
}
function beginRecognitionSession(){
  if(!speechWanted||!calling||recognition)return;
  if(document.hidden){speechFailure('background');return}
  const Constructor=window.SpeechRecognition||window.webkitSpeechRecognition;
  const generation=++speechGeneration,sourceLang=lang,sessionCallId=activeCallId;
  let instance;try{instance=new Constructor()}catch{speechFailure('unsupported');return}recognition=instance;const slots=new Map();
  const live=()=>speechWanted&&calling&&recognition===instance&&generation===speechGeneration&&activeCallId===sessionCallId;
  instance.lang=sourceLang==='en'?'en-US':sourceLang==='sr'?'sr-RS':sourceLang;
  instance.continuous=true;instance.interimResults=true;instance.maxAlternatives=1;
  speechLastActivity=Date.now();speechSessionStarted=Date.now();
  localSpeechStatus(speechMessage('正在啟動語音辨識…','Starting speech recognition…'));
  $('mic').querySelector('small').textContent=speechMessage('停止字幕','Stop captions');
  const emit=(slot,final)=>{
    if(!live()||!slot?.text)return;
    const parts=final?(slot.text.match(/[\s\S]{1,500}/g)||[]):[slot.text.slice(0,300)];
    parts.forEach((text,index)=>{const id=slot.id+(index?'-'+index:'');
      if(final)addSpeechCaption(text,sourceLang,'我','local-'+id);else updateSpeechPreview('local',text,sourceLang,'local-'+id);
      send({type:final?'speech-caption':'caption-preview',id,revision:slot.revision,text,lang:sourceLang,device:deviceId,callId:sessionCallId});
    });
  };
  instance.onstart=()=>{if(!live())return;clearTimeout(speechStartupTimer);speechLastActivity=Date.now();localSpeechStatus(speechMessage('正在聆聽；原聲通話與字幕分開處理','Listening; original audio and captions run independently'));speechPresence(true)};
  instance.onaudiostart=instance.onspeechstart=()=>{if(live())speechLastActivity=Date.now()};
  instance.onresult=event=>{
    if(!live())return;speechLastActivity=Date.now();speechFailureCount=0;
    for(let i=event.resultIndex;i<event.results.length;i++){
      const result=event.results[i],text=result[0]?.transcript?.trim();if(!text)continue;
      let slot=slots.get(i);if(!slot){slot={id:crypto.randomUUID(),revision:0,text:'',final:false};slots.set(i,slot)}
      if(slot.final)continue;slot.text=text;slot.revision++;
      if(result.isFinal){slot.final=true;if(speechPreviewSlot===slot){clearTimeout(previewTimer);previewTimer=null;speechPreviewSlot=null}emit(slot,true)}
      else{
        speechPreviewSlot=slot;updateSpeechPreview('local',text.slice(0,300),sourceLang,'local-'+slot.id);
        const now=Date.now();if(now-lastPreviewAt>650){lastPreviewAt=now;emit(slot,false)}
        else if(!previewTimer)previewTimer=setTimeout(()=>{previewTimer=null;if(live()&&speechPreviewSlot&&!speechPreviewSlot.final){lastPreviewAt=Date.now();emit(speechPreviewSlot,false)}},650);
      }
    }
    localSpeechStatus(speechMessage('正在聆聽，字幕會持續更新','Listening; captions update continuously'));
  };
  instance.onerror=event=>{
    if(!live())return;
    if(['not-allowed','service-not-allowed','audio-capture','language-not-supported'].includes(event.error)){speechFailure(event.error);return}
    if(event.error==='no-speech')return;
    speechFailureCount++;
    if(speechFailureCount>=3){speechFailure(event.error==='network'?'network':'stalled');return}
    speechPresence(false);localSpeechStatus(speechMessage('辨識服務暫停，正在重新連線…','Recognition paused; reconnecting…'));
  };
  instance.onend=()=>{
    if(!live())return;clearTimeout(speechStartupTimer);clearInterval(speechWatchdogTimer);clearTimeout(previewTimer);previewTimer=null;recognition=null;speechPresence(false);
    if(Date.now()-speechSessionStarted<1200)speechFailureCount++;
    if(speechFailureCount>=5){speechFailure('stalled');return}
    localSpeechStatus(speechMessage('正在接續語音辨識…','Continuing speech recognition…'));
    speechRestartTimer=setTimeout(()=>{speechRestartTimer=null;if(speechWanted&&calling&&generation===speechGeneration)beginRecognitionSession()},Math.min(4000,350*Math.pow(2,Math.min(speechFailureCount,3))));
  };
  speechStartupTimer=setTimeout(()=>{if(live())speechFailure('startup-timeout')},8000);
  clearInterval(speechWatchdogTimer);speechWatchdogTimer=setInterval(()=>{
    if(!live())return;
    if(document.hidden){speechFailure('background');return}
    // A silent/stuck Safari session gets a fresh recognizer without touching RTP.
    if(Date.now()-speechLastActivity>65000){
      speechFailureCount++;if(speechFailureCount>=3){speechFailure('stalled');return}
      // Some Safari hangs never fire onend. Detach before aborting and restart once.
      instance.onstart=null;instance.onresult=null;instance.onerror=null;instance.onend=null;instance.onaudiostart=null;instance.onspeechstart=null;recognition=null;clearTimeout(speechStartupTimer);clearInterval(speechWatchdogTimer);try{instance.abort()}catch{}speechPresence(false);
      speechRestartTimer=setTimeout(()=>{speechRestartTimer=null;if(speechWanted&&calling&&generation===speechGeneration)beginRecognitionSession()},350);
    }
  },5000);
  try{instance.start()}catch(error){speechFailure(error.name==='NotAllowedError'?'not-allowed':'stalled')}
}
$('mic').onclick=()=>{if(speechWanted||recognition)stopRecognition();else startSpeechCaptions()};
if($('speechRetry'))$('speechRetry').onclick=()=>{stopRecognition('',false);startSpeechCaptions()};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&speechWanted)speechFailure('background')});

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

WorldAuth.subscribe(onAuthSnapshot);
WorldAuth.ready().catch(()=>{if(coverEntered){show('emailAuth',true);$('emailAuthNotice').textContent='無法確認登入狀態，請稍後重試'}});
