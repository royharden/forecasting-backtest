-- S14 forward migration 1 of 3: frozen dataset versions, model profiles and immutable run truth.
-- Written under Dirty Mode; not applied or executed. Valid Postgres 15 syntax by careful reading only.
-- Forward-only: sorts after 20261023150000_study.sql, which stays byte-for-byte unchanged.
--
-- RECONCILIATION NOTE (engine hashes). The engine's canonical DatasetVersion hash
-- (supabase/functions/_shared/manifest.ts freezeDatasetVersion -> canonical.ts hashCanonical)
-- cannot be recomputed in SQL: jsonb reorders object keys (by length, then bytes) and re-renders
-- numbers, so jsonb text is never the engine's canonical JSON. The server therefore stores the
-- client-supplied engine version_hash as a claim, computes its own rows_hash over the stored rows
-- (public.dataset_version_rows_hash), and the browser Verify bundle rebuilds the DatasetVersion
-- from header + row_doc columns (each array in ordinal order, outcome fields merged back from
-- version_outcomes) and re-checks the engine hash. protocol_hash, recordings_hash, manifest_hash,
-- request_hash and prompt_evidence_hash are engine canonical hashes handled the same way.
-- Hashes over one UTF-8 string (evidence content_hash, prompt excerptHash) ARE recomputed here.
--
-- PUBLIC ERROR CONTRACT. Every RPC raises MESSAGE = public code with SQLSTATE PTnnn, so PostgREST
-- answers with that HTTP status: invalid_input PT400, invalid_session PT401, not_found PT404,
-- frozen_or_mismatch / in_progress / manifest_or_config_mismatch PT409, budget_exhausted PT429,
-- configuration_required PT503. DETAIL carries a non-secret explanation. Cross-owner rows always
-- report not_found.
--
-- Draft/frozen mapping (PLAN.md s.4): study_sets/questions/sources/claims/forecasts stay editable
-- drafts; finalize_dataset copies a validated engine DatasetVersion into the immutable version_*
-- tables in one transaction; freeze_run pins a run manifest; server RPCs append attempts.
-- Clients never write frozen tables directly. No storage buckets, Realtime or cron.

-- ---------------------------------------------------------------------------------------------
-- Private helpers. Not exposed through PostgREST; only definer functions call them.

create schema if not exists app_private;
revoke all on schema app_private from public;

create function app_private.fail(p_code text, p_detail text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_state text := case p_code
    when 'invalid_input' then 'PT400'
    when 'invalid_session' then 'PT401'
    when 'not_found' then 'PT404'
    when 'frozen_or_mismatch' then 'PT409'
    when 'in_progress' then 'PT409'
    when 'manifest_or_config_mismatch' then 'PT409'
    when 'budget_exhausted' then 'PT429'
    when 'configuration_required' then 'PT503'
    else 'PT500'
  end;
begin
  raise exception using errcode = v_state, message = p_code, detail = coalesce(p_detail, '');
end;
$$;

-- Explicit-UTC ISO timestamp ("Z" or "+00:00"), same shape as time.ts parseUtc.
create function app_private.utc(p_value jsonb, p_path text, p_nullable boolean default false)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    if p_nullable then
      return null;
    end if;
    perform app_private.fail('invalid_input', p_path || ' must be an explicit-UTC timestamp.');
  end if;
  if jsonb_typeof(p_value) <> 'string' then
    perform app_private.fail('invalid_input', p_path || ' must be an explicit-UTC timestamp string.');
  end if;
  v_text := p_value #>> '{}';
  if v_text !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|\+00:00)$' then
    perform app_private.fail('invalid_input', p_path || ' must be an explicit-UTC ISO timestamp (Z or +00:00).');
  end if;
  begin
    return v_text::timestamptz;
  exception when others then
    perform app_private.fail('invalid_input', p_path || ' is not a valid calendar timestamp.');
  end;
  return null;
end;
$$;

create function app_private.utc_date(p_value jsonb, p_path text)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) is distinct from 'string' then
    perform app_private.fail('invalid_input', p_path || ' must be YYYY-MM-DD.');
  end if;
  v_text := p_value #>> '{}';
  if v_text !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' then
    perform app_private.fail('invalid_input', p_path || ' must be YYYY-MM-DD.');
  end if;
  begin
    return v_text::date;
  exception when others then
    perform app_private.fail('invalid_input', p_path || ' is not a valid calendar date.');
  end;
  return null;
end;
$$;

create function app_private.txt(
  p_obj jsonb,
  p_key text,
  p_path text,
  p_nonempty boolean default true,
  p_max integer default 20000,
  p_nullable boolean default false
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_value jsonb := p_obj -> p_key;
  v_text text;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    if p_nullable then
      return null;
    end if;
    perform app_private.fail('invalid_input', p_path || '.' || p_key || ' is required.');
  end if;
  if jsonb_typeof(v_value) <> 'string' then
    perform app_private.fail('invalid_input', p_path || '.' || p_key || ' must be a string.');
  end if;
  v_text := v_value #>> '{}';
  if p_nonempty and btrim(v_text) = '' then
    perform app_private.fail('invalid_input', p_path || '.' || p_key || ' must be non-empty.');
  end if;
  if char_length(v_text) > p_max then
    perform app_private.fail('invalid_input', p_path || '.' || p_key || ' exceeds ' || p_max || ' characters.');
  end if;
  return v_text;
end;
$$;

create function app_private.num(p_obj jsonb, p_key text, p_path text, p_nullable boolean default false)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_value jsonb := p_obj -> p_key;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    if p_nullable then
      return null;
    end if;
    perform app_private.fail('invalid_input', p_path || '.' || p_key || ' is required.');
  end if;
  if jsonb_typeof(v_value) <> 'number' then
    perform app_private.fail('invalid_input', p_path || '.' || p_key || ' must be a finite number.');
  end if;
  return v_value::numeric;
end;
$$;

-- Append-only guard for frozen tables. Deletes stay possible only through owner-account cascades
-- (no client or service delete grants exist).
create function app_private.reject_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.fail('frozen_or_mismatch', tg_table_name || ' rows are immutable.');
  return null;
end;
$$;

revoke all on all functions in schema app_private from public;

-- ---------------------------------------------------------------------------------------------
-- Ownership keys on existing tables used by composite references below.

alter table public.study_sets add constraint study_sets_id_user_key unique (id, user_id);

-- ---------------------------------------------------------------------------------------------
-- Frozen dataset versions.

create table public.dataset_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  study_set_id uuid,
  dataset_id text not null check (char_length(btrim(dataset_id)) between 1 and 200),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  kind text not null check (kind in ('synthetic', 'real')),
  provenance text not null,
  rights text not null,
  schema_version integer not null check (schema_version = 1),
  core_version text not null check (char_length(btrim(core_version)) > 0),
  protocol jsonb not null check (jsonb_typeof(protocol) = 'object'),
  protocol_hash text not null check (protocol_hash ~ '^[0-9a-f]{64}$'),
  -- Engine canonical hash, supplied by the client and re-verified by the browser Verify bundle.
  version_hash text not null check (version_hash ~ '^[0-9a-f]{64}$'),
  -- Server-computed public.dataset_version_rows_hash over the stored rows; set once at finalization.
  rows_hash text check (rows_hash ~ '^[0-9a-f]{64}$'),
  recordings_hash text check (recordings_hash ~ '^[0-9a-f]{64}$'),
  frozen_at timestamptz not null,
  -- Exact engine envelope without its arrays (schemaVersion, coreVersion, datasetId, name, kind,
  -- provenance, rights, protocol, protocolHash, frozenAt, versionHash) for Verify reconstruction.
  header jsonb not null check (jsonb_typeof(header) = 'object'),
  created_at timestamptz not null default now(),
  constraint dataset_versions_owner_hash_key unique (user_id, version_hash),
  constraint dataset_versions_id_user_key unique (id, user_id),
  constraint dataset_versions_study_owner_fkey foreign key (study_set_id, user_id)
    references public.study_sets (id, user_id) on delete set null (study_set_id)
);

create table public.version_questions (
  id uuid primary key default gen_random_uuid(),
  dataset_version_id uuid not null,
  user_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  question_key text not null check (char_length(question_key) between 1 and 200),
  role text not null check (role in ('training', 'evaluation')),
  status text not null check (status in ('eligible', 'quarantined')),
  category text not null,
  event_cluster_id text not null,
  opens_at timestamptz not null,
  wording_available_at timestamptz not null,
  cutoff_at timestamptz,
  evidence_cutoff timestamptz,
  resolved_at timestamptz not null,
  -- Exact engine FrozenQuestion minus outcome and resolutionAuditText (scoring-only, below).
  row_doc jsonb not null check (
    jsonb_typeof(row_doc) = 'object' and not (row_doc ? 'outcome') and not (row_doc ? 'resolutionAuditText')
  ),
  constraint version_questions_version_fkey foreign key (dataset_version_id, user_id)
    references public.dataset_versions (id, user_id) on delete cascade,
  constraint version_questions_key unique (dataset_version_id, question_key),
  constraint version_questions_role_key unique (dataset_version_id, question_key, role),
  constraint version_questions_ordinal_key unique (dataset_version_id, ordinal),
  constraint version_questions_eligible_evaluation check (
    role = 'training'
    or status = 'quarantined'
    or (
      cutoff_at is not null
      and evidence_cutoff is not null
      and opens_at <= wording_available_at
      and wording_available_at <= cutoff_at
      and cutoff_at < resolved_at
    )
  )
);

-- Scoring-only: outcome and resolution audit text never sit beside prompt-building fields.
create table public.version_outcomes (
  dataset_version_id uuid not null,
  question_key text not null,
  user_id uuid not null,
  -- Raw imported outcome; only eligible questions are guaranteed 0 or 1.
  outcome_raw numeric,
  resolution_audit_text text not null,
  primary key (dataset_version_id, question_key),
  constraint version_outcomes_question_fkey foreign key (dataset_version_id, question_key)
    references public.version_questions (dataset_version_id, question_key) on delete cascade,
  constraint version_outcomes_version_fkey foreign key (dataset_version_id, user_id)
    references public.dataset_versions (id, user_id) on delete cascade
);

