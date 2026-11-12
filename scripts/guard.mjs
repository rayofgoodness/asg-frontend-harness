// PreToolUse guard for task-harness.
// While a task is active (.harness/ACTIVE exists) in the session that started it:
// - only the `implementer` subagent may change the main checkout (files and `git add`/`git commit` on the feature branch);
//   the orchestrator and the other agents may write only under .harness/;
// - commands that move or rewrite history (checkout, reset, rebase, merge, stash, ...) are blocked for everyone,
//   the plugin's own scripts do that work;
// - repo-wide lint/format scripts and dependency changes are blocked;
// - destructive git commands are blocked everywhere; push and MR/PR changes always ask the user.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, relative, isAbsolute, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readMeta } from './meta.mjs'

const STALE_MS = 24 * 60 * 60 * 1000
const win = process.platform === 'win32'

let input = {}
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const tool = input.tool_name || ''
const ti = input.tool_input || {}
const isShell = tool === 'Bash' || tool === 'PowerShell'
const command = isShell ? String(ti.command || '') : ''
// Subagent tool calls carry agent_type (e.g. "task-harness:implementer"); the main session has none.
const isImplementer = /(^|:)implementer$/.test(String(input.agent_type || ''))

// Git Bash style /c/Users/... → C:/Users/...
const norm = (p) => {
  let s = String(p).trim().replace(/^["']|["']$/g, '')
  if (win) s = s.replace(/^\/([a-zA-Z])(\/|$)/, (_, d, rest) => `${d.toUpperCase()}:${rest || '/'}`)
  return s
}

const projectDir = resolve(norm(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()))
const harnessDir = join(projectDir, '.harness')
const activeFile = join(harnessDir, 'ACTIVE')
const sessionFile = join(harnessDir, 'SESSION')

// `harness.mjs init` is about to start a task: remember which session owns it.
if (isShell && /harness\.(?:mjs|sh)["']?\s+init\b/.test(command) && input.session_id) {
  try {
    mkdirSync(harnessDir, { recursive: true })
    writeFileSync(sessionFile, String(input.session_id))
  } catch {}
}

if (!existsSync(activeFile)) process.exit(0)

// Only the session that started the task is restricted; other sessions work as usual.
const owner = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8').trim() : ''
if (owner && input.session_id && owner !== input.session_id) process.exit(0)

// A forgotten ACTIVE file (aborted run) stops blocking after a day.
try {
  if (Date.now() - statSync(activeFile).mtimeMs > STALE_MS) process.exit(0)
} catch {}

const activeId = (() => {
  try {
    return readFileSync(activeFile, 'utf8').trim()
  } catch {
    return '?'
  }
})()
const scriptsDir = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
const unblockHint = `If the task was aborted, run \`node "${scriptsDir}/harness.mjs" clean ${activeId}\` or \`rm .harness/ACTIVE\`.`

const block = (msg) => {
  process.stderr.write(`task-harness: ${msg}\n${unblockHint}\n`)
  process.exit(2)
}

// Feature branch and base commit of the active task, and the branch checked out now.
const taskMeta = readMeta(join(harnessDir, activeId)) || {}
const featureBranch = taskMeta.branch || ''
const baseSha = taskMeta.base_sha || ''
const currentBranch = (() => {
  try {
    // In a linked worktree .git is a file: "gitdir: <path to the worktree's git dir>".
    let gitDir = join(projectDir, '.git')
    if (statSync(gitDir).isFile()) {
      const g = readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m)
      if (g) gitDir = resolve(projectDir, norm(g[1]))
    }
    const m = readFileSync(join(gitDir, 'HEAD'), 'utf8').match(/^ref: refs\/heads\/(.+)$/m)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
})()

// A linter/formatter belongs to the project when the repo configures it or lists it as a dependency, and it is installed.
// A copy that only sits in node_modules as someone else's dependency does not count.
const CONFIG_FILES = { eslint: /^(eslint\.config\.|\.eslintrc)/, prettier: /^(\.prettierrc|prettier\.config\.)/, stylelint: /^(\.stylelintrc|stylelint\.config\.)/ }
const PKG_KEY = { eslint: 'eslintConfig', prettier: 'prettier', stylelint: 'stylelint' }
const projectUses = (tool) => {
  try {
    if (!existsSync(join(projectDir, 'node_modules', tool))) return false
    let pkg = {}
    try {
      pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
    } catch {}
    if (pkg[PKG_KEY[tool]] || pkg.dependencies?.[tool] || pkg.devDependencies?.[tool]) return true
    return readdirSync(projectDir).some((f) => CONFIG_FILES[tool].test(f))
  } catch {
    return true
  }
}

const gitOpts = { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20000 }

// Command tokens that are existing files inside the project, as repo-relative paths.
const existingFiles = (tokens, dir) => {
  const files = []
  for (const token of tokens.slice(0, 20)) {
    const abs = resolve(dir, norm(token))
    try {
      if (!statSync(abs).isFile()) continue
    } catch {
      continue
    }
    const rel = relative(projectDir, abs).replace(/\\/g, '/')
    if (!rel.startsWith('..') && !isAbsolute(rel)) files.push(rel)
  }
  return files
}

// Start commit of the task that is running now (last line written by `harness.mjs ready ID TASK`).
const taskStart = (() => {
  try {
    const last = readFileSync(join(harnessDir, activeId, 'task-starts.txt'), 'utf8').trim().split(/\r?\n/).pop()
    return last?.split(' ')[1] || ''
  } catch {
    return ''
  }
})()

// true when the file is new, has uncommitted changes, or was committed since the current task started.
// Fails open when git can't answer.
const touchedInTask = (rel) => {
  const status = spawnSync('git', ['status', '--porcelain', '--', rel], gitOpts)
  if (status.status !== 0 || status.stdout.trim()) return true
  if (!taskStart) return false
  const diff = spawnSync('git', ['diff', '--name-only', taskStart, '--', rel], gitOpts)
  return diff.status !== 0 || Boolean(diff.stdout.trim())
}

// Of the given repo-relative files, those that already had ESLint errors at the task's base.
// Fails open: if git or eslint can't answer, nothing is reported.
const filesWithBaseErrors = (files) => {
  const eslintBin = join(projectDir, 'node_modules', 'eslint', 'bin', 'eslint.js')
  if (!baseSha || !existsSync(eslintBin)) return []
  const dirty = []
  for (const rel of files) {
    const source = spawnSync('git', ['show', `${baseSha}:${rel}`], gitOpts)
    if (source.status !== 0) continue // not in base: a file this task created
    const lint = spawnSync(process.execPath, [eslintBin, '--no-warn-ignored', '-f', 'json', '--stdin', '--stdin-filename', rel], { ...gitOpts, input: source.stdout })
    try {
      const errors = JSON.parse(lint.stdout)[0]?.errorCount || 0
      if (errors > 0) dirty.push({ file: rel, errors })
    } catch {}
  }
  return dirty
}

const cmp = (p) => (win ? p.toLowerCase() : p)
// true when the path is inside the main checkout and not under .harness/
const inMainCheckout = (p, base = projectDir) => {
  const abs = resolve(base, norm(p))
  const rel = relative(cmp(projectDir), cmp(abs))
  if (isAbsolute(rel) || rel.startsWith('..')) return false
  return !(rel === '.harness' || rel.startsWith('.harness/') || rel.startsWith('.harness\\'))
}

if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  const p = ti.file_path || ti.notebook_path
  if (p && !isImplementer && inMainCheckout(p, resolve(norm(input.cwd || projectDir)))) {
    block(
      `a task is active. Only the implementer agent changes product files; write your results under .harness/. Blocked: ${relative(projectDir, resolve(norm(p)))}`
    )
  }
  process.exit(0)
}

if (!isShell) process.exit(0)

// Destructive git commands: blocked anywhere.
if (
  /\bgit\s+push\b[^;&|]*(--force|\s-f\b|\s\+\S)/.test(command) ||
  /\bgit\s+reset\s+--hard\b/.test(command) ||
  /\bgit\s+clean\s+-[a-z]*f/i.test(command) ||
  /\bgit\s+branch\s+-D\s+(develop|dev|main|master)\b/.test(command)
) {
  block('destructive git command blocked while a task is active')
}

// Push and MR/PR changes always need the user's explicit OK: force a permission prompt, even in auto mode.
if (
  /\bgit\b[^;&|]*\spush\b/.test(command) ||
  /\bglab(?:\.exe)?["']?\s+mr\s+(create|merge|update|approve|reopen)\b/.test(command) ||
  /\bgh(?:\.exe)?["']?\s+pr\s+(create|merge|edit|ready|reopen)\b/.test(command)
) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'task-harness: push / MR needs your explicit approval'
      }
    })
  )
  process.exit(0)
}

