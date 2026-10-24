-- S14 forward migration 2 of 3: durable attempt limits, protected provider-attempt ledger and the
-- server-only lease/reserve/finalize RPCs (PLAN.md s.4 bounds and "Exact workflow").
-- Written under Dirty Mode; not applied or executed. Valid Postgres 15 syntax by careful reading only.
-- Depends on 20261024000100_run_versions.sql (app_private helpers, runs/run_items/run_arm_attempts).
--
-- Accounting model:
-- * usage_counters.attempts / charged_usd are the conservative balances every cap is checked
--   against. A reservation adds 1 attempt and the verified worst-case USD. Settlement never lowers
--   them; a reported actual above the worst case raises charged_usd by the excess. Only an attempt
--   the edge proves was never sent ('not_sent') releases its reservation.
-- * usage_counters.actual_usd accumulates provider-reported usage separately from reservations.
-- * Counters are separate from app_limits, so a configuration change cannot erase outstanding
--   reservations; lowering a cap only blocks further reservations.
-- * Fixed lock order on every reserve/settle path: app_total -> app_day -> user_day -> run counter
--   rows (SELECT ... FOR UPDATE after INSERT ... ON CONFLICT DO NOTHING), then the run_items row,
--   then provider_attempts rows. The app_total row is always tracked and locked (it is enforced
--   only when app_limits.app_total_usd is set), so enabling a total cap later counts history.
-- * Exactly-once external billing is not guaranteed after a crash between provider success and
--   commit; such attempts stay reserved/unknown and keep their charge.
--
-- Error contract as in 20261024000100: MESSAGE = public code, SQLSTATE PTnnn.

-- ---------------------------------------------------------------------------------------------
-- Single-row configuration. Proposed product defaults (not provider prices); live stays disabled
-- until the owner enables it.

create table public.app_limits (
  id boolean primary key default true check (id),
  user_day_attempts integer not null default 50 check (user_day_attempts >= 0),
  app_day_attempts integer not null default 200 check (app_day_attempts >= 0),
  max_run_usd numeric not null default 1 check (max_run_usd >= 0 and max_run_usd <= 1000),
  max_user_day_usd numeric not null default 3 check (max_user_day_usd >= 0 and max_user_day_usd <= 1000),
  max_app_day_usd numeric not null default 10 check (max_app_day_usd >= 0 and max_app_day_usd <= 10000),
  app_total_usd numeric check (app_total_usd >= 0 and app_total_usd <= 100000),
  live_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.app_limits (id) values (true);

create function app_private.app_limits_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform app_private.fail('frozen_or_mismatch', 'The app_limits row cannot be deleted.');
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger app_limits_guard before update or delete on public.app_limits
  for each row execute function app_private.app_limits_guard();

-- ---------------------------------------------------------------------------------------------
-- Shared counters. counter_key: 'app_total' | 'app_day:YYYY-MM-DD' | 'user_day:<uuid>:YYYY-MM-DD'
-- | 'run:<uuid>'. Days are UTC calendar days.

create table public.usage_counters (
  counter_key text primary key,
  scope text not null check (scope in ('app_total', 'app_day', 'user_day', 'run')),
  user_id uuid references auth.users (id) on delete cascade,
  run_id uuid references public.runs (id) on delete cascade,
  day date,
  attempts integer not null default 0 check (attempts >= 0),
  charged_usd numeric not null default 0 check (charged_usd >= 0),
  actual_usd numeric not null default 0 check (actual_usd >= 0),
  updated_at timestamptz not null default now(),
  constraint usage_counters_shape check (
    (scope = 'app_total' and user_id is null and run_id is null and day is null)
    or (scope = 'app_day' and user_id is null and run_id is null and day is not null)
    or (scope = 'user_day' and user_id is not null and run_id is null and day is not null)
    or (scope = 'run' and user_id is not null and run_id is not null and day is null)
  )
);

create index usage_counters_user_idx on public.usage_counters (user_id);
create index usage_counters_run_idx on public.usage_counters (run_id);

-- ---------------------------------------------------------------------------------------------
-- Protected provider-attempt ledger: one row per possibly charged provider call.

create table public.provider_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  question_key text not null,
  arm text not null check (arm in ('no_research', 'research')),
  dataset_version_id uuid not null,
  user_id uuid not null,
  sequence smallint not null check (sequence in (1, 2)),
  request_key text not null check (char_length(request_key) between 1 and 200),
  worst_case_usd numeric not null check (worst_case_usd > 0 and worst_case_usd <= 1000),
  status text not null default 'reserved'
    check (status in ('reserved', 'succeeded', 'failed_transient', 'failed_terminal', 'unknown', 'not_sent')),
  actual_usd numeric check (actual_usd >= 0 and actual_usd <= 1000),
  usage jsonb check (usage is null or (jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 8192)),
  provider_request_id text check (char_length(provider_request_id) <= 256),
  error_code text check (error_code ~ '^[a-z0-9_.:-]{1,64}$'),
  retry_not_before timestamptz,
  -- UTC day of the reservation; settlement always hits the same day counters.
  day date not null,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  constraint provider_attempts_item_fkey foreign key (run_id, question_key, arm)
    references public.run_items (run_id, question_key, arm) on delete cascade,
  constraint provider_attempts_run_fkey foreign key (run_id, dataset_version_id, user_id)
    references public.runs (id, dataset_version_id, user_id) on delete cascade,
  constraint provider_attempts_ref_key unique (id, run_id, question_key, arm, sequence)
);

-- A released (provably unsent) reservation frees its slot and key; nothing else does.
create unique index provider_attempts_slot_key on public.provider_attempts (run_id, question_key, arm, sequence)
  where status <> 'not_sent';
create unique index provider_attempts_request_key on public.provider_attempts (run_id, request_key)
  where status <> 'not_sent';
create index provider_attempts_user_idx on public.provider_attempts (user_id, created_at desc);
create index provider_attempts_reserved_idx on public.provider_attempts (run_id) where status = 'reserved';

-- Live attempts must point at the provider charge of the same run/item/sequence.
alter table public.run_arm_attempts
  add constraint run_arm_attempts_provider_fkey foreign key (provider_attempt_id, run_id, question_key, arm, sequence)
    references public.provider_attempts (id, run_id, question_key, arm, sequence) deferrable initially deferred;

