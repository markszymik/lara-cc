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

/**
 * Options for every PHP the mod starts: PHP's own warnings and errors go to stderr, so stdout carries only what
 * the command prints. Laravel turns them off itself once booted; this covers what comes before (autoloading, a
 * package that warns on a newer PHP) and after (shutdown).
 */
export const PHP_OPTIONS = ['-d', 'display_errors=stderr']

/**
 * The JSON object PHP printed, from `marker` (`{"routes"`) to the last `}`, so what app code prints around it
 * (an `echo` in a service provider, a stray `dump()`) is skipped. Undefined when there's none.
 */
export function phpJson(stdout: string, marker = '{'): Record<string, unknown> | undefined {
  const start = stdout.indexOf(marker)
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  try {
    const value: unknown = JSON.parse(stdout.slice(start, end + 1))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The command name in `artisan help <name> --format=json` output. */
export function helpName(stdout: string): string | undefined {
  const name = phpJson(stdout)?.name
  return typeof name === 'string' ? name : undefined
}

/**
 * The last `max` characters of `text`, from a line start when one is near the cut. A cut can still part a key
 * from its value, so text for Claude is redacted before it's cut, never after.
 */
export function tail(text: string, max = 8000): string {
  if (text.length <= max) return text
  const kept = text.slice(-max)
  const nl = kept.indexOf('\n')
  return '…' + (nl >= 0 && nl < 200 ? kept.slice(nl) : kept)
}

/** The first `max` characters of `text`, cut at a space or between path parts when one is near the end. Redact first, as for tail(). */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const at = Math.max(head.lastIndexOf(' '), head.search(/[^\w+=-][\w+=-]*$/))
  return (at > max / 2 ? head.slice(0, at) : head) + '…'
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

/** Read the JSON from the snapshot's output. */
export function parseSnapshot(stdout: string): QueueSnapshot | undefined {
  return phpJson(stdout, '{"connection"') as QueueSnapshot | undefined
}

/** First line of a stored exception, e.g. `RuntimeException: Payment gateway down in /app/...:12`. */
export function exceptionHeadline(exception: string): string {
  return clip((exception.split('\n')[0] ?? '').replace(/^.*?\\(\w+(Exception|Error)):/, '$1:'), 300)
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

/** Read connectionsPhp's JSON; undefined when there's none. */
export function parseConnections(stdout: string): AppConnection[] | undefined {
  const list = phpJson(stdout, '{"connections"')?.connections
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

// ─── Routes: the Routes tab's list, where each route's code is, and its page ──

/**
 * A route as the Routes tab shows it: route:list's columns, where its code is (the controller method, closure or
 * view; relative to the project when inside it), and the parameters its URL needs a value for (required, with no
 * default). `id` is its place in the router, for openPagePhp. No domain: a route on its own domain only says so,
 * and its host stays in PHP.
 */
export type TabRoute = {
  id: number
  method: string
  uri: string
  name: string | null
  action: string
  file?: string
  line?: number
  params: string[]
  onDomain: boolean
}

/** `GET|HEAD` → `GET`; a route that takes every method (Route::any) → `ANY`; a HEAD-only route stays `HEAD`. */
export function methodLabel(method: string): string {
  const list = method.split('|').filter(m => m !== 'HEAD')
  if (!list.length) return method
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].every(m => list.includes(m)) ? 'ANY' : list.join('|')
}

/**
 * PHP run with `php -r` from the project root: boots the app and prints its routes sorted by URI as route:list
 * does, each with where its code is and the parameters its URL needs a value for (route and URL::defaults fill
 * the rest), and the editor Laravel's own `app.editor` setting names (as its error page uses it). A route's
 * domain doesn't leave PHP: only whether it has one.
 */
export function routesPhp(): string {
  return `
require 'vendor/autoload.php';
$app = require 'bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$where = function ($route) {
  $controller = $route->getAction('controller');
  if (!is_string($controller)) {
    // A closure; one from the route cache is serialized and has no file to show
    $uses = $route->getAction('uses');
    if (!$uses instanceof Closure) return null;
    $f = new ReflectionFunction($uses);
    return [$f->getFileName(), $f->getStartLine()];
  }
  [$class, $method] = array_pad(explode('@', ltrim($controller, '\\\\'), 2), 2, '__invoke');
  if ($class === Illuminate\\Routing\\ViewController::class) return [view()->getFinder()->find((string) ($route->defaults['view'] ?? '')), 1];
  // Route::redirect has no code of its own to show
  if ($class === Illuminate\\Routing\\RedirectController::class) return null;
  $c = new ReflectionClass($class);
  $m = $c->hasMethod($method) ? $c->getMethod($method) : null;
  // A method the class inherits (a Livewire page's __invoke) shows the class itself
  return $m && $m->getDeclaringClass()->getName() === $c->getName() ? [$m->getFileName(), $m->getStartLine()] : [$c->getFileName(), $c->getStartLine()];
};
$base = base_path() . DIRECTORY_SEPARATOR;
$urlDefaults = url()->getDefaultParameters();
$out = [];
foreach (array_values(app('router')->getRoutes()->getRoutes()) as $id => $route) {
  try { $at = $where($route); } catch (Throwable $e) { $at = null; }
  $file = $at && is_string($at[0]) ? (str_starts_with($at[0], $base) ? substr($at[0], strlen($base)) : $at[0]) : null;
  preg_match_all('/\\{(\\w+)\\}/', $route->getDomain() . '/' . $route->uri(), $params);
  $out[] = [
    'id' => $id, 'method' => implode('|', $route->methods()), 'uri' => $route->uri(), 'name' => $route->getName(),
    'action' => preg_replace('/@__invoke$/', '', ltrim($route->getActionName(), '\\\\')),
    'file' => $file, 'line' => $file ? (int) $at[1] : null, 'onDomain' => $route->getDomain() !== null,
    'params' => array_values(array_diff($params[1], array_keys($route->defaults + $urlDefaults))),
  ];
}
usort($out, fn ($a, $b) => strcmp($a['uri'], $b['uri']));
// A custom href can name a remote host, so only an editor's name is kept
$editor = config('app.editor');
if (is_array($editor)) $editor = $editor['name'] ?? null;
echo json_encode(['routes' => $out, 'editor' => is_string($editor) && preg_match('/^[\\w-]+$/', $editor) ? $editor : null]);
`
}

/** Read routesPhp's JSON, dropping odd entries; undefined when there's none. */
export function parseRoutes(stdout: string): { routes: TabRoute[]; editor: string } | undefined {
  const parsed = phpJson(stdout, '{"routes"')
  if (!parsed || !Array.isArray(parsed.routes)) return undefined
  const routes = (parsed.routes as Record<string, unknown>[]).flatMap((r): TabRoute[] => {
    const { id, method, uri, name, action, file, line, params } = r ?? {}
    if (!Number.isInteger(id) || typeof method !== 'string' || typeof uri !== 'string' || typeof action !== 'string') return []
    const hasFile = typeof file === 'string' && file !== '' && !/[\0-\x1f]/.test(file) && Number.isInteger(line) && (line as number) >= 1
    return [{
      id: id as number,
      method,
      uri,
      name: typeof name === 'string' ? name : null,
      action,
      ...(hasFile ? { file: file as string, line: line as number } : {}),
      params: Array.isArray(params) ? params.filter((p): p is string => typeof p === 'string' && /^\w+$/.test(p)) : [],
      onDomain: r.onDomain === true,
    }]
  })
  return { routes, editor: typeof parsed.editor === 'string' && /^[\w-]+$/.test(parsed.editor) ? parsed.editor : '' }
}

/**
 * PHP run as `php -r <this> -- <id> <method> <uri> <values JSON>`: finds the route (checking it is still the one
 * the tab showed), has Laravel's own URL generator build its URL from APP_URL with the values, and opens it in
 * the browser, so the URL never leaves PHP. Only http(s) URLs are opened. Prints `{"opened":true}`, or `false`
 * with a fixed reason.
 */
export function openPagePhp(): string {
  return `
require 'vendor/autoload.php';
$app = require 'bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
[, $id, $method, $uri, $values] = $argv + ['', '', '', '', '{}'];
$route = array_values(app('router')->getRoutes()->getRoutes())[(int) $id] ?? null;
$answer = ['opened' => false, 'why' => 'the routes changed; refresh the Routes tab'];
if ($route && implode('|', $route->methods()) === $method && $route->uri() === $uri) {
  try {
    // The values typed, then the route's own defaults (the generator applies URL::defaults itself)
    $names = array_flip($route->parameterNames());
    $url = url()->toRoute($route, array_intersect_key(json_decode($values, true) ?: [], $names) + array_intersect_key($route->defaults, $names), true);
    if (!preg_match('#^https?://#', $url)) {
      $answer['why'] = 'APP_URL is not an http(s) URL';
    } else {
      // Nothing the opener prints, which could name the URL, comes back
      $quiet = ['file', '/dev/null', 'w'];
      $p = proc_open([PHP_OS_FAMILY === 'Darwin' ? 'open' : 'xdg-open', $url], [['file', '/dev/null', 'r'], $quiet, $quiet], $pipes);
      $answer = is_resource($p) && proc_close($p) === 0 ? ['opened' => true] : ['opened' => false, 'why' => 'the browser could not be opened'];
    }
  } catch (Illuminate\\Routing\\Exceptions\\UrlGenerationException $e) {
    $answer['why'] = 'a value the URL needs is missing';
  } catch (Throwable $e) {
    $answer['why'] = 'Laravel could not build the URL';
  }
}
echo json_encode($answer);
`
}

/** Read openPagePhp's answer: `''` when opened, else why not. */
export function pageNotOpened(stdout: string): string {
  const answer = phpJson(stdout, '{"opened"')
  if (answer?.opened === true) return ''
  return typeof answer?.why === 'string' ? answer.why : 'PHP could not build the URL'
}

/** Editor links by Laravel's names for them (its error page's `app.editor`), `{file}` an absolute path. */
const EDITOR_HREFS: Record<string, string> = {
  antigravity: 'antigravity://file{file}:{line}',
  atom: 'atom://core/open/file?filename={file}&line={line}',
  cursor: 'cursor://file{file}:{line}',
  emacs: 'emacs://open?url=file://{file}&line={line}',
  fleet: 'fleet://open?file={file}&line={line}',
  idea: 'idea://open?file={file}&line={line}',
  kiro: 'kiro://file{file}:{line}',
  macvim: 'mvim://open/?url=file://{file}&line={line}',
  neovim: 'nvim://open?url=file://{file}&line={line}',
  netbeans: 'netbeans://open/?f={file}:{line}',
  nova: 'nova://core/open/file?filename={file}&line={line}',
  phpstorm: 'phpstorm://open?file={file}&line={line}',
  sublime: 'subl://open?url=file://{file}&line={line}',
  textmate: 'txmt://open?url=file://{file}&line={line}',
  trae: 'trae://file{file}:{line}',
  vscode: 'vscode://file{file}:{line}',
  'vscode-insiders': 'vscode-insiders://file{file}:{line}',
  'vscode-insiders-remote': 'vscode-insiders://vscode-remote{file}:{line}',
  'vscode-remote': 'vscode://vscode-remote{file}:{line}',
  vscodium: 'vscodium://file{file}:{line}',
  windsurf: 'windsurf://file{file}:{line}',
  xdebug: 'xdebug://{file}@{line}',
  zed: 'zed://file{file}:{line}',
}

/** The link that opens `file` (absolute) at `line` in `editor`; an unknown name gets Laravel's `<name>://open?file=…` form. */
export function editorHref(editor: string, file: string, line: number): string {
  const href = Object.hasOwn(EDITOR_HREFS, editor) ? EDITOR_HREFS[editor]! : `${editor}://open?file={file}&line={line}`
  return href.replace('{file}', file.split('/').map(encodeURIComponent).join('/')).replace('{line}', String(line))
}

/** macOS bundle ids of editors with a terminal, by Laravel's name for the editor. */
const EDITOR_APPS: Record<string, string> = {
  'com.microsoft.VSCode': 'vscode',
  'com.microsoft.VSCodeInsiders': 'vscode-insiders',
  'com.vscodium': 'vscodium',
  'com.todesktop.230313mzl4w4u92': 'cursor',
  'com.exafunction.windsurf': 'windsurf',
  'dev.zed.Zed': 'zed',
  'com.jetbrains.PhpStorm': 'phpstorm',
  'com.jetbrains.intellij': 'idea',
  'com.sublimetext.4': 'sublime',
  'com.panic.Nova': 'nova',
}

/**
 * The editor whose built-in terminal Claude Code runs in: by the app's bundle id (`__CFBundleIdentifier`), else
 * `TERMINAL_EMULATOR` (JetBrains) or `TERM_PROGRAM` (VS Code and its forks say `vscode`); '' in any other terminal.
 */
export function terminalEditor(bundle?: string, program?: string, emulator?: string): string {
  if (bundle && Object.hasOwn(EDITOR_APPS, bundle)) return EDITOR_APPS[bundle]!
  if (emulator?.startsWith('JetBrains')) return 'phpstorm'
  if (program === 'vscode' || program === 'zed') return program
  return ''
}

/**
 * The first row of the Routes tab's window, so the selected row `at` has a row drawn on each side (unless at an
 * end of the list, or the window is under 3 rows): the next arrow press always lands on a drawn row, and the
 * window follows it.
 */
export function routeWindow(at: number, top: number, rows: number, count: number): number {
  const margin = rows >= 3 ? 1 : 0
  let next = Math.min(top, at - margin)
  next = Math.max(next, at - rows + 1 + margin)
  return Math.max(0, Math.min(next, count - rows))
}

// ─── Redaction: what goes to Claude ────────────────────────────────────────

/** Key names whose value is a secret: `password=…`, `"api_key": "…"`, `'token' => '…'`, `DB_USERNAME=…`. */
// Bounded on each side: no key name is that long, and unbounded it backtracks for seconds on a long word
const SECRET_KEY = String.raw`[\w.-]{0,40}(?:passw(?:or)?d|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|app[_-]?key|authorization|credentials?|cookie|signature|dsn|username)[\w.-]{0,40}`
/**
 * A secret key and its value, in JSON (also escaped inside a JSON string, `\"password\":\"…\"`), PHP arrays,
 * query strings, headers and .env lines. A quoted value is taken whole, escaped quotes and spaces included.
 */
const KEY_VALUE = new RegExp(
  String.raw`(\\?["']|)(${SECRET_KEY})\1(\s*(?:=>|[:=])\s*)(?:\\"(?:[^"\\]|\\(?!"))*\\"|"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;&)}\]]+)`,
  'gi',
)
/**
 * PHP serialize()d strings under a secret key (queue payloads), raw or escaped in JSON: `s:8:"password";s:7:"hunter2";`.
 * A serialized string can hold quotes, so the value ends where the next serialized value (or the object) starts.
 */
const SERIALIZED = new RegExp(
  String.raw`(s:\d+:(\\?")(?:[^"\\]|\\u0000){0,40}?${SECRET_KEY}\2;)s:\d+:\2[\s\S]{0,20000}?\2;(?=[sibdaOCN][:;]|\}|$)`,
  'gi',
)
/** Tokens recognisable by their prefix: AWS key ids, Stripe and Slack keys, GitHub tokens, JWTs. */
const KNOWN_TOKENS = /\b(?:AKIA[0-9A-Z]{16}|(?:sk|pk|rk)_(?:live|test)_\w{8,}|xox[abeprs]-[\w-]{8,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})/g

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
    // The user (and password) in a URL, up to its last @, so a password with an @ in it goes too; never past
    // the URL's end into the next JSON field or argument
    .replace(/\b([a-z][\w+.-]*:\/\/)[^\s\/@"'`,;<>(){}\[\]]*(?:@[^\s\/@"'`,;<>(){}\[\]]*)*@/gi, '$1[redacted]@')
    // The credential after an auth scheme: 8+ characters with a digit, a lower-then-upper case mix or base64's
    // symbols, so prose ("CSRF token mismatch", "Basic authentication failed") is left alone
    .replace(/\b([Bb]earer|[Bb]asic|[Tt]oken)\s+(?=[\w~+\/.=-]{8})(?=[\w~+\/.=-]*(?:\d|[a-z][\w~+\/.=-]*[A-Z]|[+\/=]))[\w~+\/.=-]*[\w~+\/=-]/g, '$1 [redacted]')
    .replace(/\bbase64:[A-Za-z0-9+\/]{16,}={0,2}/g, 'base64:[redacted]')
    // Database login errors name the user: `for user 'forge'@'10.0.0.5'`, `for user "app"`
    .replace(/(\bfor user\s+)(["'])[^"']*\2(@(["'])[^"']*\4)?/gi, "$1$2?$2")
    .replace(SERIALIZED, '$1s:10:$2[redacted]$2;')
    .replace(KEY_VALUE, '$1$2$1$3[redacted]')
    .replace(KNOWN_TOKENS, '[redacted]')
    .replace(/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/(?<![\w\/\\.-])(?=[\w+=-]*[A-Z])(?=[\w+=-]*[a-z])(?=[\w+=-]*\d)[\w+=-]{32,}/g, '[redacted]')
    .replace(/\b[a-f0-9]{40,}\b/g, '[redacted]')
}

/**
 * `artisan about` (text or `--json`) for the conversation, without the app's URL or any other web address or
 * host name a package lists. What Claude needs from it, the versions, drivers and environment, stays.
 */
export function aboutWithoutAddresses(text: string): string {
  return text
    .replace(/^(\s*URL\b\s*\.*\s*)\S.*$/gim, '$1[not shown]')
    .replace(/("url"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[not shown]"')
    .replace(/\b[a-z][\w+.-]*:\/\/[^\s"']+/gi, '[address not shown]')
    // A row whose value is a host name: `Url ....... shop.test`, `Domain ....... admin.example.com`
    .replace(/^(\s*[\w ]+?\s\.{2,}\s+)[\w-]+(?:\.[\w-]+)*\.[a-z][\w-]*(?::\d+)?(?:\/\S*)?\s*$/gim, '$1[not shown]')
    .replace(/("[\w ]+"\s*:\s*)"[\w-]+(?:\.[\w-]+)*\.[a-z][\w-]*(?::\d+)?(?:\/[^"]*)?"/gi, '$1"[not shown]"')
}

/**
 * `artisan route:list --json` as lines for the conversation, each route's domain left out (a route with one says
 * so, without naming it). Undefined when the output isn't that JSON, e.g. an app with no routes.
 */
export function routeListLines(stdout: string): string[] | undefined {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end < start) return undefined
  let list: unknown
  try {
    list = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  return list
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map(r => {
      const own = text(r.domain) ? '  (own domain)' : ''
      return `${methodLabel(text(r.method)).padEnd(9)} ${text(r.uri)}${own}${text(r.name) ? '  ' + text(r.name) : ''}  ${shortClass(text(r.action))}`
    })
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
