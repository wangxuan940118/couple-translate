'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPrivateChat}=require('../lib/private-chat');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const ROOM='44444444-4444-4444-8444-444444444444',M1='55555555-5555-4555-8555-555555555555',M2='66666666-6666-4666-8666-666666666666';
function apiKey(role='anon',ref='project'){return Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({iss:'supabase',role,ref})).toString('base64url')+'.testSignature'}
const env={SUPABASE_URL:'https://project.example.test',SUPABASE_ANON_KEY:apiKey(),SUPABASE_SERVICE_ROLE_KEY:'private-service-value',PRIVATE_USER_IDS:A+','+B};
const now='2026-11-10T12:00:00.123456+00:00';
const saved=(id=M1,author=A)=>({id,author_id:author,original_text:'寶貝，我想你了',language:'zh-TW',device_id:'device-a',created_at:now});
const room=()=>({id:ROOM,created_at:now,updated_at:now});
const response=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value});
function token(id=A,exp=Math.floor(Date.now()/1000)+3600){return 'header.'+Buffer.from(JSON.stringify({sub:id,exp})).toString('base64url')+'.signature'}
function setup(handler,config=env){const calls=[];const client=createPrivateChat({env:config,fetch:async(url,options)=>{const call={url,options,body:options.body?JSON.parse(options.body):undefined};calls.push(call);return handler(call)}});return {client,calls}}

test('missing or invalid private config fails closed without a memory/file fallback',async()=>{
 for(const config of [{},{...env,PRIVATE_USER_IDS:A},{...env,PRIVATE_USER_IDS:A+','+A},{...env,SUPABASE_URL:'http://project.example.test'},{...env,SUPABASE_URL:'https://user:password@project.example.test'}]){
  const {client,calls}=setup(()=>{throw Error('must not fetch')},config);
  assert.deepEqual(client.status(),{mode:'postgres',configured:false,healthy:null});assert.equal(client.publicConfig(),null);
  await assert.rejects(client.joinRoom({id:A},'PRIVATE123'),{code:'PRIVATE_CHAT_NOT_CONFIGURED',status:503});assert.equal(calls.length,0);
 }
 const {client}=setup(()=>response(room()));assert.deepEqual(client.publicConfig(),{url:env.SUPABASE_URL,anonKey:env.SUPABASE_ANON_KEY});assert(!JSON.stringify(client.status()).includes(env.SUPABASE_SERVICE_ROLE_KEY));
});

test('public config rejects secret, service-role, mismatched project and opaque anon key mistakes',async()=>{
 for(const config of [
  {...env,SUPABASE_ANON_KEY:env.SUPABASE_SERVICE_ROLE_KEY},
  {...env,SUPABASE_ANON_KEY:'sb_secret_private_value_must_not_reach_browser'},
  {...env,SUPABASE_ANON_KEY:apiKey('service_role')},
  {...env,SUPABASE_ANON_KEY:apiKey('authenticated')},
  {...env,SUPABASE_ANON_KEY:'public-anon-value'},
  {...env,SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:apiKey('anon','different-project')},
  {...env,SUPABASE_URL:'https://project.example.test?key=secret'},
  {...env,SUPABASE_URL:'https://project.example.test/rest/v1'},
 ]){
  const {client,calls}=setup(()=>{throw Error('must not fetch')},config);
  assert.equal(client.status().configured,false);assert.equal(client.publicConfig(),null);
  await assert.rejects(client.authenticate(token()),{code:'PRIVATE_CHAT_NOT_CONFIGURED',status:503});assert.equal(calls.length,0);
 }
 const modern=setup(()=>response(room()),{...env,SUPABASE_ANON_KEY:'sb_publishable_abcdefghijklmnopqrstuvwxyz012345'}).client;
 assert.equal(modern.status().configured,true);assert.equal(modern.publicConfig().anonKey,'sb_publishable_abcdefghijklmnopqrstuvwxyz012345');
 const legacy=setup(()=>response(room()),{...env,SUPABASE_URL:'https://project.supabase.co'}).client;
 assert.equal(legacy.status().configured,true);assert.equal(legacy.publicConfig().anonKey,env.SUPABASE_ANON_KEY);
});

test('authenticate verifies token with Supabase before accepting only two confirmed users',async()=>{
 const access=token();const {client,calls}=setup(({url,options})=>{assert(url.endsWith('/auth/v1/user'));assert.equal(options.headers.apikey,env.SUPABASE_ANON_KEY);assert.equal(options.headers.Authorization,'Bearer '+access);return response({id:A,email:'a@example.test',email_confirmed_at:now})});
 const user=await client.authenticate(access);assert.equal(user.id,A);assert.equal(user.email,'a@example.test');assert(user.expiresAt>Date.now());assert.equal(calls.length,1);
 const third=setup(()=>response({id:C,email_confirmed_at:now}));await assert.rejects(third.client.authenticate(token(C)),{code:'AUTH_FORBIDDEN',status:403});
 const unconfirmed=setup(()=>response({id:A}));await assert.rejects(unconfirmed.client.authenticate(token()),{code:'AUTH_UNVERIFIED',status:403});
 const forged=setup(()=>response({message:'invalid JWT'},401));await assert.rejects(forged.client.authenticate(token()),{code:'AUTH_REQUIRED',status:401});
 const expired=setup(()=>response({id:A,email_confirmed_at:now}));await assert.rejects(expired.client.authenticate(token(A,1)),{code:'AUTH_REQUIRED',status:401});
});

