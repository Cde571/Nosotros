alter table public.items add column if not exists media jsonb;

create or replace function private.save_item(payload jsonb) returns public.items
language plpgsql security definer set search_path='' as $$
declare target uuid:=(payload->>'space_id')::uuid; ident uuid:=(payload->>'id')::uuid;
  current_item public.items; saved public.items; expected bigint:=coalesce((payload->>'expected_version')::bigint,0);
  edited_media jsonb;
begin
  if auth.uid() is null or not private.can_access(target) then raise exception 'No tienes acceso a este espacio'; end if;
  if ident is null or payload->>'kind' is null or payload->>'kind' not in ('plan','compra','viaje','nota','idea','recuerdo','meta','latido') then raise exception 'Categoría inválida'; end if;
  if length(trim(coalesce(payload->>'title','')))=0 or length(payload->>'title')>160 or length(coalesce(payload->>'detail',''))>2000 or length(coalesce(payload->>'day',''))>32 then raise exception 'El título o los detalles no son válidos'; end if;
  -- Serializes even concurrent inserts with the same UUID.
  perform pg_advisory_xact_lock(hashtextextended(ident::text,1));
  select * into current_item from public.items where id=ident for update;
  edited_media := case
    when payload->>'kind' not in ('recuerdo','viaje') then null
    when payload ? 'media' then nullif(payload->'media','null'::jsonb)
    when current_item.kind = payload->>'kind' then current_item.media
  end;
  if edited_media is not null then
    if jsonb_typeof(edited_media) <> 'object' or octet_length(edited_media::text) > 2200 then
      raise exception 'Ficha multimedia inválida';
    end if;
    if (edited_media - array['id','name','subtitle','image','file','credit','youtube']) <> '{}'::jsonb
      or exists (select 1 from jsonb_each(edited_media) where jsonb_typeof(value) <> 'string')
      or length(coalesce(edited_media->>'name','')) > 160
      or length(coalesce(edited_media->>'subtitle','')) > 120
      or (edited_media ? 'credit' and (length(edited_media->>'credit') > 180 or not (edited_media ? 'image')))
      or (edited_media ? 'youtube' and edited_media->>'youtube' !~ '^[A-Za-z0-9_-]{11}$')
      or (edited_media ? 'id' and not (
        (payload->>'kind' = 'recuerdo' and edited_media->>'id' ~ '^tt[0-9]{7,12}$')
        or (payload->>'kind' = 'viaje' and edited_media->>'id' ~ '^[0-9]{1,8}$')
      ))
      or (edited_media ? 'file' and (length(edited_media->>'file') not between 1 and 240 or not (edited_media ? 'image')))
      or (edited_media ? 'image' and (
        payload->>'kind' <> 'viaje' or not (edited_media ? 'file')
        or edited_media->>'image' !~ '^https://(upload|thumb)\.wikimedia\.org/wikipedia/commons/'
      ))
    then raise exception 'Ficha multimedia inválida'; end if;
  end if;
  if current_item.id is not null then
    if current_item.space_id<>target then raise exception 'No tienes acceso a este elemento'; end if;
    if current_item.version<>expected then
      -- A retry after an interrupted response must not get stuck as a conflict.
      if current_item.kind=payload->>'kind' and current_item.title=payload->>'title' and current_item.detail=coalesce(payload->>'detail','') and current_item.day=coalesce(payload->>'day','') and current_item.done=coalesce((payload->>'done')::boolean,false) and current_item.deleted=coalesce((payload->>'deleted')::boolean,false) and current_item.media is not distinct from edited_media then return current_item; end if;
      raise exception using errcode='40001',message='Tu pareja también editó este elemento. Revisa ambas versiones.';
    end if;
    update public.items set kind=payload->>'kind',title=trim(payload->>'title'),detail=coalesce(payload->>'detail',''),day=coalesce(payload->>'day',''),done=coalesce((payload->>'done')::boolean,false),deleted=coalesce((payload->>'deleted')::boolean,false),media=edited_media,version=version+1,updated_at=clock_timestamp() where id=ident returning * into saved;
  else
    if expected<>0 then raise exception using errcode='40001',message='El elemento ya no está disponible.'; end if;
    insert into public.items(id,space_id,kind,title,detail,day,done,deleted,author,author_id,media)
      values(ident,target,payload->>'kind',trim(payload->>'title'),coalesce(payload->>'detail',''),coalesce(payload->>'day',''),coalesce((payload->>'done')::boolean,false),coalesce((payload->>'deleted')::boolean,false),coalesce((select name from public.members where user_id=auth.uid()),'Mi perfil'),auth.uid(),edited_media) returning * into saved;
  end if;
  return saved;
end $$;
