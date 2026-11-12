// Task metadata: .harness/<ID>/meta.json ({ id, base, branch, base_sha }).
// Runs started before 0.4.0 have meta.env (written by bash `printf %q`) instead; it is still read.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const readMeta = (stateDir) => {
  const jsonPath = join(stateDir, 'meta.json')
  if (existsSync(jsonPath)) {
    try {
      return JSON.parse(readFileSync(jsonPath, 'utf8'))
    } catch {
      return null
    }
  }
  const envPath = join(stateDir, 'meta.env')
  if (!existsSync(envPath)) return null
  const text = readFileSync(envPath, 'utf8')
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'))
    return m ? m[1].trim().replace(/^'(.*)'$/, '$1').replace(/\\(.)/g, '$1') : ''
  }
  return { id: get('ID'), base: get('BASE'), branch: get('BRANCH'), base_sha: get('BASE_SHA') }
}

export const writeMeta = (stateDir, meta) => {
  writeFileSync(join(stateDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
}
