import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import {
  artisanCommandName,
  clock,
  composerDrift,
  connectionsPhp,
  durationMs,
  editKind,
  editorHref,
  errorKind,
  exceptionHeadline,
  feedLog,
  formatEntry,
  headline,
  helpName,
  herdNeeds,
  herdServices,
  hotPort,
  isError,
  isIgnoredRel,
  isTestCommand,
  testRunnerStarted,
  isWarning,
  lintResult,
  localHotUrl,
  logStamp,
  methodLabel,
  newLogState,
  npmDrift,
  openPagePhp,
  origin,
  pageNotOpened,
  parseConnections,
  parseDebugCapture,
  parseRoutes,
  parseSnapshot,
  parseTestRun,
  parseWorkerLine,
  PHP_OPTIONS,
  phpJson,
  queuesOf,
  aboutForClaude,
  clip,
  redact,
  relativeTo,
  parseRouteList,
  testsUseMemoryDb,
  redactData,
  refusedOptions,
  routesPhp,
  routeWindow,
  shortClass,
  snapshotPhp,
  splitArgs,
  stripAnsi,
  tail,
  terminalEditor,
  testScope,
  verifyBand,
} from './parse'
import type { AppConnection, EditKind, FailedJob, HerdService, LogEntry, QueueSnapshot, TabRoute, TestFailure, TestRun } from './parse'

/**
 * lara-cc: an unofficial Claude Code mod for Laravel apps. Not affiliated with or endorsed by Laravel LLC or Anthropic.
 *
 *   /lara [tab]             open the pane (services, queue, log, routes, commands, about)
 *   /lara-artisan <args>    run `php artisan <args>`; output lands in the transcript for Claude
 *   /lara-queue [start|stop|restart|logs|status|failed|retry <id|all>]
 *   /lara-vite|-schedule [start|stop|restart|logs]
 *   /lara-logs [errors|warnings|all] [count]
 *   /lara-test [args]       php artisan test
 *   /lara-routes [filter]   route list
 *   /lara-npm <script>      `npm run <script>` (pnpm / yarn / bun detected from the lockfile)
 *   /lara-composer <args>   run composer
 *
 * Claude gets tools: artisan, service, routes, logs, queue and health.
 */

type Api = EngineInterface

// ─── Config: edit these to taste ───────────────────────────────────────────

/** Long-running processes the mod can start, stop and restart. `vite` and `queue` are adjusted at start-up. */
const SERVICES = {
  queue: { label: 'Queue worker', argv: ['php', 'artisan', 'queue:work', '--tries=1'] },
  vite: { label: 'Vite dev', argv: ['npm', 'run', 'dev'] },
  schedule: { label: 'Scheduler', argv: ['php', 'artisan', 'schedule:work'] },
} satisfies Record<string, { label: string; argv: string[] }>

/** One-press commands on the Commands tab (digit = hotkey). `npm` is swapped for the detected package manager. */
const QUICK: { key: string; label: string; argv: string[] }[] = [
  { key: '1', label: 'npm run build', argv: ['npm', 'run', 'build'] },
  { key: '2', label: 'migrate', argv: ['php', 'artisan', 'migrate', '--no-interaction'] },
  { key: '3', label: 'optimize:clear', argv: ['php', 'artisan', 'optimize:clear'] },
  { key: '4', label: 'test', argv: ['php', 'artisan', 'test'] },
  { key: '5', label: 'pint', argv: ['vendor/bin/pint'] },
  { key: '6', label: 'queue:restart', argv: ['php', 'artisan', 'queue:restart'] },
  { key: '7', label: 'composer install', argv: ['composer', 'install', '--no-interaction'] },
]

/**
 * Artisan commands Claude's tool refuses, however they're spelled: artisan itself resolves the name first,
 * so `migr:fr` or `MIGRATE:FRESH` count as migrate:fresh. `tinker` is here because it runs any PHP.
 * You can still run them yourself with /lara-artisan.
 */
const DESTRUCTIVE = [
  'migrate:fresh', 'migrate:reset', 'migrate:refresh', 'migrate:rollback', 'db:wipe', 'db:seed', 'key:generate', 'down',
  'queue:flush', 'queue:clear', 'queue:forget', 'queue:prune-failed', 'queue:prune-batches', 'model:prune',
  'horizon:clear', 'horizon:forget', 'telescope:clear', 'telescope:prune', 'pulse:clear', 'tinker',
]

/**
 * Options the tool refuses on any command: `--force` skips the production prompt and overwrites files (`-f` on make:*),
 * `--env` points artisan at another environment's database, `--prune` deletes migration files, `--seed` runs seeders.
 */
const DESTRUCTIVE_OPTIONS = ['--force', '-f', '--env', '--prune', '--seed', '--seeder']

/**
 * Artisan commands Claude's tool runs only once the person says yes, with what each does: they reach past this
 * folder's files into the database, the queue or the cache, which may be shared or not on this machine at all.
 * APP_ENV saying `local` doesn't make that safe, so the question shows what the mod knows of where they land.
 */
const IMPACTFUL: Record<string, string> = {
  migrate: 'changes the database schema',
  'migrate:install': 'creates the migrations table in the database',
  'queue:retry': 'runs failed jobs again, with whatever they do (emails, payments, API calls)',
  'queue:retry-batch': 'runs a batch of failed jobs again, with whatever they do (emails, payments, API calls)',
  'queue:work': 'runs queued jobs, with whatever they do (emails, payments, API calls)',
  'queue:listen': 'runs queued jobs, with whatever they do (emails, payments, API calls)',
  horizon: 'runs queued jobs, with whatever they do (emails, payments, API calls)',
  'queue:restart': 'tells every worker that shares this cache to restart, including any elsewhere',
  'horizon:terminate': 'stops Horizon wherever it runs on this cache',
  'horizon:pause': 'pauses Horizon wherever it runs on this cache',
  'horizon:continue': 'resumes Horizon wherever it runs on this cache',
  'schedule:run': 'runs the scheduled tasks that are due, with whatever they do',
  'schedule:test': 'runs a scheduled task, with whatever it does',
  'schedule:work': 'runs the scheduled tasks every minute, with whatever they do',
  'cache:clear': 'empties the application cache, which other apps or machines may share',
  'cache:forget': 'removes an item from the application cache, which other apps or machines may share',
  'optimize:clear': 'clears every cache, the application cache (which may be shared) included',
}

/**
 * Artisan commands that only read, or write within the project folder (generated code, Laravel's own cache
 * files): Claude's tool runs these without asking. Anything else asks, with IMPACTFUL's reason when it has
 * one, since a command lara-cc doesn't know (a package's, a new one) may reach the database, queue, cache or network.
 */
const CONTAINED =
  /^(make:(cache-table|cast|channel|class|command|component|config|controller|enum|event|exception|factory|interface|job|job-middleware|listener|livewire|mail|middleware|migration|model|notification|notifications-table|observer|policy|provider|queue-batches-table|queue-failed-table|queue-table|request|resource|rule|scope|seeder|session-table|test|trait|view|volt)|filament:make-\S+|make:filament-(resource|page|widget|panel|relation-manager|cluster|exporter|importer|theme)|about|list|help|env|inspire|optimize|clear-compiled|package:discover|storage:link|(route|event):(list|cache|clear)|(config|view):(cache|clear)|(config|lang|stub|vendor):publish|model:show|db:(table|monitor)|schema:dump|migrate:status|schedule:list|channel:list|queue:(failed|monitor)|ide-helper:(generate|meta|models|eloquent))$/

/** Artisan commands Claude's tool refuses because they print secrets: config values (passwords, APP_KEY) or the .env encryption key. */
const CONFIDENTIAL = ['env:encrypt', 'env:decrypt']

/**
 * Artisan commands whose output is confidential (config values, the database's host and user) but only shows
 * information: they run for the person, with the output in the pane's Commands tab and never in the conversation.
 * Claude asking for one asks the person first (see showToPerson).
 */
const SHOWN_TO_PERSON = ['config:show', 'db:show']

/** Laravel Boost's MCP tools that read logs: asked for and redacted like lara-cc's logs tool. */
const BOOST_LOG_TOOLS = /^mcp__laravel-boost__(read-log-entries|last-error|browser-logs)$/

/** Every other Boost tool, in any version (tinker, database-query, schema, app info…): its output is redacted. get-config has its own guard. */
const BOOST_OTHER_TOOLS = /^mcp__laravel-boost__(?!(read-log-entries|last-error|browser-logs|get-config)$)/

/** Config keys whose value can be a secret: refused for Boost's get-config (`app.key`, `*.password`, `services.*.secret`…). */
const SECRET_CONFIG = /(^|[._-])(key|keys|pass(word)?|pwd|secret|token|auth|credentials?|dsn|url|cookie|signature|salt|private)([._-]|$)/i

const PANE = 'lara'
const MAX_SERVICE_LINES = 400
const TOAST_GAP_MS = 5000
/** Minute ticks without a finished health check before its results count as stale: they run every minute, so three means they're stuck. */
const CHECKS_STALE = 3

// ─── State (module variables reset when the mod reloads; child processes die with it) ──

type Tab = 'services' | 'queue' | 'log' | 'tests' | 'routes' | 'commands' | 'about'
type Run = { stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>; done: Promise<void> }
/** `crashed`: the exit code of a run that ended on its own with an error; `seen` once the Services tab showed it. */
// `startedSeq`: editCount when it started, so the report knows which of Claude's edits it has loaded
type Service = { name: string; label: string; argv: string[]; run?: Run; lines: string[]; startedAt?: number; startedSeq?: number; partial: string; crashed?: { code: number; seen: boolean } }
/**
 * `output`: for the Commands tab, its end (or all of it, `whole`, for output shown to the person on Claude's
 * request). `raw`: up to 200 KB of it, redacted and cut by formatRun only when it goes to Claude.
 */
type LastRun = { label: string; isRunning: boolean; exitCode?: number; output: string; raw?: string; whole?: boolean }
type Job = { job: string; time: string; status: 'running' | 'done' | 'failed'; ms?: number }
type Settings = {
  autoRestartQueue: boolean
  pintAfterTurn: boolean
  lintAfterTurn: boolean
  showBand: boolean
  errorToasts: boolean
  autostart: Record<string, string[]>
}

const DEFAULT_SETTINGS: Settings = { autoRestartQueue: true, pintAfterTurn: false, lintAfterTurn: true, showBand: true, errorToasts: true, autostart: {} }

// The SERVICES keys always exist; any other name (from Claude or a setting) may not, so it reads as possibly undefined
const services = {} as Record<keyof typeof SERVICES, Service> & Record<string, Service>
for (const [name, def] of Object.entries(SERVICES)) {
  services[name] = { name, label: def.label, argv: [...def.argv], lines: [], partial: '' }
}

let settings: Settings = { ...DEFAULT_SETTINGS }
let projectDir = ''
// Counts project detections, so async work started for a folder the session has since left is dropped
let projectRun = 0
// Cancels the timers session.start set, so running it again doesn't add a second set
let timers: { cancel: () => void }[] = []
let isLaravel = false
let hasPint = false
let pm = 'npm'

// PHP: `php` from PATH, or the binary Herd serves this folder with (see detectPhp)
let phpBin = 'php'
let composerArgv = ['composer']
let phpInfo = ''
let phpReady: Promise<void> = Promise.resolve()

let tab: Tab = 'services'
let paneOpen = false
let logOf = 'queue'
let lastToastAt = 0
let restartTimer: { cancel: () => void } | undefined
// The automatic queue restart is running (the worker is stopped, then started): not pending any more, not done yet
let restarting = false
let lastRun: LastRun | undefined
let about: Record<string, Record<string, unknown>> | undefined
let routeFilter = ''
// The routes (with where each route's code is), the load while one runs, and why the last one failed
let routeList: TabRoute[] | undefined
let routesLoading: Promise<void> | undefined
// Counts route loads, so a load for a folder the session has since left is dropped (detectProject counts one)
let routeLoads = 0
let routesError = ''
// The editor Laravel's `app.editor` setting names, if the app sets one
let appEditor = ''
// `open` on macOS, `xdg-open` elsewhere, asked once (see openCommand)
let opener: Promise<string> | undefined
// The selected route on the Routes tab (an index into the filtered list), and the first row drawn
let routeAt = 0
let routeTop = 0
let pendingMigrations = 0
// Fixes running from a band or Services tab button, by label, so the button reads "running…"
const fixing = new Set<string>()
// A test run started by runCommand is in progress (the Tests tab's button waits for it)
let testsRunning = false
// The last test run this session: /lara-test, the Tests tab, the artisan tool or Claude's Bash (see noteTestRun)
// `editedSince`: Claude edited PHP during or after it, so it no longer covers the code. `ledger`: editCount when it
// started, so any tracked edit since (not only PHP) shows; `scope`: whether it named part of the suite; `exitCode`: when known;
// `crashed`: the exit code of a run that ended without a summary (counts are 0, which says nothing)
let lastTest: (TestRun & { label: string; at: number; ledger: number; scope: 'suite' | 'subset'; exitCode?: number; crashed?: number; editedSince?: true }) | undefined
// Herd's debug session (queries, logs, dumps, HTTP calls the app made), started from the Services tab
type DebugState = 'off' | 'starting' | 'on' | 'stopping'
let debugState: DebugState = 'off'
let debugCapture: { data: unknown; summary: string; at: number } | undefined
// Laravel Boost's MCP server is installed: its log tools get the same ask and redaction as lara-cc's
let hasBoost = false
// The person let log entries and failed-job exceptions go to Claude for the rest of this session (see mayShare)
let shareAllowed = false
const editedPhp = new Set<string>()
// Counts Claude's PHP edits, so a test run knows whether one landed while it ran (see noteTestRun)
let phpEdits = 0

// What Claude edited this stretch, for the "Since Claude's edits" report (paths and categories only, never contents).
// Its times come from $.clock.now(), and what must be told apart (edit, check, restart) from editCount, never a mix of clocks.
// editedPhp is Pint's list and is cleared each turn, phpEdits drives lastTest.editedSince: neither changes, this is separate.
/** `seq`: editCount at the edit, so a check that started before it (a lint, a test run) is told apart from one after it. */
type Edited = { kind: EditKind; seq: number }
/** One file's `php -l`, at `at`: `raw` (the person's pane only, never Claude) is what it printed, cut; `gone`: the file no longer exists; `outside`: it is a link that leads outside the project, so it wasn't read. */
type LintFile = { seq: number; at: number; verdict: 'passed' | 'failed' | 'unknown'; line?: number; raw?: string; gone?: true; outside?: true }
/** A file of an earlier stretch with no clean check since its last edit: a known parse error (`failed`, with its line and when it was found), or just never checked. */
type Carried = { failed: boolean; line?: number; at?: number }
type Since = {
  firstAt: number                       // the first edit of this stretch: opens the log window
  lastAt: number
  files: Map<string, Edited>            // project-relative path -> its latest edit; capped at 200 (oldest dropped, never a failed one)
  dropped: number
  closedAt?: number                     // the last turn.complete chain finished; the next edit starts a new stretch
  chains: number                        // turn.complete chains queued or running for this stretch
  linting: boolean
  lint?: { at: number; seq: number; files: Map<string, LintFile> } // seq: editCount when the last check started
  carried: Map<string, Carried>         // files from an earlier stretch that haven't linted clean since; dropped only when one does (or the file is gone)
  pint?: { at: number; seq: number; files: number; ok: boolean }
  restart?: { at: number; ok: boolean } // the automatic queue restart after PHP edits: when it finished, and whether the worker came back
  errors: number                        // log errors that ARRIVED (by $.clock.now) from firstAt to closedAt + ERROR_WINDOW_MS
  newestError?: LogEntry                // the pane may show its headline; Claude gets only its own log stamp
  toasted?: string
}
let since: Since | undefined
// Counts every tracked edit
let editCount = 0
// The turn-end chains (syntax check, Pint, closing the stretch) run one after another through lintDone
let lintDone: Promise<void> = Promise.resolve()
// Like checksDone: a report waits for the syntax check queued behind a turn, not for Pint after it
let syntaxDone: Promise<void> = Promise.resolve()
const ERROR_WINDOW_MS = 10 * 60_000
// How long a restarted queue worker must stay up before the restart counts as done
const RESTART_SETTLE_MS = 1000
const LINT_MAX_FILES = 20
const LINT_BUDGET_MS = 20_000
const SINCE_MAX_FILES = 200
// artisan make:* commands that ran through lara-cc: files they created aren't tracked
let artisanMade = 0
// route:list and view:cache runs by lara-cc, with editCount when they started: the Routes and Views rows read them
let artisanRan: Record<string, { seq: number; ok: boolean; at: number }> = {}
type Verdict = 'passed' | 'failed' | 'not run' | 'skipped' | 'unknown' | 'done'
/**
 * One line of the report. `claude`: what Claude's tools can do (artisanStep, serviceStep), resolved only for the health
 * tool; `say`: a fixed next step; `partial`: passed, but a subset of the tests. `button`: the person's.
 */
type Row = {
  check: string
  known: 'seen' | 'inferred' | 'unknown'
  verdict: Verdict
  detail: string
  partial?: true
  claude?: { artisan: string } | { service: [string, 'restart'] }
  say?: string
  button?: Fix
}

// Log monitoring
let logPath = ''
let logState = newLogState()
let logRun: { stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> } | undefined
let logFilter: 'all' | 'warnings' | 'errors' = 'all'
// When the tail first ran in this folder (0: never), and each time it stopped (until `to`, when it started again): a
// stretch's log window counts only when no gap touches it
let logSince = 0
let logGaps: { from: number; to?: number }[] = []
// When the minute tick last looked at which file is newest: a file that began since is read as history from its start
let logLookedAt = 0
let unseenErrors = 0
let logReady: Promise<void> = Promise.resolve()

// Health checks: things that quietly break the app (see checkHealth)
/** `fix`: what the check's button runs, only ever on the person's press; it may return a line to show. */
type Fix = { label: string; run: () => Promise<string | void> }
/**
 * A health check's finding: something wrong, or something lara-cc couldn't tell. `known`: 'seen' when the evidence
 * shows it (a file exists, nothing listens on the port), 'inferred' for a conclusion (no worker here and the count
 * isn't falling), 'unknown' when a probe couldn't answer. `detail`: the Services tab's line, for the person.
 * `evidence`: Claude's health tool's line, only drivers, local ports, file names, package names, counts and
 * errorKind(): never a host, user, URL or message text. `claude`: what Claude's own tools can do about it and
 * whether that asks (artisanStep, serviceStep). `fromAbout`: read from `artisan about` alone, so stale when it fails.
 */
type Check = {
  band: string
  color: 'red' | 'yellow'
  known: 'seen' | 'inferred' | 'unknown'
  detail: string
  evidence: string
  fix?: Fix
  claude?: string
  backlog?: true
  fromAbout?: true
}
/** Something a check looked at and found fine, for Claude's health tool: 'inferred' when the evidence is indirect (a port answers). */
type Fine = { known: 'seen' | 'inferred'; evidence: string }
/** The band's and Services tab's marker: ⚠ for something seen, ? for a conclusion or something lara-cc couldn't tell. */
const mark = (c: Check) => (c.known === 'seen' ? '⚠' : '?')
let checks: Check[] = []
// What the last finished checks looked at and found fine (Claude's health tool), set with `checks`
let checkedFine: Fine[] = []
let checking = false
let checkAgain = false
// Resolves once the run in progress, and the one queued behind it, have finished (see checkHealth)
let checksDone: Promise<void> = Promise.resolve()
// When the checks last finished here (0: not yet), the minute ticks since (see CHECKS_STALE), and the kind of the last failure ('')
let checkedAt = 0
let checksMissed = 0
let checksFailed = ''
let depsSeen = ''
let depsChecks: Check[] = []
let depsFine: Fine[] = []
// The tools whose drift files couldn't be read at the last check (tried again next time)
let depsUnread: string[] = []
// Herd's installed services and whether each listens; services.plist is re-read only when it changes
type Probe = 'up' | 'down' | 'unknown'
let herdList: (HerdService & { up: Probe })[] = []
let herdSeen = -2
let herdInstalled: HerdService[] = []
// plutil couldn't read services.plist the last time it changed
let herdUnread = false
// Ports of the Herd services a start button is starting, so it reads "starting…" meanwhile
const herdStarting = new Set<number>()
// The driver and port of each local server the app's config connects to (see connectionsPhp), read with `about`;
// undefined until connectionsPhp has answered
let connections: AppConnection[] | undefined
// When `artisan about` last worked, and the kind of its last failure ('' when the last one worked); see errorKind
let aboutAt = 0
let aboutFailed = ''
// When migrate:status last worked (0: never here), the kind of its last failure (''), and a run count so only the newest writes
let migrationsAt = 0
// editCount when the last good migrate:status started, so the report knows which migration edits it saw
let migrationsSeq = 0
let migrationsFailed = ''
let migrationRuns = 0

// Queue monitoring
let jobs: Job[] = []
const stats = { done: 0, failed: 0, totalMs: 0 }
let snapshot: QueueSnapshot | undefined
// When the queue was last read (whether or not it worked), and when a read last worked in full
let snapshotAt = 0
let snapshotOkAt = 0
// Why the last read failed: the message for the person, its kind for Claude (see errorKind)
let snapshotError = ''
let snapshotKind = ''
// The last read counted the jobs waiting: in full, or all but the failed jobs (a partial read)
let sizesRead = false
// The read in progress, so a caller can wait for it (see recheck)
let snapshotLoad: Promise<void> | undefined
// The jobs waiting at the read before, to tell a backlog from a queue a worker elsewhere drains. That's the first
// read of the minute tick before (`waitingAtTick` is this tick's), so reads close together don't each reset it
let waitingBefore: number | undefined
let waitingAtTick: number | undefined

// ─── Small helpers ─────────────────────────────────────────────────────────

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm'
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** A test run's counts for Claude and the pane: `2 failed, 10 passed, 1 skipped`, or `12 passed`. */
function testCounts(t: { passed: number; failed: number; skipped: number; crashed?: number }): string {
  if (t.crashed !== undefined) return `exited ${t.crashed} before printing a summary`
  return (t.failed ? `${t.failed} failed, ${t.passed} passed` : `${t.passed} passed`) + (t.skipped ? `, ${t.skipped} skipped` : '')
}

/** What the logs tool does about sending entries to Claude, for a `next:` line. */
function logsConsent(): string {
  return shareAllowed ? 'the user allowed log entries this session' : 'asks the user before sending entries'
}

/** `$.clock.now()`, which is `Date.now()` here but moves with a test's clock; a session already ending (the call refused) reads the system's. */
function nowMs($: Api): Promise<number> {
  return $.clock.now().catch(() => Date.now())
}

function redraw($: Api) {
  $.ui.invalidate('ui.render')
}

/** A toast, at most one every few seconds so a burst of errors doesn't flood the screen. */
function toast($: Api, text: string) {
  const now = Date.now()
  if (now - lastToastAt < TOAST_GAP_MS) return
  lastToastAt = now
  $.ui.toast(text.length > 140 ? text.slice(0, 139) + '…' : text, { timeoutMs: 6000 })
}

function notLaravel(): string {
  return 'No `artisan` file in this directory, so this does not look like a Laravel project. Start Claude Code from the project root.'
}

async function openPane($: Api, on: Tab) {
  tab = on
  if (on === 'log') unseenErrors = 0
  if (on === 'services') for (const svc of Object.values(services)) if (svc.crashed) svc.crashed.seen = true
  if (on === 'about' && !about) void loadAbout($)
  // Again after a failed load, so a fixed app shows its routes
  if (on === 'routes' && !routeList) void loadRouteList($)
  if (on === 'queue') void refreshQueue($)
  paneOpen = true
  await $.ui.open({ id: PANE, title: 'lara-cc', focus: true, closeOnEscape: true })
  redraw($)
  if (on === 'routes') void (routesLoading ?? Promise.resolve()).then(() => focusRoute($))
}

// ─── Settings (kept between sessions) ──────────────────────────────────────

async function loadSettings($: Api) {
  const saved = await $.store.get('settings')
  if (saved && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...(saved as Partial<Settings>) }
}

async function toggle($: Api, key: 'autoRestartQueue' | 'pintAfterTurn' | 'lintAfterTurn' | 'showBand' | 'errorToasts') {
  settings = { ...settings, [key]: !settings[key] }
  redraw($)
  await $.store.set('settings', settings)
}

