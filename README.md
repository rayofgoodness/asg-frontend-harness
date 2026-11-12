# task-harness

Плагін для Claude Code: посилання на задачу в YouTrack → оцінка → аналіз → план → послідовне виконання підзадач (по одній, у самій гілці задачі) → гейти → ревʼю (scope / conventions / code) → PR.

Як поставити й користуватись — у [GUIDE.md](GUIDE.md). Цей файл описує, як харнес влаштований.

## Встановлення

У Claude Code:

```
/plugin marketplace add git@github.com:rayofgoodness/asg-frontend-harness.git
/plugin install task-harness@local-harness
```

Для розробки самого плагіна замість URL можна дати шлях до локальної копії.

Потрібно: YouTrack MCP, `glab` (GitLab) або `gh` (GitHub) з авторизацією, `node` 18+, `git`, `composer` та/або `pnpm`/`npm`. Скрипти плагіна написані на Node і однаково працюють на macOS, Linux і Windows; bash їм не потрібен. Форж визначається за `origin`, а якщо хост нічого не каже (SSH-аліас) — за `.gitlab-ci.yml` чи `.github/` у репо.

## Git

Правила git з репо (`CLAUDE.md`, `.claude/rules/*`, `CONTRIBUTING.md`) мають пріоритет. Дефолти:
- базова гілка: `develop`/`dev`, якщо є, інакше `origin/HEAD`; перевизначається `--base`;
- гілка задачі: `AMM-123` (без `feature/`); для повернутої задачі `AMM-123#2`;
- коміти: `AMM-123 Short description`, без тіла; кожна підзадача комітить прямо в гілку задачі, перед push усі коміти зводяться в один (`harness.mjs squash`), тож у git лишається тільки гілка задачі з одним комітом;
- MR: заголовок як коміт, для GitLab з `--squash-before-merge --remove-source-branch`.

## Використання

```
/task-harness:task https://youtrack.example.com/issue/AMM-123
/task-harness:task AMM-123 --plan-only
/task-harness:task AMM-123 --auto --base develop
```

Пайплайн зупиняється для підтвердження після плану (крім `--auto`). Push і створення MR — завжди окремі питання до користувача, навіть з `--auto`: без явного «так» харнес не пушить і не створює MR, а лише дає готові команди. Поки задача активна, guard додатково вимагає дозвіл Claude Code на `git push`, `glab mr create|merge|update|approve|reopen` і `gh pr create|merge|edit|ready|reopen`.
Повторний запуск з тим самим ID продовжує з місця зупинки (`.harness/<ID>/state.json`).

## Етапи та моделі

| Етап | Агент | Модель |
|---|---|---|
| Розбір задачі (AC, неясності, посилання) | `intake` | haiku |
| Попередня оцінка складності й ризику по коду | `triage` | sonnet |
| Аналіз коду + остаточна оцінка | `analyst` | sonnet / opus за складністю |
| План і розбиття | `planner` | sonnet / opus |
| Виконання | `implementer`, по одному на підзадачу, строго послідовно | sonnet, opus для складних підзадач |
| Ревʼю обсягу | `scope-guard` | sonnet / opus |
| Ревʼю конвенцій | `conventions-reviewer` | sonnet / opus |
| Ревʼю коректності | `code-reviewer` | opus |

## Як вибираються моделі

Моделі вибирає скрипт `scripts/route.mjs`, а не LLM:
- складність — це **максимум** з оцінок triage і analyst, тож її можна лише підвищити;
- ризик додатково визначає `scripts/risk.mjs` за правилами: шляхи файлів (з triage, analyst і фінального дифу) та ключові слова в задачі (checkout, ціни, залишки, замовлення, синхронізація, міграції, auth тощо);
- ризик `high` підвищує складність на рівень, `medium` не дає задачі лишитися XS;
- аналіз пропускається тільки тоді, коли triage сказав XS і ризик низький;
- якщо після аналізу рівень зріс, аналітик перезапускається на сильнішій моделі;
- перед ревʼю маршрут перераховується вже з фінальним дифом.

