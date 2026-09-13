-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  access.sql
--  Join-with-a-code sign-up.
--
--  Run this AFTER schema.sql, functions.sql, rls.sql and seed.sql.
--  Safe to re-run.
--
--  WHY IT WORKS THIS WAY
--  ---------------------
--  Employees sign in anonymously (Supabase issues a real JWT with no
--  e-mail attached) and then "claim" their account with a shared code.
--  Until the code is accepted the profile is INACTIVE, which means the
--  account can do nothing: create_service_request() refuses inactive
--  profiles, and an inactive user sees no more than a passer-by does.
--
--  The code is checked inside the database, never in the browser. It is
--  stored as a bcrypt hash in a table that has RLS enabled and NO
--  policies at all, so it is unreachable except from the SECURITY
--  DEFINER functions below. Even with the anon key in hand, a stranger
--  cannot read it, and cannot activate themselves without it.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. THE CODE ITSELF
-- ---------------------------------------------------------------------
create table if not exists public.access_codes (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null,
  label      text,
  active     boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists access_codes_active_idx on public.access_codes (active);

-- Deliberately no policies. Nothing that speaks to PostgREST can read
-- this table; only the SECURITY DEFINER functions below can.
alter table public.access_codes enable row level security;
revoke all on public.access_codes from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. BRUTE-FORCE BRAKE
--    Supabase already rate-limits anonymous sign-ins per IP address.
--    This stops one session hammering the code on top of that.
-- ---------------------------------------------------------------------
create table if not exists public.access_attempts (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  attempts     integer not null default 0,
  last_attempt timestamptz not null default now()
);
alter table public.access_attempts enable row level security;
revoke all on public.access_attempts from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. NEW ACCOUNTS
--    An anonymous sign-up starts inactive and nameless; claiming the
--    code fills both in. An e-mail sign-up stays active, but only while
--    the administrator leaves e-mail sign-up switched on.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_anon boolean := (new.email is null or new.email = '');
  v_name text;
begin
  v_name := nullif(trim(new.raw_user_meta_data ->> 'full_name'), '');
  if v_name is null then
    v_name := case when v_anon then 'Not named yet' else split_part(new.email, '@', 1) end;
  end if;

  insert into public.profiles (id, full_name, email, role, active)
  values (
    new.id,
    left(v_name, 120),
    new.email,
    'employee',                       -- admins are promoted manually, never self-assigned
    case
      when v_anon then false          -- must present the access code first
      else public.setting_bool('allow_email_signup', true)
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 4. PRIVILEGE GUARD (updated)
--    Still blocks self-promotion, but now lets claim_staff_access()
--    flip `active` on. The exemption is a transaction-local flag that
--    only that function sets, and it can never touch `role`.
-- ---------------------------------------------------------------------
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  -- NOT SECURITY DEFINER on purpose: this function needs to see the role
  -- the statement is really running as. A SECURITY DEFINER function would
  -- report its owner (postgres) here and the check below would be useless.
  --
  -- PostgREST runs every API request as `anon` or `authenticated`, so those
  -- are the only roles this guard applies to. A direct connection (the
  -- Supabase SQL editor, psql, a migration, the service-role key) is a
  -- database administrator and is trusted -- that is how the very first
  -- admin gets promoted, since auth.uid() is NULL with no JWT present.
  v_via_api  boolean := current_user in ('anon', 'authenticated');
  v_claiming boolean := coalesce(current_setting('app.claiming_access', true), '') = 'on';
begin
  if not v_via_api then
    return new;
  end if;

  if v_claiming and new.role is distinct from old.role then
    raise exception 'An access code can never change a role' using errcode = '42501';
  end if;

  if (new.role is distinct from old.role or new.active is distinct from old.active)
     and not public.is_admin()
     and not v_claiming then
    raise exception 'Only an administrator can change a role or deactivate an account'
      using errcode = '42501';
  end if;

  return new;
end;
$fn$;

drop trigger if exists guard_profiles on public.profiles;
create trigger guard_profiles
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- ---------------------------------------------------------------------
-- 5. CLAIM: "my name is X and here is the code"
-- ---------------------------------------------------------------------
create or replace function public.claim_staff_access(p_code text, p_name text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_name     text;
  v_attempts integer;
  v_last     timestamptz;
  v_ok       boolean;
  v_row      public.profiles;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  v_name := nullif(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  if v_name is null or char_length(v_name) < 2 then
    raise exception 'Please enter your full name' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'That name is too long' using errcode = '22023';
  end if;

  if not exists (select 1 from public.access_codes where active) then
    raise exception 'No access code has been set up yet. Please ask the administrator.'
      using errcode = '42501';
  end if;

  -- Brake check
  insert into public.access_attempts (user_id) values (v_uid) on conflict (user_id) do nothing;
  select attempts, last_attempt into v_attempts, v_last
    from public.access_attempts where user_id = v_uid;

  if v_last <= now() - interval '15 minutes' then
    update public.access_attempts set attempts = 0 where user_id = v_uid;
    v_attempts := 0;
  elsif v_attempts >= 6 then
    raise exception 'Too many incorrect codes. Please wait 15 minutes and try again.'
      using errcode = '42501';
  end if;

  select exists (
    select 1 from public.access_codes
     where active and code_hash = crypt(coalesce(p_code, ''), code_hash)
  ) into v_ok;

  if not v_ok then
    update public.access_attempts
       set attempts = attempts + 1, last_attempt = now()
     where user_id = v_uid;
    raise exception 'That access code is not correct' using errcode = '42501';
  end if;

  -- Correct code: name the account and switch it on.
  perform set_config('app.claiming_access', 'on', true);   -- transaction-local
  update public.profiles
     set full_name = v_name,
         active    = true
   where id = v_uid
  returning * into v_row;
  perform set_config('app.claiming_access', 'off', true);

  if not found then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;

  delete from public.access_attempts where user_id = v_uid;
  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 6. ADMIN: set or rotate the code
--    Rotating does NOT sign anybody out. People who already joined stay
--    active; the new code only affects people joining from now on.
-- ---------------------------------------------------------------------
create or replace function public.set_staff_access_code(p_code text, p_label text default null)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_code text := trim(coalesce(p_code, ''));
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = '42501';
  end if;
  if char_length(v_code) < 4 then
    raise exception 'Choose a code of at least 4 characters' using errcode = '22023';
  end if;
  if char_length(v_code) > 64 then
    raise exception 'That code is too long' using errcode = '22023';
  end if;

  update public.access_codes set active = false where active;

  insert into public.access_codes (code_hash, label, created_by)
  values (crypt(v_code, gen_salt('bf')), nullif(trim(coalesce(p_label, '')), ''), auth.uid());

  insert into public.audit_log (actor_id, action, entity, details)
  values (auth.uid(), 'access_code_set', 'access_codes',
          jsonb_build_object('label', nullif(trim(coalesce(p_label, '')), '')));
end;
$fn$;

-- ---------------------------------------------------------------------
-- 7. WHAT THE SIGN-IN PAGE IS ALLOWED TO KNOW
--    Whether a code exists — never the code itself.
-- ---------------------------------------------------------------------
create or replace function public.access_options()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'code_ready',        exists (select 1 from public.access_codes where active),
    'allow_email_signup', public.setting_bool('allow_email_signup', true)
  );
$fn$;

-- ---------------------------------------------------------------------
-- 8. HOUSEKEEPING
--    Anonymous accounts abandoned before the code was accepted. They can
--    do nothing, but there is no reason to keep them.
-- ---------------------------------------------------------------------
create or replace function public.purge_unclaimed_guests(p_older_than interval default interval '2 days')
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare v_count integer;
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = '42501';
  end if;

  with doomed as (
    select p.id from public.profiles p
    join auth.users u on u.id = p.id
    where p.active = false
      and (u.email is null or u.email = '')
      and p.created_at < now() - p_older_than
      and not exists (select 1 from public.service_requests sr where sr.requester_id = p.id)
  )
  delete from auth.users where id in (select id from doomed);

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 9. SETTINGS + GRANTS
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('allow_email_signup', 'true'::jsonb)
on conflict (key) do nothing;

revoke all on function public.claim_staff_access(text, text)      from public;
revoke all on function public.set_staff_access_code(text, text)    from public;
revoke all on function public.purge_unclaimed_guests(interval)     from public;

grant execute on function public.claim_staff_access(text, text)    to authenticated;
grant execute on function public.set_staff_access_code(text, text) to authenticated;
grant execute on function public.purge_unclaimed_guests(interval)  to authenticated;
grant execute on function public.access_options()                  to anon, authenticated;
