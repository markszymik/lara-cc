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
