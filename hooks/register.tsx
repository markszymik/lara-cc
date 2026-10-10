import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import {
  artisanCommandName,
  clock,
  composerDrift,
  connectionsPhp,
  durationMs,
  exceptionHeadline,
  feedLog,
  formatEntry,
  headline,
  helpName,
  herdNeeds,
  herdServices,
  isError,
  isTestCommand,
  isWarning,
  localHotUrl,
  newLogState,
  npmDrift,
  origin,
  parseConnections,
  parseDebugCapture,
  parseSnapshot,
  parseTestRun,
  parseWorkerLine,
  queuesOf,
  redact,
  redactData,
  refusedOptions,
  shortClass,
  snapshotPhp,
  splitArgs,
  stripAnsi,
  tail,
} from './parse'
import type { AppConnection, FailedJob, HerdService, LogEntry, QueueSnapshot, TestFailure, TestRun } from './parse'

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
 * Claude gets tools: artisan, service, routes, logs and queue.
 */

type Api = EngineInterface

// ─── Config: edit these to taste ───────────────────────────────────────────

/** Long-running processes the mod can start, stop and restart. `vite` and `queue` are adjusted at start-up. */
const SERVICES: Record<string, { label: string; argv: string[] }> = {
  queue: { label: 'Queue worker', argv: ['php', 'artisan', 'queue:work', '--tries=1'] },
  vite: { label: 'Vite dev', argv: ['npm', 'run', 'dev'] },
  schedule: { label: 'Scheduler', argv: ['php', 'artisan', 'schedule:work'] },
}

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

/** Artisan commands Claude's tool refuses because they print secrets: config values (passwords, APP_KEY) or the .env encryption key. */
const CONFIDENTIAL = ['config:show', 'env:encrypt', 'env:decrypt']

/** Laravel Boost's MCP tools that read logs: asked for and redacted like lara-cc's logs tool. */
const BOOST_LOG_TOOLS = /^mcp__laravel-boost__(read-log-entries|last-error|browser-logs)$/

/** Every other Boost tool, in any version (tinker, database-query, schema, app info…): its output is redacted. get-config has its own guard. */
const BOOST_OTHER_TOOLS = /^mcp__laravel-boost__(?!(read-log-entries|last-error|browser-logs|get-config)$)/

/** Config keys whose value can be a secret: refused for Boost's get-config (`app.key`, `*.password`, `services.*.secret`…). */
const SECRET_CONFIG = /(^|[._-])(key|keys|pass(word)?|pwd|secret|token|auth|credentials?|dsn|url|cookie|signature|salt|private)([._-]|$)/i

const PANE = 'lara'
const MAX_SERVICE_LINES = 400
const TOAST_GAP_MS = 5000

// ─── State (module variables reset when the mod reloads; child processes die with it) ──

type Tab = 'services' | 'queue' | 'log' | 'tests' | 'routes' | 'commands' | 'about'
type Run = { stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>; done: Promise<void> }
/** `crashed`: the exit code of a run that ended on its own with an error; `seen` once the Services tab showed it. */
type Service = { name: string; label: string; argv: string[]; run?: Run; lines: string[]; startedAt?: number; partial: string; crashed?: { code: number; seen: boolean } }
type LastRun = { label: string; isRunning: boolean; exitCode?: number; output: string }
type Route = { method: string; uri: string; name: string | null; action: string }
type Job = { job: string; time: string; status: 'running' | 'done' | 'failed'; ms?: number }
type Settings = {
  autoRestartQueue: boolean
  pintAfterTurn: boolean
  showBand: boolean
  errorToasts: boolean
  autostart: Record<string, string[]>
}

const DEFAULT_SETTINGS: Settings = { autoRestartQueue: true, pintAfterTurn: false, showBand: true, errorToasts: true, autostart: {} }

const services: Record<string, Service> = {}
for (const [name, def] of Object.entries(SERVICES)) {
  services[name] = { name, label: def.label, argv: [...def.argv], lines: [], partial: '' }
}

let settings: Settings = { ...DEFAULT_SETTINGS }
let projectDir = ''
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
let lastRun: LastRun | undefined
let about: Record<string, Record<string, unknown>> | undefined
let routes: Route[] | undefined
let routeFilter = ''
let pendingMigrations = 0
// Fixes running from a band or Services tab button, by label, so the button reads "running…"
const fixing = new Set<string>()
// A test run started by runCommand is in progress (the Tests tab's button waits for it)
let testsRunning = false
// The last test run this session: /lara-test, the Tests tab, the artisan tool or Claude's Bash (see noteTestRun)
let lastTest: (TestRun & { label: string; at: number }) | undefined
// Herd's debug session (queries, logs, dumps, HTTP calls the app made), started from the Services tab
type DebugState = 'off' | 'starting' | 'on' | 'stopping'
let debugState: DebugState = 'off'
let debugCapture: { data: unknown; summary: string; at: number } | undefined
// Laravel Boost's MCP server is installed: its log tools get the same ask and redaction as lara-cc's
let hasBoost = false
// The person let log entries and failed-job exceptions go to Claude for the rest of this session (see mayShare)
let shareAllowed = false
const editedPhp = new Set<string>()

// Log monitoring
let logPath = ''
let logState = newLogState()
let logRun: { stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> } | undefined
let logFilter: 'all' | 'warnings' | 'errors' = 'all'
let unseenErrors = 0
let logReady: Promise<void> = Promise.resolve()

