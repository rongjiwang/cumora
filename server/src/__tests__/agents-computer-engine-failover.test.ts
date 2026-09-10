/**
 * A capped Codex must hand the turn to a healthy Claude subscription rather
 * than pausing the agent for fifteen minutes, and must take it back once it is
 * paid up. The classification half matters as much as the switch: the wording
 * OpenAI uses for "no credit" matched none of OPERATOR_FIX_RE, so a drained
 * workspace read as `transient` and kept spinning.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  benchEngine,
  classifyTurnOutcome,
  engineFailoverPool,
  needsOperatorFix,
  resetEngineBenches,
  resolveAvailableEngine,
  unbenchEngine,
} from '../agents/computer/daemon.js'

// Verbatim from `cumora agent computer --doctor` against a capped workspace.
const CODEX_SPEND_CAP =
  'ERROR: You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.'

const INSTALLED = ['codex', 'claude'] as const

test('a capped Codex workspace is an operator fix, not a transient failure', () => {
  assert.equal(needsOperatorFix(CODEX_SPEND_CAP), true)
  assert.equal(classifyTurnOutcome(CODEX_SPEND_CAP), 'operator-fix')
  // The cases upstream already covered must keep their existing verdicts.
  assert.equal(classifyTurnOutcome('not logged in'), 'operator-fix')
  assert.equal(classifyTurnOutcome('credit balance is too low'), 'operator-fix')
  // Precedence is load-bearing: a throttle that also says quota stays a
  // throttle, so it keeps the short self-clearing cooldown and never benches.
  assert.equal(classifyTurnOutcome('429 insufficient quota'), 'rate-limited')
  // An ordinary crash must still retry rather than stop the agent.
  assert.equal(classifyTurnOutcome('process exited with code 1'), 'transient')
  assert.equal(classifyTurnOutcome(null), 'ok')
})

test('benching the primary re-homes agents onto the other engine, and back', () => {
  unbenchEngine('codex')
  const available = [...INSTALLED]

  // Healthy: the agent's assigned engine wins.
  assert.equal(resolveAvailableEngine('codex', engineFailoverPool(available)), 'codex')

  // Benched: syncOnce now resolves 'codex' to claude even though the server
  // still assigns codex, so the next wake runs on the working subscription.
  benchEngine('codex')
  assert.deepEqual(engineFailoverPool(available), ['claude'])
  assert.equal(resolveAvailableEngine('codex', engineFailoverPool(available)), 'claude')

  // A clean turn reclaims the primary.
  unbenchEngine('codex')
  assert.equal(resolveAvailableEngine('codex', engineFailoverPool(available)), 'codex')
})

test('the bench expires on its own', () => {
  unbenchEngine('codex')
  const now = Date.now()
  benchEngine('codex', now)
  assert.deepEqual(engineFailoverPool([...INSTALLED], now + 1_000), ['claude'])
  assert.deepEqual(engineFailoverPool([...INSTALLED], now + 31 * 60_000), ['codex', 'claude'])
  unbenchEngine('codex')
})

test('with every engine benched the pool stays full rather than empty', () => {
  // An empty pool makes resolveAvailableEngine return null, which stops every
  // runner on the computer — the wrong answer for one account-wide outage.
  const now = Date.now()
  benchEngine('codex', now)
  benchEngine('claude', now)
  assert.deepEqual(engineFailoverPool([...INSTALLED], now + 1_000), ['codex', 'claude'])
  assert.equal(resolveAvailableEngine('codex', engineFailoverPool([...INSTALLED], now + 1_000)), 'codex')
  unbenchEngine('codex')
  unbenchEngine('claude')
})

test('a lone installed engine never fails over to nothing', () => {
  const now = Date.now()
  benchEngine('claude', now)
  assert.deepEqual(engineFailoverPool(['claude'], now + 1_000), ['claude'])
  unbenchEngine('claude')
})

// The oscillation this prevents was observed live: a capped Codex benched at
// 09:35, expired at 10:05, took all five agents back, failed at 10:22 and
// benched again — a dead spawn, a new operator notice, and a cold-started
// Claude session every cycle.
test('consecutive failures escalate the bench instead of oscillating', () => {
  resetEngineBenches()
  const t = Date.now()

  benchEngine('codex', t)                                    // 1st → 30min
  assert.deepEqual(engineFailoverPool(INSTALLED, t + 29 * 60_000), ['claude'])
  assert.deepEqual(engineFailoverPool(INSTALLED, t + 31 * 60_000), ['codex', 'claude'])

  benchEngine('codex', t)                                    // 2nd → 1h
  assert.deepEqual(engineFailoverPool(INSTALLED, t + 59 * 60_000), ['claude'])
  assert.deepEqual(engineFailoverPool(INSTALLED, t + 61 * 60_000), ['codex', 'claude'])

  benchEngine('codex', t)                                    // 3rd → 2h
  assert.deepEqual(engineFailoverPool(INSTALLED, t + 119 * 60_000), ['claude'])

  resetEngineBenches()
})

test('the escalation is capped, and a clean turn resets it', () => {
  resetEngineBenches()
  const t = Date.now()
  for (let i = 0; i < 12; i++) benchEngine('codex', t)
  // Capped at 8h, not 30min * 2^11 (= ~426h).
  assert.deepEqual(engineFailoverPool(INSTALLED, t + 8 * 60 * 60_000 + 1_000), ['codex', 'claude'])

  // Funded again: one clean turn drops the streak, so the NEXT unrelated
  // failure starts from the short window rather than the cap.
  unbenchEngine('codex')
  benchEngine('codex', t)
  assert.deepEqual(engineFailoverPool(INSTALLED, t + 31 * 60_000), ['codex', 'claude'])
  resetEngineBenches()
})
