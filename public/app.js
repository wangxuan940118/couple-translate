const $=id=>document.getElementById(id);
const translationCache=new Map(),translationJobs=new Map();
let connectionWatch=null,qualityMonitor=null,iceRestartTimer=null,recoveryWatch=null,videoPresetLevel=0;
let typingTimer=null,typingClearTimer=null,lastTypingSent=0;
let lastPreviewAt=0,previewTimer=null,previewText='';
let lang='zh-TW',socket=null,pc=null,stream=null,recognition=null,recognizing=false,joined=false,peerOnline=false,mode=null,calling=false,remoteReady=false,iceQueue=[],currentRoom='',roomToken='',callTimer=null,speechRestartTimer=null,photoBlob=null,photoURL=null;
let connectionGeneration=0,callGeneration=0,activeCallId=null,incomingCallId=null,isInitiator=false,inviteSent=false,signalChain=Promise.resolve(),offerPending=false,restartUsed=false,flipPending=false;
let speechGeneration=0,localSpeechSeq=0,remoteSpeechSeq=0,speechDraftId=null,speechDraftSeq=0,speechSeen=new Set(),speechQueue=[],speechProcessing=false,speechWorkerEpoch=0,speaking=false,ttsGeneration=0,captionRevision=0;
const show=(id,on)=>$(id).classList.toggle('hidden',!on);
let selectedProfile=(()=>{try{return localStorage.getItem("olw-profile")==="kaan"?"kaan":"her"}catch{return "her"}})();
function applyCoupleProfile(role){selectedProfile=role;try{localStorage.setItem("olw-profile",role)}catch{};document.querySelectorAll(".heartChoice").forEach(button=>{const active=button.dataset.profile===role;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active))});$("chatlog").dataset.wallpaper=role==="her"?"kaan":"her"}
document.querySelectorAll(".heartChoice").forEach(button=>button.addEventListener("click",()=>applyCoupleProfile(button.dataset.profile)));
applyCoupleProfile(selectedProfile);
const languages=['zh-TW','en','sv','sr','fr','es','ja','ko','de','tr'];
const other=()=>lang==='zh-TW'?'en':'zh-TW'; // Translation test only; incoming chat always targets the viewer's language.
const status=t=>$('status').textContent=t;
const callStatus=t=>$('callStatus').textContent=t;
const send=m=>{if(socket?.readyState!==WebSocket.OPEN)return false;try{socket.send(JSON.stringify(m));return true}catch{return false}};
const safeError=e=>e?.message||String(e);
// Push requires a Home Screen installation on iOS and server VAPID configuration.
const deviceId=(()=>{let id;try{id=localStorage.getItem('olw-device')}catch{}if(!id){id=crypto.randomUUID();try{localStorage.setItem('olw-device',id)}catch{}}return id})();
const roomUUID=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
let currentUserId=null,reconnectTarget=null,lastJoinTarget=null,wantReconnect=false,reconnectTimer=null,reconnectAttempts=0,authRefreshTimer=null,suspended=false,authEpoch=0,nextHistoryCursor=null,historyLoading=false;
const records=new Map(),outbox=new Map();
const savedKey=()=>currentUserId&&roomUUID(currentRoom)?'olw-pending:'+currentUserId+':'+currentRoom:null;
function persistOutbox(){const key=savedKey();if(!key)return;try{localStorage.setItem(key,JSON.stringify([...outbox.values()]))}catch{status('此瀏覽器無法保存待傳訊息，請保持網頁開啟直到收到儲存確認')}}
function loadOutbox(){const key=savedKey();if(!key)return;try{const values=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(values))for(const m of values.slice(0,100))if(m&&roomUUID(m.id)&&m.roomId===currentRoom&&m.authorId===currentUserId&&typeof m.text==='string'&&m.text.length<=500&&languages.includes(m.lang)){m.state='waiting';outbox.set(m.id,m);upsertRecord(m)}}catch{status('無法恢復待傳訊息，已保存的紀錄仍會從伺服器載入')}}
function renderMessageState(record){const {bubble,message}=record;let meta=bubble.querySelector('.messageMeta');if(!meta){meta=document.createElement('small');meta.className='messageMeta';bubble.append(meta)}
 const stamp=Number.isFinite(message.timestamp)?new Date(message.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'';
 const label={waiting:'等待連線',sending:'等待儲存確認',failed:'傳送失敗，點此重試',sent:'已儲存'}[message.state]||'已儲存';meta.textContent=stamp+(stamp?' · ':'')+label;meta.classList.toggle('retryMessage',message.state==='failed');meta.onclick=()=>{const pending=outbox.get(message.id);if(pending){pending.state='waiting';pending.error=null;persistOutbox();upsertRecord(pending);flushOutbox()}};
}
function sortMessages(){const log=$('chatlog'),atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<120;for(const record of [...records.values()].sort((a,b)=>(a.message.timestamp||0)-(b.message.timestamp||0)||a.message.id.localeCompare(b.message.id)))log.append(record.bubble);if(atBottom)log.scrollTop=log.scrollHeight;filterChat()}
function upsertRecord(input){
 const id=input.id||crypto.randomUUID();let record=records.get(id);const message={...input,id,state:input.state||'sent'};
 if(record){record.message={...record.message,...message};renderMessageState(record);return record}
 const mine=message.authorId===currentUserId&&Boolean(currentUserId);const bubble=appendChat(mine?'我':'寶貝',message.text);bubble.dataset.messageId=id;
 record={message,bubble};records.set(id,record);renderMessageState(record);sortMessages();return record;
}
function flushOutbox(){if(!joined)return;for(const item of outbox.values()){if(item.state==='failed'||(item.state==='sending'&&Date.now()-(item.lastAttempt||0)<15000))continue;
 item.state='sending';item.lastAttempt=Date.now();upsertRecord(item);if(!send({type:'chat',id:item.id,text:item.text,lang:item.lang})){item.state='waiting';upsertRecord(item);break}}persistOutbox()}
function scheduleReconnect(){if(!wantReconnect||suspended||!currentUserId||!reconnectTarget)return;clearTimeout(reconnectTimer);const delay=Math.min(15000,1000*2**Math.min(reconnectAttempts++,4));reconnectTimer=setTimeout(()=>{if(wantReconnect&&!suspended)void connect(reconnectTarget)},delay)}
async function refreshSocketAuth(){if(!joined)return;const ws=socket;try{const accessToken=await window.WorldAuth?.accessToken();if(ws===socket&&joined&&accessToken)send({type:'refresh-auth',accessToken})}catch{status('登入服務暫時無法連線，稍後重試')}}
async function privateAPI(path){const accessToken=await window.WorldAuth?.accessToken();if(!accessToken)throw Error('請先登入私人帳號');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{const response=await fetch(path,{headers:{Authorization:'Bearer '+accessToken},cache:'no-store',signal:controller.signal});const data=await response.json();if(!response.ok)throw Error(data.error||'私人資料暫時無法讀取');return data}finally{clearTimeout(timer)}}
async function translateHistory(record,generation){const m=record.message;if(m.authorId===currentUserId||m.lang===lang||record.bubble.querySelector('.translation'))return;const viewer=lang;try{const result=await translate(m.text,m.lang,viewer);if(generation!==connectionGeneration||viewer!==lang||records.get(m.id)!==record)return;let sub=record.bubble.querySelector('.translation');if(!sub){sub=document.createElement('div');sub.className='translation';record.bubble.append(sub)}sub.textContent=result;filterChat()}catch{if(generation!==connectionGeneration)return;let button=record.bubble.querySelector('.translateRetry');if(!button){button=document.createElement('button');button.type='button';button.className='translateRetry';button.textContent='點此重試翻譯';button.onclick=()=>{button.remove();void translateHistory(record,connectionGeneration)};record.bubble.append(button)}}}
function mergeHistory(messages){if(!Array.isArray(messages))return;const generation=connectionGeneration,all=[];for(const message of messages)if(message&&roomUUID(message.id)&&typeof message.text==='string'&&languages.includes(message.lang)){const item=outbox.get(message.id);if(item){outbox.delete(message.id);persistOutbox()}all.push(upsertRecord({...message,state:'sent'}))}sortMessages();
 // Translate at most ten recent history entries, two at a time; older entries translate on demand.
 const queue=all.filter(r=>r.message.authorId!==currentUserId&&r.message.lang!==lang).slice(-10);for(let worker=0;worker<2;worker++)void(async()=>{while(queue.length&&generation===connectionGeneration)await translateHistory(queue.shift(),generation)})();
 for(const record of all)if(record.message.authorId!==currentUserId&&record.message.lang!==lang)record.bubble.onclick=()=>{void translateHistory(record,connectionGeneration)};
}
function updateHistoryButton(){const button=$('historyMore');if(button){button.classList.toggle('hidden',!nextHistoryCursor);button.disabled=historyLoading}}
async function loadOlderHistory(){if(historyLoading||!nextHistoryCursor||!roomUUID(currentRoom))return;historyLoading=true;updateHistoryButton();const room=currentRoom,epoch=connectionGeneration,log=$('chatlog'),height=log.scrollHeight,top=log.scrollTop;try{const page=await privateAPI('/api/messages?room='+encodeURIComponent(room)+'&before='+encodeURIComponent(nextHistoryCursor)+'&limit=50');if(epoch!==connectionGeneration||room!==currentRoom)return;nextHistoryCursor=page.nextCursor||null;mergeHistory(page.messages);log.scrollTop=top+log.scrollHeight-height}catch(e){if(epoch===connectionGeneration&&room===currentRoom)status('無法載入更早紀錄：'+safeError(e))}finally{historyLoading=false;updateHistoryButton()}}
function disconnectPrivate(){wantReconnect=false;clearTimeout(reconnectTimer);clearInterval(authRefreshTimer);authRefreshTimer=null;endCall(true);const previous=socket;socket=null;++connectionGeneration;joined=false;peerOnline=false;roomToken='';if(previous){previous.onclose=null;previous.onmessage=null;previous.close()}}
async function resumePrivate(userId,ticket){try{const data=await privateAPI('/api/rooms');if(ticket!==authEpoch||currentUserId!==userId)return;const rooms=Array.isArray(data.rooms)?data.rooms:[];let saved;try{saved=localStorage.getItem('olw-room:'+userId)}catch{}const target=rooms.find(room=>room.id===saved)||rooms[0];if(target)await connect(target.id);else{show('setup',true);show('home',false)}}catch(e){if(ticket===authEpoch){$('setupNotice').textContent='房間尚未恢復：'+safeError(e);show('setup',true)}}}
function updateWorldClocks(){for(const [id,zone]of [['taipeiTime','Asia/Taipei'],['stockholmTime','Europe/Stockholm']]){const el=$(id);if(el)el.textContent=new Intl.DateTimeFormat('zh-TW',{timeZone:zone,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())}}
const notifyStatus=message=>{const el=$('notificationStatus');if(el)el.textContent=message};
function notifyIncoming(title,body){if(!('Notification'in window)||Notification.permission!=='granted'||!document.hidden)return;try{const n=new Notification(title,{body,tag:'our-little-world-message'});n.onclick=()=>{window.focus();n.close()}}catch(e){console.warn('Notification unavailable',e)}}
function urlBase64ToUint8Array(base64){const padded=base64+'='.repeat((4-base64.length%4)%4);const raw=atob(padded.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0))}
async function subscribePush(){if(!joined||!currentRoom){notifyStatus('請先進入私人房間，再開啟通知。');return}if(!('Notification'in window)||!('serviceWorker'in navigator)||!('PushManager'in window)){notifyStatus('此裝置或瀏覽器不支援推播。iPhone 請先用 Safari 加入主畫面，再從桌面開啟。');return}
 try{const permission=await Notification.requestPermission();if(permission!=='granted'){notifyStatus('尚未允許通知。');return}const config=await(await fetch('/api/push/key')).json();if(!config.enabled){notifyStatus('通知介面已準備好，但伺服器推播金鑰尚未設定。');return}
 const registration=await navigator.serviceWorker.ready;let subscription=await registration.pushManager.getSubscription();if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(config.publicKey)});
 const result=await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json','X-Room-Token':roomToken},body:JSON.stringify({room:currentRoom,device:deviceId,subscription:subscription.toJSON()})});if(!result.ok)throw Error('無法儲存通知訂閱');notifyStatus('通知已啟用。提醒：伺服器重啟後需要重新訂閱，正式持久化仍在開發中。');
 }catch(e){notifyStatus('推播設定失敗：'+safeError(e))}}
