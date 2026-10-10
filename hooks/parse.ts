/**
 * Pure helpers: no `$`, so they can live in their own file and be unit-tested.
 */

export type LogEntry = { time: string; env: string; level: string; message: string; detail: string[] }
export type LogState = { entries: LogEntry[]; partial: string }
export type WorkerEvent = { time: string; job: string; status: 'RUNNING' | 'DONE' | 'FAIL'; duration?: string }

export const MAX_LOG_ENTRIES = 500
const MAX_DETAIL_LINES = 80
export const ERROR_LEVELS = ['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']
export const WARNING_LEVELS = ['WARNING', 'NOTICE']

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

/** Split "make:model Post -m --force" into argv, keeping quoted strings together. */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/**
 * The token artisan treats as the command name: the first one that isn't an option, as Symfony's
 * `getFirstArgument` picks it (`-q migrate:fresh` runs migrate:fresh). Undefined when there is none.
 */
export function artisanCommandName(argv: string[]): string | undefined {
  return argv.find(token => !token.startsWith('-'))
}

/**
 * The tokens in `argv` that set one of `refused` (`--force`, `-f`): long options alone or as
 * `--force=…`, short ones alone or inside a group like `-mf`.
 */
export function refusedOptions(argv: string[], refused: string[]): string[] {
  return argv.filter(token => {
    if (token.startsWith('--')) return refused.includes(token.split('=')[0]!)
    if (token.startsWith('-')) return [...token.slice(1)].some(c => refused.includes('-' + c))
    return false
  })
}

