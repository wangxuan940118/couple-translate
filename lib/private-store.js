'use strict';
const crypto=require('node:crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGUAGES=new Set(['zh-TW','en','sv','sr','fr','es','ja','ko','de','tr']);
const SAFE=Symbol('safe-store-error');
const failure=(status,code,message)=>Object.assign(Error(message),{status,code,[SAFE]:true});
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function id(value){if(typeof value!=='string'||!UUID.test(value))throw failure(400,'INVALID_ID','識別碼格式不正確');return value.toLowerCase()}
function timestamp(value){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw failure(502,'DATABASE_RESPONSE','資料庫回覆格式不正確');return value}
function roomDTO(row){if(!object(row))throw failure(502,'DATABASE_RESPONSE','房間資料格式不正確');return {id:id(row.id),ownerId:(row.owner_id||row.created_by)?id(row.owner_id||row.created_by):null,createdAt:timestamp(row.created_at),updatedAt:timestamp(row.updated_at||row.created_at)}}
function messageDTO(row){
 if(!object(row)||typeof row.body!=='string'&&row.body!==null||row.source_lang!=null&&!LANGUAGES.has(row.source_lang))throw failure(502,'DATABASE_RESPONSE','訊息資料格式不正確');
 const createdAt=timestamp(row.created_at);
 return {id:id(row.id),roomId:id(row.room_id),authorId:id(row.sender_id),text:row.deleted_at?'':row.body||'',lang:row.source_lang||null,timestamp:Date.parse(createdAt),createdAt,kind:typeof row.kind==='string'?row.kind:'text',deletedAt:row.deleted_at?timestamp(row.deleted_at):null};
}
function cursor(row){return Buffer.from(JSON.stringify({t:timestamp(row.created_at),id:id(row.id)})).toString('base64url')}
function decodeCursor(value){if(value===undefined||value===null||value==='')return {t:null,id:null};try{if(typeof value!=='string'||value.length>512||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();const data=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(!object(data)||Object.keys(data).sort().join(',')!=='id,t')throw Error();return {t:timestamp(data.t),id:id(data.id)}}catch{throw failure(400,'INVALID_CURSOR','歷史訊息分頁格式不正確')}}
function createPrivateStore(options={}){
 const env=options.env||process.env,fetcher=options.fetch||globalThis.fetch,now=options.now||Date.now;
 let url=null,key=null,allowed=[],configured=false,projectCheck=null,schemaCheck=null,schemaVerified=false,dataPathVerified=false;
 try{
  const parsed=new URL(env.SUPABASE_URL||'');if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||!['','/'].includes(parsed.pathname))throw Error();url=parsed.origin;
  key=String(env.SUPABASE_PUBLISHABLE_KEY||env.SUPABASE_ANON_KEY||'').trim();
  if(key.startsWith('sb_publishable_')){if(!/^sb_publishable_[A-Za-z0-9_-]{16,512}$/.test(key))throw Error()}
  else{const parts=key.split('.');if(parts.length!==3)throw Error();const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));const ref=parsed.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1];if(claims.role!=='anon'||ref&&claims.ref!==ref)throw Error()}
  allowed=String(env.PRIVATE_USER_IDS||'').split(',').map(value=>value.trim().toLowerCase());if(allowed.length!==2||new Set(allowed).size!==2||!allowed.every(value=>UUID.test(value)))throw Error();configured=true;
 }catch{url=null;key=null;allowed=[]}
 const ready=()=>{if(!configured)throw failure(503,'PRIVATE_CHAT_NOT_CONFIGURED','私人聊天室尚未完成資料庫與兩位帳號設定')};
 function actor(user){ready();if(!user||!allowed.includes(user.id)||typeof user.accessToken!=='string'||!(user.expiresAt>now()))throw failure(401,'AUTH_REQUIRED','登入已失效，請重新登入');return user}
 async function request(route,{body,token}={}){
  ready();const controller=new AbortController();let timer;
  const task=(async()=>{
   const response=await fetcher(url+route,{method:body===undefined?'GET':'POST',headers:{apikey:key,...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});
   let data;try{data=await response.json()}catch{throw failure(503,'PRIVATE_SERVICE_UNAVAILABLE','私人聊天服務回覆不完整')}
   if(!response.ok){
    if(route.startsWith('/auth/')){if([400,401,403].includes(response.status))throw failure(401,'AUTH_REQUIRED','登入或專案驗證失敗，請重新登入');throw failure(503,'AUTH_UNAVAILABLE','登入服務暫時無法使用')}
    if([401,403].includes(response.status)||data?.code==='42501')throw failure(403,'ROOM_FORBIDDEN','沒有這個房間的存取權限');
    if(data?.code==='23505'||data?.message==='OLW_MESSAGE_CONFLICT')throw failure(409,'MESSAGE_CONFLICT','訊息識別碼已被其他內容使用');
    if(data?.message==='OLW_INVITE_INVALID')throw failure(404,'INVITE_INVALID','邀請已失效或不屬於這個帳號');
    if(data?.message==='OLW_ROOM_FULL')throw failure(409,'ROOM_FULL','房間只允許指定的兩位使用者');
    if(data?.code==='22023')throw failure(400,'INVALID_REQUEST','請求格式不正確');
    throw failure(503,'DATABASE_UNAVAILABLE','聊天資料庫尚未準備好或暫時無法連線');
   }
   return data;
  })();
  const deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure(503,'PRIVATE_SERVICE_TIMEOUT','私人聊天服務連線逾時，請稍後重試'))},8000)});
  try{return await Promise.race([task,deadline])}catch(error){if(error?.[SAFE])throw error;throw failure(503,'PRIVATE_SERVICE_UNAVAILABLE','私人聊天服務暫時無法連線')}finally{clearTimeout(timer)}
 }
 async function verifyProject(){
  ready();if(projectCheck&&now()-projectCheck.at<30000)return projectCheck.promise;
  const check={at:now()};check.promise=request('/auth/v1/settings').then(()=>true);projectCheck=check;
  try{return await check.promise}catch(error){if(projectCheck===check)projectCheck=null;throw error}
 }
 async function authConfig(){try{await verifyProject();return {enabled:true,url,publishableKey:key,otpLength:8}}catch{return {enabled:false,url:null,publishableKey:null,otpLength:8}}}
 async function readiness(){
  try{ready();await verifyProject();if(!schemaCheck||now()-schemaCheck.at>=30000){const check={at:now()};check.promise=request('/rest/v1/rpc/olw_schema_version',{body:{}}).then(value=>{if(value?.version!==1)throw failure(503,'SCHEMA_NOT_READY','資料庫結構尚未完成');schemaVerified=true;return 1});schemaCheck=check}await schemaCheck.promise;return {ready:true,configured:true,schemaVersion:1,dataPathVerified}}
  catch(error){schemaVerified=false;return {ready:false,configured,schemaVersion:null,dataPathVerified,code:error.code||'PRIVATE_SERVICE_UNAVAILABLE'}}
 }
 async function authenticate(token){
  ready();if(typeof token!=='string'||token.length>8192||token.length<20||/[\s\x00-\x1f\x7f]/.test(token))throw failure(401,'AUTH_REQUIRED','請先登入私人帳號');
  await verifyProject();const verified=await request('/auth/v1/user',{token});if(!object(verified)||!UUID.test(verified.id||''))throw failure(503,'AUTH_UNAVAILABLE','登入服務回覆不完整');const userId=verified.id.toLowerCase();
  if(!allowed.includes(userId))throw failure(403,'ACCOUNT_FORBIDDEN','此帳號不屬於私人聊天室');
  if(typeof verified.email!=='string'||!verified.email||!verified.email_confirmed_at&&!verified.confirmed_at)throw failure(403,'EMAIL_UNVERIFIED','請先完成電子郵件驗證');
  let expiresAt;try{const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));if(claims.sub!==userId||claims.role!=='authenticated'||typeof claims.exp!=='number'||!Number.isFinite(claims.exp)||claims.exp*1000<=now())throw Error();expiresAt=claims.exp*1000}catch{throw failure(401,'AUTH_REQUIRED','登入已失效，請重新登入')}
  const user={id:userId,email:verified.email,expiresAt};Object.defineProperty(user,'accessToken',{value:token,enumerable:false});return user;
 }
 async function rpc(user,name,params={}){actor(user);const result=await request('/rest/v1/rpc/olw_private_'+name,{body:params,token:user.accessToken});dataPathVerified=true;return result}
 async function createRoom(user){actor(user);const inviteToken=crypto.randomBytes(32).toString('hex'),inviteHash=crypto.createHash('sha256').update(inviteToken).digest('hex');const row=await rpc(user,'create_room',{p_invite_hash:inviteHash,p_invitee_id:allowed.find(value=>value!==user.id)});return {room:roomDTO(row),inviteToken}}
 async function renewInvite(user,roomId){actor(user);const inviteToken=crypto.randomBytes(32).toString('hex'),inviteHash=crypto.createHash('sha256').update(inviteToken).digest('hex');const row=await rpc(user,'renew_invite',{p_room_id:id(roomId),p_invite_hash:inviteHash,p_invitee_id:allowed.find(value=>value!==user.id)});return {roomId:id(roomId),inviteToken,expiresAt:row.expires_at||null}}
 async function redeemInvite(user,token){if(typeof token!=='string'||!/^[0-9a-f]{64}$/i.test(token))throw failure(400,'INVITE_INVALID','請使用完整的私人邀請連結');return roomDTO(await rpc(user,'redeem_invite',{p_token:token.toLowerCase()}))}
 async function listRooms(user){const rows=await rpc(user,'rooms');if(!Array.isArray(rows))throw failure(502,'DATABASE_RESPONSE','房間資料格式不正確');return rows.map(roomDTO)}
 async function getRoom(user,roomId){return roomDTO(await rpc(user,'get_room',{p_room_id:id(roomId)}))}
 async function listMessages(user,roomId,{before,limit=50}={}){if(!Number.isInteger(limit)||limit<1||limit>100)throw failure(400,'INVALID_LIMIT','每次可載入 1–100 則訊息');const previous=decodeCursor(before),rows=await rpc(user,'messages',{p_room_id:id(roomId),p_before_at:previous.t,p_before_id:previous.id,p_limit:limit+1});if(!Array.isArray(rows)||rows.length>limit+1)throw failure(502,'DATABASE_RESPONSE','歷史訊息格式不正確');const page=rows.slice(0,limit);return {messages:page.map(messageDTO).reverse(),nextCursor:rows.length>limit&&page.length?cursor(page[page.length-1]):null}}
 async function saveMessage(user,roomId,input){if(!object(input)||typeof input.text!=='string'||!input.text.trim()||input.text.length>500||!LANGUAGES.has(input.lang)||(input.device!==null&&input.device!==undefined&&(typeof input.device!=='string'||!UUID.test(input.device))))throw failure(400,'INVALID_MESSAGE','訊息格式不正確');const row=await rpc(user,'save_message',{p_room_id:id(roomId),p_message_id:id(input.id),p_original_text:input.text,p_language:input.lang,p_device_id:input.device||null});return {...messageDTO(row),duplicate:row.duplicate===true}}
 return {status:()=>({mode:'postgres',configured,schemaVerified,dataPathVerified}),authConfig,readiness,authenticate,createRoom,renewInvite,redeemInvite,listRooms,getRoom,listMessages,saveMessage};
}
module.exports={createPrivateStore};
