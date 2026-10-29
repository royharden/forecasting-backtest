-- Preserve existing history; enforce exact JavaScript spans and ordering for all Unicode.
create function app_private.utf16_sort_key(p_text text) returns text
language plpgsql immutable strict set search_path = '' as $$
declare v_char text; v_code integer; v_key text := '';
begin
  foreach v_char in array regexp_split_to_array(p_text, '') loop
    v_code := ascii(v_char);
    if v_code > 65535 then
      v_key := v_key || lpad(to_hex(55296 + ((v_code - 65536) / 1024)), 4, '0')
                     || lpad(to_hex(56320 + ((v_code - 65536) % 1024)), 4, '0');
    else
      v_key := v_key || lpad(to_hex(v_code), 4, '0');
    end if;
  end loop;
  return v_key;
end $$;

create function app_private.utf16_span(p_text text, p_start integer, p_end integer) returns text
language plpgsql immutable strict set search_path = '' as $$
declare v_char text; v_pos integer := 0; v_width integer; v_result text := '';
        v_start_found boolean := false; v_end_found boolean := false;
begin
  if p_start < 0 or p_end <= p_start then return null; end if;
  foreach v_char in array regexp_split_to_array(p_text, '') loop
    if v_pos = p_start then v_start_found := true; end if;
    if v_pos = p_end then v_end_found := true; exit; end if;
    v_width := case when ascii(v_char) > 65535 then 2 else 1 end;
    if v_pos >= p_start and v_pos < p_end then v_result := v_result || v_char; end if;
    v_pos := v_pos + v_width;
  end loop;
  if v_pos = p_end then v_end_found := true; end if;
  if not v_start_found or not v_end_found then return null; end if;
  return v_result;
end $$;

create function app_private.claim_span_guard() returns trigger
language plpgsql set search_path = '' as $$
declare v_excerpt text;
begin
  if new.verdict = 'supported' then
    select item.value ->> 'excerpt' into v_excerpt
    from public.run_prompt_evidence as evidence
    cross join lateral jsonb_array_elements(evidence.prompt_evidence) as item(value)
    where evidence.run_id = new.run_id and evidence.question_key = new.question_key
      and item.value ->> 'evidenceId' = new.evidence_key
      and item.value ->> 'excerptHash' = new.content_hash;
    if v_excerpt is null or new.start_offset is null or new.end_offset is null
      or new.start_offset <> trunc(new.start_offset) or new.end_offset <> trunc(new.end_offset)
      or new.start_offset < 0 or new.end_offset > 4000
      or app_private.utf16_span(v_excerpt, new.start_offset::integer, new.end_offset::integer) is distinct from new.claim_text then
      perform app_private.fail('frozen_or_mismatch', 'A supported claim must be an exact UTF-16 excerpt span.');
    end if;
  end if;
  return new;
end $$;
create trigger claim_span_guard before insert on public.run_claim_decisions
for each row execute function app_private.claim_span_guard();
revoke all on function app_private.utf16_sort_key(text), app_private.utf16_span(text,integer,integer), app_private.claim_span_guard() from public;

create or replace function public.create_audit_sample(p_run_id uuid, p_requested_n integer, p_seed bigint)
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
    coalesce(array_agg(pair.question_key order by app_private.utf16_sort_key(pair.question_key) collate "C", app_private.utf16_sort_key(pair.evidence_key) collate "C"), '{}'),
    coalesce(array_agg(pair.evidence_key order by app_private.utf16_sort_key(pair.question_key) collate "C", app_private.utf16_sort_key(pair.evidence_key) collate "C"), '{}')
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

