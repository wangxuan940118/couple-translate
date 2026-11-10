// Authenticated Supabase history adapter. NOT enabled in production until
// the room's membership and legacy WebSocket authorization are enforced.
// Only use this adapter with a verified Supabase Auth session and RLS policies.
export function createPrivateHistory(client,roomId){
 if(!client||!/^[-0-9a-f]{36}$/i.test(roomId))throw Error('Invalid history configuration');
 const messages=client.from('messages');
 const requireUser=async()=>{
  const {data,error}=await client.auth.getUser();
  if(error||!data?.user)throw Error('Please sign in again');
  return data.user;
 };
 return {
  async load({before=null,limit=50}={}){
   await requireUser();
   const count=Math.max(1,Math.min(100,Math.floor(limit)||50));
   let query=messages.select('id,room_id,sender_id,kind,body,created_at,deleted_at')
    .eq('room_id',roomId).eq('kind','text').is('deleted_at',null)
    .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(count);
   if(before?.created_at&&before?.id){
    // Fetch page using stable timestamp; skip records >= cursor in JS.
    // Use extra room-side page capacity to avoid timestamp ties.
    query=query.lte('created_at',before.created_at).limit(Math.min(200,count+100));
   }
   const {data,error}=await query;
   if(error)throw error;
   const filtered=before?data.filter(m=>m.created_at<before.created_at||
      (m.created_at===before.created_at&&m.id<before.id)).slice(0,count):data;
   return filtered.reverse();
  },
  async save({id,body}){
   const user=await requireUser();
   if(!/^[0-9a-f-]{36}$/i.test(id)||typeof body!=='string'||!body.trim()||body.length>500)
    throw Error('Invalid message');
   const record={id,room_id:roomId,sender_id:user.id,kind:'text',body:body.trim()};
   // Ignore duplicate IDs from offline retries, then read the existing row.
   const {data,error}=await messages.upsert(record,{onConflict:'id',ignoreDuplicates:true})
     .select('id,room_id,sender_id,body,created_at').maybeSingle();
   if(error)throw error;
   if(data)return data;
   const existing=await messages.select('id,room_id,sender_id,body,created_at')
     .eq('id',id).eq('room_id',roomId).single();
   if(existing.error||!existing.data)throw Error('Message not confirmed');
   if(existing.data.sender_id!==user.id||existing.data.body!==record.body)
    throw Error('Message ID collision');
   return existing.data;
  },
  subscribe(onChange){
   if(typeof onChange!=='function')throw Error('Callback required');
   const channel=client.channel('olw-history-'+roomId)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages',filter:'room_id=eq.'+roomId},payload=>{
      if(payload.new?.room_id===roomId)onChange(payload.new);
    }).subscribe();
   return ()=>client.removeChannel(channel);
  }
 };
}