async function toggleAutostart($: Api, name: string) {
  const list = settings.autostart[projectDir] ?? []
  const next = list.includes(name) ? list.filter(n => n !== name) : [...list, name]
  settings = { ...settings, autostart: { ...settings.autostart, [projectDir]: next } }
  redraw($)
  await $.store.set('settings', settings)
}

// ─── PHP version ───────────────────────────────────────────────────────────

/** The binary and version a PHP launch (`['php']`, `['herd', 'php']`) reports, or undefined when it doesn't run or answers oddly. */
async function probePhp($: Api, argv: string[]): Promise<{ binary: string; version: string } | undefined> {
  try {
    const r = await $.process.run([...argv, ...PHP_OPTIONS, '-r', 'echo PHP_BINARY, "\\n", PHP_VERSION;'], { timeoutMs: 15_000 })
    // The last two lines, should something print before them
    const [binary = '', version = ''] = r.stdout.trim().split(/\r?\n/).slice(-2).map(s => s.trim())
    if (r.exitCode !== 0 || !binary.startsWith('/') || !/^\d+\.\d+\.\d+/.test(version) || !(await $.fs.exists(binary))) return undefined
    return { binary, version }
  } catch {
    return undefined
  }
}

/** The absolute path `which` finds for `name` on PATH, or ''. */
async function onPath($: Api, name: string): Promise<string> {
  const r = await $.process.run(['which', name], { timeoutMs: 5_000 }).catch(() => undefined)
  const path = r?.exitCode === 0 ? r.stdout.trim() : ''
  return path.startsWith('/') && (await $.fs.exists(path)) ? path : ''
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

/**
 * When the `php` on PATH is Herd's, use the binary Herd serves this folder with instead (the site's isolated
 * version), so artisan, composer and Pint run on the same PHP as the site. A PATH php from elsewhere (Homebrew,
 * asdf) was chosen on purpose and stays. Herd is asked once: going through `herd php` on every call adds ~0.5s,
 * and it doesn't pass signals on, so stopping a queue worker would leave PHP running.
 * Asks only about this folder: reads no site list and no .env.
 */
async function detectPhp($: Api) {
  const project = projectRun
  const [herd, shell, hasHerd] = await Promise.all([probePhp($, ['herd', 'php']), probePhp($, ['php']), onPath($, 'herd')])
  if (project !== projectRun) return
  if (!herd) {
    const using = shell ? `PHP ${shell.version} from PATH` : ''
    phpInfo = hasHerd ? `Herd didn't say which PHP serves this folder${using ? `; using ${using}` : ''}` : using
    return
  }
  if (shell && dirOf(shell.binary) !== dirOf(herd.binary)) {
    phpInfo = `PHP ${shell.version} from PATH (not Herd's php, so Herd's site version isn't used)`
    return
  }
  phpBin = herd.binary
  phpInfo = `PHP ${herd.version} · Herd` + (shell && shell.binary !== herd.binary ? ` (isolated; php in your shell is ${shell.version})` : '')

  // As `herd composer` does, run Composer on the site's PHP; only when it really is a PHP script (not an asdf/mise shim)
  const composer = await onPath($, 'composer')
  if (!composer) return
  const r = await $.process.run([herd.binary, composer, '--version', '--no-ansi'], { timeoutMs: 15_000 }).catch(() => undefined)
  if (project === projectRun && r?.exitCode === 0 && /^Composer version/m.test(r.stdout)) composerArgv = [herd.binary, ...PHP_OPTIONS, composer]
}

/** `argv` with php, composer and Pint run on the PHP that serves this folder, with PHP_OPTIONS. */
function withPhp(argv: string[]): string[] {
  const [cmd = '', ...rest] = argv
  if (cmd === 'php') return [phpBin, ...PHP_OPTIONS, ...rest]
  if (cmd === 'composer') return [...composerArgv, ...rest]
  if (cmd === 'vendor/bin/pint' && phpBin !== 'php') return [phpBin, ...PHP_OPTIONS, cmd, ...rest]
  return argv
}

/** `$.process.run`, once the PHP binary is known, with `withPhp` applied. */
async function runPhp($: Api, argv: string[], init: { timeoutMs: number }) {
  await phpReady
  return $.process.run(withPhp(argv), init)
}

// ─── One-shot commands ─────────────────────────────────────────────────────

/** Run a command, keep its output for the Commands tab, and return it. `resolved`: the artisan command's full name, when it was typed short (`view:ca`). */
async function runCommand($: Api, label: string, argv: string[], timeoutMs = 600_000, whole = false, resolved?: string): Promise<LastRun> {
  const isTests = isTestCommand(argv.join(' '))
  const project = projectRun
  const edits = phpEdits
  const ledger = editCount
  lastRun = { label, isRunning: true, output: '' }
  if (isTests) testsRunning = true
  redraw($)
  let run: LastRun
  try {
    const r = await runPhp($, argv, { timeoutMs })
    const output = stripAnsi([r.stdout, r.stderr].filter(Boolean).join('\n')).trim()
    run = { label, isRunning: false, exitCode: r.exitCode, output: tail(output, whole ? 200_000 : 8000), raw: tail(output, 200_000), whole }
    if (isTests && project === projectRun) noteTestRun($, label, output, edits, ledger, argv.join(' '), r.exitCode)
    if (project === projectRun) noteArtisanRan(resolved ?? (argv[1] === 'artisan' ? argv[2] : undefined), r.exitCode, ledger)
  } catch (err) {
    run = { label, isRunning: false, exitCode: -1, output: 'Could not run `' + argv.join(' ') + '`: ' + String(err) }
  }
  // The caller still gets the result; the Commands tab doesn't show it in another folder
  if (project === projectRun) {
    lastRun = run
    if (isTests) testsRunning = false
  }
  redraw($)
  // optimize:clear, composer install, artisan up… change what the checks see
  void checkHealth($)
  return run
}

/** Send `text` to Claude as the person's message: the ask Claude buttons. */
function sendToClaude($: Api, text: string) {
  $.prompt.submit({ text, asUser: true }).catch(err => $.ui.toast('Could not send to Claude: ' + String(err)))
}

/** A tool result for Claude with its text redacted; an error stays one (as a deny, which Claude reads as an error). */
function redactedResult(result: { text?: string; result?: unknown; isError?: true; deny?: string }) {
  if (result.deny) return { deny: result.deny }
  return result.isError ? { deny: redact(resultText(result)) } : { result: redact(resultText(result)) }
}

/**
 * What a tool call returned as text: what the model reads (`text`, set by core), else the record itself when a
 * hook answered: a string, MCP text blocks, or Bash's stdout and stderr.
 */
function resultText(result: { text?: string; result?: unknown }): string {
  if (result.text !== undefined) return result.text
  const record = result.result
  if (typeof record === 'string') return record
  if (Array.isArray(record)) return record.map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
  if (record && typeof record === 'object') {
    const { stdout, stderr } = record as { stdout?: unknown; stderr?: unknown }
    if (typeof stdout === 'string' || typeof stderr === 'string') return [stdout, stderr].filter(t => typeof t === 'string').join('\n')
    return JSON.stringify(record)
  }
  return ''
}

/**
 * Remember a test run's result for the band and the Tests tab. Output with no test summary is ignored, unless the run
 * failed (`exitCode`): it died before printing one (a dd() left in, a fatal while loading, out of memory), which is a
 * failure, not "not run". `edits`:
 * phpEdits when the run started, so an edit Claude made while it ran marks it as not covering the code; `ledger`:
 * editCount then, which any tracked edit moves. `command`: all of what ran (the label may be cut), for its scope.
 */
function noteTestRun($: Api, label: string, output: string, edits: number, ledger: number, command: string, exitCode?: number) {
  const parsed = parseTestRun(stripAnsi(output))
  if (!parsed && !exitCode) return
  const run = parsed ?? { passed: 0, failed: 0, skipped: 0, failures: [] }
  lastTest = {
    ...run,
    label,
    at: Date.now(),
    ledger,
    scope: testScope(command),
    ...(parsed ? (exitCode === undefined ? {} : { exitCode }) : { crashed: exitCode }),
    ...(edits !== phpEdits ? { editedSince: true as const } : {}),
  }
  redraw($)
}

/** Remember that route:list or view:cache ran, and whether it worked: the Routes and Views rows of the report read it. */
function noteArtisanRan(name: string | undefined, exitCode: number, ledger: number) {
  if (name === 'route:list' || name === 'view:cache') artisanRan[name] = { seq: ledger, ok: exitCode === 0, at: Date.now() }
}

/** Send one failing test to Claude to fix: the Tests tab's button. Redacted, like everything sent. */
function askAboutTest($: Api, f: TestFailure) {
  const text = ['This test fails in my Laravel app. Find the cause and fix it, then run it again.', '', `Test: ${f.name}`, '', '```', redact(f.detail.join('\n')), '```'].join('\n')
  sendToClaude($, text)
}

/** Send every failing test of the last run to Claude. */
function askAboutTests($: Api, failures: TestFailure[]) {
  const blocks = failures.slice(0, 10).map(f => `Test: ${f.name}\n\`\`\`\n${redact(f.detail.slice(0, 15).join('\n'))}\n\`\`\``)
  const text = [`${plural(failures.length, 'test')} fail in my Laravel app. Find the causes and fix them, then run the tests again.`, '', ...blocks].join('\n\n')
  sendToClaude($, text)
}

/** A run's result for Claude (tool results and command output in the transcript), with secrets redacted. */
function formatRun(run: LastRun): string {
  const head = redact(run.exitCode === 0 ? `✓ ${run.label}` : `✗ ${run.label} (exit ${run.exitCode})`)
  // Redacted whole before the cut, so a cut can't part a key from its value
  const body = tail(redact(run.raw ?? run.output))
  return body ? `${head}\n${body}` : head
}

/**
 * Whether artisan `argv` is safe to run for Claude. Artisan resolves the name itself (`help <name>`), so
 * abbreviations and odd casing can't slip past DESTRUCTIVE; a name it can't resolve comes back as `error`.
 */
async function checkArtisan(
  $: Api,
  argv: string[],
): Promise<{ resolved?: string; refused?: string; error?: string; impact?: string; shownToPerson?: true }> {
  const options = refusedOptions(argv, DESTRUCTIVE_OPTIONS)
  if (options.length) return { refused: `${options.join(' ')} can destroy data or point at another environment` }
  const { resolved, error } = await resolveArtisan($, argv)
  if (error) return { error }
  if (!resolved) return {}
  return { resolved, ...(await artisanSafety($, resolved)) }
}

/** What checkArtisan does with an artisan command artisan has resolved, by the 0.11 lists: Claude's tool and the health tool's suggestions both read it. */
async function artisanSafety($: Api, resolved: string): Promise<{ refused?: string; impact?: string; shownToPerson?: true }> {
  if (SHOWN_TO_PERSON.includes(resolved)) return { shownToPerson: true }
  if (CONFIDENTIAL.includes(resolved)) return { refused: `${resolved} prints configuration secrets (passwords, keys)` }
  if (DESTRUCTIVE.includes(resolved)) {
    return { refused: resolved === 'tinker' ? 'tinker runs arbitrary PHP' : `${resolved} can destroy data` }
  }
  if (CONTAINED.test(resolved)) return {}
  // Tests stay in the folder only when they can't touch a real database (RefreshDatabase resets the one configured)
  if (resolved === 'test') {
    const xml = await $.fs.read('phpunit.xml').catch(() => $.fs.read('phpunit.xml.dist').catch(() => ''))
    if (testsUseMemoryDb(xml)) return {}
    return { impact: "runs the test suite, and phpunit.xml doesn't send it to an in-memory database, so RefreshDatabase and the like can reset or fill a real one" }
  }
  return {
    impact: IMPACTFUL[resolved] ?? "isn't one lara-cc knows to stay inside the project folder, so it may reach the database, queue, cache or network",
  }
}

/** An artisan step to suggest to Claude, saying what its tool will do (artisanSafety), so the suggestion can't promise otherwise. */
async function artisanStep($: Api, commands: string[]): Promise<string> {
  const safety = await Promise.all(commands.map(c => artisanSafety($, c)))
  const how = safety.some(s => s.refused) ? 'refused; ask the user' : safety.some(s => s.impact || s.shownToPerson) ? 'asks the user first' : 'runs without asking'
  return `artisan tool: ${commands.map(c => '"' + c + '"').join(', then ')} (${how})`
}

/**
 * Run artisan for the conversation (Claude's tool, /lara-artisan): the output, redacted, with what two everyday
 * commands print as a matter of course taken out: `about`'s app URL, and route:list's domains (it runs with
 * --json so the domain is a field to drop, whatever options were asked for).
 */
async function artisanForConversation($: Api, args: string, resolved: string | undefined, timeoutMs = 600_000): Promise<string> {
  const argv = splitArgs(args)
  // Generators write files lara-cc doesn't see (the report says so)
  if (resolved && /^(make:|filament:make-)/.test(resolved)) artisanMade++
  if (resolved === 'about') {
    // Read as JSON, whatever format was asked for, so only allowed values are shown (see aboutForClaude)
    const r = await runPhp($, ['php', 'artisan', ...argv.filter(a => a !== '--json'), '--json', '--no-interaction'], { timeoutMs })
    const text = aboutForClaude(r.stdout)
    return text ? `✓ artisan ${redact(args)} (addresses and other values that could be confidential left out)\n${redact(text)}` : `✗ artisan ${redact(args)}\n${failureReason(r.stdout + '\n' + r.stderr)}`
  }
  if (resolved === 'route:list') {
    const project = projectRun
    const ledger = editCount
    const r = await runPhp($, ['php', 'artisan', ...argv.filter(a => a !== '--json'), '--json', '--no-interaction'], { timeoutMs })
    const routes = parseRouteList(r.stdout)
    if (project === projectRun) artisanRan['route:list'] = { seq: ledger, ok: !!routes, at: Date.now() }
    if (!routes) return `✗ artisan ${redact(args)}\n${failureReason(r.stdout + '\n' + r.stderr)}`
    const verbose = argv.some(a => /^-v+$/.test(a))
    const lines = routes.map(route => formatRoute(route) + (route.onDomain ? '  (own domain)' : '') + (verbose && route.middleware.length ? `  [${route.middleware.join(', ')}]` : ''))
    const body = tail(redact(lines.join('\n')))
    if (project === projectRun) lastRun = { label: 'artisan ' + args, isRunning: false, exitCode: r.exitCode, output: body }
    redraw($)
    return `✓ artisan ${redact(args)} (${plural(routes.length, 'route')}; domains left out)\n${body}`
  }
  const run = await runCommand($, 'artisan ' + args, ['php', 'artisan', ...argv, '--no-interaction'], timeoutMs, false, resolved)
  return formatRun(run)
}

/** What Claude gets when the person says no to running something: not to try again, and how they'd run it. */
const NOT_RUN = "The user chose not to run this. Don't retry it; if it's needed, ask them to run it themselves (e.g. with /lara-artisan)."

/**
 * Ask the person before Claude, or a command they didn't type, runs something IMPACTFUL. Shows what it does and
 * where it lands as far as the mod knows (APP_ENV, and which of the app's servers are on this machine: driver and
 * port, never a host or user). Dismissed, or nobody there to answer (`claude -p`), is no.
 */
async function mayRun($: Api, what: string, effect: string): Promise<boolean> {
  const project = projectRun
  // `about` and the servers are read together, a moment after start; until then, say so rather than "none found"
  const env = about?.environment?.environment
  const local = (connections ?? []).map(c => `${c.use} ${c.driver}:${c.port}`)
  const where = !about
    ? "lara-cc doesn't know APP_ENV or the app's servers (not read yet, or `artisan about` failed)."
    : `APP_ENV is ${typeof env === 'string' ? env : 'unknown'}${aboutFailed ? ` (as read ${ago(aboutAt)} ago; artisan about has failed since)` : ''}; ` +
      (connections === undefined
        ? "lara-cc couldn't read which servers it connects to."
        : local.length
          ? `servers on this machine it connects to: ${local.join(', ')}.`
          : 'lara-cc found none of its servers on this machine (it may use SQLite, files or a server elsewhere).')
  const question = `Claude (or a command you didn't type) wants to run ${what}, which ${effect}. ${where} Run it?`
  const answer = await $.ui.ask(question, { header: 'lara-cc', options: ['Run it', "Don't run"] }).catch(() => "Don't run")
  // A yes is for the folder the question was about
  return answer === 'Run it' && project === projectRun
}

/**
 * Run a SHOWN_TO_PERSON command for the person: its output goes to the Commands tab, and what comes back for the
 * conversation says only that it was shown. `ask`: Claude (or a command the person didn't type) wants it, so the
 * person says yes first; dismissed or nobody there to answer is no.
 */
async function showToPerson($: Api, args: string, ask: boolean): Promise<string> {
  if (ask) {
    const question =
      `Claude wants to see php artisan ${args}. Its output can hold passwords, keys, hosts and users, so lara-cc shows it to you in its pane and doesn't send it to Claude. Show it?`
    const project = projectRun
    const answer = await $.ui.ask(question, { header: 'Privacy', options: ['Show me', "Don't run"] }).catch(() => "Don't run")
    // A yes is for the folder the question was about
    if (answer !== 'Show me' || project !== projectRun) return NOT_RUN
  }
  const run = await runCommand($, 'artisan ' + args, ['php', 'artisan', ...splitArgs(args), '--no-interaction'], 600_000, true)
  await openPane($, 'commands').catch(() => {})
  return (
    `${run.exitCode === 0 ? '✓' : '✗'} artisan ${redact(args)}: shown to the user in the lara-cc pane (Commands tab). ` +
    "The output isn't in this conversation because it can hold secrets; ask the user for what you need from it, without the secrets."
  )
}

/** For a service start: what the process does, when it's one that needs asking (queue worker, Horizon, scheduler; not Vite). */
function startImpact(name: string): string | undefined {
  const argv = services[name]?.argv ?? []
  return argv[1] === 'artisan' ? IMPACTFUL[argv[2] ?? ''] : undefined
}

/** What a service action does that needs the person's yes: starting the worker or scheduler (a restart of what isn't running starts it). */
function serviceImpact(name: string, action: string): string | undefined {
  const starts = !services[name]?.run && (action === 'start' || action === 'restart')
  return starts ? startImpact(name) : undefined
}

/** A service step to suggest to Claude, saying what guardedServiceAction will do. */
function serviceStep(name: string, action: 'start' | 'restart'): string {
  return `service tool: ${name} ${action} (${serviceImpact(name, action) ? 'asks the user first' : 'runs without asking'})`
}

/** A finding's next steps for Claude's health tool: what Claude's tools can do, then the person's button. */
function nextSteps(claude: string | undefined, button: string | undefined): string {
  const steps = [claude ?? (button ? 'no tool of yours does this' : 'no tool of yours does this; tell the user'), button ? `the user's button "${button}"` : '']
  return '  next: ' + steps.filter(Boolean).join(' · ')
}

/**
 * serviceAction for anyone but the person typing or pressing: a start (or a restart that starts) of a process
 * that runs jobs or tasks asks first. Stopping, and restarting what already runs, are left to Claude, so it can
 * restart the worker after changing job code.
 */
async function guardedServiceAction($: Api, name: string, action: string): Promise<string> {
  const impact = serviceImpact(name, action)
  if (impact && !(await mayRun($, (services[name]?.argv ?? []).join(' '), impact))) return NOT_RUN
  return serviceAction($, name, action)
}

/** retryFailed for anyone but the person: asks first, naming how many jobs `all` is. */
async function guardedRetry($: Api, id: string): Promise<string> {
  const what = id === 'all' ? `queue:retry all (${snapshot ? plural(snapshot.failedTotal, 'failed job') : 'every failed job'})` : `queue:retry ${id}`
  if (!(await mayRun($, what, IMPACTFUL['queue:retry']!))) return NOT_RUN
  return retryFailed($, id)
}

/** Typed by the person (at the terminal or through Remote Control), not relayed from another session, channel or plugin. */
/** The full name artisan resolves the command in `argv` to (`migr:fr` is migrate:fresh); none for bare `artisan`. */
async function resolveArtisan($: Api, argv: string[]): Promise<{ resolved?: string; error?: string }> {
  const name = artisanCommandName(argv)
  if (name === undefined) return {}
  const r = await runPhp($, ['php', 'artisan', 'help', name, '--format=json', '--no-interaction'], { timeoutMs: 60_000 })
  const resolved = r.exitCode === 0 ? helpName(r.stdout) : undefined
  if (resolved) return { resolved }
  const output = stripAnsi([r.stdout, r.stderr].filter(Boolean).join('\n')).trim()
  // Goes to Claude: the app failing to boot can print config, hosts and users
  return { error: `✗ artisan could not resolve "${name}"\n${tail(redact(output), 2000)}` }
}

function fromUser(origin: { kind: string } | undefined): boolean {
  return origin?.kind === 'composer' || origin?.kind === 'bridge'
}

// ─── Long-running services ─────────────────────────────────────────────────

function onServiceOutput($: Api, svc: Service, text: string) {
  const parts = (svc.partial + stripAnsi(text)).split('\n')
  svc.partial = parts.pop() ?? ''
  for (const line of parts) {
    if (line.trim() === '') continue
    svc.lines.push(line)
    if (svc.name === 'queue') onWorkerLine($, line)
  }
  if (svc.lines.length > MAX_SERVICE_LINES) svc.lines.splice(0, svc.lines.length - MAX_SERVICE_LINES)
  redraw($)
}

async function startService($: Api, name: string): Promise<string> {
  const svc = services[name]
  if (!svc) return `Unknown service "${name}". Known: ${Object.keys(services).join(', ')}`
  const project = projectRun
  await phpReady
  if (project !== projectRun) return `${svc.label} not started: the session moved to another folder.`
  // Nothing awaits between this check and the spawn, so two quick starts can't both get through
  if (svc.run) return `${svc.label} is already running.`

  const argv = withPhp(svc.argv)
  svc.crashed = undefined
  const stream = $.process.spawn({ argv })
  svc.lines.push(`$ ${argv.join(' ')}`)
  svc.startedAt = Date.now()
  svc.startedSeq = editCount
  svc.partial = ''

  let finish = () => {}
  const run: Run = { stream, done: new Promise<void>(resolve => (finish = resolve)) }
  svc.run = run

  // The loop is the child's life: it keeps running after this function returns.
  void (async () => {
    try {
      let step = await stream.next()
      while (!step.done) {
        // A stop that timed out has let go of the run: what it still prints isn't the service's any more
        if (svc.run === run) onServiceOutput($, svc, step.value.text)
        step = await stream.next()
      }
      // A stream closed by stopService ends without a result
      const end = step.value as ProcessSpawnResult | undefined
      // A stop that let go of the run (timed out, or the session moved on) has said its piece already
      if (svc.run === run) {
        if (!end || end.signal) svc.lines.push('■ stopped')
        else svc.lines.push(`■ exited with code ${end.code}`)
        if (end?.code) {
          svc.crashed = { code: end.code, seen: paneOpen && tab === 'services' }
          toast($, `${svc.label} exited with code ${end.code}`)
        }
      }
    } catch (err) {
      if (svc.run === run) svc.lines.push('■ ' + String(err))
    }
    if (svc.run === run) {
      svc.run = undefined
      svc.startedAt = undefined
    }
    finish()
    redraw($)
    // Vite leaves public/hot behind when it dies
    void checkHealth($)
  })()

  redraw($)
  return `${svc.label} started: ${argv.join(' ')}`
}

async function stopService($: Api, name: string): Promise<string> {
  const svc = services[name]
  if (!svc) return `Unknown service "${name}".`
  // A start waiting on phpReady goes first, so this sees (and stops) what it spawns
  await phpReady
  const run = svc.run
  // Only what this session started: one run elsewhere is out of its sight
  if (!run) return `${svc.label} isn't running in this session, so there's nothing to stop; lara-cc can't stop one run elsewhere.`
  svc.lines.push('… stopping')
  redraw($)
  // Closing the stream kills the child. Don't wait forever on a quiet process.
  void run.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  await Promise.race([run.done, $.clock.sleep(5000)])
  if (svc.run === run) {
    svc.run = undefined
    svc.startedAt = undefined
    svc.lines.push('■ stop requested (process may still be finishing)')
  }
  redraw($)
  return `${svc.label} stopped.`
}

async function restartService($: Api, name: string): Promise<string> {
  if (services[name]?.run) await stopService($, name)
  return (await startService($, name)).replace('started', 'restarted')
}

async function serviceAction($: Api, name: string, action: string): Promise<string> {
  const svc = services[name]
  if (!svc) return `Unknown service "${name}". Known: ${Object.keys(services).join(', ')}`
  if (action === 'start') return startService($, name)
  if (action === 'stop') return stopService($, name)
  if (action === 'restart') return restartService($, name)
  if (action === 'logs') return `${svc.label}, last 60 lines:\n` + (redact(svc.lines.slice(-60).join('\n')) || '(no output)')
  const state = svc.run
    ? `${svc.label} is running (${ago(svc.startedAt ?? Date.now())}), started by this session.`
    : `${svc.label} is not running in this session; lara-cc can't see one run elsewhere.`
  return name === 'queue' ? state + '\n' + queueSummary() : state
}

// ─── Queue monitoring ──────────────────────────────────────────────────────

function onWorkerLine($: Api, line: string) {
  const ev = parseWorkerLine(line)
  if (!ev) return
  if (ev.status === 'RUNNING') {
    jobs.push({ job: ev.job, time: ev.time, status: 'running' })
  } else {
    const ms = durationMs(ev.duration)
    const status = ev.status === 'DONE' ? 'done' : 'failed'
    let i = jobs.length - 1
    while (i >= 0 && !(jobs[i]?.status === 'running' && jobs[i]?.job === ev.job)) i--
    const job = jobs[i]
    if (job) Object.assign(job, { status, ms })
    else jobs.push({ job: ev.job, time: ev.time, status, ms })
    if (status === 'done') {
      stats.done += 1
      stats.totalMs += ms ?? 0
    } else {
      stats.failed += 1
      toast($, `Job failed: ${shortClass(ev.job)}`)
      // The failed_jobs row is written just after the line; look again shortly
      $.clock.after(1500, () => void refreshQueue($))
    }
  }
  if (jobs.length > 100) jobs.splice(0, jobs.length - 100)
}

/** Read the queue state. One read at a time: a call while one runs gets that read (recheck then reads again). */
function refreshQueue($: Api): Promise<void> {
  if (!isLaravel) return Promise.resolve()
  if (snapshotLoad) return snapshotLoad
  const project = projectRun
  const loading = (async () => {
    try {
      const r = await runPhp($, ['php', '-r', snapshotPhp(queuesOf(services.queue.argv))], { timeoutMs: 30_000 })
      // Another folder's queue: detectProject has cleared the snapshot and the read in progress
      if (project !== projectRun) return
      const parsed = parseSnapshot(r.stdout)
      // Taken when it counted the jobs waiting; one that failed there keeps the last good read, so no count reads as current that isn't
      sizesRead = !!parsed && (!parsed.error || !!parsed.partial)
      if (parsed && sizesRead) {
        waitingAtTick ??= waiting(parsed)
        // A partial read's failed-job count is the PHP default 0, not a count: the last one stays (marked, see the band)
        snapshot = parsed.partial && snapshot ? { ...parsed, failedTotal: snapshot.failedTotal, failed: snapshot.failed } : parsed
      }
      if (parsed && !parsed.error) snapshotOkAt = Date.now()
      snapshotError = parsed ? (parsed.error ?? '') : clip(redact(stripAnsi(r.stderr || r.stdout).trim().split('\n')[0] ?? ''), 300) || 'Could not read the queue state.'
      snapshotKind = parsed ? parsed.errorKind || errorKind(parsed.error ?? '') : errorKind(r.stderr + '\n' + r.stdout)
    } catch (err) {
      if (project !== projectRun) return
      sizesRead = false
      snapshotError = String(err)
      snapshotKind = "it timed out or couldn't run"
    }
    snapshotAt = Date.now()
    // Only the backlog warning depends on the snapshot: swap it in without running every check
    const backlog = backlogCheck($)
    checks = [...checks.filter(c => !c.backlog), ...(backlog ? [backlog] : [])]
    redraw($)
  })().finally(() => {
    // Not one a later folder started (leaveProject let go of this one)
    if (snapshotLoad === loading) snapshotLoad = undefined
  })
  snapshotLoad = loading
  redraw($)
  return loading
}

/** Jobs waiting across the snapshot's queues. */
function waiting(snap: QueueSnapshot): number {
  return Object.values(snap.sizes).reduce((n, size) => n + (Number(size) || 0), 0)
}

/** `default: 3, emails: 1`: the snapshot's queues with jobs waiting. */
function waitingSizes(snap: QueueSnapshot): string {
  return Object.entries(snap.sizes).filter(([, n]) => n).map(([q, n]) => `${q}: ${n}`).join(', ')
}

/** Fewer jobs wait than at the read before while this session runs no worker: something elsewhere is working the queue. */
function drainingNote(): string {
  if (services.queue.run || !snapshot || !sizesRead || waitingBefore === undefined || waiting(snapshot) >= waitingBefore) return ''
  return `Jobs waiting went from ${waitingBefore} to ${waiting(snapshot)} since the read before, so a worker elsewhere seems to be working the queue.`
}

/** How the last queue read failed, for Claude: the kind only, since the message can name a host. */
function queueReadFailure(): string {
  return `${sizesRead ? "couldn't count the failed jobs" : 'failed'} (${snapshotKind || 'no reason given'})`
}

/** Claude's answer when the failed jobs aren't known (no read, or a read that failed or couldn't count them). */
function queueUnread(): string {
  return `The queue read ${queueReadFailure()}; the full message is on lara-cc's Queue tab, shown only to the user.`
}

async function retryFailed($: Api, id: string): Promise<string> {
  const run = await runCommand($, `queue:retry ${id}`, ['php', 'artisan', 'queue:retry', id], 60_000)
  await refreshQueue($)
  return formatRun(run)
}

async function forgetFailed($: Api, id: string): Promise<string> {
  const run = await runCommand($, `queue:forget ${id}`, ['php', 'artisan', 'queue:forget', id], 60_000)
  await refreshQueue($)
  return formatRun(run)
}

function queueSummary(): string {
  const avg = stats.done ? Math.round(stats.totalMs / stats.done) : 0
  const lines = [
    `This session: ${stats.done} done, ${stats.failed} failed${stats.done ? `, avg ${avg}ms` : ''}.`,
  ]
  if (snapshot) {
    lines.push(`Connection: ${snapshot.connection}${snapshot.connection === 'sync' ? ' (jobs run inline; no worker needed)' : ''}`)
    lines.push('Pending: ' + (Object.entries(snapshot.sizes).map(([q, n]) => `${q}=${n}`).join(', ') || 'unknown'))
    lines.push(`Failed jobs stored: ${sizesRead && snapshotError ? 'unknown' : snapshot.failedTotal}`)
  }
  const draining = drainingNote()
  if (draining) lines.push(draining)
  // The kind only: the message can name a host, and it's on the Queue tab for the person
  if (snapshotError) {
    lines.push(`Note: the last queue read ${queueReadFailure()}; the full message is on lara-cc's Queue tab, shown only to the user.`)
  }
  const recent = jobs.slice(-10).map(j => `  ${j.status === 'done' ? '✓' : j.status === 'failed' ? '✗' : '…'} ${j.time} ${j.job}${j.ms !== undefined ? ` ${Math.round(j.ms)}ms` : ''}`)
  if (recent.length) lines.push('Recent jobs:', ...recent)
  return lines.join('\n')
}

function formatFailed(list: FailedJob[], withTrace: number): string {
  if (!list.length) return 'No failed jobs.'
  return list
    .map((f, i) => {
      // Redacted whole, before the headline is cut to length
      const exception = redact(f.exception)
      const rest = i < withTrace ? exception.split('\n').slice(1, 13).filter(l => l.trim()) : []
      const trace = rest.length ? '\n' + rest.map(l => '    ' + l).join('\n') : ''
      return `- ${f.id}  ${f.job}  (queue ${f.queue}, failed ${f.failedAt})\n  ${exceptionHeadline(exception)}${trace}`
    })
    .join('\n')
}

async function askAboutFailedJob($: Api, f: FailedJob) {
  if (!(await mayShare($, 'this failed job and its exception'))) return
  const text = [
    'This queued job failed in my Laravel app. Find the cause and fix it. When fixed, retry it with the queue tool.',
    '',
    `Job: ${f.job}`,
    `Failed job id: ${f.id}`,
    `Queue: ${f.queue}, failed at ${f.failedAt}`,
    '',
    '```',
    redact(f.exception.split('\n').slice(0, 40).join('\n')),
    '```',
  ].join('\n')
  sendToClaude($, text)
}

// ─── Log monitoring ────────────────────────────────────────────────────────

/** The newest laravel*.log in storage/logs (single or daily channel). */
async function newestLog($: Api): Promise<string> {
  const dir = 'storage/logs'
  try {
    const files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && /^laravel(-\d{4}-\d\d-\d\d)?\.log$/.test(f.name))
    let best = ''
    let bestTime = -1
    for (const f of files) {
      const s = await $.fs.stat(dir + '/' + f.name)
      if (s.mtimeMs > bestTime) {
        best = f.name
        bestTime = s.mtimeMs
      }
    }
    if (best) return dir + '/' + best
  } catch {
    // no storage/logs yet
  }
  return dir + '/laravel.log'
}

