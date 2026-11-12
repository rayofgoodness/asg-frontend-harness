import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const [, , stateDir, repoRoot = process.cwd()] = process.argv
if (!stateDir) {
  process.stderr.write('usage: node route.mjs <.harness/ID> [repoRoot]\n')
  process.exit(64)
}

const here = dirname(fileURLToPath(import.meta.url))
const readJson = (p) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
  } catch {
    return null
  }
}

const order = ['XS', 'S', 'M', 'L', 'XL']
const riskOrder = ['low', 'medium', 'high']
const statePath = resolve(stateDir, 'state.json')
const state = readJson(statePath) || {}

const triage = readJson(resolve(stateDir, 'triage.json'))
const analysis = readJson(resolve(stateDir, 'analysis.json'))
const det = JSON.parse(execFileSync('node', [resolve(here, 'risk.mjs'), stateDir, repoRoot], { encoding: 'utf8' }))

const estimates = [state.routing?.complexity, triage?.complexity, analysis?.complexity].filter((c) => order.includes(c))
const complexity = estimates.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'XS')

const risks = [state.routing?.risk, triage?.risk, analysis?.risk, det.risk].filter((r) => riskOrder.includes(r))
const risk = risks.reduce((a, b) => (riskOrder.indexOf(b) > riskOrder.indexOf(a) ? b : a), 'low')

let effective = complexity
if (risk === 'high' && effective !== 'XL') effective = order[Math.min(order.indexOf(effective) + 1, 3)]
if (risk === 'medium' && effective === 'XS') effective = 'S'

const table = {
  XS: { analyst: null, planner: null, implementer: { S: 'sonnet', M: 'sonnet', L: 'sonnet' }, reviewers: 'sonnet', codeReviewer: false },
  S: { analyst: 'sonnet', planner: 'sonnet', implementer: { S: 'sonnet', M: 'sonnet', L: 'opus' }, reviewers: 'sonnet', codeReviewer: true },
  M: { analyst: 'opus', planner: 'opus', implementer: { S: 'sonnet', M: 'sonnet', L: 'opus' }, reviewers: 'opus', codeReviewer: true },
  L: { analyst: 'opus', planner: 'opus', implementer: { S: 'sonnet', M: 'opus', L: 'opus' }, reviewers: 'opus', codeReviewer: true },
  XL: { split: true }
}

const prev = state.routing?.effective
const routing = {
  complexity,
  risk,
  effective,
  estimates: { triage: triage?.complexity ?? null, analysis: analysis?.complexity ?? null },
  risk_hits: det.hits,
  skip_analysis: effective === 'XS',
  ...table[effective]
}
const upgraded = Boolean(prev && order.indexOf(effective) > order.indexOf(prev))

writeFileSync(statePath, JSON.stringify({ ...state, routing }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ ...routing, upgraded, previous: prev ?? null }, null, 2) + '\n')