$('enableNotifications').onclick=subscribePush;
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(e=>console.warn('Service worker registration failed',e));

try{const saved=localStorage.getItem('olw-language');if(languages.includes(saved)){lang=saved;$('languageSelect').value=saved}}catch{}
$('languageSelect').onchange=e=>{lang=e.target.value;try{localStorage.setItem('olw-language',lang)}catch{};for(const record of records.values())record.bubble.querySelectorAll('.translation,.translateRetry').forEach(el=>el.remove());const queue=[...records.values()].filter(r=>r.message.authorId!==currentUserId).slice(-10);void(async()=>{for(const record of queue)await translateHistory(record,connectionGeneration)})()};
$('random').onclick=()=>{const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',nums=new Uint32Array(10);crypto.getRandomValues(nums);$('room').value=Array.from(nums,n=>chars[n%chars.length]).join('')};
function appendChat(who,text,translation){const log=$('chatlog');log.querySelector('.empty')?.remove();const p=document.createElement('div');p.className='bubble '+(who==='我'?'mine':'theirs');const title=document.createElement('small');title.textContent=who;p.append(title);const line=document.createElement('div');line.textContent=text;p.append(line);if(translation&&translation!==text){const sub=document.createElement('div');sub.className='translation';sub.textContent=translation;p.append(sub)}log.append(p);log.scrollTop=log.scrollHeight;filterChat();return p}
function filterChat(){const query=$('searchMessages').value.trim().toLocaleLowerCase();$('chatlog').querySelectorAll('.bubble').forEach(el=>{el.classList.toggle('hidden',Boolean(query)&&!el.textContent.toLocaleLowerCase().includes(query))})}
$('searchMessages').oninput=filterChat;
function sendTyping(){if(!joined)return;const now=Date.now();if(now-lastTypingSent>1600){send({type:'typing'});lastTypingSent=now}}
$('message').addEventListener('input',sendTyping);
$('callText').addEventListener('input',sendTyping);
async function translate(text,from,to,scope='chat'){
 if(from===to)return text;
 const cacheKey=from+'|'+to+'|'+text;if(translationCache.has(cacheKey))return translationCache.get(cacheKey);
 const jobKey=scope+'|'+cacheKey;if(translationJobs.has(jobKey))return translationJobs.get(jobKey).promise;
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
 const job={controller,promise:null};
 job.promise=(async()=>{try{
 const r=await fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json',...(roomToken?{'X-Room-Token':roomToken}:{})},body:JSON.stringify({text,from,to}),signal:controller.signal});
 const d=await r.json();if(!r.ok)throw Error(d.error||'翻譯服務暫時無法使用');if(typeof d.translation!=='string'||!d.translation.trim())throw Error('翻譯結果為空');
 if(controller.signal.aborted)throw Object.assign(Error('翻譯已取消'),{name:'AbortError'});
 translationCache.set(cacheKey,d.translation);if(translationCache.size>120)translationCache.delete(translationCache.keys().next().value);return d.translation;
 }finally{clearTimeout(timeout);if(translationJobs.get(jobKey)===job)translationJobs.delete(jobKey)}})();
 translationJobs.set(jobKey,job);return job.promise;
}
function abortSpeechTranslations(){for(const [key,job]of translationJobs)if(key.startsWith('speech:')){job.controller.abort();translationJobs.delete(key)}}
function postText(text){
 text=text.trim();if(!text||text.length>500||!currentUserId||!roomUUID(currentRoom))return false;
 if(outbox.size>=100){status('待傳送訊息已滿，請先連線重試');return false}
 const message={id:crypto.randomUUID(),text,lang,authorId:currentUserId,device:deviceId,timestamp:Date.now(),state:'waiting',roomId:currentRoom};
 outbox.set(message.id,message);persistOutbox();upsertRecord(message);flushOutbox();return true;
}
function setIncomingCaption(original,translated,state){$('captionOriginal').textContent=original;$('captionTranslation').textContent=translated;$('captionState').textContent=state||''}
async function receiveText(m){
 const generation=connectionGeneration,viewerLanguage=lang,bubble=upsertRecord(m).bubble,callEpoch=callGeneration,captionTicket=calling?++captionRevision:null;
 const canShow=()=>captionTicket!==null&&calling&&callEpoch===callGeneration&&captionTicket===captionRevision&&viewerLanguage===lang;
 if(canShow())setIncomingCaption(m.text,'翻譯中…','對方的文字訊息');notifyIncoming('卡安 ❤️',m.text);
 try{const t=await translate(m.text,m.lang,viewerLanguage);if(generation!==connectionGeneration||!joined||viewerLanguage!==lang)return;if(t!==m.text){let sub=bubble.querySelector('.translation');if(!sub){sub=document.createElement('div');sub.className='translation';bubble.append(sub)}sub.textContent=t;filterChat()}if(canShow()){setIncomingCaption(m.text,t,'對方的文字訊息 / '+languageName(lang));}}
 catch{if(generation!==connectionGeneration||viewerLanguage!==lang)return;const sub=document.createElement('div');sub.className='translation';sub.textContent='翻譯暫時無法使用，原文已保留';bubble.append(sub);if(canShow())setIncomingCaption(m.text,'翻譯暫時無法使用','原文已保留，通話繼續')}
}
function receiveSpeech(m,interim=false){
 if(!calling||m.callId!==activeCallId||!languages.includes(m.lang)||typeof m.text!=='string'||!Number.isInteger(m.seq)||m.seq<remoteSpeechSeq)return;
 if(interim){if(m.seq===remoteSpeechSeq&&speechSeen.has(m.id))return;remoteSpeechSeq=m.seq;++captionRevision;setIncomingCaption(m.text,'辨識中，尚未翻譯…','對方正在說話');return}
 if(speechSeen.has(m.id))return;speechSeen.add(m.id);if(speechSeen.size>100)speechSeen.delete(speechSeen.values().next().value);
 remoteSpeechSeq=m.seq;++captionRevision;setIncomingCaption(m.text,'翻譯中…','對方原文');
 // Keep only the latest waiting sentence; no translation is awaited by the signalling path.
 speechQueue=[{...m,generation:callGeneration,viewerLanguage:lang,revision:captionRevision}];void processSpeechQueue();
}
async function processSpeechQueue(){
 if(speechProcessing)return;const workerEpoch=++speechWorkerEpoch;speechProcessing=true;
 try{while(speechQueue.length&&workerEpoch===speechWorkerEpoch){const item=speechQueue.shift();if(!calling||item.callId!==activeCallId||item.generation!==callGeneration)continue;
 try{const text=await translate(item.text,item.lang,item.viewerLanguage,'speech:'+item.generation);if(!calling||item.callId!==activeCallId||item.generation!==callGeneration||item.seq!==remoteSpeechSeq||item.revision!==captionRevision||item.viewerLanguage!==lang)continue;setIncomingCaption(item.text,text,'對方原文 / '+languageName(lang));}
 catch{if(calling&&item.callId===activeCallId&&item.generation===callGeneration&&item.seq===remoteSpeechSeq&&item.revision===captionRevision)setIncomingCaption(item.text,'翻譯暫時無法使用','原文已保留，通話繼續')}
 }}finally{if(workerEpoch===speechWorkerEpoch){speechProcessing=false;if(speechQueue.length)void processSpeechQueue()}}
}
function languageName(code){return {'zh-TW':'繁體中文',en:'English',sv:'Svenska',sr:'Srpski',fr:'Français',es:'Español',ja:'日本語',ko:'한국어',de:'Deutsch',tr:'Türkçe'}[code]||code}
$('testTranslate').onclick=async()=>{const button=$('testTranslate');const phrase=$('testPhrase').value.trim();if(!phrase)return;$('testResult').textContent='正在翻譯…';button.disabled=true;try{const result=await translate(phrase,lang,$('testTargetSelect').value);$('testResult').textContent='翻譯：'+result}catch(e){$('testResult').textContent='測試失敗：'+(e.name==='AbortError'?'翻譯逾時':safeError(e))}finally{button.disabled=false}};
$('manual').onsubmit=e=>{e.preventDefault();if(postText($('message').value))$('message').value=''};
$('callSend').onclick=()=>{if(postText($('callText').value))$('callText').value=''};
$('callText').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('callSend').click()}};
$('join').onclick=()=>{const room=$('room').value.trim().toUpperCase();if(!/^[A-Z0-9]{6,20}$/.test(room)){ $('setupNotice').textContent='請輸入 6–20 位英數字房間代碼';return}$('setupNotice').textContent='';void connect(room)};
async function connect(target){
 const generation=++connectionGeneration;wantReconnect=true;clearTimeout(reconnectTimer);clearInterval(authRefreshTimer);authRefreshTimer=null;
 const desired=roomUUID(target)?{roomId:target}:{room:target};reconnectTarget=target;
 const same=target===currentRoom||target===lastJoinTarget;
 endCall(false);for(const job of translationJobs.values())job.controller.abort();translationJobs.clear();translationCache.clear();
 if(!same){records.clear();outbox.clear();$('chatlog').replaceChildren();currentRoom='';nextHistoryCursor=null;updateHistoryButton()}
 lastJoinTarget=target;$('typingStatus').textContent='';clearTimeout(typingClearTimer);
 const previous=socket;socket=null;if(previous){previous.onclose=null;previous.onmessage=null;previous.close()}
 joined=false;peerOnline=false;roomToken='';signalChain=Promise.resolve();status('正在安全連線…');
 let token;try{token=await window.WorldAuth?.accessToken()}catch{if(generation===connectionGeneration){status('登入服務暫時無法連線，等待重試');scheduleReconnect()}return}
 if(generation!==connectionGeneration||!wantReconnect)return;
 if(!token){status('請先登入私人帳號');show('setup',false);return}
 const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);socket=ws;
 const handshake=setTimeout(()=>{if(socket===ws&&!joined)ws.close()},15000);
 ws.onopen=()=>{if(socket===ws&&generation===connectionGeneration)send({type:'join',...desired,accessToken:token,device:deviceId})};
 ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(!m||typeof m!=='object')return;signalChain=signalChain.catch(()=>{}).then(()=>{if(socket===ws&&generation===connectionGeneration)return handle(m)}).catch(()=>{if(generation===connectionGeneration&&calling)callStatus('通話訊號暫時無法處理，請結束後重試')})};
 ws.onerror=()=>{if(socket===ws)status('網路連線失敗，訊息會等待重試')};
 ws.onclose=event=>{clearTimeout(handshake);if(socket!==ws||generation!==connectionGeneration)return;joined=false;peerOnline=false;roomToken='';clearInterval(authRefreshTimer);authRefreshTimer=null;endCall(false);
  for(const item of outbox.values())if(item.state==='sending'){item.state='waiting';upsertRecord(item)}persistOutbox();
  if(event?.code===4001){wantReconnect=false;status('此帳號已在另一個分頁開啟，請關閉另一個分頁後重新進入');return}
  if(event?.code===4003){wantReconnect=false;void window.WorldAuth?.signOut();return}
  status('連線中斷，訊息保留並等待重連');if(!roomUUID(currentRoom)){show('setup',true);show('home',false)}scheduleReconnect();
 };
}
function currentSignal(m){return calling&&m.callId===activeCallId}
async function handle(m){switch(m.type){
case 'joined':{
 joined=true;roomToken=typeof m.roomToken==='string'?m.roomToken:'';peerOnline=m.count===2;reconnectAttempts=0;
 if(roomUUID(m.roomId))currentRoom=m.roomId;if(typeof m.userId==='string')currentUserId=m.userId;
 try{localStorage.setItem('olw-room:'+currentUserId,currentRoom)}catch{}
 loadOutbox();show('setup',false);show('home',true);status(peerOnline?'♡ 你們都在線上':'對方離線，仍可傳送文字訊息');
 $('storageStatus').textContent=m.storage?.mode==='postgres'?'訊息儲存於私人資料庫；收到儲存確認才標為已傳送。':'儲存狀態尚未確認';
 clearInterval(authRefreshTimer);authRefreshTimer=setInterval(()=>{void refreshSocketAuth()},60000);flushOutbox();break;}
case 'chat-history':if(m.roomId===currentRoom){nextHistoryCursor=m.nextCursor||null;mergeHistory(m.messages);updateHistoryButton()}break;
case 'chat-saved':if(m.roomId===currentRoom){const item=m.message||m;outbox.delete(m.id);persistOutbox();upsertRecord({...item,state:'sent'});sortMessages()}break;
case 'chat-error':{const item=outbox.get(m.id);if(item){item.state='failed';item.error=m.message||'訊息尚未儲存';upsertRecord(item);persistOutbox()}status(m.message||'傳送失敗，請點訊息重試');break;}
case 'auth-refreshed':break;
case 'auth-refresh-error':status('登入驗證暫時無法連線，通話繼續並稍後重試');break;
case 'auth-required':wantReconnect=false;void window.WorldAuth?.signOut();break;
case 'peer-joined':peerOnline=true;status('♡ 你們都在線上');break;
case 'peer-left':peerOnline=false;status('寶貝已離開房間');endCall(false);break;
case 'typing':$('typingStatus').textContent='對方正在輸入…';clearTimeout(typingClearTimer);typingClearTimer=setTimeout(()=>$('typingStatus').textContent='',2500);break;
case 'chat':case 'caption':$('typingStatus').textContent='';if(typeof m.text==='string'&&languages.includes(m.lang)){if(m.authorId===currentUserId)upsertRecord(m);else void receiveText(m)}break;
case 'speech-interim':receiveSpeech(m,true);break;
case 'speech-caption':receiveSpeech(m,false);break;
case 'call-invite':
 if(typeof m.callId!=='string')break;
 if(calling){if(isInitiator&&m.callId!==activeCallId)endCall(false);else{send({type:'call-decline',callId:m.callId});break}}
 if(incomingCallId&&incomingCallId!==m.callId)break;
 incomingCallId=m.callId;mode=m.mode==='video'?'video':'audio';$('incomingMode').textContent=mode==='video'?'視訊通話':'語音通話';$('incomingTitle').textContent='寶貝正在呼叫你…';show('incomingCall',true);notifyIncoming('卡安 ❤️','正在呼叫你 · '+(mode==='video'?'視訊通話':'語音通話'));break;
case 'call-accept':if(currentSignal(m)&&isInitiator){clearTimeout(callTimer);callStatus('正在連線…');await makeOffer()}break;
case 'call-busy':if(currentSignal(m)&&isInitiator){endCall(false);status('對方正在處理另一通來電，請稍後再試')}break;
case 'call-decline':if(currentSignal(m)){endCall(false);status('對方暫時無法接聽')}break;
case 'call-end':if(currentSignal(m)||incomingCallId===m.callId)endCall(false);break;
case 'offer':{
 if(!currentSignal(m)||!pc||isInitiator)break;const peer=pc,generation=callGeneration;
 if(peer.remoteDescription?.sdp===m.sdp?.sdp)break;
 remoteReady=false;await peer.setRemoteDescription(m.sdp);if(!validCall(generation,peer))break;remoteReady=true;await flushIce(peer,generation);if(!validCall(generation,peer))break;
 const answer=await peer.createAnswer();if(!validCall(generation,peer))break;await peer.setLocalDescription(answer);if(validCall(generation,peer))send({type:'answer',callId:activeCallId,sdp:peer.localDescription});break;}
case 'answer':{
 if(!currentSignal(m)||!pc||!isInitiator)break;const peer=pc,generation=callGeneration;if(peer.signalingState!=='have-local-offer')break;
 await peer.setRemoteDescription(m.sdp);if(!validCall(generation,peer))break;remoteReady=true;await flushIce(peer,generation);break;}
case 'ice':{
 if(!currentSignal(m)||!pc)break;const peer=pc,generation=callGeneration;
 if(remoteReady&&candidateMatches(m.candidate,peer)){try{await peer.addIceCandidate(m.candidate)}catch{if(validCall(generation,peer)&&iceQueue.length<128)iceQueue.push(m.candidate)}}else if(iceQueue.length<128)iceQueue.push(m.candidate);break;}
case 'error':$('setupNotice').textContent=m.message||'房間連線失敗';if(!joined){wantReconnect=false;socket?.close();show('setup',Boolean(currentUserId));show('home',false)}break;
}}
function validCall(generation,peer=pc){return calling&&generation===callGeneration&&pc===peer&&Boolean(activeCallId)}
function candidateMatches(candidate,peer){return !candidate?.usernameFragment||!peer.remoteDescription?.sdp||peer.remoteDescription.sdp.includes('a=ice-ufrag:'+candidate.usernameFragment)}
async function flushIce(peer=pc,generation=callGeneration){const queued=iceQueue.splice(0);for(const candidate of queued){if(!validCall(generation,peer))return;if(!candidateMatches(candidate,peer))continue;try{await peer.addIceCandidate(candidate)}catch{}}}
function renderQuality(metrics){
 const fmt=(value,suffix='')=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(value<10?1:0)+suffix:'—';
 $('qualityType').textContent=metrics.connectionType==='relay'?'中繼連線':metrics.connectionType==='direct'?'直接連線':'尚未確認';
 $('qualityRTT').textContent=fmt(metrics.rttMs,' ms');$('qualityLoss').textContent=fmt(metrics.audioLossPercent,' %');$('qualityJitter').textContent=fmt(metrics.jitterMs,' ms');
 $('qualityVideo').textContent=metrics.videoWidth&&metrics.videoHeight?metrics.videoWidth+' × '+metrics.videoHeight+' · '+fmt(metrics.videoFPS,' fps'):'—';$('qualityBitrate').textContent=fmt(metrics.sendVideoBitrateKbps,' kbps');
}
async function setupCall(which,id,initiator){
 const generation=++callGeneration;activeCallId=id;incomingCallId=null;isInitiator=initiator;inviteSent=false;mode=which;calling=true;remoteReady=false;iceQueue=[];restartUsed=false;offerPending=false;videoPresetLevel=0;$('qualityPreset').textContent='標準視訊';
 localSpeechSeq=0;remoteSpeechSeq=0;++captionRevision;speechSeen.clear();speechQueue=[];
 show('call',true);show('home',false);applyFilter();show('cameraExtras',which==='video');show('incomingCall',false);show('audioBackdrop',which==='audio');show('local',which==='video');$('camera').disabled=which==='audio';$('flip').disabled=which==='audio';
 $('mute').querySelector('small').textContent='靜音';$('camera').querySelector('small').textContent='關閉鏡頭';setIncomingCaption('等待對方說話…','翻譯將顯示在這裡','對方原文 / 你的語言');callStatus('正在準備通話…');
 const configPromise=window.CallTools?CallTools.fetchRTCConfig({token:roomToken}):Promise.resolve({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],turnConfigured:false});
 let media;
 try{
 media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:which==='video'?{width:{ideal:640},height:{ideal:360},frameRate:{ideal:15,max:20},facingMode:'user'}:false});
 if(!calling||generation!==callGeneration||activeCallId!==id){media.getTracks().forEach(t=>t.stop());return false}
 stream=media;$('local').srcObject=media;const config=await configPromise;
 if(!calling||generation!==callGeneration||activeCallId!==id){media.getTracks().forEach(t=>t.stop());return false}
 $('qualityRelay').textContent=config.turnConfigured?'已配置中繼':'尚未配置 TURN；部分跨網路可能無法接通';if(config.configurationError)$('qualityNote').textContent=config.configurationError;else $('qualityNote').textContent='品質資料僅顯示統計，不顯示 IP 或完整連線候選。';
 const peer=new RTCPeerConnection({iceServers:config.iceServers,bundlePolicy:'max-bundle'}),remoteMedia=new MediaStream();pc=peer;
 for(const track of media.getTracks()){const sender=peer.addTrack(track,media);if(track.kind==='video'&&window.CallTools)void CallTools.applyVideoPreset(sender,0)}
 peer.ontrack=e=>{if(!validCall(generation,peer))return;const remoteStream=e.streams[0]||remoteMedia;if(!e.streams[0]&&!remoteMedia.getTracks().includes(e.track))remoteMedia.addTrack(e.track);$('remote').srcObject=remoteStream;try{const playback=$('remote').play();playback?.catch(()=>{if(validCall(generation,peer))show('playRemote',true)})}catch{show('playRemote',true)}};
 peer.onicecandidate=e=>{if(validCall(generation,peer)&&e.candidate)send({type:'ice',callId:id,candidate:e.candidate})};
 peer.onconnectionstatechange=()=>{if(!validCall(generation,peer))return;if(peer.connectionState==='connected'){clearTimeout(iceRestartTimer);clearTimeout(recoveryWatch);iceRestartTimer=null;recoveryWatch=null;callStatus('♡ 通話中')}else if(['failed','disconnected'].includes(peer.connectionState)){callStatus(restartUsed&&peer.connectionState==='failed'?'連線無法恢復，請結束後重撥':'網路不穩，嘗試恢復連線…');scheduleIceRestart(generation,peer)}};
 if(window.CallTools){qualityMonitor=CallTools.createQualityMonitor(peer,{onMetrics:metrics=>{if(validCall(generation,peer))renderQuality(metrics)},onPreset:result=>{if(validCall(generation,peer)){videoPresetLevel=result.level;$('qualityPreset').textContent=['標準視訊','降低視訊負載','優先音訊'][result.level]+(result.applied?'':'（瀏覽器未支援完整調整）')}},onWarning:message=>{if(validCall(generation,peer))$('qualityNote').textContent=message}});qualityMonitor.start()}
 return true;
 }catch(e){media?.getTracks().forEach(t=>t.stop());if(generation===callGeneration){const message='無法使用相機或麥克風：'+safeError(e);$('setupNotice').textContent=message;endCall(false);status(message)}return false}
}
async function makeOffer(restart=false){
 const peer=pc,generation=callGeneration,id=activeCallId;if(!peer||!isInitiator||offerPending||peer.signalingState!=='stable')return;
 offerPending=true;try{const offer=await peer.createOffer(restart?{iceRestart:true}:undefined);if(!validCall(generation,peer))return;await peer.setLocalDescription(offer);if(validCall(generation,peer))send({type:'offer',callId:id,sdp:peer.localDescription})}finally{if(generation===callGeneration)offerPending=false}
}
function scheduleIceRestart(generation,peer){
 if(!isInitiator||restartUsed||iceRestartTimer)return;iceRestartTimer=setTimeout(()=>{iceRestartTimer=null;if(!validCall(generation,peer)||peer.connectionState==='connected')return;restartUsed=true;recoveryWatch=setTimeout(()=>{if(validCall(generation,peer)&&peer.connectionState!=='connected')callStatus('連線無法恢復，請結束後重撥，並檢查中繼設定')},20000);void makeOffer(true).catch(()=>{if(validCall(generation,peer))callStatus('無法恢復連線，請結束後重撥')})},peer.connectionState==='failed'?500:4000);
}
async function dial(which){
 if(!joined||!peerOnline){status('請等寶貝進入同一個房間後再撥打');return}if(calling||mode||incomingCallId)return;
 const id=crypto.randomUUID();if(!await setupCall(which,id,true)||activeCallId!==id)return;
 callStatus('正在呼叫寶貝…');inviteSent=send({type:'call-invite',callId:id,mode:which});
 if(!inviteSent){endCall(false);return}
 callTimer=setTimeout(()=>{if(calling&&activeCallId===id&&pc?.connectionState!=='connected'){status('對方尚未接聽');endCall(true)}},45000);
}
$('audioCall').onclick=()=>{void dial('audio')};$('videoCall').onclick=()=>{void dial('video')};
$('decline').onclick=()=>{if(incomingCallId)send({type:'call-decline',callId:incomingCallId});incomingCallId=null;mode=null;show('incomingCall',false)};
$('accept').onclick=async()=>{const id=incomingCallId,which=mode;if(!id||calling)return;const ok=await setupCall(which,id,false);if(!ok){if(joined)send({type:'call-decline',callId:id});return}if(activeCallId!==id)return;callStatus('正在接聽…');send({type:'call-accept',callId:id})};
function endCall(notify=true){
 const id=activeCallId||incomingCallId;++callGeneration;++ttsGeneration;++captionRevision;calling=false;activeCallId=null;incomingCallId=null;mode=null;
 qualityMonitor?.stop();qualityMonitor=null;clearInterval(connectionWatch);connectionWatch=null;clearTimeout(callTimer);clearTimeout(iceRestartTimer);clearTimeout(recoveryWatch);iceRestartTimer=null;recoveryWatch=null;stopRecognition();abortSpeechTranslations();speechQueue=[];speechProcessing=false;++speechWorkerEpoch;speechSeen.clear();remoteSpeechSeq=0;
 speaking=false;if('speechSynthesis'in window)speechSynthesis.cancel();if(notify&&joined&&id)send({type:'call-end',callId:id});
 const peer=pc;pc=null;if(peer){peer.ontrack=null;peer.onicecandidate=null;peer.onconnectionstatechange=null;peer.close()}
 stream?.getTracks().forEach(t=>t.stop());stream=null;$('local').srcObject=null;$('remote').srcObject=null;remoteReady=false;iceQueue=[];offerPending=false;flipPending=false;
 closePhoto();show('call',false);show('incomingCall',false);show('home',joined);show('playRemote',false);$('mute').querySelector('small').textContent='靜音';$('camera').querySelector('small').textContent='關閉鏡頭';$('flip').disabled=false;
}
$('hangup').onclick=()=>endCall(true);
$('leave').onclick=()=>{disconnectPrivate();show('home',false);show('setup',Boolean(currentUserId))};
$('playRemote').onclick=()=>{const promise=$('remote').play();promise?.then(()=>show('playRemote',false)).catch(()=>callStatus('請確認手機音量與瀏覽器播放權限'))};
$('mute').onclick=()=>{const t=stream?.getAudioTracks()[0];if(!t)return;t.enabled=!t.enabled;if(!t.enabled)stopRecognition();$('mute').querySelector('small').textContent=t.enabled?'靜音':'取消靜音'};
$('camera').onclick=()=>{const t=stream?.getVideoTracks()[0];if(!t)return;t.enabled=!t.enabled;$('camera').querySelector('small').textContent=t.enabled?'關閉鏡頭':'開啟鏡頭'};
$('flip').onclick=async()=>{
 const old=stream?.getVideoTracks()[0],peer=pc,generation=callGeneration;if(!old||!peer||flipPending)return;flipPending=true;$('flip').disabled=true;let replacement,adopted=false;
 try{
 const facing=old.getSettings().facingMode==='environment'?'user':'environment';replacement=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:640},height:{ideal:360},frameRate:{ideal:15,max:20}},audio:false});const track=replacement.getVideoTracks()[0];
 if(!track||!validCall(generation,peer)){replacement.getTracks().forEach(t=>t.stop());return}const sender=peer.getSenders().find(s=>s.track?.kind==='video');if(!sender)throw Error('找不到目前鏡頭');track.enabled=old.enabled;await sender.replaceTrack(track);
 if(!validCall(generation,peer)){replacement.getTracks().forEach(t=>t.stop());return}stream.removeTrack(old);old.stop();stream.addTrack(track);adopted=true;$('local').srcObject=stream;if(window.CallTools)await CallTools.applyVideoPreset(sender,videoPresetLevel);
 }catch(e){if(validCall(generation,peer))callStatus('無法切換鏡頭：'+safeError(e))}
 finally{if(replacement&&!adopted)replacement.getTracks().forEach(t=>t.stop());if(generation===callGeneration){flipPending=false;$('flip').disabled=mode==='audio'}}
};
function stopRecognition(){
 recognizing=false;++speechGeneration;clearTimeout(speechRestartTimer);clearTimeout(previewTimer);previewTimer=null;previewText='';speechDraftId=null;speechDraftSeq=0;
 const previous=recognition;recognition=null;if(previous){previous.onresult=null;previous.onend=null;previous.onerror=null;try{previous.abort()}catch{}}
 $('mic').querySelector('small').textContent='語音字幕';$('speechStatus').textContent='語音字幕已停止';
}
function restartRecognition(instance,generation){
 if(!instance||recognition!==instance||generation!==speechGeneration||!recognizing||!calling||speaking||!stream?.getAudioTracks().some(t=>t.enabled))return;
 clearTimeout(speechRestartTimer);speechRestartTimer=setTimeout(()=>{if(recognition!==instance||generation!==speechGeneration||!recognizing||!calling||speaking)return;try{instance.start()}catch{stopRecognition();$('speechStatus').textContent='辨識暫停，請重新開啟'}},500);
}
$('mic').onclick=()=>{
 if(recognizing){stopRecognition();return}if(!calling||pc?.connectionState!=='connected'||!stream?.getAudioTracks().some(t=>t.enabled)){$('speechStatus').textContent='請先接通電話並開啟麥克風';return}
 const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SpeechRecognition){$('speechStatus').textContent='此瀏覽器不支援語音辨識，可使用文字訊息';return}
 const instance=new SpeechRecognition(),generation=++speechGeneration,callId=activeCallId,callEpoch=callGeneration;let emptyRestarts=0,hadResult=false;
 recognition=instance;instance.lang={en:'en-US',sr:'sr-RS',sv:'sv-SE',fr:'fr-FR',es:'es-ES',ja:'ja-JP',ko:'ko-KR',de:'de-DE',tr:'tr-TR'}[lang]||lang;instance.continuous=true;instance.interimResults=true;
 const valid=()=>recognition===instance&&generation===speechGeneration&&recognizing&&calling&&activeCallId===callId&&callGeneration===callEpoch;
 const newDraft=()=>{if(!speechDraftId){speechDraftId=crypto.randomUUID();speechDraftSeq=++localSpeechSeq}};
 instance.onresult=e=>{
 if(!valid()||speaking)return;hadResult=true;let interim='';
 for(let i=e.resultIndex;i<e.results.length;i++){const result=e.results[i],text=result[0]?.transcript?.trim();if(!text)continue;newDraft();
 if(result.isFinal){clearTimeout(previewTimer);previewTimer=null;previewText='';if(text.length<=500)send({type:'speech-caption',callId,id:speechDraftId,seq:speechDraftSeq,text,lang});else $('speechStatus').textContent='這句較長，請停頓後分句說話';speechDraftId=null;speechDraftSeq=0}else interim+=text;
 }
 if(interim){newDraft();$('speechStatus').textContent='正在辨識你的語音…';previewText=interim.slice(0,300);const publish=()=>{previewTimer=null;if(valid()&&!speaking&&previewText&&speechDraftId){lastPreviewAt=Date.now();send({type:'speech-interim',callId,id:speechDraftId,seq:speechDraftSeq,text:previewText,lang})}};
 if(Date.now()-lastPreviewAt>1100)publish();else if(!previewTimer)previewTimer=setTimeout(publish,1100)
 }else $('speechStatus').textContent='正在聆聽，停頓後傳送字幕';
 };
 instance.onend=()=>{if(!valid()||speaking)return;if(hadResult){emptyRestarts=0;hadResult=false}else emptyRestarts++;if(emptyRestarts>=3){stopRecognition();$('speechStatus').textContent='語音辨識多次中斷，請重新開啟或改用文字';return}restartRecognition(instance,generation)};
 instance.onerror=e=>{if(!valid())return;if(e.error==='no-speech')return;stopRecognition();$('speechStatus').textContent='語音辨識暫停：'+e.error+'；通話仍可繼續'};
 try{recognizing=true;instance.start();$('mic').querySelector('small').textContent='停止字幕';$('speechStatus').textContent='正在聆聽，停頓後分享字幕；建議使用耳機避免回音'}catch(e){stopRecognition();$('speechStatus').textContent='無法啟動辨識：'+safeError(e)}
};

