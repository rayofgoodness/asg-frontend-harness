// Branch and state management for task-harness. Runs the same on macOS, Linux and Windows (needs only node and git).
// usage: node harness.mjs {init ID [BASE] [BRANCH]|base ID|forge|ready ID [TASK]|changed ID TASK|diff ID|squash ID MSG|clean ID}
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { readMeta, writeMeta } from './meta.mjs'

const [, , cmd, ...args] = process.argv

const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}
const USAGE = 'usage: harness.mjs {init ID [BASE] [BRANCH]|base ID|forge|ready ID [TASK]|changed ID TASK|diff ID|squash ID MSG|clean ID}'

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
if (top.status !== 0) die('ERROR: not inside a git repository')
const root = resolve(top.stdout.trim())

const run = (argv) => spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
// stdout of a git command that must succeed
const git = (...argv) => {
  const r = run(argv)
  if (r.status !== 0) die(`ERROR: git ${argv.join(' ')}\n${(r.stderr || '').trim()}`)
  return r.stdout
}
const gitOk = (...argv) => run(argv).status === 0
// trimmed stdout, or '' when the command fails
const gitTry = (...argv) => {
  const r = run(argv)
  return r.status === 0 ? r.stdout.trim() : ''
}

const stateDir = (id) => join(root, '.harness', id)
const need = (value, name) => value || die(`ERROR: ${name} is required\n${USAGE}`, 64)
const meta = (id) => readMeta(stateDir(id)) || die(`ERROR: no task state for '${id}' (run init first)`)
const hasRef = (ref) => gitOk('show-ref', '--verify', '--quiet', ref)
const dirty = () => git('status', '--porcelain', '--untracked-files=no').trim()

// Integration branch first (develop/dev), then origin/HEAD, then main/master.
const detectBase = () => {
  for (const c of ['develop', 'dev']) {
    if (hasRef(`refs/remotes/origin/${c}`) || hasRef(`refs/heads/${c}`)) return c
  }
  const head = gitTry('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '')
  if (head) return head
  for (const c of ['main', 'master']) if (hasRef(`refs/heads/${c}`)) return c
  return 'main'
}

// By the origin URL; when the host says nothing (an SSH alias), by what the repo itself contains.
const detectForge = () => {
  const url = gitTry('remote', 'get-url', 'origin').toLowerCase()
  if (url.includes('github')) return 'github'
  if (url.includes('gitlab')) return 'gitlab'
  if (existsSync(join(root, '.gitlab-ci.yml'))) return 'gitlab'
  if (existsSync(join(root, '.github'))) return 'github'
  return 'unknown'
}

// Worktrees left by runs before 0.2.0 (tasks ran in parallel worktrees then).
const removeLegacyWorktrees = (id) => {
  const sibling = join(dirname(root), `${basename(root)}.worktrees`)
  for (const parent of [sibling, join(root, '.harness', 'worktrees')]) {
    if (!existsSync(parent)) continue
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(`${id}-`)) continue
      const wt = join(parent, name)
      run(['worktree', 'remove', '--force', wt])
      try {
        rmSync(wt, { recursive: true, force: true })
      } catch {
        process.stderr.write(`WARN: could not remove ${wt} (files in use?)\n`)
      }
    }
  }
  run(['worktree', 'prune'])
  try {
    rmdirSync(sibling)
  } catch {}
}

