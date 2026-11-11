-- Our Little World canonical public schema, migration 002 (PR12 hardened).
-- Run preflight.sql, then schema.sql, then this file in an ADMIN SQL session.
-- Authentication uses the caller's Supabase JWT/auth.uid(); no service-role key.
-- Existing source_lang=NULL rows are preserved as unknown, never guessed.
begin;

do $$
declare v record;
begin
 if to_regclass('olw_private.messages') is not null or to_regclass('olw_private.members') is not null or to_regclass('olw_private.room_members') is not null then
  raise exception 'OLW_LEGACY_MIGRATION_REQUIRED: existing olw_private history/membership requires a separate reviewed migration; no legacy data was changed';
 end if;
 if to_regclass('public.rooms') is null or to_regclass('public.room_members') is null or to_regclass('public.messages') is null then
  raise exception 'OLW_SCHEMA_REQUIRED: apply the reviewed canonical schema.sql first';
 end if;
 for v in select c.table_name,c.column_name,c.udt_name from information_schema.columns c
 where c.table_schema='public' and c.table_name in ('rooms','room_members','messages','room_invites')
 and not exists (select 1 from (values
  ('rooms','id','uuid'),('rooms','name','text'),('rooms','created_by','uuid'),('rooms','created_at','timestamptz'),
  ('room_members','room_id','uuid'),('room_members','user_id','uuid'),('room_members','joined_at','timestamptz'),('room_members','member_slot','int2'),
  ('messages','id','uuid'),('messages','room_id','uuid'),('messages','sender_id','uuid'),('messages','kind','text'),('messages','body','text'),
  ('messages','attachment_path','text'),('messages','reply_to','uuid'),('messages','deleted_at','timestamptz'),('messages','created_at','timestamptz'),
  ('messages','source_lang','text'),('messages','device_id','text'),
  ('room_invites','id','uuid'),('room_invites','room_id','uuid'),('room_invites','token_hash','text'),('room_invites','created_by','uuid'),
  ('room_invites','expires_at','timestamptz'),('room_invites','used_by','uuid'),('room_invites','used_at','timestamptz'),('room_invites','created_at','timestamptz'),('room_invites','recipient_id','uuid')
 ) as expected(tbl,col,typ) where expected.tbl=c.table_name and expected.col=c.column_name and expected.typ=c.udt_name)
 loop raise exception 'OLW_SCHEMA_INCOMPATIBLE: unknown column/type public.%.% (%); review a separate migration',v.table_name,v.column_name,v.udt_name; end loop;
 if exists(select 1 from pg_catalog.pg_policies p where p.schemaname='public'
  and p.tablename in ('rooms','room_members','messages','room_invites','message_reads','message_reactions','push_subscriptions')
  and not exists(select 1 from (values
   ('rooms','rooms_read'),('rooms','rooms_create'),('room_members','members_read'),
   ('messages','messages_read'),('messages','messages_write'),('messages','messages_soft_delete'),
   ('message_reads','reads_read'),('message_reads','reads_write'),
   ('message_reactions','reactions_read'),('message_reactions','reactions_write'),('message_reactions','reactions_remove'),
   ('push_subscriptions','push_self_read'),('push_subscriptions','push_self_insert'),('push_subscriptions','push_self_update'),('push_subscriptions','push_self_delete')
  ) allowed(tbl,policy) where allowed.tbl=p.tablename and allowed.policy=p.policyname)) then
  raise exception 'OLW_POLICY_REVIEW_REQUIRED: unknown canonical-table policy; review possible RLS bypass before migration';
 end if;
end $$;

alter table public.messages add column if not exists source_lang text;
alter table public.messages add column if not exists device_id text;
alter table public.room_members add column if not exists member_slot smallint;

-- Structural two-slot uniqueness backs up row locks, including stale snapshots.
do $$
begin
 if exists(select 1 from public.room_members group by room_id having count(*)>2) then
  raise exception 'OLW_MEMBERSHIP_MIGRATION_REQUIRED: existing room has more than two members; no members were removed';
 end if;
end $$;
with slots as (
 select room_id,user_id,row_number() over(partition by room_id order by joined_at,user_id)::smallint as slot
 from public.room_members
)
update public.room_members m set member_slot=s.slot from slots s
where m.room_id=s.room_id and m.user_id=s.user_id and m.member_slot is null;
alter table public.room_members alter column member_slot set not null;
do $$ begin
 if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.room_members'::regclass and conname='olw_member_slot_range') then
  alter table public.room_members add constraint olw_member_slot_range check(member_slot in (1,2));
 end if;
