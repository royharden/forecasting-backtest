import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { importManifest, gateForQuestion, marketAsOf } from '../supabase/functions/_shared/engine.ts';
const dir=resolve('.agent-work/normalizer');mkdirSync(dir,{recursive:true});
const example=JSON.parse(readFileSync('README.md','utf8').match(/```json\s*([\s\S]*?)```/)[1]);
function run(input,name) {
  const source=resolve(dir,`${name}-input.json`), output=resolve(dir,`${name}-output.json`);
  writeFileSync(source,JSON.stringify(input));
  const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/prepare-manifest.ts',source,output],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const manifest=JSON.parse(readFileSync(output,'utf8'));
  const imported=importManifest(manifest,new Date().toISOString());
  assert.equal(imported.ok,true,JSON.stringify(imported));
  return {manifest,version:imported.version,stderr:result.stderr};
}
const fixed=run(example,'fixed');
assert.equal(fixed.version.questions[0].cutoffAt,'2024-10-20T00:00:00Z');
assert.equal(fixed.manifest.marketObservations[0].observedAt,'2024-10-19T22:00:00.000Z');
assert.equal(marketAsOf(fixed.version.marketObservations,fixed.version.questions[0].cutoffAt,24).probability,.61);
const scheduled=structuredClone(example);
scheduled.dataset.cutoffPreset='scheduled-midpoint-v1';
scheduled.questions[0].scheduled_close_at='2024-11-05T00:00:00Z';
scheduled.questions[0].scheduled_close_source='Illustrative historical venue revision captured at opening';
delete scheduled.questions[0].cutoff_at;
scheduled.prices[0].observed_at='2024-09-17T18:00:00-04:00';
scheduled.evidence[0].published_at='2024-09-15T09:00:00Z';
scheduled.evidence[0].archived_at='2024-09-15T12:00:00Z';
const midpoint=run(scheduled,'scheduled');
const question=midpoint.version.questions[0];
assert.equal(question.status,'eligible');
// 96-day scheduled lifetime, midpoint is 48 days after August 1; resolution is not used.
assert.equal(question.cutoffAt,'2024-09-18T00:00:00.000Z');
assert.equal(question.evidenceCutoff,'2024-09-17T00:00:00.000Z');
assert.equal(gateForQuestion(midpoint.version,question).promptEvidence.length,1);
const missing=structuredClone(example);
missing.prices[0].observed_at='2024-10-19 18:00';
delete missing.evidence[0].retrieved_at;
const rejected=run(missing,'missing-provenance');
assert.equal(rejected.manifest.marketObservations.length,0);
assert.equal(rejected.manifest.evidence.length,0);
assert.match(rejected.stderr,/REJECT prices\[0\]/);
assert.match(rejected.stderr,/REJECT evidence\[0\]/);
for (const [name, timestamp] of [['calendar-rollover','2024-02-30T18:00:00-04:00'],['hour-rollover','2024-10-19T24:00:00-04:00'],['epoch-overflow',1e30]]) {
  const invalid=structuredClone(example);invalid.prices[0].observed_at=timestamp;
  const result=run(invalid,name);
  assert.equal(result.manifest.marketObservations.length,0,`${name} must not become an invented price date`);
  assert.match(result.stderr,/REJECT prices\[0\]/);
}
console.log('S14_NORMALIZER_PASS: worked fixed and scheduled examples, UTC offset conversion, missing-date/provenance rejection; local illustrative files only.');