// Health checks: things that quietly break the app (see checkHealth)
/** `fix`: what the check's button runs, only ever on the person's press; it may return a line to show. */
type Fix = { label: string; run: () => Promise<string | void> }
type Check = { band: string; color: 'red' | 'yellow'; detail: string; fix?: Fix; backlog?: true }
let checks: Check[] = []
let checking = false
let checkAgain = false
let depsSeen = ''
let depsChecks: Check[] = []
// Herd's installed services and whether each listens; services.plist is re-read only when it changes
let herdList: (HerdService & { up: boolean })[] = []
let herdSeen = -2
let herdInstalled: HerdService[] = []
// Ports of the Herd services a start button is starting, so it reads "starting…" meanwhile
const herdStarting = new Set<number>()
// The driver and port of each local server the app's config connects to (see connectionsPhp), read with `about`
let connections: AppConnection[] = []

// Queue monitoring
let jobs: Job[] = []
const stats = { done: 0, failed: 0, totalMs: 0 }
let snapshot: QueueSnapshot | undefined
let snapshotAt = 0
let snapshotError = ''
let snapshotLoading = false
// The jobs waiting at the snapshot before this one, to tell a backlog from a queue a worker elsewhere drains
let waitingBefore: number | undefined

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
  if (on === 'routes' && !routes) void loadRoutes($)
  if (on === 'queue') void refreshQueue($)
  paneOpen = true
  await $.ui.open({ id: PANE, title: 'lara-cc', focus: true, closeOnEscape: true })
  redraw($)
}

// ─── Settings (kept between sessions) ──────────────────────────────────────

async function loadSettings($: Api) {
  const saved = await $.store.get('settings')
  if (saved && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...(saved as Partial<Settings>) }
}

async function toggle($: Api, key: 'autoRestartQueue' | 'pintAfterTurn' | 'showBand' | 'errorToasts') {
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
    const r = await $.process.run([...argv, '-r', 'echo PHP_BINARY, "\\n", PHP_VERSION;'], { timeoutMs: 15_000 })
    // The last two lines: PHP may print warnings first
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
  const [herd, shell, hasHerd] = await Promise.all([probePhp($, ['herd', 'php']), probePhp($, ['php']), onPath($, 'herd')])
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
  if (r?.exitCode === 0 && /^Composer version/m.test(r.stdout)) composerArgv = [herd.binary, composer]
}

/** `argv` with php, composer and Pint run on the PHP that serves this folder. */
function withPhp(argv: string[]): string[] {
  const [cmd = '', ...rest] = argv
  if (cmd === 'php') return [phpBin, ...rest]
  if (cmd === 'composer') return [...composerArgv, ...rest]
  if (cmd === 'vendor/bin/pint' && phpBin !== 'php') return [phpBin, cmd, ...rest]
  return argv
}

/** `$.process.run`, once the PHP binary is known, with `withPhp` applied. */
async function runPhp($: Api, argv: string[], init: { timeoutMs: number }) {
  await phpReady
  return $.process.run(withPhp(argv), init)
}

// ─── One-shot commands ─────────────────────────────────────────────────────