create index run_arm_attempts_provider_idx on public.run_arm_attempts (provider_attempt_id);

-- ---------------------------------------------------------------------------------------------
-- Row level security and grants. Clients may read limits and their own counters/ledger rows;
-- nobody but the definer RPCs writes counters or the ledger (the service role included).

alter table public.app_limits enable row level security;
alter table public.usage_counters enable row level security;
alter table public.provider_attempts enable row level security;

create policy app_limits_read on public.app_limits
  for select to authenticated
  using (true);

create policy usage_counters_owner_read on public.usage_counters
  for select to authenticated
  using (
    usage_counters.user_id = (select auth.uid())
    and (
      usage_counters.run_id is null
      or exists (
        select 1 from public.runs as run
        where run.id = usage_counters.run_id and run.user_id = (select auth.uid())
      )
    )
  );

create policy provider_attempts_owner_read on public.provider_attempts
  for select to authenticated
  using (
    provider_attempts.user_id = (select auth.uid())
    and exists (
      select 1 from public.run_items as item
      where item.run_id = provider_attempts.run_id
        and item.question_key = provider_attempts.question_key
        and item.arm = provider_attempts.arm
        and item.user_id = (select auth.uid())
    )
  );

revoke all on public.app_limits, public.usage_counters, public.provider_attempts from anon, authenticated, service_role;
grant select on public.app_limits, public.usage_counters, public.provider_attempts to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- lease_arm(user, run, question, arm, holder, leaseSeconds) -> jsonb
-- {leased, state, leaseExpiresAt?, retryNotBefore?, selectedAttemptId?, chargedCalls, attempts, reasonCode?}
--
-- Terminal item: leased=false with its stored state (caller returns the cached result).
-- Live lease by the same holder: renewed. Live lease by another holder: in_progress.
-- Expired lease: explicit retry; the expired holder's reserved provider attempt becomes 'unknown'
-- with its charge kept consumed; no remaining slot ends the item failed (attempts_exhausted).
-- research waits until no_research is terminal. Only one leased item per run at a time, so only
-- one provider call per run can be active.