/** The tail stopped (or is being replaced): the log isn't followed until the next one starts. */
function openLogGap(now: number) {
  const last = logGaps.at(-1)
  if (!logSince || (last && last.to === undefined)) return
  logGaps.push({ from: now })
  if (logGaps.length > 50) logGaps.shift()
}

/** A tail started: the first one marks when following began here, a later one ends the gap since the last stopped. */
function closeLogGap(now: number) {
  logSince ||= now
  const last = logGaps.at(-1)
  if (last && last.to === undefined) last.to = now
}

/** Follow the newest log file; called at start and every minute, so a new daily file is picked up. */
async function watchLog($: Api) {
  if (!isLaravel) return
  const project = projectRun
  let loaded = () => {}
  const ready = new Promise<void>(resolve => (loaded = resolve))
  const previous = logReady
  logReady = ready
  try {
    // One watch at a time, so two overlapping calls can't start two tails
    await previous
    const path = await newestLog($)
    if (project !== projectRun) return
    if (path === logPath && logRun) {
      const looked = await nowMs($)
      if (project === projectRun) logLookedAt = looked
      return
    }
    // Let go of the old tail at once (before anything is awaited), so what it still sends while the new file is read isn't taken for it
    const old = logRun
    logRun = undefined
    if (old) {
      void old.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
      // The new file may have begun at any time since the last look, and what it already holds is read as history,
      // not counted: the gap starts there, so an interval that touches it isn't called quiet
      const from = logLookedAt || (await nowMs($))
      if (project !== projectRun) return
      openLogGap(from)
    }

    logPath = path
    const state = newLogState()
    logState = state
    try {
      const r = await $.process.run(['tail', '-n', '400', path], { timeoutMs: 10_000 })
      if (r.exitCode === 0) feedLog(state, r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n')
    } catch {
      // the file may not exist yet; tail -F below waits for it
    }
    if (project !== projectRun) return

    const stream = $.process.spawn({ argv: ['tail', '-n', '0', '-F', path] })
    const run = { stream }
    logRun = run
    logLookedAt = await nowMs($)
    closeLogGap(logLookedAt)
    void (async () => {
      try {
        for await (const chunk of stream) {
          // A tail replaced by another (a new daily file, another folder) may still deliver a chunk
          if (chunk.stream !== 'stdout' || logRun !== run) continue
          const at = await nowMs($)
          if (logRun === run) onLogEntries($, feedLog(logState, chunk.text), at)
        }
      } catch {
        // stream closed
      }
      const ended = await nowMs($)
      if (logRun === run) {
        logRun = undefined
        openLogGap(ended)
      }
    })()
    redraw($)
  } finally {
    loaded()
  }
}

/** `at`: when the chunk arrived ($.clock.now). */
function onLogEntries($: Api, entries: LogEntry[], at: number) {
  const errors = entries.filter(isError)
  if (errors.length) {
    const viewing = paneOpen && tab === 'log'
    if (!viewing) unseenErrors += errors.length
    const last = errors[errors.length - 1]
    if (last && settings.errorToasts) toast($, `Laravel ${last.level.toLowerCase()}: ${headline(last)}`)
    // Counted by when it arrived here (the entry's own stamp has no timezone), from the first edit to ten minutes after the turn ended
    if (since && last && at <= (since.closedAt ?? Infinity) + ERROR_WINDOW_MS) {
      since.errors += errors.length
      since.newestError = last
    }
  }
  redraw($)
}

function filteredLog(filter: 'all' | 'warnings' | 'errors'): LogEntry[] {
  const all = logState.entries
  if (filter === 'errors') return all.filter(isError)
  if (filter === 'warnings') return all.filter(e => isError(e) || isWarning(e))
  return all
}

/** Wait for the log's history to be read, so a call right after start sees it. */
async function logsLoaded() {
  await logReady
}

function logsText(filter: 'all' | 'warnings' | 'errors', count: number): string {
  const list = filteredLog(filter).slice(-count)
  if (!list.length) return `No ${filter === 'all' ? 'entries' : filter} in ${logPath || 'storage/logs'}.`
  const noun = filter === 'all' ? (list.length === 1 ? 'entry' : 'entries') : plural(list.length, filter.replace(/s$/, '')).replace(/^\d+ /, '')
  return `Latest ${list.length} ${noun} from ${logPath}:\n\n` + list.map(e => redact(formatEntry(e, 15, projectDir))).join('\n\n')
}

/** What Claude gets when the person says no: why there's no text, and what to do instead. */
const NOT_SHARED = 'The user chose not to send this to Claude, since logs and exceptions can contain confidential data. Ask them to describe the error instead.'

/**
 * Ask before log entries or failed-job exceptions go to Claude: they can hold confidential data that redact()
 * doesn't catch. "Allow this session" stops the asking until the session ends; dismissed or headless is no.
 */
async function mayShare($: Api, what: string): Promise<boolean> {
  if (shareAllowed) return true
  const question =
    'Logs and exceptions can contain confidential data: emails, SQL values, tokens, request data. lara-cc hides passwords, keys, tokens, emails, SQL values and stack arguments first, but cannot catch everything. ' +
    `Send ${what} to Claude?`
  const answer = await $.ui.ask(question, { header: 'Privacy', options: ['Send redacted', 'Allow this session', "Don't send"] }).catch(() => "Don't send")
  if (answer === 'Allow this session') shareAllowed = true
  return answer === 'Send redacted' || answer === 'Allow this session'
}

/** `1 log entry`, `5 log entries`: the most recent `count` of `filter` that would be sent. */
function entriesToSend(filter: 'all' | 'warnings' | 'errors', count: number): string {
  const n = Math.min(count, filteredLog(filter).length)
  return n === 1 ? '1 log entry' : `${n} log entries`
}

async function askAboutError($: Api, entry: LogEntry) {
  if (!(await mayShare($, 'this log entry'))) return
  const text = [
    `This error appeared in my Laravel log (${logPath}). Find the cause and fix it.`,
    '',
    '```',
    redact(formatEntry(entry, 30, projectDir)),
    '```',
  ].join('\n')
  sendToClaude($, text)
}

async function clearLog($: Api) {
  if (!logPath) return
  await $.fs.write(logPath, '')
  logState = newLogState()
  unseenErrors = 0
  redraw($)
}

// ─── Project info ──────────────────────────────────────────────────────────

/**
 * The routes, read with routesPhp: one PHP boot for route:list's columns and where each route's code is. Serves
 * the Routes tab, /lara-routes and Claude's routes tool. One load at a time; one for a folder the session has
 * left since is dropped.
 */
function loadRouteList($: Api): Promise<void> {
  if (routesLoading) return routesLoading
  const load = ++routeLoads
  const loading = (async () => {
    try {
      const r = await runPhp($, ['php', '-r', routesPhp()], { timeoutMs: 60_000 })
      if (load !== routeLoads) return
      const parsed = parseRoutes(r.stdout)
      if (parsed) ({ routes: routeList, editor: appEditor } = parsed)
      routesError = parsed ? '' : failureReason([r.stderr, r.stdout].join('\n')) || 'Could not read the routes.'
    } catch (err) {
      if (load === routeLoads) routesError = 'Could not read the routes: ' + String(err)
    } finally {
      if (load === routeLoads) routesLoading = undefined
      redraw($)
    }
  })()
  routesLoading = loading
  return loading
}

/** The routes for /lara-routes and Claude's tool, filtered; why not, redacted, when they can't be read. */
async function routesText($: Api, filter: string): Promise<string> {
  await loadRouteList($)
  if (routesError || !routeList) return redact(routesError || 'Could not read the routes.')
  const shown = filterRoutes(routeList, filter)
  return tail(`${shown.length} of ${routeList.length} routes\n` + shown.map(formatRoute).join('\n'))
}

/**
 * Why a PHP run failed, in a line: its first line that isn't a PHP warning, with the message after it when that
 * line is only an exception's class (as Collision prints it).
 */
function failureReason(output: string): string {
  const lines = stripAnsi(output)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^(PHP )?(Deprecated|Warning|Notice):/i.test(l))
  const [first = '', second] = lines
  return clip(redact(/^[\w\\]+$/.test(first) && second ? `${first}: ${second}` : first), 300)
}

/** Put the focus ring on the selected route, so the arrows browse the list and Enter opens one straight away. */
async function focusRoute($: Api) {
  if (!paneOpen || tab !== 'routes' || !routeList || !filterRoutes(routeList, routeFilter).length) return
  await $.ui.focus({ requestId: PANE, key: 'route-' + routeAt }).catch(() => undefined)
}

/** `GET /users/{user}`. */
function routeLabel(r: { method: string; uri: string }): string {
  return `${methodLabel(r.method)} ${uriText(r)}`
}

/**
 * Enter on a route: open its code in the editor, or its page in the browser (GET routes), asking which when
 * both apply. Only the person's press.
 */
async function openRoute($: Api, r: TabRoute) {
  const file = r.file ? `Open ${r.file.split('/').pop()}:${r.line}` : undefined
  const page = r.method.split('|').includes('GET') ? 'Open in browser' : undefined
  const options = [file, page].filter((o): o is string => !!o)
  if (!options.length) return $.ui.toast(`${routeLabel(r)}: no file found for its code, and only GET routes open in the browser`, { timeoutMs: 6000 })
  const pick = options.length > 1 ? await $.ui.ask(`${routeLabel(r)}: open its code or its page?`, { header: 'Route', options }).catch(() => '') : options[0]
  if (r.file && pick === file) await openFile($, r.file, r.line ?? 1)
  else if (pick === page) await openPage($, r)
}

/** What opens a file or a link: `open` on macOS, `xdg-open` elsewhere (Linux has an unrelated `open`). */
function openCommand($: Api): Promise<string> {
  opener ??= $.process.run(['uname', '-s'], { timeoutMs: 5_000 }).then(
    r => (r.stdout.trim() === 'Darwin' ? 'open' : 'xdg-open'),
    () => 'open',
  )
  return opener
}

/**
 * Open a route's file at its line: in the editor Laravel's `app.editor` setting names, else the one whose terminal
 * Claude Code runs in. Without one, or when the editor's link doesn't open, in whatever opens .php files (no line).
 */
async function openFile($: Api, file: string, line: number) {
  const path = file.startsWith('/') ? file : `${projectDir}/${file}`
  const [open, bundle, program, emulator] = await Promise.all([openCommand($), $.env.get('__CFBundleIdentifier'), $.env.get('TERM_PROGRAM'), $.env.get('TERMINAL_EMULATOR')])
  const editor = appEditor || terminalEditor(bundle, program, emulator)
  const opens = (target: string) => $.process.run([open, target], { timeoutMs: 15_000 }).then(r => r.exitCode === 0, () => false)
  if (editor && (await opens(editorHref(editor, path, line)))) return
  if (!(await opens(path))) $.ui.toast(`Couldn't open ${file}`, { timeoutMs: 8000 })
  else if (editor) $.ui.toast(`${editor} didn't open it, so ${file} opened as a file (without line ${line})`, { timeoutMs: 8000 })
  else $.ui.toast(`Opened ${file}. To land on line ${line}, set 'editor' (e.g. phpstorm, vscode) in config/app.php`, { timeoutMs: 8000 })
}

/**
 * Open a GET route's page in the browser, asking for each value its URL needs. PHP builds the URL with Laravel's
 * own generator and opens it, so the URL never reaches the mod or Claude.
 */
async function openPage($: Api, r: TabRoute) {
  const values: Record<string, string> = {}
  for (const param of r.params) {
    const value = (await $.ui.ask(`Value for {${param}} in ${routeLabel(r)}?`, { header: 'Route', options: ['1', 'Cancel'] }).catch(() => 'Cancel')).trim()
    if (value === 'Cancel') return
    // Empty, the URL would quietly be another route's (/users/ for /users/{user})
    if (!value) return $.ui.toast(`{${param}} needs a value, so ${routeLabel(r)} wasn't opened`, { timeoutMs: 6000 })
    values[param] = value
  }
  try {
    const run = await runPhp($, ['php', '-r', openPagePhp(), '--', String(r.id), r.method, r.uri, JSON.stringify(values)], { timeoutMs: 30_000 })
    const why = pageNotOpened(run.stdout)
    $.ui.toast(why ? `Couldn't open ${routeLabel(r)}: ${why}` : `Opened ${routeLabel(r)} in the browser`, { timeoutMs: 6000 })
  } catch (err) {
    $.ui.toast(`Couldn't open ${routeLabel(r)}: ${String(err)}`, { timeoutMs: 8000 })
  }
}

/** The routes whose method (as shown: `ANY`, no `HEAD`), URI, name or action holds `filter`. */
function filterRoutes(list: TabRoute[], filter: string): TabRoute[] {
  const f = filter.trim().toLowerCase()
  if (!f) return list
  return list.filter(r => `${methodLabel(r.method)} ${uriText(r)} ${r.name ?? ''} ${r.action}`.toLowerCase().includes(f))
}

function formatRoute(r: { method: string; uri: string; name: string | null; action: string }): string {
  return `${methodLabel(r.method).padEnd(9)} ${uriText(r)}${r.name ? '  ' + r.name : ''}  ${shortClass(r.action)}`
}

