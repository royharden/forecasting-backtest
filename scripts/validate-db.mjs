// Local synthetic PostgreSQL regression harness. Never connects to a remote database.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { importManifest, freezeRun, replayRun, createAuditSample, sha256Hex } from '../supabase/functions/_shared/engine.ts';
import { harborManifestValue } from '../src/lib/demoPack.ts';

const [container, database] = process.argv.slice(2);
if (!/^s14-int-[\w-]+$/.test(container ?? '') || !/^s14_[a-z0-9_]+$/.test(database ?? '')) throw Error('Provide an INT-owned s14-int- container and a NEW s14_ test database.');
const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
docker(['exec', container, 'createdb', '-U', 'postgres', database]);
const j = value => `$s14json$${JSON.stringify(value)}$s14json$::jsonb`;
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const now = new Date().toISOString();
const raw = harborManifestValue();
// Exercise real SQL/engine parity with the ordering that UTF-8 and UTF-16 disagree on.
const renamed = new Map();
for (const [i, evidence] of raw.evidence.filter(e=>e.questionId==='q6').slice(0,2).entries()) {
  const old = evidence.id;
  evidence.id = i === 0 ? '\uE000' : '😀';
  evidence.excerpt = `😀 ${evidence.excerpt}`;
  evidence.contentHash = sha256Hex(evidence.excerpt);
  renamed.set(old, evidence);
}
for (const recording of raw.recordedAttempts) {
  if (recording.output.kind !== 'text') continue;
  const parsed=JSON.parse(recording.output.text);
  for (const claim of parsed.claims ?? []) {
    const evidence=renamed.get(claim.evidenceId);
    if (evidence) Object.assign(claim,{evidenceId:evidence.id,start:claim.start+3,end:claim.end+3,contentHash:evidence.contentHash});
  }
  recording.output.text=JSON.stringify(parsed);
}
const fixture = importManifest(raw, now);
if (!fixture.ok) throw Error(JSON.stringify(fixture.errors));
const runId = randomUUID(), owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', draft = randomUUID();
const frozen = freezeRun(fixture.version, {runId, createdAt: now, mode:'replay', profile:null, allowlist:[], recordingsHash:fixture.recordingsHash});
if (!frozen.ok) throw Error(frozen.code);
const execution = replayRun(fixture.version, frozen.manifest, fixture.recordings);
let sql = `create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema public,auth to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
create extension pgcrypto;
`;
for (const file of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) sql += `\n-- APPLY ${file}\n${readFileSync(`supabase/migrations/${file}`,'utf8')}\n`;
sql += `create function pg_temp.require(ok boolean, label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'ASSERT: %',label; end if; end $$;
insert into auth.users values (${q(owner)}),(${q(other)});
set local role authenticated;
select set_config('request.jwt.claim.sub',${q(owner)},true);
insert into public.study_sets(id,user_id,name) values(${q(draft)},${q(owner)},'Synthetic validation');
select public.finalize_dataset(${q(draft)},${j({...fixture.version, recordings:fixture.recordings, recordingsHash:fixture.recordingsHash})},${q(fixture.version.versionHash)}) as version_id \\gset
select public.freeze_run(:'version_id',null,${q(fixture.version.protocolHash)},${j(frozen.manifest)},${q(frozen.manifest.manifestHash)},'replay');
select pg_temp.require((select count(*)=${fixture.version.questions.length} from public.version_questions),'all frozen training and evaluation questions');
select pg_temp.require((select count(*)=6 from public.version_questions where row_doc->>'role'='evaluation'),'six evaluation questions');
select set_config('request.jwt.claim.sub',${q(other)},true);
select pg_temp.require((select count(*)=0 from public.dataset_versions),'B cannot see A versions');
select pg_temp.require((select count(*)=0 from public.runs),'B cannot see A runs');
reset role;
select pg_temp.require(not has_function_privilege('authenticated','public.lease_arm(uuid,uuid,text,text,uuid,integer)','EXECUTE'),'lease RPC service-only');
select pg_temp.require(not has_function_privilege('anon','public.finalize_dataset(uuid,jsonb,text)','EXECUTE'),'anon cannot finalize');
select pg_temp.require((select bool_and(relrowsecurity) from pg_class where oid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r')),'RLS on every public table');
select pg_temp.require(app_private.utf16_span('😀abc',0,2)='😀','whole astral span');
select pg_temp.require(app_private.utf16_span('😀abc',0,1) is null,'split surrogate rejected');
select pg_temp.require(app_private.utf16_span('😀abc',2,5)='abc','offsets after astral');
select pg_temp.require(app_private.utf16_span('😀abc',0,99) is null,'out of range rejected');
select pg_temp.require(app_private.utf16_sort_key('😀') collate "C" < app_private.utf16_sort_key(U&'\\E000') collate "C",'sort matches JavaScript');
set local role service_role;
`;
for (const item of execution.items) {
  const gate = item.gate;
  sql += `select public.record_prompt_evidence(${q(runId)},${q(item.questionId)},${j(gate.promptEvidence)},${q(gate.promptEvidenceHash)},${j(gate.ledger)},${j(gate.funnel)});\n`;
  for (const arm of ['no_research','research']) {
    const result = item.arms[arm];
    const records = result.attempts.length ? result.attempts : [null];
    for (let i=0;i<records.length;i++) {
      const holder=randomUUID(), a=records[i], last=i===records.length-1;
      const attempt=a ? {...a, attemptId:randomUUID(), requestKey:holder} : null;
      const claims=a?.evaluation.status !== 'failed' ? (a?.evaluation.claims ?? []) : [];
      sql += `select public.lease_arm(${q(owner)},${q(runId)},${q(item.questionId)},${q(arm)},${q(holder)});\n`;
      sql += `select public.finalize_arm_result(${q(runId)},${q(item.questionId)},${q(arm)},${q(holder)},${attempt ? j(attempt) : 'null'},${j(claims)},${q(last ? result.state : 'pending')},${last && result.state==='done' ? q(attempt.attemptId) : 'null'},null);\n`;
    }
  }
}
const population=execution.items.flatMap(i=>i.gate.ledger.filter(d=>d.decision==='kept').map(d=>({questionId:d.questionId,evidenceId:d.evidenceId})));
const sample=createAuditSample(runId,fixture.version.versionHash,population,100,14);
sql += `reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',${q(owner)},true);
select pg_temp.require(public.finalize_run(${q(runId)})='completed','replay finishes');
select public.create_audit_sample(${q(runId)},100,14) as sample_id \\gset
select pg_temp.require((select jsonb_agg(jsonb_build_array(question_key,evidence_key) order by position) from public.audit_sample_items where sample_id=:'sample_id')=${j(sample.items.map(i=>[i.questionId,i.evidenceId]))},'SQL and engine sample parity');
select pg_temp.require((select count(*)=0 from public.provider_attempts),'replay has zero provider charges');
reset role;
do $$ begin
  begin
    insert into public.run_claim_decisions(attempt_id,run_id,question_key,dataset_version_id,user_id,claim_index,claim_text,evidence_key,start_offset,end_offset,content_hash,verdict,supported_evidence_key)
    select attempt_id,run_id,question_key,dataset_version_id,user_id,15,'invented',evidence_key,0,1,content_hash,'supported',supported_evidence_key
    from public.run_claim_decisions where run_id=${q(runId)} and question_key='q6' and verdict='supported' limit 1;
    raise exception 'invalid astral span was accepted';
  exception when sqlstate 'PT409' then null;
  end;
end $$;
select 'S14_DATABASE_REGRESSION_PASS';
`;
const output=docker(['exec','-i',container,'psql','-U','postgres','-d',database,'-X','-1','-v','ON_ERROR_STOP=1','-q'],sql);
if (!output.includes('S14_DATABASE_REGRESSION_PASS')) throw Error('Missing completion marker');
console.log('S14_DATABASE_REGRESSION_PASS: migrations, RLS A/B, replay, zero charges, UTF-16 spans and mixed-Unicode audit parity.');
