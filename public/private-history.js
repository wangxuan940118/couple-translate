/* Authenticated REST adapter. Typed messages are persisted only through WebSocket. */
(function(root){
 'use strict';
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 function message(raw){
  if(!raw||typeof raw.id!=='string'||typeof(raw.text??raw.body)!=='string')return null;
  return {id:raw.id,roomId:raw.roomId??raw.room_id,authorId:raw.authorId??raw.author_id??raw.sender_id,text:raw.text??raw.body,lang:raw.lang??raw.source_lang??null,createdAt:raw.createdAt??raw.created_at??null,timestamp:raw.timestamp??Date.parse(raw.createdAt??raw.created_at??'')??0,kind:raw.kind??'text',deletedAt:raw.deletedAt??raw.deleted_at??null};
 }
 function order(a,b){
  const exact=x=>{const s=String(x.createdAt||'');const t=Date.parse(s);if(!Number.isFinite(t))return String(Number(x.timestamp)||0).padStart(16,'0')+'000';const fraction=(s.match(/\.(\d+)/)||[])[1]||'';return String(t).padStart(16,'0')+fraction.padEnd(6,'0').slice(3,6)};
  return exact(a).localeCompare(exact(b))||a.id.localeCompare(b.id);
 }
 function createClient(options={}){
  const fetcher=options.fetcher||root.fetch.bind(root),getToken=options.getAccessToken||(()=>root.WorldAuth?.accessToken?.());
  async function request(path,{method='GET',body,signal}={}){
   const token=await getToken();if(signal?.aborted)throw Object.assign(Error('已取消私人房間請求'),{name:'AbortError'});if(typeof token!=='string'||token.length<20||token.length>8192||/\s/.test(token))throw Object.assign(Error('請先以 Email 驗證登入'),{status:401});
   const r=await fetcher(path,{method,signal,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
   let data;try{data=await r.json()}catch{throw Error('伺服器回覆不完整，請稍後重試')}
   if(!r.ok)throw Object.assign(Error(data.error||data.message||'私人房間操作失敗'),{status:r.status,code:data.code});return data;
  }
  return {rooms:signal=>request('/api/rooms',{signal}),createRoom:signal=>request('/api/rooms',{method:'POST',body:{},signal}),redeemInvite:(token,signal)=>request('/api/invites/redeem',{method:'POST',body:{token},signal}),renewInvite:(roomId,signal)=>request('/api/invites',{method:'POST',body:{roomId},signal}),messages:(roomId,before,signal)=>request('/api/messages?'+new URLSearchParams({room:roomId,...(before?{before}:{})}),{signal}),request};
 }
 function parseRoom(value){
  const s=String(value||'').trim();if(UUID.test(s))return {roomId:s.toLowerCase()};if(/^[a-f0-9]{64}$/i.test(s))return {token:s.toLowerCase()};
  try{const u=new URL(s);const p=new URLSearchParams(u.hash.slice(1));const token=p.get('invite')||u.searchParams.get('invite');if(/^[a-f0-9]{64}$/i.test(token||''))return {token:token.toLowerCase()}}catch{}return null;
 }
 root.WorldHistory=Object.freeze({createClient,message,order,parseRoom,isRoomId:value=>UUID.test(value)});
})(globalThis);
