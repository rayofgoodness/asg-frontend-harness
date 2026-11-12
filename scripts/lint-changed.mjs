// ESLint with a baseline: only errors the branch introduced fail.
// usage: node lint-changed.mjs <base-sha> <file>...   (run from the repo root, never fixes anything)
//
// An error counts when
//   - it sits on a line added or changed since <base-sha> (committed or not), or the file is new;
//   - or it is a fatal/parse error;
//   - or it sits elsewhere, but the file has more errors of that rule than it had at <base-sha>
//     (e.g. the change removed the last use of a variable declared on an untouched line).
// Errors that were already in the file at <base-sha> are counted and ignored.
// exit: 0 clean, 1 new errors, 2 could not run eslint.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, relative } from 'node:path'

const [, , base, ...files] = process.argv
if (!base || !files.length) {
  process.stderr.write('usage: node lint-changed.mjs <base-sha> <file>...\n')
  process.exit(64)
}

const MAX_PRINTED = 40
const root = process.cwd()
const eslintBin = resolve(root, 'node_modules/eslint/bin/eslint.js')
if (!existsSync(eslintBin)) {
  process.stderr.write('INFRA: node_modules/eslint not found; install dependencies first\n')
  process.exit(2)
}

const git = (args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const eslint = (args, input) => {
  const r = spawnSync(process.execPath, [eslintBin, '--no-warn-ignored', '-f', 'json', ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024
  })
  try {
    return JSON.parse(r.stdout)
  } catch {
    process.stderr.write(`INFRA: eslint did not produce a report (exit ${r.status})\n${(r.stderr || r.stdout || '').slice(0, 4000)}\n`)
    process.exit(2)
  }
}
const slash = (p) => p.replace(/\\/g, '/')

// new path → old path, for files renamed since base
const renames = new Map()
for (const line of git(['diff', '-M', '--name-status', base]).stdout.split('\n')) {
  const [status, from, to] = line.split('\t')
  if (status?.startsWith('R') && from && to) renames.set(to, from)
}

const inBase = (path) => git(['cat-file', '-e', `${base}:${path}`]).status === 0

// Line ranges of the current file that were added or changed since base; null = the whole file is new.
const changedRanges = (file) => {
  const old = renames.get(file) || file
  if (!inBase(old)) return null
  const paths = old === file ? [file] : [old, file]
  const ranges = []
  for (const m of git(['diff', '-M', '-U0', base, '--', ...paths]).stdout.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count > 0) ranges.push([start, start + count - 1])
  }
  return ranges
}

const errorsOf = (result) => (result?.messages || []).filter((m) => m.severity === 2)
const countByRule = (messages) => {
  const counts = {}
  for (const m of messages) counts[m.ruleId || 'fatal'] = (counts[m.ruleId || 'fatal'] || 0) + 1
  return counts
}

const present = files.map(slash).filter((f) => existsSync(resolve(root, f)))
if (!present.length) {
  process.stdout.write('lint-changed: no files to check\n')
  process.exit(0)
}

const report = eslint(present)
const fresh = []
let preexisting = 0

for (const result of report) {
  const file = slash(relative(root, result.filePath))
  const errors = errorsOf(result)
  if (!errors.length) continue

  const ranges = changedRanges(file)
  const onDiff = (m) => ranges === null || ranges.some(([a, b]) => (m.endLine || m.line) >= a && m.line <= b)
  const mine = errors.filter((m) => m.fatal || onDiff(m))
  const rest = errors.filter((m) => !mine.includes(m))
  for (const m of mine) fresh.push({ file, m, note: '' })
  if (!rest.length) continue

  // Errors on untouched lines: new only when the rule's count in this file grew since base.
  const old = renames.get(file) || file
  const baseSource = git(['show', `${base}:${old}`]).stdout
  const baseCounts = countByRule(errorsOf(eslint(['--stdin', '--stdin-filename', file], baseSource)[0]))
  const headCounts = countByRule(errors)
  const mineCounts = countByRule(mine)
  for (const m of rest) {
    const rule = m.ruleId || 'fatal'
    const grew = (headCounts[rule] || 0) - (baseCounts[rule] || 0)
    if (grew > (mineCounts[rule] || 0)) {
      fresh.push({ file, m, note: ` [outside changed lines; ${rule}: ${baseCounts[rule] || 0} at base → ${headCounts[rule]} now]` })
    } else {
      preexisting++
    }
  }
}

for (const { file, m, note } of fresh.slice(0, MAX_PRINTED)) {
  process.stdout.write(`${file}:${m.line || 0}:${m.column || 0} ${m.ruleId || 'fatal'} ${m.message}${note}\n`)
}
if (fresh.length > MAX_PRINTED) process.stdout.write(`... and ${fresh.length - MAX_PRINTED} more\n`)
process.stdout.write(
  `lint-changed: ${fresh.length} new error(s) in ${present.length} file(s); ${preexisting} error(s) that were already there at ${base.slice(0, 8)} ignored\n`
)
process.exit(fresh.length ? 1 : 0)