test('raw room codes never reach database RPC and an unapproved user cannot call it',async()=>{
 const {client,calls}=setup(()=>response(room()));const joined=await client.joinRoom({id:A},'private123');assert.equal(joined.id,ROOM);assert.equal(joined.createdAt,Date.parse(now));
 assert.equal(calls[0].body.p_user_id,A);assert.deepEqual(calls[0].body.p_member_ids,[A,B]);assert.match(calls[0].body.p_code_hash,/^[0-9a-f]{64}$/);assert(!JSON.stringify(calls).includes('PRIVATE123'));
 assert.equal(calls[0].options.headers.apikey,env.SUPABASE_SERVICE_ROLE_KEY);
 await assert.rejects(client.joinRoom({id:C},'private123'),{code:'AUTH_FORBIDDEN'});assert.equal(calls.length,1);
 await assert.rejects(client.joinRoom({id:A},'bad'),{code:'INVALID_ROOM',status:400});assert.equal(calls.length,1);
});

test('room lookup and resume always send the verified actor and normalize timestamps',async()=>{
 const {client,calls}=setup(({url})=>response(url.endsWith('_rooms')?[room()]:room()));
 assert.equal((await client.getRoom({id:B},ROOM)).id,ROOM);assert.equal(calls[0].body.p_user_id,B);assert.equal(calls[0].body.p_room_id,ROOM);
 assert.deepEqual(await client.resume({id:A}),[{id:ROOM,createdAt:Date.parse(now),updatedAt:Date.parse(now)}]);
 const denied=setup(()=>response({code:'42501',message:'OLW_FORBIDDEN'},403));await assert.rejects(denied.client.getRoom({id:A},ROOM),{code:'ROOM_FORBIDDEN',status:403});
});

test('history uses stable timestamp plus ID keyset cursor and returns oldest to newest',async()=>{
 const {client,calls}=setup(()=>response([saved(M2,B),saved(M1,A)]));
 const first=await client.listMessages({id:A},ROOM,{limit:1});assert.equal(first.messages[0].id,M2);assert.equal(first.messages[0].authorId,B);assert.equal(first.messages[0].timestamp,Date.parse(now));assert(first.nextCursor);
 await client.listMessages({id:A},ROOM,{limit:1,before:first.nextCursor});
 assert.equal(calls[1].body.p_before_at,now);assert.equal(calls[1].body.p_before_id,M2);assert.equal(calls[1].body.p_limit,2);
 const all=await client.listMessages({id:A},ROOM,{limit:50});assert.deepEqual(all.messages.map(value=>value.id),[M1,M2]);assert.equal(all.nextCursor,null);
 await assert.rejects(client.listMessages({id:A},ROOM,{before:'broken'}),{code:'INVALID_CURSOR'});
 await assert.rejects(client.listMessages({id:A},ROOM,{limit:101}),{code:'INVALID_LIMIT'});assert.equal(calls.length,3);
});

test('writes are acknowledged only after RPC success and preserve sender, ID, original and language',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);let complete=false;
 const {client,calls}=setup(async()=>{await pending;return response({...saved(),duplicate:false})});
 const writing=client.saveMessage({id:A},ROOM,{id:M1,text:'寶貝，我想你了',lang:'zh-TW',device:'device-a'}).then(value=>{complete=true;return value});
 await Promise.resolve();assert.equal(complete,false);assert.equal(calls[0].body.p_user_id,A);assert.equal(calls[0].body.p_message_id,M1);assert.equal(calls[0].body.p_original_text,'寶貝，我想你了');assert.equal(calls[0].body.p_language,'zh-TW');
 release();const result=await writing;assert.equal(result.duplicate,false);assert.equal(result.authorId,A);
 const retry=setup(()=>response({...saved(),duplicate:true}));assert.equal((await retry.client.saveMessage({id:A},ROOM,{id:M1,text:'寶貝，我想你了',lang:'zh-TW',device:'device-a'})).duplicate,true);
 const conflict=setup(()=>response({code:'23505',message:'OLW_CONFLICT'},409));await assert.rejects(conflict.client.saveMessage({id:A},ROOM,{id:M1,text:'different',lang:'en'}),{code:'MESSAGE_CONFLICT',status:409});
});

test('database failure is explicit, safe, and never a false successful saved message',async()=>{
 const {client}=setup(()=>response({message:'sensitive '+env.SUPABASE_SERVICE_ROLE_KEY},500));
 await assert.rejects(client.saveMessage({id:A},ROOM,{id:M1,text:'hello',lang:'en'}),error=>error.code==='DATABASE_UNAVAILABLE'&&error.status===503&&!error.message.includes(env.SUPABASE_SERVICE_ROLE_KEY));
 assert.equal(client.status().healthy,false);
 const offline=setup(()=>{throw Error('private hostname and secret')});await assert.rejects(offline.client.resume({id:A}),{code:'DATABASE_UNAVAILABLE'});
 const invalid=setup(()=>response(room()));await assert.rejects(invalid.client.saveMessage({id:A},ROOM,{id:'bad',text:'hello',lang:'en'}),{code:'INVALID_MESSAGE'});assert.equal(invalid.calls.length,0);
});