switch (cmd) {
  case 'init': {
    // init ID [BASE] [BRANCH]; BRANCH defaults to the bare ID (e.g. AMM-123, or AMM-123#2 for a reopened ticket)
    const id = need(args[0], 'ID')
    let base = args[1] || detectBase()
    let branch = args[2] || id
    if (dirty()) die('ERROR: working tree has uncommitted changes')
    // --git-path also works in a linked worktree, where .git is a file
    const exclude = resolve(root, git('rev-parse', '--git-path', 'info/exclude').trim())
    mkdirSync(dirname(exclude), { recursive: true })
    const excluded = existsSync(exclude) ? readFileSync(exclude, 'utf8').split(/\r?\n/) : []
    if (!excluded.includes('.harness/')) appendFileSync(exclude, `${excluded.length && excluded.at(-1) !== '' ? '\n' : ''}.harness/\n`)
    const sd = stateDir(id)
    mkdirSync(join(sd, 'reports'), { recursive: true })
    mkdirSync(join(sd, 'reviews'), { recursive: true })
    // Resume: keep the branch and base recorded on the first run
    const saved = readMeta(sd)
    if (saved) {
      base = saved.base
      branch = saved.branch
    }
    run(['fetch', '--quiet', 'origin', base])
    const start = hasRef(`refs/remotes/origin/${base}`) ? `origin/${base}` : base
    // Branch off the base without tracking it: the upstream must be origin/<branch> (set by `push -u`)
    if (hasRef(`refs/heads/${branch}`)) git('checkout', '--quiet', branch)
    else git('checkout', '--quiet', '--no-track', '-b', branch, start)
    if (gitTry('rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`) !== `origin/${branch}`) {
      if (hasRef(`refs/remotes/origin/${branch}`)) run(['branch', '--quiet', '-u', `origin/${branch}`, branch])
      else run(['branch', '--quiet', '--unset-upstream', branch])
    }
    const m = saved || { id, base, branch, base_sha: git('rev-parse', start).trim() }
    if (!existsSync(join(sd, 'meta.json'))) writeMeta(sd, m)
    writeFileSync(join(root, '.harness', 'ACTIVE'), `${id}\n`)
    console.log(`branch=${m.branch} base=${m.base} base_sha=${m.base_sha} forge=${detectForge()} state=${sd}`)
    break
  }
  case 'base':
    console.log(meta(need(args[0], 'ID')).base_sha)
    break
  case 'forge':
    console.log(detectForge())
    break
  case 'ready': {
    // ready ID [TASK]: before a task starts: on the feature branch, nothing uncommitted. Prints HEAD (the task's start point).
    const id = need(args[0], 'ID')
    const task = args[1]
    const m = meta(id)
    const cur = gitTry('symbolic-ref', '--quiet', '--short', 'HEAD') || 'DETACHED'
    if (cur !== m.branch) die(`ERROR: on '${cur}', expected '${m.branch}'`)
    if (dirty()) die(`ERROR: uncommitted changes on ${m.branch}:\n${git('status', '--short', '--untracked-files=no').trimEnd()}`)
    const head = git('rev-parse', '--short', 'HEAD').trim()
    if (task) appendFileSync(join(stateDir(id), 'task-starts.txt'), `${task} ${head}\n`)
    console.log(`READY ${m.branch} ${head}`)
    break
  }
  case 'changed': {
    // changed ID TASK: files committed since the task's start point recorded by `ready ID TASK`
    const id = need(args[0], 'ID')
    const task = need(args[1], 'TASK')
    meta(id)
    const file = join(stateDir(id), 'task-starts.txt')
    const starts = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
    const start = starts.map((l) => l.split(' ')).filter(([t, sha]) => t === task && sha).pop()?.[1]
    if (!start) die(`ERROR: no start recorded for task '${task}'`)
    process.stdout.write(git('diff', '--name-only', `${start}..HEAD`))
    break
  }
  case 'squash': {
    // squash ID "<ID> <Description>": collapse the branch into one commit on top of base_sha
    const id = need(args[0], 'ID')
    const msg = need(args[1], 'MSG')
    const m = meta(id)
    git('checkout', '--quiet', m.branch)
    if (dirty()) die('ERROR: working tree has uncommitted changes')
    if (git('rev-list', '--count', `${m.base_sha}..${m.branch}`).trim() === '0') {
      console.log('NOTHING_TO_SQUASH')
      process.exit(1)
    }
    git('reset', '--quiet', '--soft', m.base_sha)
    git('commit', '--quiet', '-m', msg)
    console.log(`SQUASHED ${git('rev-parse', '--short', 'HEAD').trim()} ${msg}`)
    break
  }
  case 'diff': {
    const id = need(args[0], 'ID')
    const m = meta(id)
    const sd = stateDir(id)
    const range = `${m.base_sha}...${m.branch}`
    writeFileSync(join(sd, 'final.diff'), git('diff', range))
    const stat = git('diff', '--stat', range)
    writeFileSync(join(sd, 'final.stat'), stat)
    writeFileSync(join(sd, 'final.files'), git('diff', '--name-status', range))
    process.stdout.write(stat)
    break
  }
  case 'clean': {
    const id = need(args[0], 'ID')
    removeLegacyWorktrees(id)
    // Branches left by old runs
    for (const b of git('for-each-ref', '--format=%(refname:short)', `refs/heads/harness/${id}/`).split('\n').filter(Boolean)) {
      run(['branch', '-D', '--quiet', b])
    }
    rmSync(join(root, '.harness', 'ACTIVE'), { force: true })
    rmSync(join(root, '.harness', 'SESSION'), { force: true })
    console.log(`cleaned ${id}`)
    break
  }
  default:
    die(USAGE, 64)
}
