import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const [, , stateDir, repoRoot = process.cwd()] = process.argv
if (!stateDir) {
  process.stderr.write('usage: node risk.mjs <.harness/ID> [repoRoot]\n')
  process.exit(64)
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const readJson = (p) => {
  try {
    return JSON.parse(read(p) || 'null')
  } catch {
    return null
  }
}

// Path rules:
// - with "/" → matched as a path fragment starting at a segment boundary ("config/" hits "config/app.php", "nuxt.config.ts" does not);
// - without "/" → matched as a whole token of the path; tokens come from splitting on / . - _ and camelCase
//   ("cart" hits "components/cart/cart-item.vue", "sync" does not hit "useAsync.ts", "export" does not hit "exporter.scss").
//   Plural forms (+s / +es) also match.
// Keyword rules: case-insensitive regex matched as a whole word in the issue text
// ("склад" does not hit "складний"; use "оплат\\p{L}*" to match a stem).
const defaults = {
  high: {
    paths: [
      'checkout', 'cart', 'basket', 'order', 'payment', 'invoice', 'refund',
      'price', 'pricing', 'discount', 'coupon', 'promo', 'stock', 'inventory', 'warehouse',
      'sync', 'import', 'export', 'feed', 'auth', 'login', 'password', 'permission', 'policy', 'policies',
      'database/migrations', 'migrations/', 'config/', 'routes/api', 'webhook', 'cron', 'kernel', 'jobs/', 'queue'
    ],
    keywords: [
      'checkout', 'payments?', 'refunds?', 'prices?', 'pricing', 'stock', 'migrations?', 'auth', 'authori[sz]ation',
      'webhooks?', 'sync', 'synchroni[sz]ation', 'imports?',
      'оплат\\p{L}*', 'замовлен\\p{L}*', 'цін(?:а|и|у|ою|і|ах|ами)?', 'цінов\\p{L}*', 'знижк\\p{L}*', 'промокод\\p{L}*',
      'залишок', 'залишк\\p{L}*', 'склад(?:у|і|ом|и|ів|ах)?', 'складськ\\p{L}*', 'кошик\\p{L}*',
      'синхрон\\p{L}*', 'імпорт\\p{L}*', 'вивантаж\\p{L}*', 'міграц\\p{L}*', 'авториз\\p{L}*',
      'доступ(?:у|ом|и|ів)?', 'плат[іе]ж\\p{L}*', 'повернен\\p{L}* (?:коштів|грошей|товар\\p{L}*)'
    ]
  },
  medium: {
    paths: ['search', 'filter', 'catalog', 'seo', 'sitemap', 'cache', 'resources/', 'api/'],
    keywords: ['пошук\\p{L}*', 'фільтр\\p{L}*', 'каталог\\p{L}*', 'seo', 'кеш\\p{L}*', 'api']
  }
}

// .harness-risk.json:
// {
//   "high":   { "paths": [], "keywords": [] },          // added to defaults
//   "medium": { "paths": [], "keywords": [] },
//   "ignore": {
//     "rules": ["import", "api/"],                       // default rules (paths or keywords, exact string) to drop
//     "files": ["assets/scss/mixins/"]                   // file path prefixes never scanned
//   }
// }
const custom = readJson(resolve(repoRoot, '.harness-risk.json')) || {}
const ignoredRules = new Set((custom.ignore?.rules || []).map((r) => String(r).toLowerCase()))
const ignoredFiles = (custom.ignore?.files || []).map((f) => String(f).toLowerCase().replace(/\\/g, '/'))
const keep = (r) => !ignoredRules.has(String(r).toLowerCase())

const rules = {}
for (const level of ['high', 'medium']) {
  rules[level] = {
    paths: [...defaults[level].paths.filter(keep), ...(custom[level]?.paths || [])],
    keywords: [...defaults[level].keywords.filter(keep), ...(custom[level]?.keywords || [])]
  }
}

const tokensOf = (file) =>
  file
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\/\\._\-\s]+/)
    .filter(Boolean)

const pathMatches = (rule, file, tokens) => {
  const r = rule.toLowerCase()
  if (r.includes('/')) return `/${file.toLowerCase()}`.includes(`/${r.replace(/^\//, '')}`)
  return tokens.some((t) => t === r || t === `${r}s` || t === `${r}es`)
}

const keywordRegex = (k) => {
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${k})(?![\\p{L}\\p{N}_])`, 'iu')
  } catch {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu')
  }
}

const issueText = read(resolve(stateDir, 'issue.md'))
const analysis = readJson(resolve(stateDir, 'analysis.json'))
const triage = readJson(resolve(stateDir, 'triage.json'))
const finalFiles = read(resolve(stateDir, 'final.files'))
  .split('\n')
  .map((l) => l.split('\t').pop().trim())
  .filter(Boolean)
const files = [...new Set([...(analysis?.files || []), ...(triage?.likely_files || []), ...finalFiles])]
  .map((f) => String(f).replace(/\\/g, '/'))
  .filter((f) => !ignoredFiles.some((p) => f.toLowerCase().startsWith(p)))
  .map((f) => ({ file: f, tokens: tokensOf(f) }))

const hits = { high: [], medium: [] }
for (const level of ['high', 'medium']) {
  for (const p of rules[level].paths) {
    const f = files.find((x) => pathMatches(p, x.file, x.tokens))
    if (f) hits[level].push(`path:${p} → ${f.file}`)
  }
  for (const k of rules[level].keywords) {
    const m = issueText.match(keywordRegex(k))
    if (m) hits[level].push(`keyword:${k} → "${m[0]}"`)
  }
}

const risk = hits.high.length ? 'high' : hits.medium.length ? 'medium' : 'low'
const result = { risk, hits, source: files.length ? 'issue+files' : 'issue' }
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