/** `/users/{user}`. */
function uriText(r: { uri: string }): string {
  return '/' + r.uri.replace(/^\//, '')
}

/** `text` cut to `n` columns with an ellipsis, and padded to `n` unless `pad` is false. */
function fit(text: string, n: number, pad = true): string {
  if (n <= 0) return ''
  const cut = text.length > n ? text.slice(0, n - 1) + '…' : text
  return pad ? cut.padEnd(n) : cut
}

/** The Routes tab's method colors; any other method (OPTIONS, ANY) is magenta. */
const METHOD_COLORS: Record<string, string> = { GET: 'green', POST: 'yellow', PUT: 'blue', PATCH: 'blue', DELETE: 'red' }

/** By the method as shown (`methodLabel`), so ANY isn't drawn as GET. */
function methodColor(label: string): string {
  const first = label.split('|')[0] ?? ''
  return Object.hasOwn(METHOD_COLORS, first) ? METHOD_COLORS[first]! : 'magenta'
}

async function loadAbout($: Api) {
  const project = projectRun
  const read = runPhp($, ['php', '-r', connectionsPhp()], { timeoutMs: 30_000 }).catch(() => undefined)
  // A failed read keeps the last result, dated by aboutAt and marked by aboutFailed, rather than forgetting it
  let found = about
  let failed = ''
  try {
    const r = await runPhp($, ['php', 'artisan', 'about', '--json'], { timeoutMs: 60_000 })
    const json = r.exitCode === 0 ? (phpJson(r.stdout) as typeof about) : undefined
    if (json) found = json
    else failed = r.exitCode === 0 ? 'unreadable output' : errorKind(r.stdout + '\n' + r.stderr) || 'exit ' + r.exitCode
  } catch {
    // A run that throws (timeout, no PHP) carries no PHP output to take a kind from
    failed = "it timed out or couldn't run"
  }
  const conn = await read
  // Read for a folder the session has since left
  if (project !== projectRun) return
  about = found
  aboutFailed = failed
  if (about && !failed) aboutAt = Date.now()
  if (conn) connections = parseConnections(conn.stdout) ?? connections
  redraw($)
}

async function checkMigrations($: Api) {
  const project = projectRun
  // Only the newest run writes, so a re-check that started before the migrate fix can't bring the old count back
  const run = ++migrationRuns
  const seq = editCount
  let failed = ''
  try {
    const r = await runPhp($, ['php', 'artisan', 'migrate:status', '--no-ansi'], { timeoutMs: 60_000 })
    if (project !== projectRun || run !== migrationRuns) return
    if (r.exitCode !== 0) failed = errorKind(r.stdout + '\n' + r.stderr) || 'exit ' + r.exitCode
    else {
      const before = pendingMigrations
      pendingMigrations = r.stdout.split('\n').filter(l => /\bPending\b/.test(l)).length
      migrationsAt = Date.now()
      migrationsSeq = seq
      // Only when the count rose: the health tool reads it again on every call
      if (pendingMigrations > before) toast($, `${plural(pendingMigrations, 'pending migration')}. Run /lara-artisan migrate`)
    }
  } catch {
    if (project !== projectRun || run !== migrationRuns) return
    // Timed out or couldn't run: the count stays, marked stale, rather than reading as zero
    failed = "it timed out or couldn't run"
  }
  migrationsFailed = failed
  redraw($)
}

// ─── Health checks ─────────────────────────────────────────────────────────

/** Laravel's cache files: while one exists, edits to what it caches don't take effect. */
const CACHE_FILES = { config: 'bootstrap/cache/config.php', routes: 'bootstrap/cache/routes-v7.php', events: 'bootstrap/cache/events.php' }

/**
 * Look for things that quietly break the app and show them in the band: a production environment, maintenance
 * mode, cached config/routes/events, a public/hot pointing at a dead Vite, a stopped Herd service the app uses,
 * and dependencies out of step with the lockfiles. Reads lockfiles and Laravel's marker files, never .env. Cheap: lockfiles are re-read only when changed.
 * What each check found fine goes to checkedFine, for Claude's health tool. Update healthText's Never checked line when a check is added.
 */
async function checkHealth($: Api): Promise<void> {
  if (!isLaravel) return
  // One run at a time; a request that arrives meanwhile runs again afterwards, and waits for that run
  if (checking) {
    checkAgain = true
    return checksDone
  }
  checking = true
  let done = () => {}
  checksDone = new Promise<void>(resolve => (done = resolve))
  const project = projectRun
  try {
    const next: Check[] = []
    const fine: Fine[] = []
    // What about said is as old as the last time it worked
    const aboutStale = aboutFailed ? `; read ${ago(aboutAt)} ago, and artisan about has failed since (${aboutFailed})` : ''
    if (about?.environment?.environment === 'production') {
      next.push({
        band: 'env: production',
        color: 'red',
        known: 'seen',
        detail: 'APP_ENV is production on this machine: errors are hidden and migrations need --force.',
        evidence: `artisan about says APP_ENV is production${aboutStale}`,
        fromAbout: true,
      })
    }
    const [down, hot, ...cacheFiles] = await Promise.all([
      $.fs.exists('storage/framework/down'),
      viteProbe($),
      ...Object.values(CACHE_FILES).map(f => $.fs.exists(f)),
    ])
    // The file covers the default driver; about covers the cache driver too
    if (down || about?.environment?.maintenance_mode === true) {
      next.push({
        band: 'maintenance mode',
        color: 'red',
        known: 'seen',
        detail: 'The app answers every request with 503 (storage/framework/down). `artisan up` brings it back.',
        evidence: down ? 'storage/framework/down exists' : `artisan about reports maintenance mode (cache driver)${aboutStale}`,
        fix: { label: 'up', run: artisanFix($, [['up']]) },
        claude: await artisanStep($, ['up']),
        ...(down ? {} : { fromAbout: true as const }),
      })
    } else if (about && !aboutFailed) {
      fine.push({ known: 'seen', evidence: 'not in maintenance mode (no storage/framework/down, and artisan about agrees)' })
    } else {
      fine.push({ known: 'inferred', evidence: `no storage/framework/down; maintenance through the cache driver needs artisan about, which ${aboutFailed ? 'failed' : "hasn't answered"}` })
    }
    const cached = Object.keys(CACHE_FILES).filter((_, i) => cacheFiles[i])
    if (cached.length) {
      const list = cached.join(', ')
      // Only the caches that exist: optimize:clear would also empty the application cache
      const clear = cached.map(c => CLEAR_COMMANDS[c as keyof typeof CACHE_FILES])
      next.push({
        band: `${cached.join('+')} cached`,
        color: 'yellow',
        known: 'seen',
        detail: `Laravel is using cached ${list}, so edits to them don't take effect until the cache is cleared (${clear.join(', ')}).`,
        evidence: `${cached.map(c => CACHE_FILES[c as keyof typeof CACHE_FILES]).join(', ')} ${cached.length > 1 ? 'exist' : 'exists'}`,
        fix: { label: 'clear', run: artisanFix($, clear.map(c => [c])) },
        claude: await artisanStep($, clear),
      })
    } else {
      fine.push({ known: 'seen', evidence: 'no cached config, routes or events in bootstrap/cache' })
    }
    // Only the port ever reaches a string: the host stays in public/hot
    if (hot.state === 'down') {
      next.push({
        band: 'Vite not running (public/hot)',
        color: 'yellow',
        known: 'seen',
        detail: "public/hot points pages at a Vite dev server that isn't running, so they load without CSS and JS. Start Vite, or delete public/hot.",
        evidence: `public/hot names port ${hot.port} on this machine, and nothing accepts connections there (curl exit 7)`,
        fix: { label: 'start vite', run: () => startService($, 'vite') },
        claude: serviceStep('vite', 'start'),
      })
    } else if (hot.state === 'unknown') {
      next.push({
        band: 'Vite unchecked (public/hot)',
        color: 'yellow',
        known: 'unknown',
        detail: `public/hot points pages at a dev server on port ${hot.port} of this machine, but lara-cc couldn't tell whether it answers (${hot.exit}).`,
        evidence: `public/hot names port ${hot.port} on this machine; ${hot.exit}, so whether a dev server answers there is unknown`,
        claude: `ask the user whether a dev server runs there; ${serviceStep('vite', 'start')}`,
      })
    } else if (hot.state === 'up') {
      fine.push({ known: 'inferred', evidence: `public/hot names port ${hot.port} on this machine and something gives a web reply there (not checked to be this app's Vite)` })
    } else if (hot.state === 'here') {
      fine.push({ known: 'seen', evidence: 'Vite runs in this session' })
    } else if (hot.state === 'none') {
      fine.push({ known: 'seen', evidence: 'no public/hot, so pages use the built assets' })
    }
    const backlog = backlogCheck($)
    if (backlog) next.push(backlog)
    const [herd, deps] = await Promise.all([checkHerd($, fine), checkDeps($, fine)])
    next.push(...herd, ...deps)
    // Checked a folder the session has since left: the run requested meanwhile checks the new one
    if (project === projectRun) {
      checks = next
      checkedFine = fine
      checkedAt = Date.now()
      checksMissed = 0
      checksFailed = ''
    }
  } catch (err) {
    $.ui.log('lara-cc: health check failed: ' + String(err))
    // The last results stay, marked stale (see checksStale); the error itself is in the log, for the person
    if (project === projectRun) checksFailed = 'a file read or probe threw'
  } finally {
    checking = false
  }
  redraw($)
  try {
    // Awaited, so whoever waits on checksDone gets the run that started after they asked
    if (checkAgain) {
      checkAgain = false
      await checkHealth($)
    }
  } finally {
    done()
  }
}

/** The checks' results can't be trusted as current: the last run failed, or none has finished for CHECKS_STALE minute ticks. */
function checksStale(): boolean {
  return !!checksFailed || checksMissed >= CHECKS_STALE
}

/** Read again what the health tool reports: the checks, the queue and migrate:status. All reads, so the health tool and the person's recheck run it unasked. */
async function recheck($: Api) {
  // A queue read already running started before this call: wait for it, then read again
  const queue = async () => {
    await snapshotLoad
    await refreshQueue($)
  }
  await Promise.all([checkHealth($), queue(), checkMigrations($)])
}

/** The artisan commands that clear each cache file. */
const CLEAR_COMMANDS: Record<keyof typeof CACHE_FILES, string> = { config: 'config:clear', routes: 'route:clear', events: 'event:clear' }

/** A fix that runs these artisan commands in turn (shown on the Commands tab), stopping at the first that fails. */
function artisanFix($: Api, commands: string[][]): Fix['run'] {
  return async () => {
    for (const args of commands) {
      const run = await runCommand($, 'artisan ' + args.join(' '), ['php', 'artisan', ...args, '--no-interaction'])
      if (run.exitCode !== 0) return `✗ artisan ${args.join(' ')} (exit ${run.exitCode}); output on the Commands tab`
    }
    return `✓ artisan ${commands.map(c => c.join(' ')).join(', ')}`
  }
}

/** Run the pending migrations, then count them again so the band's warning goes. */
function migrateFix($: Api): Fix['run'] {
  const migrate = artisanFix($, [['migrate']])
  return async () => {
    const said = await migrate()
    await checkMigrations($)
    return said
  }
}

/** A fix that runs one command (Composer, npm), shown on the Commands tab. */
function commandFix($: Api, label: string, argv: string[]): Fix['run'] {
  return async () => {
    const run = await runCommand($, label, argv)
    return run.exitCode === 0 ? `✓ ${label}` : `✗ ${label} (exit ${run.exitCode}); output on the Commands tab`
  }
}

/**
 * Jobs waiting while this session runs no worker, so they won't run unless one runs elsewhere. Left out when the
 * count dropped since the read before (see drainingNote): a worker elsewhere (another terminal, Horizon) is draining it.
 */
function backlogCheck($: Api): Check | undefined {
  // Counts from a read that failed aren't current; a partial read's are (only the failed jobs weren't counted)
  if (!snapshot || !sizesRead || snapshot.connection === 'sync' || services.queue.run) return undefined
  const now = waiting(snapshot)
  if (!now || drainingNote()) return undefined
  const sizes = waitingSizes(snapshot)
  const before = waitingBefore
  const trend =
    before === undefined
      ? "This is the first read, so it can't tell yet whether they're being worked off. "
      : `The count hasn't dropped since the read before (${before}), so nothing seems to be working them off. `
  return {
    band: `${plural(now, 'job')} waiting, no worker in this session`,
    color: 'yellow',
    known: 'inferred',
    detail:
      `${plural(now, 'job')} waiting on the ${snapshot.connection} queue (${sizes}) and no worker runs in this session, so they won't run unless one runs elsewhere (another terminal, Supervisor), which lara-cc can't see. ` +
      trend +
      'Delayed jobs count too.',
    evidence: `${now} waiting on the ${snapshot.connection} queue (${sizes}), ${before === undefined ? 'first read' : `${before} at the read before`}; no worker runs in this session; one elsewhere is not ruled out`,
    fix: { label: 'start worker', run: () => startService($, 'queue') },
    claude: `ask the user whether a worker runs elsewhere; ${serviceStep('queue', 'start')}`,
    backlog: true,
  }
}

/**
 * Run a check's fix: the band's or the Services tab's button, so only ever the person's press. Shows how it
 * went, then checks again so the warning clears.
 */
async function runFix($: Api, fix: Fix) {
  if (fixing.has(fix.label)) return
  fixing.add(fix.label)
  redraw($)
  try {
    const said = await fix.run()
    if (said) $.ui.toast(said, { timeoutMs: 6000 })
  } catch (err) {
    $.ui.toast(`${fix.label} failed: ${String(err)}`, { timeoutMs: 8000 })
  } finally {
    fixing.delete(fix.label)
    redraw($)
    void checkHealth($)
  }
}

/**
 * What public/hot's dev server says: 'none' (no public/hot), 'here' (this session runs Vite), 'remote' (another machine:
 * never probed), else curl at its local port: 'up' (a web reply), 'down' (exit 7: nothing accepts connections),
 * 'unknown' (anything else, curl missing included; `exit` names it). Only the port ever leaves this function.
 */
async function viteProbe($: Api): Promise<{ state: 'none' | 'here' | 'remote' | Probe; port?: number; exit?: string }> {
  if (!(await $.fs.exists('public/hot'))) return { state: 'none' }
  if (services.vite.run) return { state: 'here' }
  const url = localHotUrl(await $.fs.read('public/hot').catch(() => ''))
  if (!url) return { state: 'remote' }
  const port = hotPort(url)
  // -q first so a ~/.curlrc can't change the request; -k because local dev certificates are often self-signed
  const r = await $.process.run(['curl', '-q', '-s', '-o', '/dev/null', '-m', '2', '-k', url + '/'], { timeoutMs: 5_000 }).catch(() => undefined)
  if (r?.exitCode === 0) return { state: 'up', port }
  if (r?.exitCode === 7) return { state: 'down', port }
  // A timeout, a TLS or DNS failure, curl missing: none of these says whether a server is there
  return { state: 'unknown', port, exit: r ? `curl exit ${r.exitCode}` : "curl couldn't run" }
}

/**
 * Herd services the app connects to that aren't running, e.g. MySQL stopped while the database is on its port.
 * Reads Herd's services.plist (type, port, version: no credentials), never its site list, and only checks this
 * machine at the ports it names. A server on a port no Herd service has (Docker, DBngin, remote) is left alone.
 */
async function checkHerd($: Api, fine: Fine[]): Promise<Check[]> {
  const installed = await herdInstalledServices($)
  const up = await Promise.all(installed.map(s => probePort($, s.port)))
  herdList = installed.map((s, i) => ({ ...s, up: up[i]! }))
  const needs = herdNeeds(connections ?? [], herdList)
  const stopped: Check[] = needs
    .filter(need => need.service.up === 'down')
    .map(({ service: s, driver, uses }) => ({
      band: `Herd ${s.name} stopped`,
      color: 'red' as const,
      known: 'seen' as const,
      detail: `The app's ${uses.join(', ')} uses ${driver} on port ${s.port}, and Herd's ${s.name} ${s.version} there isn't running, so anything that needs it fails.`,
      evidence: `nothing accepts connections on localhost:${s.port}, where Herd's ${s.name} ${s.version} is set up; the app's ${uses.join(', ')} uses ${driver} there`,
      fix: { label: `start ${s.name}`, run: () => startHerdService($, s) },
    }))
  // A port that answers is a listener, maybe another server on the same port: not proof it's Herd's
  for (const { service: s, driver, uses } of needs.filter(need => need.service.up === 'up')) {
    fine.push({
      known: 'inferred',
      evidence: `localhost:${s.port} accepts connections, where Herd's ${s.name} ${s.version} is set up and the app's ${uses.join(', ')} uses ${driver} (a listener, not proof it's Herd's ${s.name})`,
    })
  }
  // Neither running nor stopped: say so once, rather than calling them fine
  const unchecked = needs.filter(need => need.service.up === 'unknown').map(need => need.service)
  if (unchecked.length) {
    const names = unchecked.map(s => `${s.name} (port ${s.port})`).join(', ')
    stopped.push({
      band: `Herd ${unchecked.map(s => s.name).join('+')} unchecked`,
      color: 'yellow',
      known: 'unknown',
      detail: `The app uses Herd's ${names}, but lara-cc couldn't tell whether ${unchecked.length > 1 ? 'they are' : 'it is'} running: nc is missing or didn't answer.`,
      evidence: `nc couldn't probe ${unchecked.map(s => 'localhost:' + s.port).join(', ')} (missing, timed out or an unexpected exit)`,
      claude: 'ask the user whether it is running (Herd → Services)',
    })
  }
  return stopped
}

/**
 * Start a Herd service: the Services tab's start button, so only ever the person's press, never Claude's.
 * Uses Herd's own AppleScript command (as Herd's MCP server does), with the type, port and version passed
 * as arguments rather than written into the script. macOS asks once whether the terminal may control Herd.
 */
async function startHerdService($: Api, s: HerdService) {
  if (herdStarting.has(s.port)) return
  herdStarting.add(s.port)
  redraw($)
  try {
    const script = ['on run argv', 'tell application "Herd" to start extraservice (item 1 of argv) port (item 2 of argv) version (item 3 of argv)', 'end run']
    const r = await $.process.run(['osascript', ...script.flatMap(line => ['-e', line]), s.type, String(s.port), s.version], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) {
      $.ui.toast(`Herd couldn't start ${s.name}: ${stripAnsi(r.stderr).trim().slice(0, 200) || 'exit ' + r.exitCode}`, { timeoutMs: 8000 })
      return
    }
    // Herd answers before the server listens. A probe that can't answer gets two more tries, not the whole wait
    let up = await probePort($, s.port)
    for (let i = 0; i < 20 && (up === 'down' || (up === 'unknown' && i < 2)); i++) {
      await $.clock.sleep(500)
      up = await probePort($, s.port)
    }
    const told = {
      up: `Herd ${s.name} started: port ${s.port} answers`,
      down: `Herd ${s.name} hasn't started yet; check Herd → Services`,
      unknown: `Herd was asked to start ${s.name}, but lara-cc couldn't check port ${s.port} (nc missing or not answering)`,
    }
    $.ui.toast(told[up], { timeoutMs: 6000 })
  } catch (err) {
    $.ui.toast(`Herd couldn't start ${s.name}: ${String(err)}`, { timeoutMs: 8000 })
  } finally {
    herdStarting.delete(s.port)
    void checkHealth($)
  }
}

/**
 * Start or stop Herd's debug session (Herd Pro): while it runs, Herd records the queries, logs, dumps and
 * HTTP calls the app makes, and stopping hands them over. Only the person's press. What it records can be
 * confidential, so it stays in the mod until they choose to send it, asked and redacted like logs.
 */
async function toggleDebugSession($: Api) {
  if (debugState === 'starting' || debugState === 'stopping') return
  const starting = debugState === 'off'
  const project = projectRun
  debugState = starting ? 'starting' : 'stopping'
  redraw($)
  let after: DebugState = starting ? 'off' : 'on'
  try {
    // Fixed script text: Herd's own commands, nothing from elsewhere written into it
    const command = starting ? 'tell application "Herd" to dumps start debug' : 'tell application "Herd" to dumps stop debug'
    const r = await $.process.run(['osascript', '-e', command], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) {
      const why = stripAnsi(r.stderr).trim().slice(0, 200) || 'exit ' + r.exitCode
      $.ui.toast(`Herd couldn't ${starting ? 'start' : 'stop'} the debug session (it needs Herd Pro): ${why}`, { timeoutMs: 8000 })
    } else if (starting) {
      after = 'on'
      debugCapture = undefined
      $.ui.toast('Herd is recording queries, logs, dumps and HTTP calls. Use the app, then stop the session.', { timeoutMs: 6000 })
    } else {
      after = 'off'
      // Dropped if the session moved to another folder while Herd answered
      if (project === projectRun) debugCapture = { ...parseDebugCapture(r.stdout), at: Date.now() }
    }
  } catch (err) {
    $.ui.toast(`Herd couldn't ${starting ? 'start' : 'stop'} the debug session: ${String(err)}`, { timeoutMs: 8000 })
  } finally {
    debugState = after
    redraw($)
  }
}

/** Send the debug session Herd recorded to Claude to look for problems: asked first, bound values and headers withheld. */
async function askAboutDebugCapture($: Api) {
  if (!debugCapture || !(await mayShare($, 'the debug session Herd recorded (queries, logs, dumps, HTTP calls)'))) return
  const json = JSON.stringify(redactData(debugCapture.data), null, 1)
  const text = [
    'Herd recorded this debug session in my Laravel app: queries, logs, dumps and HTTP calls. Look for problems, such as errors, slow or repeated (N+1) queries and failed requests, and fix them.',
    '',
    '```json',
    json.length > 30_000 ? json.slice(0, 30_000) + '\n…' : json,
    '```',
  ].join('\n')
  sendToClaude($, text)
}

/** What Herd's services.plist lists; empty without Herd. A half-written plist keeps the last read and is read again next time. */
async function herdInstalledServices($: Api): Promise<HerdService[]> {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (!home) return []
  const plist = `${home}/Library/Application Support/Herd/config/services.plist`
  const time = await mtime($, plist)
  if (time === herdSeen) return herdInstalled
  if (time < 0) {
    herdSeen = time
    herdUnread = false
    herdInstalled = []
    return herdInstalled
  }
  const r = await $.process.run(['plutil', '-convert', 'json', '-o', '-', plist], { timeoutMs: 5_000 }).catch(() => undefined)
  // Said in the health tool and on the Services tab: Herd's services go unchecked meanwhile
  herdUnread = r?.exitCode !== 0
  if (r?.exitCode !== 0) return herdInstalled
  herdSeen = time
  herdInstalled = herdServices(r.stdout)
  return herdInstalled
}

/**
 * Whether something accepts connections on this machine's `port`, over IPv4 or IPv6 (`localhost` is both): nc
 * connects and hangs up at once. 'unknown' when nc is missing, hangs or exits some other way: a probe that
 * didn't work is never taken for a listening port, nor for a closed one.
 */
async function probePort($: Api, port: number): Promise<Probe> {
  const r = await $.process.run(['nc', '-z', '-w', '1', 'localhost', String(port)], { timeoutMs: 5_000 }).catch(() => undefined)
  return r?.exitCode === 0 ? 'up' : r?.exitCode === 1 ? 'down' : 'unknown'
}

/** Modification time of `path`, or -1 when it doesn't exist. */
async function mtime($: Api, path: string): Promise<number> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return -1
  }
}

const NODE_LOCKS: Record<string, string[]> = { npm: ['package-lock.json'], pnpm: ['pnpm-lock.yaml'], yarn: ['yarn.lock'], bun: ['bun.lock', 'bun.lockb'] }

