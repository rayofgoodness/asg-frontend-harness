// Quality gates for task-harness. Runs the same on macOS, Linux and Windows.
// usage: node gates.mjs [dir] [quick|full] [out-file] [base-sha]
//
// Linters (eslint, stylelint, pint) run only when the project configures them and has them installed, and only on files
// changed since base-sha (or $HARNESS_BASE): without a base sha they are skipped, never run on the whole repo.
// Nothing here fixes or formats files, and nothing is downloaded: a tool that is not installed is a SKIP.
// HARNESS_SKIP="js:eslint,js:build" (comma or space separated, "js:*" for a group) turns gates off temporarily.
// Full logs of failed gates go to <out-file dir>/logs/<gate>.log.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [, , dirArg = '.', mode = 'full', outArg = '', baseArg = ''] = process.argv
const base = baseArg || process.env.HARNESS_BASE || ''
const dir = resolve(dirArg)
const out = outArg && outArg !== '/dev/stdout' ? resolve(outArg) : ''
const logsDir = out ? join(dirname(out), 'logs') : ''
process.chdir(dir)

const lines = []
let failed = false

const skipPatterns = (process.env.HARNESS_SKIP || '')
  .split(/[,\s]+/)
  .filter(Boolean)
  .map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`))
const skippedByEnv = (name) => skipPatterns.some((re) => re.test(name))
const skip = (name, reason) => lines.push(`SKIP ${name}: ${reason}`)

const exists = (p) => existsSync(join(dir, p))
const has = (...names) => names.some(exists)
const pkg = exists('package.json') ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : null
const hasScript = (name) => Boolean(pkg?.scripts?.[name])
// Installed, not just listed: gates never download a tool.
const installed = (name) => exists(`node_modules/${name}/package.json`)
// Path of an installed package's CLI entry, to run it with node directly (no shell, so no quoting of file names).
const binOf = (name, bin = name) => {
  try {
    const p = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'))
    const rel = typeof p.bin === 'string' ? p.bin : p.bin?.[bin]
    return rel ? join(dir, 'node_modules', name, rel) : ''
  } catch {
    return ''
  }
}

// run(name, 'shell command') or run(name, [executable, ...args]) — arrays are spawned without a shell.
const run = (name, command, env = {}) => {
  if (skippedByEnv(name)) return skip(name, 'HARNESS_SKIP')
  const opts = { cwd: dir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, ...env } }
  const r = Array.isArray(command) ? spawnSync(command[0], command.slice(1), opts) : spawnSync(command, { ...opts, shell: true })
  if (r.status === 0) return lines.push(`PASS ${name}`)
  failed = true
  const log = `${r.stdout || ''}${r.stderr || ''}${r.error ? `${r.error.message}\n` : ''}`
  const shown = Array.isArray(command) ? command.join(' ') : command
  lines.push(`FAIL ${name}: ${shown.length > 300 ? `${shown.slice(0, 300)}…` : shown}`)
  if (logsDir) {
    mkdirSync(logsDir, { recursive: true })
    const file = join(logsDir, `${name.replace(/[^a-z0-9]+/gi, '-')}.log`)
    writeFileSync(file, log)
    lines.push(`    full log: ${file}`)
  }
  for (const l of log.trimEnd().split(/\r?\n/).slice(-60)) lines.push(`    ${l}`)
}

// Files changed since base, filtered by pathspecs.
const changed = (...specs) => {
  const r = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', ...specs], { cwd: dir, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : []
}
// A linter over the files this branch changed; skipped without a base sha or without changed files.
const runOnChanged = (name, specs, command) => {
  if (!base) return skip(name, 'no base sha: linters run on changed files only')
  const files = changed(...specs)
  if (!files.length) return skip(name, 'no changed files')
  run(name, [...command, ...files])
}

const pm = exists('yarn.lock') ? 'yarn' : exists('pnpm-lock.yaml') ? 'pnpm' : 'npm'

if (exists('composer.json')) {
  if (exists('vendor/bin/pint')) runOnChanged('php:pint', ['*.php'], ['php', 'vendor/bin/pint', '--test'])
  if (exists('vendor/bin/phpstan')) run('php:phpstan', 'php vendor/bin/phpstan analyse --no-progress --memory-limit=1G')
  if (mode === 'full') {
    if (exists('vendor/bin/pest')) run('php:pest', 'php vendor/bin/pest --compact')
    else if (exists('artisan') && has('phpunit.xml', 'phpunit.xml.dist')) run('php:test', 'php artisan test')
    else if (exists('vendor/bin/phpunit')) run('php:phpunit', 'php vendor/bin/phpunit')
  }
}

if (pkg) {
  // ESLint: only if the project is set up for it, only changed files, only errors the branch introduced (lint-changed.mjs).
  const eslintConfigured = readdirSync(dir).some((f) => /^eslint\.config\.|^\.eslintrc/.test(f)) || Boolean(pkg.eslintConfig)
  if (eslintConfigured && installed('eslint')) {
    runOnChanged('js:eslint', ['*.js', '*.mjs', '*.cjs', '*.ts', '*.mts', '*.cts', '*.jsx', '*.tsx', '*.vue'], [process.execPath, join(here, 'lint-changed.mjs'), base])
  } else if (eslintConfigured) {
    skip('js:eslint', 'eslint is configured but not installed (node_modules/eslint)')
  }

  if (hasScript('typecheck')) run('js:typecheck', `${pm} run typecheck`)
  else if (hasScript('type-check')) run('js:typecheck', `${pm} run type-check`)
  else if (installed('vue-tsc')) run('js:typecheck', installed('nuxt') ? 'npx nuxi typecheck' : 'npx vue-tsc --noEmit')
  else skip('js:typecheck', 'no typecheck script and no vue-tsc')

  const stylelintConfigured = readdirSync(dir).some((f) => /^(\.stylelintrc|stylelint\.config\.)/.test(f)) || Boolean(pkg.stylelint)
  const stylelintBin = stylelintConfigured ? binOf('stylelint') : ''
  if (stylelintBin) runOnChanged('css:stylelint', ['*.css', '*.scss', '*.vue'], [process.execPath, stylelintBin, '--allow-empty-input'])

  if (mode === 'full') {
    if (installed('vitest')) run('js:vitest', 'npx vitest run --passWithNoTests --exclude ".harness/**"')
    else if (hasScript('test')) run('js:test', `${pm} run test`, { CI: '1' })
    if (hasScript('build')) run('js:build', `${pm} run build`)
  }
}

if (!lines.length) lines.push('SKIP no gates detected')
const text = `${lines.join('\n')}\n`
process.stdout.write(text)
if (out) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
}
process.exit(failed ? 1 : 0)
