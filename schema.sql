-- MostPopular.com — corrective Supabase migration
-- Run AFTER the original schema. This is a targeted migration, not a full rebuild.
-- It fixes:
--   1. Concurrent figure/verification limit bypasses.
--   2. Public access to internal figure columns.
--   3. Read RPCs that need access to protected score columns.
--   4. Inconsistent zero-vote figure ranks.
--   5. NULL leaderboard limits accidentally removing the row limit.
--   6. Explicit function execution grants.

begin;

-- ---------------------------------------------------------------------
-- 1. Serialise figure creation per owner, and enforce owner identity.
-- ---------------------------------------------------------------------
create or replace function public.figures_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if new.owner_id is distinct from v_uid then
    raise exception 'invalid_owner' using errcode = '42501';
  end if;

  -- Same user always receives the same lock. Hash collisions only
  -- cause harmless extra serialisation; they do not weaken the limit.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  if (
    select count(*)
    from public.figures
    where owner_id = v_uid
  ) >= 3 then
    raise exception 'figure_limit';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Serialise verification requests and enforce figure ownership.
-- ---------------------------------------------------------------------
create or replace function public.verifications_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if new.owner_id is distinct from v_uid then
    raise exception 'invalid_owner' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.figures f
    where f.id = new.figure_id
      and f.owner_id = v_uid
  ) then
    raise exception 'figure_not_owned';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  if (
    select count(*)
    from public.verifications
    where owner_id = v_uid
      and created_at > now() - interval '24 hours'
  ) >= 5 then
    raise exception 'verification_rate_limited';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Restrict direct figure reads to public-facing columns.
-- The RPCs below are SECURITY DEFINER and return only their declared
-- public result columns. Their search_path is fixed.
-- ---------------------------------------------------------------------
revoke select on public.figures from anon, authenticated;

grant select (
  id,
  slug,
  display_name,
  avatar_url,
  category,
  country_code,
  region,
  verified,
  created_at,
  updated_at
)
on public.figures to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Leaderboard RPC: protected score columns remain server-side.
-- Coalesce NULL p_limit so LIMIT can never become unbounded.
-- ---------------------------------------------------------------------
create or replace function public.leaderboard(
  p_country text default null,
  p_category text default null,
  p_limit int default 50
)
returns table (
  rank int,
  id uuid,
  slug text,
  display_name text,
  avatar_url text,
  category text,
  country_code char(2),
  verified boolean,
  score float8
)
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  select
    rank() over (order by s.sc desc)::int,
    s.id,
    s.slug,
    s.display_name,
    s.avatar_url,
    s.category,
    s.country_code,
    s.verified,
    s.sc
  from (
    select
      f.id,
      f.slug,
      f.display_name,
      f.avatar_url,
      f.category,
      f.country_code,
      f.verified,
      public.mp_score(f.score_log_fast, f.score_log_slow) as sc
    from public.figures f
    where f.vote_count > 0
      and (p_country is null or f.country_code = upper(p_country))
      and (p_category is null or f.category = p_category)
  ) s
  order by s.sc desc, s.id
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- ---------------------------------------------------------------------
-- 5. Figure ranks: zero-vote figures return NULL ranks and score 0.
-- Figures with votes are ranked using the same population as leaderboard.
-- ---------------------------------------------------------------------
create or replace function public.figure_ranks(p_figure uuid)
returns table (
  global_rank int,
  country_rank int,
  category_country_rank int,
  score float8
)
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  with target as (
    select f.id, f.vote_count
    from public.figures f
    where f.id = p_figure
  ),
  ranked as (
    select
      f.id,
      public.mp_score(f.score_log_fast, f.score_log_slow) as sc,
      rank() over (
        order by public.mp_score(f.score_log_fast, f.score_log_slow) desc
      ) as g,
      rank() over (
        partition by f.country_code
        order by public.mp_score(f.score_log_fast, f.score_log_slow) desc
      ) as c,
      rank() over (
        partition by f.country_code, f.category
        order by public.mp_score(f.score_log_fast, f.score_log_slow) desc
      ) as cc
    from public.figures f
    where f.vote_count > 0
  )
  select
    case when t.vote_count > 0 then r.g::int else null end,
    case when t.vote_count > 0 then r.c::int else null end,
    case when t.vote_count > 0 then r.cc::int else null end,
    coalesce(r.sc, 0::float8)
  from target t
  left join ranked r on r.id = t.id;
$$;

-- ---------------------------------------------------------------------
-- 6. Keep personal vote status behind authenticated RPC.
-- It uses votes under the caller's RLS identity.
-- ---------------------------------------------------------------------
create or replace function public.my_vote_status()
returns table (
  used int,
  remaining int,
  next_slot_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    count(*)::int,
    greatest(0, 3 - count(*)::int),
    case
      when count(*) >= 3
      then min(created_at) + interval '24 hours'
      else null
    end
  from public.votes
  where voter_id = auth.uid()
    and created_at > now() - interval '24 hours';
$$;

-- ---------------------------------------------------------------------
-- 7. Remove direct access to internal daily-limit state.
-- The frontend should call my_vote_status() instead.
-- ---------------------------------------------------------------------
revoke select on public.daily_limits from anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. Explicit function permissions. PostgreSQL grants EXECUTE to PUBLIC
-- by default, so remove that implicit access and grant only intended roles.
-- ---------------------------------------------------------------------
revoke all on function public.leaderboard(text, text, int) from public;
revoke all on function public.figure_ranks(uuid) from public;
revoke all on function public.my_vote_status() from public;

grant execute on function public.leaderboard(text, text, int)
  to anon, authenticated;
grant execute on function public.figure_ranks(uuid)
  to anon, authenticated;
grant execute on function public.my_vote_status()
  to authenticated;

-- The verification finaliser remains service-role only.
revoke all on function public.mp_mark_verified(uuid, text)
  from public, anon, authenticated;
grant execute on function public.mp_mark_verified(uuid, text)
  to service_role;

commit;

-- ---------------------------------------------------------------------
-- POST-MIGRATION CHECKS (run separately after the migration):
--
-- 1. Check table grants:
-- select grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in ('figures', 'daily_limits')
-- order by table_name, grantee, privilege_type;
--
-- 2. Check function security:
-- select routine_name, security_type
-- from information_schema.routines
-- where routine_schema = 'public'
--   and routine_name in ('leaderboard', 'figure_ranks', 'my_vote_status');
--
-- 3. Test as anon: leaderboard should work; direct SELECT of
--    score_log_fast, score_log_slow, owner_id should fail.
--
-- 4. Test as authenticated: my_vote_status should work and return
--    only the current user's vote count.
--
-- NOTE: If your frontend directly selects daily_limits, change it to call
-- my_vote_status() before applying this migration.
