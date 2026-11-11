import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

// Real embedded PostgreSQL executes migrations, triggers, constraints and RLS.
// Only Supabase's auth schema/roles/JWT-context function are substituted.
// This is not SMTP, PostgREST, hosted Supabase, or multi-connection concurrency.
const schema=await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8');
const foundation=await readFile(new URL('../supabase/private-foundation.sql',import.meta.url),'utf8');
const preflight=await readFile(new URL('../supabase/preflight.sql',import.meta.url),'utf8');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const legacyRoom='11111111-1111-4111-8111-111111111111';
const legacyMessage='22222222-2222-4222-8222-222222222222';
const raw=n=>n.toString(16).padStart(64,'0');
const hash=token=>createHash('sha256').update(token,'utf8').digest('hex');

async function makeDatabase(){
 const db=new PGlite();
 await db.exec(`create schema auth;
 create role anon nologin; create role authenticated nologin;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated;
 grant execute on function auth.uid() to anon,authenticated;
 insert into auth.users(id,email,email_confirmed_at) values
 ('${A}','a@example.test',now()),('${B}','b@example.test',now()),('${C}','c@example.test',now());`);
 return db;
}
async function actor(db,id,sql,params=[]){
 await db.exec(`begin; set local role ${id?'authenticated':'anon'};`);
 try{
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[id||'']);
  const result=await db.query(sql,params);
  await db.exec('commit');return result;
 }catch(error){await db.exec('rollback');throw error;}
}
async function rpc(db,id,name,params=[]){
 const result=await actor(db,id,`select public.${name}(${params.map((_,i)=>'$'+(i+1)).join(',')}) as value`,params);
 return result.rows[0]?.value;
}
async function createRoom(db,owner,recipient,token){
 return rpc(db,owner,'olw_private_create_room',[hash(token),recipient]);
}