/** Run a command, keep its output for the Commands tab, and return it. */
async function runCommand($: Api, label: string, argv: string[], timeoutMs = 600_000): Promise<LastRun> {
  const isTests = isTestCommand(argv.join(' '))
  lastRun = { label, isRunning: true, output: '' }
  if (isTests) testsRunning = true
  redraw($)
  try {
    const r = await runPhp($, argv, { timeoutMs })
    const output = stripAnsi([r.stdout, r.stderr].filter(Boolean).join('\n')).trim()
    lastRun = { label, isRunning: false, exitCode: r.exitCode, output: tail(output) }
    if (isTests) noteTestRun($, label, output)
  } catch (err) {
    lastRun = { label, isRunning: false, exitCode: -1, output: 'Could not run `' + argv.join(' ') + '`: ' + String(err) }
  }
  if (isTests) testsRunning = false
  redraw($)
  // optimize:clear, composer install, artisan up… change what the checks see
  void checkHealth($)
  return lastRun
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

/** Remember a test run's result for the band and the Tests tab; output with no test summary is ignored. */
function noteTestRun($: Api, label: string, output: string) {
  const run = parseTestRun(stripAnsi(output))
  if (!run) return
  lastTest = { ...run, label, at: Date.now() }
  redraw($)
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
  const head = run.exitCode === 0 ? `✓ ${run.label}` : `✗ ${run.label} (exit ${run.exitCode})`
  return redact(run.output ? `${head}\n${run.output}` : head)
}

/**
 * Whether artisan `argv` is safe to run for Claude. Artisan resolves the name itself (`help <name>`), so
 * abbreviations and odd casing can't slip past DESTRUCTIVE; a name it can't resolve comes back as `error`.
 */
async function checkArtisan($: Api, argv: string[]): Promise<{ refused?: string; error?: string }> {
  const options = refusedOptions(argv, DESTRUCTIVE_OPTIONS)
  if (options.length) return { refused: `${options.join(' ')} can destroy data or point at another environment` }
  const { resolved, error } = await resolveArtisan($, argv)
  if (error) return { error }
  if (!resolved) return {}
  if (CONFIDENTIAL.includes(resolved)) return { refused: `${resolved} prints configuration secrets (passwords, keys)` }
  if (DESTRUCTIVE.includes(resolved)) {
    return { refused: resolved === 'tinker' ? 'tinker runs arbitrary PHP' : `${resolved} can destroy data` }
  }
  return {}
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
  return { error: `✗ artisan could not resolve "${name}"\n${tail(output, 2000)}` }
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
  await phpReady
  // Nothing awaits between this check and the spawn, so two quick starts can't both get through
  if (svc.run) return `${svc.label} is already running.`

  const argv = withPhp(svc.argv)
  svc.crashed = undefined
  const stream = $.process.spawn({ argv })
  svc.lines.push(`$ ${argv.join(' ')}`)
  svc.startedAt = Date.now()
  svc.partial = ''

  let finish = () => {}
  const run: Run = { stream, done: new Promise<void>(resolve => (finish = resolve)) }
  svc.run = run

  // The loop is the child's life: it keeps running after this function returns.
  void (async () => {
    try {
      let step = await stream.next()
      while (!step.done) {
        onServiceOutput($, svc, step.value.text)
        step = await stream.next()
      }
      // A stream closed by stopService ends without a result
      const end = step.value as ProcessSpawnResult | undefined
      if (!end || end.signal) svc.lines.push('■ stopped')
      else svc.lines.push(`■ exited with code ${end.code}`)
      if (end?.code) {
        svc.crashed = { code: end.code, seen: paneOpen && tab === 'services' }
        toast($, `${svc.label} exited with code ${end.code}`)
      }
    } catch (err) {
      svc.lines.push('■ ' + String(err))
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
  if (!run) return `${svc.label} is not running.`
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
  const state = svc.run ? `${svc.label} is running (${ago(svc.startedAt ?? Date.now())}).` : `${svc.label} is stopped.`
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

async function refreshQueue($: Api) {
  if (!isLaravel || snapshotLoading) return
  snapshotLoading = true
  redraw($)
  try {
    const r = await runPhp($, ['php', '-r', snapshotPhp(queuesOf(services.queue.argv))], { timeoutMs: 30_000 })
    const parsed = parseSnapshot(r.stdout)
    if (parsed) {
      waitingBefore = snapshot ? waiting(snapshot) : undefined
      snapshot = parsed
      snapshotError = parsed.error ?? ''
    } else {
      snapshotError = stripAnsi(r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 300) || 'Could not read the queue state.'
    }
  } catch (err) {
    snapshotError = String(err)
  }
  snapshotAt = Date.now()
  snapshotLoading = false
  // Only the backlog warning depends on the snapshot: swap it in without running every check
  const backlog = backlogCheck($)
  checks = [...checks.filter(c => !c.backlog), ...(backlog ? [backlog] : [])]
  redraw($)
}

/** Jobs waiting across the snapshot's queues. */
function waiting(snap: QueueSnapshot): number {
  return Object.values(snap.sizes).reduce((n, size) => n + (Number(size) || 0), 0)
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
    lines.push(`Failed jobs stored: ${snapshot.failedTotal}`)
  }
  const recent = jobs.slice(-10).map(j => `  ${j.status === 'done' ? '✓' : j.status === 'failed' ? '✗' : '…'} ${j.time} ${j.job}${j.ms !== undefined ? ` ${Math.round(j.ms)}ms` : ''}`)
  if (recent.length) lines.push('Recent jobs:', ...recent)
  return lines.join('\n')
}

function formatFailed(list: FailedJob[], withTrace: number): string {
  if (!list.length) return 'No failed jobs.'
  return list
    .map((f, i) => {
      const rest = i < withTrace ? f.exception.split('\n').slice(1, 13).filter(l => l.trim()) : []
      const trace = rest.length ? '\n' + rest.map(l => '    ' + l).join('\n') : ''
      return `- ${f.id}  ${f.job}  (queue ${f.queue}, failed ${f.failedAt})\n` + redact(`  ${exceptionHeadline(f.exception)}${trace}`)
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

/** Follow the newest log file; called at start and every minute, so a new daily file is picked up. */
async function watchLog($: Api) {
  if (!isLaravel) return
  let loaded = () => {}
  const ready = new Promise<void>(resolve => (loaded = resolve))
  const previous = logReady
  logReady = ready
  try {
    // One watch at a time, so two overlapping calls can't start two tails
    await previous
    const path = await newestLog($)
    if (path === logPath && logRun) return
    if (logRun) void logRun.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})

    logPath = path
    logState = newLogState()
    try {
      const r = await $.process.run(['tail', '-n', '400', path], { timeoutMs: 10_000 })
      if (r.exitCode === 0) feedLog(logState, r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n')
    } catch {
      // the file may not exist yet; tail -F below waits for it
    }

    const stream = $.process.spawn({ argv: ['tail', '-n', '0', '-F', path] })
    const run = { stream }
    logRun = run
    void (async () => {
      try {
        for await (const chunk of stream) {
          if (chunk.stream === 'stdout') onLogEntries($, feedLog(logState, chunk.text))
        }
      } catch {
        // stream closed
      }
      if (logRun === run) logRun = undefined
    })()
    redraw($)
  } finally {
    loaded()
  }
}

function onLogEntries($: Api, entries: LogEntry[]) {
  const errors = entries.filter(isError)
  if (errors.length) {
    const viewing = paneOpen && tab === 'log'
    if (!viewing) unseenErrors += errors.length
    const last = errors[errors.length - 1]
    if (last && settings.errorToasts) toast($, `Laravel ${last.level.toLowerCase()}: ${headline(last)}`)
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

async function loadRoutes($: Api): Promise<Route[] | string> {
  try {
    const r = await runPhp($, ['php', 'artisan', 'route:list', '--json'], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) return stripAnsi(r.stderr || r.stdout)
    const list = JSON.parse(r.stdout) as Route[]
    routes = list.map(x => ({ method: x.method, uri: x.uri, name: x.name, action: x.action }))
    redraw($)
    return routes
  } catch (err) {
    return 'Could not read routes: ' + String(err)
  }
}

function filterRoutes(list: Route[], filter: string): Route[] {
  const f = filter.trim().toLowerCase()
  if (!f) return list
  return list.filter(r => `${r.method} ${r.uri} ${r.name ?? ''} ${r.action}`.toLowerCase().includes(f))
}

function formatRoute(r: Route): string {
  const method = r.method.replace('|HEAD', '').padEnd(9)
  return `${method} /${r.uri.replace(/^\//, '')}${r.name ? '  ' + r.name : ''}  ${shortClass(r.action)}`
}

async function loadAbout($: Api) {
  const read = runPhp($, ['php', '-r', connectionsPhp()], { timeoutMs: 30_000 })
    .then(r => (connections = parseConnections(r.stdout) ?? connections))
    .catch(() => undefined)
  try {
    const r = await runPhp($, ['php', 'artisan', 'about', '--json'], { timeoutMs: 60_000 })
    // PHP may print deprecation warnings before the JSON
    if (r.exitCode === 0) about = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
  } catch {
    about = undefined
  }
  await read
  redraw($)
}

async function checkMigrations($: Api) {
  try {
    const r = await runPhp($, ['php', 'artisan', 'migrate:status', '--no-ansi'], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) return
    pendingMigrations = r.stdout.split('\n').filter(l => /\bPending\b/.test(l)).length
    if (pendingMigrations) toast($, `${plural(pendingMigrations, 'pending migration')}. Run /lara-artisan migrate`)
    redraw($)
  } catch {
    // no database yet: nothing to report
  }
}

// ─── Health checks ─────────────────────────────────────────────────────────

/** Laravel's cache files: while one exists, edits to what it caches don't take effect. */
const CACHE_FILES = { config: 'bootstrap/cache/config.php', routes: 'bootstrap/cache/routes-v7.php', events: 'bootstrap/cache/events.php' }

/**
 * Look for things that quietly break the app and show them in the band: a production environment, maintenance
 * mode, cached config/routes/events, a public/hot pointing at a dead Vite, a stopped Herd service the app uses,
 * and dependencies out of step with the lockfiles. Reads lockfiles and Laravel's marker files, never .env. Cheap: lockfiles are re-read only when changed.
 */
async function checkHealth($: Api) {
  if (!isLaravel) return
  // One run at a time; a request that arrives meanwhile runs again afterwards so nothing is missed
  if (checking) {
    checkAgain = true
    return
  }
  checking = true
  try {
    const next: Check[] = []
    if (about?.environment?.environment === 'production') {
      next.push({ band: 'env: production', color: 'red', detail: 'APP_ENV is production on this machine: errors are hidden and migrations need --force.' })
    }
    const [down, hot, ...cacheFiles] = await Promise.all([
      $.fs.exists('storage/framework/down'),
      viteIsGone($),
      ...Object.values(CACHE_FILES).map(f => $.fs.exists(f)),
    ])
    // The file covers the default driver; about covers the cache driver too
    if (down || about?.environment?.maintenance_mode === true) {
      next.push({
        band: 'maintenance mode',
        color: 'red',
        detail: 'The app answers every request with 503 (storage/framework/down). `artisan up` brings it back.',
        fix: { label: 'up', run: artisanFix($, [['up']]) },
      })
    }
    const cached = Object.keys(CACHE_FILES).filter((_, i) => cacheFiles[i])
    if (cached.length) {
      const list = cached.join(', ')
      // Only the caches that exist: optimize:clear would also empty the application cache
      const clear = cached.map(c => CLEAR_COMMANDS[c as keyof typeof CACHE_FILES])
      next.push({
        band: `${cached.join('+')} cached`,
        color: 'yellow',
        detail: `Laravel is using cached ${list}, so edits to them don't take effect until the cache is cleared (${clear.join(', ')}).`,
        fix: { label: 'clear', run: artisanFix($, clear.map(c => [c])) },
      })
    }
    if (hot) {
      next.push({
        band: 'Vite not running (public/hot)',
        color: 'yellow',
        detail: "public/hot points pages at a Vite dev server that isn't running, so they load without CSS and JS. Start Vite, or delete public/hot.",
        fix: { label: 'start vite', run: () => startService($, 'vite') },
      })
    }
    const backlog = backlogCheck($)
    if (backlog) next.push(backlog)
    const [herd, deps] = await Promise.all([checkHerd($), checkDeps($)])
    next.push(...herd, ...deps)
    checks = next
  } catch (err) {
    $.ui.log('lara-cc: health check failed: ' + String(err))
  } finally {
    checking = false
  }
  redraw($)
  if (checkAgain) {
    checkAgain = false
    void checkHealth($)
  }
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
 * Jobs waiting while this session runs no worker, so they won't run. Left out when the count dropped since
 * the last snapshot: a worker elsewhere (another terminal, Horizon) is draining it.
 */
function backlogCheck($: Api): Check | undefined {
  if (!snapshot || snapshot.connection === 'sync' || services.queue.run) return undefined
  const now = waiting(snapshot)
  if (!now || (waitingBefore !== undefined && now < waitingBefore)) return undefined
  const sizes = Object.entries(snapshot.sizes).filter(([, n]) => n).map(([q, n]) => `${q}: ${n}`).join(', ')
  return {
    band: `${plural(now, 'job')} waiting, no worker`,
    color: 'yellow',
    detail: `${plural(now, 'job')} waiting on the ${snapshot.connection} queue (${sizes}) and no worker runs in this session, so they won't run. Start one, or ignore this if a worker runs elsewhere (delayed jobs count too).`,
    fix: { label: 'start worker', run: () => startService($, 'queue') },
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

/** public/hot names a local dev server and nothing listens there (curl exit 7: couldn't connect). Vite run elsewhere counts as running. */
async function viteIsGone($: Api): Promise<boolean> {
  if (services.vite?.run || !(await $.fs.exists('public/hot'))) return false
  const url = localHotUrl(await $.fs.read('public/hot').catch(() => ''))
  if (!url) return false
  // -q first so a ~/.curlrc can't change the request; -k because local dev certificates are often self-signed
  const r = await $.process.run(['curl', '-q', '-s', '-o', '/dev/null', '-m', '2', '-k', url + '/'], { timeoutMs: 5_000 }).catch(() => undefined)
  return r?.exitCode === 7
}

/**
 * Herd services the app connects to that aren't running, e.g. MySQL stopped while the database is on its port.
 * Reads Herd's services.plist (type, port, version: no credentials), never its site list, and only checks this
 * machine at the ports it names. A server on a port no Herd service has (Docker, DBngin, remote) is left alone.
 */
async function checkHerd($: Api): Promise<Check[]> {
  const installed = await herdInstalledServices($)
  const up = await Promise.all(installed.map(s => listening($, s.port)))
  herdList = installed.map((s, i) => ({ ...s, up: up[i]! }))
  return herdNeeds(connections, herdList)
    .filter(need => !need.service.up)
    .map(({ service: s, driver, uses }) => ({
      band: `Herd ${s.name} stopped`,
      color: 'red' as const,
      detail: `The app's ${uses.join(', ')} uses ${driver} on port ${s.port}, and Herd's ${s.name} ${s.version} there isn't running, so anything that needs it fails.`,
      fix: { label: `start ${s.name}`, run: () => startHerdService($, s) },
    }))
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
    // Herd answers before the server listens
    let up = await listening($, s.port)
    for (let i = 0; i < 20 && !up; i++) {
      await $.clock.sleep(500)
      up = await listening($, s.port)
    }
    $.ui.toast(up ? `Herd ${s.name} is running` : `Herd ${s.name} hasn't started yet; check Herd → Services`, { timeoutMs: 6000 })
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
      debugCapture = { ...parseDebugCapture(r.stdout), at: Date.now() }
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
    herdInstalled = []
    return herdInstalled
  }
  const r = await $.process.run(['plutil', '-convert', 'json', '-o', '-', plist], { timeoutMs: 5_000 }).catch(() => undefined)
  if (r?.exitCode !== 0) return herdInstalled
  herdSeen = time
  herdInstalled = herdServices(r.stdout)
  return herdInstalled
}

/**
 * Something accepts connections on this machine's `port`, over IPv4 or IPv6 (`localhost` is both). nc connects
 * and hangs up at once; a missing nc counts as listening.
 */
async function listening($: Api, port: number): Promise<boolean> {
  const r = await $.process.run(['nc', '-z', '-w', '1', 'localhost', String(port)], { timeoutMs: 5_000 }).catch(() => undefined)
  return r?.exitCode !== 1
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

/** Composer and node packages out of step with the lockfiles, e.g. after a `git pull`. */
async function checkDeps($: Api): Promise<Check[]> {
  const times = await Promise.all(DEP_FILES.map(f => mtime($, f)))
  const key = times.join(',')
  if (key === depsSeen) return depsChecks
  const has = (file: string) => times[DEP_FILES.indexOf(file)]! >= 0
  const out: Check[] = []
  const add = (tool: string, detail: string) =>
    out.push({
      band: `${tool} install needed`,
      color: 'yellow',
      detail,
      fix: { label: `${tool} install`, run: commandFix($, `${tool} install`, tool === 'composer' ? ['composer', 'install', '--no-interaction'] : [pm, 'install']) },
    })
  const differ = (lock: string, drift: string[], fix: string) =>
    `${plural(drift.length, 'package')} in ${lock} differ from what's installed (${drift.slice(0, 3).join(', ')}${drift.length > 3 ? '…' : ''}). Run ${fix}.`

  if (has('composer.lock')) {
    const fix = 'composer install (/lara-composer install)'
    if (!has('vendor/composer/installed.json')) add('composer', `vendor/ is missing. Run ${fix}.`)
    else {
      // An unreadable or half-written file (mid-install) is skipped, and read again once it changes
      const drift = await Promise.all([$.fs.read('composer.lock'), $.fs.read('vendor/composer/installed.json')])
        .then(([lock, installed]) => composerDrift(lock, installed))
        .catch(() => [])
      if (drift.length) add('composer', differ('composer.lock', drift, fix))
    }
  }

  // The lockfile `pm` was picked from, so the advice matches the tool (a stray package-lock.json in a yarn project is ignored)
  const nodeLock = NODE_LOCKS[pm]?.find(has)
  if (nodeLock && !has('node_modules')) add(pm, `node_modules/ is missing. Run ${pm} install.`)
  // Only npm keeps a record of what it installed precise enough to compare against the lockfile
  else if (nodeLock === 'package-lock.json' && has('node_modules/.package-lock.json')) {
    const drift = await Promise.all([$.fs.read('package-lock.json'), $.fs.read('node_modules/.package-lock.json')])
      .then(([lock, installed]) => npmDrift(lock, installed))
      .catch(() => [])
    if (drift.length) add(pm, differ('package-lock.json', drift, `${pm} install`))
  }

  depsSeen = key
  depsChecks = out
  return out
}

async function detectProject($: Api) {
  projectDir = await $.session.cwd()
  isLaravel = await $.fs.exists('artisan')
  // Module state outlives a session: don't carry another folder's PHP over
  phpBin = 'php'
  composerArgv = ['composer']
  phpInfo = ''
  checks = []
  connections = []
  shareAllowed = false
  lastTest = undefined
  waitingBefore = undefined
  hasBoost = false
  depsSeen = ''
  depsChecks = []
  about = undefined
  routes = undefined
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

const commandFailed = (_$: Api, _e: unknown, next: { error: { message?: string } }) => ({ text: 'lara-cc: ' + (next.error.message ?? 'failed') })
const toolFailed = (_$: Api, _e: unknown, next: { error: { message?: string } }) => ({ result: 'lara-cc: ' + (next.error.message ?? 'failed') })

const TABS: Tab[] = ['services', 'queue', 'log', 'tests', 'routes', 'commands', 'about']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadSettings($)
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
        'Run a Laravel artisan command in the project and return its output, e.g. "route:list --path=api", "make:model Post -m", "db:show", "model:show User". Runs on the PHP version the site uses (Herd\'s isolated one, when set), which can differ from `php` in Bash. Refuses commands that can destroy data or run arbitrary code (migrate:fresh/rollback, db:wipe, db:seed, tinker, --force, --env…); ask the user to run those.',
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

    if (isLaravel) {
      void watchLog($)
      void checkMigrations($)
      void refreshQueue($)
      // about gives the environment name without reading .env; the checks run once it's in
      void loadAbout($).then(() => checkHealth($))
      for (const name of settings.autostart[projectDir] ?? []) if (services[name]) void startService($, name)
      // Pick up a new daily log file, and keep the Queue tab current while it's showing
      $.clock.every(60_000, () => {
        void watchLog($)
        // about is re-read so a changed APP_ENV or `artisan down` shows within a minute
        void loadAbout($).then(() => checkHealth($))
        // Jobs piling up with no worker; not when the app has no queue to read (no database yet) or runs jobs inline
        if (!services.queue.run && snapshot && !snapshotError && snapshot.connection !== 'sync') void refreshQueue($)
      })
      $.clock.every(15_000, () => {
        if (paneOpen && tab === 'queue') void refreshQueue($)
      })
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
    } else {
      // Typed by the person, but the output still lands in the conversation, where Claude reads it
      const { resolved } = await resolveArtisan($, splitArgs(e.args))
      if (resolved && CONFIDENTIAL.includes(resolved)) {
        return { text: `Not run: ${resolved} prints configuration secrets, and this output goes into the conversation where Claude reads it. Run \`php artisan ${e.args.trim()}\` in your own terminal instead.` }
      }
    }
    const run = await runCommand($, 'artisan ' + e.args, ['php', 'artisan', ...splitArgs(e.args), '--no-interaction'])
    return { text: formatRun(run) }
  }).catch(commandFailed)

  on('command.run', { command: 'lara-queue' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const [action = 'status', id = ''] = splitArgs(e.args)
    if (action === 'failed') {
      await refreshQueue($)
      if (snapshot?.failed.length && !(await mayShare($, `${plural(snapshot.failedTotal, 'failed job')} with their exceptions`))) return { text: NOT_SHARED }
      return { text: snapshot ? `${plural(snapshot.failedTotal, 'failed job')}:\n` + formatFailed(snapshot.failed, 3) : redact(snapshotError) }
    }
    if (action === 'retry') return { text: id ? await retryFailed($, id) : 'Usage: /lara-queue retry <id|all>' }
    if (action === 'status') await refreshQueue($)
    return { text: await serviceAction($, 'queue', action) }
  }).catch(commandFailed)

  on('command.run', { command: ['lara-vite', 'lara-schedule'] }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    return { text: await serviceAction($, e.command.replace('lara-', ''), e.args.trim() || 'status') }
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
    const run = await runCommand($, 'test ' + e.args, ['php', 'artisan', 'test', ...splitArgs(e.args)])
    return { text: formatRun(run) }
  }).catch(commandFailed)

  on('command.run', { command: 'lara-routes' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const list = await loadRoutes($)
    if (typeof list === 'string') return { text: list }
    routeFilter = e.args.trim()
    const shown = filterRoutes(list, routeFilter)
    return { text: tail(`${shown.length} of ${list.length} routes\n` + shown.map(formatRoute).join('\n')) }
  }).catch(commandFailed)

  on('command.run', { command: 'lara-npm' }, async ($, e) => {
    const script = e.args.trim() || 'build'
    return { text: formatRun(await runCommand($, `${pm} run ${script}`, [pm, 'run', ...splitArgs(script)])) }
  }).catch(commandFailed)

  on('command.run', { command: 'lara-composer' }, async ($, e) => {
    if (!e.args.trim()) return { text: 'Usage: /lara-composer <args>, e.g. /lara-composer require laravel/pail' }
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
    const run = await runCommand($, 'artisan ' + command, ['php', 'artisan', ...splitArgs(command), '--no-interaction'], 300_000)
    return { result: formatRun(run) }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__lara-cc__service' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const args = e as unknown as { name?: string; action?: string }
    return { result: await serviceAction($, String(args.name), String(args.action ?? 'status')) }
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
    if (args.action === 'retry') return { result: args.id ? await retryFailed($, String(args.id)) : 'Give the failed job id, or "all".' }
    await refreshQueue($)
    if (args.action === 'failed') {
      if (snapshot?.failed.length && !(await mayShare($, `${plural(snapshot.failedTotal, 'failed job')} with their exceptions`))) return { result: NOT_SHARED }
      return { result: snapshot ? `${plural(snapshot.failedTotal, 'failed job')}:\n` + formatFailed(snapshot.failed, 5) : redact(snapshotError) }
    }
    const worker = services.queue.run ? `${services.queue.label} running (started by this session).` : `${services.queue.label} not started by this session.`
    return { result: [worker, queueSummary(), snapshotError ? 'Note: ' + redact(snapshotError) : ''].filter(Boolean).join('\n') }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__lara-cc__routes' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const list = await loadRoutes($)
    if (typeof list === 'string') return { result: list }
    const filter = String((e as unknown as { filter?: string }).filter ?? '')
    const shown = filterRoutes(list, filter)
    return { result: tail(`${shown.length} of ${list.length} routes\n` + shown.map(formatRoute).join('\n')) }
  }).catch(toolFailed)

  // ── Tests Claude runs itself: the result shows in the band and the Tests tab ──

  // No .catch that calls next again: the command has already run, and must not run twice
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const command = String((e as unknown as { command?: string }).command ?? '')
      if (isLaravel && isTestCommand(command) && !('deny' in result && result.deny)) noteTestRun($, 'Claude ran ' + command.slice(0, 60), resultText(result))
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

  // As with Bash: the edit has already been made, so nothing here may make it run again
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const result = await next(e)
    try {
      const path = String((e as unknown as { file_path?: string }).file_path ?? '')
      if (!path.endsWith('.php') || ('isError' in result && result.isError)) return result
      editedPhp.add(path)
      if (settings.autoRestartQueue && services.queue.run) {
        restartTimer?.cancel()
        restartTimer = $.clock.after(2000, async () => {
          await restartService($, 'queue')
          $.ui.toast(`${services.queue.label} restarted after PHP edits`)
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
    if (e.agentId === undefined && editedPhp.size) {
      const files = [...editedPhp].filter(f => !f.includes('/vendor/'))
      editedPhp.clear()
      if (settings.pintAfterTurn && hasPint && files.length) {
        void (async () => {
          try {
            const r = await runPhp($, ['vendor/bin/pint', ...files], { timeoutMs: 120_000 })
            $.ui.log(r.exitCode === 0 ? `lara-cc: Pint formatted ${plural(files.length, 'file')}` : `lara-cc: Pint failed: ${stripAnsi(r.stdout + r.stderr).trim().slice(0, 300)}`)
          } catch (err) {
            $.ui.log('lara-cc: Pint failed: ' + String(err))
          }
        })()
      }
    }
    return next(e)
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // ── The band above the prompt: one line, only when there's something to show ──

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isLaravel || !settings.showBand || e.props.hasSurvey) return next(e)
    const running = Object.values(services).filter(s => s.run)
    const failedStored = snapshot?.failedTotal ?? 0
    const crashed = Object.values(services).filter(s => s.crashed && !s.crashed.seen)
    const failingTests = lastTest?.failed ?? 0
    if (!running.length && !crashed.length && !unseenErrors && !failedStored && !pendingMigrations && !failingTests && !checks.length) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const theirs = await next(e)
    type Item = { text: string; color?: string; fix?: Fix }
    const items: Item[] = []
    for (const s of running) {
      const extra = s.name === 'queue' && (stats.done || stats.failed) ? ` ${stats.done}✓${stats.failed ? ` ${stats.failed}✗` : ''}` : ''
      items.push({ text: '●', color: 'green' }, { text: s.name + extra })
    }
    if (lastTest && !failingTests) items.push({ text: `✓ ${plural(lastTest.passed, 'test')}`, color: 'green' })
    for (const s of crashed) {
      items.push({ text: `✗ ${s.name} exited (${s.crashed!.code})`, color: 'red', fix: { label: `restart ${s.name}`, run: () => restartService($, s.name) } })
    }
    if (failingTests) items.push({ text: `✗ ${plural(failingTests, 'test')} failing`, color: 'red' })
    if (unseenErrors) items.push({ text: `▲ ${plural(unseenErrors, 'new error')}`, color: 'red' })
    if (failedStored) items.push({ text: plural(failedStored, 'failed job'), color: 'yellow' })
    if (pendingMigrations) items.push({ text: plural(pendingMigrations, 'pending migration'), color: 'yellow', fix: { label: 'migrate', run: migrateFix($) } })
    const warnings: Item[] = checks.map(c => ({ text: `⚠ ${c.band}`, color: c.color, fix: c.fix }))

    // Too wide for one row: drop the fix buttons, then fold the warnings into a count (the Services tab has both)
    const widthOf = (list: Item[], withFixes: boolean) =>
      list.reduce((n, i) => n + i.text.length + 2 + (withFixes && i.fix ? i.fix.label.length + 3 : 0), 'lara-cc  open'.length)
    let shown = [...items, ...warnings]
    let withFixes = widthOf(shown, true) <= e.props.bodyColumns
    if (!withFixes && widthOf(shown, false) > e.props.bodyColumns) {
      shown = [...items]
      if (checks.length) shown.push({ text: `⚠ ${plural(checks.length, 'warning')}`, color: checks.some(c => c.color === 'red') ? 'red' : 'yellow' })
      withFixes = widthOf(shown, true) <= e.props.bodyColumns
    }
    const parts = shown.flatMap(i => {
      const fix = withFixes ? i.fix : undefined
      const text = <Text color={i.color}>{i.text + (fix ? ' ' : i.text === '●' ? ' ' : '  ')}</Text>
      if (!fix) return [text]
      // A fix runs only on the person's press
      const busy = fixing.has(fix.label)
      return [text, <Button key={'fix-' + fix.label} label={busy ? 'running…' : fix.label} dimColor={busy} onPress={() => void runFix($, fix)} />, <Text>{'  '}</Text>]
    })

    // The Services tab explains crashes and checks
    const target: Tab = crashed.length ? 'services' : failingTests ? 'tests' : unseenErrors ? 'log' : failedStored ? 'queue' : 'services'
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

    const errorBadge = unseenErrors ? ` (${unseenErrors})` : ''
    const failedBadge = snapshot?.failedTotal ? ` (${snapshot.failedTotal})` : ''
    const header = (
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {tabButton('services', 'Services', 's')}
        {tabButton('queue', 'Queue' + failedBadge, 'q')}
        {tabButton('log', 'Log' + errorBadge, 'l')}
        {tabButton('tests', 'Tests' + (lastTest?.failed ? ` (${lastTest.failed})` : ''), 't')}
        {tabButton('routes', 'Routes', 'r')}
        {tabButton('commands', 'Commands', 'c')}
        {tabButton('about', 'About', 'a')}
      </Box>
    )

    const toggleButton = (key: 'autoRestartQueue' | 'pintAfterTurn' | 'showBand' | 'errorToasts', label: string) => (
      <Button key={'set-' + key} label={`${settings[key] ? '[x]' : '[ ]'} ${label}`} plain dimColor={!settings[key]} onPress={() => void toggle($, key)} />
    )

    let body
    if (tab === 'services') {
      const shown = services[logOf]
      const autostart = settings.autostart[projectDir] ?? []
      const herdText = herdList.map(s => `○ ${s.name} ${s.version} :${s.port}` + (s.up ? '' : ' starting…'))
      // The Herd row wraps on a narrow pane
      const herdRows = herdList.length ? Math.ceil(['Herd services', ...herdText].join('  ').length / width) : 0
      body = (
        <Box flexDirection="column">
          {phpInfo && <Text dimColor>{phpInfo}</Text>}
          {herdList.length > 0 && (
            <Box flexDirection="row" columnGap={2} flexWrap="wrap">
              <Text dimColor>Herd services</Text>
              {herdList.map(s =>
                s.up ? (
                  <Text color="green">{`● ${s.name} ${s.version} :${s.port}`}</Text>
                ) : (
                  <Box flexDirection="row" columnGap={1}>
                    <Text dimColor>{`○ ${s.name} ${s.version} :${s.port}`}</Text>
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
          {checks.map(c => (
            <Box flexDirection="row" columnGap={1}>
              <Text color={c.color}>{`⚠ ${c.detail}`}</Text>
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
                <Text dimColor>{(svc.run ? 'running ' + ago(svc.startedAt ?? Date.now()) : 'stopped').padEnd(13)}</Text>
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
            {hasPint && toggleButton('pintAfterTurn', 'Pint after each turn')}
            {toggleButton('errorToasts', 'error toasts')}
            {toggleButton('showBand', 'status band')}
          </Box>
          <Text> </Text>
          <Text bold>{shown?.label ?? ''} output</Text>
          {(shown?.lines.length ? shown.lines.slice(-Math.max(3, rows - Object.keys(services).length - 4 - (phpInfo ? 1 : 0) - herdRows - (herdList.length ? 1 : 0) - checks.length * 2)) : ['(no output yet)']).map(l => line(l, true))}
        </Box>
      )
    } else if (tab === 'queue') {
      const avg = stats.done ? Math.round(stats.totalMs / stats.done) : 0
      const failed = snapshot?.failed ?? []
      const recent = jobs.slice(-Math.max(3, Math.floor((rows - 8) / 2)))
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text>
              {snapshot ? `connection ${snapshot.connection}` : snapshotLoading ? 'reading queue…' : 'queue state unknown'}
            </Text>
            {snapshot && (
              <Text dimColor>{Object.entries(snapshot.sizes).map(([q, n]) => `${q}: ${n} pending`).join('  ')}</Text>
            )}
            <Button key="queue-refresh" label={snapshotAt ? `refresh (${ago(snapshotAt)} ago)` : 'refresh'} plain dimColor onPress={() => void refreshQueue($)} />
          </Box>
          {snapshot?.connection === 'sync' && line('QUEUE_CONNECTION=sync: jobs run inline during the request, so no worker is needed.', false, 'yellow')}
          {snapshotError && line(snapshotError, false, 'red')}
          <Text>
            {`${services.queue.label}: ${services.queue.run ? 'running' : 'stopped'}  ·  ${stats.done} done  ·  ${stats.failed} failed${stats.done ? `  ·  avg ${avg}ms` : ''}`}
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
              {lastRun.output.split('\n').slice(-(rows - 5)).map(l => line(l, true))}
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
      const room = Math.max(1, Math.floor((rows - 5) / perFailure))
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
          {!t && <Text dimColor>No test run yet this session. Run them here, with /lara-test, or let Claude run them: the result shows here and in the band.</Text>}
          {t && (
            <Text bold color={t.failed ? 'red' : 'green'}>
              {(t.failed ? `✗ ${t.failed} failed, ` : '✓ ') + `${t.passed} passed` + (t.skipped ? `, ${t.skipped} skipped` : '')}
            </Text>
          )}
          {t && <Text dimColor>{`${t.label} · ${ago(t.at)} ago`}</Text>}
          {t && t.failed > 0 && !t.failures.length && <Text dimColor>The output didn't include the failures. Run the tests here to see them.</Text>}
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
      const shown = routes ? filterRoutes(routes, routeFilter) : []
      body = (
        <Box flexDirection="column">
          {Input && (
            <Input
              key="route-filter"
              label="filter"
              placeholder="uri, name or controller"
              value={routeFilter}
              submitLabel="filter"
              onInput={value => {
                routeFilter = value
                redraw($)
              }}
              onSubmit={value => {
                routeFilter = value
                redraw($)
              }}
            />
          )}
          {!routes ? <Text dimColor>Loading routes…</Text> : <Text dimColor>{`${shown.length} of ${routes.length}`}</Text>}
          {shown.slice(0, rows - 3).map(r => line(formatRoute(r)))}
          <Button key="routes-refresh" label="refresh" plain dimColor onPress={() => void loadRoutes($)} />
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
