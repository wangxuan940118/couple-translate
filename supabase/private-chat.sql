-- Our Little World: PostgreSQL history and membership, via server-only RPCs.
-- Run in Supabase SQL Editor as the project database administrator.
-- Independent of the older planning schema.sql; no existing tables are dropped.
begin;
create schema if not exists olw_private;
revoke all on schema olw_private from public, anon, authenticated;

create table if not exists olw_private.rooms (
 id uuid primary key default gen_random_uuid(),
 code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
create table if not exists olw_private.room_members (
 room_id uuid not null references olw_private.rooms(id) on delete cascade,
 user_id uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 primary key(room_id,user_id)
);
create index if not exists olw_member_user on olw_private.room_members(user_id,room_id);
create table if not exists olw_private.messages (
 id uuid primary key,
 room_id uuid not null references olw_private.rooms(id) on delete cascade,
 author_id uuid not null references auth.users(id),
 original_text text not null check (char_length(original_text) between 1 and 500 and btrim(original_text)<>''),
 language text not null check (language in ('zh-TW','en','sv','sr','fr','es','ja','ko','de','tr')),
 device_id text check (device_id is null or device_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(room_id,author_id) references olw_private.room_members(room_id,user_id)
);
create index if not exists olw_message_history on olw_private.messages(room_id,created_at desc,id desc);
alter table olw_private.rooms enable row level security;
alter table olw_private.room_members enable row level security;
alter table olw_private.messages enable row level security;
revoke all on all tables in schema olw_private from public, anon, authenticated;

-- Every membership mutation locks its room, so concurrent inserts cannot create
-- a third member. This also protects writes made outside the join RPC.
create or replace function olw_private.limit_two_members() returns trigger
language plpgsql set search_path='' as $$
begin
 perform 1 from olw_private.rooms where id=new.room_id for update;
 if (select count(*) from olw_private.room_members where room_id=new.room_id and user_id<>new.user_id)>=2 then
  raise exception using errcode='42501',message='OLW_FORBIDDEN';
 end if;
 return new;
end $$;
drop trigger if exists olw_two_members on olw_private.room_members;
create trigger olw_two_members before insert or update on olw_private.room_members for each row execute function olw_private.limit_two_members();

create or replace function olw_private.assert_member(p_user_id uuid,p_room_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_user_id is null or not exists(select 1 from olw_private.room_members where user_id=p_user_id and room_id=p_room_id) then
  raise exception using errcode='42501',message='OLW_FORBIDDEN';
 end if;
end $$;

create or replace function public.olw_private_join_room(p_user_id uuid,p_code_hash text,p_member_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target olw_private.rooms; members_count integer;
begin
 if p_user_id is null or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or cardinality(p_member_ids)<>2 or p_member_ids[1] is null or p_member_ids[2] is null or p_member_ids[1]=p_member_ids[2] or not (p_user_id=any(p_member_ids)) then
  raise exception using errcode='42501',message='OLW_FORBIDDEN';
 end if;
 insert into olw_private.rooms(code_hash) values(p_code_hash) on conflict(code_hash) do nothing;
 select * into target from olw_private.rooms where code_hash=p_code_hash for update;
 select count(*) into members_count from olw_private.room_members where room_id=target.id;
 if members_count=0 then
  insert into olw_private.room_members(room_id,user_id) select target.id,member_id from unnest(p_member_ids) member_id;
 elsif members_count<>2 or exists(select 1 from olw_private.room_members where room_id=target.id and not (user_id=any(p_member_ids))) then
  raise exception using errcode='42501',message='OLW_FORBIDDEN';
 end if;
 perform olw_private.assert_member(p_user_id,target.id);
 return jsonb_build_object('id',target.id,'created_at',target.created_at,'updated_at',target.updated_at);
end $$;

create or replace function public.olw_private_get_room(p_user_id uuid,p_room_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target olw_private.rooms;
begin
 perform olw_private.assert_member(p_user_id,p_room_id);
 select * into strict target from olw_private.rooms where id=p_room_id;
 return jsonb_build_object('id',target.id,'created_at',target.created_at,'updated_at',target.updated_at);
end $$;

create or replace function public.olw_private_rooms(p_user_id uuid) returns jsonb
language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(row_to_json(result) order by result.updated_at desc,result.id),'[]'::jsonb)
 from (select r.id,r.created_at,r.updated_at from olw_private.rooms r join olw_private.room_members m on m.room_id=r.id where m.user_id=p_user_id order by r.updated_at desc,r.id limit 100) result;
$$;

create or replace function public.olw_private_messages(p_user_id uuid,p_room_id uuid,p_before_at timestamptz default null,p_before_id uuid default null,p_limit integer default 51) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform olw_private.assert_member(p_user_id,p_room_id);
 if p_limit is null or p_limit not between 1 and 101 or (p_before_at is null)<>(p_before_id is null) then raise exception using errcode='22023',message='OLW_INVALID_INPUT';end if;
 select coalesce(jsonb_agg(row_to_json(page) order by page.created_at desc,page.id desc),'[]'::jsonb) into result
 from (select id,author_id,original_text,language,device_id,created_at from olw_private.messages
       where room_id=p_room_id and (p_before_at is null or (created_at,id)<(p_before_at,p_before_id))
       order by created_at desc,id desc limit p_limit) page;
 return result;
end $$;

create or replace function public.olw_private_save_message(p_user_id uuid,p_room_id uuid,p_message_id uuid,p_original_text text,p_language text,p_device_id text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved olw_private.messages; inserted boolean;
begin
 perform olw_private.assert_member(p_user_id,p_room_id);
 if p_message_id is null or p_original_text is null or char_length(p_original_text) not between 1 and 500 or btrim(p_original_text)='' or p_language is null or p_language not in ('zh-TW','en','sv','sr','fr','es','ja','ko','de','tr') or (p_device_id is not null and p_device_id !~ '^[A-Za-z0-9_-]{1,128}$') then
  raise exception using errcode='22023',message='OLW_INVALID_INPUT';
 end if;
 insert into olw_private.messages(id,room_id,author_id,original_text,language,device_id)
 values(p_message_id,p_room_id,p_user_id,p_original_text,p_language,p_device_id)
 on conflict(id) do nothing returning * into saved;
 inserted=found;
 if not inserted then
  select * into strict saved from olw_private.messages where id=p_message_id;
  if saved.room_id<>p_room_id or saved.author_id<>p_user_id or saved.original_text<>p_original_text or saved.language<>p_language or saved.device_id is distinct from p_device_id then
   raise exception using errcode='23505',message='OLW_CONFLICT';
  end if;
 else
  update olw_private.rooms set updated_at=greatest(updated_at,saved.created_at) where id=p_room_id;
 end if;
 return (to_jsonb(saved)-'room_id')||jsonb_build_object('duplicate',not inserted);
end $$;

-- PostgREST exposes the public RPC names, but anon/authenticated cannot execute
-- them. Only our server's private service role may supply a verified actor ID.
revoke all on all functions in schema olw_private from public, anon, authenticated;
revoke all on function public.olw_private_join_room(uuid,text,uuid[]) from public, anon, authenticated;
revoke all on function public.olw_private_get_room(uuid,uuid) from public, anon, authenticated;
revoke all on function public.olw_private_rooms(uuid) from public, anon, authenticated;
revoke all on function public.olw_private_messages(uuid,uuid,timestamptz,uuid,integer) from public, anon, authenticated;
revoke all on function public.olw_private_save_message(uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.olw_private_join_room(uuid,text,uuid[]) to service_role;
grant execute on function public.olw_private_get_room(uuid,uuid) to service_role;
grant execute on function public.olw_private_rooms(uuid) to service_role;
grant execute on function public.olw_private_messages(uuid,uuid,timestamptz,uuid,integer) to service_role;
grant execute on function public.olw_private_save_message(uuid,uuid,uuid,text,text,text) to service_role;
notify pgrst,'reload schema';
commit;