const DEP_FILES = ['composer.lock', 'vendor/composer/installed.json', 'package-lock.json', 'node_modules/.package-lock.json', 'node_modules', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']

/** Composer and node packages out of step with the lockfiles, e.g. after a `git pull`. What matches goes to `fine`. */
async function checkDeps($: Api, fine: Fine[]): Promise<Check[]> {
  const project = projectRun
  const times = await Promise.all(DEP_FILES.map(f => mtime($, f)))
  const key = times.join(',')
  if (key === depsSeen) {
    fine.push(...depsFine)
    return depsChecks
  }
  const has = (file: string) => times[DEP_FILES.indexOf(file)]! >= 0
  const out: Check[] = []
  const ok: Fine[] = []
  const unread: string[] = []
  const add = (tool: string, detail: string, evidence: string) =>
    out.push({
      band: `${tool} install needed`,
      color: 'yellow',
      known: 'seen',
      detail,
      evidence,
      fix: { label: `${tool} install`, run: commandFix($, `${tool} install`, tool === 'composer' ? ['composer', 'install', '--no-interaction'] : [pm, 'install']) },
    })
  const sample = (drift: string[]) => `${drift.slice(0, 3).join(', ')}${drift.length > 3 ? '…' : ''}`
  const differ = (lock: string, drift: string[], fix: string) => `${plural(drift.length, 'package')} in ${lock} differ from what's installed (${sample(drift)}). Run ${fix}.`
  const differIn = (files: string, drift: string[]) => `${files} differ for ${plural(drift.length, 'package')} (${sample(drift)})`

  if (has('composer.lock')) {
    const fix = 'composer install (/lara-composer install)'
    if (!has('vendor/composer/installed.json')) add('composer', `vendor/ is missing. Run ${fix}.`, "composer.lock exists, vendor/composer/installed.json doesn't")
    else {
      // An unreadable or half-written file (mid-install) is neither a match nor drift: said as unread, and read again next time
      const drift = await Promise.all([$.fs.read('composer.lock'), $.fs.read('vendor/composer/installed.json')])
        .then(([lock, installed]) => composerDrift(lock, installed))
        .catch(() => undefined)
      if (!drift) unread.push('composer')
      else if (drift.length) add('composer', differ('composer.lock', drift, fix), differIn('composer.lock and vendor/', drift))
      else ok.push({ known: 'seen', evidence: 'vendor/ matches composer.lock' })
    }
  }

  // The lockfile `pm` was picked from, so the advice matches the tool (a stray package-lock.json in a yarn project is ignored)
  const nodeLock = NODE_LOCKS[pm]?.find(has)
  if (nodeLock && !has('node_modules')) add(pm, `node_modules/ is missing. Run ${pm} install.`, `${nodeLock} exists, node_modules/ doesn't`)
  // Only npm keeps a record of what it installed precise enough to compare against the lockfile
  else if (nodeLock === 'package-lock.json' && has('node_modules/.package-lock.json')) {
    const drift = await Promise.all([$.fs.read('package-lock.json'), $.fs.read('node_modules/.package-lock.json')])
      .then(([lock, installed]) => npmDrift(lock, installed))
      .catch(() => undefined)
    if (!drift) unread.push(pm)
    else if (drift.length) add(pm, differ('package-lock.json', drift, `${pm} install`), differIn('package-lock.json and node_modules/', drift))
    else ok.push({ known: 'seen', evidence: 'node_modules/ matches package-lock.json' })
  } else if (nodeLock) ok.push({ known: 'inferred', evidence: `node_modules/ exists (${pm} leaves no record lara-cc compares with ${nodeLock})` })

  // Not into the cache once the session has moved to another folder, nor while a file couldn't be read
  if (project === projectRun) {
    if (!unread.length) depsSeen = key
    depsChecks = out
    depsFine = ok
    depsUnread = unread
  }
  fine.push(...ok)
  return out
}

/**
 * What lara-cc couldn't check right now: neither fine nor broken. `label` for the Services tab's checks row, `text`
 * for Claude's health tool, which lists each under Unknown, so the two can't disagree; `artisan`: what reads it again.
 */
function notChecked(): { label: string; text: string; artisan?: string }[] {
  const out: { label: string; text: string; artisan?: string }[] = []
  if (!about) {
    out.push({
      label: `APP_ENV (artisan about ${aboutFailed ? 'failed' : "hasn't answered"})`,
      text: `APP_ENV: artisan about ${aboutFailed ? `failed (${aboutFailed})` : "hasn't answered yet"}, so production isn't ruled out`,
    })
  }
  if (connections === undefined) {
    out.push({
      label: herdInstalled.length ? "Herd (the app's servers unknown)" : "the app's servers (config unread)",
      text: "Which servers the app uses: lara-cc hasn't read its config (not yet, or it failed), so Herd services aren't checked against it",
    })
  }
  if (herdUnread) out.push({ label: 'Herd (services.plist unreadable)', text: "Herd services: couldn't read services.plist" })
  for (const tool of depsUnread) {
    const files = tool === 'composer' ? 'composer.lock or installed.json' : 'package-lock.json or node_modules/.package-lock.json'
    out.push({ label: `${tool} drift (files unreadable)`, text: `${tool} drift: couldn't read ${files}` })
  }
  if (!migrationsAt && migrationsFailed) {
    // A SQLSTATE comes from the database; anything else (a parse error, no vendor/) says nothing about one
    const maybe = migrationsFailed.includes('SQLSTATE') ? '; maybe there is no database yet, or it is not reachable' : ''
    out.push({ label: 'migrations (migrate:status failed)', text: `Migrations: migrate:status failed (${migrationsFailed})${maybe}`, artisan: 'migrate:status' })
  } else if (!migrationsAt) {
    out.push({ label: "migrations (migrate:status hasn't answered)", text: "Migrations: migrate:status hasn't answered yet" })
  }
  if (snapshotError) {
    // A partial read has current waiting counts but no failed-job count; a failed one has neither
    out.push({
      label: sizesRead ? "failed jobs (couldn't count)" : snapshot ? 'queue (last read failed)' : 'queue (unread)',
      text: `Queue: the read ${ago(snapshotAt)} ago ${queueReadFailure()}${sizesRead ? '' : ', so waiting and failed jobs are unknown'}`,
    })
  } else if (!snapshot) out.push({ label: 'queue (not read yet)', text: 'Queue: not read yet' })
  if (!logRun) {
    out.push({
      label: 'log (not following)',
      text: `Log: lara-cc isn't following ${logPath || 'storage/logs'} right now (tail stopped or hasn't started); it tries again within a minute, so new errors may be missed meanwhile`,
    })
  }
  return out
}

// ─── Since Claude's edits ──────────────────────────────────────────────────

/** A file's size and time of change, '' when it isn't there: told apart before and after a call, they show whether it changed the file. */
async function fileStamp($: Api, path: string): Promise<string> {
  try {
    const s = await $.fs.stat(path)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return ''
  }
}

/** `14:03:10`, in local time. */
const hms = (ms: number) => new Date(ms).toTimeString().slice(0, 8)

/** A file `php -l` can read: PHP, not Blade (php -l on a template means nothing), and never an env file (`.env.php`: a parse error can quote it). */
const lintable = (rel: string) => rel.endsWith('.php') && !rel.endsWith('.blade.php') && editKind(rel) !== 'env'

/** `PHP 8.4.1` when the PHP lara-cc runs is known (see detectPhp), else ''. */
function phpLabel(): string {
  const version = /^PHP (\d+\.\d+(?:\.\d+)?)/.exec(phpInfo)?.[1]
  return version ? 'PHP ' + version : ''
}

/**
 * What a closed stretch leaves for the next: every PHP file with no clean check after its last edit (a parse error, an
 * edit that landed while the check ran, a file it never reached), so none is forgotten. One goes only when it lints
 * clean or is gone.
 */
function carryFrom(s: Since): Map<string, Carried> {
  const carried = new Map(s.carried)
  for (const [rel, f] of s.files) {
    if (!lintable(rel)) continue
    const rec = s.lint?.files.get(rel)
    const current = !!rec && rec.seq >= f.seq
    if (current && (rec.gone || rec.verdict === 'passed')) carried.delete(rel)
    // Even a failure from before the latest edit: the file isn't known to be fixed
    else if (rec?.verdict === 'failed') carried.set(rel, { failed: true, line: rec.line, at: rec.at })
    else if (!carried.has(rel)) carried.set(rel, { failed: false })
  }
  return carried
}

/**
 * Remember an edit Claude made with a tracked tool: its path inside the project (`..` resolved first, so a path that
 * leaves the project is dropped), never its contents. The first edit after a stretch closed starts a new one,
 * carrying forward the files that haven't linted clean (see carryFrom).
 */
function noteEdit(path: string, now: number) {
  const rel = relativeTo(path, projectDir)
  if (rel === undefined || isIgnoredRel(rel)) return
  if (!since || since.closedAt !== undefined) {
    since = { firstAt: now, lastAt: now, files: new Map(), dropped: 0, chains: 0, linting: false, carried: since ? carryFrom(since) : new Map(), errors: 0 }
  }
  since.lastAt = now
  // Deleted first, so the map stays in order of the latest edit
  since.files.delete(rel)
  since.files.set(rel, { kind: editKind(rel), seq: ++editCount })
  if (since.files.size > SINCE_MAX_FILES) {
    const s = since
    const failed = (rel: string) => s.lint?.files.get(rel)?.verdict === 'failed'
    const checked = (rel: string, f: Edited) => {
      const rec = s.lint?.files.get(rel)
      return !!rec && rec.seq >= f.seq && (rec.gone === true || rec.verdict === 'passed')
    }
    // What nothing needs to check goes first. Never a parse error, and a PHP file with no clean check yet is carried (so
    // it is still linted and counted), not forgotten
    const all = [...s.files]
    const oldest = all.find(([r]) => !lintable(r)) ?? all.find(([r]) => !failed(r))
    if (oldest) {
      const [r, f] = oldest
      s.files.delete(r)
      s.dropped++
      if (lintable(r) && !checked(r, f)) {
        // An old record would hide that it was never checked since its last edit
        s.lint?.files.delete(r)
        if (!s.carried.has(r)) s.carried.set(r, { failed: false })
      }
    }
  }
}

/**
 * `php -l` on the PHP files Claude edited and hasn't had checked since, then the ones carried from an earlier stretch
 * (so a fix made elsewhere clears them): parse only (no autoloader, no app boot, no database or network, nothing
 * written), a few ms a file. At most LINT_MAX_FILES files and LINT_BUDGET_MS in all; the rest stay unlinted and the
 * report says so. A file edited while it ran stays unchecked (see `seq`).
 */
async function lintEdited($: Api, s: Since, project: number) {
  if (project !== projectRun) return
  const todo = [
    ...[...s.files].filter(([rel, f]) => lintable(rel) && (s.lint?.files.get(rel)?.seq ?? -1) < f.seq).map(([rel]) => rel),
    ...[...s.carried.keys()].filter(rel => !s.files.has(rel) && !s.lint?.files.has(rel)),
  ]
  if (!todo.length) return
  const lint = (s.lint ??= { at: 0, seq: 0, files: new Map() })
  lint.seq = editCount
  s.linting = true
  const started = await nowMs($)
  // Where the project really is: a file whose real path leaves it (a symlink) isn't read
  const root = await $.fs.stat(projectDir, { resolve: true }).then(st => st.realPath, () => undefined)
  try {
    for (const rel of todo.slice(0, LINT_MAX_FILES)) {
      if ((await nowMs($)) - started > LINT_BUDGET_MS) break
      // The session moved to another folder while the last file was checked (or the clock was asked)
      if (project !== projectRun) return
      const seq = editCount
      let rec: Omit<LintFile, 'at'> = { seq, verdict: 'unknown' }
      try {
        // stat rejects for a missing file, and for one it couldn't read: exists() tells which
        const real = await $.fs.stat(projectDir + '/' + rel, { resolve: true }).then(
          st => st.realPath ?? '',
          async () => ((await $.fs.exists(rel)) ? '' : undefined),
        )
        if (real === undefined) rec = { seq, verdict: 'unknown', gone: true }
        else if (!real || !root) rec = { seq, verdict: 'unknown' }
        else if (!real.startsWith(root.replace(/\/$/, '') + '/')) rec = { seq, verdict: 'unknown', outside: true }
        else {
          const r = await runPhp($, ['php', '-l', projectDir + '/' + rel], { timeoutMs: 10_000 })
          const output = stripAnsi(r.stdout + '\n' + r.stderr)
          const result = lintResult(r.exitCode, output)
          rec = { seq, ...result, ...(result.verdict === 'failed' ? { raw: tail(output.trim(), 600) } : {}) }
        }
      } catch {
        // php couldn't run: unknown, never passed
      }
      // The session moved to another folder while it ran
      if (project !== projectRun) return
      lint.at = await nowMs($)
      lint.files.set(rel, { ...rec, at: lint.at })
      if (rec.verdict === 'passed' || rec.gone) s.carried.delete(rel)
      else if (rec.verdict === 'failed' && s.carried.has(rel)) s.carried.set(rel, { failed: true, line: rec.line, at: lint.at })
    }
  } finally {
    s.linting = false
  }
}

/**
 * What follows a main agent's turn, in two steps that run one after another (see turn.complete): the syntax check, then
 * Pint and the close of the stretch.
 */
async function syntaxCheck($: Api, s: Since | undefined, project: number) {
  try {
    if (s && settings.lintAfterTurn) await lintEdited($, s, project)
  } catch (err) {
    $.ui.log('lara-cc: syntax check failed: ' + String(err))
  }
}

/**
 * Pint, then the stretch closes (the last of the chains queued for it closes it). Chains run one after another
 * (lintDone), so turns ending close together don't run Pint twice on the same files. `files`: the PHP files edited, and
 * `seq`: editCount, both taken when the turn ended, so an edit that lands while the syntax check runs doesn't read as formatted.
 */
async function afterTurn($: Api, s: Since | undefined, files: string[], seq: number, project: number) {
  // Queued behind another chain while the session moved to another folder: nothing of this one is run there
  if (project !== projectRun) return
  try {
    if (project === projectRun && settings.pintAfterTurn && hasPint && files.length) {
      let ok = false
      try {
        const r = await runPhp($, ['vendor/bin/pint', ...files], { timeoutMs: 120_000 })
        ok = r.exitCode === 0
        $.ui.log(ok ? `lara-cc: Pint formatted ${plural(files.length, 'file')}` : `lara-cc: Pint failed: ${stripAnsi(r.stdout + r.stderr).trim().slice(0, 300)}`)
      } catch (err) {
        $.ui.log('lara-cc: Pint failed: ' + String(err))
      }
      if (s && project === projectRun) s.pint = { at: await nowMs($), seq, files: files.length, ok }
    }
  } finally {
    // Whatever went wrong above, so a stretch is never left open
    const now = await nowMs($)
    if (s && --s.chains === 0) s.closedAt = now
    if (project === projectRun) {
      toastSince($, s, now)
      redraw($)
    }
  }
}

/** The band's item for Claude's edits (see verifyBand), only once a turn has ended: the Syntax and Tests rows' verdicts. */
function bandVerify($: Api, now: number, v = verifyRows($, now)): { text: string; color: 'red' | 'yellow'; message: string } | undefined {
  if (!v || since?.closedAt === undefined) return undefined
  const [syntax, tests] = [v.rows.find(r => r.check === 'Syntax'), v.rows.find(r => r.check === 'Tests')]
  const item = verifyBand(v.files, syntax?.verdict, tests && { verdict: tests.verdict, partial: tests.partial })
  if (!item) return undefined
  const failed = v.failed[0]
  // The band's own words for the tests (`tests not run`), so the toast can't say otherwise
  const message = syntax?.verdict === 'failed' && failed
    ? `Claude's edits: syntax error in ${failed.file}${failed.line ? ':' + failed.line : ''}`
    : `Claude's edits: ${syntax ? `syntax ${syntax.verdict}, ` : ''}${item.words}`
  return { text: item.text, color: item.color, message }
}

/**
 * Once, when the syntax check and Pint have finished: a toast if the edits have a syntax error or the tests don't cover
 * them (the band says it either way).
 */
function toastSince($: Api, s: Since | undefined, now: number) {
  if (!s || s !== since || s.closedAt === undefined || !settings.errorToasts) return
  const item = bandVerify($, now)
  if (!item || s.toasted === item.message) return
  s.toasted = item.message
  toast($, item.message)
}

/**
 * The report on Claude's edits, built from state so Claude's health tool and the pane can't disagree, and so a test run
 * or restart after the edits shows at once. Each row is a check that applies to what was edited; none says passed
 * because nothing went wrong. Undefined when no edit was seen. `$`: only for the person's buttons; `now`: $.clock.now().
 */
function verifyRows($: Api, now: number): { header: string; rows: Row[]; observed: string; noCheck: string; files: number; failed: { file: string; line?: number }[] } | undefined {
  const s = since
  if (!s) return undefined
  const all = [...s.files]
  const kinds = new Map<EditKind, number>()
  for (const [, f] of all) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1)
  const has = (...k: EditKind[]) => k.some(x => kinds.has(x))
  const latest = (k: EditKind[], only: (rel: string) => boolean = () => true) =>
    Math.max(0, ...all.filter(([rel, f]) => k.includes(f.kind) && only(rel)).map(([, f]) => f.seq))
  const rows: Row[] = []
  // `unknown` is lara-cc not being able to tell, whatever else the caller says
  const add = (r: Omit<Row, 'known'> & { known?: Row['known'] }) => rows.push({ ...r, known: r.verdict === 'unknown' ? 'unknown' : (r.known ?? 'seen') })
  const php = phpLabel()

  // Syntax: one row. Passed only when every PHP file was linted after its last edit
  const lintFiles = all.filter(([rel]) => lintable(rel))
  // A known parse error: `old` when it's from an earlier stretch and nothing has checked the file since
  const failed = new Map<string, { line?: number; at?: number; old?: true; recheck?: true }>()
  const tally = { passed: 0, unknown: 0, outside: 0, stale: 0, unlinted: 0 }
  // Parse errors from before the file's latest edit: not known to be fixed, so they stay in the row
  const before: string[] = []
  // With the check off a carried file is never looked at again, so its old parse error isn't a current finding
  const failedBefore: string[] = []
  const where = (file: string, line?: number) => (line ? `${file} line ${line}` : file)
  for (const [rel, f] of lintFiles) {
    const rec = s.lint?.files.get(rel)
    const carried = s.carried.get(rel)
    // No record: edited after the last check began, or the check never reached it (the cap, the time budget)
    if (!rec ? !!s.lint && f.seq > s.lint.seq : rec.seq < f.seq) tally.stale++
    else if (!rec) tally.unlinted++
    else if (rec.verdict === 'failed') failed.set(rel, { line: rec.line })
    else if (rec.verdict === 'passed') tally.passed++
    else if (rec.outside) tally.outside++
    else tally.unknown++
    // Not known to be fixed: edited since, or the check that followed couldn't run
    if (carried?.failed && (!rec || rec.seq < f.seq || (rec.verdict === 'unknown' && !rec.gone))) before.push(where(rel, carried.line))
  }
  // Carried files Claude hasn't edited again: what the check found this stretch, else what it found before
  const carriedOnly = [...s.carried].filter(([rel]) => !s.files.has(rel))
  for (const [rel, c] of carriedOnly) {
    const rec = s.lint?.files.get(rel)
    if (rec?.verdict === 'failed') failed.set(rel, { line: rec.line })
    else if (!rec && c.failed && !settings.lintAfterTurn) {
      failedBefore.push(where(rel, c.line))
      tally.unlinted++
    }
    // A re-check that couldn't run doesn't show the file was fixed: the old parse error stands
    else if (c.failed && (!rec || (rec.verdict === 'unknown' && !rec.gone))) failed.set(rel, { line: c.line, at: c.at, old: true, ...(rec ? { recheck: true as const } : {}) })
    else if (rec?.outside) tally.outside++
    else if (rec) tally.unknown++
    else tally.unlinted++
  }
  if (lintFiles.length || carriedOnly.length) {
    // Which PHP, since the app's may be newer than the one lara-cc runs (a file valid on one can fail on the other)
    const at = (s.lint ? ` at ${hms(s.lint.at)}` : '') + (php ? `, ${php}` : '')
    const unlinted = tally.unknown + tally.outside + tally.stale + tally.unlinted
    const earlier =
      (before.length ? `; failed before its latest edit: ${before.slice(0, 5).join(', ')}` : '') +
      (failedBefore.length ? `; failed before: ${failedBefore.slice(0, 5).join(', ')}` : '')
    if (failed.size) {
      const list = [...failed].slice(0, 5).map(([file, f]) => where(file, f.line) + (f.old && f.at ? ` (found ${hms(f.at)}${f.recheck ? '; the re-check could not run' : ''})` : '')).join(', ') + (failed.size > 5 ? ` and ${failed.size - 5} more` : '')
      const old = [...failed.values()].every(f => f.old)
      const rest = unlinted ? `; ${plural(unlinted, 'other file')} not linted` : ''
      add({
        check: 'Syntax',
        verdict: 'failed',
        detail:
          // An old one's time is its own, not when other files were last linted
          `${old ? 'still failing from before: ' : ''}${list} (php -l${old ? (php ? `, ${php}` : '') : at}; did not parse on this PHP)${rest}` +
          (old && !settings.lintAfterTurn ? ' (not re-checked: "syntax check after each turn" is off)' : ''),
        say: "Edit that file, then call health again (the user's pane shows the parse error text; no tool of yours reads it)",
      })
    } else if (s.linting) {
      add({ check: 'Syntax', verdict: 'unknown', detail: 'the syntax check is still running; call health again' })
    } else if (!settings.lintAfterTurn && (!s.lint || tally.unlinted + tally.stale > 0)) {
      add({ check: 'Syntax', verdict: 'skipped', detail: `"syntax check after each turn" is off${earlier}` })
    } else if (!s.lint) {
      add({ check: 'Syntax', verdict: 'not run', known: 'inferred', detail: (s.closedAt === undefined ? "runs when Claude's turn ends" : 'did not run on these edits') + earlier })
    } else if (!unlinted) {
      add({ check: 'Syntax', verdict: 'passed', detail: `php -l on ${plural(tally.passed, 'file')}${at}` })
    } else {
      const why = [
        tally.unknown && `${tally.unknown} not found or could not run`,
        tally.outside && `${tally.outside} link${tally.outside === 1 ? '' : 's'} to outside the project, not read`,
        tally.stale && `${tally.stale} edited after the check`,
        tally.unlinted && (s.closedAt === undefined ? `${tally.unlinted} not checked yet` : `${tally.unlinted} over the ${LINT_MAX_FILES}-file cap or the time budget`),
      ].filter(Boolean)
      add({
        check: 'Syntax',
        verdict: tally.unknown || tally.outside ? 'unknown' : 'not run',
        detail: `php -l passed on ${tally.passed} of ${plural(lintFiles.length + carriedOnly.length, 'file')}${at}; ${plural(unlinted, 'file')} not linted (${why.join(', ')})${earlier}`,
      })
    }
  }

  // Tests: from the last run at the time of the call, so a later run by the person or Claude's Bash shows
  if (has('php', 'migration', 'route', 'config', 'test')) {
    const t = lastTest
    const test: Pick<Row, 'claude' | 'button'> = {
      claude: { artisan: 'test' },
      button: { label: 'run tests', run: async () => void (await runCommand($, 'test', ['php', 'artisan', 'test'])) },
    }
    // A test file Claude changed is the likeliest thing to be wrong, so say it has not run
    const changedTests = has('test') ? '; a changed test file with no later run' : ''
    if (!t) add({ check: 'Tests', verdict: 'not run', known: 'inferred', detail: `none run this session${changedTests}`, ...test })
    else {
      const counts = testCounts(t)
      const what = `${redact(t.label)}, ${hms(t.at)}`
      if (t.editedSince || t.ledger !== editCount) add({ check: 'Tests', verdict: 'not run', detail: `the last run (${counts}, ${ago(t.at)} ago, ${redact(t.label)}) was before these edits${changedTests}`, ...test })
      else if (t.crashed !== undefined) {
        add({ check: 'Tests', verdict: 'failed', detail: `${counts} (${what})`, say: "its output is in the Commands tab for a run made there, and in your own Bash result for yours", ...test })
      } else if (t.failed) {
        add({ check: 'Tests', verdict: 'failed', detail: `${counts} (${what})`, say: 'the Tests tab lists them; test names reach you only through the tests the user sends', ...test })
      } else if (t.exitCode) add({ check: 'Tests', verdict: 'unknown', detail: `exited ${t.exitCode} after printing a summary (${counts}; ${what})`, ...test })
      else if (!t.passed) add({ check: 'Tests', verdict: 'unknown', detail: t.skipped ? `all ${t.skipped} skipped, none ran (${what})` : `ran, no tests found (${what})`, ...test })
      else {
        const subset = t.scope === 'subset'
        const scope = subset ? "a subset, so the rest hasn't run on these edits" : 'the suite'
        add({ check: 'Tests', verdict: 'passed', ...(subset ? { partial: true as const } : {}), detail: `${counts} (${scope}; ${what}, after the last edit at ${hms(s.lastAt)})` })
      }
    }
  }

  // Pint: opt-in, so a skipped row says the setting is off
  if (hasPint && lintFiles.some(([, f]) => f.kind !== 'view')) {
    if (!settings.pintAfterTurn) add({ check: 'Pint', verdict: 'skipped', detail: '"Pint after each turn" is off' })
    else if (s.pint && s.pint.seq >= latest(['php', 'migration', 'route', 'config', 'test'])) {
      add({ check: 'Pint', verdict: s.pint.ok ? 'passed' : 'failed', detail: `${plural(s.pint.files, 'file')} at ${hms(s.pint.at)}`, ...(s.pint.ok ? {} : { say: "the user's pane and lara-cc's log show why; no tool of yours reads it" }) })
    } else add({ check: 'Pint', verdict: 'not run', known: 'inferred', detail: s.pint ? 'ran before the latest edit' : s.closedAt === undefined ? "runs when Claude's turn ends" : 'did not run on these edits' })
  }

  // Migrations: never "passed", since lara-cc runs none
  if (has('migration')) {
    const read = `migrate:status, ${ago(migrationsAt)} ago`
    if (!migrationsAt || migrationsSeq < latest(['migration'])) {
      add({ check: 'Migrations', verdict: 'unknown', detail: `migrate:status has not been read since the edit${migrationsFailed ? ` (the last attempt failed: ${migrationsFailed})` : ''}` })
    } else if (migrationsFailed) {
      // Read after the edit, then a re-check failed: the count is as of the read
      add({ check: 'Migrations', verdict: 'unknown', detail: `migrate:status has failed since (${migrationsFailed}); ${plural(pendingMigrations, 'pending migration')} as of ${ago(migrationsAt)} ago`, ...(pendingMigrations ? { claude: { artisan: 'migrate' }, button: { label: 'migrate', run: migrateFix($) } } : {}) })
    } else if (pendingMigrations) {
      add({ check: 'Migrations', verdict: 'not run', detail: `${plural(pendingMigrations, 'pending migration')} (${read})`, claude: { artisan: 'migrate' }, button: { label: 'migrate', run: migrateFix($) } })
    } else add({ check: 'Migrations', verdict: 'unknown', detail: `no pending migrations (${read}); that doesn't show the edited migration ran or works` })
  }

  // Routes and views: lara-cc ran the check itself, after the last edit of that kind, or didn't
  for (const [check, kind, command, why] of [
    ['Routes', 'route', 'route:list', 'route:list not run, so new routes and names are unverified'],
    ['Views', 'view', 'view:cache', 'Blade not compiled; a template error shows only when the page renders'],
  ] as const) {
    if (!has(kind)) continue
    const ran = artisanRan[command]
    if (ran && ran.seq >= latest([kind])) {
      add(ran.ok ? { check, verdict: 'passed', detail: `${command} ran at ${hms(ran.at)}, after the last ${kind} edit` } : { check, verdict: 'failed', detail: `${command} failed at ${hms(ran.at)}`, say: 'the Commands tab shows why, only to the user', claude: { artisan: command } })
    } else add({ check, verdict: 'not run', known: 'inferred', detail: why, claude: { artisan: command } })
  }

  // The queue worker reads code, config and env at boot; lara-cc can restart only the one it started
  if (has('php', 'migration', 'route', 'config', 'env') && snapshot?.connection !== 'sync') {
    const svc = services.queue
    const workerKinds: EditKind[] = ['php', 'migration', 'route', 'config', 'env']
    const needSeq = latest(workerKinds)
    const reads = [has('php', 'migration', 'route') && 'code', has('config') && 'config', has('env') && 'env values'].filter(Boolean).join(', ')
    const restart = { claude: { service: ['queue', 'restart'] as [string, 'restart'] }, button: { label: 'restart queue', run: () => restartService($, 'queue') } }
    // A cached config is what a worker reads, whenever it starts: a restart alone doesn't load an edit to config or env
    const configCached = has('config', 'env') && checks.some(c => /\bconfig\b.*cached/.test(c.band))
    const restarted = svc.startedAt !== undefined && (svc.startedSeq ?? 0) >= needSeq
    if (svc.run && configCached) {
      add({
        check: svc.label,
        verdict: 'not run',
        known: 'inferred',
        detail: `config is cached, so the worker still reads the old config and env values${restarted ? ` even after its restart at ${hms(svc.startedAt!)}` : ''}; clear the config cache, then restart (see Problems)`,
        say: 'clear the config cache first, then restart the queue worker',
        claude: { artisan: 'config:clear' },
        button: restart.button,
      })
    } else if (svc.run && restarted) {
      add({ check: svc.label, verdict: 'done', detail: `managed worker (re)started ${hms(svc.startedAt!)}, after the last edit it reads` })
    } else if (restartTimer || restarting) {
      add({ check: svc.label, verdict: 'not run', known: 'inferred', detail: restarting ? 'restarting now' : 'restart pending (2 s debounce)' })
    } else if (svc.run) {
      const phpEdited = latest(workerKinds, rel => rel.endsWith('.php')) > 0
      const why = !settings.autoRestartQueue ? ' ("restart queue on PHP edits" is off)' : !phpEdited ? ' (the automatic restart only follows PHP edits)' : ''
      add({
        check: svc.label,
        verdict: 'not run',
        known: 'inferred',
        detail: `still running the ${reads} from before the edits${why}`,
        ...restart,
      })
    } else if (svc.crashed || (s.restart && !s.restart.ok)) {
      const why = svc.crashed ? `it exited with code ${svc.crashed.code}` : `the automatic restart at ${hms(s.restart!.at)} did not bring it back`
      add({ check: svc.label, verdict: 'failed', detail: `the managed worker isn't running: ${why}`, ...restart })
    } else {
      add({
        check: svc.label,
        verdict: 'unknown',
        detail: "no worker from this session; one elsewhere (Supervisor, another terminal) keeps the old code, config and env values, and lara-cc can't see it",
        claude: { artisan: 'queue:restart' },
      })
    }
  }

  const noCheck: [EditKind, string][] = [['frontend', 'frontend file'], ['composer', 'dependency file'], ['env', 'env file'], ['other', 'other file']]
  const unchecked = noCheck.filter(([k]) => kinds.has(k)).map(([k, word]) => plural(kinds.get(k)!, word))
  const noCheckText = unchecked.length
    ? `No check exists for: ${unchecked.join(', ')}.` +
      (kinds.has('env') ? ' An env file was edited (lara-cc never reads it); cached config, workers and Vite keep old values until restarted.' : '') +
      (services.vite.run ? " Vite runs here but lara-cc doesn't read its errors." : '')
    : ''

  const label = (k: EditKind) => (k === 'composer' ? 'dependency' : k)
  const files = all.length + s.dropped
  const header =
    `${hms(s.firstAt)}${s.lastAt === s.firstAt ? '' : ' to ' + hms(s.lastAt)}, ${plural(files, 'file')}: ${[...kinds].map(([k, n]) => `${n} ${label(k)}`).join(', ')}` +
    (s.dropped ? ` (${s.dropped} earlier not listed)` : '')

  // The log window: counted by arrival, so it says only what showed up, and only when the tail ran the whole time
  const endsAt = s.closedAt === undefined ? undefined : s.closedAt + ERROR_WINDOW_MS
  const open = endsAt === undefined || now < endsAt
  const to = Math.min(now, endsAt ?? now)
  const whole = logSince !== 0 && logSince <= s.firstAt && !logGaps.some(g => g.from <= to && (g.to ?? Infinity) >= s.firstAt)
  const stamp = logStamp(s.newestError?.time)
  const doesNotShow = "This doesn't show the edits work: only code that ran in that time could have written one."
  let observed: string
  if (s.errors) {
    const extra = [open && endsAt && `window open until ${hms(endsAt)}`, stamp && `newest entry stamped ${stamp}`].filter(Boolean).join('; ')
    const span = open ? `${s.errors === 1 ? 'has' : 'have'} arrived since ${hms(s.firstAt)} so far` : `arrived between ${hms(s.firstAt)} and ${hms(endsAt!)}`
    const read = `read them with the logs tool (${logsConsent()})`
    observed =
      `Log: ${plural(s.errors, 'error')} ${span}${extra ? ` (${extra})` : ''}. The log alone doesn't show these came from Claude's edits (requests, jobs and other processes write to it); ${read}.` +
      (whole ? '' : " The log wasn't followed the whole time, so there may be more.")
  } else if (!whole) observed = `Log: not followed for the whole interval since ${hms(s.firstAt)} (unknown).`
  else if (open) observed = `Log: no errors have arrived since ${hms(s.firstAt)} so far (${endsAt ? `window open until ${hms(endsAt)}` : 'the stretch is still open'}). ${doesNotShow}`
  else observed = `Log: no errors arrived ${hms(s.firstAt)}-${hms(endsAt!)}. ${doesNotShow}`

  return { header, rows, observed, noCheck: noCheckText, files, failed: [...failed].map(([file, f]) => ({ file, ...(f.line ? { line: f.line } : {}) })) }
}

