'use strict';
const crypto=require('node:crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGUAGES=new Set(['zh-TW','en','sv','sr','fr','es','ja','ko','de','tr']);
function failure(code,message,status=503){return Object.assign(new Error(message),{code,status})}
function isObject(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value)}
// This is a configuration guard, not JWT authentication. Only the publishable
// key or an explicitly anon legacy JWT may ever reach browser configuration.
function publicAnonKey(value,serviceKey,hostname){
 if(!value||value===serviceKey||value.length>8192||value.startsWith('sb_secret_'))return false;
 if(/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(value))return true;
 try{
  const parts=value.split('.');if(parts.length!==3||!parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)))return false;
  const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
  if(!isObject(payload)||payload.role!=='anon')return false;
  const hosted=hostname.match(/^([a-z0-9-]+)\.supabase\.co$/);
  if(hosted&&payload.ref!==hosted[1])return false;
  return true;
 }catch{return false}
}
function userId(user){if(!user||!UUID.test(user.id||''))throw failure('AUTH_REQUIRED','請先登入',401);return user.id.toLowerCase()}
function roomId(value){if(typeof value!=='string'||!UUID.test(value))throw failure('INVALID_ROOM','房間格式不正確',400);return value.toLowerCase()}
function isoTime(value){const parsed=Date.parse(value);if(typeof value!=='string'||!Number.isFinite(parsed))throw failure('DATABASE_RESPONSE','聊天資料格式不正確');return parsed}
function room(value){if(!isObject(value)||!UUID.test(value.id||''))throw failure('DATABASE_RESPONSE','房間資料格式不正確');return {id:value.id.toLowerCase(),createdAt:isoTime(value.created_at),updatedAt:isoTime(value.updated_at)}}
function message(value){
 if(!isObject(value)||!UUID.test(value.id||'')||!UUID.test(value.author_id||'')||typeof value.original_text!=='string'||!LANGUAGES.has(value.language))throw failure('DATABASE_RESPONSE','聊天資料格式不正確');
 return {id:value.id.toLowerCase(),text:value.original_text,lang:value.language,authorId:value.author_id.toLowerCase(),device:value.device_id||null,timestamp:isoTime(value.created_at)};
}
function cursorFor(row){return Buffer.from(JSON.stringify({t:row.created_at,id:row.id})).toString('base64url')}
function parseCursor(value){
 if(value===undefined||value===null||value==='')return {t:null,id:null};
 try{if(typeof value!=='string'||value.length>256||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(!isObject(parsed)||Object.keys(parsed).sort().join(',')!=='id,t'||!UUID.test(parsed.id||''))throw Error();isoTime(parsed.t);return {t:parsed.t,id:parsed.id.toLowerCase()}}
 catch{throw failure('INVALID_CURSOR','歷史訊息分頁格式不正確',400)}
}
/** PostgreSQL-backed private chat. No message or membership falls back to local memory or files. */
function createPrivateChat(options={}){
 const env=options.env||process.env,fetcher=options.fetch||globalThis.fetch;
 let baseURL=null,allowed=[],configured=false,healthy=null;
 const anonKey=String(env.SUPABASE_ANON_KEY||'').trim(),serviceKey=String(env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
 try{
  const url=new URL(String(env.SUPABASE_URL||''));
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error();
  allowed=String(env.PRIVATE_USER_IDS||'').split(',').map(value=>value.trim().toLowerCase());
  if(allowed.length!==2||new Set(allowed).size!==2||!allowed.every(value=>UUID.test(value))||!serviceKey||/[\s\x00-\x1f\x7f]/.test(anonKey+serviceKey)||!publicAnonKey(anonKey,serviceKey,url.hostname))throw Error();
  baseURL=url.origin;configured=true;
 }catch{}
 const ready=()=>{if(!configured)throw failure('PRIVATE_CHAT_NOT_CONFIGURED','私人聊天資料庫與兩位使用者尚未設定完成')};
 const actor=user=>{ready();const id=userId(user);if(!allowed.includes(id))throw failure('AUTH_FORBIDDEN','此帳號未獲准使用私人聊天室',403);return id};
 async function request(path,body,token,auth=false){
  ready();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
   const response=await fetcher(baseURL+path,{method:body===undefined?'GET':'POST',headers:{apikey:auth?anonKey:serviceKey,Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});
   let value;try{value=await response.json()}catch{throw failure(auth?'AUTH_UNAVAILABLE':'DATABASE_UNAVAILABLE',auth?'登入服務暫時無法使用':'聊天資料庫暫時無法使用')}
   if(!response.ok){
    if(auth&&[400,401,403].includes(response.status))throw failure('AUTH_REQUIRED','登入已失效，請重新登入',401);
    if(!auth&&(value?.code==='42501'||value?.message==='OLW_FORBIDDEN'))throw failure('ROOM_FORBIDDEN','沒有這個房間的存取權限',403);
    if(!auth&&value?.message==='OLW_CONFLICT')throw failure('MESSAGE_CONFLICT','訊息識別碼已被其他內容使用',409);
    if(!auth&&value?.code==='22023')throw failure('INVALID_MESSAGE','訊息或分頁格式不正確',400);
    throw failure(auth?'AUTH_UNAVAILABLE':'DATABASE_UNAVAILABLE',auth?'登入服務暫時無法使用':'聊天資料庫暫時無法使用，訊息尚未確認儲存');
   }
   if(!auth)healthy=true;return value;
  }catch(error){if(!auth)healthy=false;if(error?.code&&error?.status)throw error;throw failure(auth?'AUTH_UNAVAILABLE':'DATABASE_UNAVAILABLE',auth?'登入服務暫時無法連線':'聊天資料庫暫時無法連線，訊息尚未確認儲存')}
  finally{clearTimeout(timer)}
 }
 const rpc=(name,params)=>request('/rest/v1/rpc/olw_private_'+name,params,serviceKey);
 async function authenticate(accessToken){
  ready();if(typeof accessToken!=='string'||accessToken.length<20||accessToken.length>8192||/[\s\x00-\x1f\x7f]/.test(accessToken))throw failure('AUTH_REQUIRED','請先登入',401);
  const verified=await request('/auth/v1/user',undefined,accessToken,true);
  const id=actor(verified);if(!verified.email_confirmed_at&&!verified.confirmed_at)throw failure('AUTH_UNVERIFIED','請先完成帳號的電子郵件驗證',403);
  let expiresAt;try{const payload=JSON.parse(Buffer.from(accessToken.split('.')[1],'base64url').toString('utf8'));if(typeof payload.exp!=='number'||!Number.isFinite(payload.exp)||payload.exp*1000<=Date.now())throw Error();expiresAt=payload.exp*1000}catch{throw failure('AUTH_REQUIRED','登入已失效，請重新登入',401)}
  return {id,email:typeof verified.email==='string'?verified.email:'',expiresAt};
 }
 async function joinRoom(user,code){
  const id=actor(user);if(typeof code!=='string'||!/^[A-Z0-9]{6,20}$/.test(code.trim().toUpperCase()))throw failure('INVALID_ROOM','請輸入 6–20 位英數字房間代碼',400);
  const hash=crypto.createHash('sha256').update('our-little-world:private-room:v1:'+code.trim().toUpperCase()).digest('hex');
  return room(await rpc('join_room',{p_user_id:id,p_code_hash:hash,p_member_ids:allowed}));
 }
 async function getRoom(user,id){return room(await rpc('get_room',{p_user_id:actor(user),p_room_id:roomId(id)}))}
 async function resume(user){const value=await rpc('rooms',{p_user_id:actor(user)});if(!Array.isArray(value))throw failure('DATABASE_RESPONSE','房間資料格式不正確');return value.map(room)}
 async function listMessages(user,id,options={}){
  const actorId=actor(user),target=roomId(id),limit=options.limit===undefined?50:options.limit;
  if(!Number.isInteger(limit)||limit<1||limit>100)throw failure('INVALID_LIMIT','每次可載入 1–100 則訊息',400);
  const before=parseCursor(options.before),value=await rpc('messages',{p_user_id:actorId,p_room_id:target,p_before_at:before.t,p_before_id:before.id,p_limit:limit+1});
  if(!Array.isArray(value)||value.length>limit+1)throw failure('DATABASE_RESPONSE','歷史訊息格式不正確');
  const selected=value.slice(0,limit),nextCursor=value.length>limit&&selected.length?cursorFor(selected[selected.length-1]):null;
  return {messages:selected.map(message).reverse(),nextCursor};
 }
 async function saveMessage(user,id,input){
  const actorId=actor(user),target=roomId(id);
  if(!isObject(input)||!UUID.test(input.id||'')||typeof input.text!=='string'||!input.text.trim()||input.text.length>500||!LANGUAGES.has(input.lang)||(input.device!==undefined&&input.device!==null&&(typeof input.device!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.device))))throw failure('INVALID_MESSAGE','訊息格式不正確',400);
  const value=await rpc('save_message',{p_user_id:actorId,p_room_id:target,p_message_id:input.id.toLowerCase(),p_original_text:input.text,p_language:input.lang,p_device_id:input.device||null});
  return {...message(value),duplicate:value.duplicate===true};
 }
 return {status:()=>({mode:'postgres',configured,healthy}),publicConfig:()=>configured?{url:baseURL,anonKey}:null,authenticate,joinRoom,getRoom,resume,listMessages,saveMessage};
}
module.exports={createPrivateChat};