create table public.version_evidence (
  id uuid primary key default gen_random_uuid(),
  dataset_version_id uuid not null,
  user_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  evidence_key text not null check (char_length(evidence_key) between 1 and 200),
  question_key text not null,
  -- Constant column so the composite reference proves the question is an evaluation question.
  question_role text not null default 'evaluation' check (question_role = 'evaluation'),
  title text not null,
  url text not null,
  published jsonb not null check (jsonb_typeof(published) = 'object'),
  retrieved_at timestamptz not null,
  version_available_at timestamptz,
  updated_at timestamptz,
  excerpt text not null check (char_length(excerpt) > 0),
  content_hash text not null check (content_hash = encode(sha256(convert_to(excerpt, 'UTF8')), 'hex')),
  row_doc jsonb not null check (jsonb_typeof(row_doc) = 'object'),
  constraint version_evidence_version_fkey foreign key (dataset_version_id, user_id)
    references public.dataset_versions (id, user_id) on delete cascade,
  constraint version_evidence_question_fkey foreign key (dataset_version_id, question_key, question_role)
    references public.version_questions (dataset_version_id, question_key, role) on delete cascade,
  constraint version_evidence_key unique (dataset_version_id, evidence_key),
  constraint version_evidence_question_key unique (dataset_version_id, question_key, evidence_key),
  constraint version_evidence_ordinal_key unique (dataset_version_id, ordinal)
);

create table public.version_prices (
  id uuid primary key default gen_random_uuid(),
  dataset_version_id uuid not null,
  user_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  observation_key text not null check (char_length(observation_key) between 1 and 200),
  question_key text not null,
  question_role text not null default 'evaluation' check (question_role = 'evaluation'),
  yes_probability numeric not null check (yes_probability >= 0 and yes_probability <= 1),
  observed_at timestamptz not null,
  venue text not null,
  row_doc jsonb not null check (jsonb_typeof(row_doc) = 'object'),
  constraint version_prices_version_fkey foreign key (dataset_version_id, user_id)
    references public.dataset_versions (id, user_id) on delete cascade,
  constraint version_prices_question_fkey foreign key (dataset_version_id, question_key, question_role)
    references public.version_questions (dataset_version_id, question_key, role) on delete cascade,
  constraint version_prices_key unique (dataset_version_id, observation_key),
  constraint version_prices_ordinal_key unique (dataset_version_id, ordinal)
);

create table public.version_quarantine (
  id uuid primary key default gen_random_uuid(),
  dataset_version_id uuid not null,
  user_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  target_type text not null check (target_type in ('question', 'evidence', 'observation')),
  target_key text not null check (char_length(target_key) between 1 and 200),
  question_key text not null,
  reason text not null check (char_length(btrim(reason)) > 0),
  row_doc jsonb not null check (jsonb_typeof(row_doc) = 'object'),
  constraint version_quarantine_version_fkey foreign key (dataset_version_id, user_id)
    references public.dataset_versions (id, user_id) on delete cascade,
  constraint version_quarantine_question_fkey foreign key (dataset_version_id, question_key)
    references public.version_questions (dataset_version_id, question_key) on delete cascade,
  constraint version_quarantine_ordinal_key unique (dataset_version_id, ordinal)
);

create table public.version_recordings (
  id uuid primary key default gen_random_uuid(),
  dataset_version_id uuid not null,
  user_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  recording_key text not null check (char_length(recording_key) between 1 and 200),
  question_key text not null,
  question_role text not null default 'evaluation' check (question_role = 'evaluation'),
  arm text not null check (arm in ('no_research', 'research')),
  -- Imports can never assert live or cache-hit origin.
  origin text not null check (origin in ('demo', 'recorded', 'manual')),
  sequence smallint not null check (sequence in (1, 2)),
  output jsonb not null check (jsonb_typeof(output) = 'object' and output ->> 'kind' in ('text', 'failure')),
  model jsonb,
  row_doc jsonb not null check (jsonb_typeof(row_doc) = 'object'),
  constraint version_recordings_version_fkey foreign key (dataset_version_id, user_id)
    references public.dataset_versions (id, user_id) on delete cascade,
  constraint version_recordings_question_fkey foreign key (dataset_version_id, question_key, question_role)
    references public.version_questions (dataset_version_id, question_key, role) on delete cascade,
  constraint version_recordings_key unique (dataset_version_id, recording_key),
  constraint version_recordings_slot_key unique (dataset_version_id, question_key, arm, sequence),
  constraint version_recordings_ordinal_key unique (dataset_version_id, ordinal)
);

-- ---------------------------------------------------------------------------------------------
-- Server-managed model profiles. Clients select only; the owner inserts rows with the SQL editor.
-- profile is the exact engine ModelProfile (prompt.ts); it is immutable once written, only the
-- enabled switch may change. Live runs pin a snapshot in run_manifests.

