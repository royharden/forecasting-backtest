-- S14 forward migration 3 of 3: fixed human audit samples, append-only verdict editions and the
-- derived report/sensitivity cache (PLAN.md s.4 audit paragraph and "Exact workflow").
-- Written under Dirty Mode; not applied or executed. Valid Postgres 15 syntax by careful reading only.
-- Depends on 20261024000100_run_versions.sql (app_private helpers, runs, run_prompt_evidence,
-- version_evidence).
--
-- Sampling mirrors supabase/functions/_shared/audit.ts createAuditSample exactly:
-- population = distinct kept (questionId, evidenceId) pairs from the run's source-decision ledgers,
-- sorted by question then evidence id with COLLATE "C"; n = min(requestedN, N); partial
-- Fisher-Yates without replacement driven by xorshift32 (13, 17, 5) on a nonzero uint32 seed:
-- for i in 0..n-1: j = i + next() % (N - i); swap(pool[i], pool[j]); sample = pool[0..n-1].
-- uint32 arithmetic is emulated with bigint masking. The browser recomputes selectionHash from the
-- stored inputs (run id, evidence_version_hash, algorithm, seed, requested_n, population, selected).
-- This samples supplied evidence; it cannot prove the absence of leakage. Verdicts never change
-- frozen performance cohorts.
--
-- Error contract as in 20261024000100: MESSAGE = public code, SQLSTATE PTnnn.

