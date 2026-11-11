/* Supabase email/password sessions. The server verifies every private-room access. */
(function () {
 'use strict';
 const STORAGE_KEY='olw-auth-session',listeners=new Set();
 let config=null,session=null,currentUser=null,initialization=null,refreshJob=null,epoch=0;
 let state='loading',message='正在確認登入狀態…',remembered=true;
 class AuthError extends Error{constructor(text,status=0){super(text);this.status=status}}
 const savedSession=()=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'null')}catch{return null}};
 const validSession=value=>value&&typeof value==='object'&&typeof value.access_token==='string'&&value.access_token.length<12000&&typeof value.refresh_token==='string'&&value.refresh_token.length<12000&&Number.isFinite(value.expires_at)&&value.project===config?.url;
 function persist(){try{if(session)localStorage.setItem(STORAGE_KEY,JSON.stringify(session));else localStorage.removeItem(STORAGE_KEY);remembered=true}catch{remembered=false}}
 function snapshot(){return {user:currentUser?{id:currentUser.id,email:currentUser.email}:null,configured:config?.configured===true,status:state,message,remembered}}
 function emit(){const value=snapshot();render(value);for(const listener of listeners)try{listener(value)}catch{}}
 function setState(next,text){state=next;message=text;emit()}
 function clearSession(text='請使用已獲授權的帳號登入。'){++epoch;session=null;currentUser=null;refreshJob=null;persist();setState('signed-out',text)}
 function safeFailure(error){if(error?.name==='AbortError')return '登入服務連線逾時，請重試。';if(error?.status===400||error?.status===401||error?.status===403)return '登入資料無效或登入已過期，請重新登入。';if(error?.status===429)return '登入嘗試過於頻繁，請稍後重試。';return '目前無法連接登入服務，請檢查網路後重試。'}
 async function request(url,options={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch(url,{...options,signal:controller.signal,cache:'no-store'});let value;try{value=await response.json()}catch{throw new AuthError('登入服務回應格式錯誤。',response.status)}
   if(!response.ok)throw new AuthError('登入服務拒絕請求。',response.status);return value;
  }finally{clearTimeout(timer)}
 }
 function authRequest(path,body,token){return request(config.url+'/auth/v1/'+path,{method:body?'POST':'GET',headers:{apikey:config.anonKey,...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})})}
 function normalize(value){if(!value||typeof value.access_token!=='string'||!value.access_token||typeof value.refresh_token!=='string'||!value.refresh_token)throw new AuthError('登入回應不完整。');return {access_token:value.access_token,refresh_token:value.refresh_token,expires_at:Number(value.expires_at)||Math.floor(Date.now()/1000)+(Number(value.expires_in)||3600),project:config.url}}
 function userRecord(value){if(!value||typeof value.id!=='string'||!value.id||(!value.email_confirmed_at&&!value.confirmed_at))throw new AuthError('帳號尚未完成確認。',403);return {id:value.id,email:typeof value.email==='string'?value.email:''}}
 async function refresh(){
  if(refreshJob)return refreshJob;
  const ticket=epoch,refreshToken=session?.refresh_token;if(!refreshToken)return null;
  const job=(async()=>{try{const value=await authRequest('token?grant_type=refresh_token',{refresh_token:refreshToken});if(ticket!==epoch)return null;session=normalize(value);persist();return session.access_token}
   catch(error){if(ticket===epoch&&(error.status===400||error.status===401||error.status===403))clearSession('登入已過期，請重新登入。');throw error}
   finally{if(refreshJob===job)refreshJob=null}})();refreshJob=job;return job;
 }
 async function verify(){
  if(!session)return null;
  const ticket=epoch;
  try{if(session.expires_at<=Date.now()/1000+60)await refresh();if(ticket!==epoch||!session)return null;
   const value=await authRequest('user',null,session.access_token);if(ticket!==epoch||!session)return null;
   currentUser=userRecord(value);setState('authenticated',remembered?'已登入私人聊天室。':'已登入；此瀏覽器無法記住登入狀態。');return session.access_token;
  }catch(error){if(ticket!==epoch)return null;if(error.status===400||error.status===401||error.status===403)clearSession('登入已失效，請重新登入。');else{currentUser=null;setState('network-error',safeFailure(error))}throw error}
 }
 async function ready(){
  if(initialization)return initialization;
  if(config&&state!=='network-error')return snapshot();
  initialization=(async()=>{try{
   if(!config){
    const value=await request('/api/auth/config');
    if(value?.configured!==true){config={configured:false};setState('not-configured','私人登入與資料庫尚未設定，請先完成伺服器設定。');return snapshot()}
    const url=new URL(value.url);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||typeof value.anonKey!=='string'||!value.anonKey)throw new AuthError('登入設定不完整。');
    config={configured:true,url:url.origin,anonKey:value.anonKey};const stored=savedSession();session=validSession(stored)?stored:null;
    if(stored&&!session)persist();
   }
   if(session)await verify();else setState('signed-out','請使用已獲授權的帳號登入。');
  }catch(error){if(state!=='signed-out'&&state!=='network-error')setState('network-error',safeFailure(error))}return snapshot()})();
  const job=initialization;try{return await job}finally{if(initialization===job)initialization=null}
 }
 async function signIn(email,password){
  await ready();if(!config?.configured)throw new AuthError('私人登入尚未設定。');
  if(typeof email!=='string'||!email.trim()||typeof password!=='string'||!password)throw new AuthError('請輸入 Email 和密碼。',400);
  const ticket=++epoch;currentUser=null;session=null;refreshJob=null;persist();setState('signing-in','正在登入…');
  try{const value=await authRequest('token?grant_type=password',{email:email.trim(),password});if(ticket!==epoch)return null;
   session=normalize(value);persist();await verify();return currentUser;
  }catch(error){if(ticket===epoch){if(error.status===400||error.status===401||error.status===403){session=null;persist()}currentUser=null;setState('signed-out',safeFailure(error))}throw error}
 }

 async function sendOtp(email){
  await ready();if(!config?.configured)throw new AuthError('私人登入尚未設定。');
  if(typeof email!=='string'||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email.trim()))throw new AuthError('請輸入有效的 Email。',400);
  setState('signing-in','正在寄送驗證碼…');
  try{
   // shouldCreateUser:false prevents an arbitrary email from registering a new account.
   await authRequest('otp',{email:email.trim(),create_user:false});
   setState('signed-out','如果這個 Email 已獲授權，請查看信箱中的驗證碼。');
  }catch(error){setState('signed-out',safeFailure(error));throw error}
 }
 async function verifyOtp(email,token){
  await ready();if(!config?.configured)throw new AuthError('私人登入尚未設定。');
  if(typeof email!=='string'||typeof token!=='string'||!/^[0-9]{8}$/.test(token.trim()))throw new AuthError('請輸入 8 位數驗證碼。',400);
  const ticket=++epoch;currentUser=null;session=null;refreshJob=null;persist();setState('signing-in','正在驗證…');
  try{
   const value=await authRequest('verify',{email:email.trim(),token:token.trim(),type:'email'});
   if(ticket!==epoch)return null;
   session=normalize(value);persist();await verify();return currentUser;
  }catch(error){if(ticket===epoch){session=null;persist();currentUser=null;setState('signed-out',safeFailure(error))}throw error}
 }
 async function signOut(){
  const token=session?.access_token;clearSession('已登出。伺服器上的聊天紀錄會保留。');
  if(token&&config?.configured)try{await request(config.url+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:config.anonKey,Authorization:'Bearer '+token}})}catch{}
 }
 async function accessToken(){await ready();if(!config?.configured||!session)return null;if(!currentUser)return verify();if(session.expires_at<=Date.now()/1000+60){await refresh();if(!session)return null;return verify()}return session.access_token}
 function subscribe(listener){listeners.add(listener);listener(snapshot());return ()=>listeners.delete(listener)}
 function render(value){const status=document.getElementById('authStatus'),form=document.getElementById('authForm'),signInButton=document.getElementById('authSignIn'),signOutButton=document.getElementById('authSignOut');if(status)status.textContent=value.message;if(form)form.classList.toggle('hidden',Boolean(value.user));if(signInButton)signInButton.disabled=value.status==='loading'||value.status==='signing-in'||value.status==='not-configured';if(signOutButton)signOutButton.classList.toggle('hidden',!value.user)}
 const form=document.getElementById('authForm');if(form)form.addEventListener('submit',async event=>{event.preventDefault();try{await sendOtp(document.getElementById('authEmail').value);document.getElementById('authOtpForm')?.classList.remove('hidden')}catch{}});
 const otpForm=document.getElementById('authOtpForm');if(otpForm)otpForm.addEventListener('submit',async event=>{event.preventDefault();const input=document.getElementById('authOtpCode');try{await verifyOtp(document.getElementById('authEmail').value,input.value)}catch{}finally{input.value=''}});
 document.getElementById('authSignOut')?.addEventListener('click',()=>{void signOut()});
 window.addEventListener('storage',event=>{if(event.key!==STORAGE_KEY||!config?.configured)return;++epoch;refreshJob=null;currentUser=null;const stored=savedSession();session=validSession(stored)?stored:null;if(!session)setState('signed-out','已在其他分頁登出。');else void verify().catch(()=>{})});
 window.WorldAuth={ready,signIn,sendOtp,verifyOtp,signOut,accessToken,user:()=>currentUser?{...currentUser}:null,subscribe};
 void ready();
})();
