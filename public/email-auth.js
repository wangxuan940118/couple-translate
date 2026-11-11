/* Public Supabase keys identify the project; only verified user JWTs authorize rooms. */
(function () {
 'use strict';
 const STORE='olw-email-auth-session',subscribers=new Set(),$=id=>document.getElementById(id);
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 let config=null,session=null,currentUser=null,initializing=null,refreshing=null,validating=null,epoch=0;
 let status='loading',message='正在確認登入狀態…',requestedEmail='',nextCodeAt=0,refreshTimer=null;
 class AuthError extends Error{constructor(text,httpStatus=0){super(text);this.status=httpStatus}}
 const readStored=()=>{try{return JSON.parse(localStorage.getItem(STORE)||'null')}catch{return null}};
 const tokenShape=v=>typeof v==='string'&&v.length>0&&v.length<12000&&!/\s/.test(v)&&!v.startsWith('sb_');
 const validStored=v=>v&&v.project===config?.url&&tokenShape(v.access_token)&&tokenShape(v.refresh_token)&&Number.isFinite(v.expires_at)&&UUID.test(v.user_id||'');
 const liveUser=()=>currentUser&&session&&session.expires_at>Date.now()/1000?{...currentUser}:null;
 function snapshot(){return {user:liveUser(),status,configured:config?.enabled===true,message}}
 function remember(){try{if(session)localStorage.setItem(STORE,JSON.stringify(session));else localStorage.removeItem(STORE)}catch{}}
 function stopTimer(){if(refreshTimer!==null)clearTimeout(refreshTimer);refreshTimer=null}
 function publish(next,text){status=next;message=text;const value=snapshot();render(value);for(const listener of subscribers)try{listener(value)}catch{}}
 function cancelJobs(){++epoch;refreshing=null;validating=null;stopTimer()}
 function clearSession(text='請使用已獲授權的 Email 登入。'){cancelJobs();session=null;currentUser=null;requestedEmail='';remember();publish('signed-out',text)}
 function failureText(error){if(error?.status===429)return '登入嘗試過於頻繁，請稍後重試。';if(error?.status===401)return '登入已過期，請重新取得驗證碼。';if(error?.status===403)return '這個帳號未獲私人聊天室授權。';if(error?.status===400)return '驗證碼無效或已過期，請重新確認。';if(error?.name==='AbortError')return '登入服務連線逾時，請重試。';return '目前無法連接登入服務，請檢查網路後重試。'}
 async function request(url,options={}){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch(url,{...options,signal:controller.signal,cache:'no-store'});let data=null;
   if(response.status!==204){try{data=await response.json()}catch{if(response.ok)throw new AuthError('登入服務回應格式錯誤。')}}
   if(!response.ok)throw new AuthError('登入請求失敗。',response.status);return data;
  }finally{clearTimeout(timeout)}
 }
 function provider(path,{body,token,method}={}){return request(config.url+'/auth/v1/'+path,{method:method||(body?'POST':'GET'),headers:{apikey:config.publishableKey,...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})})}
 function publicKey(value){if(typeof value!=='string'||!value||value.startsWith('sb_secret_'))return false;if(/^sb_publishable_[A-Za-z0-9_-]+$/.test(value))return true;
  try{const parts=value.split('.');if(parts.length!==3)return false;const payload=JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));return payload.role==='anon'}catch{return false}
 }
 function normalize(value){if(!value||!tokenShape(value.access_token)||!tokenShape(value.refresh_token))throw new AuthError('登入回應不完整。');
  const expires=Number(value.expires_at)||(Date.now()/1000+Number(value.expires_in||3600));if(!Number.isFinite(expires)||expires<=Date.now()/1000)throw new AuthError('登入已過期。',401);
  return {access_token:value.access_token,refresh_token:value.refresh_token,expires_at:expires,project:config.url};
 }
 function authFailure(error,ticket){if(ticket!==epoch)return;if([400,401,403].includes(error?.status)){clearSession(failureText(error));return}publish(session&&session.expires_at<=Date.now()/1000?'session-expired':'network-error',failureText(error));scheduleRefresh()}
 async function checked(candidate,ticket){
  const remote=await provider('user',{token:candidate.access_token});if(ticket!==epoch)return null;
  if(!UUID.test(remote?.id||'')||(!remote.email_confirmed_at&&!remote.confirmed_at))throw new AuthError('帳號尚未確認。',403);
  const local=await request('/api/session',{headers:{Authorization:'Bearer '+candidate.access_token}});if(ticket!==epoch)return null;
  if(local?.user?.id!==remote.id)throw new AuthError('私人帳號驗證失敗。',403);
  if(candidate.user_id&&candidate.user_id!==remote.id)throw new AuthError('登入身分已變更。',401);
  const expires=typeof local.expiresAt==='number'?local.expiresAt:(typeof local.expiresAt==='string'?Date.parse(local.expiresAt)/1000:NaN);
  const seconds=expires>1e12?expires/1000:expires;if(Number.isFinite(seconds))candidate.expires_at=Math.min(candidate.expires_at,seconds);
  if(candidate.expires_at<=Date.now()/1000)throw new AuthError('登入已過期。',401);
  candidate.user_id=remote.id;session=candidate;currentUser={id:remote.id,email:typeof local.user.email==='string'?local.user.email:typeof remote.email==='string'?remote.email:''};remember();requestedEmail='';publish('authenticated','已安全登入私人聊天室。');scheduleRefresh();return candidate.access_token;
 }
 async function verifySaved(){if(validating)return validating;if(!session)return null;const ticket=epoch,candidate={...session};
  const job=(async()=>{try{return await checked(candidate,ticket)}catch(error){authFailure(error,ticket);throw error}finally{if(validating===job)validating=null}})();validating=job;return job;
 }
 async function refresh(){if(refreshing)return refreshing;if(!session)return null;const ticket=epoch,original={...session};
  const run=async()=>{if(ticket!==epoch)return null;const stored=readStored();let refreshToken=original.refresh_token;if(validStored(stored)&&stored.user_id===original.user_id&&stored.refresh_token!==original.refresh_token){if(stored.expires_at>Date.now()/1000+60)return checked({...stored},ticket);refreshToken=stored.refresh_token}
   const value=await provider('token?grant_type=refresh_token',{body:{refresh_token:refreshToken}});if(ticket!==epoch)return null;
   const candidate=normalize(value);candidate.user_id=original.user_id;
   // Retain a rotated refresh token through temporary membership-service outages.
   // Keep the previous access-token expiry until server authorization succeeds.
   session.refresh_token=candidate.refresh_token;remember();return checked(candidate,ticket);
  };
  const job=(async()=>{try{return await (typeof navigator!=='undefined'&&navigator.locks?.request?navigator.locks.request('olw-email-auth-refresh',run):run())}catch(error){authFailure(error,ticket);throw error}finally{if(refreshing===job)refreshing=null}})();refreshing=job;return job;
 }
 function scheduleRefresh(){stopTimer();if(!session||!currentUser)return;const remaining=session.expires_at*1000-Date.now();if(remaining<=0){publish('session-expired','登入已過期；連線恢復後會重新驗證。');return}
  const delay=remaining>65000?remaining-60000:Math.min(10000,remaining+10);refreshTimer=setTimeout(()=>{refreshTimer=null;void accessToken().catch(()=>{})},Math.max(1000,delay));
 }
 async function ready(){if(initializing)return initializing;if(config&&status!=='network-error'&&status!=='session-expired')return snapshot();
  initializing=(async()=>{try{if(!config){const value=await request('/api/auth-config');if(value?.enabled!==true){config={enabled:false};publish('not-configured','私人登入尚未設定，請先完成伺服器設定。');return snapshot()}
    const url=new URL(value.url);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!publicKey(value.publishableKey)||value.otpLength!==8)throw new AuthError('私人登入設定無效。');
    config={enabled:true,url:url.origin,publishableKey:value.publishableKey,otpLength:8};const stored=readStored();session=validStored(stored)?stored:null;if(stored&&!session)remember();
   }
   if(session){if(session.expires_at<=Date.now()/1000+60)await refresh();else await verifySaved()}else publish('signed-out','請使用已獲授權的 Email 登入。');
  }catch(error){if(status==='loading')publish('network-error',failureText(error))}return snapshot()})();const job=initializing;try{return await job}finally{if(initializing===job)initializing=null}
 }
 function address(value){const email=typeof value==='string'?value.trim().toLowerCase():'';if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new AuthError('請輸入有效的 Email。',400);return email}
 async function requestCode(value){const intent=epoch;await ready();if(intent!==epoch)return null;if(!config?.enabled)throw new AuthError('私人登入尚未設定。');if(liveUser())throw new AuthError('你已經登入。',409);
  const email=address(value),seconds=Math.ceil((nextCodeAt-Date.now())/1000);if(seconds>0)throw new AuthError('請等 '+seconds+' 秒後再寄送驗證碼。',429);
  const ticket=++epoch;publish('sending-code','正在寄送驗證碼…');
  try{await provider('otp',{body:{email,create_user:false}});if(ticket!==epoch)return null;requestedEmail=email;nextCodeAt=Date.now()+60000;publish('code-sent','請檢查信箱及垃圾郵件，輸入 8 位數驗證碼。');return {email,retryAfter:60}}
  catch(error){if(ticket!==epoch)return null;publish('signed-out',failureText(error));throw error}
 }
 async function verifyCode(value,code){const intent=epoch;await ready();if(intent!==epoch)return null;if(!config?.enabled)throw new AuthError('私人登入尚未設定。');const email=address(value);
  if(typeof code!=='string'||!/^\d{8}$/.test(code.trim()))throw new AuthError('請輸入完整的 8 位數驗證碼。',400);if(requestedEmail&&requestedEmail!==email)throw new AuthError('請返回重新寄送驗證碼。',400);
  const ticket=++epoch;publish('verifying','正在驗證私人帳號…');
  try{const value=await provider('verify',{body:{email,token:code.trim(),type:'email'}});if(ticket!==epoch)return null;const token=await checked(normalize(value),ticket);return token?liveUser():null}
  catch(error){if(ticket!==epoch)return null;if(session)authFailure(error,ticket);else publish([401,403].includes(error?.status)?'signed-out':'code-sent',failureText(error));throw error}
 }
 async function signOut(){const token=session?.access_token;clearSession('已從此瀏覽器登出；伺服器上的聊天紀錄會保留。');if(!token||!config?.enabled)return {revoked:true};const ticket=epoch;
  try{await provider('logout?scope=local',{method:'POST',token});return {revoked:true}}
  catch{if(ticket===epoch)publish('signed-out','此瀏覽器已登出；網路未能確認伺服器撤銷登入。');return {revoked:false}}
 }
 async function accessToken(){await ready();if(!config?.enabled||!session)return null;if(session.expires_at<=Date.now()/1000+60)return refresh();if(!liveUser())return verifySaved();return session.access_token}
 function subscribe(callback){subscribers.add(callback);callback(snapshot());return ()=>subscribers.delete(callback)}
 function render(value){const authenticated=Boolean(value.user);if(authenticated)$('emailAuth')?.classList.add('hidden');
  if($('emailAuthNotice'))$('emailAuthNotice').textContent=value.message;if($('emailAuthLogout'))$('emailAuthLogout').classList.toggle('hidden',!authenticated);
  const verifyVisible=!authenticated&&['code-sent','verifying'].includes(value.status);$('emailAuthRequest')?.classList.toggle('hidden',authenticated||verifyVisible);$('emailAuthVerify')?.classList.toggle('hidden',!verifyVisible);
  const busy=['loading','sending-code','verifying','not-configured'].includes(value.status);for(const id of ['emailAuthRequest','emailAuthVerify']){const button=$(id)?.querySelector('button[type="submit"],button:not([type])');if(button)button.disabled=busy}
 }
 $('emailAuthRequest')?.addEventListener('submit',async event=>{event.preventDefault();try{await requestCode($('emailAuthAddress').value)}catch(error){if($('emailAuthNotice'))$('emailAuthNotice').textContent=error.status===429&&error.message.startsWith('請等 ')?error.message:failureText(error)}});
 $('emailAuthVerify')?.addEventListener('submit',async event=>{event.preventDefault();try{await verifyCode(requestedEmail||$('emailAuthAddress').value,$('emailAuthCode').value)}catch(error){if($('emailAuthNotice'))$('emailAuthNotice').textContent=failureText(error)}finally{if($('emailAuthCode'))$('emailAuthCode').value=''}});
 $('emailAuthBack')?.addEventListener('click',()=>{cancelJobs();requestedEmail='';if($('emailAuthCode'))$('emailAuthCode').value='';publish('signed-out','請輸入要使用的 Email。')});
 $('emailAuthLogout')?.addEventListener('click',()=>{void signOut()});
 window.addEventListener('storage',event=>{if(event.key!==STORE||!config?.enabled)return;const oldUser=currentUser;cancelJobs();const stored=readStored();session=validStored(stored)?stored:null;
  if(!session){currentUser=null;publish('signed-out','已在其他分頁登出。');return}currentUser=oldUser?.id===session.user_id?oldUser:null;publish('loading','正在同步登入狀態…');void (session.expires_at<=Date.now()/1000+60?refresh():verifySaved()).catch(()=>{});
 });
 window.addEventListener('online',()=>{void ready()});
 window.WorldAuth={ready,accessToken,user:liveUser,subscribe,requestCode,verifyCode,signOut};
 void ready();
})();
