create table if not exists private.youtube_search_requests (
  space_id uuid not null references public.spaces(id) on delete cascade,
  requested_at timestamptz not null
);

alter table private.youtube_search_requests enable row level security;
revoke all on private.youtube_search_requests from public, anon, authenticated;

create or replace function public.take_youtube_search(search_space uuid, search_user uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  requested timestamptz;
  day_start timestamptz;
  total bigint;
  pair_total bigint;
  pair_latest timestamptz;
begin
  if not exists (
    select 1 from public.members where space_id = search_space and user_id = search_user and approved
  ) or (select count(*) from public.members where space_id = search_space and approved) <> 2 then
    return 'pair_required';
  end if;

  -- Check and reserve quota atomically across simultaneous Edge Function requests.
  perform pg_advisory_xact_lock(hashtextextended('nosotros:youtube-search', 0));
  requested := clock_timestamp();
  day_start := date_trunc('day', requested, 'America/Los_Angeles');
  delete from private.youtube_search_requests where requested_at < day_start;
  select count(*), count(*) filter (where space_id = search_space),
    max(requested_at) filter (where space_id = search_space)
  into total, pair_total, pair_latest
  from private.youtube_search_requests;

  if total >= 60 or pair_total >= 24 then return 'daily_limit'; end if;
  if pair_latest > requested - interval '6 seconds' then return 'slow_down'; end if;

  insert into private.youtube_search_requests (space_id, requested_at) values (search_space, requested);
  return 'allowed';
end;
$$;

revoke execute on function public.take_youtube_search(uuid, uuid) from public, anon, authenticated;
grant execute on function public.take_youtube_search(uuid, uuid) to service_role;