const effects={none:'none',mono:'grayscale(1)',soft:'brightness(1.07) contrast(.94) saturate(1.06)',bright:'brightness(1.18) contrast(1.05)',vintage:'sepia(.45) contrast(.9) saturate(.75)'};
function applyFilter(){const effect=effects[$('filterSelect').value]||'none';$('local').style.filter=effect}
$('filterSelect').onchange=applyFilter;
function closePhoto(){show('photoPreview',false);if(photoURL)URL.revokeObjectURL(photoURL);photoURL=null;photoBlob=null;$('photoImage').removeAttribute('src')}
$('closePhoto').onclick=closePhoto;
$('snapshot').onclick=()=>{const video=$('local');if(!calling||mode!=='video'||!video.videoWidth){alert('請先開啟視訊，等待自己的畫面出現');return}try{const snapshotGeneration=callGeneration;const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const ctx=canvas.getContext('2d');if(!ctx)throw Error('無法使用拍照功能');ctx.filter=effects[$('filterSelect').value]||'none';ctx.drawImage(video,0,0,canvas.width,canvas.height);canvas.toBlob(blob=>{if(snapshotGeneration!==callGeneration||!calling)return;if(!blob){alert('照片建立失敗');return}closePhoto();photoBlob=blob;photoURL=URL.createObjectURL(blob);$('photoImage').src=photoURL;show('photoPreview',true)},'image/jpeg',.92)}catch(e){alert('拍照失敗：'+safeError(e))}};
$('savePhoto').onclick=async()=>{if(!photoBlob)return;const file=new File([photoBlob],'our-little-world-'+Date.now()+'.jpg',{type:'image/jpeg'});try{if(navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:'Our Little World'});return}}catch(e){if(e.name==='AbortError')return}const a=document.createElement('a');a.href=photoURL;a.download=file.name;document.body.append(a);a.click();a.remove();$('photoHint').textContent='如果 iPhone 沒有直接儲存，請長按照片選擇「儲存到照片」。'};
window.addEventListener('pagehide',()=>{suspended=true;endCall(true);clearTimeout(reconnectTimer);socket?.close()});
window.addEventListener('pageshow',()=>{suspended=false;if(currentUserId&&wantReconnect&&reconnectTarget&&!joined)void connect(reconnectTarget)});
window.addEventListener('beforeunload',()=>{suspended=true;endCall(true);socket?.close()});

$('historyMore').onclick=()=>{void loadOlderHistory()};
setInterval(()=>{flushOutbox();updateWorldClocks()},5000);updateWorldClocks();
window.addEventListener('online',()=>{void window.WorldAuth?.ready();if(wantReconnect&&reconnectTarget&&!joined)void connect(reconnectTarget)});
if(window.WorldAuth){window.WorldAuth.subscribe(value=>{if(value.status==='network-error'&&!value.user&&currentUserId)return;const id=value.user?.id||null;if(id===currentUserId)return;const previous=currentUserId;disconnectPrivate();currentUserId=id;++authEpoch;records.clear();outbox.clear();currentRoom='';reconnectTarget=null;lastJoinTarget=null;$('chatlog').replaceChildren();nextHistoryCursor=null;updateHistoryButton();show('home',false);show('setup',Boolean(id));if(id)void resumePrivate(id,authEpoch);else if(previous)status('已登出，聊天紀錄仍保存在伺服器')});void window.WorldAuth.ready()}
