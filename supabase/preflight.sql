-- Read-only preflight. Run before migrations; inspect every row marked migration_needed.
-- No message text, token, credential, export, or modification is produced.
with legacy as (
 select c.relname as table_name from pg_catalog.pg_class c
 join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname='olw_private' and c.relkind in ('r','p')
), expected(table_name,column_name,data_type) as (values
 ('rooms','id','uuid'),('rooms','name','text'),('rooms','created_by','uuid'),('rooms','created_at','timestamptz'),
 ('room_members','room_id','uuid'),('room_members','user_id','uuid'),('room_members','joined_at','timestamptz'),
 ('room_members','member_slot','int2'),
 ('messages','id','uuid'),('messages','room_id','uuid'),('messages','sender_id','uuid'),('messages','kind','text'),
 ('messages','body','text'),('messages','attachment_path','text'),('messages','reply_to','uuid'),
 ('messages','deleted_at','timestamptz'),('messages','created_at','timestamptz'),
 ('messages','source_lang','text'),('messages','device_id','text'),
 ('room_invites','id','uuid'),('room_invites','room_id','uuid'),('room_invites','token_hash','text'),
 ('room_invites','created_by','uuid'),('room_invites','expires_at','timestamptz'),('room_invites','used_by','uuid'),
 ('room_invites','used_at','timestamptz'),('room_invites','created_at','timestamptz'),('room_invites','recipient_id','uuid')
)
select 'legacy_namespace' as check_name,'olw_private.'||table_name as object_name,
 true as migration_needed,'Existing separate schema requires explicit migration review; it will not be changed or exported.' as detail
from legacy
union all
select 'canonical_column',c.table_schema||'.'||c.table_name||'.'||c.column_name,true,
 'Unknown column or type; review before applying canonical migrations.'
from information_schema.columns c
where c.table_schema='public' and c.table_name in ('rooms','room_members','messages','room_invites')
 and not exists(select 1 from expected e where e.table_name=c.table_name and e.column_name=c.column_name and e.data_type=c.udt_name)
union all
select 'namespace_isolation','olw_private',false,'No automatic copy, export, delete, or alteration of legacy data is performed.';
