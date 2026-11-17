-- Our Little World: private account + durable chat foundation (apply AFTER schema.sql).
-- Execute only in your own Supabase SQL editor after reviewing the setup guide.
-- IMPORTANT: This does not migrate existing browser-only chat history.
create extension if not exists pgcrypto;

-- Ensure room creator becomes a member automatically.
create or replace function public.olw_add_room_owner()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.room_members(room_id,user_id)
  values (new.id,new.created_by) on conflict do nothing;
  return new;
end $$;
revoke all on function public.olw_add_room_owner() from public, anon, authenticated;
drop trigger if exists olw_room_owner_member on public.rooms;
create trigger olw_room_owner_member after insert on public.rooms
for each row execute function public.olw_add_room_owner();

-- Invitation secrets are stored as hashes, never plaintext.
create table if not exists public.room_invites (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references public.rooms(id) on delete cascade,
 token_hash text not null unique,
 created_by uuid not null references auth.users(id),
 expires_at timestamptz not null,
 used_by uuid references auth.users(id),
 used_at timestamptz,
 created_at timestamptz not null default now()
);
create index if not exists olw_room_invites_expiry_idx on public.room_invites(expires_at);
alter table public.room_invites enable row level security;
-- No direct client policies: all invitation access goes through restricted RPCs.

create or replace function public.olw_create_invite(p_room_id uuid)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_token text;
begin
  if v_user is null then raise exception 'Sign in required'; end if;
  if not exists (select 1 from public.rooms where id=p_room_id and created_by=v_user)
    then raise exception 'Only the room owner may invite'; end if;
  if (select count(*) from public.room_members where room_id=p_room_id) >= 2
    then raise exception 'Room already has two members'; end if;
  delete from public.room_invites where room_id=p_room_id and used_at is null;
  v_token := encode(gen_random_bytes(32),'hex');
  insert into public.room_invites(room_id,token_hash,created_by,expires_at)
  values (p_room_id,encode(extensions.digest(v_token,'sha256'),'hex'),v_user,now()+interval '24 hours');
  return v_token;
end $$;

create or replace function public.olw_redeem_invite(p_token text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_room uuid;
begin
  if v_user is null then raise exception 'Sign in required'; end if;
  if p_token is null or p_token !~ '^[a-f0-9]{64}$'
    then raise exception 'Invalid invitation'; end if;
  select room_id into v_room from public.room_invites
   where token_hash=encode(extensions.digest(p_token,'sha256'),'hex')
     and used_at is null and expires_at>now()
   for update;
  if v_room is null then raise exception 'Invitation invalid or expired'; end if;
  if (select count(*) from public.room_members where room_id=v_room) >= 2
    then raise exception 'Room already has two members'; end if;
  insert into public.room_members(room_id,user_id) values(v_room,v_user)
  on conflict do nothing;
  update public.room_invites set used_at=now(),used_by=v_user
  where token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
  return v_room;
end $$;

revoke all on function public.olw_create_invite(uuid) from public, anon;
revoke all on function public.olw_redeem_invite(text) from public, anon;
grant execute on function public.olw_create_invite(uuid) to authenticated;
grant execute on function public.olw_redeem_invite(text) to authenticated;

-- Prevent message content edits disguised as soft deletes.
create or replace function public.olw_protect_message_fields()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.room_id is distinct from new.room_id
    or old.sender_id is distinct from new.sender_id
    or old.body is distinct from new.body
    or old.attachment_path is distinct from new.attachment_path
    or old.kind is distinct from new.kind
    or old.created_at is distinct from new.created_at
    or old.reply_to is distinct from new.reply_to
  then raise exception 'Message contents cannot be modified'; end if;
  return new;
end $$;
drop trigger if exists olw_protect_message_fields on public.messages;
create trigger olw_protect_message_fields before update on public.messages
for each row execute function public.olw_protect_message_fields();

-- Keep message ID stable for deduplication across devices and retries.
create unique index if not exists olw_messages_room_id_id_idx
  on public.messages(room_id,id);

-- Access is always enforced by Supabase Auth and existing RLS policies.
-- Never use service_role or database credentials in browser JavaScript.
