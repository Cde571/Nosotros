create table if not exists public.together_books (
  space_id uuid not null references public.spaces(id) on delete cascade,
  id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  catalog_key text check (catalog_key is null or catalog_key ~ '^/works/OL[0-9]{1,16}W$'),
  created_at timestamptz not null default now(),
  primary key (space_id, id)
);

create table if not exists public.together_room (
  space_id uuid primary key references public.spaces(id) on delete cascade,
  book_id uuid,
  page integer check (page between 1 and 10000),
  netflix_id text check (netflix_id is null or netflix_id ~ '^[0-9]{5,16}$'),
  starts_at timestamptz,
  youtube_id text check (youtube_id is null or youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  foreign key (space_id, book_id) references public.together_books(space_id, id)
);

alter table public.together_books enable row level security;
alter table public.together_room enable row level security;
revoke all on public.together_books, public.together_room from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('nosotros-books', 'nosotros-books', false, 20971520, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Object names consist of two UUIDs. Resolve access by the first UUID only.
create or replace function private.can_access_book_object(object_name text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select case
    when object_name ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.pdf$'
    then private.can_access(split_part(object_name, '/', 1)::uuid)
    else false
  end
$$;

drop policy if exists nosotros_pdf_read on storage.objects;
create policy nosotros_pdf_read on storage.objects for select to authenticated
using (bucket_id = 'nosotros-books' and private.can_access_book_object(name));
drop policy if exists nosotros_pdf_upload on storage.objects;
create policy nosotros_pdf_upload on storage.objects for insert to authenticated
with check (bucket_id = 'nosotros-books' and private.can_access_book_object(name));
drop policy if exists nosotros_pdf_cleanup on storage.objects;
create policy nosotros_pdf_cleanup on storage.objects for delete to authenticated
using (bucket_id = 'nosotros-books' and owner_id = (select auth.uid())::text
  and private.can_access_book_object(name));

-- Reuse the existing private Realtime signal without sending book titles or links in the event.
drop trigger if exists nosotros_together_book_update on public.together_books;
create trigger nosotros_together_book_update after insert on public.together_books
for each row execute function private.signal_pair_update();
drop trigger if exists nosotros_together_room_update on public.together_room;
create trigger nosotros_together_room_update after insert or update on public.together_room
for each row execute function private.signal_pair_update();

create or replace function private.together_state(target uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_access(target) then raise exception 'Espacio no disponible'; end if;
  return jsonb_build_object(
    'server_now', statement_timestamp(),
    'room', (select to_jsonb(r) from public.together_room r where r.space_id = target),
    'books', (select coalesce(jsonb_agg(to_jsonb(b) order by b.created_at desc), '[]'::jsonb)
      from public.together_books b where b.space_id = target));
end
$$;
create or replace function public.together_state(target uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.together_state(target) $$;

create or replace function private.together_add_book(target uuid, book uuid, book_title text, work_key text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_access(target) then raise exception 'Espacio no disponible'; end if;
  if work_key is null and not exists (
    select 1 from storage.objects where bucket_id = 'nosotros-books'
      and name = target::text || '/' || book::text || '.pdf'
  ) then raise exception 'El PDF no se encuentra'; end if;
  insert into public.together_books(space_id,id,title,catalog_key)
  values (target,book,btrim(book_title),work_key)
  on conflict (space_id,id) do nothing;
end
$$;
create or replace function public.together_add_book(target uuid, book uuid, book_title text, work_key text)
returns void language sql security invoker set search_path = '' as $$
  select private.together_add_book(target,book,book_title,work_key)
$$;

create or replace function private.together_action(target uuid, action text, value text, page_number integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_access(target) then raise exception 'Espacio no disponible'; end if;
  if action = 'reading' then
    if value is null or page_number is null or not exists (
      select 1 from public.together_books where space_id = target and id = value::uuid and catalog_key is null
    ) then raise exception 'El PDF no está en su biblioteca'; end if;
    insert into public.together_room(space_id,book_id,page) values (target,value::uuid,page_number)
    on conflict (space_id) do update set book_id = excluded.book_id, page = excluded.page;
  elsif action = 'netflix' then
    if value is null then raise exception 'Falta el enlace del título'; end if;
    insert into public.together_room(space_id,netflix_id) values (target,value)
    on conflict (space_id) do update set netflix_id = excluded.netflix_id, starts_at = null;
  elsif action = 'countdown' then
    update public.together_room set starts_at = clock_timestamp() + interval '15 seconds'
      where space_id = target and netflix_id is not null;
    if not found then raise exception 'Comparte primero un título de Netflix'; end if;
  elsif action = 'youtube' then
    if value is null then raise exception 'Falta el video'; end if;
    insert into public.together_room(space_id,youtube_id) values (target,value)
    on conflict (space_id) do update set youtube_id = excluded.youtube_id;
  else
    raise exception 'Acción no válida';
  end if;
  return private.together_state(target);
end
$$;
create or replace function public.together_action(target uuid, action text, value text, page_number integer)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.together_action(target,action,value,page_number)
$$;

revoke execute on function private.can_access_book_object(text),
  private.together_state(uuid), private.together_add_book(uuid,uuid,text,text),
  private.together_action(uuid,text,text,integer),
  public.together_state(uuid), public.together_add_book(uuid,uuid,text,text),
  public.together_action(uuid,text,text,integer) from public, anon, authenticated;
grant execute on function private.can_access_book_object(text),
  private.together_state(uuid), private.together_add_book(uuid,uuid,text,text),
  private.together_action(uuid,text,text,integer),
  public.together_state(uuid), public.together_add_book(uuid,uuid,text,text),
  public.together_action(uuid,text,text,integer) to authenticated;