create function public.lease_arm(
  p_user_id uuid,
  p_run_id uuid,
  p_question_key text,
  p_arm text,
  p_holder uuid,
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  v_item public.run_items%rowtype;
  v_seconds integer := coalesce(p_lease_seconds, 90);
  v_attempts integer;
begin
  if p_user_id is null or p_run_id is null or p_question_key is null or p_holder is null then
    perform app_private.fail('invalid_input', 'user, run, question and holder are required.');
  end if;
  if p_arm is null or p_arm not in ('no_research', 'research') then
    perform app_private.fail('invalid_input', 'arm must be no_research or research.');
  end if;
  if v_seconds < 10 or v_seconds > 300 then
    perform app_private.fail('invalid_input', 'lease seconds must be 10..300.');
  end if;

  select * into v_run from public.runs as run
  where run.id = p_run_id and run.user_id = p_user_id and run.dataset_version_id is not null
  for update;
  if not found then
    perform app_private.fail('not_found', 'Run not found.');
  end if;
  if v_run.status not in ('created', 'processing') then
    perform app_private.fail('frozen_or_mismatch', 'Run is terminal; start a new linked run.');
  end if;

  select * into v_item from public.run_items as item
  where item.run_id = p_run_id and item.question_key = p_question_key and item.arm = p_arm
  for update;
  if not found then
    perform app_private.fail('not_found', 'Run item not found.');
  end if;

  select count(*) into v_attempts from public.run_arm_attempts as attempt
  where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm;

  if v_item.state in ('done', 'withheld', 'failed', 'skipped') then
    return jsonb_build_object(
      'leased', false, 'state', v_item.state, 'selectedAttemptId', v_item.selected_attempt_id,
      'chargedCalls', v_item.charged_calls, 'attempts', v_attempts, 'reasonCode', v_item.reason_code
    );
  end if;

  if v_item.state = 'leased' then
    if v_item.lease_expires_at > now() then
      -- Any live lease, including one held by the same request key, is in progress: a replayed key
      -- must never start a second concurrent provider call or release the first call's lease.
      perform app_private.fail('in_progress', 'This arm is leased by an in-flight request.');
    end if;
    -- Expired lease: explicit retry. Its possibly billed reservation stays consumed.
    update public.provider_attempts as attempt
    set status = 'unknown', error_code = 'lease_expired', finalized_at = now()
    where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
      and attempt.status = 'reserved';
    update public.run_items as item
    set state = 'pending', lease_holder = null, lease_expires_at = null, updated_at = now()
    where item.run_id = p_run_id and item.question_key = p_question_key and item.arm = p_arm
    returning * into v_item;
  end if;

  -- The item is not under a live lease here, so any provider row still 'reserved' for it is orphaned
  -- (its holder released or lost the lease before settling). Keep the charge as 'unknown' so the
  -- edge records the slot as a failed attempt and nothing stays stranded.
  update public.provider_attempts as attempt
  set status = 'unknown', error_code = coalesce(attempt.error_code, 'lease_released'), finalized_at = now()
  where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
    and attempt.status = 'reserved';

  -- pending. Exhaustion is decided by recorded attempts: a charged slot without an attempt row
  -- (expired lease) is recorded by the edge as a failed transient attempt under the next lease.
  if v_attempts >= 2 then
    update public.run_items as item
    set state = 'failed', reason_code = 'attempts_exhausted', retry_not_before = null, updated_at = now()
    where item.run_id = p_run_id and item.question_key = p_question_key and item.arm = p_arm
    returning * into v_item;
    return jsonb_build_object(
      'leased', false, 'state', v_item.state, 'selectedAttemptId', null,
      'chargedCalls', v_item.charged_calls, 'attempts', v_attempts, 'reasonCode', v_item.reason_code
    );
  end if;
  if v_item.retry_not_before is not null and v_item.retry_not_before > now() then
    return jsonb_build_object(
      'leased', false, 'state', 'pending', 'retryNotBefore', v_item.retry_not_before,
      'chargedCalls', v_item.charged_calls, 'attempts', v_attempts
    );
  end if;
  if p_arm = 'research' and exists (
    select 1 from public.run_items as baseline
    where baseline.run_id = p_run_id and baseline.question_key = p_question_key and baseline.arm = 'no_research'
      and baseline.state not in ('done', 'withheld', 'failed', 'skipped')
  ) then
    perform app_private.fail('in_progress', 'no_research must reach a terminal state before research starts.');
  end if;
  if exists (
    select 1 from public.run_items as other
    where other.run_id = p_run_id and other.state = 'leased' and other.lease_expires_at > now()
      and not (other.question_key = p_question_key and other.arm = p_arm)
  ) then
    perform app_private.fail('in_progress', 'Only one provider call per run may be active.');
  end if;

  update public.run_items as item
  set state = 'leased', lease_holder = p_holder, lease_expires_at = now() + make_interval(secs => v_seconds), updated_at = now()
  where item.run_id = p_run_id and item.question_key = p_question_key and item.arm = p_arm
  returning * into v_item;
  if v_run.status = 'created' then
    update public.runs set status = 'processing' where id = p_run_id;
  end if;
  return jsonb_build_object(
    'leased', true, 'state', 'leased', 'leaseExpiresAt', v_item.lease_expires_at,
    'chargedCalls', v_item.charged_calls, 'attempts', v_attempts
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- reserve_attempt(user, run, question, arm, sequence, requestKey, worstCaseUsd, leaseHolder) -> provider_attempts.id
--
-- Live runs only, with live_enabled. Caller must hold the item's unexpired lease. Locks counters
-- in the fixed order, then the item. Enforces: one in-flight provider call per run, <= 2 charged
-- calls per arm (sequence = next free slot), run planned ceiling questionCount * 2 arms * 2
-- attempts, daily user/app attempt caps and run/user-day/app-day/(app-total) USD caps.

create function public.reserve_attempt(
  p_user_id uuid,
  p_run_id uuid,
  p_question_key text,
  p_arm text,
  p_sequence integer,
  p_request_key text,
  p_worst_case_usd numeric,
  p_lease_holder uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits public.app_limits%rowtype;
  v_run public.runs%rowtype;
  v_item public.run_items%rowtype;
  v_day date := (now() at time zone 'utc')::date;
  v_total public.usage_counters%rowtype;
  v_app public.usage_counters%rowtype;
  v_user public.usage_counters%rowtype;
  v_run_counter public.usage_counters%rowtype;
  v_keys text[];
  v_questions integer;
  v_next integer;
  v_id uuid;
begin
  if p_user_id is null or p_run_id is null or p_question_key is null or p_lease_holder is null then
    perform app_private.fail('invalid_input', 'user, run, question and lease holder are required.');
  end if;
  if p_arm is null or p_arm not in ('no_research', 'research') then
    perform app_private.fail('invalid_input', 'arm must be no_research or research.');
  end if;
  if p_request_key is null or char_length(p_request_key) not between 1 and 200 then
    perform app_private.fail('invalid_input', 'request key must be 1..200 characters.');
  end if;
  if p_worst_case_usd is null or p_worst_case_usd <= 0
    or p_worst_case_usd = 'NaN'::numeric or p_worst_case_usd > 1000 then
    perform app_private.fail('invalid_input', 'worst-case USD must be a verified positive amount.');
  end if;

  select * into v_limits from public.app_limits as limits where limits.id;
  if not found or not v_limits.live_enabled then
    perform app_private.fail('configuration_required', 'Live model calls are not enabled.');
  end if;

  select * into v_run from public.runs as run
  where run.id = p_run_id and run.user_id = p_user_id and run.dataset_version_id is not null;
  if not found then
    perform app_private.fail('not_found', 'Run not found.');
  end if;
  if v_run.status not in ('created', 'processing') then
    perform app_private.fail('frozen_or_mismatch', 'Run is terminal.');
  end if;
  -- The RPC re-validates its own invariant: the run's pinned model profile must still be enabled.
  if not exists (
    select 1
    from public.run_manifests as manifest
    join public.model_profiles as profile on profile.profile_version = manifest.model_profile_version
    where manifest.run_id = p_run_id and profile.enabled
  ) then
    perform app_private.fail('configuration_required', 'The run''s pinned model profile is not enabled.');
  end if;
  if v_run.mode <> 'live' then
    perform app_private.fail('invalid_input', 'Replay runs have no provider path.');
  end if;
  select cardinality(manifest.evaluation_keys) into v_questions
  from public.run_manifests as manifest where manifest.run_id = p_run_id;

  v_keys := array[
    'app_total',
    'app_day:' || v_day::text,
    'user_day:' || p_user_id::text || ':' || v_day::text,
    'run:' || p_run_id::text
  ];
  insert into public.usage_counters (counter_key, scope, user_id, run_id, day) values
    (v_keys[1], 'app_total', null, null, null),
    (v_keys[2], 'app_day', null, null, v_day),
    (v_keys[3], 'user_day', p_user_id, null, v_day),
    (v_keys[4], 'run', p_user_id, p_run_id, null)
  on conflict (counter_key) do nothing;

  -- Fixed lock order: app_total -> app_day -> user_day -> run -> item.
  select * into v_total from public.usage_counters as counter where counter.counter_key = v_keys[1] for update;
  select * into v_app from public.usage_counters as counter where counter.counter_key = v_keys[2] for update;
  select * into v_user from public.usage_counters as counter where counter.counter_key = v_keys[3] for update;
  select * into v_run_counter from public.usage_counters as counter where counter.counter_key = v_keys[4] for update;
  select * into v_item from public.run_items as item
  where item.run_id = p_run_id and item.question_key = p_question_key and item.arm = p_arm
  for update;
  if not found then
    perform app_private.fail('not_found', 'Run item not found.');
  end if;
  if v_item.state <> 'leased' or v_item.lease_holder is distinct from p_lease_holder or v_item.lease_expires_at <= now() then
    perform app_private.fail('frozen_or_mismatch', 'Only the current, unexpired lease holder may reserve an attempt.');
  end if;
  if v_item.retry_not_before is not null and v_item.retry_not_before > now() then
    perform app_private.fail('in_progress', 'Retry is not allowed before ' || v_item.retry_not_before::text || '.');
  end if;

  -- Stale in-flight reservations of this run (their item is no longer under a live lease) become
  -- 'unknown' and keep their charge; any remaining in-flight call blocks a second one.
  update public.provider_attempts as attempt
  set status = 'unknown', error_code = 'lease_expired', finalized_at = now()
  where attempt.run_id = p_run_id and attempt.status = 'reserved'
    and not exists (
      select 1 from public.run_items as item
      where item.run_id = attempt.run_id and item.question_key = attempt.question_key and item.arm = attempt.arm
        and item.state = 'leased' and item.lease_expires_at > now()
    );
  if exists (select 1 from public.provider_attempts as attempt where attempt.run_id = p_run_id and attempt.status = 'reserved') then
    perform app_private.fail('in_progress', 'Only one provider call per run may be active.');
  end if;

  -- Next slot after every charged reservation and every recorded attempt of this arm.
  select greatest(
    coalesce((
      select max(attempt.sequence) from public.provider_attempts as attempt
      where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
        and attempt.status <> 'not_sent'
    ), 0),
    coalesce((
      select max(attempt.sequence) from public.run_arm_attempts as attempt
      where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
    ), 0)
  ) + 1 into v_next;
  if v_item.charged_calls >= 2 or v_next > 2 then
    perform app_private.fail('budget_exhausted', 'arm_attempts: two charged calls per arm are used.');
  end if;
  if p_sequence is distinct from v_next then
    perform app_private.fail('invalid_input', 'sequence must be the next free slot (' || v_next || ').');
  end if;

  if v_limits.app_total_usd is not null and v_total.charged_usd + p_worst_case_usd > v_limits.app_total_usd then
    perform app_private.fail('budget_exhausted', 'app_total_usd');
  end if;
  if v_app.attempts + 1 > v_limits.app_day_attempts then
    perform app_private.fail('budget_exhausted', 'app_day_attempts');
  end if;
  if v_app.charged_usd + p_worst_case_usd > v_limits.max_app_day_usd then
    perform app_private.fail('budget_exhausted', 'app_day_usd');
  end if;
  if v_user.attempts + 1 > v_limits.user_day_attempts then
    perform app_private.fail('budget_exhausted', 'user_day_attempts');
  end if;
  if v_user.charged_usd + p_worst_case_usd > v_limits.max_user_day_usd then
    perform app_private.fail('budget_exhausted', 'user_day_usd');
  end if;
  if v_run_counter.attempts + 1 > coalesce(v_questions, 0) * 2 * 2 then
    perform app_private.fail('budget_exhausted', 'run_planned_ceiling');
  end if;
  if v_run_counter.charged_usd + p_worst_case_usd > v_limits.max_run_usd then
    perform app_private.fail('budget_exhausted', 'run_usd');
  end if;

  begin
    insert into public.provider_attempts (
      run_id, question_key, arm, dataset_version_id, user_id, sequence, request_key, worst_case_usd, day
    ) values (
      p_run_id, p_question_key, p_arm, v_run.dataset_version_id, p_user_id, p_sequence, p_request_key, p_worst_case_usd, v_day
    )
    returning id into v_id;
  exception when unique_violation then
    perform app_private.fail('in_progress', 'This request key or slot already has a reservation.');
  end;

  update public.usage_counters as counter
  set attempts = counter.attempts + 1, charged_usd = counter.charged_usd + p_worst_case_usd, updated_at = now()
  where counter.counter_key = any (v_keys);
  update public.run_items as item
  set charged_calls = item.charged_calls + 1, updated_at = now()
  where item.run_id = p_run_id and item.question_key = p_question_key and item.arm = p_arm;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- finalize_attempt(attempt, status, actualUsd, usage, providerRequestId, errorCode, retryNotBefore)
--
-- status: succeeded | failed_transient | failed_terminal | unknown | not_sent.
-- From 'reserved' any status is allowed; from 'unknown' (expired lease, call may have finished)
-- only a billed outcome may settle. 'not_sent' (edge proves fetch never started) is the only path
-- that releases the reservation. A settled attempt is immutable.

create function public.finalize_attempt(
  p_attempt_id uuid,
  p_status text,
  p_actual_usd numeric,
  p_usage jsonb,
  p_provider_request_id text,
  p_error_code text,
  p_retry_not_before timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.provider_attempts%rowtype;
  v_keys text[];
  v_extra numeric;
begin
  if p_status is null or p_status not in ('succeeded', 'failed_transient', 'failed_terminal', 'unknown', 'not_sent') then
    perform app_private.fail('invalid_input', 'status must be succeeded, failed_transient, failed_terminal, unknown or not_sent.');
  end if;
  if p_actual_usd is not null and (p_actual_usd < 0 or p_actual_usd = 'NaN'::numeric or p_actual_usd > 1000) then
    perform app_private.fail('invalid_input', 'actual USD must be a finite non-negative amount.');
  end if;
  if p_usage is not null and (jsonb_typeof(p_usage) <> 'object' or octet_length(p_usage::text) > 8192) then
    perform app_private.fail('invalid_input', 'usage must be a small object of allowlisted fields.');
  end if;
  if p_provider_request_id is not null and char_length(p_provider_request_id) > 256 then
    perform app_private.fail('invalid_input', 'provider request id is too long.');
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z0-9_.:-]{1,64}$' then
    perform app_private.fail('invalid_input', 'error code must be a sanitized code.');
  end if;

  -- Identity columns are immutable, so an unlocked read is safe for choosing the lock keys.
  select * into v_attempt from public.provider_attempts as attempt where attempt.id = p_attempt_id;
  if not found then
    perform app_private.fail('not_found', 'Provider attempt not found.');
  end if;
  v_keys := array[
    'app_total',
    'app_day:' || v_attempt.day::text,
    'user_day:' || v_attempt.user_id::text || ':' || v_attempt.day::text,
    'run:' || v_attempt.run_id::text
  ];
  perform 1 from public.usage_counters as counter where counter.counter_key = v_keys[1] for update;
  perform 1 from public.usage_counters as counter where counter.counter_key = v_keys[2] for update;
  perform 1 from public.usage_counters as counter where counter.counter_key = v_keys[3] for update;
  perform 1 from public.usage_counters as counter where counter.counter_key = v_keys[4] for update;
  perform 1 from public.run_items as item
  where item.run_id = v_attempt.run_id and item.question_key = v_attempt.question_key and item.arm = v_attempt.arm
  for update;
  select * into v_attempt from public.provider_attempts as attempt where attempt.id = p_attempt_id for update;

  if v_attempt.status not in ('reserved', 'unknown') then
    perform app_private.fail('frozen_or_mismatch', 'Provider attempt is already settled.');
  end if;

  if p_status = 'not_sent' then
    if v_attempt.status <> 'reserved' then
      perform app_private.fail('frozen_or_mismatch', 'Only a reserved attempt that was provably never sent may be released.');
    end if;
    update public.usage_counters as counter
    set attempts = counter.attempts - 1, charged_usd = counter.charged_usd - v_attempt.worst_case_usd, updated_at = now()
    where counter.counter_key = any (v_keys);
    update public.run_items as item
    set charged_calls = item.charged_calls - 1, updated_at = now()
    where item.run_id = v_attempt.run_id and item.question_key = v_attempt.question_key and item.arm = v_attempt.arm
      and item.charged_calls > 0;
    update public.provider_attempts
    set status = 'not_sent', error_code = p_error_code, finalized_at = now()
    where id = p_attempt_id;
    return;
  end if;

  if v_attempt.status = 'unknown' and p_status = 'unknown' then
    return;
  end if;

  -- Settle: the reservation stays; only usage above the worst case raises the charged balance.
  v_extra := greatest(coalesce(p_actual_usd, 0) - v_attempt.worst_case_usd, 0);
  update public.usage_counters as counter
  set charged_usd = counter.charged_usd + v_extra,
      actual_usd = counter.actual_usd + coalesce(p_actual_usd, 0),
      updated_at = now()
  where counter.counter_key = any (v_keys);
  update public.provider_attempts
  set status = p_status,
      actual_usd = p_actual_usd,
      usage = p_usage,
      provider_request_id = p_provider_request_id,
      error_code = p_error_code,
      -- Persisted Retry-After, clamped to 1..300 s (default 5 s) from now.
      retry_not_before = case
        when p_status = 'failed_transient' then
          greatest(now() + interval '1 second', least(coalesce(p_retry_not_before, now() + interval '5 seconds'), now() + interval '300 seconds'))
      end,
      finalized_at = now()
  where id = p_attempt_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- finalize_arm_result(run, question, arm, holder, attempt, claimDecisions, nextState,
--                     selectedAttemptId, retryNotBefore) -> appended run_arm_attempts.id (or null)
--
-- Only the current lease holder may write; a stale holder cannot overwrite a replacement's result.
-- p_attempt is the engine AttemptRecord plus requestKey, cacheKey (live/cache_hit),
-- providerAttemptId (live) and cacheSourceAttemptId (cache_hit); null when no attempt is appended
-- (skipped research with an empty evidence pack). p_claim_decisions must equal
-- p_attempt.evaluation.claims ([] when absent). next_state: done | withheld | failed | skipped |
-- pending (retry with the remaining slot). done selects the first valid attempt in sequence order.

create function public.finalize_arm_result(
  p_run_id uuid,
  p_question_key text,
  p_arm text,
  p_holder uuid,
  p_attempt jsonb,
  p_claim_decisions jsonb,
  p_next_state text,
  p_selected_attempt_id uuid,
  p_retry_not_before timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  v_item public.run_items%rowtype;
  v_evidence public.run_prompt_evidence%rowtype;
  v_provider public.provider_attempts%rowtype;
  v_recording public.version_recordings%rowtype;
  v_selected public.run_arm_attempts%rowtype;
  v_attempt_id uuid;
  v_sequence integer;
  v_origin text;
  v_kind text;
  v_evaluation jsonb;
  v_status text;
  v_probability numeric;
  v_claims jsonb;
  v_claim jsonb;
  v_ord bigint;
  v_verdict text;
  v_pack_item jsonb;
  v_start numeric;
  v_end numeric;
  v_provider_id uuid;
  v_cache_source uuid;
  v_attempts integer;
  v_reason text;
  v_withheld numeric;
begin
  if p_run_id is null or p_question_key is null or p_holder is null then
    perform app_private.fail('invalid_input', 'run, question and holder are required.');
  end if;
  if p_arm is null or p_arm not in ('no_research', 'research') then
    perform app_private.fail('invalid_input', 'arm must be no_research or research.');
  end if;
  if p_next_state is null or p_next_state not in ('done', 'withheld', 'failed', 'skipped', 'pending') then
    perform app_private.fail('invalid_input', 'next state must be done, withheld, failed, skipped or pending.');
  end if;

  -- Lock order run (share) -> item, matching lease_arm and finalize_run.
  select * into v_run from public.runs as run
  where run.id = p_run_id and run.dataset_version_id is not null
  for share;
  if not found then
    perform app_private.fail('not_found', 'Run not found.');
  end if;
  if v_run.status not in ('created', 'processing') then
    perform app_private.fail('frozen_or_mismatch', 'Run is terminal.');
  end if;
  select * into v_item from public.run_items as item
  where item.run_id = p_run_id and item.question_key = p_question_key and item.arm = p_arm
  for update;
  if not found then
    perform app_private.fail('not_found', 'Run item not found.');
  end if;
  if v_item.state <> 'leased' or v_item.lease_holder is distinct from p_holder then
    perform app_private.fail('frozen_or_mismatch', 'Stale lease holder: this arm was released or re-leased.');
  end if;
  select * into v_evidence from public.run_prompt_evidence as evidence
  where evidence.run_id = p_run_id and evidence.question_key = p_question_key;
  if not found then
    perform app_private.fail('frozen_or_mismatch', 'Prompt evidence must be recorded before results.');
  end if;

  if p_attempt is not null and jsonb_typeof(p_attempt) <> 'null' then
    if jsonb_typeof(p_attempt) <> 'object' or octet_length(p_attempt::text) > 262144 then
      perform app_private.fail('invalid_input', 'attempt must be an AttemptRecord object.');
    end if;
    begin
      v_attempt_id := (p_attempt ->> 'attemptId')::uuid;
      v_provider_id := (p_attempt ->> 'providerAttemptId')::uuid;
      v_cache_source := (p_attempt ->> 'cacheSourceAttemptId')::uuid;
    exception when invalid_text_representation then
      perform app_private.fail('invalid_input', 'attemptId, providerAttemptId and cacheSourceAttemptId must be uuids.');
    end;
    if v_attempt_id is null then
      perform app_private.fail('invalid_input', 'attemptId is required.');
    end if;
    if p_attempt ->> 'questionId' is distinct from p_question_key or p_attempt ->> 'arm' is distinct from p_arm then
      perform app_private.fail('invalid_input', 'attempt question/arm differ from the item.');
    end if;
    if (p_attempt -> 'sequence') is distinct from '1'::jsonb and (p_attempt -> 'sequence') is distinct from '2'::jsonb then
      perform app_private.fail('invalid_input', 'sequence must be 1 or 2.');
    end if;
    v_sequence := (p_attempt ->> 'sequence')::integer;
    if v_sequence <> coalesce((
      select max(attempt.sequence) from public.run_arm_attempts as attempt
      where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
    ), 0) + 1 then
      perform app_private.fail('frozen_or_mismatch', 'Attempts are appended in sequence order.');
    end if;
    v_kind := coalesce(p_attempt ->> 'kind', '');
    if v_kind not in ('first', 'correction', 'retry') or (v_sequence = 1) <> (v_kind = 'first') then
      perform app_private.fail('invalid_input', 'kind must be first for sequence 1 and correction/retry for sequence 2.');
    end if;
    v_origin := coalesce(p_attempt ->> 'origin', '');
    if (v_run.mode = 'live' and v_origin not in ('live', 'cache_hit'))
      or (v_run.mode = 'replay' and v_origin not in ('demo', 'recorded', 'manual')) then
      perform app_private.fail('invalid_input', 'Attempt origin does not match the run mode.');
    end if;
    if coalesce(p_attempt ->> 'requestHash', '') !~ '^[0-9a-f]{64}$' then
      perform app_private.fail('invalid_input', 'requestHash must be 64 lowercase hex.');
    end if;
    if p_attempt ->> 'promptEvidenceHash' is distinct from v_evidence.prompt_evidence_hash then
      perform app_private.fail('frozen_or_mismatch', 'promptEvidenceHash differs from the frozen prompt evidence.');
    end if;
    if jsonb_typeof(coalesce(p_attempt -> 'auditFlags', '[]'::jsonb)) <> 'array'
      or exists (select 1 from jsonb_array_elements(coalesce(p_attempt -> 'auditFlags', '[]'::jsonb)) as flag(value) where jsonb_typeof(flag.value) <> 'string') then
      perform app_private.fail('invalid_input', 'auditFlags must be an array of strings.');
    end if;
    if coalesce(jsonb_typeof(p_attempt -> 'rawText'), 'null') not in ('null', 'string') then
      perform app_private.fail('invalid_input', 'rawText must be a string or null.');
    end if;

    v_evaluation := p_attempt -> 'evaluation';
    if v_evaluation is null or jsonb_typeof(v_evaluation) <> 'object' then
      perform app_private.fail('invalid_input', 'evaluation must be an object.');
    end if;
    v_status := coalesce(v_evaluation ->> 'status', '');
    if v_status not in ('valid', 'withheld', 'failed') then
      perform app_private.fail('invalid_input', 'evaluation.status must be valid, withheld or failed.');
    end if;
    if v_status = 'failed' then
      v_probability := null;
    else
      v_probability := app_private.num(v_evaluation, 'probability', '$.evaluation');
      if v_probability < 0 or v_probability > 1 then
        perform app_private.fail('invalid_input', 'evaluation.probability must be in [0, 1].');
      end if;
    end if;
    v_claims := coalesce(v_evaluation -> 'claims', '[]'::jsonb);
    if jsonb_typeof(v_claims) <> 'array' or jsonb_array_length(v_claims) > 16 then
      perform app_private.fail('invalid_input', 'evaluation.claims must be an array of at most 16.');
    end if;
    if coalesce(p_claim_decisions, '[]'::jsonb) is distinct from v_claims then
      perform app_private.fail('invalid_input', 'claim decisions must equal evaluation.claims.');
    end if;
    if p_arm = 'no_research' and jsonb_array_length(v_claims) > 0 then
      perform app_private.fail('invalid_input', 'The no-research arm carries no claims.');
    end if;
    if p_arm = 'research' and v_status = 'valid' and (
      jsonb_array_length(v_claims) = 0
      or exists (select 1 from jsonb_array_elements(v_claims) as claim(value) where claim.value ->> 'verdict' is distinct from 'supported')
    ) then
      perform app_private.fail('invalid_input', 'A valid research attempt needs 1..16 claims, all supported.');
    end if;

    -- Origin provenance.
    if v_origin = 'live' then
      select * into v_provider from public.provider_attempts as attempt
      where attempt.id = v_provider_id and attempt.run_id = p_run_id and attempt.question_key = p_question_key
        and attempt.arm = p_arm and attempt.sequence = v_sequence;
      if not found or v_provider.status in ('reserved', 'not_sent') then
        perform app_private.fail('frozen_or_mismatch', 'A live attempt needs its settled provider charge for this slot.');
      end if;
      if coalesce(p_attempt ->> 'cacheKey', '') !~ '^[0-9a-f]{64}$' then
        perform app_private.fail('invalid_input', 'cacheKey must be 64 lowercase hex for live attempts.');
      end if;
    elsif v_origin = 'cache_hit' then
      if not exists (
        select 1 from public.run_arm_attempts as source
        where source.id = v_cache_source and source.user_id = v_run.user_id
          and source.dataset_version_id = v_run.dataset_version_id
          and source.origin = 'live' and source.cache_key = p_attempt ->> 'cacheKey'
      ) then
        perform app_private.fail('frozen_or_mismatch', 'A cache hit must name an owned live attempt with the same cache key.');
      end if;
    else
      select * into v_recording from public.version_recordings as recording
      where recording.dataset_version_id = v_run.dataset_version_id and recording.question_key = p_question_key
        and recording.arm = p_arm and recording.sequence = v_sequence;
      if not found then
        perform app_private.fail('frozen_or_mismatch', 'replay_miss: no frozen recording for this slot.');
      end if;
      if v_recording.origin <> v_origin
        or (v_recording.output ->> 'kind' = 'text' and p_attempt ->> 'rawText' is distinct from v_recording.output ->> 'text')
        or (v_recording.output ->> 'kind' = 'failure' and v_status <> 'failed') then
        perform app_private.fail('frozen_or_mismatch', 'Replay attempt differs from its frozen recording.');
      end if;
    end if;

    begin
      insert into public.run_arm_attempts (
        id, run_id, question_key, arm, dataset_version_id, user_id, sequence, kind, origin, request_key,
        request_hash, cache_key, prompt_evidence_hash, evaluation_status, probability, evaluation, raw_text,
        audit_flags, model, provider_attempt_id, cache_source_attempt_id, record
      ) values (
        v_attempt_id, p_run_id, p_question_key, p_arm, v_run.dataset_version_id, v_run.user_id, v_sequence, v_kind,
        v_origin, app_private.txt(p_attempt, 'requestKey', '$.attempt', true, 200), p_attempt ->> 'requestHash',
        case when v_origin in ('live', 'cache_hit') then p_attempt ->> 'cacheKey' end,
        p_attempt ->> 'promptEvidenceHash', v_status, v_probability, v_evaluation, p_attempt ->> 'rawText',
        array(select flag.value from jsonb_array_elements_text(coalesce(p_attempt -> 'auditFlags', '[]'::jsonb)) as flag(value)),
        nullif(p_attempt -> 'model', 'null'::jsonb),
        case when v_origin = 'live' then v_provider_id end,
        case when v_origin = 'cache_hit' then v_cache_source end,
        p_attempt
      );
    exception
      when unique_violation then
        perform app_private.fail('frozen_or_mismatch', 'Attempt id, request key or slot already recorded: ' || sqlerrm);
      when check_violation then
        perform app_private.fail('invalid_input', 'Attempt rejected by a constraint: ' || sqlerrm);
    end;

    -- Claim decisions, including rejects.
    for v_claim, v_ord in
      select claim.value, claim.ordinality from jsonb_array_elements(v_claims) with ordinality as claim(value, ordinality)
    loop
      if jsonb_typeof(v_claim) <> 'object' or (v_claim -> 'claimIndex') is distinct from to_jsonb(v_ord - 1) then
        perform app_private.fail('invalid_input', 'Claim decisions must be objects with claimIndex in order.');
      end if;
      v_verdict := coalesce(v_claim ->> 'verdict', '');
      if v_verdict not in ('supported', 'empty', 'unknown_source', 'truncated_away', 'span_not_in_excerpt', 'hash_mismatch', 'invalid_offset') then
        perform app_private.fail('invalid_input', 'Unknown claim verdict.');
      end if;
      if jsonb_typeof(v_claim -> 'text') is distinct from 'string'
        or jsonb_typeof(v_claim -> 'evidenceId') is distinct from 'string'
        or jsonb_typeof(v_claim -> 'contentHash') is distinct from 'string'
        or coalesce(jsonb_typeof(v_claim -> 'start'), 'null') not in ('null', 'number')
        or coalesce(jsonb_typeof(v_claim -> 'end'), 'null') not in ('null', 'number') then
        perform app_private.fail('invalid_input', 'Claims need text, evidenceId, contentHash and numeric offsets.');
      end if;
      v_start := (v_claim ->> 'start')::numeric;
      v_end := (v_claim ->> 'end')::numeric;
      if v_verdict = 'supported' then
        v_pack_item := null;
        select pack.value into v_pack_item
        from jsonb_array_elements(v_evidence.prompt_evidence) as pack(value)
        where pack.value ->> 'evidenceId' = v_claim ->> 'evidenceId';
        if v_pack_item is null or v_pack_item ->> 'excerptHash' is distinct from v_claim ->> 'contentHash' then
          perform app_private.fail('frozen_or_mismatch', 'A supported claim must cite kept prompt evidence by its excerpt hash.');
        end if;
        if v_start is null or v_end is null or v_start <> trunc(v_start) or v_end <> trunc(v_end) or v_start < 0 or v_end <= v_start
          -- A 2,000 code-point excerpt has at most 4,000 UTF-16 units.
          or v_end > 4000 then
          perform app_private.fail('frozen_or_mismatch', 'A supported claim needs integer offsets with 0 <= start < end <= excerpt length.');
        end if;
        -- Offsets are JavaScript UTF-16 indices. They equal code-point indices when the excerpt
        -- has no supplementary-plane characters; only then is the span re-checked here.
        if v_pack_item ->> 'excerpt' !~ '[\U00010000-\U0010FFFF]'
          and substr(v_pack_item ->> 'excerpt', (v_start + 1)::integer, (v_end - v_start)::integer) is distinct from v_claim ->> 'text' then
          perform app_private.fail('frozen_or_mismatch', 'A supported claim must be the exact excerpt span.');
        end if;
      end if;
      begin
        insert into public.run_claim_decisions (
          attempt_id, run_id, question_key, dataset_version_id, user_id, claim_index, claim_text, evidence_key,
          start_offset, end_offset, content_hash, verdict, supported_evidence_key
        ) values (
          v_attempt_id, p_run_id, p_question_key, v_run.dataset_version_id, v_run.user_id, (v_ord - 1)::smallint,
          v_claim ->> 'text', v_claim ->> 'evidenceId', v_start, v_end, v_claim ->> 'contentHash', v_verdict,
          case when v_verdict = 'supported' then v_claim ->> 'evidenceId' end
        );
      exception
        when check_violation or foreign_key_violation then
          perform app_private.fail('invalid_input', 'Claim decision rejected by a constraint: ' || sqlerrm);
      end;
    end loop;
  end if;

  select count(*) into v_attempts from public.run_arm_attempts as attempt
  where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm;

  if p_next_state = 'done' then
    select * into v_selected from public.run_arm_attempts as attempt
    where attempt.id = p_selected_attempt_id and attempt.run_id = p_run_id
      and attempt.question_key = p_question_key and attempt.arm = p_arm;
    if not found or v_selected.evaluation_status <> 'valid' then
      perform app_private.fail('frozen_or_mismatch', 'done must select a valid attempt of this arm.');
    end if;
    if exists (
      select 1 from public.run_arm_attempts as earlier
      where earlier.run_id = p_run_id and earlier.question_key = p_question_key and earlier.arm = p_arm
        and earlier.evaluation_status = 'valid' and earlier.sequence < v_selected.sequence
    ) then
      perform app_private.fail('frozen_or_mismatch', 'The first valid attempt in execution order is selected.');
    end if;
    v_reason := 'valid';
  elsif p_selected_attempt_id is not null then
    perform app_private.fail('invalid_input', 'Only done selects an attempt.');
  end if;

  if p_next_state = 'skipped' then
    if p_arm <> 'research' or jsonb_array_length(v_evidence.prompt_evidence) <> 0 or v_attempts <> 0 then
      perform app_private.fail('invalid_input', 'Only research with an empty evidence pack and no attempts may be skipped.');
    end if;
    v_reason := 'insufficient_evidence';
  elsif p_next_state = 'withheld' and p_arm = 'research' and exists (
    select 1 from public.run_arm_attempts as attempt
    where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
      and attempt.evaluation_status = 'valid'
  ) then
    -- Post-inference audit (engine run.ts applyPostInferenceAudit): the FIRST valid research attempt
    -- repeats the offline resolution sentence, so the arm is withheld unscored. No correction follows.
    select attempt.probability, 'withheld_audit' into v_withheld, v_reason
    from public.run_arm_attempts as attempt
    where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
      and attempt.evaluation_status = 'valid'
    order by attempt.sequence asc
    limit 1;
    if not exists (
      select 1 from public.run_arm_attempts as attempt
      where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
        and attempt.evaluation_status = 'valid' and attempt.probability is not distinct from v_withheld
        and 'outcome_tripwire' = any (attempt.audit_flags)
        and attempt.sequence = (
          select min(first_valid.sequence) from public.run_arm_attempts as first_valid
          where first_valid.run_id = p_run_id and first_valid.question_key = p_question_key and first_valid.arm = p_arm
            and first_valid.evaluation_status = 'valid'
        )
    ) then
      perform app_private.fail('frozen_or_mismatch', 'An arm with a valid attempt ends done unless its selected attempt has an outcome_tripwire audit flag.');
    end if;
  elsif p_next_state = 'withheld' then
    select attempt.probability,
      case when (attempt.evaluation ->> 'correctable') = 'false' then 'withheld_audit' else 'withheld_unsupported_claims' end
    into v_withheld, v_reason
    from public.run_arm_attempts as attempt
    where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
      and attempt.evaluation_status = 'withheld'
    order by attempt.sequence desc
    limit 1;
    if v_reason is null then
      perform app_private.fail('invalid_input', 'withheld needs a withheld attempt.');
    end if;
    if exists (
      select 1 from public.run_arm_attempts as attempt
      where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
        and attempt.evaluation_status = 'valid'
    ) then
      perform app_private.fail('frozen_or_mismatch', 'An arm with a valid attempt ends done.');
    end if;
  elsif p_next_state = 'failed' and v_run.mode = 'replay' and (p_attempt is null or jsonb_typeof(p_attempt) = 'null')
    and not exists (
      select 1 from public.version_recordings as recording
      where recording.dataset_version_id = v_run.dataset_version_id and recording.question_key = p_question_key
        and recording.arm = p_arm and recording.sequence = v_attempts + 1
    ) then
    -- Replay-only mode has no provider path: a missing recording ends the arm as replay_miss.
    if exists (
      select 1 from public.run_arm_attempts as attempt
      where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
        and attempt.evaluation_status = 'valid'
    ) then
      perform app_private.fail('frozen_or_mismatch', 'An arm with a valid attempt ends done.');
    end if;
    v_reason := 'replay_miss';
  elsif p_next_state = 'failed' then
    if v_attempts = 0 and v_item.charged_calls = 0 then
      perform app_private.fail('invalid_input', 'failed needs an attempt or a consumed charge.');
    end if;
    if exists (
      select 1 from public.run_arm_attempts as attempt
      where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
        and attempt.evaluation_status = 'valid'
    ) then
      perform app_private.fail('frozen_or_mismatch', 'An arm with a valid attempt ends done.');
    end if;
    select coalesce(attempt.evaluation ->> 'code', 'failed') into v_reason
    from public.run_arm_attempts as attempt
    where attempt.run_id = p_run_id and attempt.question_key = p_question_key and attempt.arm = p_arm
    order by attempt.sequence desc
    limit 1;
    v_reason := coalesce(v_reason, 'attempts_exhausted');
  elsif p_next_state = 'pending' then
    if v_attempts >= 2 or v_item.charged_calls >= 2 then
      perform app_private.fail('frozen_or_mismatch', 'No attempt slot remains for a retry.');
    end if;
    v_reason := 'retry_scheduled';
  end if;

  update public.run_items as item
  set state = p_next_state,
      lease_holder = null,
      lease_expires_at = null,
      selected_attempt_id = case when p_next_state = 'done' then v_selected.id end,
      probability = case when p_next_state = 'done' then v_selected.probability end,
      withheld_probability = case when p_next_state = 'withheld' then v_withheld end,
      reason_code = v_reason,
      -- A retry waits for the persisted provider Retry-After (clamped to 300 s); corrections may
      -- pass null to continue immediately.
      retry_not_before = case
        when p_next_state = 'pending' and p_retry_not_before is not null then
          least(greatest(p_retry_not_before, now()), now() + interval '300 seconds')
      end,
      updated_at = now()
  where item.run_id = p_run_id and item.question_key = p_question_key and item.arm = p_arm;

  return v_attempt_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants: server-only RPCs. The edge function verifies the JWT and ownership first, then calls
-- these with the service role; each RPC still validates its own invariants.

revoke all on function public.lease_arm(uuid, uuid, text, text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.reserve_attempt(uuid, uuid, text, text, integer, text, numeric, uuid) from public, anon, authenticated, service_role;
revoke all on function public.finalize_attempt(uuid, text, numeric, jsonb, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.finalize_arm_result(uuid, text, text, uuid, jsonb, jsonb, text, uuid, timestamptz) from public, anon, authenticated, service_role;

grant execute on function public.lease_arm(uuid, uuid, text, text, uuid, integer) to service_role;
grant execute on function public.reserve_attempt(uuid, uuid, text, text, integer, text, numeric, uuid) to service_role;
grant execute on function public.finalize_attempt(uuid, text, numeric, jsonb, text, text, timestamptz) to service_role;
grant execute on function public.finalize_arm_result(uuid, text, text, uuid, jsonb, jsonb, text, uuid, timestamptz) to service_role;

revoke all on all functions in schema app_private from public, anon, authenticated, service_role;