end $$;
create unique index if not exists olw_room_member_slots on public.room_members(room_id,member_slot);

create or replace function public.olw_limit_room_members()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_slot smallint;
begin
 if tg_op='UPDATE' then
  perform r.id from public.rooms r where r.id in (old.room_id,new.room_id) order by r.id for update;
  select s.slot into v_slot from (values(1::smallint),(2::smallint)) s(slot)
   where not exists(select 1 from public.room_members m where m.room_id=new.room_id and m.member_slot=s.slot
     and not(m.room_id=old.room_id and m.user_id=old.user_id)) order by s.slot limit 1;
 else
  perform r.id from public.rooms r where r.id=new.room_id for update;
  -- A retry of an existing membership must not reserve another slot.
  select m.member_slot into v_slot from public.room_members m where m.room_id=new.room_id and m.user_id=new.user_id;
  if v_slot is null then
   select s.slot into v_slot from (values(1::smallint),(2::smallint)) s(slot)
    where not exists(select 1 from public.room_members m where m.room_id=new.room_id and m.member_slot=s.slot) order by s.slot limit 1;
  end if;
 end if;
 if v_slot is null then raise exception 'OLW_ROOM_FULL'; end if;
 new.member_slot:=v_slot;
 return new;
end $$;
revoke all on function public.olw_limit_room_members() from public,anon,authenticated;
drop trigger if exists olw_limit_room_members on public.room_members;
create trigger olw_limit_room_members before insert or update on public.room_members for each row execute function public.olw_limit_room_members();

create or replace function public.olw_add_room_owner()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.room_members(room_id,user_id) values(new.id,new.created_by) on conflict(room_id,user_id) do nothing;
 return new;
end $$;
revoke all on function public.olw_add_room_owner() from public,anon,authenticated;
drop trigger if exists olw_room_owner_member on public.rooms;
create trigger olw_room_owner_member after insert on public.rooms for each row execute function public.olw_add_room_owner();
-- Preserve existing rooms while repairing a missing owner membership, or fail if full.
insert into public.room_members(room_id,user_id)
select r.id,r.created_by from public.rooms r where not exists(select 1 from public.room_members m where m.room_id=r.id and m.user_id=r.created_by);

create table if not exists public.room_invites (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references public.rooms(id) on delete cascade,
 token_hash text not null unique,
 created_by uuid not null references auth.users(id),
 expires_at timestamptz not null,
 used_by uuid references auth.users(id),
 used_at timestamptz,
 created_at timestamptz not null default now(),
 recipient_id uuid references auth.users(id)
);
alter table public.room_invites add column if not exists recipient_id uuid references auth.users(id);
create index if not exists olw_room_invites_expiry_idx on public.room_invites(expires_at);
alter table public.room_invites enable row level security;
revoke all on public.room_invites from public,anon,authenticated;
-- Existing unbound invitations remain stored, but can never be redeemed by new RPCs.

-- Revoke PR12's unsafe old entry points if the draft was previously applied.
do $$ begin
 if to_regprocedure('public.olw_create_invite(uuid)') is not null then execute 'revoke all on function public.olw_create_invite(uuid) from public,anon,authenticated'; end if;
 if to_regprocedure('public.olw_redeem_invite(text)') is not null then execute 'revoke all on function public.olw_redeem_invite(text) from public,anon,authenticated'; end if;
end $$;

create or replace function public.olw_validate_message_insert()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.kind='text' and (new.body is null or char_length(btrim(new.body))<1 or char_length(new.body)>500 or new.source_lang is null) then
  raise exception 'OLW_INVALID_MESSAGE' using errcode='22023';
 end if;
 if new.source_lang is not null and new.source_lang not in ('zh-TW','en','sv','sr','fr','es','ja','ko','de','tr') then raise exception 'OLW_INVALID_LANGUAGE' using errcode='22023'; end if;
 if new.device_id is not null and new.device_id !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'OLW_INVALID_DEVICE' using errcode='22023'; end if;
 return new;
end $$;
revoke all on function public.olw_validate_message_insert() from public,anon,authenticated;
drop trigger if exists olw_validate_message_insert on public.messages;
create trigger olw_validate_message_insert before insert on public.messages for each row execute function public.olw_validate_message_insert();

