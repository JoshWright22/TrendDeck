// checks the pure parts of the agent gateway and pipeline: arg validation, redaction,
// policy decisions and the run rules. no electron. run with: npm run test:gateway
import assert from 'node:assert/strict'
import { cleanPolicy, decide, defaultPolicy } from '../src/main/gateway/decide'
import { redact, redactText, REDACTED } from '../src/main/gateway/redact'
import { int, list, obj, oneOf, str, validateArgs } from '../src/main/gateway/validate'
import { advanceRun, applyChanges, defaultStages, diffStages, newRun, PipelineError, setStage, syncRun } from '../src/main/pipeline/model'

let passed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (err) {
    console.error(`FAIL ${name}`)
    throw err
  }
}

// validation
const schema = obj({ ref: int('ref', 1), text: str('text', 10, 1), mode: oneOf('mode', ['a', 'b']), ids: list('ids', str('id'), 2) }, ['ref'])

test('accepts good args and drops nulls', () => {
  const v = validateArgs(schema, { ref: 3, text: 'hi', mode: null })
  assert.deepEqual(v, { ok: true, value: { ref: 3, text: 'hi' } })
})
test('missing args count as {}', () => {
  assert.equal(validateArgs(obj(), undefined).ok, true)
})
test('unknown args are refused with the accepted names', () => {
  const v = validateArgs(schema, { ref: 1, colour: 'red' })
  assert.equal(v.ok, false)
  if (!v.ok) assert.match(v.errors[0], /unknown argument "colour"\. accepted: ref, text, mode, ids/)
})
test('a tool with no args says so', () => {
  const v = validateArgs(obj(), { x: 1 })
  assert.equal(v.ok, false)
  if (!v.ok) assert.match(v.errors[0], /takes no arguments/)
})
test('types, enums, bounds and required are checked, nothing coerced', () => {
  const v = validateArgs(schema, { ref: '3', text: '', mode: 'c', ids: ['a', 'b', 'c'] })
  assert.equal(v.ok, false)
  if (!v.ok) {
    assert.ok(v.errors.some((e) => /ref should be a number/.test(e)))
    assert.ok(v.errors.some((e) => /text can't be empty/.test(e)))
    assert.ok(v.errors.some((e) => /mode should be one of a, b/.test(e)))
    assert.ok(v.errors.some((e) => /ids takes at most 2/.test(e)))
  }
  const missing = validateArgs(schema, {})
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.deepEqual(missing.errors, ['ref is required'])
  const frac = validateArgs(schema, { ref: 1.5 })
  assert.equal(frac.ok, false)
})
test('nested objects are strict too', () => {
  const s = obj({ stage: obj({ label: str('l') }, ['label']) })
  const v = validateArgs(s, { stage: { label: 'x', extra: 1 } })
  assert.equal(v.ok, false)
  if (!v.ok) assert.match(v.errors[0], /unknown argument "extra" in stage/)
})
test('a non object is refused', () => {
  assert.equal(validateArgs(schema, [1]).ok, false)
  assert.equal(validateArgs(schema, 'x').ok, false)
})

// redaction
test('secret keys are blanked, booleans stay', () => {
  const out = redact({ password: 'hunter22', apiKey: 'abc12345', hasPassword: true, cookie: 'sid=1', name: 'ok', nested: { refresh_token: 'r' }, tiktokToken: '' })
  assert.deepEqual(out, { password: REDACTED, apiKey: REDACTED, hasPassword: true, cookie: REDACTED, name: 'ok', nested: { refresh_token: REDACTED }, tiktokToken: '' })
})
test('secret shapes in text are scrubbed', () => {
  const t = redactText(
    [
      'Authorization: Bearer abcdefghijklmnop',
      'Cookie: sessionid=xyz; csrftoken=abc',
      'key sk-ant-abcdefghijklmnopqrstuv',
      'aws AKIAABCDEFGHIJKLMNOP',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'g AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'url https://x.com/cb?code=abc123&state=ok&access_token=zzz',
      'password = "p@ss w0rd"',
      'token 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    ].join('\n')
  )
  for (const leak of ['abcdefghijklmnop', 'sessionid=xyz', 'sk-ant-', 'AKIAABCD', 'ghp_', 'AIzaSy', 'eyJhbGci', 'code=abc123', 'access_token=zzz', 'p@ss', '0123456789abcdef0123']) {
    assert.ok(!t.includes(leak), `leaked ${leak}: ${t}`)
  }
  assert.ok(t.includes('state=ok'))
})
test('uuids and normal text stay', () => {
  const s = 'media 3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b is ready, 1200 views'
  assert.equal(redactText(s), s)
})
test('known values are scrubbed anywhere, url encoded too', () => {
  const t = redactText('logged in with Tr0ub4dor&3 and ?p=Tr0ub4dor%263', ['Tr0ub4dor&3'])
  assert.ok(!t.includes('Tr0ub4dor'))
})

// policy
const tool = (name: string, risk: 'read' | 'edit' | 'publish' | 'spend', alwaysAsk = false) => ({ name, risk, alwaysAsk })
test('defaults: read and edit run, publish and spend ask', () => {
  const p = defaultPolicy('b1')
  assert.equal(decide(p, tool('a', 'read')), 'auto')
  assert.equal(decide(p, tool('a', 'edit')), 'auto')
  assert.equal(decide(p, tool('a', 'publish')), 'ask')
  assert.equal(decide(p, tool('a', 'spend')), 'ask')
})
test('tool rules win over risk, deny wins over everything', () => {
  const p = cleanPolicy('b1', { risks: { edit: 'ask' }, tools: { request_post: 'auto', click: 'deny', pipeline_propose_change: 'auto' } })
  assert.equal(decide(p, tool('draft_create', 'edit')), 'ask')
  assert.equal(decide(p, tool('request_post', 'publish')), 'auto')
  assert.equal(decide(p, tool('click', 'edit'), new Set(['click'])), 'deny')
  assert.equal(decide(p, tool('pipeline_propose_change', 'edit', true)), 'ask')
})
test('allowed for this turn skips the ask, but not always ask or must ask', () => {
  const p = defaultPolicy('b1')
  assert.equal(decide(p, tool('request_post', 'publish'), new Set(['request_post'])), 'auto')
  assert.equal(decide(p, tool('x', 'edit', true), new Set(['x'])), 'ask')
  assert.equal(decide(p, tool('run_advance_stage', 'edit'), new Set(['run_advance_stage']), true), 'ask')
})
test('bad policy input is cleaned', () => {
  const p = cleanPolicy('b1', { risks: { read: 'nope', publish: 'auto' }, tools: { 'Bad Name': 'auto', ok_tool: 'maybe' }, approvalTimeoutSec: 1 })
  assert.equal(p.risks.read, 'auto')
  assert.equal(p.risks.publish, 'auto')
  assert.deepEqual(p.tools, {})
  assert.equal(p.approvalTimeoutSec, 15)
})

// pipeline
test('a new run starts at the first stage', () => {
  const stages = defaultStages()
  const r = newRun('r1', 'b1', stages, { title: 'x' }, 1)
  assert.equal(r.currentStageId, 'research')
  assert.equal(r.stageStates.research.status, 'running')
  assert.equal(r.stageStates.publish.status, 'pending')
})
test('advance finishes the stage and starts the next', () => {
  const stages = defaultStages()
  let r = newRun('r1', 'b1', stages, {}, 1)
  r = advanceRun(r, stages, { notes: 'found 3', artifacts: ['idea-1'] }, 2)
  assert.equal(r.stageStates.research.status, 'done')
  assert.deepEqual(r.stageStates.research.artifacts, ['idea-1'])
  assert.equal(r.currentStageId, 'ideate')
  assert.equal(r.stageStates.ideate.status, 'running')
  r = advanceRun(r, stages, { skip: true }, 3)
  assert.equal(r.stageStates.ideate.status, 'skipped')
  r = advanceRun(r, stages, { toStageId: 'research' }, 4)
  assert.equal(r.currentStageId, 'research')
  assert.equal(r.stageStates.research.status, 'running')
})
test('setting a stage running makes it current, finishing the last ends the run', () => {
  const stages = defaultStages().slice(0, 2)
  let r = newRun('r1', 'b1', stages, {}, 1)
  r = setStage(r, stages, 'ideate', { status: 'running' }, 2)
  assert.equal(r.currentStageId, 'ideate')
  r = setStage(r, stages, 'ideate', { status: 'done' }, 3)
  assert.equal(r.currentStageId, 'research')
  r = advanceRun(r, stages, {}, 4)
  assert.equal(r.currentStageId, null)
  assert.throws(() => advanceRun(r, stages), PipelineError)
  assert.throws(() => setStage(r, stages, 'nope', { status: 'done' }), PipelineError)
})
test('changes apply in order and show as a diff', () => {
  const before = defaultStages()
  const after = applyChanges(before, [
    { op: 'add', stage: { label: 'Thumbnail', kind: 'produce', workspace: 'media', config: { size: '1280x720' }, auto: false }, index: 4 },
    { op: 'remove', stageId: 'engage' },
    { op: 'move', stageId: 'analyze', index: 0 },
    { op: 'configure', stageId: 'publish', patch: { auto: true, config: { platforms: 'youtube,tiktok' } } }
  ])
  assert.equal(after[0].id, 'analyze')
  assert.equal(after.find((s) => s.id === 'thumbnail')?.workspace, 'media')
  assert.ok(!after.some((s) => s.id === 'engage'))
  assert.equal(after.find((s) => s.id === 'publish')?.auto, true)
  const lines = diffStages(before, after)
  const kinds = Object.fromEntries(lines.map((l) => [l.stageId, l.kind]))
  assert.equal(kinds.thumbnail, 'added')
  assert.equal(kinds.engage, 'removed')
  assert.equal(kinds.analyze, 'moved')
  assert.equal(kinds.publish, 'changed')
  assert.equal(kinds.script, 'same')
  assert.equal(lines.length, before.length + 1)
})
test('bad changes are refused', () => {
  const s = defaultStages()
  assert.throws(() => applyChanges(s, [{ op: 'remove', stageId: 'nope' }]), PipelineError)
  assert.throws(() => applyChanges(s.slice(0, 1), [{ op: 'remove', stageId: 'research' }]), /at least one stage/)
  assert.throws(() => applyChanges(s, [{ op: 'configure', stageId: 'research', patch: { label: '' } }]), PipelineError)
})
test('adding a stage with a taken id gets a new one', () => {
  const after = applyChanges(defaultStages(), [{ op: 'add', stage: { label: 'Research', kind: 'research', workspace: 'trends', config: {}, auto: true } }])
  assert.equal(after[after.length - 1].id, 'research-2')
})
test('runs follow the pipeline when stages change', () => {
  const stages = defaultStages()
  const r = newRun('r1', 'b1', stages, {}, 1)
  const fewer = stages.filter((s) => s.id !== 'research')
  const synced = syncRun(r, fewer)
  assert.equal(synced.currentStageId, 'ideate')
  assert.ok(synced.stageStates.research, 'old state kept')
})

console.log(`gateway tests: ${passed} passed`)
