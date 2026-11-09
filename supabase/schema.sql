-- Our Little World: proposed Supabase schema. Run only after configuring Auth.
-- Private conversations require membership checks; never expose service_role keys.
create extension if not exists pgcrypto;
create table if not exists public.rooms (
 id uuid primary key default gen_random_uuid(),
 name text not null default 'Our Little World',
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now()
);
create table if not exists public.room_members (
 room_id uuid not null references public.rooms(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 joined_at timestamptz not null default now(),
 primary key(room_id,user_id)
);
create table if not exists public.messages (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references public.rooms(id) on delete cascade,
 sender_id uuid not null references auth.users(id),
 kind text not null default 'text' check(kind in ('text','image','video','file','voice')),
 body text,
 attachment_path text,
 reply_to uuid references public.messages(id) on delete set null,
 deleted_at timestamptz,
 created_at timestamptz not null default now(),
 check(body is not null or attachment_path is not null)
);
create index if not exists messages_room_created_idx on public.messages(room_id,created_at desc);
create table if not exists public.message_reads (
 message_id uuid not null references public.messages(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 read_at timestamptz not null default now(),
 primary key(message_id,user_id)
);
create table if not exists public.message_reactions (
 message_id uuid not null references public.messages(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 emoji text not null check(char_length(emoji) between 1 and 12),
 primary key(message_id,user_id,emoji)
);
create table if not exists public.push_subscriptions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 endpoint text not null unique,
 subscription jsonb not null,
 updated_at timestamptz not null default now()
);
create or replace function public.is_room_member(r uuid) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.room_members where room_id=r and user_id=(select auth.uid()))$$;
revoke all on function public.is_room_member(uuid) from public;
grant execute on function public.is_room_member(uuid) to authenticated;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reads enable row level security;
alter table public.message_reactions enable row level security;
alter table public.push_subscriptions enable row level security;
create policy rooms_read on public.rooms for select to authenticated using(public.is_room_member(id));
create policy rooms_create on public.rooms for insert to authenticated with check(created_by=(select auth.uid()));
create policy members_read on public.room_members for select to authenticated using(public.is_room_member(room_id));
create policy messages_read on public.messages for select to authenticated using(public.is_room_member(room_id));
create policy messages_write on public.messages for insert to authenticated with check(sender_id=(select auth.uid()) and public.is_room_member(room_id));
create policy messages_soft_delete on public.messages for update to authenticated using(sender_id=(select auth.uid()) and public.is_room_member(room_id)) with check(sender_id=(select auth.uid()) and public.is_room_member(room_id));
create policy reads_read on public.message_reads for select to authenticated using(exists(select 1 from public.messages m where m.id=message_id and public.is_room_member(m.room_id)));
create policy reads_write on public.message_reads for insert to authenticated with check(user_id=(select auth.uid()) and exists(select 1 from public.messages m where m.id=message_id and public.is_room_member(m.room_id)));
create policy reactions_read on public.message_reactions for select to authenticated using(exists(select 1 from public.messages m where m.id=message_id and public.is_room_member(m.room_id)));
create policy reactions_write on public.message_reactions for insert to authenticated with check(user_id=(select auth.uid()) and exists(select 1 from public.messages m where m.id=message_id and public.is_room_member(m.room_id)));
create policy reactions_remove on public.message_reactions for delete to authenticated using(user_id=(select auth.uid()));
create policy push_self_read on public.push_subscriptions for select to authenticated using(user_id=(select auth.uid()));
create policy push_self_insert on public.push_subscriptions for insert to authenticated with check(user_id=(select auth.uid()));
create policy push_self_update on public.push_subscriptions for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
create policy push_self_delete on public.push_subscriptions for delete to authenticated using(user_id=(select auth.uid()));
-- Membership invitation must be implemented via verified server-side function.
-- Never add an unrestricted room_members INSERT policy.