Як працюють збіги:
- правило шляху з `/` (`config/`, `routes/api`) шукається як фрагмент шляху від межі сегмента;
- правило без `/` (`cart`, `sync`) має збігтися з цілим токеном шляху (шлях ділиться по `/ . - _` і camelCase), множина `+s`/`+es` теж рахується. Тож `sync` не чіпляє `useAsync.ts`, а `export` не чіпляє `exporter.scss`;
- ключові слова — регулярні вирази без урахування регістру, які мають збігтися з цілим словом у тексті задачі. `склад` не чіпляє «складний»; для основи слова пиши `оплат\\p{L}*`.

Під amm правила можна розширити й звузити файлом `.harness-risk.json` у корені репо:

```json
{
  "high": { "paths": ["app/Services/OneC", "app/Integrations"], "keywords": ["1с", "нова пошта"] },
  "medium": { "paths": ["resources/js/pages/catalog"], "keywords": [] },
  "ignore": {
    "rules": ["import", "api/"],
    "files": ["assets/scss/mixins/"]
  }
}
```

`ignore.rules` прибирає дефолтні правила (точний рядок правила шляху або ключового слова), `ignore.files` — префікси шляхів, які не скануються.

## Як забезпечується «нічого зайвого»

- Planner задає порядок підзадач (`order` у `tasks.json`); одночасно працює лише один implementer, наступний стартує після коміту попереднього.
- Перед кожною підзадачею `harness.mjs ready <ID> <TASK>` перевіряє, що вибрана гілка задачі і немає незакомічених змін, і записує стартовий коміт у `.harness/<ID>/task-starts.txt`.
- Implementer може міняти тільки свої файли; кожне відхилення фіксується у звіті.
- Хук `guard.mjs` (Edit/Write/Bash/PowerShell), поки задача активна. Субагента він розпізнає за полем `agent_type` у вхідних даних хука:
  - змінювати файли проєкту (Edit/Write, редиректи, `sed -i`, `rm`/`mv`/`cp`, `eslint --fix <файли>`) і комітити може лише `implementer`; оркестратор та інші агенти пишуть тільки в `.harness/`;
  - `implementer` комітить лише в гілку задачі і лише явно вказані файли: `git add -A`/`git add .`/`commit -a`/`--amend` заблоковані, як і `--fix`/`--write` на весь репо. `eslint`/`prettier`/`stylelint` блокуються, якщо проєкт ними не користується (нема ні конфігу, ні залежності в `package.json`, або не встановлено; копія в `node_modules` як чужа транзитивна залежність не рахується); з `--fix`/`--write` — якщо файл не змінювався в поточній підзадачі; `eslint --fix <файл>` — ще й якщо файл уже мав помилки eslint на `base_sha`;
  - для всіх заблоковані `checkout`/`switch`/`reset`/`rebase`/`merge`/`stash`/`pull`/`restore`/`cherry-pick`, `npm run lint|format`, встановлення залежностей;
  - деструктивні git-команди (`push --force`, `reset --hard`, `clean -f`) блокуються будь-де.

  Власні скрипти плагіна дозволені. Перевірка shell-команд евристична: це страховка від помилок агентів, а не пісочниця. Шляхи зі змінними (`$VAR`, `$(...)`) хук обчислити не може і пропускає.
- Блокування діє лише в сесії, яка запустила задачу (`.harness/SESSION`), і знімається через `harness.mjs clean <ID>` або автоматично через 24 години після старту. Якщо задача обірвалась, видали `.harness/ACTIVE` або запусти `clean`.
- `scope-guard` перевіряє кожен hunk на відповідність задачі й acceptance criteria і запускається повторно після кожного циклу фіксів.

## Конвенції

`conventions-reviewer` збирає правила з самого репо в такому порядку пріоритету:
`CLAUDE.md` / `.claude/rules` / `CONVENTIONS.md` → конфіги (`pint.json`, `phpstan.neon`, eslint, prettier, stylelint, tsconfig) → патерни сусідніх файлів → скіл `guard-clauses` → дефолти зі скілу `vue-frontend-conventions`.