/** `passed`, or `passed (subset only)`. */
const verdictText = (r: Row) => (r.partial ? 'passed (subset only)' : r.verdict)

/** Claude's lines for the report: each row with its next steps (what its tools can do and whether that asks), the log, and what has no check. */
async function verifyLines($: Api, v: NonNullable<ReturnType<typeof verifyRows>>): Promise<string[]> {
  const made = artisanMade ? `; ${plural(artisanMade, 'artisan make command')} ran through lara-cc, and the files they created aren't tracked` : ''
  const out = [`Since Claude's edits (${v.header}; lara-cc saw only edits made with Claude's Edit, Write and NotebookEdit tools${made}):`]
  for (const r of v.rows) {
    out.push(`- [${r.known}] ${r.check}: ${verdictText(r)}, ${r.detail}`)
    if (['passed', 'done', 'skipped'].includes(r.verdict)) continue
    const tool = !r.claude ? undefined : 'artisan' in r.claude ? await artisanStep($, [r.claude.artisan]) : serviceStep(r.claude.service[0], r.claude.service[1])
    const steps = [r.say, tool].filter(Boolean).join(' · ')
    if (steps || r.button) out.push(nextSteps(steps || undefined, r.button?.label))
  }
  out.push(`Observed: ${v.observed}`)
  if (v.noCheck) out.push(v.noCheck)
  out.push('A pass means only that check passed. Never say "verified" or "all good" from this list alone; say which checks passed, failed, were not run or skipped.')
  return out
}

/** What Claude's health tool never looks at, so nothing left out reads as fine. */
const NEVER_CHECKED =
  "Never checked: servers not on this machine (lara-cc doesn't name them); local servers on ports no Herd service has (Docker, DBngin); a public/hot that names another machine; workers, Vite or schedulers started outside this session; files edited outside Claude's Edit, Write and NotebookEdit tools (Bash, git, artisan, an editor); whether edited code is correct beyond syntax and the tests that ran; whether pages actually render."

/**
 * Claude's health tool: problems, what lara-cc couldn't tell, what's stale and what's fine, each marked [seen],
 * [inferred] or [unknown]. Only counts, drivers, local ports, file names, package names, times and errorKind():
 * never log or exception text (the logs and queue tools ask for those). Update Never checked when a check is added.
 * `slow`: the re-check it asked for hadn't finished when the answer was due.
 */
async function healthText($: Api, slow: boolean): Promise<string> {
  const problems: string[] = []
  const unknown: string[] = []
  const stale: string[] = []
  const fine: string[] = []
  const session: string[] = []
  const line = (known: string, text: string) => `- [${known}] ${text}`
  const old = checksStale()
  // The report on Claude's edits is the one source for what it covers: the lines below drop their own for the same facts
  await Promise.race([syntaxDone, $.clock.sleep(5000)])
  const v = verifyRows($, await nowMs($))
  const verify = v
    ? await verifyLines($, v)
    : [
        "Since Claude's edits: none seen. No edit through Claude's Edit, Write or NotebookEdit tools this session, and changes made by Bash, git, artisan or an editor aren't tracked, so nothing here says a change was checked." +
          (artisanMade ? ` ${plural(artisanMade, 'artisan make command')} ran through lara-cc; the files they created aren't tracked.` : ''),
      ]
  const [testsInReport, migrationsInReport] = [!!v?.rows.some(r => r.check === 'Tests'), !!v?.rows.some(r => r.check === 'Migrations')]

  const why = checksFailed ? `the checks' last run failed (${checksFailed})` : !checkedAt ? "the checks haven't finished yet" : `the checks haven't finished for ${CHECKS_STALE}+ minutes`
  const sentence = `${checkedAt ? `The checks finished ${ago(checkedAt)} ago` : "The checks haven't finished yet"}; they also run every minute and after each of your turns.`
  if (slow) unknown.push(line('unknown', 'A re-check is still running (it took over 20 s), so what follows is from before it; call health again shortly'))
  if (!checkedAt || old) unknown.push(line('unknown', `What the checks cover (maintenance, caches, public/hot, Herd, installs): ${why}, so nothing they cover is listed as fine`))

  for (const c of checks) {
    // The backlog is swapped in by each queue read, so it's as current as the queue
    const checkOld = old && !c.backlog
    const text = line(c.known, `${c.band}: ${c.evidence}${checkOld ? `; stale: ${why}, so this is from ${ago(checkedAt)} ago` : ''}`) + '\n' + nextSteps(c.claude, c.fix?.label)
    if (checkOld || (c.fromAbout && aboutFailed)) stale.push(text)
    else if (c.known === 'unknown') unknown.push(text)
    else problems.push(text)
  }
  for (const n of notChecked()) unknown.push(line('unknown', n.text) + (n.artisan ? '\n' + nextSteps(await artisanStep($, [n.artisan]), undefined) : ''))

  const env = about?.environment?.environment
  // An answer without an environment is unknown, not fine
  if (about && typeof env !== 'string') unknown.push(line('unknown', `APP_ENV: artisan about answered ${ago(aboutAt)} ago without an environment, so production isn't ruled out`))
  // production is the env: production finding's, which goes stale with about
  else if (about && env !== 'production') {
    if (aboutFailed) stale.push(line('seen', `APP_ENV was ${env} at the artisan about ${ago(aboutAt)} ago; stale: artisan about has failed since (${aboutFailed})`))
    else fine.push(line('seen', `APP_ENV is ${env} (artisan about, ${ago(aboutAt)} ago)`))
  }
  if (!old) fine.push(...checkedFine.map(f => line(f.known, f.evidence)))

  for (const svc of Object.values(services)) {
    if (svc.crashed && !svc.run) {
      problems.push(line('seen', `${svc.label}, started by this session, exited with code ${svc.crashed.code}`) + '\n' + nextSteps(serviceStep(svc.name, 'restart'), `restart ${svc.name}`))
    }
  }

  // A count kept from before a failed re-check is stale, never zero
  if (migrationsAt && !migrationsInReport) {
    const read = `migrate:status, ${ago(migrationsAt)} ago`
    const failedSince = migrationsFailed ? `; stale: migrate:status has failed since (${migrationsFailed})` : ''
    if (pendingMigrations) {
      const text = line('seen', `${plural(pendingMigrations, 'pending migration')} (${read})${failedSince}`) + '\n' + nextSteps(await artisanStep($, ['migrate']), 'migrate')
      ;(migrationsFailed ? stale : problems).push(text)
    } else if (migrationsFailed) stale.push(line('seen', `no pending migrations (${read})${failedSince}`))
    else fine.push(line('seen', `no pending migrations (${read})`))
  }

  // A run from before Claude's PHP edits is stale, passed or failed
  const t = lastTest
  let passing = ''
  // With a Tests row in the report only the stale run stays here, pointing at it
  if (!t) {
    if (!testsInReport) unknown.push(line('unknown', 'Tests: none run this session'))
  } else if (!testsInReport || t.editedSince) {
    const run = testCounts(t)
    const text = line('seen', `Tests: ${run} in the last run (${redact(t.label)}, ${ago(t.at)} ago)${t.editedSince ? `; stale: Claude edited PHP files since${testsInReport ? " (see the Since Claude's edits section)" : ''}` : ''}`)
    const next = t.failed || t.crashed !== undefined || t.editedSince ? '\n' + nextSteps(await artisanStep($, ['test']), undefined) : ''
    if (t.editedSince) stale.push(text + next)
    else if (t.failed || t.crashed !== undefined) problems.push(text + next)
    else passing = text
  }

  const failedNext = `queue tool "failed" (${shareAllowed ? 'the user allowed exceptions this session' : 'asks the user before sending exceptions'}); queue tool "retry" (asks the user first)`
  if (snapshot?.failedTotal && !snapshotError) {
    problems.push(line('seen', `${plural(snapshot.failedTotal, 'failed job')} stored (queue read ${ago(snapshotAt)} ago)`) + '\n' + nextSteps(failedNext, undefined))
  } else if (snapshot?.failedTotal) {
    stale.push(line('seen', `${plural(snapshot.failedTotal, 'failed job')} stored (queue read ${ago(snapshotOkAt)} ago); stale: the queue read ${ago(snapshotAt)} ago ${queueReadFailure()}`) + '\n' + nextSteps(failedNext, undefined))
  }

  // Counts and the log's own timestamp only: entries go through the logs tool, which asks
  const newestError = [...logState.entries].reverse().find(isError)
  if (unseenErrors) {
    const when = logStamp(newestError?.time) ? `, newest at ${newestError!.time}` : ''
    const logsNext = `logs tool (${logsConsent()})`
    problems.push(line('seen', `${plural(unseenErrors, 'new error')} in ${logPath} since the user last looked at the log (Log tab or /lara-logs)${when}`) + '\n' + nextSteps(logsNext, undefined))
  }

  if (snapshot) {
    const n = waiting(snapshot)
    const counted = `${snapshot.connection} connection, ${n ? `${n} waiting (${waitingSizes(snapshot)})` : 'nothing waiting'}`
    // notChecked() lists a failed or partial read under Unknown; a partial one still has current counts
    if (snapshotError && sizesRead) session.push(line('seen', `Queue: ${counted} (read ${ago(snapshotAt)} ago)`))
    else if (!snapshotError && snapshot.connection === 'sync') fine.push(line('seen', `Queue: sync connection, so jobs run inline and no worker is needed (read ${ago(snapshotAt)} ago)`))
    else if (!snapshotError && !n && !snapshot.failedTotal) fine.push(line('seen', `Queue: nothing waiting, no failed jobs stored (${snapshot.connection} connection, read ${ago(snapshotAt)} ago)`))
    // Not under Fine: these counts go with the backlog or failed-job problems above
    else if (!snapshotError) session.push(line('seen', `Queue: ${counted}, ${snapshot.failedTotal} failed stored (read ${ago(snapshotAt)} ago)`))
    if (drainingNote()) fine.push(line('inferred', `Fewer jobs wait than at the read before (${waitingBefore} → ${n}), so a worker elsewhere seems to be working the queue`))
  }
  if (passing) fine.push(passing)

  for (const svc of Object.values(services)) {
    if (svc.run) session.push(line('seen', `${svc.label}: running for ${ago(svc.startedAt ?? Date.now())}, started by this session`))
    else session.push(line('seen', `${svc.label}: not running in this session; lara-cc can't see one run elsewhere (another terminal, Supervisor)`))
  }
  if (logRun) {
    const errors = filteredLog('errors').length
    session.push(line('seen', `Log: following ${logPath}; ${errors ? plural(errors, 'error') : 'no errors'} among the last ${logState.entries.length} entries`))
  }

  const sections: [string, string[]][] = [['Problems', problems], ['Unknown', unknown], ['Stale', stale], ['Fine', fine], ['This session', session]]
  return [
    `lara-cc health (read-only: it changed nothing). ${sentence}`,
    "[seen]: lara-cc saw it. [inferred]: a conclusion from indirect evidence. [unknown]: lara-cc couldn't tell; treat it as neither fine nor broken. Stale: true when last seen, not confirmed since. Not listed means not checked, not fine.",
    "next: (runs without asking) you may do; (asks the user first) shows them a question, and a no means don't retry; the user's button is theirs to press: suggest it.",
    ...(v
      ? ["Since Claude's edits: passed/failed = ran after the last edit; not run = nothing ran after it (an older run says nothing about it); skipped = a setting says not to; unknown = lara-cc can't tell; done = an action was taken (the managed worker restarted). No error appearing is not a pass."]
      : []),
    '',
    ...verify,
    '',
    ...sections.filter(([, lines]) => lines.length).flatMap(([name, lines]) => [name + ':', ...lines]),
    NEVER_CHECKED,
  ].join('\n')
}

/**
 * The session moved to another folder: stop what it started there and forget what it found, so nothing of
 * that project (its Horizon, worker, logs, jobs, results) shows in this one. Work still running for it is
 * dropped as it finishes (see projectRun). Doesn't wait for the processes to die: session start goes on.
 */
function leaveProject() {
  projectRun++
  for (const name of Object.keys(SERVICES) as (keyof typeof SERVICES)[]) {
    const svc = services[name]
    const def = SERVICES[name]
    // Closing the stream kills the child; its loop sees the run is no longer the service's and stays quiet
    if (svc.run) void svc.run.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
    Object.assign(svc, { argv: [...def.argv], label: def.label, run: undefined, startedAt: undefined, lines: [], partial: '' })
  }
  hasPint = false
  if (logRun) void logRun.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  logRun = undefined
  logSince = 0
  logGaps = []
  logLookedAt = 0
  logPath = ''
  logState = newLogState()
  unseenErrors = 0
  jobs = []
  stats.done = stats.failed = stats.totalMs = 0
  snapshot = undefined
  snapshotAt = 0
  snapshotOkAt = 0
  snapshotError = ''
  snapshotKind = ''
  sizesRead = false
  snapshotLoad = undefined
  pendingMigrations = 0
  migrationsAt = 0
  migrationsSeq = 0
  migrationsFailed = ''
  lastRun = undefined
  testsRunning = false
  restartTimer?.cancel()
  restartTimer = undefined
  editedPhp.clear()
  since = undefined
  lintDone = syntaxDone = Promise.resolve()
  artisanMade = 0
  artisanRan = {}
  debugCapture = undefined
}

async function detectProject($: Api) {
  const dir = await $.session.cwd()
  if (projectDir && dir !== projectDir) leaveProject()
  projectDir = dir
  isLaravel = await $.fs.exists('artisan')
  // Module state outlives a session: don't carry another folder's PHP over
  phpBin = 'php'
  composerArgv = ['composer']
  phpInfo = ''
  checks = []
  checkedFine = []
  checkedAt = 0
  checksMissed = 0
  checksFailed = ''
  connections = undefined
  shareAllowed = false
  lastTest = undefined
  since = undefined
  lintDone = syntaxDone = Promise.resolve()
  artisanMade = 0
  artisanRan = {}
  waitingBefore = undefined
  waitingAtTick = undefined
  hasBoost = false
  depsSeen = ''
  depsChecks = []
  depsFine = []
  depsUnread = []
  about = undefined
  aboutAt = 0
  aboutFailed = ''
  routeList = undefined
  // A load still running is for the folder left behind (see loadRouteList)
  routesLoading = undefined
  routeLoads++
  routesError = ''
  appEditor = ''
  routeAt = 0
  routeTop = 0
  pm = 'npm'
  for (const svc of Object.values(services)) svc.crashed = undefined
  if (!isLaravel) return
  // In the background: PHP launches wait for it, session start doesn't
  phpReady = detectPhp($).then(() => redraw($))
  hasPint = await $.fs.exists('vendor/bin/pint')

  if (await $.fs.exists('bun.lock')) pm = 'bun'
  else if (await $.fs.exists('bun.lockb')) pm = 'bun'
  else if (await $.fs.exists('pnpm-lock.yaml')) pm = 'pnpm'
  else if (await $.fs.exists('yarn.lock')) pm = 'yarn'
  services.vite.argv = [pm, 'run', 'dev']
  for (const q of QUICK) {
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(q.argv[0]!)) {
      q.label = q.label.replace(q.argv[0]!, pm)
      q.argv = [pm, ...q.argv.slice(1)]
    }
  }

  try {
    const composer = await $.fs.read('composer.json')
    hasBoost = composer.includes('"laravel/boost"')
    if (composer.includes('"laravel/horizon"')) {
      services.queue.argv = ['php', 'artisan', 'horizon']
      services.queue.label = 'Horizon'
    }
  } catch {
    // no composer.json: keep defaults
  }
}

// ─── The mod ───────────────────────────────────────────────────────────────

// An error's message can quote what failed (a command's output, a path with a user name), so it's redacted too
const commandFailed = (_$: Api, _e: unknown, next: { error: { message?: string } }) => ({ text: 'lara-cc: ' + redact(next.error.message ?? 'failed') })
const toolFailed = (_$: Api, _e: unknown, next: { error: { message?: string } }) => ({ result: 'lara-cc: ' + redact(next.error.message ?? 'failed') })

