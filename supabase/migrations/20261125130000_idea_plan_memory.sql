alter table public.items
  add column if not exists accepted_by uuid,
  add column if not exists idea_id uuid references public.items(id),
  add column if not exists plan_id uuid references public.items(id),
  add column if not exists memory_photo uuid;

create unique index if not exists items_one_plan_per_idea
  on public.items(space_id, idea_id) where idea_id is not null;
create unique index if not exists items_one_memory_per_plan
  on public.items(space_id, plan_id) where plan_id is not null;

create or replace function private.guard_journey_item() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind <> old.kind and (old.idea_id is not null or old.plan_id is not null
    or (old.kind = 'idea' and exists (
      select 1 from public.items where space_id = old.space_id and idea_id = old.id
    ))) then
    raise exception 'La categoría está vinculada a su plan o recuerdo';
  end if;
  if old.idea_id is not null and new.day = '' then
    raise exception 'El plan necesita fecha y hora';
  end if;
  if old.kind = 'idea' and (new.kind, new.title, new.detail, new.day) is distinct from
    (old.kind, old.title, old.detail, old.day) then
    new.accepted_by := null;
  end if;
  return new;
end
$$;
revoke execute on function private.guard_journey_item() from public, anon, authenticated;
create or replace trigger nosotros_guard_journey_item before update on public.items
  for each row execute function private.guard_journey_item();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('nosotros-memories', 'nosotros-memories', false, 2097152, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.can_access_memory_photo(object_name text, for_upload boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when object_name ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.jpg$'
    then private.can_access(split_part(object_name, '/', 1)::uuid)
      and exists (
        select 1 from public.items where id = split_part(object_name, '/', 2)::uuid
          and space_id = split_part(object_name, '/', 1)::uuid and kind = 'plan'
          and (not for_upload or (done and not deleted))
      )
      and (for_upload or exists (
        select 1 from public.items where space_id = split_part(object_name, '/', 1)::uuid
          and plan_id = split_part(object_name, '/', 2)::uuid
          and memory_photo = left(split_part(object_name, '/', 3), 36)::uuid and not deleted
      ))
    else false
  end
$$;
revoke execute on function private.can_access_memory_photo(text,boolean) from public, anon, authenticated;
grant execute on function private.can_access_memory_photo(text,boolean) to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'nosotros_memory_photo_read') then
    create policy nosotros_memory_photo_read on storage.objects for select to authenticated
      using (bucket_id = 'nosotros-memories' and private.can_access_memory_photo(name, false));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'nosotros_memory_photo_upload') then
    create policy nosotros_memory_photo_upload on storage.objects for insert to authenticated
      with check (bucket_id = 'nosotros-memories' and private.can_access_memory_photo(name, true));
  end if;
end
$$;

create or replace function private.journey_action(target uuid, source uuid, action text, details jsonb) returns public.items
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  origin_row public.items;
  result public.items;
  day_text text;
  memory_title text;
  memory_note text;
  photo uuid;
  expected bigint;
begin
  select m.name into actor_name from public.members m
    where m.space_id = target and m.user_id = actor and m.approved;
  if not found or (select count(*) from public.members where space_id = target and approved) <> 2 then
    raise exception 'Vincula a tu pareja para usar este recorrido';
  end if;
  select * into origin_row from public.items where space_id = target and id = source and not deleted for update;
  if not found then raise exception 'El elemento ya no está disponible'; end if;

  if action in ('propose', 'accept', 'schedule') and origin_row.kind = 'idea' then
    if action = 'propose' then
      if origin_row.author_id is null then
        update public.items set author_id = actor, author = actor_name, done = false,
          version = version + 1, updated_at = clock_timestamp()
          where id = source returning * into origin_row;
      elsif origin_row.author_id <> actor then
        raise exception 'La idea pertenece a tu pareja';
      end if;
      return origin_row;
    end if;
    if origin_row.done then raise exception 'La propuesta está cerrada'; end if;
    if action = 'accept' then
      if origin_row.author_id is null or origin_row.author_id = actor then
        raise exception 'Tu pareja debe confirmar la propuesta';
      end if;
      if origin_row.accepted_by = actor then return origin_row; end if;
      if origin_row.version is distinct from (details->>'expected')::bigint then
        raise exception using errcode = '40001', message = 'La propuesta cambió. Revísala antes de apuntarte.';
      end if;
      update public.items set accepted_by = actor, version = version + 1, updated_at = clock_timestamp()
        where id = source returning * into result;
      return result;
    end if;

    select * into result from public.items where space_id = target and idea_id = source for update;
    if found and not result.deleted then return result; end if;
    if origin_row.accepted_by is null then raise exception 'Falta que tu pareja se apunte'; end if;
    day_text := details->>'day';
    if day_text is null or day_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'Elige una fecha y hora válidas';
    end if;
    perform day_text::timestamp;
    if result.id is not null then
      update public.items set deleted = false, done = false, day = day_text,
        version = version + 1, updated_at = clock_timestamp()
        where id = result.id returning * into result;
      return result;
    end if;
    insert into public.items(id, space_id, kind, title, detail, day, author, author_id, idea_id)
      values(gen_random_uuid(), target, 'plan', origin_row.title, origin_row.detail, day_text, actor_name, actor, source)
      returning * into result;
    return result;
  end if;

  if action is distinct from 'memory' or origin_row.kind <> 'plan' or not origin_row.done then
    raise exception 'Completa el plan antes de guardar el recuerdo';
  end if;
  memory_title := btrim(coalesce(details->>'title', ''));
  memory_note := btrim(coalesce(details->>'note', ''));
  photo := (details->>'photo')::uuid;
  expected := (details->>'expected')::bigint;
  if length(memory_title) not between 1 and 160 or length(memory_note) > 2000
    or (memory_note = '' and photo is null) then
    raise exception 'Agrega un título y una nota o una foto';
  end if;
  if photo is not null and not exists (
    select 1 from storage.objects where bucket_id = 'nosotros-memories'
      and name = target::text || '/' || source::text || '/' || photo::text || '.jpg'
  ) then raise exception 'La foto aún no está disponible'; end if;

  select * into result from public.items where space_id = target and plan_id = source for update;
  if found then
    if result.title = memory_title and result.detail = memory_note and result.memory_photo is not distinct from photo
      and not result.deleted then return result; end if;
    if (not result.deleted and expected is distinct from result.version)
      or (result.deleted and expected is not null) then
      raise exception using errcode = '40001', message = 'El recuerdo cambió. Vuelve a abrirlo para revisar la versión actual.';
    end if;
    update public.items set title = memory_title, detail = memory_note, memory_photo = photo,
      deleted = false, version = version + 1, updated_at = clock_timestamp()
      where id = result.id returning * into result;
  else
    if expected is not null then
      raise exception using errcode = '40001', message = 'El recuerdo ya no está disponible.';
    end if;
    insert into public.items(id,space_id,kind,title,detail,day,author,author_id,plan_id,memory_photo)
      values(gen_random_uuid(),target,'nota',memory_title,memory_note,origin_row.day,actor_name,actor,source,photo)
      returning * into result;
  end if;
  return result;
end
$$;

create or replace function public.journey_action(target uuid, source uuid, action text, details jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select to_jsonb(private.journey_action(target,source,action,details))
$$;
revoke execute on function private.journey_action(uuid,uuid,text,jsonb), public.journey_action(uuid,uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function private.journey_action(uuid,uuid,text,jsonb), public.journey_action(uuid,uuid,text,jsonb)
  to authenticated;