create table public.model_profiles (
  profile_version text primary key check (profile_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  enabled boolean not null default false,
  profile jsonb not null check (jsonb_typeof(profile) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint model_profiles_version_matches check (profile ->> 'profileVersion' = profile_version)
);

create function app_private.model_profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.profile_version <> old.profile_version or new.profile is distinct from old.profile or new.created_at <> old.created_at then
    perform app_private.fail('frozen_or_mismatch', 'Model profile metadata is immutable; add a new profile_version instead.');
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger model_profiles_guard before update on public.model_profiles
  for each row execute function app_private.model_profiles_guard();

-- ---------------------------------------------------------------------------------------------
-- Extend the existing runs table (existing columns kept; summary stays a derived cache).
-- Deleting a draft study no longer cascades into frozen runs: set_id becomes nullable and is
-- cleared instead.

alter table public.runs drop constraint runs_set_id_fkey;
alter table public.runs alter column set_id drop not null;
alter table public.runs
  add constraint runs_set_owner_fkey foreign key (set_id, user_id)
    references public.study_sets (id, user_id) on delete set null (set_id);

alter table public.runs
  add column dataset_version_id uuid,
  -- Existing legacy rows were saved finished summaries; new rows start at 'created'.
  add column status text not null default 'completed'
    check (status in ('created', 'processing', 'completed', 'partial', 'failed', 'cancelled')),
  add column mode text check (mode in ('replay', 'live')),
  add column manifest_hash text check (manifest_hash ~ '^[0-9a-f]{64}$'),
  add column linked_run_id uuid references public.runs (id),
  add column finalized_at timestamptz;

alter table public.runs alter column status set default 'created';

alter table public.runs
  add constraint runs_version_owner_fkey foreign key (dataset_version_id, user_id)
    references public.dataset_versions (id, user_id) on delete cascade,
  add constraint runs_frozen_fields check (
    dataset_version_id is null or (mode is not null and manifest_hash is not null)
  ),
  add constraint runs_id_user_key unique (id, user_id),
  add constraint runs_id_version_user_key unique (id, dataset_version_id, user_id);

create index runs_version_idx on public.runs (dataset_version_id);

create function app_private.runs_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id <> old.id
    or new.user_id <> old.user_id
    or new.created_at <> old.created_at
    or new.dataset_version_id is distinct from old.dataset_version_id
    or new.mode is distinct from old.mode
    or new.manifest_hash is distinct from old.manifest_hash
    or new.linked_run_id is distinct from old.linked_run_id
    or new.finalized_at is distinct from old.finalized_at and old.finalized_at is not null then
    perform app_private.fail('frozen_or_mismatch', 'Frozen run fields cannot change.');
  end if;
  if new.status is distinct from old.status then
    if old.status in ('completed', 'partial', 'failed', 'cancelled') then
      perform app_private.fail('frozen_or_mismatch', 'Terminal runs are immutable; start a new linked run.');
    end if;
    if not (
      (old.status = 'created' and new.status in ('processing', 'completed', 'partial', 'failed', 'cancelled'))
      or (old.status = 'processing' and new.status in ('completed', 'partial', 'failed', 'cancelled'))
    ) then
      perform app_private.fail('frozen_or_mismatch', 'Invalid run status transition.');
    end if;
  end if;
  return new;
end;
$$;

create trigger runs_guard before update on public.runs
  for each row execute function app_private.runs_guard();

-- ---------------------------------------------------------------------------------------------
-- Frozen run truth.

create table public.run_manifests (
  run_id uuid primary key,
  dataset_version_id uuid not null,
  user_id uuid not null,
  mode text not null check (mode in ('replay', 'live')),
  -- Exact engine RunManifest (run.ts), including its manifestHash.
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  model_profile_version text references public.model_profiles (profile_version),
  model_profile jsonb,
  evaluation_keys text[] not null,
  training_keys text[] not null,
  recordings_hash text check (recordings_hash ~ '^[0-9a-f]{64}$'),
  manifest_created_at timestamptz not null,
  frozen_at timestamptz not null default now(),
  constraint run_manifests_run_fkey foreign key (run_id, dataset_version_id, user_id)
    references public.runs (id, dataset_version_id, user_id) on delete cascade,
  constraint run_manifests_live_profile check (
    mode = 'replay' or (model_profile_version is not null and model_profile is not null)
  ),
  constraint run_manifests_replay_recordings check (mode = 'live' or recordings_hash is not null)
);

create table public.run_items (
  run_id uuid not null,
  question_key text not null,
  arm text not null check (arm in ('no_research', 'research')),
  dataset_version_id uuid not null,
  user_id uuid not null,
  state text not null default 'pending'
    check (state in ('pending', 'leased', 'done', 'withheld', 'failed', 'skipped')),
  lease_holder uuid,
  lease_expires_at timestamptz,
  retry_not_before timestamptz,
  charged_calls smallint not null default 0 check (charged_calls between 0 and 2),
  selected_attempt_id uuid,
  -- Scorable probability of the selected valid attempt only.
  probability numeric check (probability >= 0 and probability <= 1),
  -- Unscored probability kept for audit when the arm ends withheld.
  withheld_probability numeric check (withheld_probability >= 0 and withheld_probability <= 1),
  reason_code text,
  updated_at timestamptz not null default now(),
  primary key (run_id, question_key, arm),
  constraint run_items_run_fkey foreign key (run_id, dataset_version_id, user_id)
    references public.runs (id, dataset_version_id, user_id) on delete cascade,
  constraint run_items_question_fkey foreign key (dataset_version_id, question_key)
    references public.version_questions (dataset_version_id, question_key) on delete cascade,
  constraint run_items_lease_shape check (
    (state = 'leased') = (lease_holder is not null and lease_expires_at is not null)
  ),
  constraint run_items_selection check (
    (state = 'done') = (selected_attempt_id is not null and probability is not null)
  )
);

create index run_items_state_idx on public.run_items (run_id, state);

create function app_private.run_items_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.run_id <> old.run_id or new.question_key <> old.question_key or new.arm <> old.arm
    or new.dataset_version_id <> old.dataset_version_id or new.user_id <> old.user_id then
    perform app_private.fail('frozen_or_mismatch', 'Run item identity cannot change.');
  end if;
  if exists (
    select 1 from public.runs as run
    where run.id = new.run_id and run.status in ('completed', 'partial', 'failed', 'cancelled')
  ) then
    perform app_private.fail('frozen_or_mismatch', 'Items of a terminal run are immutable.');
  end if;
  return new;
end;
$$;

create trigger run_items_guard before update on public.run_items
  for each row execute function app_private.run_items_guard();

-- Exact PromptEvidence, source-decision ledger and funnel per run and question; written once.
create table public.run_prompt_evidence (
  run_id uuid not null,
  question_key text not null,
  dataset_version_id uuid not null,
  user_id uuid not null,
  prompt_evidence jsonb not null check (jsonb_typeof(prompt_evidence) = 'array'),
  prompt_evidence_hash text not null check (prompt_evidence_hash ~ '^[0-9a-f]{64}$'),
  ledger jsonb not null check (jsonb_typeof(ledger) = 'array'),
  funnel jsonb not null check (jsonb_typeof(funnel) = 'object'),
  created_at timestamptz not null default now(),
  primary key (run_id, question_key),
  constraint run_prompt_evidence_run_fkey foreign key (run_id, dataset_version_id, user_id)
    references public.runs (id, dataset_version_id, user_id) on delete cascade,
  constraint run_prompt_evidence_question_fkey foreign key (dataset_version_id, question_key)
    references public.version_questions (dataset_version_id, question_key) on delete cascade
);

-- Append-only model attempts. id is the engine AttemptRecord.attemptId.
create table public.run_arm_attempts (
  id uuid primary key,
  run_id uuid not null,
  question_key text not null,
  arm text not null check (arm in ('no_research', 'research')),
  dataset_version_id uuid not null,
  user_id uuid not null,
  sequence smallint not null check (sequence in (1, 2)),
  kind text not null check (kind in ('first', 'correction', 'retry')),
  origin text not null check (origin in ('demo', 'recorded', 'manual', 'live', 'cache_hit')),
  -- Client idempotency key of the forecast request; a permitted retry uses a new key.
  request_key text not null check (char_length(request_key) between 1 and 200),
  -- Engine SHA-256 of the exact canonical model messages.
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  -- Engine computeRequestKey cache key (owner + version scoped); null for replay origins.
  cache_key text check (cache_key ~ '^[0-9a-f]{64}$'),
  prompt_evidence_hash text not null check (prompt_evidence_hash ~ '^[0-9a-f]{64}$'),
  evaluation_status text not null check (evaluation_status in ('valid', 'withheld', 'failed')),
  probability numeric check (probability >= 0 and probability <= 1),
  evaluation jsonb not null check (jsonb_typeof(evaluation) = 'object'),
  raw_text text check (raw_text is null or octet_length(raw_text) <= 65536),
  audit_flags text[] not null default '{}',
  model jsonb,
  -- Set for live origin; the composite reference is added in 20261024000200_attempt_limits.sql.
  provider_attempt_id uuid,
  cache_source_attempt_id uuid,
  -- Exact engine AttemptRecord (plus requestKey/cacheKey/providerAttemptId/cacheSourceAttemptId).
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  created_at timestamptz not null default now(),
  constraint run_arm_attempts_slot_key unique (run_id, question_key, arm, sequence),
  constraint run_arm_attempts_request_key unique (run_id, request_key),
  constraint run_arm_attempts_item_ref_key unique (id, run_id, question_key, arm),
  constraint run_arm_attempts_question_ref_key unique (id, run_id, question_key),
  constraint run_arm_attempts_item_fkey foreign key (run_id, question_key, arm)
    references public.run_items (run_id, question_key, arm) on delete cascade,
  constraint run_arm_attempts_run_fkey foreign key (run_id, dataset_version_id, user_id)
    references public.runs (id, dataset_version_id, user_id) on delete cascade,
  constraint run_arm_attempts_cache_source_fkey foreign key (cache_source_attempt_id)
    references public.run_arm_attempts (id) deferrable initially deferred,
  constraint run_arm_attempts_live_has_provider check ((origin = 'live') = (provider_attempt_id is not null)),
  constraint run_arm_attempts_cache_has_source check ((origin = 'cache_hit') = (cache_source_attempt_id is not null)),
  constraint run_arm_attempts_probability_shape check ((evaluation_status = 'failed') = (probability is null))
);

create index run_arm_attempts_cache_idx on public.run_arm_attempts (user_id, cache_key) where cache_key is not null;

alter table public.run_items
  add constraint run_items_selected_fkey foreign key (selected_attempt_id, run_id, question_key, arm)
    references public.run_arm_attempts (id, run_id, question_key, arm) deferrable initially deferred;

-- Every claim decision, including rejects. Supported claims reference the exact frozen evidence
-- row, so claim -> evidence -> question -> version -> owner is enforced by composite keys.
create table public.run_claim_decisions (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null,
  run_id uuid not null,
  question_key text not null,
  dataset_version_id uuid not null,
  user_id uuid not null,
  claim_index smallint not null check (claim_index between 0 and 15),
  claim_text text not null check (char_length(claim_text) <= 4000),
  -- Model-supplied reference; may be unknown for rejected claims.
  evidence_key text not null check (char_length(evidence_key) <= 200),
  start_offset numeric,
  end_offset numeric,
  content_hash text not null check (char_length(content_hash) <= 200),
  verdict text not null check (
    verdict in ('supported', 'empty', 'unknown_source', 'truncated_away', 'span_not_in_excerpt', 'hash_mismatch', 'invalid_offset')
  ),
  supported_evidence_key text,
  created_at timestamptz not null default now(),
  constraint run_claim_decisions_index_key unique (attempt_id, claim_index),
  constraint run_claim_decisions_attempt_fkey foreign key (attempt_id, run_id, question_key)
    references public.run_arm_attempts (id, run_id, question_key) on delete cascade,
  constraint run_claim_decisions_run_fkey foreign key (run_id, dataset_version_id, user_id)
    references public.runs (id, dataset_version_id, user_id) on delete cascade,
  constraint run_claim_decisions_evidence_fkey foreign key (dataset_version_id, question_key, supported_evidence_key)
    references public.version_evidence (dataset_version_id, question_key, evidence_key) on delete cascade,
  constraint run_claim_decisions_supported_shape check (
    (verdict = 'supported') = (supported_evidence_key is not null)
    and (supported_evidence_key is null or supported_evidence_key = evidence_key)
  )
);

create index run_claim_decisions_run_idx on public.run_claim_decisions (run_id, question_key);

-- Append-only triggers on frozen tables.
create function app_private.dataset_versions_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only the draft link may be cleared (study deletion) and rows_hash set once at finalization.
  if (to_jsonb(new) - 'study_set_id' - 'rows_hash') is distinct from (to_jsonb(old) - 'study_set_id' - 'rows_hash')
    or (old.rows_hash is not null and new.rows_hash is distinct from old.rows_hash) then
    perform app_private.fail('frozen_or_mismatch', 'Dataset versions are immutable.');
  end if;
  return new;
end;
$$;

create trigger dataset_versions_guard before update on public.dataset_versions
  for each row execute function app_private.dataset_versions_guard();
create trigger version_questions_append_only before update on public.version_questions
  for each row execute function app_private.reject_update();
create trigger version_outcomes_append_only before update on public.version_outcomes
  for each row execute function app_private.reject_update();
create trigger version_evidence_append_only before update on public.version_evidence
  for each row execute function app_private.reject_update();
create trigger version_prices_append_only before update on public.version_prices
  for each row execute function app_private.reject_update();
create trigger version_quarantine_append_only before update on public.version_quarantine
  for each row execute function app_private.reject_update();
create trigger version_recordings_append_only before update on public.version_recordings
  for each row execute function app_private.reject_update();
create trigger run_manifests_append_only before update on public.run_manifests
  for each row execute function app_private.reject_update();
create trigger run_prompt_evidence_append_only before update on public.run_prompt_evidence
  for each row execute function app_private.reject_update();
create trigger run_arm_attempts_append_only before update on public.run_arm_attempts
  for each row execute function app_private.reject_update();
create trigger run_claim_decisions_append_only before update on public.run_claim_decisions
  for each row execute function app_private.reject_update();

-- Foreign-key support indexes not covered by unique keys.
create index dataset_versions_user_idx on public.dataset_versions (user_id, created_at desc);
create index dataset_versions_study_idx on public.dataset_versions (study_set_id);
create index version_evidence_question_idx on public.version_evidence (dataset_version_id, question_key);
create index version_prices_question_idx on public.version_prices (dataset_version_id, question_key);
create index version_quarantine_question_idx on public.version_quarantine (dataset_version_id, question_key);
create index run_manifests_version_idx on public.run_manifests (dataset_version_id);
create index run_items_question_idx on public.run_items (dataset_version_id, question_key);
create index run_prompt_evidence_question_idx on public.run_prompt_evidence (dataset_version_id, question_key);
create index run_arm_attempts_run_idx on public.run_arm_attempts (run_id, question_key, arm);
create index run_claim_decisions_evidence_idx on public.run_claim_decisions (dataset_version_id, question_key, supported_evidence_key);

-- ---------------------------------------------------------------------------------------------
-- Row level security: owner policies on every parent path. Frozen tables are select-only.

alter table public.dataset_versions enable row level security;
alter table public.version_questions enable row level security;
alter table public.version_outcomes enable row level security;
alter table public.version_evidence enable row level security;
alter table public.version_prices enable row level security;
alter table public.version_quarantine enable row level security;
alter table public.version_recordings enable row level security;
alter table public.model_profiles enable row level security;
alter table public.run_manifests enable row level security;
alter table public.run_items enable row level security;
alter table public.run_prompt_evidence enable row level security;
alter table public.run_arm_attempts enable row level security;
alter table public.run_claim_decisions enable row level security;

create policy dataset_versions_owner_read on public.dataset_versions
  for select to authenticated
  using (dataset_versions.user_id = (select auth.uid()));

create policy version_questions_owner_read on public.version_questions
  for select to authenticated
  using (
    version_questions.user_id = (select auth.uid())
    and exists (
      select 1 from public.dataset_versions as version
      where version.id = version_questions.dataset_version_id and version.user_id = (select auth.uid())
    )
  );

create policy version_outcomes_owner_read on public.version_outcomes
  for select to authenticated
  using (
    version_outcomes.user_id = (select auth.uid())
    and exists (
      select 1 from public.dataset_versions as version
      where version.id = version_outcomes.dataset_version_id and version.user_id = (select auth.uid())
    )
  );

create policy version_evidence_owner_read on public.version_evidence
  for select to authenticated
  using (
    version_evidence.user_id = (select auth.uid())
    and exists (
      select 1 from public.version_questions as question
      where question.dataset_version_id = version_evidence.dataset_version_id
        and question.question_key = version_evidence.question_key
        and question.user_id = (select auth.uid())
    )
  );

create policy version_prices_owner_read on public.version_prices
  for select to authenticated
  using (
    version_prices.user_id = (select auth.uid())
    and exists (
      select 1 from public.version_questions as question
      where question.dataset_version_id = version_prices.dataset_version_id
        and question.question_key = version_prices.question_key
        and question.user_id = (select auth.uid())
    )
  );

create policy version_quarantine_owner_read on public.version_quarantine
  for select to authenticated
  using (
    version_quarantine.user_id = (select auth.uid())
    and exists (
      select 1 from public.dataset_versions as version
      where version.id = version_quarantine.dataset_version_id and version.user_id = (select auth.uid())
    )
  );

create policy version_recordings_owner_read on public.version_recordings
  for select to authenticated
  using (
    version_recordings.user_id = (select auth.uid())
    and exists (
      select 1 from public.version_questions as question
      where question.dataset_version_id = version_recordings.dataset_version_id
        and question.question_key = version_recordings.question_key
        and question.user_id = (select auth.uid())
    )
  );

create policy model_profiles_read on public.model_profiles
  for select to authenticated
  using (true);

create policy run_manifests_owner_read on public.run_manifests
  for select to authenticated
  using (
    run_manifests.user_id = (select auth.uid())
    and exists (
      select 1 from public.runs as run
      where run.id = run_manifests.run_id and run.user_id = (select auth.uid())
    )
  );

create policy run_items_owner_read on public.run_items
  for select to authenticated
  using (
    run_items.user_id = (select auth.uid())
    and exists (
      select 1 from public.runs as run
      where run.id = run_items.run_id and run.user_id = (select auth.uid())
    )
  );

create policy run_prompt_evidence_owner_read on public.run_prompt_evidence
  for select to authenticated
  using (
    run_prompt_evidence.user_id = (select auth.uid())
    and exists (
      select 1 from public.runs as run
      where run.id = run_prompt_evidence.run_id and run.user_id = (select auth.uid())
    )
  );

create policy run_arm_attempts_owner_read on public.run_arm_attempts
  for select to authenticated
  using (
    run_arm_attempts.user_id = (select auth.uid())
    and exists (
      select 1 from public.run_items as item
      where item.run_id = run_arm_attempts.run_id
        and item.question_key = run_arm_attempts.question_key
        and item.arm = run_arm_attempts.arm
        and item.user_id = (select auth.uid())
    )
  );

create policy run_claim_decisions_owner_read on public.run_claim_decisions
  for select to authenticated
  using (
    run_claim_decisions.user_id = (select auth.uid())
    and exists (
      select 1 from public.run_arm_attempts as attempt
      where attempt.id = run_claim_decisions.attempt_id and attempt.user_id = (select auth.uid())
    )
  );

-- Supabase default privileges grant everything to anon/authenticated/service_role; reset them.
-- Even the service role cannot write frozen tables directly: writes go through definer RPCs.
revoke all on
  public.dataset_versions, public.version_questions, public.version_outcomes, public.version_evidence,
  public.version_prices, public.version_quarantine, public.version_recordings, public.model_profiles,
  public.run_manifests, public.run_items, public.run_prompt_evidence, public.run_arm_attempts,
  public.run_claim_decisions
  from anon, authenticated, service_role;
grant select on
  public.dataset_versions, public.version_questions, public.version_outcomes, public.version_evidence,
  public.version_prices, public.version_quarantine, public.version_recordings, public.model_profiles,
  public.run_manifests, public.run_items, public.run_prompt_evidence, public.run_arm_attempts,
  public.run_claim_decisions
  to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Legacy surface fixes.

-- runs: clients may read their runs and edit only label and the derived summary cache. Run
-- creation, status and frozen fields go through freeze_run / finalize_run / server RPCs.
drop policy runs_owner on public.runs;

create policy runs_owner_read on public.runs
  for select to authenticated
  using (runs.user_id = (select auth.uid()));

create policy runs_owner_update on public.runs
  for update to authenticated
  using (runs.user_id = (select auth.uid()))
  with check (runs.user_id = (select auth.uid()));

revoke insert, update, delete on public.runs from anon, authenticated, service_role;
grant update (label, summary) on public.runs to authenticated;

-- claims: the baseline policy compared source.question_id with itself (unqualified question_id
-- resolved to the sources alias). Recreated with fully qualified columns.
drop policy claims_owner on public.claims;

create policy claims_owner on public.claims
  for all to authenticated
  using (claims.user_id = (select auth.uid()))
  with check (
    claims.user_id = (select auth.uid())
    and exists (
      select 1 from public.questions as question
      where question.id = claims.question_id and question.user_id = (select auth.uid())
    )
    and (
      claims.source_id is null
      or exists (
        select 1 from public.sources as source
        where source.id = claims.source_id
          and source.user_id = (select auth.uid())
          and source.question_id = claims.question_id
      )
    )
  );

-- forecasts: legacy/manual recorded drafts only. Clients can no longer create, edit or delete
-- live-origin rows; server outputs live in run_arm_attempts (no back-write).
drop policy forecasts_owner on public.forecasts;

create policy forecasts_owner_read on public.forecasts
  for select to authenticated
  using (forecasts.user_id = (select auth.uid()));

create policy forecasts_owner_insert on public.forecasts
  for insert to authenticated
  with check (
    forecasts.user_id = (select auth.uid())
    and forecasts.origin = 'recorded'
    and exists (
      select 1 from public.questions as question
      where question.id = forecasts.question_id and question.user_id = (select auth.uid())
    )
  );

create policy forecasts_owner_update on public.forecasts
  for update to authenticated
  using (forecasts.user_id = (select auth.uid()) and forecasts.origin = 'recorded')
  with check (
    forecasts.user_id = (select auth.uid())
    and forecasts.origin = 'recorded'
    and exists (
      select 1 from public.questions as question
      where question.id = forecasts.question_id and question.user_id = (select auth.uid())
    )
  );

create policy forecasts_owner_delete on public.forecasts
  for delete to authenticated
  using (forecasts.user_id = (select auth.uid()) and forecasts.origin = 'recorded');

-- Every forecasts.claim_ids entry must be a claim of the same question and owner.
create function app_private.forecasts_claims_valid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from unnest(new.claim_ids) as attached(claim_id)
    where attached.claim_id is null
      or not exists (
        select 1 from public.claims as claim
        where claim.id = attached.claim_id
          and claim.question_id = new.question_id
          and claim.user_id = new.user_id
      )
  ) then
    perform app_private.fail('invalid_input', 'Every claim_ids entry must be a claim of the same question and owner.');
  end if;
  return new;
end;
$$;

create trigger forecasts_claims_valid before insert or update of claim_ids, question_id, user_id on public.forecasts
  for each row execute function app_private.forecasts_claims_valid();

-- ---------------------------------------------------------------------------------------------
-- Server rows hash (rows-hash-v1): SHA-256 of the jsonb text of the stored rows in ordinal order.
-- Security invoker, so an owner can ask for a recomputation of their own version under RLS and
-- compare it with dataset_versions.rows_hash.

create function public.dataset_version_rows_hash(p_dataset_version_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select encode(sha256(convert_to(jsonb_build_array(
    'rows-hash-v1',
    version.header,
    version.recordings_hash,
    coalesce((
      select jsonb_agg(jsonb_build_array(question.row_doc, outcome.outcome_raw, outcome.resolution_audit_text) order by question.ordinal)
      from public.version_questions as question
      join public.version_outcomes as outcome
        on outcome.dataset_version_id = question.dataset_version_id and outcome.question_key = question.question_key
      where question.dataset_version_id = version.id
    ), '[]'::jsonb),
    coalesce((select jsonb_agg(evidence.row_doc order by evidence.ordinal) from public.version_evidence as evidence where evidence.dataset_version_id = version.id), '[]'::jsonb),
    coalesce((select jsonb_agg(price.row_doc order by price.ordinal) from public.version_prices as price where price.dataset_version_id = version.id), '[]'::jsonb),
    coalesce((select jsonb_agg(quarantine.row_doc order by quarantine.ordinal) from public.version_quarantine as quarantine where quarantine.dataset_version_id = version.id), '[]'::jsonb),
    coalesce((select jsonb_agg(recording.row_doc order by recording.ordinal) from public.version_recordings as recording where recording.dataset_version_id = version.id), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
  from public.dataset_versions as version
  where version.id = p_dataset_version_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- finalize_dataset(draft, version, versionHash) -> dataset_versions.id
--
-- p_version is the engine DatasetVersion (manifest.ts) plus two optional top-level keys from the
-- ImportResult: "recordings" (RecordedAttempt[]) and "recordingsHash". They are stripped from the
-- stored header. Validates owner, structure, explicit-UTC timestamps, LIMITS, references, eligible
-- temporal order and recomputed content hashes, then inserts every row in this one transaction or
-- raises. Idempotent per owner and version hash (returns the existing id).

create function public.finalize_dataset(p_draft_id uuid, p_version jsonb, p_version_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_kind text;
  v_protocol jsonb;
  v_buffer numeric;
  v_number numeric;
  v_frozen_at timestamptz;
  v_row jsonb;
  v_ord bigint;
  v_path text;
  v_key text;
  v_role text;
  v_status text;
  v_reasons jsonb;
  v_proof text;
  v_opens timestamptz;
  v_wording timestamptz;
  v_cutoff timestamptz;
  v_evidence_cutoff timestamptz;
  v_resolved timestamptz;
  v_outcome numeric;
  v_published jsonb;
  v_excerpt text;
  v_hash text;
  v_output jsonb;
  v_origin text;
  v_count integer;
begin
  if v_uid is null then
    perform app_private.fail('invalid_session', 'Sign in to finalize a dataset.');
  end if;
  if p_draft_id is not null and not exists (
    select 1 from public.study_sets as draft where draft.id = p_draft_id and draft.user_id = v_uid
  ) then
    perform app_private.fail('not_found', 'Draft study set not found.');
  end if;
  if p_version is null or jsonb_typeof(p_version) <> 'object' then
    perform app_private.fail('invalid_input', 'p_version must be a DatasetVersion object.');
  end if;
  -- The 1 MiB import limit applies to the manifest text (browser/normalizer). The derived version
  -- adds frozen fields and jsonb rendering adds whitespace, so the server backstop is 1.5 MiB.
  if octet_length(p_version::text) > 1572864 then
    perform app_private.fail('invalid_input', 'Dataset version payload is too large.');
  end if;
  if p_version_hash is null or p_version_hash !~ '^[0-9a-f]{64}$' or p_version ->> 'versionHash' is distinct from p_version_hash then
    perform app_private.fail('invalid_input', 'p_version_hash must equal versionHash (64 lowercase hex).');
  end if;

  select version.id into v_id
  from public.dataset_versions as version
  where version.user_id = v_uid and version.version_hash = p_version_hash;
  if v_id is not null then
    return v_id;
  end if;

  -- Envelope and protocol card.
  if (p_version -> 'schemaVersion') is distinct from '1'::jsonb then
    perform app_private.fail('invalid_input', 'schemaVersion must be 1.');
  end if;
  v_kind := app_private.txt(p_version, 'kind', '$');
  if v_kind not in ('synthetic', 'real') then
    perform app_private.fail('invalid_input', 'kind must be synthetic or real.');
  end if;
  perform app_private.txt(p_version, 'datasetId', '$', true, 200);
  perform app_private.txt(p_version, 'name', '$', true, 200);
  perform app_private.txt(p_version, 'provenance', '$');
  perform app_private.txt(p_version, 'rights', '$');
  perform app_private.txt(p_version, 'coreVersion', '$', true, 64);
  if coalesce(p_version ->> 'protocolHash', '') !~ '^[0-9a-f]{64}$' then
    perform app_private.fail('invalid_input', 'protocolHash must be 64 lowercase hex.');
  end if;
  v_frozen_at := app_private.utc(p_version -> 'frozenAt', '$.frozenAt');
  if v_frozen_at > now() + interval '5 minutes' then
    perform app_private.fail('invalid_input', 'frozenAt is in the future.');
  end if;

  v_protocol := p_version -> 'protocol';
  if v_protocol is null or jsonb_typeof(v_protocol) <> 'object' then
    perform app_private.fail('invalid_input', 'protocol must be an object.');
  end if;
  if coalesce(v_protocol ->> 'cutoffPreset', '') not in ('supplied-fixed-v1', 'scheduled-midpoint-v1') then
    perform app_private.fail('invalid_input', 'protocol.cutoffPreset is not a predeclared preset.');
  end if;
  if v_protocol ->> 'fallbackPolicy' is distinct from 'research_else_noResearch_else_half' then
    perform app_private.fail('invalid_input', 'protocol.fallbackPolicy must be research_else_noResearch_else_half.');
  end if;
  v_buffer := app_private.num(v_protocol, 'sourceBufferHours', '$.protocol');
  if v_buffer <> case v_kind when 'synthetic' then 0 else 24 end then
    perform app_private.fail('invalid_input', 'A ' || v_kind || ' dataset uses a ' || case v_kind when 'synthetic' then 0 else 24 end || 'h source buffer.');
  end if;
  if app_private.num(v_protocol, 'maxPriceAgeHours', '$.protocol') <> 24 then
    perform app_private.fail('invalid_input', 'protocol.maxPriceAgeHours is fixed at 24.');
  end if;
  v_number := app_private.num(v_protocol, 'trainMinimum', '$.protocol');
  if v_number < 10 or v_number <> trunc(v_number) then
    perform app_private.fail('invalid_input', 'protocol.trainMinimum must be an integer of at least 10.');
  end if;
  if app_private.num(v_protocol, 'calibrationBins', '$.protocol') not in (5, 10) then
    perform app_private.fail('invalid_input', 'protocol.calibrationBins must be 5 or 10.');
  end if;
  v_number := app_private.num(v_protocol, 'maxPromptExcerpts', '$.protocol');
  if v_number < 1 or v_number > 8 or v_number <> trunc(v_number) then
    perform app_private.fail('invalid_input', 'protocol.maxPromptExcerpts must be 1..8.');
  end if;
  v_number := app_private.num(v_protocol, 'bootstrapSeed', '$.protocol');
  if v_number < 1 or v_number > 4294967295 or v_number <> trunc(v_number) then
    perform app_private.fail('invalid_input', 'protocol.bootstrapSeed must be a nonzero uint32.');
  end if;
  if app_private.num(v_protocol, 'bootstrapReplicates', '$.protocol') <> 2000 then
    perform app_private.fail('invalid_input', 'protocol.bootstrapReplicates is fixed at 2000.');
  end if;
  perform app_private.txt(v_protocol, 'protocolId', '$.protocol', true, 200);
  perform app_private.txt(v_protocol, 'modelProfileVersion', '$.protocol', true, 64);
  perform app_private.txt(v_protocol, 'promptVersion', '$.protocol', true, 64);
  perform app_private.txt(v_protocol, 'gateVersion', '$.protocol', true, 64);
  perform app_private.txt(v_protocol, 'blocklistVersion', '$.protocol', true, 64);

  if jsonb_typeof(p_version -> 'questions') is distinct from 'array'
    or jsonb_typeof(p_version -> 'evidence') is distinct from 'array'
    or jsonb_typeof(p_version -> 'marketObservations') is distinct from 'array'
    or jsonb_typeof(p_version -> 'quarantine') is distinct from 'array'
    or coalesce(jsonb_typeof(p_version -> 'recordings'), 'array') <> 'array' then
    perform app_private.fail('invalid_input', 'questions, evidence, marketObservations, quarantine and recordings must be arrays.');
  end if;
  if jsonb_array_length(p_version -> 'questions') < 1 or jsonb_array_length(p_version -> 'questions') > 100 then
    perform app_private.fail('invalid_input', 'A version holds 1..100 questions, training included.');
  end if;
  if coalesce(p_version ->> 'recordingsHash', '') !~ '^[0-9a-f]{64}$'
    and (jsonb_typeof(p_version -> 'recordingsHash') is distinct from 'null' and p_version ? 'recordingsHash') then
    perform app_private.fail('invalid_input', 'recordingsHash must be 64 lowercase hex or null.');
  end if;
  if coalesce(jsonb_array_length(p_version -> 'recordings'), 0) > 0 and coalesce(p_version ->> 'recordingsHash', '') !~ '^[0-9a-f]{64}$' then
    perform app_private.fail('invalid_input', 'Recordings need a recordingsHash.');
  end if;

  begin
    insert into public.dataset_versions (
      user_id, study_set_id, dataset_id, name, kind, provenance, rights, schema_version, core_version,
      protocol, protocol_hash, version_hash, recordings_hash, frozen_at, header
    ) values (
      v_uid, p_draft_id, p_version ->> 'datasetId', p_version ->> 'name', v_kind, p_version ->> 'provenance',
      p_version ->> 'rights', 1, p_version ->> 'coreVersion', v_protocol, p_version ->> 'protocolHash',
      p_version_hash, nullif(p_version ->> 'recordingsHash', ''), v_frozen_at,
      p_version - 'questions' - 'evidence' - 'marketObservations' - 'quarantine' - 'recordings' - 'recordingsHash'
    )
    returning id into v_id;

    -- Questions (FrozenQuestion) and their scoring-only outcomes.
    for v_row, v_ord in
      select item.value, item.ordinality from jsonb_array_elements(p_version -> 'questions') with ordinality as item(value, ordinality)
    loop
      v_path := '$.questions[' || (v_ord - 1) || ']';
      if jsonb_typeof(v_row) <> 'object' then
        perform app_private.fail('invalid_input', v_path || ' must be an object.');
      end if;
      v_key := app_private.txt(v_row, 'id', v_path, true, 200);
      v_role := app_private.txt(v_row, 'role', v_path);
      if v_role not in ('training', 'evaluation') then
        perform app_private.fail('invalid_input', v_path || '.role must be training or evaluation.');
      end if;
      v_status := app_private.txt(v_row, 'status', v_path);
      if v_status not in ('eligible', 'quarantined') then
        perform app_private.fail('invalid_input', v_path || '.status must be eligible or quarantined.');
      end if;
      v_reasons := v_row -> 'quarantineReasons';
      if jsonb_typeof(v_reasons) is distinct from 'array'
        or (v_status = 'eligible') <> (jsonb_array_length(v_reasons) = 0) then
        perform app_private.fail('invalid_input', v_path || ': status must be eligible exactly when quarantineReasons is empty.');
      end if;
      perform app_private.txt(v_row, 'category', v_path, true, 200);
      perform app_private.txt(v_row, 'eventClusterId', v_path, true, 200);
      perform app_private.txt(v_row, 'questionTextAsOf', v_path);
      perform app_private.txt(v_row, 'resolutionRulesAsOf', v_path);
      v_proof := app_private.txt(v_row, 'wordingVersionProof', v_path, false);
      perform app_private.txt(v_row, 'cutoffProvenance', v_path, false);
      perform app_private.txt(v_row, 'scheduledCloseProvenance', v_path, false, 20000, true);
      perform app_private.txt(v_row, 'resolutionAuditText', v_path, false);
      v_opens := app_private.utc(v_row -> 'opensAt', v_path || '.opensAt');
      v_wording := app_private.utc(v_row -> 'wordingAvailableAt', v_path || '.wordingAvailableAt');
      perform app_private.utc(v_row -> 'suppliedCutoffAt', v_path || '.suppliedCutoffAt', true);
      perform app_private.utc(v_row -> 'scheduledCloseAt', v_path || '.scheduledCloseAt', true);
      perform app_private.utc(v_row -> 'actualCloseAt', v_path || '.actualCloseAt', true);
      v_resolved := app_private.utc(v_row -> 'resolvedAt', v_path || '.resolvedAt');
      v_cutoff := app_private.utc(v_row -> 'cutoffAt', v_path || '.cutoffAt', true);
      v_evidence_cutoff := app_private.utc(v_row -> 'evidenceCutoff', v_path || '.evidenceCutoff', true);
      v_outcome := app_private.num(v_row, 'outcome', v_path, true);

      if v_status = 'eligible' then
        if v_outcome is null or v_outcome not in (0, 1) then
          perform app_private.fail('invalid_input', v_path || ': an eligible question needs outcome exactly 0 or 1.');
        end if;
        if v_resolved > v_frozen_at then
          perform app_private.fail('invalid_input', v_path || ': an eligible question must resolve by frozenAt.');
        end if;
        if v_role = 'evaluation' then
          if v_cutoff is null or v_evidence_cutoff is null
            or not (v_opens <= v_wording and v_wording <= v_cutoff and v_cutoff < v_resolved) then
            perform app_private.fail('invalid_input', v_path || ': requires opensAt <= wordingAvailableAt <= cutoffAt < resolvedAt.');
          end if;
          if v_evidence_cutoff <> v_cutoff - make_interval(hours => v_buffer::integer) then
            perform app_private.fail('invalid_input', v_path || ': evidenceCutoff must equal cutoffAt minus the source buffer.');
          end if;
          if v_kind = 'real' and btrim(v_proof) = '' then
            perform app_private.fail('invalid_input', v_path || ': real wording needs historical availability proof.');
          end if;
        elsif v_opens > v_resolved then
          perform app_private.fail('invalid_input', v_path || ': requires opensAt <= resolvedAt.');
        end if;
      end if;

      insert into public.version_questions (
        dataset_version_id, user_id, ordinal, question_key, role, status, category, event_cluster_id,
        opens_at, wording_available_at, cutoff_at, evidence_cutoff, resolved_at, row_doc
      ) values (
        v_id, v_uid, v_ord - 1, v_key, v_role, v_status, v_row ->> 'category', v_row ->> 'eventClusterId',
        v_opens, v_wording, v_cutoff, v_evidence_cutoff, v_resolved, v_row - 'outcome' - 'resolutionAuditText'
      );
      insert into public.version_outcomes (dataset_version_id, question_key, user_id, outcome_raw, resolution_audit_text)
      values (v_id, v_key, v_uid, v_outcome, v_row ->> 'resolutionAuditText');
    end loop;

    -- Evidence: content hash is recomputed from the full excerpt and must match.
    for v_row, v_ord in
      select item.value, item.ordinality from jsonb_array_elements(p_version -> 'evidence') with ordinality as item(value, ordinality)
    loop
      v_path := '$.evidence[' || (v_ord - 1) || ']';
      if jsonb_typeof(v_row) <> 'object' then
        perform app_private.fail('invalid_input', v_path || ' must be an object.');
      end if;
      v_key := app_private.txt(v_row, 'id', v_path, true, 200);
      perform app_private.txt(v_row, 'questionId', v_path, true, 200);
      perform app_private.txt(v_row, 'title', v_path);
      perform app_private.txt(v_row, 'url', v_path, false, 4000);
      perform app_private.txt(v_row, 'versionProof', v_path, false, 20000, true);
      perform app_private.txt(v_row, 'rightsNote', v_path, false);
      v_excerpt := app_private.txt(v_row, 'excerpt', v_path, true, 1048576);
      v_hash := encode(sha256(convert_to(v_excerpt, 'UTF8')), 'hex');
      if lower(coalesce(v_row ->> 'contentHash', '')) <> v_hash then
        perform app_private.fail('invalid_input', v_path || '.contentHash does not match the SHA-256 of the excerpt.');
      end if;
      v_published := v_row -> 'published';
      if v_published is null or jsonb_typeof(v_published) <> 'object' then
        perform app_private.fail('invalid_input', v_path || '.published must be an object.');
      end if;
      case v_published ->> 'precision'
        when 'instant' then
          perform app_private.utc(v_published -> 'at', v_path || '.published.at');
        when 'day' then
          perform app_private.utc_date(v_published -> 'date', v_path || '.published.date');
        when 'interval' then
          perform app_private.utc(v_published -> 'start', v_path || '.published.start');
          perform app_private.utc(v_published -> 'end', v_path || '.published.end');
        when 'unknown' then
          null;
        else
          perform app_private.fail('invalid_input', v_path || '.published.precision must be instant, day, interval or unknown.');
      end case;

      insert into public.version_evidence (
        dataset_version_id, user_id, ordinal, evidence_key, question_key, title, url, published,
        retrieved_at, version_available_at, updated_at, excerpt, content_hash, row_doc
      ) values (
        v_id, v_uid, v_ord - 1, v_key, v_row ->> 'questionId', v_row ->> 'title', v_row ->> 'url', v_published,
        app_private.utc(v_row -> 'retrievedAt', v_path || '.retrievedAt'),
        app_private.utc(v_row -> 'versionAvailableAt', v_path || '.versionAvailableAt', true),
        app_private.utc(v_row -> 'updatedAt', v_path || '.updatedAt', true),
        v_excerpt, v_hash, v_row
      );
    end loop;

    -- Market observations (scoring-only).
    for v_row, v_ord in
      select item.value, item.ordinality from jsonb_array_elements(p_version -> 'marketObservations') with ordinality as item(value, ordinality)
    loop
      v_path := '$.marketObservations[' || (v_ord - 1) || ']';
      if jsonb_typeof(v_row) <> 'object' then
        perform app_private.fail('invalid_input', v_path || ' must be an object.');
      end if;
      v_key := app_private.txt(v_row, 'id', v_path, true, 200);
      perform app_private.txt(v_row, 'questionId', v_path, true, 200);
      perform app_private.txt(v_row, 'venue', v_path);
      perform app_private.txt(v_row, 'provenance', v_path);
      v_number := app_private.num(v_row, 'yesProbability', v_path);
      if v_number < 0 or v_number > 1 then
        perform app_private.fail('invalid_input', v_path || '.yesProbability must be in [0, 1].');
      end if;
      insert into public.version_prices (
        dataset_version_id, user_id, ordinal, observation_key, question_key, yes_probability, observed_at, venue, row_doc
      ) values (
        v_id, v_uid, v_ord - 1, v_key, v_row ->> 'questionId', v_number,
        app_private.utc(v_row -> 'observedAt', v_path || '.observedAt'), v_row ->> 'venue', v_row
      );
    end loop;

    -- Quarantine rows.
    for v_row, v_ord in
      select item.value, item.ordinality from jsonb_array_elements(p_version -> 'quarantine') with ordinality as item(value, ordinality)
    loop
      v_path := '$.quarantine[' || (v_ord - 1) || ']';
      if jsonb_typeof(v_row) <> 'object' then
        perform app_private.fail('invalid_input', v_path || ' must be an object.');
      end if;
      if coalesce(v_row ->> 'targetType', '') not in ('question', 'evidence', 'observation') then
        perform app_private.fail('invalid_input', v_path || '.targetType must be question, evidence or observation.');
      end if;
      perform app_private.txt(v_row, 'targetId', v_path, true, 200);
      perform app_private.txt(v_row, 'questionId', v_path, true, 200);
      perform app_private.txt(v_row, 'reason', v_path, true, 200);
      perform app_private.txt(v_row, 'detail', v_path, false);
      insert into public.version_quarantine (
        dataset_version_id, user_id, ordinal, target_type, target_key, question_key, reason, row_doc
      ) values (
        v_id, v_uid, v_ord - 1, v_row ->> 'targetType', v_row ->> 'targetId', v_row ->> 'questionId', v_row ->> 'reason', v_row
      );
    end loop;

    -- Recorded attempts (replay inputs). Imports cannot assert live or cache-hit origin.
    for v_row, v_ord in
      select item.value, item.ordinality from jsonb_array_elements(coalesce(p_version -> 'recordings', '[]'::jsonb)) with ordinality as item(value, ordinality)
    loop
      v_path := '$.recordings[' || (v_ord - 1) || ']';
      if jsonb_typeof(v_row) <> 'object' then
        perform app_private.fail('invalid_input', v_path || ' must be an object.');
      end if;
      v_key := app_private.txt(v_row, 'id', v_path, true, 200);
      perform app_private.txt(v_row, 'questionId', v_path, true, 200);
      if coalesce(v_row ->> 'arm', '') not in ('no_research', 'research') then
        perform app_private.fail('invalid_input', v_path || '.arm must be no_research or research.');
      end if;
      v_origin := coalesce(v_row ->> 'origin', '');
      if v_origin not in ('demo', 'recorded', 'manual') then
        perform app_private.fail('invalid_input', v_path || '.origin must be demo, recorded or manual (forged_origin).');
      end if;
      if (v_row -> 'sequence') is distinct from '1'::jsonb and (v_row -> 'sequence') is distinct from '2'::jsonb then
        perform app_private.fail('invalid_input', v_path || '.sequence must be 1 or 2.');
      end if;
      v_output := v_row -> 'output';
      if v_output is null or jsonb_typeof(v_output) <> 'object' then
        perform app_private.fail('invalid_input', v_path || '.output must be an object.');
      end if;
      if v_output ->> 'kind' = 'text' then
        perform app_private.txt(v_output, 'text', v_path || '.output', false, 65536);
      elsif v_output ->> 'kind' = 'failure' then
        perform app_private.txt(v_output, 'code', v_path || '.output', true, 64);
      else
        perform app_private.fail('invalid_input', v_path || '.output.kind must be text or failure.');
      end if;
      if coalesce(jsonb_typeof(v_row -> 'model'), 'null') not in ('null', 'object') then
        perform app_private.fail('invalid_input', v_path || '.model must be an object or null.');
      end if;
      if jsonb_typeof(v_row -> 'model') = 'object' then
        perform app_private.txt(v_row -> 'model', 'provider', v_path || '.model', true, 64);
        perform app_private.txt(v_row -> 'model', 'modelId', v_path || '.model', true, 200);
      end if;
      insert into public.version_recordings (
        dataset_version_id, user_id, ordinal, recording_key, question_key, arm, origin, sequence, output, model, row_doc
      ) values (
        v_id, v_uid, v_ord - 1, v_key, v_row ->> 'questionId', v_row ->> 'arm', v_origin,
        (v_row ->> 'sequence')::smallint, v_output, nullif(v_row -> 'model', 'null'::jsonb), v_row
      );
    end loop;
  exception
    when unique_violation then
      perform app_private.fail('invalid_input', 'Duplicate id or slot in the version: ' || sqlerrm);
    when foreign_key_violation then
      perform app_private.fail('invalid_input', 'Unresolved or wrong-role reference in the version: ' || sqlerrm);
    when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range then
      perform app_private.fail('invalid_input', 'Row rejected by a version constraint: ' || sqlerrm);
  end;

  -- Per-question envelope limits.
  select count(*) into v_count from (
    select evidence.question_key from public.version_evidence as evidence
    where evidence.dataset_version_id = v_id
    group by evidence.question_key having count(*) > 50
  ) as over_limit;
  if v_count > 0 then
    perform app_private.fail('invalid_input', 'At most 50 evidence candidates per question.');
  end if;
  select count(*) into v_count from (
    select price.question_key from public.version_prices as price
    where price.dataset_version_id = v_id
    group by price.question_key having count(*) > 50
  ) as over_limit;
  if v_count > 0 then
    perform app_private.fail('invalid_input', 'At most 50 price observations per question.');
  end if;

  -- Quarantine accounting: every quarantined question has a question-level quarantine row and
  -- every question-level row names a quarantined question.
  if exists (
    select 1 from public.version_questions as question
    where question.dataset_version_id = v_id and question.status = 'quarantined'
      and not exists (
        select 1 from public.version_quarantine as quarantine
        where quarantine.dataset_version_id = v_id and quarantine.target_type = 'question'
          and quarantine.target_key = question.question_key
      )
  ) or exists (
    select 1 from public.version_quarantine as quarantine
    where quarantine.dataset_version_id = v_id and quarantine.target_type = 'question'
      and not exists (
        select 1 from public.version_questions as question
        where question.dataset_version_id = v_id and question.question_key = quarantine.target_key
          and question.status = 'quarantined'
      )
  ) then
    perform app_private.fail('invalid_input', 'Quarantine rows and question statuses disagree.');
  end if;

  update public.dataset_versions
  set rows_hash = public.dataset_version_rows_hash(v_id)
  where id = v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- freeze_run(...) -> runs.id (the engine RunManifest.runId)
--
-- Re-derives the evaluation, excluded and training cohorts from the frozen version at the
-- manifest's createdAt and refuses any difference. Live mode needs live_enabled, the protocol's
-- model profile, an enabled profile with declared cutoff/source/confirmation and verified pricing,
-- and a declared cutoff before every evaluation question opened. Creates runs, run_manifests and
-- pending run_items atomically. p_linked_run_id optionally links a terminal predecessor run.
-- (Reads public.app_limits from 20261024000200_attempt_limits.sql; plpgsql binds it at run time.)

create function public.freeze_run(
  p_dataset_version_id uuid,
  p_model_profile_version text,
  p_protocol_hash text,
  p_manifest jsonb,
  p_manifest_hash text,
  p_mode text,
  p_linked_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_version public.dataset_versions%rowtype;
  v_profile public.model_profiles%rowtype;
  v_doc jsonb;
  v_run_id uuid;
  v_created timestamptz;
  v_declared_cutoff timestamptz;
  v_live_enabled boolean;
  v_eval text[];
  v_excluded text[];
  v_train text[];
  v_claim_eval text[];
  v_claim_excluded text[];
  v_claim_train text[];
begin
  if v_uid is null then
    perform app_private.fail('invalid_session', 'Sign in to create a run.');
  end if;
  select * into v_version from public.dataset_versions as version
  where version.id = p_dataset_version_id and version.user_id = v_uid;
  if not found then
    perform app_private.fail('not_found', 'Dataset version not found.');
  end if;
  if p_protocol_hash is distinct from v_version.protocol_hash then
    perform app_private.fail('frozen_or_mismatch', 'Protocol hash does not match the frozen version.');
  end if;
  if p_mode is null or p_mode not in ('replay', 'live') then
    perform app_private.fail('invalid_input', 'mode must be replay or live.');
  end if;
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'object' or octet_length(p_manifest::text) > 262144 then
    perform app_private.fail('invalid_input', 'p_manifest must be a RunManifest object.');
  end if;
  if p_manifest_hash is null or p_manifest_hash !~ '^[0-9a-f]{64}$' or p_manifest ->> 'manifestHash' is distinct from p_manifest_hash then
    perform app_private.fail('invalid_input', 'p_manifest_hash must equal manifest.manifestHash (64 lowercase hex).');
  end if;
  if p_manifest ->> 'datasetVersionHash' is distinct from v_version.version_hash
    or p_manifest ->> 'protocolHash' is distinct from v_version.protocol_hash
    or p_manifest ->> 'datasetId' is distinct from v_version.dataset_id
    or p_manifest ->> 'datasetKind' is distinct from v_version.kind
    or p_manifest ->> 'mode' is distinct from p_mode then
    perform app_private.fail('frozen_or_mismatch', 'Manifest does not describe this dataset version and mode.');
  end if;
  begin
    v_run_id := (p_manifest ->> 'runId')::uuid;
  exception when invalid_text_representation then
    v_run_id := null;
  end;
  if v_run_id is null then
    perform app_private.fail('invalid_input', 'manifest.runId must be a uuid.');
  end if;
  v_created := app_private.utc(p_manifest -> 'createdAt', '$.createdAt');
  if v_created > now() + interval '5 minutes' or v_created < now() - interval '1 hour' then
    perform app_private.fail('invalid_input', 'manifest.createdAt must be the current time.');
  end if;
  if jsonb_typeof(p_manifest -> 'evaluationIds') is distinct from 'array'
    or jsonb_typeof(p_manifest -> 'trainingIds') is distinct from 'array'
    or jsonb_typeof(p_manifest -> 'excluded') is distinct from 'array' then
    perform app_private.fail('invalid_input', 'evaluationIds, trainingIds and excluded must be arrays.');
  end if;

  -- Server-derived cohorts (run.ts freezeRun): eligible evaluation questions resolved by createdAt.
  select coalesce(array_agg(question.question_key order by question.question_key collate "C"), '{}')
  into v_eval
  from public.version_questions as question
  where question.dataset_version_id = v_version.id and question.role = 'evaluation'
    and question.status = 'eligible' and question.resolved_at <= v_created;
  select coalesce(array_agg(question.question_key order by question.question_key collate "C"), '{}')
  into v_excluded
  from public.version_questions as question
  where question.dataset_version_id = v_version.id and question.role = 'evaluation'
    and not (question.status = 'eligible' and question.resolved_at <= v_created);
  select coalesce(array_agg(question.question_key order by question.question_key collate "C"), '{}')
  into v_train
  from public.version_questions as question
  where question.dataset_version_id = v_version.id and question.role = 'training' and question.status = 'eligible';

  select coalesce(array_agg(claimed.value order by claimed.value collate "C"), '{}') into v_claim_eval
  from jsonb_array_elements_text(p_manifest -> 'evaluationIds') as claimed(value);
  select coalesce(array_agg(claimed.value order by claimed.value collate "C"), '{}') into v_claim_train
  from jsonb_array_elements_text(p_manifest -> 'trainingIds') as claimed(value);
  select coalesce(array_agg(claimed.value ->> 'questionId' order by claimed.value ->> 'questionId' collate "C"), '{}') into v_claim_excluded
  from jsonb_array_elements(p_manifest -> 'excluded') as claimed(value);

  if v_claim_eval <> v_eval or v_claim_train <> v_train or v_claim_excluded <> v_excluded then
    perform app_private.fail('frozen_or_mismatch', 'Manifest cohorts differ from the frozen version.');
  end if;
  if cardinality(v_eval) = 0 then
    perform app_private.fail('invalid_input', 'The version has no eligible evaluation questions.');
  end if;

  if p_mode = 'live' then
    select limits.live_enabled into v_live_enabled from public.app_limits as limits where limits.id;
    if not coalesce(v_live_enabled, false) then
      perform app_private.fail('configuration_required', 'Live model calls are not enabled.');
    end if;
    if p_model_profile_version is null or p_model_profile_version is distinct from v_version.protocol ->> 'modelProfileVersion' then
      perform app_private.fail('manifest_or_config_mismatch', 'The model profile must be the one frozen in the protocol card.');
    end if;
    select * into v_profile from public.model_profiles as profile
    where profile.profile_version = p_model_profile_version and profile.enabled;
    if not found then
      perform app_private.fail('configuration_required', 'No enabled server model profile ' || p_model_profile_version || '.');
    end if;
    v_doc := v_profile.profile;
    if btrim(coalesce(v_doc ->> 'trainingCutoffSource', '')) = ''
      or jsonb_typeof(v_doc -> 'pricing') is distinct from 'object'
      or v_doc -> 'pricing' ->> 'reasoningBilling' is distinct from 'verified_within_output_cap'
      or jsonb_typeof(v_doc -> 'pricing' -> 'maxInputTokensPerByte') is distinct from 'number'
      or jsonb_typeof(v_doc -> 'pricing' -> 'inputUsdPerMTok') is distinct from 'number'
      or jsonb_typeof(v_doc -> 'pricing' -> 'outputUsdPerMTok') is distinct from 'number'
      or case
        when jsonb_typeof(v_doc -> 'maxOutputTokens') = 'number' then (v_doc ->> 'maxOutputTokens')::numeric not between 1 and 1024
        else true
      end then
      perform app_private.fail('configuration_required', 'Model profile lacks a declared cutoff source, verified pricing/tokenization or a valid output cap.');
    end if;
    begin
      v_declared_cutoff := app_private.utc(v_doc -> 'declaredTrainingCutoff', 'declaredTrainingCutoff');
      perform app_private.utc(v_doc -> 'trainingCutoffConfirmedAt', 'trainingCutoffConfirmedAt');
      perform app_private.utc(v_doc -> 'pricing' -> 'verifiedAt', 'pricing.verifiedAt');
    exception when sqlstate 'PT400' then
      perform app_private.fail('configuration_required', 'Model profile training cutoff, confirmation or pricing verification date is unknown.');
    end;
    if exists (
      select 1 from public.version_questions as question
      where question.dataset_version_id = v_version.id
        and question.question_key = any (v_eval)
        and question.opens_at <= v_declared_cutoff
    ) then
      perform app_private.fail('configuration_required', 'training_cutoff_not_before_question_open');
    end if;
    if (p_manifest -> 'modelProfile') is distinct from v_doc then
      perform app_private.fail('manifest_or_config_mismatch', 'Manifest model profile differs from the server profile.');
    end if;
    if (p_manifest -> 'liveEligibility' ->> 'eligible') is distinct from 'true' then
      perform app_private.fail('manifest_or_config_mismatch', 'Manifest live eligibility is not true.');
    end if;
    if coalesce(jsonb_typeof(p_manifest -> 'recordingsHash'), 'null') <> 'null' then
      perform app_private.fail('invalid_input', 'Live manifests carry no recordings hash.');
    end if;
  else
    if v_version.recordings_hash is null or p_manifest ->> 'recordingsHash' is distinct from v_version.recordings_hash then
      perform app_private.fail('frozen_or_mismatch', 'Replay needs the version recordings hash.');
    end if;
    if coalesce(jsonb_typeof(p_manifest -> 'modelProfile'), 'null') <> 'null' then
      perform app_private.fail('invalid_input', 'Replay manifests carry no model profile.');
    end if;
  end if;

  if p_linked_run_id is not null and not exists (
    select 1 from public.runs as linked
    where linked.id = p_linked_run_id and linked.user_id = v_uid and linked.dataset_version_id = v_version.id
      and linked.status in ('completed', 'partial', 'failed', 'cancelled')
  ) then
    perform app_private.fail('not_found', 'Linked run not found or not terminal.');
  end if;

  begin
    insert into public.runs (
      id, set_id, user_id, label, summary, dataset_version_id, status, mode, manifest_hash, linked_run_id
    ) values (
      v_run_id, v_version.study_set_id, v_uid, left(v_version.name, 160) || ' - ' || p_mode, '{}'::jsonb,
      v_version.id, 'created', p_mode, p_manifest_hash, p_linked_run_id
    );
  exception when unique_violation then
    perform app_private.fail('frozen_or_mismatch', 'A run with this id already exists.');
  end;

  insert into public.run_manifests (
    run_id, dataset_version_id, user_id, mode, manifest, manifest_hash, model_profile_version,
    model_profile, evaluation_keys, training_keys, recordings_hash, manifest_created_at
  ) values (
    v_run_id, v_version.id, v_uid, p_mode, p_manifest, p_manifest_hash,
    case when p_mode = 'live' then p_model_profile_version end,
    case when p_mode = 'live' then v_doc end,
    v_eval, v_train,
    case when p_mode = 'replay' then v_version.recordings_hash end,
    v_created
  );

  insert into public.run_items (run_id, question_key, arm, dataset_version_id, user_id)
  select v_run_id, eligible.question_key, arms.arm, v_version.id, v_uid
  from unnest(v_eval) as eligible(question_key)
  cross join (values ('no_research'), ('research')) as arms(arm);

  return v_run_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- record_prompt_evidence(...) -- server only. Stores the engine GateResult for one run question
-- once, before any model call. Recomputes excerptHash, checks every item is the frozen excerpt of
-- this question cut at 2,000 code points with its content hash, and that ledger/funnel/kept set
-- agree with the frozen candidates. A repeat with the same hash is a no-op; a different hash is
-- frozen_or_mismatch.

create function public.record_prompt_evidence(
  p_run_id uuid,
  p_question_key text,
  p_prompt_evidence jsonb,
  p_prompt_evidence_hash text,
  p_ledger jsonb,
  p_funnel jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
  v_existing text;
  v_max numeric;
  v_raw integer;
  v_item jsonb;
  v_full text;
  v_excerpt text;
  v_kept text[];
  v_pack text[];
begin
  select * into v_run from public.runs as run where run.id = p_run_id and run.dataset_version_id is not null;
  if not found then
    perform app_private.fail('not_found', 'Run not found.');
  end if;
  if v_run.status not in ('created', 'processing') then
    perform app_private.fail('frozen_or_mismatch', 'Run is terminal.');
  end if;
  if not exists (select 1 from public.run_items as item where item.run_id = p_run_id and item.question_key = p_question_key) then
    perform app_private.fail('not_found', 'Question is not part of this run.');
  end if;
  if p_prompt_evidence_hash is null or p_prompt_evidence_hash !~ '^[0-9a-f]{64}$' then
    perform app_private.fail('invalid_input', 'promptEvidenceHash must be 64 lowercase hex.');
  end if;

  select evidence.prompt_evidence_hash into v_existing
  from public.run_prompt_evidence as evidence
  where evidence.run_id = p_run_id and evidence.question_key = p_question_key;
  if found then
    if v_existing = p_prompt_evidence_hash then
      return;
    end if;
    perform app_private.fail('frozen_or_mismatch', 'Prompt evidence for this run question is already frozen.');
  end if;

  if jsonb_typeof(p_prompt_evidence) is distinct from 'array'
    or jsonb_typeof(p_ledger) is distinct from 'array'
    or jsonb_typeof(p_funnel) is distinct from 'object' then
    perform app_private.fail('invalid_input', 'promptEvidence and ledger must be arrays, funnel an object.');
  end if;
  select (version.protocol ->> 'maxPromptExcerpts')::numeric into v_max
  from public.dataset_versions as version where version.id = v_run.dataset_version_id;
  if jsonb_array_length(p_prompt_evidence) > least(coalesce(v_max, 8), 8) then
    perform app_private.fail('invalid_input', 'Prompt evidence exceeds the protocol excerpt cap.');
  end if;

  for v_item in select pack.value from jsonb_array_elements(p_prompt_evidence) as pack(value)
  loop
    if jsonb_typeof(v_item) <> 'object' or v_item ->> 'questionId' is distinct from p_question_key then
      perform app_private.fail('invalid_input', 'Each prompt evidence item must be an object of this question.');
    end if;
    v_full := null;
    select evidence.excerpt into v_full
    from public.version_evidence as evidence
    where evidence.dataset_version_id = v_run.dataset_version_id
      and evidence.question_key = p_question_key
      and evidence.evidence_key = v_item ->> 'evidenceId'
      and evidence.content_hash = v_item ->> 'contentHash';
    if v_full is null then
      perform app_private.fail('frozen_or_mismatch', 'Prompt evidence must cite this question''s frozen evidence by content hash.');
    end if;
    v_excerpt := v_item ->> 'excerpt';
    if v_excerpt is null or v_excerpt <> left(v_full, 2000) then
      perform app_private.fail('frozen_or_mismatch', 'Prompt excerpt must be the frozen excerpt cut at 2,000 code points.');
    end if;
    if v_item ->> 'excerptHash' is distinct from encode(sha256(convert_to(v_excerpt, 'UTF8')), 'hex') then
      perform app_private.fail('invalid_input', 'excerptHash does not match the SHA-256 of the prompt excerpt.');
    end if;
    if (v_item -> 'truncated') is distinct from to_jsonb(char_length(v_full) > 2000) then
      perform app_private.fail('invalid_input', 'truncated flag disagrees with the frozen excerpt length.');
    end if;
  end loop;

  select count(*) into v_raw from public.version_evidence as evidence
  where evidence.dataset_version_id = v_run.dataset_version_id and evidence.question_key = p_question_key;
  if jsonb_array_length(p_ledger) <> v_raw
    or (select count(distinct entry.value ->> 'evidenceId') from jsonb_array_elements(p_ledger) as entry(value)) <> v_raw
    or exists (
      select 1 from jsonb_array_elements(p_ledger) as entry(value)
      where jsonb_typeof(entry.value) <> 'object'
        or entry.value ->> 'questionId' is distinct from p_question_key
        or coalesce(entry.value ->> 'decision', '') not in (
          'kept', 'invalid_reference', 'rights_missing', 'blocklisted_source', 'undated',
          'published_after_cutoff', 'version_unavailable', 'update_marker', 'duplicate_content', 'over_cap'
        )
        or not exists (
          select 1 from public.version_evidence as evidence
          where evidence.dataset_version_id = v_run.dataset_version_id
            and evidence.question_key = p_question_key
            and evidence.evidence_key = entry.value ->> 'evidenceId'
        )
    ) then
    perform app_private.fail('invalid_input', 'The ledger must hold one valid decision per frozen candidate of this question.');
  end if;

  select coalesce(array_agg(entry.value ->> 'evidenceId' order by entry.value ->> 'evidenceId' collate "C"), '{}') into v_kept
  from jsonb_array_elements(p_ledger) as entry(value) where entry.value ->> 'decision' = 'kept';
  select coalesce(array_agg(pack.value ->> 'evidenceId' order by pack.value ->> 'evidenceId' collate "C"), '{}') into v_pack
  from jsonb_array_elements(p_prompt_evidence) as pack(value);
  if v_kept <> v_pack then
    perform app_private.fail('invalid_input', 'Kept ledger entries must equal the prompt evidence pack.');
  end if;
  if p_funnel ->> 'questionId' is distinct from p_question_key
    or (p_funnel -> 'raw') is distinct from to_jsonb(v_raw)
    or (p_funnel -> 'kept') is distinct from to_jsonb(cardinality(v_kept)) then
    perform app_private.fail('invalid_input', 'Funnel raw/kept counts disagree with the ledger.');
  end if;

  insert into public.run_prompt_evidence (
    run_id, question_key, dataset_version_id, user_id, prompt_evidence, prompt_evidence_hash, ledger, funnel
  ) values (
    p_run_id, p_question_key, v_run.dataset_version_id, v_run.user_id, p_prompt_evidence, p_prompt_evidence_hash, p_ledger, p_funnel
  )
  on conflict (run_id, question_key) do nothing;
  -- A concurrent first writer won: identical evidence is a no-op, anything else is a mismatch.
  if not found and (
    select evidence.prompt_evidence_hash from public.run_prompt_evidence as evidence
    where evidence.run_id = p_run_id and evidence.question_key = p_question_key
  ) is distinct from p_prompt_evidence_hash then
    perform app_private.fail('frozen_or_mismatch', 'Prompt evidence for this run question was already recorded differently.');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- finalize_run(runId) -> 'completed' | 'partial'
-- Owned created/processing run only. completed when every item is terminal, partial otherwise
-- (unfinished items stay recorded as missing). An active lease is in_progress. Terminal runs are
-- immutable (runs_guard / run_items_guard).

create function public.finalize_run(p_run_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_run public.runs%rowtype;
  v_active integer;
  v_open integer;
  v_status text;
begin
  if v_uid is null then
    perform app_private.fail('invalid_session', 'Sign in to finalize a run.');
  end if;
  select * into v_run from public.runs as run
  where run.id = p_run_id and run.user_id = v_uid and run.dataset_version_id is not null
  for update;
  if not found then
    perform app_private.fail('not_found', 'Run not found.');
  end if;
  if v_run.status not in ('created', 'processing') then
    perform app_private.fail('frozen_or_mismatch', 'Run is already terminal.');
  end if;
  select
    count(*) filter (where item.state = 'leased' and item.lease_expires_at > now()),
    count(*) filter (where item.state in ('pending', 'leased'))
  into v_active, v_open
  from public.run_items as item
  where item.run_id = p_run_id;
  if v_active > 0 then
    perform app_private.fail('in_progress', 'A model call for this run is still leased.');
  end if;
  -- Expired leases end as pending (missing); any reserved provider charge stays consumed and is
  -- marked unknown (public.provider_attempts is created in 20261024000200; plpgsql binds late).
  update public.provider_attempts as attempt
  set status = 'unknown', error_code = coalesce(attempt.error_code, 'run_finalized'), finalized_at = now()
  where attempt.run_id = p_run_id and attempt.status = 'reserved';
  update public.run_items as item
  set state = 'pending', lease_holder = null, lease_expires_at = null, updated_at = now()
  where item.run_id = p_run_id and item.state = 'leased';
  v_status := case
    when v_open = 0 and not exists (
      select 1 from public.run_items as item where item.run_id = p_run_id and item.reason_code = 'replay_miss'
    ) then 'completed'
    else 'partial'
  end;
  update public.runs set status = v_status, finalized_at = now() where id = p_run_id;
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Function grants. Supabase grants EXECUTE on new public functions to anon/authenticated/
-- service_role by default and Postgres grants it to PUBLIC; reset explicitly.

revoke all on function public.dataset_version_rows_hash(uuid) from public, anon, authenticated, service_role;
revoke all on function public.finalize_dataset(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.freeze_run(uuid, text, text, jsonb, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_prompt_evidence(uuid, text, jsonb, text, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.finalize_run(uuid) from public, anon, authenticated, service_role;

grant execute on function public.dataset_version_rows_hash(uuid) to authenticated, service_role;
grant execute on function public.finalize_dataset(uuid, jsonb, text) to authenticated;
grant execute on function public.freeze_run(uuid, text, text, jsonb, text, text, uuid) to authenticated;
grant execute on function public.finalize_run(uuid) to authenticated;
grant execute on function public.record_prompt_evidence(uuid, text, jsonb, text, jsonb, jsonb) to service_role;

revoke all on all functions in schema app_private from public, anon, authenticated, service_role;