create function app_private.xorshift32_next(p_state bigint)
returns bigint
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_state bigint := p_state;
begin
  -- state ^= state << 13 (mod 2^32); state ^= state >>> 17; state ^= state << 5 (mod 2^32)
  v_state := (v_state # (v_state << 13)) & 4294967295;
  v_state := v_state # (v_state >> 17);
  v_state := (v_state # (v_state << 5)) & 4294967295;
  return v_state;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables.

create table public.audit_samples (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  dataset_version_id uuid not null,
  user_id uuid not null,
  -- The run's dataset_versions.version_hash (the evidence version the population came from).
  evidence_version_hash text not null check (evidence_version_hash ~ '^[0-9a-f]{64}$'),
  seed bigint not null check (seed between 1 and 4294967295),
  requested_n integer not null check (requested_n between 1 and 10000),
  algorithm text not null check (algorithm = 'xorshift32-partial-fisher-yates-v1'),
  population_n integer not null check (population_n >= 0),
  sampled_n integer not null,
  -- Selection hash inputs: sorted population [[questionId, evidenceId], ...] and the selected
  -- pairs in sample order.
  population jsonb not null check (jsonb_typeof(population) = 'array'),
  selected jsonb not null check (jsonb_typeof(selected) = 'array'),
  -- Server SHA-256 of jsonb_build_array(population, selected)::text, for tamper checks only.
  selection_rows_hash text not null check (selection_rows_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint audit_samples_idempotency_key unique (run_id, evidence_version_hash, seed, requested_n, algorithm),
  constraint audit_samples_ref_key unique (id, run_id, dataset_version_id, user_id),
  constraint audit_samples_run_fkey foreign key (run_id, dataset_version_id, user_id)
    references public.runs (id, dataset_version_id, user_id) on delete cascade,
  constraint audit_samples_sampled_n check (sampled_n = least(requested_n, population_n))
);

create table public.audit_sample_items (
  id uuid primary key default gen_random_uuid(),
  sample_id uuid not null,
  run_id uuid not null,
  dataset_version_id uuid not null,
  user_id uuid not null,
  position integer not null check (position >= 0),
  question_key text not null,
  evidence_key text not null,
  constraint audit_sample_items_position_key unique (sample_id, position),
  constraint audit_sample_items_pair_key unique (sample_id, question_key, evidence_key),
  constraint audit_sample_items_owner_key unique (id, user_id),
  constraint audit_sample_items_sample_fkey foreign key (sample_id, run_id, dataset_version_id, user_id)
    references public.audit_samples (id, run_id, dataset_version_id, user_id) on delete cascade,
  constraint audit_sample_items_evidence_fkey foreign key (dataset_version_id, question_key, evidence_key)
    references public.version_evidence (dataset_version_id, question_key, evidence_key) on delete cascade
);

-- Append-only editions. No row means unreviewed; unreviewed never counts as clean.
create table public.audit_verdict_editions (
  id uuid primary key default gen_random_uuid(),
  sample_item_id uuid not null,
  user_id uuid not null,
  edition integer not null check (edition >= 1),
  verdict text not null check (verdict in ('clean', 'leak', 'unsure')),
  notes text not null default '' check (char_length(notes) <= 4000),
  supersedes_id uuid,
  created_at timestamptz not null default now(),
  constraint audit_verdict_editions_edition_key unique (sample_item_id, edition),
  constraint audit_verdict_editions_supersedes_key unique (supersedes_id),
  constraint audit_verdict_editions_item_ref_key unique (id, sample_item_id),
  constraint audit_verdict_editions_item_fkey foreign key (sample_item_id, user_id)
    references public.audit_sample_items (id, user_id) on delete cascade,
  -- A correction supersedes an edition of the same sample item.
  constraint audit_verdict_editions_supersedes_fkey foreign key (supersedes_id, sample_item_id)
    references public.audit_verdict_editions (id, sample_item_id) on delete cascade,
  constraint audit_verdict_editions_first check ((edition = 1) = (supersedes_id is null))
);

-- Derived report and sensitivity cache. Never a source of truth: the browser Verify bundle
-- recomputes metrics from frozen rows. Editions are appended, never updated.
create table public.report_cache (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  dataset_version_id uuid not null,
  user_id uuid not null,
  kind text not null check (kind in ('report', 'sensitivity')),
  edition integer not null check (edition >= 1),
  -- What the cached result was computed from (e.g. audit sample id and verdict edition ids).
  basis jsonb not null default '{}'::jsonb check (jsonb_typeof(basis) = 'object'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 1048576),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint report_cache_edition_key unique (run_id, kind, edition),
  constraint report_cache_run_fkey foreign key (run_id, dataset_version_id, user_id)
    references public.runs (id, dataset_version_id, user_id) on delete cascade
);

create index audit_samples_run_idx on public.audit_samples (run_id);
create index audit_sample_items_sample_idx on public.audit_sample_items (sample_id, run_id, dataset_version_id, user_id);
create index audit_sample_items_evidence_idx on public.audit_sample_items (dataset_version_id, question_key, evidence_key);
create index audit_verdict_editions_item_idx on public.audit_verdict_editions (sample_item_id, user_id);
create index audit_verdict_editions_supersedes_idx on public.audit_verdict_editions (supersedes_id, sample_item_id);
create index report_cache_run_idx on public.report_cache (run_id, dataset_version_id, user_id);

create trigger audit_samples_append_only before update on public.audit_samples
  for each row execute function app_private.reject_update();
create trigger audit_sample_items_append_only before update on public.audit_sample_items
  for each row execute function app_private.reject_update();
create trigger audit_verdict_editions_append_only before update on public.audit_verdict_editions
  for each row execute function app_private.reject_update();
create trigger report_cache_append_only before update on public.report_cache
  for each row execute function app_private.reject_update();

-- ---------------------------------------------------------------------------------------------
-- Row level security.

alter table public.audit_samples enable row level security;
alter table public.audit_sample_items enable row level security;
alter table public.audit_verdict_editions enable row level security;
alter table public.report_cache enable row level security;

create policy audit_samples_owner_read on public.audit_samples
  for select to authenticated
  using (
    audit_samples.user_id = (select auth.uid())
    and exists (
      select 1 from public.runs as run
      where run.id = audit_samples.run_id and run.user_id = (select auth.uid())
    )
  );

create policy audit_sample_items_owner_read on public.audit_sample_items
  for select to authenticated
  using (
    audit_sample_items.user_id = (select auth.uid())
    and exists (
      select 1 from public.audit_samples as sample
      where sample.id = audit_sample_items.sample_id and sample.user_id = (select auth.uid())
    )
  );

create policy audit_verdict_editions_owner_read on public.audit_verdict_editions
  for select to authenticated
  using (
    audit_verdict_editions.user_id = (select auth.uid())
    and exists (
      select 1 from public.audit_sample_items as item
      where item.id = audit_verdict_editions.sample_item_id and item.user_id = (select auth.uid())
    )
  );

create policy report_cache_owner_read on public.report_cache
  for select to authenticated
  using (
    report_cache.user_id = (select auth.uid())
    and exists (
      select 1 from public.runs as run
      where run.id = report_cache.run_id and run.user_id = (select auth.uid())
    )
  );

create policy report_cache_owner_insert on public.report_cache
  for insert to authenticated
  with check (
    report_cache.user_id = (select auth.uid())
    and exists (
      select 1 from public.runs as run
      where run.id = report_cache.run_id
        and run.user_id = (select auth.uid())
        and run.dataset_version_id = report_cache.dataset_version_id
        and run.status in ('completed', 'partial')
    )
  );

create policy report_cache_owner_delete on public.report_cache
  for delete to authenticated
  using (report_cache.user_id = (select auth.uid()));

revoke all on public.audit_samples, public.audit_sample_items, public.audit_verdict_editions, public.report_cache
  from anon, authenticated, service_role;
grant select on public.audit_samples, public.audit_sample_items, public.audit_verdict_editions, public.report_cache
  to authenticated, service_role;
-- The cache is derived data the owner may add and clear; audit truth is written only by RPCs.
grant insert, delete on public.report_cache to authenticated;

-- ---------------------------------------------------------------------------------------------
-- create_audit_sample(run, requestedN, seed) -> audit_samples.id
-- Completed or partial owned run only. Idempotent on (run, evidence_version_hash, seed,
-- requested_n, algorithm): a repeat returns the existing sample.

create function public.create_audit_sample(p_run_id uuid, p_requested_n integer, p_seed bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_algorithm constant text := 'xorshift32-partial-fisher-yates-v1';
  v_run public.runs%rowtype;
  v_version_hash text;
  v_questions text[];
  v_evidence text[];
  v_population jsonb;
  v_selected jsonb;
  v_n integer;
  v_k integer;
  v_state bigint;
  v_j integer;
  v_swap text;
  v_id uuid;
begin
  if v_uid is null then
    perform app_private.fail('invalid_session', 'Sign in to sample an audit.');
  end if;
  if p_requested_n is null or p_requested_n < 1 or p_requested_n > 10000 then
    perform app_private.fail('invalid_input', 'requestedN must be 1..10000.');
  end if;
  if p_seed is null or p_seed < 1 or p_seed > 4294967295 then
    perform app_private.fail('invalid_input', 'seed must be a nonzero uint32.');
  end if;
  select * into v_run from public.runs as run
  where run.id = p_run_id and run.user_id = v_uid and run.dataset_version_id is not null;
  if not found then
    perform app_private.fail('not_found', 'Run not found.');
  end if;
  -- PLAN.md s.4: completed owned runs only. A partial run has questions with no stored ledger, so
  -- its population would differ from the full engine population.
  if v_run.status <> 'completed' then
    perform app_private.fail('frozen_or_mismatch', 'Audit samples need a completed run.');
  end if;
  select version.version_hash into v_version_hash
  from public.dataset_versions as version where version.id = v_run.dataset_version_id;

  select sample.id into v_id from public.audit_samples as sample
  where sample.run_id = p_run_id and sample.evidence_version_hash = v_version_hash
    and sample.seed = p_seed and sample.requested_n = p_requested_n and sample.algorithm = v_algorithm;
  if v_id is not null then
    return v_id;
  end if;

  -- Sorted population of kept (question, evidence) pairs.
  select
    coalesce(array_agg(pair.question_key order by pair.question_key collate "C", pair.evidence_key collate "C"), '{}'),
    coalesce(array_agg(pair.evidence_key order by pair.question_key collate "C", pair.evidence_key collate "C"), '{}')
  into v_questions, v_evidence
  from (
    select distinct evidence.question_key, entry.value ->> 'evidenceId' as evidence_key
    from public.run_prompt_evidence as evidence
    cross join lateral jsonb_array_elements(evidence.ledger) as entry(value)
    where evidence.run_id = p_run_id and entry.value ->> 'decision' = 'kept'
  ) as pair;

  v_n := coalesce(array_length(v_questions, 1), 0);
  v_k := least(p_requested_n, v_n);
  select coalesce(jsonb_agg(jsonb_build_array(v_questions[i], v_evidence[i]) order by i), '[]'::jsonb)
  into v_population
  from generate_series(1, v_n) as i;

  -- Partial Fisher-Yates (0-based i, 1-based arrays).
  v_state := p_seed;
  for v_i in 0 .. v_k - 1 loop
    v_state := app_private.xorshift32_next(v_state);
    v_j := v_i + (v_state % (v_n - v_i))::integer;
    v_swap := v_questions[v_i + 1];
    v_questions[v_i + 1] := v_questions[v_j + 1];
    v_questions[v_j + 1] := v_swap;
    v_swap := v_evidence[v_i + 1];
    v_evidence[v_i + 1] := v_evidence[v_j + 1];
    v_evidence[v_j + 1] := v_swap;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_array(v_questions[i], v_evidence[i]) order by i), '[]'::jsonb)
  into v_selected
  from generate_series(1, v_k) as i;

  insert into public.audit_samples (
    run_id, dataset_version_id, user_id, evidence_version_hash, seed, requested_n, algorithm,
    population_n, sampled_n, population, selected, selection_rows_hash
  ) values (
    p_run_id, v_run.dataset_version_id, v_uid, v_version_hash, p_seed, p_requested_n, v_algorithm,
    v_n, v_k, v_population, v_selected,
    encode(sha256(convert_to(jsonb_build_array(v_population, v_selected)::text, 'UTF8')), 'hex')
  )
  on conflict (run_id, evidence_version_hash, seed, requested_n, algorithm) do nothing
  returning id into v_id;

  if v_id is null then
    -- A concurrent identical request won; return its sample.
    select sample.id into v_id from public.audit_samples as sample
    where sample.run_id = p_run_id and sample.evidence_version_hash = v_version_hash
      and sample.seed = p_seed and sample.requested_n = p_requested_n and sample.algorithm = v_algorithm;
    return v_id;
  end if;

  insert into public.audit_sample_items (sample_id, run_id, dataset_version_id, user_id, position, question_key, evidence_key)
  select v_id, p_run_id, v_run.dataset_version_id, v_uid, i - 1, v_questions[i], v_evidence[i]
  from generate_series(1, v_k) as i;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- append_audit_verdict(sampleItem, verdict, notes, supersedes) -> audit_verdict_editions.id
-- The first edition has no supersedes link; every later edition must supersede the current latest
-- edition (stale corrections are frozen_or_mismatch). edition = max + 1 under a row lock on the
-- sample item. Never updates or deletes an edition.

create function public.append_audit_verdict(
  p_sample_item_id uuid,
  p_verdict text,
  p_notes text,
  p_supersedes_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_latest_id uuid;
  v_latest_edition integer;
  v_id uuid;
begin
  if v_uid is null then
    perform app_private.fail('invalid_session', 'Sign in to record a verdict.');
  end if;
  if p_verdict is null or p_verdict not in ('clean', 'leak', 'unsure') then
    perform app_private.fail('invalid_input', 'verdict must be clean, leak or unsure.');
  end if;
  if p_notes is not null and char_length(p_notes) > 4000 then
    perform app_private.fail('invalid_input', 'notes are limited to 4,000 characters.');
  end if;

  perform 1 from public.audit_sample_items as item
  where item.id = p_sample_item_id and item.user_id = v_uid
  for update;
  if not found then
    perform app_private.fail('not_found', 'Audit sample item not found.');
  end if;

  select edition.id, edition.edition into v_latest_id, v_latest_edition
  from public.audit_verdict_editions as edition
  where edition.sample_item_id = p_sample_item_id
  order by edition.edition desc
  limit 1;

  if v_latest_id is null and p_supersedes_id is not null then
    perform app_private.fail('invalid_input', 'The first verdict supersedes nothing.');
  end if;
  if v_latest_id is not null and p_supersedes_id is distinct from v_latest_id then
    perform app_private.fail('frozen_or_mismatch', 'A correction must supersede the current latest edition.');
  end if;

  insert into public.audit_verdict_editions (sample_item_id, user_id, edition, verdict, notes, supersedes_id)
  values (p_sample_item_id, v_uid, coalesce(v_latest_edition, 0) + 1, p_verdict, coalesce(p_notes, ''), p_supersedes_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants.

revoke all on function public.create_audit_sample(uuid, integer, bigint) from public, anon, authenticated, service_role;
revoke all on function public.append_audit_verdict(uuid, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_audit_sample(uuid, integer, bigint) to authenticated;
grant execute on function public.append_audit_verdict(uuid, text, text, uuid) to authenticated;

revoke all on all functions in schema app_private from public, anon, authenticated, service_role;
