-- Realtime announces membership changes without publishing profile data or photos.
create table if not exists public.pair_updates (
  space_id uuid primary key references public.spaces(id) on delete cascade,
  revision bigint not null default 1
);
alter table public.pair_updates enable row level security;
revoke all on public.pair_updates from anon, authenticated;
grant select on public.pair_updates to authenticated;
drop policy if exists pair_updates_read on public.pair_updates;
create policy pair_updates_read on public.pair_updates
  for select to authenticated using (private.can_access(space_id));

create or replace function private.signal_pair_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pair_updates(space_id)
  values (new.space_id)
  on conflict (space_id) do update set revision = pair_updates.revision + 1;
  return new;
end;
$$;
revoke execute on function private.signal_pair_update() from public, anon, authenticated;
drop trigger if exists nosotros_pair_update on public.members;
create trigger nosotros_pair_update
  after insert or update on public.members
  for each row execute function private.signal_pair_update();

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='items'
  ) then
    alter publication supabase_realtime add table public.items;
  end if;
  if not exists (
    select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='pair_updates'
  ) then
    alter publication supabase_realtime add table public.pair_updates;
  end if;
end;
$$;
