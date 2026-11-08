const $=id=>document.getElementById(id);
let lang='zh-TW',socket,pc,stream,recognition,listening=false,joined=false,speaking=false,speakToken=0,remoteSet=false,pendingIce=[],chain=Promise.resolve();
const other=()=>lang==='zh-TW'?'en':'zh-TW';
$('zh').onclick=()=>choose('zh-TW');$('en').onclick=()=>choose('en');
function choose(l){lang=l;$('zh').classList.toggle('selected',l==='zh-TW');$('en').classList.toggle('selected',l==='en')}
$('random').onclick=()=>{const abc='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',b=new Uint32Array(10);crypto.getRandomValues(b);$('room').value=Array.from(b,n=>abc[n%abc.length]).join('')};
function status(s){$('status').textContent=s}function notice(s){$('notice').textContent=s}
function send(m){if(socket?.readyState===1)socket.send(JSON.stringify(m))}
async function translate(text,from,to){if(from===to)return text;const r=await fetch('/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,from,to})});const d=await r.json();if(!r.ok)throw Error(d.error||'翻譯失敗');return d.translation}
async function start(){const room=$('room').value.trim().toUpperCase();if(!/^[A-Z0-9]{6,20}$/.test(room)){alert('請輸入 6–20 位英數字房間代碼');return}try{
 stream=await navigator.mediaDevices.getUserMedia({audio:true,video:true});$('local').srcObject=stream;
 $('setup').classList.add('hidden');$('call').classList.remove('hidden');status('正在加入私人房間…');
 remoteSet=false;pendingIce=[];pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});stream.getTracks().forEach(t=>pc.addTrack(t,stream));pc.ontrack=e=>{$('remote').srcObject=e.streams[0]};pc.onicecandidate=e=>{if(e.candidate)send({type:'ice',candidate:e.candidate})};pc.onconnectionstatechange=()=>{if(pc.connectionState==='connected')status('♡ 已連線，可以開始聊天');else if(['failed','disconnected'].includes(pc.connectionState))status('連線中斷，請重新加入房間')};
 socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);socket.onopen=()=>send({type:'join',room});socket.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}chain=chain.then(()=>handleMessage(m));};
 async function handleMessage(m){try{
 if(m.type==='joined'){joined=true;status(m.count===1?'等待對方加入…':'正在連線…')}
 if(m.type==='peer-joined'){const offer=await pc.createOffer();await pc.setLocalDescription(offer);send({type:'offer',sdp:pc.localDescription})}
 if(m.type==='offer'){await pc.setRemoteDescription(m.sdp);await flushIce();const answer=await pc.createAnswer();await pc.setLocalDescription(answer);send({type:'answer',sdp:pc.localDescription})}
 if(m.type==='answer'){await pc.setRemoteDescription(m.sdp);await flushIce()}
 if(m.type==='ice'){if(remoteSet)await pc.addIceCandidate(m.candidate);else pendingIce.push(m.candidate)}
 if(m.type==='caption')receiveCaption(m);/* 不 await，避免翻譯等待卡住連線訊號 */
 if(m.type==='peer-left'){status('對方已離開');$('remote').srcObject=null}
 if(m.type==='error'){alert(m.message);leave()}
 }catch(err){notice('連線處理問題：'+err.message)}}
 async function flushIce(){remoteSet=true;const q=pendingIce;pendingIce=[];for(const c of q){try{await pc.addIceCandidate(c)}catch{}}}
 socket.onerror=()=>status('連線失敗，請檢查伺服器');socket.onclose=()=>{if(joined)status('伺服器連線已中斷')};
 }catch(e){alert('無法開啟鏡頭／麥克風：'+e.message);leave()}}
$('join').onclick=start;
async function sendCaption(text){text=text.trim();if(!text)return;$('outgoing').textContent=text;send({type:'caption',text,lang});}
async function receiveCaption(m){$('original').textContent=m.text;try{const translated=await translate(m.text,m.lang,lang);$('incoming').textContent=translated;if($('speak').checked&&'speechSynthesis'in window){speechSynthesis.cancel();const token=++speakToken;const u=new SpeechSynthesisUtterance(translated);u.lang=lang==='zh-TW'?'zh-TW':'en-US';u.rate=.9;const done=()=>{if(token!==speakToken)return;speaking=false;if(listening){try{recognition.start()}catch{}}};u.onend=done;u.onerror=done;speaking=true;if(listening){try{recognition.stop()}catch{}}speechSynthesis.speak(u)}}catch(e){$('incoming').textContent=m.text+'（翻譯暫時不可用）';notice('翻譯服務出錯：'+e.message)}}
function beginRecognition(){const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SpeechRecognition){notice('此瀏覽器不支援語音辨識。請使用下方文字輸入，或在電腦 Chrome 測試。');return}
 listening=true;recognition=new SpeechRecognition();recognition.lang=lang==='zh-TW'?'zh-TW':'en-US';recognition.continuous=true;recognition.interimResults=true;
 recognition.onresult=e=>{let interim='';for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)sendCaption(t);else interim+=t}if(interim)$('outgoing').textContent=interim+' …'};
 recognition.onerror=e=>notice('語音辨識：'+e.error+'。可改用文字輸入。');recognition.onend=()=>{if(listening&&!speaking){try{recognition.start()}catch{}}};try{recognition.start();$('mic').textContent='⏸️ 停止逐句翻譯';notice('正在辨識你的聲音；停頓後會傳送字幕。')}catch(e){listening=false;notice(e.message)}}
$('mic').onclick=()=>{if(listening){listening=false;recognition?.stop();$('mic').textContent='🎙️ 開啟逐句翻譯'}else beginRecognition()};
$('manual').onsubmit=e=>{e.preventDefault();const t=$('message').value;if(t.trim()){sendCaption(t);$('message').value=''}};
$('mute').onclick=()=>{const t=stream?.getAudioTracks()[0];if(t){t.enabled=!t.enabled;$('mute').textContent=t.enabled?'關閉麥克風':'開啟麥克風'}};
$('camera').onclick=()=>{const t=stream?.getVideoTracks()[0];if(t){t.enabled=!t.enabled;$('camera').textContent=t.enabled?'關閉鏡頭':'開啟鏡頭'}};
function leave(){listening=false;recognition?.stop();socket?.close();pc?.close();stream?.getTracks().forEach(t=>t.stop());$('call').classList.add('hidden');$('setup').classList.remove('hidden');joined=false}
$('leave').onclick=leave;window.addEventListener('beforeunload',()=>{stream?.getTracks().forEach(t=>t.stop())});
