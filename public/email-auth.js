// Staged email OTP UI. Do not enable until authenticated room access is implemented.
const el=id=>document.getElementById(id),auth=el('emailAuth'),req=el('emailAuthRequest'),verify=el('emailAuthVerify'),note=el('emailAuthNotice'),email=el('emailAuthAddress'),code=el('emailAuthCode'),logout=el('emailAuthLogout');
const say=s=>note.textContent=s;
let client=null;
try{
 const r=await fetch('/api/auth-config',{cache:'no-store'}),cfg=await r.json();
 if(cfg.enabled){
  const {createClient}=await import('https://esm.sh/@supabase/supabase-js@2');
  client=createClient(cfg.url,cfg.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  auth.classList.remove('hidden');el('cover').classList.add('hidden');
  const {data:{user}}=await client.auth.getUser();
  if(user){req.classList.add('hidden');logout.classList.remove('hidden');say('已登入 '+(user.email||'')+'。私人房間功能尚待安全權限完成。')}
 }
}catch(e){console.error('Email auth initialization failed',e)}
req.addEventListener('submit',async e=>{e.preventDefault();if(!client)return;const btn=req.querySelector('button');btn.disabled=true;say('正在寄送驗證碼…');try{const {error}=await client.auth.signInWithOtp({email:email.value.trim(),options:{shouldCreateUser:true}});if(error)throw error;req.classList.add('hidden');verify.classList.remove('hidden');say('請檢查信箱及垃圾郵件。')}catch(err){say('寄送失敗：'+err.message)}finally{btn.disabled=false}});
verify.addEventListener('submit',async e=>{e.preventDefault();if(!client)return;const btn=verify.querySelector('button');btn.disabled=true;say('正在驗證…');try{const {data,error}=await client.auth.verifyOtp({email:email.value.trim(),token:code.value.trim(),type:'email'});if(error)throw error;if(!data.user)throw Error('無法確認登入');verify.classList.add('hidden');logout.classList.remove('hidden');say('登入成功！私人房間尚待安全權限完成。')}catch(err){say('驗證失敗：'+err.message)}finally{btn.disabled=false}});
el('emailAuthBack').onclick=()=>{verify.classList.add('hidden');req.classList.remove('hidden');code.value='';say('')};
logout.onclick=async()=>{if(!client)return;await client.auth.signOut();logout.classList.add('hidden');req.classList.remove('hidden');say('已登出')};
