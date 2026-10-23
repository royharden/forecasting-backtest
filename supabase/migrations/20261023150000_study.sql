-- Backtest study records for one signed-in user.
-- Bolt Database applies this file. It has not been executed in Dirty Mode.

create table public.study_sets (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  created_at timestamptz not null default now()
);

create table public.questions (
  id uuid primary key,
  set_id uuid not null references public.study_sets (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  prompt text not null check (char_length(btrim(prompt)) > 0),
  cutoff_at timestamptz not null,
  resolved_at timestamptz not null,
  outcome boolean not null,
  market_price numeric not null,
  resolution_statement text not null default '',
  model_knowledge_cutoff timestamptz,
  created_at timestamptz not null default now(),
  constraint questions_cutoff_before_resolution check (cutoff_at < resolved_at),
  constraint questions_market_price_unit check (market_price >= 0 and market_price <= 1)
);

create table public.sources (
  id uuid primary key,
  question_id uuid not null references public.questions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) > 0),
  url text not null default '',
  published_at timestamptz,
  body text not null default '',
  created_at timestamptz not null default now()
);

create table public.claims (
  id uuid primary key,
  question_id uuid not null references public.questions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  text text not null check (char_length(btrim(text)) > 0),
  source_id uuid references public.sources (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.forecasts (
  id uuid primary key,
  question_id uuid not null references public.questions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  arm text not null check (arm in ('no_research', 'research')),
  probability numeric not null check (probability >= 0 and probability <= 1),
  origin text not null check (origin in ('recorded', 'live')),
  rationale text not null default '',
  model text,
  status text not null check (status in ('scored', 'withheld')),
  withhold_reason text,
  claim_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.runs (
  id uuid primary key,
  set_id uuid not null references public.study_sets (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null check (char_length(btrim(label)) > 0),
  summary jsonb not null,
  created_at timestamptz not null default now()
);

create index study_sets_user_idx on public.study_sets (user_id, created_at desc);
create index questions_set_idx on public.questions (set_id, cutoff_at);
create index questions_user_idx on public.questions (user_id);
create index sources_question_idx on public.sources (question_id);
create index claims_question_idx on public.claims (question_id);
create index forecasts_question_idx on public.forecasts (question_id, created_at);
create index forecasts_user_time_idx on public.forecasts (user_id, created_at desc);
create index runs_set_idx on public.runs (set_id, created_at desc);

alter table public.study_sets enable row level security;
alter table public.questions enable row level security;
alter table public.sources enable row level security;
alter table public.claims enable row level security;
alter table public.forecasts enable row level security;
alter table public.runs enable row level security;

create policy study_sets_owner on public.study_sets
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy questions_owner on public.questions
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.study_sets as study_set
      where study_set.id = set_id and study_set.user_id = auth.uid()
    )
  );

create policy sources_owner on public.sources
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.questions as question
      where question.id = question_id and question.user_id = auth.uid()
    )
  );

create policy claims_owner on public.claims
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.questions as question
      where question.id = question_id and question.user_id = auth.uid()
    )
    and (
      source_id is null
      or exists (
        select 1 from public.sources as source
        where source.id = source_id
          and source.user_id = auth.uid()
          and source.question_id = question_id
      )
    )
  );

create policy forecasts_owner on public.forecasts
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.questions as question
      where question.id = question_id and question.user_id = auth.uid()
    )
  );

create policy runs_owner on public.runs
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.study_sets as study_set
      where study_set.id = set_id and study_set.user_id = auth.uid()
    )
  );

revoke all on public.study_sets, public.questions, public.sources, public.claims, public.forecasts, public.runs
  from anon, authenticated;
grant select, insert, update, delete on public.study_sets, public.questions, public.sources, public.claims, public.forecasts, public.runs
  to authenticated;