test('canonical SQL: real PostgreSQL authorization, invitations and durable history',async t=>{
 const db=await makeDatabase();
 try{
  await db.exec(schema);
  // Simulate a canonical pre-migration row. Its language must remain unknown.
  await db.query('insert into public.rooms(id,created_by) values($1,$2)',[legacyRoom,A]);
  await db.query('insert into public.messages(id,room_id,sender_id,body) values($1,$2,$3,$4)',[legacyMessage,legacyRoom,A,'Legacy original']);
  // Old draft signatures must lose execute permission even if already installed.
  await db.exec(`create function public.olw_create_invite(uuid) returns text language sql as $$select 'unsafe'::text$$;
   create function public.olw_redeem_invite(text) returns uuid language sql as $$select null::uuid$$;
   grant execute on function public.olw_create_invite(uuid),public.olw_redeem_invite(text) to authenticated;`);
  await db.exec(foundation);
  let room;

  await t.test('anonymous can read only static readiness; old unsafe RPCs are revoked',async()=>{
   assert.deepEqual(await rpc(db,null,'olw_schema_version'),{version:1});
   assert.deepEqual(await rpc(db,A,'olw_schema_version'),{version:1});
   await assert.rejects(actor(db,null,'select * from public.messages'),/permission denied/);
   await assert.rejects(rpc(db,null,'olw_private_rooms'),/permission denied/);
   await assert.rejects(rpc(db,A,'olw_create_invite',[legacyRoom]),/permission denied/);
   await assert.rejects(rpc(db,A,'olw_redeem_invite',[raw(1)]),/permission denied/);
  });

  await t.test('migration preserves legacy rows and repairs owner membership without guessing language',async()=>{
   const result=await actor(db,A,'select body,source_lang from public.messages where id=$1',[legacyMessage]);
   assert.deepEqual(result.rows,[{body:'Legacy original',source_lang:null}]);
   assert.equal((await actor(db,A,'select * from public.room_members where room_id=$1',[legacyRoom])).rows.length,1);
   assert.equal((await actor(db,C,'select * from public.messages')).rows.length,0);
  });

  await t.test('owner creation, recipient-bound hashed single-use invite, and private RLS',async()=>{
   room=await createRoom(db,A,B,raw(2));
   assert.equal(room.created_by,A);
   assert.equal((await actor(db,A,'select * from public.room_members where room_id=$1',[room.id])).rows.length,1);
   await assert.rejects(rpc(db,B,'olw_private_get_room',[room.id]),/OLW_FORBIDDEN/);
   await assert.rejects(rpc(db,C,'olw_private_redeem_invite',[raw(2)]),/OLW_INVITE_INVALID/);
   await assert.rejects(rpc(db,B,'olw_private_redeem_invite',[hash(raw(2))]),/OLW_INVITE_INVALID/);
   const stored=(await db.query('select token_hash,expires_at-created_at as lifetime from public.room_invites where room_id=$1',[room.id])).rows[0];
   assert.equal(stored.token_hash,hash(raw(2)));
   assert.notEqual(stored.token_hash,raw(2));
   await assert.rejects(actor(db,A,'select * from public.room_invites'),/permission denied/);
   assert.equal((await rpc(db,B,'olw_private_redeem_invite',[raw(2)])).id,room.id);
   await assert.rejects(rpc(db,B,'olw_private_redeem_invite',[raw(2)]),/OLW_INVITE_INVALID/);
   assert.equal((await actor(db,B,'select * from public.rooms where id=$1',[room.id])).rows.length,1);
   assert.equal((await actor(db,C,'select * from public.rooms where id=$1',[room.id])).rows.length,0);
   assert.equal((await actor(db,C,'select * from public.room_members where room_id=$1',[room.id])).rows.length,0);
  });

  await t.test('two members enforced for INSERT and UPDATE; clients cannot insert membership',async()=>{
   await assert.rejects(actor(db,C,'insert into public.room_members(room_id,user_id) values($1,$2)',[room.id,C]),/permission denied/);
   await assert.rejects(db.query('insert into public.room_members(room_id,user_id) values($1,$2)',[room.id,C]),/OLW_ROOM_FULL/);
   const other=await createRoom(db,C,A,raw(3));
   await rpc(db,A,'olw_private_redeem_invite',[raw(3)]);
   await assert.rejects(db.query('update public.room_members set room_id=$1 where room_id=$2 and user_id=$3',[other.id,room.id,B]),/OLW_ROOM_FULL/);
   assert.equal((await db.query('select * from public.room_members where room_id=$1',[room.id])).rows.length,2);
   const constraints=await db.query("select indexdef from pg_indexes where indexname='olw_room_member_slots'");
   assert.match(constraints.rows[0].indexdef,/UNIQUE.*room_id, member_slot/);
  });

  await t.test('renewal revokes previous invite and expiration is enforced',async()=>{
   const pending=await createRoom(db,A,B,raw(4));
   await rpc(db,A,'olw_private_renew_invite',[pending.id,hash(raw(5)),B]);
   assert.equal((await db.query('select * from public.room_invites where room_id=$1 and used_at is null',[pending.id])).rows.length,1);
   await assert.rejects(rpc(db,B,'olw_private_redeem_invite',[raw(4)]),/OLW_INVITE_INVALID/);
   await db.query("update public.room_invites set expires_at=now()-interval '1 second' where room_id=$1",[pending.id]);
   await assert.rejects(rpc(db,B,'olw_private_redeem_invite',[raw(5)]),/OLW_INVITE_INVALID/);
   await assert.rejects(rpc(db,B,'olw_private_renew_invite',[pending.id,hash(raw(6)),C]),/OLW_FORBIDDEN/);
  });

  await t.test('message save confirms PostgreSQL commit and strict same-account retries',async()=>{
   const id=randomUUID();
   const saved=await rpc(db,A,'olw_private_save_message',[room.id,id,' 寶貝，我想你了 ','zh-TW','device-a']);
   assert.equal(saved.duplicate,false);assert.equal(saved.body,'寶貝，我想你了');assert.equal(saved.source_lang,'zh-TW');assert.equal(saved.sender_id,A);
   const duplicate=await rpc(db,A,'olw_private_save_message',[room.id,id,saved.body,'zh-TW','another-device']);
   assert.equal(duplicate.duplicate,true);assert.equal(duplicate.created_at,saved.created_at);assert.equal(duplicate.device_id,'device-a');
   for(const args of [[room.id,id,'Different','zh-TW'],[room.id,id,saved.body,'en']])
    await assert.rejects(rpc(db,A,'olw_private_save_message',args),/OLW_MESSAGE_CONFLICT/);
   await assert.rejects(rpc(db,B,'olw_private_save_message',[room.id,id,saved.body,'zh-TW']),/OLW_MESSAGE_CONFLICT/);
   const other=await createRoom(db,A,B,raw(7));
   await assert.rejects(rpc(db,A,'olw_private_save_message',[other.id,id,saved.body,'zh-TW']),/OLW_MESSAGE_CONFLICT/);
   await assert.rejects(rpc(db,C,'olw_private_save_message',[room.id,randomUUID(),'Forbidden','en']),/OLW_FORBIDDEN/);
   for(const column of ['id','body','source_lang','device_id','created_at']){
    const value={id:randomUUID(),body:'Changed',source_lang:'en',device_id:'changed',created_at:new Date().toISOString()}[column];
    await assert.rejects(actor(db,A,`update public.messages set ${column}=$1 where id=$2`,[value,id]),/OLW_MESSAGE_IMMUTABLE/);
   }
   await actor(db,A,'update public.messages set deleted_at=now() where id=$1',[id]);
   await assert.rejects(rpc(db,A,'olw_private_save_message',[room.id,id,saved.body,'zh-TW']),/OLW_MESSAGE_CONFLICT/);
   await assert.rejects(actor(db,A,'update public.messages set deleted_at=null where id=$1',[id]),/OLW_MESSAGE_ALREADY_DELETED/);
   const imageID=randomUUID();
   await db.query("insert into public.messages(id,room_id,sender_id,kind,body,source_lang) values($1,$2,$3,'image','Caption','en')",[imageID,room.id,A]);
   await assert.rejects(rpc(db,A,'olw_private_save_message',[room.id,imageID,'Caption','en']),/OLW_MESSAGE_CONFLICT/);
   await assert.rejects(actor(db,A,'insert into public.messages(room_id,sender_id,body) values($1,$2,$3)',[room.id,A,'Missing language']),/OLW_INVALID_MESSAGE/);
   assert.equal((await actor(db,C,'select * from public.messages where room_id=$1',[room.id])).rows.length,0);
  });

  await t.test('tuple cursor retrieves >150 timestamp ties plus older records without duplicate/loss',async()=>{
   const historyRoom=await createRoom(db,A,B,raw(8));
   await db.query(`insert into public.messages(id,room_id,sender_id,body,source_lang,created_at)
    select ('00000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid,$1,$2,'Tie '||i,'en','2026-01-02T00:00:00Z'::timestamptz from generate_series(1,200) i`,[historyRoom.id,A]);
   await db.query("insert into public.messages(room_id,sender_id,body,source_lang,created_at) values($1,$2,'Older','en','2026-01-01T00:00:00Z')",[historyRoom.id,A]);
   const ids=new Set();let beforeAt=null,beforeID=null,pages=[];
   for(let i=0;i<8;i++){
    const {rows}=await actor(db,A,'select * from public.olw_private_messages($1,$2,$3,$4)',[historyRoom.id,beforeAt,beforeID,50]);
    pages.push(rows.length);if(!rows.length)break;
    for(const row of rows){assert(!ids.has(row.id));ids.add(row.id);}
    beforeAt=rows.at(-1).created_at;beforeID=rows.at(-1).id;
   }
   assert.deepEqual(pages,[50,50,50,50,1,0]);assert.equal(ids.size,201);
   await assert.rejects(actor(db,C,'select * from public.olw_private_messages($1,null,null,50)',[historyRoom.id]),/OLW_FORBIDDEN/);
   await assert.rejects(actor(db,A,'select * from public.olw_private_messages($1,now(),null,50)',[historyRoom.id]),/OLW_INVALID_CURSOR/);
  });

  await t.test('both migrations can be repeated without dropping data',async()=>{
   const before=(await db.query('select count(*)::int as n from public.messages')).rows[0].n;
   await db.exec(schema);await db.exec(foundation);
   assert.equal((await db.query('select count(*)::int as n from public.messages')).rows[0].n,before);
   assert.deepEqual(await rpc(db,null,'olw_schema_version'),{version:1});
  });
 }finally{await db.close();}
});