create or replace function public.olw_protect_message_fields()
returns trigger language plpgsql set search_path='' as $$
begin
 if (to_jsonb(old)-'deleted_at') is distinct from (to_jsonb(new)-'deleted_at') then
  raise exception 'OLW_MESSAGE_IMMUTABLE' using errcode='42501';
 end if;
 if old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
  raise exception 'OLW_MESSAGE_ALREADY_DELETED' using errcode='42501';
 end if;
 return new;
end $$;
revoke all on function public.olw_protect_message_fields() from public,anon,authenticated;
drop trigger if exists olw_protect_message_fields on public.messages;
create trigger olw_protect_message_fields before update on public.messages for each row execute function public.olw_protect_message_fields();
create index if not exists olw_messages_room_cursor_idx on public.messages(room_id,created_at desc,id desc);

create or replace function public.olw_private_get_room(p_room_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_room public.rooms;
begin
 if auth.uid() is null then raise exception 'OLW_AUTH_REQUIRED' using errcode='42501'; end if;
 if not public.is_room_member(p_room_id) then raise exception 'OLW_FORBIDDEN' using errcode='42501'; end if;
 select * into v_room from public.rooms where id=p_room_id;
 if not found then raise exception 'OLW_FORBIDDEN' using errcode='42501'; end if;
 return to_jsonb(v_room);
end $$;

create or replace function public.olw_private_rooms()
returns setof public.rooms language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'OLW_AUTH_REQUIRED' using errcode='42501'; end if;
 return query select r.* from public.rooms r where public.is_room_member(r.id) order by r.created_at desc,r.id desc;
end $$;

create or replace function public.olw_private_renew_invite(p_room_id uuid,p_invite_hash text,p_invitee_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_room public.rooms; v_expires timestamptz;
begin
 if v_user is null then raise exception 'OLW_AUTH_REQUIRED' using errcode='42501'; end if;
 if p_invite_hash is null or p_invite_hash !~ '^[a-f0-9]{64}$' or p_invitee_id is null or p_invitee_id=v_user then raise exception 'OLW_INVALID_INVITE' using errcode='22023'; end if;
 select * into v_room from public.rooms where id=p_room_id for update;
 if not found or v_room.created_by<>v_user then raise exception 'OLW_FORBIDDEN' using errcode='42501'; end if;
 if not exists(select 1 from auth.users where id=p_invitee_id) then raise exception 'OLW_INVALID_INVITEE' using errcode='22023'; end if;
 if exists(select 1 from public.room_members where room_id=p_room_id and user_id=p_invitee_id) then raise exception 'OLW_ALREADY_MEMBER' using errcode='22023'; end if;
 if (select count(*) from public.room_members where room_id=p_room_id)>=2 then raise exception 'OLW_ROOM_FULL'; end if;
 delete from public.room_invites where room_id=p_room_id and used_at is null;
 v_expires:=clock_timestamp()+interval '24 hours';
 insert into public.room_invites(room_id,token_hash,created_by,expires_at,recipient_id)
 values(p_room_id,p_invite_hash,v_user,v_expires,p_invitee_id);
 return jsonb_build_object('room_id',p_room_id,'expires_at',v_expires);
end $$;

create or replace function public.olw_private_create_room(p_invite_hash text,p_invitee_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_room public.rooms; v_invite jsonb;
begin
 if v_user is null then raise exception 'OLW_AUTH_REQUIRED' using errcode='42501'; end if;
 insert into public.rooms(created_by) values(v_user) returning * into v_room;
 v_invite:=public.olw_private_renew_invite(v_room.id,p_invite_hash,p_invitee_id);
 return to_jsonb(v_room)||jsonb_build_object('invite_expires_at',v_invite->'expires_at');
end $$;

create or replace function public.olw_private_redeem_invite(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_hash text; v_room_id uuid; v_invite public.room_invites;
begin
 if v_user is null then raise exception 'OLW_AUTH_REQUIRED' using errcode='42501'; end if;
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception 'OLW_INVALID_INVITE' using errcode='22023'; end if;
 v_hash:=encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
 -- Always lock ROOM before INVITATION, the same order as renewal.
 select room_id into v_room_id from public.room_invites where token_hash=v_hash;
 if v_room_id is null then raise exception 'OLW_INVITE_INVALID'; end if;
 perform id from public.rooms where id=v_room_id for update;
 if not found then raise exception 'OLW_INVITE_INVALID'; end if;
 select * into v_invite from public.room_invites where token_hash=v_hash for update;
 if not found or v_invite.used_at is not null or v_invite.expires_at<=clock_timestamp() or v_invite.recipient_id is distinct from v_user then raise exception 'OLW_INVITE_INVALID'; end if;
 if exists(select 1 from public.room_members where room_id=v_room_id and user_id=v_user) then raise exception 'OLW_ALREADY_MEMBER' using errcode='22023'; end if;
 insert into public.room_members(room_id,user_id) values(v_room_id,v_user);
 update public.room_invites set used_at=clock_timestamp(),used_by=v_user where id=v_invite.id;
 return public.olw_private_get_room(v_room_id);
end $$;

create or replace function public.olw_private_messages(p_room_id uuid,p_before_at timestamptz default null,p_before_id uuid default null,p_limit integer default 50)
returns setof public.messages language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'OLW_AUTH_REQUIRED' using errcode='42501'; end if;
 if not public.is_room_member(p_room_id) then raise exception 'OLW_FORBIDDEN' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 101 or (p_before_at is null)<>(p_before_id is null) then raise exception 'OLW_INVALID_CURSOR' using errcode='22023'; end if;
 return query select m.* from public.messages m where m.room_id=p_room_id and m.kind='text' and m.deleted_at is null
  and (p_before_at is null or (m.created_at,m.id)<(p_before_at,p_before_id))
  order by m.created_at desc,m.id desc limit p_limit;
end $$;

create or replace function public.olw_private_save_message(p_room_id uuid,p_message_id uuid,p_original_text text,p_language text,p_device_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_body text:=btrim(p_original_text); v_row public.messages; v_duplicate boolean:=false;
begin
 if v_user is null then raise exception 'OLW_AUTH_REQUIRED' using errcode='42501'; end if;
 if not public.is_room_member(p_room_id) then raise exception 'OLW_FORBIDDEN' using errcode='42501'; end if;
 if p_message_id is null or v_body is null or char_length(v_body) not between 1 and 500 or p_language is null
  or p_language not in ('zh-TW','en','sv','sr','fr','es','ja','ko','de','tr')
  or (p_device_id is not null and p_device_id !~ '^[A-Za-z0-9_-]{1,128}$') then raise exception 'OLW_INVALID_MESSAGE' using errcode='22023'; end if;
 insert into public.messages(id,room_id,sender_id,kind,body,source_lang,device_id)
 values(p_message_id,p_room_id,v_user,'text',v_body,p_language,p_device_id)
 on conflict(id) do nothing returning * into v_row;
 if not found then
  v_duplicate:=true;
  select * into v_row from public.messages where id=p_message_id;
  if not found or v_row.room_id<>p_room_id or v_row.sender_id<>v_user or v_row.body is distinct from v_body
   or v_row.source_lang is distinct from p_language or v_row.kind<>'text' or v_row.deleted_at is not null then
   raise exception 'OLW_MESSAGE_CONFLICT' using errcode='23505';
  end if;
 end if;
 return to_jsonb(v_row)||jsonb_build_object('duplicate',v_duplicate);
end $$;

-- Explicit privileges, independent of a project's default table/function grants.
grant usage on schema public to anon,authenticated;
revoke all on public.rooms,public.room_members,public.messages,public.message_reads,public.message_reactions,public.push_subscriptions from public,anon;
grant select on public.rooms,public.room_members to authenticated;
grant select,insert,update on public.messages to authenticated;
grant select,insert,update,delete on public.message_reads,public.message_reactions,public.push_subscriptions to authenticated;
drop policy if exists rooms_create on public.rooms;
revoke insert,update,delete on public.rooms,public.room_members from authenticated;
revoke all on function public.olw_private_get_room(uuid),public.olw_private_rooms(),
 public.olw_private_create_room(text,uuid),public.olw_private_renew_invite(uuid,text,uuid),
 public.olw_private_redeem_invite(text),public.olw_private_messages(uuid,timestamptz,uuid,integer),
 public.olw_private_save_message(uuid,uuid,text,text,text) from public,anon;
grant execute on function public.olw_private_get_room(uuid),public.olw_private_rooms(),
 public.olw_private_create_room(text,uuid),public.olw_private_renew_invite(uuid,text,uuid),
 public.olw_private_redeem_invite(text),public.olw_private_messages(uuid,timestamptz,uuid,integer),
 public.olw_private_save_message(uuid,uuid,text,text,text) to authenticated;

-- Final transaction marker. Anonymous readiness may read ONLY this literal.
create or replace function public.olw_schema_version()
returns jsonb language sql immutable set search_path='' as $$select '{"version":1}'::jsonb$$;
revoke all on function public.olw_schema_version() from public;
grant execute on function public.olw_schema_version() to anon,authenticated;
commit;