// The plugin's own scripts manage the main checkout (branches, squash, gates): let them through.
if (/(harness\.mjs|gates\.mjs|route\.mjs|risk\.mjs|lint-changed\.mjs)\b/.test(command)) process.exit(0)

// Working directory of the command: a leading cd / Set-Location / pushd, else the tool's cwd.
const cwd = resolve(norm(input.cwd || projectDir))
const cdMatch = command.match(/^\s*(?:cd|Set-Location|sl|pushd|Push-Location)\s+(?:-(?:Literal)?Path\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/i)
const effectiveDir = cdMatch ? resolve(cwd, norm(cdMatch[1])) : cwd
const runsInMain = inMainCheckout(effectiveDir)

// Drop inline scripts and heredoc bodies so "a > b" inside code is not taken for a redirect.
const scan = command
  .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, ' ')
  .replace(/\s-(?:e|c|Command|EncodedCommand)\s+("(?:[^"\\]|\\.)*"|'[^']*')/g, ' ')

if (!isImplementer) {
  // Redirect targets that land in the main checkout.
  const NULL_TARGETS = /^(\/dev\/(null|stdout|stderr)|\$null|nul)$/i
  for (const m of scan.matchAll(/(?:^|[\s;&|(])(?:\d|\*)?>{1,2}\s*(?!&)("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g)) {
    const target = norm(m[1])
    if (!target || NULL_TARGETS.test(target) || target.includes('$')) continue
    if (inMainCheckout(target, effectiveDir)) block(`a task is active. Shell redirect into the main checkout blocked: ${m[0].trim()}`)
  }
}

if (runsInMain) {
  if (!isImplementer) {
    // File operations: allowed when every path argument is under .harness/ or outside the project.
    const FILE_COMMANDS = [
      [/\bsed\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*i/, 'sed -i'],
      [/\bperl\s+-[a-zA-Z]*i/, 'perl -i'],
      [/(?:^|[\s(])tee\s/, 'tee'],
      [/\b(Set-Content|Add-Content|Out-File|Clear-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i, 'PowerShell file cmdlet'],
      [/^\(?\s*(rm|mv|cp|del|erase|move|copy|ren)\s/i, 'file command']
    ]
    const tokens = (s) => s.match(/"[^"]*"|'[^']*'|\S+/g) || []
    for (const segment of scan.split(/\s*(?:&&|\|\||[;&|\n])\s*/)) {
      for (const [re, name] of FILE_COMMANDS) {
        if (!re.test(segment)) continue
        const args = tokens(segment).slice(1).filter((t) => !t.startsWith('-'))
        // Paths with shell variables can't be resolved here: they don't count as main-checkout paths.
        if (args.length && args.every((a) => a.includes('$') || !inMainCheckout(a, effectiveDir))) continue
        block(`a task is active. "${name}" in the main checkout is blocked; only the implementer agent changes product files.`)
      }
    }
    if (/\bgit\s+(commit|add)\b/.test(scan)) {
      block('a task is active. Only the implementer agent commits; the orchestrator uses harness.mjs.')
    }
    if (/\beslint\b[^;&|]*--fix\b/.test(scan) || /\bprettier\b[^;&|]*--write\b/.test(scan) || /\bstylelint\b[^;&|]*--fix\b/.test(scan)) {
      block('a task is active. Formatters with --fix/--write are for the implementer agent only.')
    }
  } else {
    // Implementer: commit only on the feature branch, and only explicit files.
    if (/\bgit\s+commit\b/.test(scan) && featureBranch && currentBranch !== featureBranch) {
      block(`commit blocked: checked out "${currentBranch || 'detached HEAD'}", expected the feature branch "${featureBranch}".`)
    }
    if (/\bgit\s+add\s+(?:[^;&|]*\s)?(-A|--all|\.|:\/)(?=\s|$|[;&|])/.test(scan) || /\bgit\s+commit\b[^;&|]*\s-[a-zA-Z]*a/.test(scan)) {
      block('stage only your task files: `git add <files>` (no -A, ".", or commit -a).')
    }
    // Linters and formatters: only tools the project has installed; with --fix/--write only on files this task changed,
    // and eslint --fix only where it will not reformat errors that were already there at the task's base.
    const WRITE_FLAG = { eslint: '--fix', stylelint: '--fix', prettier: '--write' }
    for (const segment of scan.split(/\s*(?:&&|\|\||[;&|\n])\s*/)) {
      // quoted text with spaces is a message, not a command or a path
      const bare = segment.replace(/"[^"]*"|'[^']*'/g, (q) => (/\s/.test(q) ? ' ' : q))
      const tool = bare.match(/(?:^|[\s\/\\])(eslint|stylelint|prettier)(?:\.cmd)?(?=\s|$)/)?.[1]
      if (!tool) continue
      if (!projectUses(tool)) {
        block(`this project does not use ${tool} (no config, not a dependency, or not installed): do not run or download it.`)
      }
      if (!new RegExp(`\\s${WRITE_FLAG[tool]}\\b`).test(bare)) continue
      const files = existingFiles((bare.match(/"[^"]*"|'[^']*'|\S+/g) || []).filter((t) => !t.startsWith('-')), effectiveDir)
      const untouched = files.filter((rel) => !touchedInTask(rel))
      if (untouched.length) {
        block(`${tool} ${WRITE_FLAG[tool]} only on files you changed in this task. Not changed by you: ${untouched.join(', ')}.`)
      }
      if (tool !== 'eslint') continue
      const dirty = filesWithBaseErrors(files)
      if (dirty.length) {
        block(
          `eslint --fix would reformat lines outside your task: ${dirty.map((x) => `${x.file} (${x.errors} errors already there at base)`).join(', ')}. ` +
            `Fix your own errors by hand; check them with lint-changed.mjs.`
        )
      }
    }
    // Repo-wide formatting: --fix/--write needs explicit file paths.
    if (/\b(eslint|stylelint)\b[^;&|]*--fix\b[^;&|]*(\s\.(?=\s|$|[;&|])|\s\*\*)/.test(scan) || /\bprettier\b[^;&|]*--write\b[^;&|]*(\s\.(?=\s|$|[;&|])|\s\*\*)/.test(scan)) {
      block('run formatters with --fix/--write on your changed files only, not on the whole repo.')
    }
  }

  const WRITE_COMMANDS = [
    [/\bgit\s+(checkout|switch|restore|stash|reset|rebase|cherry-pick|apply|am|rm|mv|revert|pull)\b/, 'git command that changes branches or history'],
    [/\bgit\s+merge\b(?![^;&|]*--abort)/, 'git merge'],
    [/\bgit\s+commit\b[^;&|]*--amend\b/, 'git commit --amend'],
    [/\bvendor\/bin\/pint\b(?![^;&|]*(--test|\.(php)\b))/, 'pint on the whole repo'],
    [/\b(npm|pnpm|yarn)\s+(run\s+)?(lint|format)\b/, 'lint/format script'],
    [/\b(npm|pnpm|yarn)\s+(i|install|ci|add|remove|uninstall|update|upgrade)\b/, 'dependency change'],
    [/\bcomposer\s+(require|remove|update|install)\b/, 'dependency change']
  ]
  for (const [re, name] of WRITE_COMMANDS) {
    if (re.test(scan)) block(`a task is active. "${name}" in the main checkout is blocked.`)
  }
}

process.exit(0)