test('preflight refuses legacy namespace or unknown canonical security without changing it',async()=>{
 const db=await makeDatabase();
 try{
  await db.exec('create schema olw_private; create table olw_private.messages(id integer); insert into olw_private.messages values(7);');
  const results=await db.exec(preflight);
  assert(results[0].rows.some(row=>row.object_name==='olw_private.messages'&&row.migration_needed));
  await db.exec(schema);
  await assert.rejects(db.exec(foundation),/OLW_LEGACY_MIGRATION_REQUIRED/);await db.exec('rollback');
  assert.deepEqual((await db.query('select * from olw_private.messages')).rows,[{id:7}]);
  assert.equal((await db.query("select to_regprocedure('public.olw_schema_version()') as marker")).rows[0].marker,null);
  await db.exec('drop schema olw_private cascade; create policy unexpected_open_read on public.messages for select to authenticated using(true);');
  await assert.rejects(db.exec(foundation),/OLW_POLICY_REVIEW_REQUIRED/);await db.exec('rollback');
  await db.exec('drop policy unexpected_open_read on public.messages; alter table public.messages add column unknown_secret text;');
  await assert.rejects(db.exec(foundation),/OLW_SCHEMA_INCOMPATIBLE/);await db.exec('rollback');
 }finally{await db.close();}
});