const TABS: Tab[] = ['services', 'queue', 'log', 'tests', 'routes', 'commands', 'about']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadSettings($)
    for (const timer of timers) timer.cancel()
    timers = []
    await detectProject($)

    const commands = [
      { name: 'lara', description: 'Open the lara-cc pane', argumentHint: '[services|queue|log|tests|routes|commands|about]', immediate: true as const },
      { name: 'lara-artisan', description: 'Run php artisan <args>', argumentHint: '<command> [args]' },
      { name: 'lara-queue', description: 'Queue worker and failed jobs', argumentHint: '[start|stop|restart|logs|status|failed|retry <id|all>]', immediate: true as const },
      { name: 'lara-vite', description: 'Vite dev server: start, stop, restart, logs', argumentHint: '[start|stop|restart|logs]', immediate: true as const },
      { name: 'lara-schedule', description: 'Scheduler (schedule:work): start, stop, restart, logs', argumentHint: '[start|stop|restart|logs]', immediate: true as const },
      { name: 'lara-logs', description: 'Recent entries from storage/logs', argumentHint: '[errors|warnings|all] [count]', immediate: true as const },
      { name: 'lara-test', description: 'Run php artisan test', argumentHint: '[--filter=Name] [args]' },
      { name: 'lara-routes', description: 'List routes, optionally filtered', argumentHint: '[filter]' },
      { name: 'lara-npm', description: 'Run a package.json script (npm/pnpm/yarn/bun)', argumentHint: '<script>' },
      { name: 'lara-composer', description: 'Run composer <args>', argumentHint: '<args>' },
    ]
    for (const command of commands) {
      try {
        await $.command.register(command)
      } catch (err) {
        $.ui.log(`lara-cc: could not register /${command.name}: ${String(err)}`)
      }
    }

    await $.tool.register({
      name: 'artisan',
      description:
        'Run a Laravel artisan command in the project and return its output, e.g. "route:list --path=api", "make:model Post -m", "db:table users", "model:show User". Runs on the PHP version the site uses (Herd\'s isolated one, when set), which can differ from `php` in Bash. Refuses commands that can destroy data or run arbitrary code (migrate:fresh/rollback, db:wipe, db:seed, tinker, --force, --env…); ask the user to run those. Commands that reach the database, queue or cache ask the user first. config:show and db:show print secrets, so their output is shown to the user, not returned to you.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Everything after `php artisan`' } },
        required: ['command'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'service',
      description:
        'Manage the long-running Laravel processes the user runs in this session (queue worker or Horizon, Vite dev server, scheduler). Restart the queue worker after changing job, listener or service code so it picks up the new code. Use "logs" to read recent output.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: Object.keys(SERVICES) },
          action: { type: 'string', enum: ['status', 'start', 'stop', 'restart', 'logs'] },
        },
        required: ['name', 'action'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'logs',
      description:
        'Read recent entries from the Laravel log (storage/logs), with exception origin and stack. Check it after running code, hitting a page or running tests, to see errors the app logged.' +
        (hasBoost ? " Use this rather than Laravel Boost's read-log-entries or last-error." : ''),
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['errors', 'warnings', 'all'], description: 'Default errors' },
          count: { type: 'number', description: 'How many entries, newest last (default 5)' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'queue',
      description:
        'Laravel queue state: pending jobs per queue, jobs the worker ran this session, and failed jobs with their exceptions. "failed" lists failed jobs with stack traces; "retry" re-queues one (id) or all.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'failed', 'retry'] },
          id: { type: 'string', description: 'Failed job id for retry, or "all"' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'routes',
      description: 'List the Laravel routes (method, URI, name, action), optionally filtered by a substring.',
      inputSchema: { type: 'object', properties: { filter: { type: 'string' } } },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'health',
      description:
        "What lara-cc knows about this Laravel app's local health, and how: problems, what it couldn't tell, what is stale and what is fine, each marked [seen], [inferred] or [unknown] with its age, and each problem with its next step and whether that runs without asking, asks the user first, or is the user's to do. Read-only: it re-runs the checks, the queue read and migrate:status first. Counts, drivers, local ports and file names only: read log entries and exceptions with the logs and queue tools. Call it before telling the user something is broken or working, and after a fix to confirm it took. After editing files, call it: it lists which checks ran on your edits and which passed, failed, were skipped or not run, with timestamps.",
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })

    if (isLaravel) {
      void watchLog($)
      void checkMigrations($)
      void refreshQueue($)
      // about gives the environment name without reading .env; the checks run once it's in
      void loadAbout($).then(() => checkHealth($))
      for (const name of settings.autostart[projectDir] ?? []) if (services[name]) void startService($, name)
      // Pick up a new daily log file, and keep the Queue tab current while it's showing
      timers.push($.clock.every(60_000, () => {
        // Reset when checkHealth finishes: three ticks without that and its results show as stale
        checksMissed++
        // The queue's read before moves at most once a tick (see refreshQueue)
        if (waitingAtTick !== undefined) {
          waitingBefore = waitingAtTick
          waitingAtTick = undefined
        }
        void watchLog($)
        // about is re-read so a changed APP_ENV or `artisan down` shows within a minute
        void loadAbout($).then(() => checkHealth($))
        // Jobs piling up with no worker; not when the app has no queue to read (no database yet) or runs jobs inline
        if (!services.queue.run && snapshot && !snapshotError && snapshot.connection !== 'sync') void refreshQueue($)
      }))
      timers.push($.clock.every(15_000, () => {
        if (paneOpen && tab === 'queue') void refreshQueue($)
      }))
    }

    return next(e)
  })

  // ── Slash commands ──

  on('command.run', { command: 'lara' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const wanted = e.args.trim().toLowerCase() as Tab
    await openPane($, TABS.includes(wanted) ? wanted : tab)
    return {}
  }).catch(commandFailed)

  on('command.run', { command: 'lara-artisan' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    if (!e.args.trim()) return { text: 'Usage: /lara-artisan <command> [args], e.g. /lara-artisan make:model Post -m' }
    // Unguarded only when the person typed it; a relayed message gets the same check as Claude's tool
    if (!fromUser(e.origin)) {
      const check = await checkArtisan($, splitArgs(e.args))
      if (check.refused) return { text: `Refused: ${check.refused}. Only commands you type yourself skip this check.` }
      if (check.error) return { text: check.error }
      if (check.shownToPerson) return { text: await showToPerson($, e.args.trim(), true) }
      if (check.impact && !(await mayRun($, `php artisan ${e.args.trim()}`, check.impact))) return { text: NOT_RUN }
      return { text: await artisanForConversation($, e.args.trim(), check.resolved) }
    }
    // Typed by the person, but the output still lands in the conversation, where Claude reads it
    const { resolved } = await resolveArtisan($, splitArgs(e.args))
    if (resolved && SHOWN_TO_PERSON.includes(resolved)) return { text: await showToPerson($, e.args.trim(), false) }
    if (resolved && CONFIDENTIAL.includes(resolved)) {
      return { text: `Not run: ${resolved} prints configuration secrets, and this output goes into the conversation where Claude reads it. Run \`php artisan ${e.args.trim()}\` in your own terminal instead.` }
    }
    return { text: await artisanForConversation($, e.args.trim(), resolved) }
  }).catch(commandFailed)

  on('command.run', { command: 'lara-queue' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const [action = 'status', id = ''] = splitArgs(e.args)
    if (action === 'failed') {
      await refreshQueue($)
      // A failed or partial read has no failed-job list to give: not "0 failed jobs", and not an older read's list
      if (!snapshot || snapshotError) return { text: queueUnread() }
      if (snapshot.failed.length && !(await mayShare($, `${plural(snapshot.failedTotal, 'failed job')} with their exceptions`))) return { text: NOT_SHARED }
      return { text: `${plural(snapshot.failedTotal, 'failed job')}:\n` + formatFailed(snapshot.failed, 3) }
    }
    const typed = fromUser(e.origin)
    if (action === 'retry') return { text: id ? await (typed ? retryFailed($, id) : guardedRetry($, id)) : 'Usage: /lara-queue retry <id|all>' }
    if (action === 'status') await refreshQueue($)
    return { text: await (typed ? serviceAction($, 'queue', action) : guardedServiceAction($, 'queue', action)) }
  }).catch(commandFailed)

  on('command.run', { command: ['lara-vite', 'lara-schedule'] }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const name = e.command.replace('lara-', '')
    const action = e.args.trim() || 'status'
    return { text: await (fromUser(e.origin) ? serviceAction($, name, action) : guardedServiceAction($, name, action)) }
  }).catch(commandFailed)

  on('command.run', { command: 'lara-logs' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const args = splitArgs(e.args)
    const filter = (['errors', 'warnings', 'all'].find(f => args.includes(f)) ?? 'errors') as 'errors' | 'warnings' | 'all'
    const count = Number(args.find(a => /^\d+$/.test(a)) ?? 5)
    await logsLoaded()
    unseenErrors = 0
    redraw($)
    if (filteredLog(filter).length && !(await mayShare($, entriesToSend(filter, count)))) return { text: NOT_SHARED }
    return { text: logsText(filter, count) }
  }).catch(commandFailed)

  on('command.run', { command: 'lara-test' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const run = await runCommand($, ('test ' + e.args).trim(), ['php', 'artisan', 'test', ...splitArgs(e.args)])
    return { text: formatRun(run) }
  }).catch(commandFailed)

  on('command.run', { command: 'lara-routes' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const text = await routesText($, e.args)
    // The Routes tab shows the same filter
    routeFilter = e.args.trim()
    routeAt = routeTop = 0
    redraw($)
    return { text }
  }).catch(commandFailed)

  on('command.run', { command: 'lara-npm' }, async ($, e) => {
    const script = e.args.trim() || 'build'
    if (!fromUser(e.origin) && !(await mayRun($, `${pm} run ${script}`, 'runs a package.json script, which can run any command'))) return { text: NOT_RUN }
    return { text: formatRun(await runCommand($, `${pm} run ${script}`, [pm, 'run', ...splitArgs(script)])) }
  }).catch(commandFailed)

  on('command.run', { command: 'lara-composer' }, async ($, e) => {
    if (!e.args.trim()) return { text: 'Usage: /lara-composer <args>, e.g. /lara-composer require laravel/pail' }
    if (!fromUser(e.origin) && !(await mayRun($, `composer ${e.args.trim()}`, 'can install or change packages and run their scripts'))) return { text: NOT_RUN }
    return { text: formatRun(await runCommand($, 'composer ' + e.args, ['composer', ...splitArgs(e.args), '--no-interaction'])) }
  }).catch(commandFailed)

  // ── Tools for Claude ──

  on('tool.call', { tool: 'mcp__lara-cc__artisan' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const command = String((e as unknown as { command?: string }).command ?? '').trim()
    const check = await checkArtisan($, splitArgs(command))
    if (check.refused) {
      return { result: `Refused: ${check.refused}. Ask the user to run it themselves with /lara-artisan ${command}` }
    }
    if (check.error) return { result: check.error }
    if (check.shownToPerson) return { result: await showToPerson($, command, true) }
    if (check.impact && !(await mayRun($, `php artisan ${command}`, check.impact))) return { result: NOT_RUN }
    return { result: await artisanForConversation($, command, check.resolved, 300_000) }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__lara-cc__service' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const args = e as unknown as { name?: string; action?: string }
    return { result: await guardedServiceAction($, String(args.name), String(args.action ?? 'status')) }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__lara-cc__logs' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const args = e as unknown as { level?: string; count?: number }
    const level = (['errors', 'warnings', 'all'].includes(String(args.level)) ? args.level : 'errors') as 'errors' | 'warnings' | 'all'
    await logsLoaded()
    const count = Math.min(50, Math.max(1, Number(args.count) || 5))
    if (filteredLog(level).length && !(await mayShare($, entriesToSend(level, count)))) return { result: NOT_SHARED }
    return { result: logsText(level, count) }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__lara-cc__queue' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const args = e as unknown as { action?: string; id?: string }
    if (args.action === 'retry') return { result: args.id ? await guardedRetry($, String(args.id)) : 'Give the failed job id, or "all".' }
    await refreshQueue($)
    if (args.action === 'failed') {
      if (!snapshot || snapshotError) return { result: queueUnread() }
      if (snapshot.failed.length && !(await mayShare($, `${plural(snapshot.failedTotal, 'failed job')} with their exceptions`))) return { result: NOT_SHARED }
      return { result: `${plural(snapshot.failedTotal, 'failed job')}:\n` + formatFailed(snapshot.failed, 5) }
    }
    const worker = services.queue.run
      ? `${services.queue.label} running (started by this session).`
      : `${services.queue.label} not started by this session; lara-cc can't see a worker run elsewhere (another terminal, Supervisor), so whether one runs is unknown.`
    return { result: [worker, queueSummary()].join('\n') }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__lara-cc__routes' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    return { result: await routesText($, String((e as unknown as { filter?: string }).filter ?? '')) }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__lara-cc__health' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const project = projectRun
    // Read-only, so no question: everything it runs already runs unasked (nc and curl to this machine, migrate:status,
    // the queue read). Bounded, so a hung PHP can't hang the tool: past it, the answer says the re-check is still running
    const finished = await Promise.race([recheck($).then(() => true), $.clock.sleep(20_000).then(() => false)])
    if (project !== projectRun) return { result: 'The session moved to another folder while lara-cc was checking; call health again.' }
    // Every input is from the allow-list already; redact() is a second line of defence
    return { result: redact(await healthText($, !finished)) }
  }).catch(toolFailed)

  // ── Tests Claude runs itself: the result shows in the band and the Tests tab ──

  // No .catch that calls next again: the command has already run, and must not run twice
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const edits = phpEdits
    const ledger = editCount
    const result = await next(e)
    try {
      const command = String((e as unknown as { command?: string }).command ?? '')
      if (isLaravel && isTestCommand(command) && !('deny' in result && result.deny)) {
        const text = resultText(result)
        // Core marks a command that exited non-zero (`Exit code 255` first in its text): a summary printed before a crash isn't a pass
        const failed = 'isError' in result && result.isError ? Number(/^Exit code (\d+)/.exec(text)?.[1]) || 1 : undefined
        // A failure with no summary is a crashed run only when the runner started: `ls vendor/bin/pest` exiting 1 isn't one
        const clean = stripAnsi(text)
        const exitCode = failed !== undefined && !parseTestRun(clean) && !testRunnerStarted(command, clean) ? undefined : failed
        noteTestRun($, 'Claude ran ' + command.slice(0, 60), text, edits, ledger, command, exitCode)
      }
    } catch (err) {
      $.ui.log('lara-cc: could not read the test run: ' + String(err))
    }
    return result
  })

  // ── Laravel Boost: its log tools get the same ask and redaction as lara-cc's, and step behind its logs tool ──

  on('tool.describe', { tool: ['mcp__laravel-boost__read-log-entries', 'mcp__laravel-boost__last-error'] }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, description: described.description + ' Prefer mcp__lara-cc__logs: the same entries, asked for and redacted.', isDeferred: true }
  })

  on('tool.call', { tool: BOOST_LOG_TOOLS }, async ($, e, next) => {
    if (!(await mayShare($, "log entries through Laravel Boost's " + e.tool.replace('mcp__laravel-boost__', '')))) return { deny: NOT_SHARED }
    return redactedResult(await next(e))
  }).catch(() => ({ deny: 'lara-cc could not check this call, so it was not sent.' }))

  // Config values: a key that names a secret isn't read at all, and every value is redacted
  on('tool.call', { tool: 'mcp__laravel-boost__get-config' }, async ($, e, next) => {
    const key = String((e as unknown as { key?: string }).key ?? '')
    if (SECRET_CONFIG.test(key)) return { deny: `lara-cc refused ${key}: it can hold a secret (password, key, token). Ask the user if you need it.` }
    return redactedResult(await next(e))
  }).catch(() => ({ deny: 'lara-cc could not check this call, so it was not sent.' }))

  // Whatever else Boost prints (tinker, queries, schema, app info) reaches Claude redacted, like artisan output
  on('tool.call', { tool: BOOST_OTHER_TOOLS }, async ($, e, next) => redactedResult(await next(e))).catch(() => ({
    deny: 'lara-cc could not redact this result, so it was not sent.',
  }))

  // ── When Claude edits PHP: restart the queue worker, and remember the file for Pint ──

  // As with Bash: the edit has already been made, so nothing here may make it run again. A failed edit changed nothing, and
  // neither did one refused before it ran; but a deny can also come after it ran (a plugin withholding the result), which
  // undoes nothing: the file tells which
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const input = e as unknown as { file_path?: string; notebook_path?: string }
    const path = String(input.file_path ?? input.notebook_path ?? '')
    // Nothing outside the project is stat'd: a path it doesn't track can't be told apart after a deny, so a deny stands
    const rel = relativeTo(path, projectDir)
    const tracked = isLaravel && rel !== undefined && !isIgnoredRel(rel)
    const before = tracked ? await fileStamp($, path) : ''
    const result = await next(e)
    try {
      if ('isError' in result && result.isError) return result
      if ('deny' in result && result.deny && (!tracked || (await fileStamp($, path)) === before)) return result
      if (tracked) noteEdit(path, await nowMs($))
      if (!path.endsWith('.php')) return result
      editedPhp.add(path)
      phpEdits++
      // The last test run no longer covers the code
      if (lastTest) lastTest.editedSince = true
      if (settings.autoRestartQueue && services.queue.run) {
        restartTimer?.cancel()
        restartTimer = $.clock.after(2000, async () => {
          // No longer pending, whatever follows
          restartTimer = undefined
          restarting = true
          try {
            await restartService($, 'queue')
            // A worker that dies as it boots (a parse error in the edit) goes in this wait, so it isn't told as restarted
            const run = services.queue.run
            if (run) await Promise.race([run.done, $.clock.sleep(RESTART_SETTLE_MS)])
          } catch (err) {
            $.ui.log('lara-cc: queue restart after PHP edits failed: ' + String(err))
          } finally {
            restarting = false
          }
          const ok = !!services.queue.run
          if (since) since.restart = { at: await nowMs($), ok }
          $.ui.toast(ok ? `${services.queue.label} restarted after PHP edits` : `${services.queue.label} did not restart after PHP edits`)
          redraw($)
        })
      }
    } catch (err) {
      $.ui.log('lara-cc: after an edit: ' + String(err))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    // Claude may have cached config, installed packages or stopped Vite
    if (e.agentId === undefined) void checkHealth($)
    // A subagent's turn ending says nothing about the main one's edits
    if (e.agentId === undefined) {
      // Only what the stretch tracks: inside the project (`..` resolved), not vendor or a cache, never an env file (`.env.php`: Pint would rewrite it)
      const files = [...editedPhp].flatMap(f => {
        const rel = relativeTo(f, projectDir)
        return rel === undefined || isIgnoredRel(rel) || editKind(rel) === 'env' ? [] : [projectDir + '/' + rel]
      })
      const seq = editCount
      // The folder this turn ended in, not the one the chain finds when its turn comes (see afterTurn)
      const project = projectRun
      editedPhp.clear()
      // A stretch that already closed has nothing new to check
      const s = since?.closedAt === undefined ? since : undefined
      if (s) s.chains++
      if (s || files.length) {
        // A report waits for the syntax check, not for Pint after it
        const lint = lintDone.then(() => syntaxCheck($, s, project))
        syntaxDone = lint
        lintDone = lint.then(() => afterTurn($, s, files, seq, project)).catch(() => {})
      }
    }
    return next(e)
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // The Routes tab draws only the rows that fit, so the arrows walk them; the window follows the focus ring
  on('ui.focus', { requestId: PANE }, ($, e, next) => {
    const row = /^route-(\d+)$/.exec(e.element ?? '')
    if (row) {
      routeAt = Number(row[1])
      redraw($)
    }
    return next(e)
  })

  // Where the arrows scroll the pane instead, and for the wheel and page keys, they move the selected route
  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    const count = tab === 'routes' && routeList ? filterRoutes(routeList, routeFilter).length : 0
    // A pane too short for what it drew scrolls as usual, so nothing is out of reach
    if (!count || e.contentRows > e.bodyRows) return next(e)
    // Home and End ask for the drawing's whole height, the page keys for the window's
    const isEnd = Math.abs(e.by) === e.contentRows && e.contentRows !== e.bodyRows
    routeAt = isEnd ? (e.by < 0 ? 0 : count - 1) : Math.max(0, Math.min(count - 1, routeAt + e.by))
    redraw($)
    void $.ui.focus({ requestId: PANE, key: 'route-' + routeAt }).catch(() => undefined)
    return {}
  })

  // ── The band above the prompt: one line, only when there's something to show ──

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isLaravel || !settings.showBand || e.props.hasSurvey) return next(e)
    const running = Object.values(services).filter(s => s.run)
    const failedStored = snapshot?.failedTotal ?? 0
    // A read that failed or couldn't count them leaves the failed jobs unknown, not none
    const failedUnknown = !!snapshot && !!snapshotError && !failedStored
    const crashed = Object.values(services).filter(s => s.crashed && !s.crashed.seen)
    const failingTests = lastTest?.failed ?? 0
    // A run that ended without printing a summary: no count, but not a pass either
    const crashedTests = lastTest?.crashed !== undefined
    const stale = checksStale()
    // Claude's edits, once a turn has ended: a syntax error, or tests that don't cover them
    const now = since ? await nowMs($) : 0
    const report = verifyRows($, now)
    const verify = bandVerify($, now, report)
    const testsRow = report?.rows.find(r => r.check === 'Tests')
    if (!running.length && !crashed.length && !unseenErrors && !failedStored && !failedUnknown && !pendingMigrations && !failingTests && !crashedTests && !checks.length && !stale && !verify) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const theirs = await next(e)
    // `dim`: a count kept from before a re-read that failed
    type Item = { text: string; color?: string; fix?: Fix; dim?: boolean }
    const items: Item[] = []
    for (const s of running) {
      const extra = s.name === 'queue' && (stats.done || stats.failed) ? ` ${stats.done}✓${stats.failed ? ` ${stats.failed}✗` : ''}` : ''
      items.push({ text: '●', color: 'green' }, { text: s.name + extra })
    }
    // A passing run isn't drawn when the report says it no longer covers Claude's edits (before a PHP edit or any other
    // tracked one, or an unclear or partial run): a green count beside "tests not run" would contradict itself
    const covers = !testsRow || (testsRow.verdict === 'passed' && !testsRow.partial)
    if (lastTest && !failingTests && !crashedTests && !lastTest.editedSince && covers) items.push({ text: `✓ ${plural(lastTest.passed, 'test')}`, color: 'green' })
    // Never green. Tests that failed already have their own item below, so only a syntax error joins them
    if (verify && (verify.color === 'red' || !failingTests)) items.push({ text: verify.text, color: verify.color })
    for (const s of crashed) {
      items.push({ text: `✗ ${s.name} exited (${s.crashed!.code})`, color: 'red', fix: { label: `restart ${s.name}`, run: () => restartService($, s.name) } })
    }
    if (failingTests) {
      items.push(
        lastTest!.editedSince
          ? { text: `✗ ${plural(failingTests, 'test')} failed, edited since`, color: 'yellow' }
          : { text: `✗ ${plural(failingTests, 'test')} failing`, color: 'red' },
      )
    }
    if (crashedTests) items.push({ text: `✗ tests exited (${lastTest!.crashed})`, color: lastTest!.editedSince ? 'yellow' : 'red' })
    if (unseenErrors) items.push({ text: `▲ ${plural(unseenErrors, 'new error')}`, color: 'red' })
    if (failedStored) {
      items.push({ text: plural(failedStored, 'failed job') + (snapshotError ? ' (last read failed)' : ''), color: 'yellow', dim: !!snapshotError })
    } else if (failedUnknown) items.push({ text: '? failed jobs unknown', color: 'yellow', dim: true })
    if (pendingMigrations) {
      items.push({ text: plural(pendingMigrations, 'pending migration') + (migrationsFailed ? ' (last check failed)' : ''), color: 'yellow', dim: !!migrationsFailed, fix: { label: 'migrate', run: migrateFix($) } })
    }
    // In items, so it's never folded away. runFix checks again once this returns
    if (stale) items.push({ text: checkedAt ? `? checks stale (${ago(checkedAt)})` : '? checks not run', color: 'yellow', fix: { label: 'recheck', run: async () => {} } })
    const warnings: Item[] = checks.map(c => ({ text: `${mark(c)} ${c.band}`, color: c.color, fix: c.fix }))

    // Too wide for one row: drop the fix buttons, then fold the warnings into a count (the Services tab has both)
    const widthOf = (list: Item[], withFixes: boolean) =>
      list.reduce((n, i) => n + i.text.length + 2 + (withFixes && i.fix ? i.fix.label.length + 3 : 0), 'lara-cc  open'.length)
    let shown = [...items, ...warnings]
    let withFixes = widthOf(shown, true) <= e.props.bodyColumns
    if (!withFixes && widthOf(shown, false) > e.props.bodyColumns) {
      shown = [...items]
      // Folded under the marker of what's folded: only unchecked or inferred findings aren't warnings
      const seen = checks.some(c => c.known === 'seen')
      const count = seen ? `⚠ ${plural(checks.length, 'warning')}` : `? ${checks.length} unchecked`
      if (checks.length) shown.push({ text: count, color: checks.some(c => c.color === 'red') ? 'red' : 'yellow' })
      withFixes = widthOf(shown, true) <= e.props.bodyColumns
    }
    const parts = shown.flatMap(i => {
      const fix = withFixes ? i.fix : undefined
      const text = (
        <Text color={i.color} dimColor={i.dim}>
          {i.text + (fix ? ' ' : i.text === '●' ? ' ' : '  ')}
        </Text>
      )
      if (!fix) return [text]
      // A fix runs only on the person's press
      const busy = fixing.has(fix.label)
      return [text, <Button key={'fix-' + fix.label} label={busy ? 'running…' : fix.label} dimColor={busy} onPress={() => void runFix($, fix)} />, <Text>{'  '}</Text>]
    })

    // The Services tab explains crashes and checks
    const target: Tab = crashed.length ? 'services' : failingTests || crashedTests || verify?.color === 'red' ? 'tests' : unseenErrors ? 'log' : failedStored ? 'queue' : verify ? 'tests' : 'services'
    const band = (
      <Box flexDirection="row">
        <Text dimColor>{'lara-cc  '}</Text>
        {parts}
        <Button key="band-open" label="open" plain dimColor onPress={() => void openPane($, target)} />
      </Box>
    )
    return theirs ? (
      <Box flexDirection="column">
        {band}
        {theirs}
      </Box>
    ) : (
      band
    )
  })

  // ── The pane ──

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Text fields exist in the terminal and the Desktop app, not in VS Code or mobile
    const Input = 'Input' in elements ? elements.Input : undefined
    const width = e.props.bodyColumns ?? 80
    const rows = Math.max(10, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30) - 6)

    const line = (text: string, dim = false, color?: string) => (
      <Text dimColor={dim} color={color} wrap="truncate-end">
        {text.slice(0, width + 20) || ' '}
      </Text>
    )

    const tabButton = (id: Tab, label: string, hotkey: string) => (
      <Button key={'tab-' + id} label={label} hotkey={hotkey} plain dimColor={tab !== id} onPress={() => void openPane($, id)} />
    )

    // Claude's edits, on the Tests tab (the rows) and the Services tab (one line)
    const verify = verifyRows($, since ? await nowMs($) : 0)
    const errorBadge = unseenErrors ? ` (${unseenErrors})` : ''
    const failedBadge = snapshot?.failedTotal ? ` (${snapshot.failedTotal})` : ''
    const tabs: [Tab, string, string][] = [
      ['services', 'Services', 's'],
      ['queue', 'Queue' + failedBadge, 'q'],
      ['log', 'Log' + errorBadge, 'l'],
      ['tests', 'Tests' + (lastTest?.failed ? ` (${lastTest.failed})` : lastTest?.crashed !== undefined ? ' (!)' : ''), 't'],
      ['routes', 'Routes', 'r'],
      ['commands', 'Commands', 'c'],
      ['about', 'About', 'a'],
    ]
    const header = (
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {tabs.map(([id, label, hotkey]) => tabButton(id, label, hotkey))}
      </Box>
    )
    // Rows the header wraps to: each tab is drawn `s: Services`, two columns apart
    const headerRows = Math.ceil(tabs.reduce((n, [, label]) => n + label.length + 5, -2) / width)

    const toggleButton = (key: 'autoRestartQueue' | 'pintAfterTurn' | 'lintAfterTurn' | 'showBand' | 'errorToasts', label: string) => (
      <Button key={'set-' + key} label={`${settings[key] ? '[x]' : '[ ]'} ${label}`} plain dimColor={!settings[key]} onPress={() => void toggle($, key)} />
    )

    let body
    if (tab === 'services') {
      const shown = services[logOf]
      const autostart = settings.autostart[projectDir] ?? []
      const herdText = herdList.map(s => `○ ${s.name} ${s.version} :${s.port}` + (s.up === 'up' ? '' : s.up === 'down' ? ' starting…' : ' unchecked starting…'))
      // The Herd row wraps on a narrow pane
      const herdRows = herdList.length ? Math.ceil(['Herd services (port check)', ...herdText].join('  ').length / width) : 0
      // When the checks ran, and what they couldn't check: not fine, not broken (the health tool lists the same)
      const stale = checksStale()
      const missing = notChecked().map(n => n.label)
      const ran = checkedAt
        ? `checks ${stale ? 'stale, last finished' : 'ran'} ${ago(checkedAt)} ago${checks.length || missing.length ? '' : ': nothing found'}`
        : 'checks not run yet'
      const notCheckedText = missing.length ? `· not checked: ${missing.join(', ')}` : ''
      const checksRows = Math.ceil(`${ran} ${notCheckedText} recheck`.length / width)
      body = (
        <Box flexDirection="column">
          {phpInfo && <Text dimColor>{phpInfo}</Text>}
          {herdList.length > 0 && (
            <Box flexDirection="row" columnGap={2} flexWrap="wrap">
              <Text dimColor>Herd services (port check)</Text>
              {herdList.map(s =>
                s.up === 'up' ? (
                  <Text color="green">{`● ${s.name} ${s.version} :${s.port}`}</Text>
                ) : (
                  <Box flexDirection="row" columnGap={1}>
                    <Text dimColor>{s.up === 'down' ? `○ ${s.name} ${s.version} :${s.port}` : `? ${s.name} ${s.version} :${s.port} unchecked`}</Text>
                    <Button
                      key={'herd-start-' + s.port}
                      label={herdStarting.has(s.port) ? 'starting…' : 'start'}
                      dimColor={herdStarting.has(s.port)}
                      onPress={() => void startHerdService($, s)}
                    />
                  </Box>
                ),
              )}
            </Box>
          )}
          {herdList.length > 0 && (
            <Box flexDirection="row" columnGap={2} flexWrap="wrap">
              <Button
                key="herd-debug"
                label={{ off: 'start Herd debug session', starting: 'starting…', on: '● stop debug session', stopping: 'stopping…' }[debugState]}
                dimColor={debugState === 'starting' || debugState === 'stopping'}
                onPress={() => void toggleDebugSession($)}
              />
              {debugState === 'on' && <Text color="yellow">recording queries, logs, dumps and HTTP calls</Text>}
              {debugState === 'off' && debugCapture && <Text dimColor>{`last session: ${debugCapture.summary} (${ago(debugCapture.at)} ago)`}</Text>}
              {debugState === 'off' && debugCapture && <Button key="debug-ask" label="ask Claude" plain onPress={() => void askAboutDebugCapture($)} />}
            </Box>
          )}
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text dimColor={!stale} color={stale ? 'yellow' : undefined}>
              {ran}
            </Text>
            {notCheckedText && <Text dimColor>{notCheckedText}</Text>}
            <Button key="checks-recheck" label={checking ? 'checking…' : 'recheck'} plain dimColor onPress={() => void recheck($)} />
          </Box>
          {verify && (
            <Box flexDirection="row" columnGap={1} flexWrap="wrap">
              <Text dimColor>
                {[`Claude's edits: ${plural(verify.files, 'file')}`, ...(['Syntax', 'Tests'] as const).flatMap(check => verify.rows.filter(r => r.check === check).map(r => `${check.toLowerCase()} ${verdictText(r)}`))].join(' · ')}
              </Text>
              <Button key="since-details" label="details" plain dimColor onPress={() => void openPane($, 'tests')} />
            </Box>
          )}
          {checks.map(c => (
            <Box flexDirection="row" columnGap={1}>
              <Text color={c.color}>{`${mark(c)} ${c.detail}`}</Text>
              {c.fix && (
                <Button
                  key={'check-fix-' + c.fix.label}
                  label={fixing.has(c.fix.label) ? 'running…' : c.fix.label}
                  dimColor={fixing.has(c.fix.label)}
                  onPress={() => void runFix($, c.fix!)}
                />
              )}
            </Box>
          ))}
          {Object.values(services).map(svc => (
            <Box flexDirection="row" columnGap={1}>
              <Text color={svc.run ? 'green' : undefined} dimColor={!svc.run}>
                {svc.run ? '●' : '○'}
              </Text>
              <Text bold>{svc.label.padEnd(13)}</Text>
              {svc.crashed && !svc.run ? (
                <Text color="red">{`exited (${svc.crashed.code})`.padEnd(13)}</Text>
              ) : (
                <Text dimColor>{(svc.run ? 'running ' + ago(svc.startedAt ?? Date.now()) : svc.lines.length ? 'stopped' : 'not started').padEnd(13)}</Text>
              )}
              {svc.run ? (
                <Button key={'stop-' + svc.name} label="stop" onPress={() => void stopService($, svc.name)} />
              ) : (
                <Button key={'start-' + svc.name} label="start" onPress={() => void startService($, svc.name)} />
              )}
              <Button key={'restart-' + svc.name} label="restart" onPress={() => void restartService($, svc.name)} />
              <Button
                key={'log-' + svc.name}
                label="output"
                dimColor={logOf !== svc.name}
                onPress={() => {
                  logOf = svc.name
                  redraw($)
                }}
              />
              <Button
                key={'auto-' + svc.name}
                label={autostart.includes(svc.name) ? '[x] autostart' : '[ ] autostart'}
                plain
                dimColor={!autostart.includes(svc.name)}
                onPress={() => void toggleAutostart($, svc.name)}
              />
            </Box>
          ))}
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {toggleButton('autoRestartQueue', 'restart queue on PHP edits')}
            {toggleButton('lintAfterTurn', 'syntax check after each turn')}
            {hasPint && toggleButton('pintAfterTurn', 'Pint after each turn')}
            {toggleButton('errorToasts', 'error toasts')}
            {toggleButton('showBand', 'status band')}
          </Box>
          <Text> </Text>
          <Text bold>{shown?.label ?? ''} output</Text>
          {(shown?.lines.length ? shown.lines.slice(-Math.max(3, rows - Object.keys(services).length - 4 - (phpInfo ? 1 : 0) - herdRows - (herdList.length ? 1 : 0) - checks.length * 2 - checksRows - (verify ? 1 : 0))) : ['(no output yet)']).map(l => line(l, true))}
        </Box>
      )
    } else if (tab === 'queue') {
      const avg = stats.done ? Math.round(stats.totalMs / stats.done) : 0
      const failed = snapshot?.failed ?? []
      const recent = jobs.slice(-Math.max(3, Math.floor((rows - 8) / 2)))
      // When the counts shown were read: after a read that couldn't count, the last full one's
      const readAt = sizesRead ? snapshotAt : snapshotOkAt
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text>
              {snapshot ? `connection ${snapshot.connection}` : snapshotLoad ? 'reading queue…' : 'queue state unknown'}
            </Text>
            {snapshot && (
              <Text dimColor>{Object.entries(snapshot.sizes).map(([q, n]) => `${q}: ${n} pending`).join('  ')}</Text>
            )}
            <Button key="queue-refresh" label={readAt ? `refresh (read ${ago(readAt)} ago)` : 'refresh'} plain dimColor onPress={() => void refreshQueue($)} />
            {snapshotError && <Text dimColor>(last read failed)</Text>}
          </Box>
          {snapshot?.connection === 'sync' && line('QUEUE_CONNECTION=sync: jobs run inline during the request, so no worker is needed.', false, 'yellow')}
          {snapshotError && line(snapshotError, false, 'red')}
          <Text>
            {`${services.queue.label}: ${services.queue.run ? 'running' : 'not running in this session'}  ·  ${stats.done} done  ·  ${stats.failed} failed${stats.done ? `  ·  avg ${avg}ms` : ''}`}
          </Text>
          <Text> </Text>
          <Text bold>Recent jobs</Text>
          {recent.length
            ? recent.map(j =>
                line(
                  `${j.status === 'done' ? '✓' : j.status === 'failed' ? '✗' : '…'} ${clock(j.time)} ${shortClass(j.job)}${j.ms !== undefined ? `  ${Math.round(j.ms)}ms` : ''}`,
                  j.status === 'done',
                  j.status === 'failed' ? 'red' : j.status === 'running' ? 'yellow' : undefined,
                ),
              )
            : line(services.queue.run ? 'Waiting for jobs…' : 'Start the worker (Services tab or /lara-queue start) to see jobs here.', true)}
          <Text> </Text>
          <Box flexDirection="row" columnGap={2}>
            <Text bold>{`Failed jobs (${snapshot?.failedTotal ?? 0})`}</Text>
            {failed.length > 0 && <Button key="retry-all" label="retry all" plain onPress={() => void retryFailed($, 'all')} />}
          </Box>
          {failed.slice(0, Math.max(2, Math.floor((rows - recent.length - 8) / 2))).map(f => (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text color="red">✗</Text>
                <Text bold>{shortClass(f.job)}</Text>
                <Text dimColor>{`${f.queue} · ${f.failedAt}`}</Text>
                <Button key={'retry-' + f.id} label="retry" plain onPress={() => void retryFailed($, f.id)} />
                <Button key={'forget-' + f.id} label="forget" plain dimColor onPress={() => void forgetFailed($, f.id)} />
                <Button key={'ask-' + f.id} label="ask Claude" plain onPress={() => void askAboutFailedJob($, f)} />
              </Box>
              {line('  ' + exceptionHeadline(f.exception), true)}
            </Box>
          ))}
        </Box>
      )
    } else if (tab === 'log') {
      const list = filteredLog(logFilter)
      const latestError = [...logState.entries].reverse().find(isError)
      const filterButton = (id: typeof logFilter, label: string) => (
        <Button
          key={'filter-' + id}
          label={label}
          plain
          dimColor={logFilter !== id}
          onPress={() => {
            logFilter = id
            redraw($)
          }}
        />
      )
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {filterButton('all', 'all')}
            {filterButton('warnings', 'warnings+')}
            {filterButton('errors', 'errors')}
            {latestError && <Button key="ask-error" label="ask Claude about latest error" plain onPress={() => void askAboutError($, latestError)} />}
            <Button key="log-clear" label="clear log" plain dimColor onPress={() => void clearLog($)} />
          </Box>
          <Text dimColor>{`${logPath || 'storage/logs'} · ${logRun ? 'following' : 'not following'} · ${list.length} entries`}</Text>
          {list.length === 0 && <Text dimColor>Nothing logged yet.</Text>}
          {list.slice(-(rows - 2)).map(entry => {
            const where = isError(entry) ? origin(entry, projectDir) : undefined
            const color = isError(entry) ? 'red' : isWarning(entry) ? 'yellow' : undefined
            return line(`${clock(entry.time)} ${entry.level.padEnd(8)} ${headline(entry)}${where ? `  (${where})` : ''}`, !color, color)
          })}
        </Box>
      )
    } else if (tab === 'commands') {
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {QUICK.map(q => (
              <Button key={'quick-' + q.key} label={q.label} hotkey={q.key} plain onPress={() => void runCommand($, q.label, q.argv)} />
            ))}
          </Box>
          {Input && (
            <Input
              key="artisan-input"
              label="artisan"
              placeholder="make:model Post -m"
              value=""
              submitLabel="run"
              onSubmit={value => {
                if (value.trim()) void runCommand($, 'artisan ' + value, ['php', 'artisan', ...splitArgs(value), '--no-interaction'])
              }}
            />
          )}
          <Text> </Text>
          {lastRun ? (
            <Box flexDirection="column">
              <Text bold color={lastRun.isRunning ? 'yellow' : lastRun.exitCode === 0 ? 'green' : 'red'}>
                {lastRun.isRunning ? '… ' + lastRun.label : (lastRun.exitCode === 0 ? '✓ ' : '✗ ') + lastRun.label}
              </Text>
              {/* Output shown on Claude's request is drawn whole, for the pane to scroll: the person was told it's there */}
              {(lastRun.whole ? lastRun.output.split('\n') : lastRun.output.split('\n').slice(-(rows - 5))).map(l => line(l, true))}
            </Box>
          ) : (
            <Text dimColor>Press a number to run a command, or type an artisan command.</Text>
          )}
        </Box>
      )
    } else if (tab === 'tests') {
      const t = lastTest
      // One command at a time: a run would replace what the Commands tab shows of another
      const busy = !!lastRun?.isRunning
      const perFailure = 3
      // Claude's edits: a block above the last run, from the same rows Claude's health tool lists. A parse error's own
      // text is the person's only: it can quote the code, so it's drawn here and never goes to Claude
      const shownVerdict: Record<Verdict, [string, string | undefined, boolean]> = {
        passed: ['✓ passed', 'green', false],
        failed: ['✗ failed', 'red', false],
        'not run': ['○ not run', 'yellow', false],
        skipped: ['− skipped', undefined, true],
        unknown: ['? unknown', 'yellow', true],
        done: ['↻ done', undefined, true],
      }
      const parseErrors = [...(since?.lint?.files ?? [])].filter(([rel, rec]) => rec.verdict === 'failed' && rec.raw && rec.seq >= (since!.files.get(rel)?.seq ?? 0)).slice(0, 3)
      const parseLines = parseErrors.flatMap(([rel, rec]) => [`${rel}${rec.line ? ':' + rec.line : ''}`, ...rec.raw!.split('\n').filter(l => l.trim()).slice(-6).map(l => '  ' + l)])
      const room = Math.max(1, Math.floor((rows - 5 - (verify ? verify.rows.length + parseLines.length + 4 + (verify.noCheck ? 1 : 0) : 0)) / perFailure))
      const newestError = since?.newestError
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            <Button
              key="tests-run"
              label={testsRunning ? 'running…' : busy ? 'run tests (waiting for ' + lastRun!.label + ')' : 'run tests'}
              dimColor={busy}
              onPress={() => {
                if (!busy) void runCommand($, 'test', ['php', 'artisan', 'test'])
              }}
            />
            {t && t.failures.length > 1 && <Button key="tests-ask-all" label="ask Claude to fix all" plain onPress={() => askAboutTests($, t.failures)} />}
          </Box>
          {verify && (
            <Box flexDirection="column">
              <Text bold>Since Claude's edits</Text>
              <Text dimColor>{verify.header}</Text>
              {verify.rows.map(r => {
                const [glyph, color, dim] = shownVerdict[r.verdict]
                return (
                  <Box flexDirection="row" columnGap={1} flexWrap="wrap">
                    <Text color={color} dimColor={dim}>{r.partial ? '✓ passed (subset only)' : glyph}</Text>
                    <Text bold>{r.check}</Text>
                    <Text dimColor>{r.detail}</Text>
                    {/* The Tests row's button is the one at the top; Claude's `next:` line names each of these */}
                    {r.button && r.check !== 'Tests' && (
                      <Button
                        key={'verify-' + r.button.label}
                        label={fixing.has(r.button.label) ? 'running…' : r.button.label}
                        dimColor={fixing.has(r.button.label)}
                        onPress={() => void runFix($, r.button!)}
                      />
                    )}
                  </Box>
                )
              })}
              {parseLines.map(l => line(l, true))}
              <Box flexDirection="row" columnGap={1} flexWrap="wrap">
                <Text dimColor>{verify.observed}</Text>
                <Button key="verify-open-log" label="open Log" plain dimColor onPress={() => void openPane($, 'log')} />
              </Box>
              {since && since.errors > 0 && newestError && line('newest: ' + headline(newestError), true, 'red')}
              {verify.noCheck && <Text dimColor>{verify.noCheck}</Text>}
              <Text> </Text>
            </Box>
          )}
          {!t && <Text dimColor>No test run yet this session. Run them here, with /lara-test, or let Claude run them: the result shows here and in the band.</Text>}
          {t && (
            <Text bold color={t.failed || t.crashed !== undefined ? 'red' : 'green'}>
              {t.crashed !== undefined ? `✗ ${testCounts(t)}` : (t.failed ? `✗ ${t.failed} failed, ` : '✓ ') + `${t.passed} passed` + (t.skipped ? `, ${t.skipped} skipped` : '')}
            </Text>
          )}
          {t && <Text dimColor>{`${t.label} · ${ago(t.at)} ago`}</Text>}
          {t?.editedSince && <Text dimColor>Claude edited PHP files since this run; not re-run</Text>}
          {t && t.failed > 0 && !t.failures.length && <Text dimColor>The output didn't include the failures. Run the tests here to see them.</Text>}
          {t?.crashed !== undefined && <Text dimColor>The run died before a summary: the Commands tab shows what it printed, when it ran here.</Text>}
          {t?.failures.slice(0, room).map((f, i) => (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text color="red">{'✗ ' + f.name}</Text>
                <Button key={'ask-test-' + i} label="ask Claude" plain onPress={() => askAboutTest($, f)} />
              </Box>
              {f.detail
                .filter(l => l.trim())
                .slice(0, perFailure - 1)
                .map(l => line('    ' + l, true))}
            </Box>
          ))}
          {t && t.failures.length > room && line(`…and ${t.failures.length - room} more`, true)}
        </Box>
      )
    } else if (tab === 'routes') {
      const shown = routeList ? filterRoutes(routeList, routeFilter) : []
      const count = !routeList
        ? routesLoading
          ? 'Loading routes…'
          : 'No routes'
        : `${shown.length} of ${plural(routeList.length, 'route')}`
      const hint = '↑↓ browse · enter opens the code or the page'
      const refresh = routesLoading ? 'loading…' : 'refresh'
      // Only the rows that fit are drawn, each a Button: with nothing to scroll the arrows walk them, and the
      // window keeps a row drawn beyond the selected one so the next press always lands. Around the list: the
      // header, a blank row, the filter, the summary row (as wrapped), an error, the selected route's line, a spare
      const summaryRows = Math.ceil((count.length + 13 + (shown.length ? hint.length + 2 : 0) + (Input ? 11 : 0) + refresh.length) / width)
      const chrome = headerRows + 1 + (Input ? 1 : 0) + summaryRows + (routesError ? 1 : 0) + (shown.length ? 1 : 0) + 1
      const routeRows = Math.max(1, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30) - chrome)
      routeAt = Math.min(routeAt, Math.max(0, shown.length - 1))
      routeTop = routeWindow(routeAt, routeTop, routeRows, shown.length)
      const visible = shown.slice(routeTop, routeTop + routeRows)
      const selected = shown[routeAt]
      // Sized to the whole filtered list, so the columns stay put while scrolling, and cut to fit the pane: a
      // row is the marker, the method, then the URI, name and action with a gap before each
      const widest = (of: (r: TabRoute) => string) => shown.reduce((n, r) => Math.max(n, of(r).length), 0)
      const methodWidth = Math.min(9, Math.max(3, widest(r => methodLabel(r.method))))
      const room = Math.max(0, width - 4 - methodWidth)
      const uriWidth = Math.max(1, Math.min(widest(uriText), Math.floor(room * 0.5)))
      const nameWidth = Math.min(widest(r => r.name ?? ''), Math.floor(room * 0.25))
      const actionWidth = room - uriWidth - (nameWidth ? nameWidth + 2 : 0) - 2
      const setFilter = (value: string) => {
        routeFilter = value
        routeAt = routeTop = 0
        redraw($)
      }
      // The selected row is marked as well as ringed, so it shows while the focus is on the filter
      const routeRow = (r: TabRoute, i: number) => (
        <Button key={'route-' + i} label={routeLabel(r)} plain onPress={() => void openRoute($, r)}>
          <Text bold>{i === routeAt ? '› ' : '  '}</Text>
          <Text color={methodColor(methodLabel(r.method))}>{fit(methodLabel(r.method), methodWidth) + '  '}</Text>
          {fit(uriText(r), uriWidth)
            .split(/(\{[^}]*\})/)
            .filter(Boolean)
            .map(part => (
              <Text color={part.startsWith('{') ? 'cyan' : undefined}>{part}</Text>
            ))}
          {nameWidth > 0 && <Text dimColor>{'  ' + fit(r.name ?? '', nameWidth)}</Text>}
          {actionWidth > 0 && <Text dimColor>{'  ' + fit(shortClass(r.action), actionWidth, false)}</Text>}
        </Button>
      )
      body = (
        <Box flexDirection="column">
          {Input && (
            <Input
              key="route-filter"
              label="filter"
              placeholder="uri, name or controller"
              value={routeFilter}
              submitLabel="browse"
              onInput={setFilter}
              onSubmit={value => {
                setFilter(value)
                void focusRoute($)
              }}
            />
          )}
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            <Text dimColor>{count + (shown.length > visible.length ? `  (${routeTop + 1}–${routeTop + visible.length})` : '')}</Text>
            {shown.length > 0 && <Text dimColor>{hint}</Text>}
            {Input && <Button key="route-find" label="filter" hotkey="f" plain dimColor onPress={() => void $.ui.focus({ requestId: PANE, key: 'route-filter' }).catch(() => undefined)} />}
            <Button key="routes-refresh" label={refresh} plain dimColor onPress={() => void loadRouteList($)} />
          </Box>
          {!!routesError && line(routesError, false, 'red')}
          {routeList && !shown.length && <Text dimColor>{`No routes match "${routeFilter}".`}</Text>}
          {visible.map((r, i) => routeRow(r, routeTop + i))}
          {selected && line(`→ ${selected.file ? `${selected.file}:${selected.line}  ` : ''}${selected.action}${selected.onDomain ? '  (on its own domain)' : ''}`, true)}
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column">
          {pendingMigrations > 0 && line(`${plural(pendingMigrations, 'pending migration')}: run /lara-artisan migrate`, false, 'yellow')}
          {hasBoost && (
            <Text dimColor>
              Laravel Boost is installed. Its log tools ask before sending and are redacted, like lara-cc's logs tool; get-config refuses keys that can hold secrets; every other
              Boost tool's output (tinker, database-query…) is redacted.
            </Text>
          )}
          {!about && <Text dimColor>Loading `php artisan about`…</Text>}
          {about &&
            Object.entries(about).map(([section, values]) => (
              <Box flexDirection="column">
                <Text bold>{section}</Text>
                {Object.entries(values ?? {}).map(([k, v]) =>
                  line(`  ${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`, true),
                )}
              </Box>
            ))}
          <Button
            key="about-refresh"
            label="refresh"
            plain
            dimColor
            onPress={() => {
              void loadAbout($).then(() => checkHealth($))
              void checkMigrations($)
            }}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        <Text> </Text>
        {body}
      </Box>
    )
  })
}