/** The command name in `artisan help <name> --format=json` output, which may follow PHP warnings. */
export function helpName(stdout: string): string | undefined {
  try {
    const name = (JSON.parse(stdout.slice(stdout.indexOf('{'))) as { name?: unknown }).name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

export function tail(text: string, max = 8000): string {
  return text.length > max ? '…' + text.slice(-max) : text
}

/** `App\Jobs\SendInvoice` → `SendInvoice`, `App\Http\Controllers\X@y` → `X@y`. */
export function shortClass(name: string): string {
  return name.replace(/^App\\(Jobs|Listeners|Mail|Notifications|Http\\Controllers)\\/, '')
}

// ─── storage/logs/*.log ────────────────────────────────────────────────────

const LOG_HEADER = /^\[(\d{4}-\d\d-\d\d[ T][^\]]+)\] ([\w-]+)\.([A-Z]+): ?(.*)$/

export function newLogState(): LogState {
  return { entries: [], partial: '' }
}

/** Feed raw text from the log; returns the entries that started in it. */
export function feedLog(state: LogState, text: string): LogEntry[] {
  const lines = (state.partial + stripAnsi(text)).split('\n')
  state.partial = lines.pop() ?? ''
  const started: LogEntry[] = []
  for (const line of lines) {
    const m = line.match(LOG_HEADER)
    if (m) {
      const entry: LogEntry = { time: m[1] ?? '', env: m[2] ?? '', level: m[3] ?? '', message: m[4] ?? '', detail: [] }
      state.entries.push(entry)
      started.push(entry)
    } else if (state.entries.length && line.trim() !== '') {
      const last = state.entries[state.entries.length - 1]
      if (last && last.detail.length < MAX_DETAIL_LINES) last.detail.push(line)
    }
  }
  if (state.entries.length > MAX_LOG_ENTRIES) state.entries.splice(0, state.entries.length - MAX_LOG_ENTRIES)
  return started
}

export function isError(entry: LogEntry): boolean {
  return ERROR_LEVELS.includes(entry.level)
}

export function isWarning(entry: LogEntry): boolean {
  return WARNING_LEVELS.includes(entry.level)
}

/** The message without the trailing JSON context Laravel appends. */
export function headline(entry: LogEntry): string {
  const cut = entry.message.search(/ \{"|\s\[\]\s*$/)
  return (cut > 0 ? entry.message.slice(0, cut) : entry.message).trim()
}

/** A path relative to the project: strips `root` when given, else guesses from the usual Laravel folders. */
export function projectPath(path: string, root = ''): string {
  if (root && path.startsWith(root.replace(/[\/\\]$/, '') + '/')) return path.slice(root.replace(/[\/\\]$/, '').length + 1)
  return path.replace(/^.*?[\/\\](app|bootstrap|config|database|resources|routes|src|tests|vendor|storage)[\/\\]/, '$1/')
}

/**
 * Where an exception happened, e.g. `app/Models/User.php:42`. When it was thrown
 * inside vendor/, the first stack frame in the project's own code is more useful.
 */
export function origin(entry: LogEntry, root = ''): string | undefined {
  const m = entry.message.match(/ at (\/[^\s)]+?|[A-Z]:\\[^\s)]+?):(\d+)\)/)
  if (!m) return undefined
  const thrown = `${projectPath(m[1] ?? '', root)}:${m[2]}`
  if (!thrown.startsWith('vendor/')) return thrown
  for (const line of entry.detail) {
    const frame = line.match(/^#\d+ (\S+?)\((\d+)\):/)
    if (frame && !/[\/\\]vendor[\/\\]/.test(frame[1] ?? '')) return `${projectPath(frame[1] ?? '', root)}:${frame[2]}`
  }
  return thrown
}

/** One entry as text for Claude: header, origin, and the first stack lines. */
export function formatEntry(entry: LogEntry, stackLines = 15, root = ''): string {
  const where = origin(entry, root)
  const prefix = root ? root.replace(/[\/\\]$/, '') + '/' : ''
  const stack = entry.detail
    .filter(l => /^#\d+ /.test(l))
    .slice(0, stackLines)
    .map(l => (prefix ? l.split(prefix).join('') : l))
  return [`[${entry.time}] ${entry.level}: ${headline(entry)}`, where ? `  at ${where}` : '', ...stack.map(l => '  ' + l)]
    .filter(Boolean)
    .join('\n')
}

/** The time of day of a log timestamp: `2026-10-10 08:01:02` → `08:01:02`. */
export function clock(time: string): string {
  return time.match(/(\d\d:\d\d:\d\d)/)?.[1] ?? time
}

// ─── queue:work output ─────────────────────────────────────────────────────

const WORKER_LINE = /^\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(\S+)\s*\.*\s*(?:([\d.,]+\s?(?:ms|s|m))\s+)?(RUNNING|DONE|FAIL)\s*$/

/** A `queue:work` line such as `2026-10-10 08:00:01 App\Jobs\Foo .... 23.45ms DONE`. */
export function parseWorkerLine(line: string): WorkerEvent | undefined {
  const m = stripAnsi(line).match(WORKER_LINE)
  if (!m) return undefined
  return { time: m[1] ?? '', job: m[2] ?? '', status: m[4] as WorkerEvent['status'], duration: m[3]?.replace(/\s/g, '') }
}

/** `23.45ms` / `1.2s` / `2m` → milliseconds. */
export function durationMs(duration: string | undefined): number | undefined {
  const m = duration?.match(/^([\d.,]+)(ms|s|m)$/)
  if (!m) return undefined
  const n = Number((m[1] ?? '').replace(',', ''))
  return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60_000
}

/** The `--queue=a,b` names in a worker's argv. */
export function queuesOf(argv: string[]): string[] {
  const flag = argv.find(a => a.startsWith('--queue='))
  return flag ? flag.slice('--queue='.length).split(',').filter(q => /^[\w:.-]+$/.test(q)) : []
}

// ─── Queue snapshot (failed jobs, sizes) ───────────────────────────────────

export type FailedJob = { id: string; queue: string; job: string; failedAt: string; exception: string }
export type QueueSnapshot = {
  connection: string
  sizes: Record<string, number>
  failedTotal: number
  failed: FailedJob[]
  error?: string
}

/** PHP run with `php -r` from the project root: boots the app and prints the queue state as JSON. */
export function snapshotPhp(queues: string[]): string {
  const list = queues.filter(q => /^[\w:.-]+$/.test(q)).map(q => `'${q}'`).join(',')
  return `
require 'vendor/autoload.php';
$app = require 'bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$c = config('queue.default');
$queues = [${list}];
if (!$queues) $queues = [config("queue.connections.$c.queue") ?: 'default'];
$out = ['connection' => $c, 'sizes' => [], 'failedTotal' => 0, 'failed' => []];
foreach ($queues as $q) { try { $out['sizes'][$q] = Illuminate\\Support\\Facades\\Queue::connection($c)->size($q); } catch (Throwable $e) { $out['error'] = $e->getMessage(); } }
try {
  $all = app('queue.failer')->all();
  $out['failedTotal'] = count($all);
  foreach (array_slice($all, 0, 25) as $f) {
    $f = (array) $f;
    $p = json_decode($f['payload'] ?? '{}', true) ?: [];
    $out['failed'][] = ['id' => (string) ($f['uuid'] ?? $f['id'] ?? ''), 'queue' => (string) ($f['queue'] ?? ''), 'job' => (string) ($p['displayName'] ?? '?'), 'failedAt' => (string) ($f['failed_at'] ?? ''), 'exception' => mb_substr((string) ($f['exception'] ?? ''), 0, 4000)];
  }
} catch (Throwable $e) { $out['error'] = $e->getMessage(); }
echo json_encode($out);
`
}

/** Read the JSON from the snapshot's output, skipping any PHP warnings printed before it. */
export function parseSnapshot(stdout: string): QueueSnapshot | undefined {
  const start = stdout.indexOf('{"connection"')
  if (start < 0) return undefined
  try {
    return JSON.parse(stdout.slice(start)) as QueueSnapshot
  } catch {
    return undefined
  }
}

/** First line of a stored exception, e.g. `RuntimeException: Payment gateway down in /app/...:12`. */
export function exceptionHeadline(exception: string): string {
  return (exception.split('\n')[0] ?? '').replace(/^.*?\\(\w+(Exception|Error)):/, '$1:').slice(0, 300)
}

// ─── Health checks ─────────────────────────────────────────────────────────

type ComposerPackage = { name: string; version: string }

/**
 * Packages whose installed version differs from composer.lock (changed, missing, or installed but no longer
 * locked). `installedJson` is vendor/composer/installed.json: an object in Composer 2, a list in Composer 1.
 */
export function composerDrift(lockJson: string, installedJson: string): string[] {
  const lock = JSON.parse(lockJson) as { packages?: ComposerPackage[]; 'packages-dev'?: ComposerPackage[] }
  const installed = JSON.parse(installedJson) as { packages?: ComposerPackage[]; dev?: boolean } | ComposerPackage[]
  const list = Array.isArray(installed) ? installed : (installed.packages ?? [])
  // `composer install --no-dev` leaves the dev packages out on purpose
  const dev = Array.isArray(installed) || installed.dev !== false
  const want = new Map([...(lock.packages ?? []), ...(dev ? (lock['packages-dev'] ?? []) : [])].map(p => [p.name, p.version]))
  const have = new Map(list.map(p => [p.name, p.version]))
  return [...new Set([...want.keys(), ...have.keys()])].filter(name => want.get(name) !== have.get(name)).sort()
}

type NpmEntry = { version?: string; optional?: boolean; devOptional?: boolean; dev?: boolean }

/**
 * Packages whose installed version differs from package-lock.json, read from npm's own record of what it
 * installed (node_modules/.package-lock.json). Not counted as missing: optional packages (other platforms'
 * builds are never installed), dev packages after `npm install --omit=dev`, and workspace packages, which
 * live outside node_modules.
 */
export function npmDrift(lockJson: string, installedJson: string): string[] {
  const lock = (JSON.parse(lockJson) as { packages?: Record<string, NpmEntry> }).packages ?? {}
  const have = (JSON.parse(installedJson) as { packages?: Record<string, NpmEntry> }).packages ?? {}
  const deps = Object.entries(lock).filter(([path]) => path.includes('node_modules/'))
  // An install that left out every dev package did so on purpose
  const omitDev = deps.some(([, e]) => e.dev) && !deps.some(([path, e]) => e.dev && path in have)
  const out = new Set<string>()
  for (const [path, entry] of deps) {
    const got = have[path]
    if (got) {
      if (got.version !== entry.version) out.add(path)
    } else if (!entry.optional && !entry.devOptional && !(omitDev && entry.dev)) out.add(path)
  }
  for (const path of Object.keys(have)) if (path.includes('node_modules/') && !(path in lock)) out.add(path)
  return [...out].map(path => path.replace(/^.*node_modules\//, '')).sort()
}

/**
 * The origin in public/hot when it's a dev server on this machine (localhost, a loopback address, or a
 * `.test`/`.localhost` host), else undefined: the mod only ever probes local servers.
 */
export function localHotUrl(text: string): string | undefined {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const local = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host) || host.endsWith('.test') || host.endsWith('.localhost')
  return local ? url.origin : undefined
}

export type HerdService = { type: string; name: string; port: number; version: string }

/**
 * Herd's installed services (MySQL, Redis…) from its services.plist, converted to JSON: type, name, port
 * and version only. An entry without a plain type or a valid port is left out; unreadable JSON is none.
 */
export function herdServices(json: string): HerdService[] {
  let list: unknown
  try {
    list = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list.flatMap((s: Record<string, unknown>) => {
    const port = Number(s?.port)
    if (typeof s?.type !== 'string' || !/^[a-z0-9]+$/.test(s.type) || !Number.isInteger(port) || port < 1 || port > 65535) return []
    return [{ type: s.type, name: typeof s.name === 'string' ? s.name : s.type, port, version: typeof s.version === 'string' ? s.version : '' }]
  })
}

/**
 * PHP run with `php -r` from the project root: the driver and port of each server on this machine that the
 * app's default database, cache, queue, session, broadcasting and Scout config connect to. Loads config without
 * booting providers, so a server that's down can't stop it. Only those two values leave PHP: no credentials,
 * usernames, URLs or remote hostnames ever reach the mod or Claude.
 */
export function connectionsPhp(): string {
  return `
require 'vendor/autoload.php';
$app = require 'bootstrap/app.php';
$app->bootstrapWith([Illuminate\\Foundation\\Bootstrap\\LoadEnvironmentVariables::class, Illuminate\\Foundation\\Bootstrap\\LoadConfiguration::class]);
$out = [];
$add = function ($use, $driver, $c, $port) use (&$out) {
  if (!is_array($c) || !is_string($driver)) return;
  $host = $c['host'] ?? '127.0.0.1';
  if (is_array($host)) $host = reset($host);
  $port = $c['port'] ?? $port;
  // A URL (DB_URL, REDIS_URL, Meilisearch's host) wins; only its host and port are kept
  $url = !empty($c['url']) && is_string($c['url']) ? $c['url'] : (is_string($host) && str_contains($host, '://') ? $host : null);
  if ($url) { $u = parse_url($url) ?: []; $host = $u['host'] ?? ''; $port = $u['port'] ?? $port; }
  $host = trim((string) $host, '[]');
  if (!in_array($host, ['127.0.0.1', 'localhost', '::1'], true) || !is_numeric($port)) return;
  $out[] = ['use' => $use, 'driver' => $driver, 'port' => (int) $port];
};
$redis = fn ($use, $name) => $add($use, 'redis', config('database.redis.' . ($name ?: 'default')), 6379);
$db = config('database.connections.' . config('database.default'));
$add('database', $db['driver'] ?? null, $db, ['mysql' => 3306, 'mariadb' => 3306, 'pgsql' => 5432, 'mongodb' => 27017][$db['driver'] ?? ''] ?? null);
$cache = config('cache.stores.' . config('cache.default'));
if (($cache['driver'] ?? '') === 'redis') $redis('cache', $cache['connection'] ?? null);
$queue = config('queue.connections.' . config('queue.default'));
if (($queue['driver'] ?? '') === 'redis') $redis('queue', $queue['connection'] ?? null);
if (config('session.driver') === 'redis') $redis('session', config('session.connection'));
$cast = config('broadcasting.connections.' . config('broadcasting.default'));
if (($cast['driver'] ?? '') === 'reverb') $add('broadcasting', 'reverb', $cast['options'] ?? null, 8080);
if (config('scout.driver') === 'meilisearch') $add('scout', 'meilisearch', config('scout.meilisearch'), 7700);
if (config('scout.driver') === 'typesense') $add('scout', 'typesense', config('scout.typesense.client-settings.nodes.0'), 8108);
echo json_encode(['connections' => $out]);
`
}

export type AppConnection = { use: string; driver: string; port: number }

/** Read connectionsPhp's JSON, skipping any PHP warnings printed before it; undefined when there's none. */
export function parseConnections(stdout: string): AppConnection[] | undefined {
  const start = stdout.indexOf('{"connections"')
  if (start < 0) return undefined
  let list: unknown
  try {
    list = (JSON.parse(stdout.slice(start)) as { connections?: unknown }).connections
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  return list.flatMap((c: Record<string, unknown>) =>
    typeof c?.use === 'string' && typeof c.driver === 'string' && Number.isInteger(c.port) ? [{ use: c.use, driver: c.driver, port: c.port as number }] : [],
  )
}

/** The Herd service types that can serve each driver. */
const DRIVER_SERVICES: Record<string, string[]> = {
  mysql: ['mysql', 'mariadb'],
  mariadb: ['mariadb', 'mysql'],
  pgsql: ['postgresql'],
  mongodb: ['mongodb'],
  redis: ['redis'],
  reverb: ['reverb'],
  meilisearch: ['meilisearch'],
  typesense: ['typesense'],
}

/**
 * The Herd services the app connects to: one of the right type on the port the app's config names, with what
 * uses it, e.g. `{ service: Redis…, driver: 'redis', uses: ['cache', 'queue'] }`. A server on a port no Herd
 * service of that type has is someone else's (Docker, DBngin) and is left out.
 */
export function herdNeeds<T extends HerdService>(connections: AppConnection[], installed: T[]): { service: T; driver: string; uses: string[] }[] {
  const out = new Map<T, { service: T; driver: string; uses: string[] }>()
  for (const c of connections) {
    const service = installed.find(s => s.port === c.port && DRIVER_SERVICES[c.driver]?.includes(s.type))
    if (!service) continue
    const entry = out.get(service) ?? { service, driver: c.driver, uses: [] }
    if (!entry.uses.includes(c.use)) entry.uses.push(c.use)
    out.set(service, entry)
  }
  return [...out.values()]
}

// ─── Redaction: what goes to Claude ────────────────────────────────────────

/** Key names whose value is a secret: `password=…`, `"api_key": "…"`, `'token' => '…'`. */
const SECRET_KEY = String.raw`[\w.-]*(?:passw(?:or)?d|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authorization|credentials?|cookie|signature|dsn)[\w.-]*`
const KEY_VALUE = new RegExp(String.raw`(["']?)(${SECRET_KEY})\1(\s*(?:=>|[:=])\s*)(?:"[^"]*"|'[^']*'|[^\s,;&)}\]]+)`, 'gi')

/** A stack frame's arguments, `Foo->bar('secret', Array)`, cut to `Foo->bar(...)`. */
function frameWithoutArgs(line: string): string {
  return line.replace(/^(\s*#\d+ .*?: [^(]*)\((.+)\)\s*$/, '$1(...)')
}

/**
 * Values in an SQL error. Laravel puts the bindings into the SQL unquoted, so they can't be told apart: the
 * statement is kept up to `where`, `values`, `set` or `having` (table and columns) and the rest cut. In the
 * driver's own message, quoted strings that aren't identifiers and Postgres' `Key (email)=(…)` are hidden.
 */
function sqlWithoutValues(line: string): string {
  if (!/SQLSTATE|SQL: /.test(line)) return line
  const at = line.indexOf('SQL: ')
  const message = (at < 0 ? line : line.slice(0, at))
    .replace(/'((?:[^'\\]|\\.)*)'/g, (all, inner: string) => (/^[a-z_][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(inner) ? all : "'?'"))
    .replace(/\)=\([^)]*\)/g, ')=(?)')
  if (at < 0) return message
  const sql = line.slice(at)
  const cut = sql.search(/\s(where|values|set|having)\s/i)
  return message + (cut < 0 ? sql : sql.slice(0, cut) + sql.slice(cut).replace(/^(\s\w+)[\s\S]*$/, '$1 …)'))
}

/**
 * Hide what looks confidential in log entries, exceptions and command output before they go to Claude:
 * passwords, tokens and keys by name, credentials in URLs, bearer tokens, email addresses, SQL values,
 * stack frame arguments, and long random strings. Best effort: it can't know every secret, so callers
 * still ask before sending log and exception text.
 */
export function redact(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const out = /^\s*#\d+ /.test(line) ? frameWithoutArgs(line) : line
      return sqlWithoutValues(out)
    })
    .join('\n')
    .replace(/\b([a-z][\w+.-]*:\/\/)[^\s\/@:]*:[^\s\/@]*@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|Basic|Token)\s+[\w~+\/.=-]{8,}/g, '$1 [redacted]')
    .replace(KEY_VALUE, '$1$2$1$3[redacted]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/(?<![\w\/\\.-])(?=[\w+=-]*[A-Z])(?=[\w+=-]*[a-z])(?=[\w+=-]*\d)[\w+=-]{32,}/g, '[redacted]')
    .replace(/\b[a-f0-9]{40,}\b/g, '[redacted]')
}

// ─── Test runs ─────────────────────────────────────────────────────────────

export type TestFailure = { name: string; detail: string[] }
export type TestRun = { passed: number; failed: number; skipped: number; failures: TestFailure[] }

/**
 * A command that runs the test suite: `php artisan test`, `pest` or `phpunit` (bare or in vendor/bin), or
 * `composer test`. Not `phpunit.xml` or a package named `pestphp/pest`.
 */
export function isTestCommand(command: string): boolean {
  return /\bartisan\s+test(\s|$)|(^|[\s;&|(]|vendor\/bin\/)(pest|phpunit)(\s|$)|\bcomposer\s+(run(-script)?\s+)?test(\s|$)/.test(command)
}

/**
 * The result of a test run from its output: `artisan test` and Pest (`Tests: 2 failed, 30 passed`), or
 * PHPUnit (`OK (32 tests…)`, `Tests: 32, Assertions: 80, Failures: 2.`), with each failure's name and its
 * message. Undefined when the output has no summary (the run didn't finish, or isn't a test run).
 */
export function parseTestRun(output: string): TestRun | undefined {
  const lines = output.split('\n').map(l => l.replace(/\s+$/, ''))
  const count = (text: string, word: RegExp) => Number(text.match(new RegExp(String.raw`(\d+)\s+${word.source}`, 'i'))?.[1] ?? 0)
  let run: TestRun | undefined
  const collision = [...lines].reverse().find(l => /^\s*Tests:\s+\d+\s+\w/.test(l))
  const phpunit = [...lines].reverse().find(l => /^\s*Tests:\s+\d+,/.test(l))
  const ok = [...lines].reverse().find(l => /^OK \(\d+ tests?/.test(l))
  if (collision) {
    const skipped = ['skipped', 'incomplete', 'todos?', 'risky'].reduce((n, w) => n + count(collision, new RegExp(w)), 0)
    run = { passed: count(collision, /passed/), failed: count(collision, /failed/) + count(collision, /errors?/), skipped, failures: [] }
  } else if (phpunit) {
    const field = (name: string) => Number(phpunit.match(new RegExp(`${name}: (\\d+)`))?.[1] ?? 0)
    const failed = field('Failures') + field('Errors')
    const skipped = field('Skipped') + field('Incomplete')
    run = { passed: Math.max(0, field('Tests') - failed - skipped), failed, skipped, failures: [] }
  } else if (ok) {
    run = { passed: Number(ok.match(/\((\d+)/)![1]), failed: 0, skipped: 0, failures: [] }
  }
  if (!run) return undefined

  // Collision/Pest: `FAILED  Tests\Feature\OrderTest > it creates an order`. PHPUnit: `1) Tests\…::test_x`, but
  // only in its failure and error lists, not the numbered lists of skipped, risky or deprecated tests
  let listing = false
  const header = (l: string) => l.match(/^\s*(?:FAILED|ERROR)\s+(\S.*)$/)?.[1] ?? (listing ? l.match(/^\d+\) (\S.*)$/)?.[1] : undefined)
  const end = (l: string) => /^\s*Tests:\s+\d/.test(l) || /^(FAILURES!|ERRORS!|OK\b|There (was|were) \d+)/.test(l)
  let current: TestFailure | undefined
  for (const l of lines) {
    if (/^There (was|were) \d+ /.test(l)) listing = /^There (was|were) \d+ (failure|error)s?:/.test(l)
    const name = header(l)
    if (name) {
      current = { name: name.trim(), detail: [] }
      run.failures.push(current)
    } else if (current && end(l)) current = undefined
    else if (current && current.detail.length < 30 && (l.trim() || current.detail.length)) current.detail.push(l.trim() ? l.replace(/^ {2}/, '') : '')
  }
  for (const f of run.failures) while (f.detail.length && !f.detail.at(-1)!.trim()) f.detail.pop()
  return run
}

// ─── Herd debug session ────────────────────────────────────────────────────

/**
 * What Herd's `dumps stop debug` returned, and a count per kind for the Services tab: `12 queries, 3 logs`
 * for an object of lists, or by each entry's `type` for a list. Text that isn't JSON is kept as text.
 */
export function parseDebugCapture(stdout: string): { data: unknown; summary: string } {
  const text = stdout.trim()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { data: text, summary: text ? `${text.length} characters captured` : 'nothing captured' }
  }
  const counts = new Map<string, number>()
  if (Array.isArray(data)) {
    for (const entry of data) {
      const kind = entry && typeof entry === 'object' && typeof (entry as { type?: unknown }).type === 'string' ? (entry as { type: string }).type : 'entries'
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
  } else if (data && typeof data === 'object') {
    for (const [kind, value] of Object.entries(data)) if (Array.isArray(value) && value.length) counts.set(kind, value.length)
  }
  return { data, summary: [...counts].map(([kind, n]) => `${n} ${kind}`).join(', ') || 'nothing captured' }
}

/** Keys whose whole value is withheld from Claude in captured data: bound values, headers, cookies, bodies. */
const WITHHELD_KEY = new RegExp(String.raw`^(bindings|headers|cookies?|session|payload|body|request_?body|response_?body|${SECRET_KEY})$`, 'i')

/** Captured data for Claude: values under WITHHELD_KEY replaced, and every string passed through redact(). */
export function redactData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value)
  if (value === null || typeof value !== 'object') return value
  // Too deep to walk: withheld rather than sent as is
  if (depth > 20) return '[redacted]'
  if (Array.isArray(value)) return value.map(v => redactData(v, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, WITHHELD_KEY.test(k) ? '[redacted]' : redactData(v, depth + 1)]))
}