Скіл `guard-clauses` (`skills/guard-clauses/SKILL.md`) задає стиль нового й зміненого JS/TS/Vue-коду: перевірки на початку функції з негайним `return`/`throw`, основний шлях без обгортки в `if`, без `else` після `return`, вкладеність не глибше 2. Implementer пише в цьому стилі, `conventions-reviewer` перевіряє додані й змінені рядки. Старий код заради цього не переписується; явне правило проєкту чи eslint має пріоритет.
Найкращий спосіб підлаштувати під amm — дописати правила команди в `CLAUDE.md` або `.claude/rules/*.md` у репозиторії.

## Гейти (`scripts/gates.mjs`)

Підхоплює те, що є в проєкті: Pint, PHPStan/Larastan, Pest/PHPUnit, eslint, typecheck (nuxi / vue-tsc), stylelint, vitest, build.

`node gates.mjs <dir> quick|full <out> <base_sha>`:
- лінтери (eslint, stylelint, pint) запускаються, лише якщо проєкт їх використовує: є конфіг (`eslint.config.*`, `.stylelintrc*`) і інструмент встановлений (`node_modules/<tool>`, `vendor/bin/pint`), і лише на файлах, змінених з `base_sha`. Без `base_sha` вони пропускаються, на весь репо не запускаються ніколи. Нічого не завантажується: інструмента нема — `SKIP`;
- eslint з `base_sha` іде через `scripts/lint-changed.mjs` і валить гейт лише на помилках, які внесла гілка: на доданих чи змінених рядках, у нових файлах, parse-помилках, а також поза зміненими рядками, якщо помилок цього правила у файлі стало більше, ніж було на `base_sha`. Помилки, що вже були у файлі, рахуються й ігноруються. Той самий скрипт запускає implementer перед комітом; `--fix` на файлі зі старими помилками йому заборонений, бо переформатує чужі рядки;
- проєктний скрипт `lint` не запускається взагалі: він лінтить (а з `--fix` і переписує) весь репо;
- повний лог гейта, що впав, лежить у `.harness/<ID>/logs/<gate>.log`, у звіт іде останні 60 рядків;
- typecheck запускається лише якщо є скрипт `typecheck`/`type-check` або встановлений `vue-tsc`;
- vitest запускається з `--passWithNoTests`;
- пропущені перевірки пишуться як `SKIP <name>: <причина>` і не вважаються провалом.

Тимчасово вимкнути перевірки можна змінною `HARNESS_SKIP`: імена через кому або пробіл, `*` як маска (`js:eslint`, `js:eslint,js:build`, `js:*`). Імена: `php:pint`, `php:phpstan`, `php:pest`/`php:test`/`php:phpunit`, `js:lint`/`js:eslint`, `js:typecheck`, `css:stylelint`, `js:vitest`/`js:test`, `js:build`. Для одного проєкту зручно задати її в `.claude/settings.local.json`:

```json
{ "env": { "HARNESS_SKIP": "js:eslint" } }
```

Вимкнені перевірки потрапляють у звіт і в опис MR як `SKIP <name>: HARNESS_SKIP`.

## Артефакти

`.harness/<ID>/` (додається в `.git/info/exclude`, не в `.gitignore`): `issue.md`, `intake.json`, `triage.json`, `analysis.md`, `analysis.json`, `state.json`, `plan.md`, `tasks.json`, `reports/`, `reviews/`, `gates.txt`, `final.diff`, `summary.md`.
## Без worktrees (з 0.2.0)

Підзадачі виконуються по одній прямо в основній папці проєкту, у гілці задачі: без git worktree, без окремих `node_modules`/`.nuxt` і без злиття. До 0.2.0 підзадачі йшли паралельно в `<repo>.worktrees/`; `harness.mjs clean` прибирає такі папки, що лишилися від старих запусків.

Збірка й гейти теж ідуть в основній папці. Якщо там же запущено dev-сервер (`nuxi dev`), збірка може впасти на спільних `.nuxt`/`.output`: зупини dev-сервер на час гейтів.

Якщо vitest/phpunit у репо підхоплює файли з `.harness/`, додай `.harness/**` в exclude їхнього конфігу.
