-- Upgrade 0.1/0.2 after schema.sql and migration-0.2.sql.
-- Public RPC wrappers expose only authenticated operations; privileged code stays private.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
alter table public.items add column if not exists version bigint not null default 1;
alter table public.items add column if not exists author_id uuid references auth.users(id);
alter table public.items add column if not exists votes uuid[] not null default '{}';
create index if not exists items_space_id_idx on public.items(space_id, id);
create index if not exists items_author_id_idx on public.items(author_id);
create index if not exists members_space_id_idx on public.members(space_id);
create index if not exists spaces_owner_idx on public.spaces(owner);
create index if not exists invites_space_id_idx on public.invites(space_id);

create or replace function private.can_access(s uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(select 1 from public.members where user_id=(select auth.uid()) and space_id=s and approved)
$$;
create or replace function public.can_access(s uuid) returns boolean
language sql stable security invoker set search_path='' as $$ select private.can_access(s) $$;

create or replace function private.create_space(display text) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  select space_id into result from public.members where user_id=auth.uid() and approved;
  if result is not null then return result; end if;
  if exists(select 1 from public.members where user_id=auth.uid()) then raise exception 'Ya tienes una solicitud pendiente'; end if;
  insert into public.spaces(owner) values(auth.uid()) returning id into result;
  insert into public.members(space_id,user_id,name,approved) values(result,auth.uid(),left(coalesce(nullif(trim(display),''),'Mi perfil'),80),true);
  return result;
end $$;
create or replace function public.create_space(display text) returns uuid
language sql security invoker set search_path='' as $$ select private.create_space(display) $$;

create or replace function private.make_invite() returns text
language plpgsql security definer set search_path='' as $$
declare target uuid; code text;
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  select id into target from public.spaces where owner=auth.uid() for update;
  if target is null then raise exception 'Solo el creador puede invitar'; end if;
  if (select count(*) from public.members where space_id=target)>=2 then raise exception 'Su espacio ya está completo'; end if;
  delete from public.invites where space_id=target;
  code:=upper(right(replace(gen_random_uuid()::text,'-',''),16));
  insert into public.invites values(code,target,now()+interval '30 minutes');
  return code;
end $$;
create or replace function public.make_invite() returns text
language sql security invoker set search_path='' as $$ select private.make_invite() $$;

create or replace function private.join_space(invite_code text,display text) returns uuid
language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  if exists(select 1 from public.members where user_id=auth.uid()) then raise exception 'Tu perfil ya pertenece a un espacio'; end if;
  select space_id into target from public.invites where code=upper(trim(invite_code)) and expires>clock_timestamp();
  if target is null then raise exception 'Código inválido o vencido'; end if;
  perform 1 from public.spaces where id=target for update;
  if not exists(select 1 from public.invites where code=upper(trim(invite_code)) and space_id=target and expires>clock_timestamp()) then raise exception 'Código inválido o vencido'; end if;
  if (select count(*) from public.members where space_id=target)>=2 then raise exception 'Su espacio ya está completo'; end if;
  -- The single-use, expiring code authorizes the second member. No extra approval.
  insert into public.members(space_id,user_id,name,approved) values(target,auth.uid(),left(coalesce(nullif(trim(display),''),'Mi perfil'),80),true);
  delete from public.invites where space_id=target;
  return target;
end $$;
create or replace function public.join_space(invite_code text,display text) returns uuid
language sql security invoker set search_path='' as $$ select private.join_space(invite_code,display) $$;

create or replace function private.update_profile(display text,avatar text,feeling text,since text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  if avatar is null or length(avatar)>100000 or (avatar<>'' and avatar !~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$') then raise exception 'Foto inválida'; end if;
  update public.members set name=left(coalesce(nullif(trim(display),''),'Mi perfil'),80),photo=avatar,mood=left(coalesce(feeling,''),80),anniversary=nullif(since,'')::date where user_id=auth.uid() and approved;
  if not found then raise exception 'Perfil no vinculado'; end if;
end $$;
create or replace function public.update_profile(display text,avatar text,feeling text,since text) returns void
language sql security invoker set search_path='' as $$ select private.update_profile(display,avatar,feeling,since) $$;

create or replace function private.approve_member(member_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  update public.members set approved=true where user_id=member_id and space_id in(select id from public.spaces where owner=auth.uid());
  if not found then raise exception 'Solicitud no encontrada'; end if;
end $$;
create or replace function public.approve_member(member_id uuid) returns void
language sql security invoker set search_path='' as $$ select private.approve_member(member_id) $$;

create or replace function private.my_space() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  return (select jsonb_build_object('id',m.space_id,'approved',m.approved,'name',m.name,'owner',s.owner=auth.uid(),'members',
    (select coalesce(jsonb_agg(jsonb_build_object('id',x.user_id,'name',x.name,'approved',x.approved,
      'photo',case when m.approved and x.approved then x.photo else '' end,
      'mood',case when m.approved and x.approved then x.mood else '' end,
      'anniversary',case when m.approved and x.approved then x.anniversary else null end)),'[]'::jsonb)
     from public.members x where x.space_id=m.space_id and (m.approved or x.user_id=auth.uid())))
    from public.members m join public.spaces s on s.id=m.space_id where m.user_id=auth.uid());
end $$;
create or replace function public.my_space() returns jsonb
language sql stable security invoker set search_path='' as $$ select private.my_space() $$;

create or replace function private.save_item(payload jsonb) returns public.items
language plpgsql security definer set search_path='' as $$
declare target uuid:=(payload->>'space_id')::uuid; ident uuid:=(payload->>'id')::uuid;
  current_item public.items; saved public.items; expected bigint:=coalesce((payload->>'expected_version')::bigint,0);
begin
  if auth.uid() is null or not private.can_access(target) then raise exception 'No tienes acceso a este espacio'; end if;
  if ident is null or payload->>'kind' is null or payload->>'kind' not in ('plan','compra','viaje','nota','idea','recuerdo','meta','latido') then raise exception 'Categoría inválida'; end if;
  if length(trim(coalesce(payload->>'title','')))=0 or length(payload->>'title')>160 or length(coalesce(payload->>'detail',''))>2000 or length(coalesce(payload->>'day',''))>32 then raise exception 'El título o los detalles no son válidos'; end if;
  -- Serializes even concurrent inserts with the same UUID.
  perform pg_advisory_xact_lock(hashtextextended(ident::text,1));
  select * into current_item from public.items where id=ident for update;
  if found then
    if current_item.space_id<>target then raise exception 'No tienes acceso a este elemento'; end if;
    if current_item.version<>expected then
      -- A retry after an interrupted response must not get stuck as a conflict.
      if current_item.kind=payload->>'kind' and current_item.title=payload->>'title' and current_item.detail=coalesce(payload->>'detail','') and current_item.day=coalesce(payload->>'day','') and current_item.done=coalesce((payload->>'done')::boolean,false) and current_item.deleted=coalesce((payload->>'deleted')::boolean,false) then return current_item; end if;
      raise exception using errcode='40001',message='Tu pareja también editó este elemento. Revisa ambas versiones.';
    end if;
    update public.items set kind=payload->>'kind',title=trim(payload->>'title'),detail=coalesce(payload->>'detail',''),day=coalesce(payload->>'day',''),done=coalesce((payload->>'done')::boolean,false),deleted=coalesce((payload->>'deleted')::boolean,false),version=version+1,updated_at=clock_timestamp() where id=ident returning * into saved;
  else
    if expected<>0 then raise exception using errcode='40001',message='El elemento ya no está disponible.'; end if;
    insert into public.items(id,space_id,kind,title,detail,day,done,deleted,author,author_id)
      values(ident,target,payload->>'kind',trim(payload->>'title'),coalesce(payload->>'detail',''),coalesce(payload->>'day',''),coalesce((payload->>'done')::boolean,false),coalesce((payload->>'deleted')::boolean,false),coalesce((select name from public.members where user_id=auth.uid()),'Mi perfil'),auth.uid()) returning * into saved;
  end if;
  return saved;
end $$;
create or replace function public.save_item(payload jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select to_jsonb(private.save_item(payload)) $$;

create or replace function private.vote_item(item_id uuid) returns public.items
language plpgsql security definer set search_path='' as $$
declare current_item public.items; saved public.items;
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  select * into current_item from public.items where id=item_id for update;
  if not found or not private.can_access(current_item.space_id) or current_item.deleted or current_item.kind<>'idea' then raise exception 'Idea no disponible'; end if;
  update public.items set votes=case when auth.uid()=any(votes) then array_remove(votes,auth.uid()) else array_append(votes,auth.uid()) end,updated_at=clock_timestamp() where id=item_id returning * into saved;
  return saved;
end $$;
create or replace function public.vote_item(item_id uuid) returns jsonb
language sql security invoker set search_path='' as $$ select to_jsonb(private.vote_item(item_id)) $$;

-- Mutations go through the validated RPCs, reads remain protected by RLS.
revoke insert,update,delete on public.items from authenticated,anon;
revoke all on public.spaces,public.members,public.invites from authenticated,anon;
grant select on public.items to authenticated;
alter table public.items enable row level security;
alter table public.spaces enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
revoke execute on function private.can_access(uuid),private.create_space(text),private.make_invite(),private.join_space(text,text),private.update_profile(text,text,text,text),private.approve_member(uuid),private.my_space(),private.save_item(jsonb),private.vote_item(uuid) from public,anon,authenticated;
grant execute on function private.can_access(uuid),private.create_space(text),private.make_invite(),private.join_space(text,text),private.update_profile(text,text,text,text),private.approve_member(uuid),private.my_space(),private.save_item(jsonb),private.vote_item(uuid) to authenticated;
revoke execute on function public.can_access(uuid),public.create_space(text),public.make_invite(),public.join_space(text,text),public.update_profile(text,text,text,text),public.approve_member(uuid),public.my_space(),public.save_item(jsonb),public.vote_item(uuid) from public,anon;
grant execute on function public.can_access(uuid),public.create_space(text),public.make_invite(),public.join_space(text,text),public.update_profile(text,text,text,text),public.approve_member(uuid),public.my_space(),public.save_item(jsonb),public.vote_item(uuid) to authenticated;
