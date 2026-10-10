import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import {
  artisanCommandName,
  clock,
  durationMs,
  exceptionHeadline,
  feedLog,
  formatEntry,
  headline,
  helpName,
  isError,
  isWarning,
  newLogState,
  origin,
  parseSnapshot,
  parseWorkerLine,
  queuesOf,
  refusedOptions,
  shortClass,
  snapshotPhp,
  splitArgs,
  stripAnsi,
  tail,
} from './parse'
import type { FailedJob, LogEntry, QueueSnapshot } from './parse'

/**
 * Unofficial Laravel mod for Claude Code. Not affiliated with or endorsed by Laravel or Anthropic.
 *
 *   /laravel [tab]             open the pane (services, queue, log, routes, commands, about)
 *   /laravel-artisan <args>    run `php artisan <args>`; output lands in the transcript for Claude
 *   /laravel-queue [start|stop|restart|logs|status|failed|retry <id|all>]
 *   /laravel-vite|-schedule [start|stop|restart|logs]
 *   /laravel-logs [errors|warnings|all] [count]
 *   /laravel-test [args]       php artisan test
 *   /laravel-routes [filter]   route list
 *   /laravel-npm <script>      `npm run <script>` (pnpm / yarn / bun detected from the lockfile)
 *   /laravel-composer <args>   run composer
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
 * You can still run them yourself with /laravel-artisan.
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

const PANE = 'laravel'
const MAX_SERVICE_LINES = 400
const TOAST_GAP_MS = 5000

// ─── State (module variables reset when the mod reloads; child processes die with it) ──

type Tab = 'services' | 'queue' | 'log' | 'routes' | 'commands' | 'about'
type Run = { stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>; done: Promise<void> }
type Service = { name: string; label: string; argv: string[]; run?: Run; lines: string[]; startedAt?: number; partial: string }
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
const editedPhp = new Set<string>()

// Log monitoring
let logPath = ''
let logState = newLogState()
let logRun: { stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> } | undefined
let logFilter: 'all' | 'warnings' | 'errors' = 'all'
let unseenErrors = 0
let logReady: Promise<void> = Promise.resolve()

// Queue monitoring
let jobs: Job[] = []
const stats = { done: 0, failed: 0, totalMs: 0 }
let snapshot: QueueSnapshot | undefined
let snapshotAt = 0
let snapshotError = ''
let snapshotLoading = false

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
  if (on === 'about' && !about) void loadAbout($)
  if (on === 'routes' && !routes) void loadRoutes($)
  if (on === 'queue') void refreshQueue($)
  paneOpen = true
  await $.ui.open({ id: PANE, title: 'Laravel', focus: true, closeOnEscape: true })
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

// ─── One-shot commands ─────────────────────────────────────────────────────

/** Run a command, keep its output for the Commands tab, and return it. */
async function runCommand($: Api, label: string, argv: string[], timeoutMs = 600_000): Promise<LastRun> {
  lastRun = { label, isRunning: true, output: '' }
  redraw($)
  try {
    const r = await $.process.run(argv, { timeoutMs })
    const output = stripAnsi([r.stdout, r.stderr].filter(Boolean).join('\n')).trim()
    lastRun = { label, isRunning: false, exitCode: r.exitCode, output: tail(output) }
  } catch (err) {
    lastRun = { label, isRunning: false, exitCode: -1, output: 'Could not run `' + argv.join(' ') + '`: ' + String(err) }
  }
  redraw($)
  return lastRun
}

function formatRun(run: LastRun): string {
  const head = run.exitCode === 0 ? `✓ ${run.label}` : `✗ ${run.label} (exit ${run.exitCode})`
  return run.output ? `${head}\n${run.output}` : head
}

/**
 * Whether artisan `argv` is safe to run for Claude. Artisan resolves the name itself (`help <name>`), so
 * abbreviations and odd casing can't slip past DESTRUCTIVE; a name it can't resolve comes back as `error`.
 */
async function checkArtisan($: Api, argv: string[]): Promise<{ refused?: string; error?: string }> {
  const options = refusedOptions(argv, DESTRUCTIVE_OPTIONS)
  if (options.length) return { refused: `${options.join(' ')} can destroy data or point at another environment` }
  const name = artisanCommandName(argv)
  if (name === undefined) return {}
  const r = await $.process.run(['php', 'artisan', 'help', name, '--format=json', '--no-interaction'], { timeoutMs: 60_000 })
  const resolved = r.exitCode === 0 ? helpName(r.stdout) : undefined
  if (!resolved) {
    const output = stripAnsi([r.stdout, r.stderr].filter(Boolean).join('\n')).trim()
    return { error: `✗ artisan could not resolve "${name}"\n${tail(output, 2000)}` }
  }
  if (DESTRUCTIVE.includes(resolved)) {
    return { refused: resolved === 'tinker' ? 'tinker runs arbitrary PHP' : `${resolved} can destroy data` }
  }
  return {}
}

/** Typed by the person (at the terminal or through Remote Control), not relayed from another session, channel or plugin. */
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

function startService($: Api, name: string): string {
  const svc = services[name]
  if (!svc) return `Unknown service "${name}". Known: ${Object.keys(services).join(', ')}`
  if (svc.run) return `${svc.label} is already running.`

  const stream = $.process.spawn({ argv: svc.argv })
  svc.lines.push(`$ ${svc.argv.join(' ')}`)
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
      if (end?.code) toast($, `${svc.label} exited with code ${end.code}`)
    } catch (err) {
      svc.lines.push('■ ' + String(err))
    }
    if (svc.run === run) {
      svc.run = undefined
      svc.startedAt = undefined
    }
    finish()
    redraw($)
  })()

  redraw($)
  return `${svc.label} started: ${svc.argv.join(' ')}`
}

async function stopService($: Api, name: string): Promise<string> {
  const svc = services[name]
  if (!svc) return `Unknown service "${name}".`
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
  return startService($, name).replace('started', 'restarted')
}

async function serviceAction($: Api, name: string, action: string): Promise<string> {
  const svc = services[name]
  if (!svc) return `Unknown service "${name}". Known: ${Object.keys(services).join(', ')}`
  if (action === 'start') return startService($, name)
  if (action === 'stop') return stopService($, name)
  if (action === 'restart') return restartService($, name)
  if (action === 'logs') return `${svc.label}, last 60 lines:\n` + (svc.lines.slice(-60).join('\n') || '(no output)')
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
    const r = await $.process.run(['php', '-r', snapshotPhp(queuesOf(services.queue.argv))], { timeoutMs: 30_000 })
    const parsed = parseSnapshot(r.stdout)
    if (parsed) {
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
  redraw($)
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
      return `- ${f.id}  ${f.job}  (queue ${f.queue}, failed ${f.failedAt})\n  ${exceptionHeadline(f.exception)}${trace}`
    })
    .join('\n')
}

function askAboutFailedJob($: Api, f: FailedJob) {
  const text = [
    'This queued job failed in my Laravel app. Find the cause and fix it. When fixed, retry it with the queue tool.',
    '',
    `Job: ${f.job}`,
    `Failed job id: ${f.id}`,
    `Queue: ${f.queue}, failed at ${f.failedAt}`,
    '',
    '```',
    f.exception.split('\n').slice(0, 40).join('\n'),
    '```',
  ].join('\n')
  $.prompt.submit({ text, asUser: true }).catch(err => $.ui.toast('Could not send to Claude: ' + String(err)))
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
  return `Latest ${list.length} ${noun} from ${logPath}:\n\n` + list.map(e => formatEntry(e, 15, projectDir)).join('\n\n')
}

function askAboutError($: Api, entry: LogEntry) {
  const text = [
    `This error appeared in my Laravel log (${logPath}). Find the cause and fix it.`,
    '',
    '```',
    formatEntry(entry, 30, projectDir),
    '```',
  ].join('\n')
  $.prompt.submit({ text, asUser: true }).catch(err => $.ui.toast('Could not send to Claude: ' + String(err)))
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
    const r = await $.process.run(['php', 'artisan', 'route:list', '--json'], { timeoutMs: 60_000 })
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
  try {
    const r = await $.process.run(['php', 'artisan', 'about', '--json'], { timeoutMs: 60_000 })
    if (r.exitCode === 0) about = JSON.parse(r.stdout)
  } catch {
    about = undefined
  }
  redraw($)
}

async function checkMigrations($: Api) {
  try {
    const r = await $.process.run(['php', 'artisan', 'migrate:status', '--no-ansi'], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) return
    pendingMigrations = r.stdout.split('\n').filter(l => /\bPending\b/.test(l)).length
    if (pendingMigrations) toast($, `${plural(pendingMigrations, 'pending migration')}. Run /laravel-artisan migrate`)
    redraw($)
  } catch {
    // no database yet: nothing to report
  }
}

async function detectProject($: Api) {
  projectDir = await $.session.cwd()
  isLaravel = await $.fs.exists('artisan')
  if (!isLaravel) return
  hasPint = await $.fs.exists('vendor/bin/pint')

  if (await $.fs.exists('bun.lock')) pm = 'bun'
  else if (await $.fs.exists('bun.lockb')) pm = 'bun'
  else if (await $.fs.exists('pnpm-lock.yaml')) pm = 'pnpm'
  else if (await $.fs.exists('yarn.lock')) pm = 'yarn'
  services.vite.argv = [pm, 'run', 'dev']
  for (const q of QUICK) {
    if (q.argv[0] === 'npm') {
      q.argv = [pm, ...q.argv.slice(1)]
      q.label = q.label.replace('npm', pm)
    }
  }

  try {
    const composer = await $.fs.read('composer.json')
    if (composer.includes('"laravel/horizon"')) {
      services.queue.argv = ['php', 'artisan', 'horizon']
      services.queue.label = 'Horizon'
    }
  } catch {
    // no composer.json: keep defaults
  }
}

// ─── The mod ───────────────────────────────────────────────────────────────

const commandFailed = (_$: Api, _e: unknown, next: { error: { message?: string } }) => ({ text: 'laravel: ' + (next.error.message ?? 'failed') })
const toolFailed = (_$: Api, _e: unknown, next: { error: { message?: string } }) => ({ result: 'laravel: ' + (next.error.message ?? 'failed') })

const TABS: Tab[] = ['services', 'queue', 'log', 'routes', 'commands', 'about']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadSettings($)
    await detectProject($)

    const commands = [
      { name: 'laravel', description: 'Open the Laravel pane', argumentHint: '[services|queue|log|routes|commands|about]', immediate: true as const },
      { name: 'laravel-artisan', description: 'Run php artisan <args>', argumentHint: '<command> [args]' },
      { name: 'laravel-queue', description: 'Queue worker and failed jobs', argumentHint: '[start|stop|restart|logs|status|failed|retry <id|all>]', immediate: true as const },
      { name: 'laravel-vite', description: 'Vite dev server: start, stop, restart, logs', argumentHint: '[start|stop|restart|logs]', immediate: true as const },
      { name: 'laravel-schedule', description: 'Scheduler (schedule:work): start, stop, restart, logs', argumentHint: '[start|stop|restart|logs]', immediate: true as const },
      { name: 'laravel-logs', description: 'Recent entries from storage/logs', argumentHint: '[errors|warnings|all] [count]', immediate: true as const },
      { name: 'laravel-test', description: 'Run php artisan test', argumentHint: '[--filter=Name] [args]' },
      { name: 'laravel-routes', description: 'List routes, optionally filtered', argumentHint: '[filter]' },
      { name: 'laravel-npm', description: 'Run a package.json script (npm/pnpm/yarn/bun)', argumentHint: '<script>' },
      { name: 'laravel-composer', description: 'Run composer <args>', argumentHint: '<args>' },
    ]
    for (const command of commands) {
      try {
        await $.command.register(command)
      } catch (err) {
        $.ui.log(`laravel: could not register /${command.name}: ${String(err)}`)
      }
    }

    await $.tool.register({
      name: 'artisan',
      description:
        'Run a Laravel artisan command in the project and return its output, e.g. "route:list --path=api", "make:model Post -m", "db:show", "model:show User". Refuses commands that can destroy data or run arbitrary code (migrate:fresh/rollback, db:wipe, db:seed, tinker, --force, --env…); ask the user to run those.',
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
        'Read recent entries from the Laravel log (storage/logs), with exception origin and stack. Check it after running code, hitting a page or running tests, to see errors the app logged.',
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
      for (const name of settings.autostart[projectDir] ?? []) if (services[name]) startService($, name)
      // Pick up a new daily log file, and keep the Queue tab current while it's showing
      $.clock.every(60_000, () => void watchLog($))
      $.clock.every(15_000, () => {
        if (paneOpen && tab === 'queue') void refreshQueue($)
      })
    }

    return next(e)
  })

  // ── Slash commands ──

  on('command.run', { command: 'laravel' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const wanted = e.args.trim().toLowerCase() as Tab
    await openPane($, TABS.includes(wanted) ? wanted : tab)
    return {}
  }).catch(commandFailed)

  on('command.run', { command: 'laravel-artisan' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    if (!e.args.trim()) return { text: 'Usage: /laravel-artisan <command> [args], e.g. /laravel-artisan make:model Post -m' }
    // Unguarded only when the person typed it; a relayed message gets the same check as Claude's tool
    if (!fromUser(e.origin)) {
      const check = await checkArtisan($, splitArgs(e.args))
      if (check.refused) return { text: `Refused: ${check.refused}. Only commands you type yourself skip this check.` }
      if (check.error) return { text: check.error }
    }
    const run = await runCommand($, 'artisan ' + e.args, ['php', 'artisan', ...splitArgs(e.args), '--no-interaction'])
    return { text: formatRun(run) }
  }).catch(commandFailed)

  on('command.run', { command: 'laravel-queue' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const [action = 'status', id = ''] = splitArgs(e.args)
    if (action === 'failed') {
      await refreshQueue($)
      return { text: snapshot ? `${plural(snapshot.failedTotal, 'failed job')}:\n` + formatFailed(snapshot.failed, 3) : snapshotError }
    }
    if (action === 'retry') return { text: id ? await retryFailed($, id) : 'Usage: /laravel-queue retry <id|all>' }
    if (action === 'status') await refreshQueue($)
    return { text: await serviceAction($, 'queue', action) }
  }).catch(commandFailed)

  on('command.run', { command: ['laravel-vite', 'laravel-schedule'] }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    return { text: await serviceAction($, e.command.replace('laravel-', ''), e.args.trim() || 'status') }
  }).catch(commandFailed)

  on('command.run', { command: 'laravel-logs' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const args = splitArgs(e.args)
    const filter = (['errors', 'warnings', 'all'].find(f => args.includes(f)) ?? 'errors') as 'errors' | 'warnings' | 'all'
    const count = Number(args.find(a => /^\d+$/.test(a)) ?? 5)
    await logsLoaded()
    unseenErrors = 0
    redraw($)
    return { text: logsText(filter, count) }
  }).catch(commandFailed)

  on('command.run', { command: 'laravel-test' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const run = await runCommand($, 'test ' + e.args, ['php', 'artisan', 'test', ...splitArgs(e.args)])
    return { text: formatRun(run) }
  }).catch(commandFailed)

  on('command.run', { command: 'laravel-routes' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const list = await loadRoutes($)
    if (typeof list === 'string') return { text: list }
    routeFilter = e.args.trim()
    const shown = filterRoutes(list, routeFilter)
    return { text: tail(`${shown.length} of ${list.length} routes\n` + shown.map(formatRoute).join('\n')) }
  }).catch(commandFailed)

  on('command.run', { command: 'laravel-npm' }, async ($, e) => {
    const script = e.args.trim() || 'build'
    return { text: formatRun(await runCommand($, `${pm} run ${script}`, [pm, 'run', ...splitArgs(script)])) }
  }).catch(commandFailed)

  on('command.run', { command: 'laravel-composer' }, async ($, e) => {
    if (!e.args.trim()) return { text: 'Usage: /laravel-composer <args>, e.g. /laravel-composer require laravel/pail' }
    return { text: formatRun(await runCommand($, 'composer ' + e.args, ['composer', ...splitArgs(e.args), '--no-interaction'])) }
  }).catch(commandFailed)

  // ── Tools for Claude ──

  on('tool.call', { tool: 'mcp__laravel__artisan' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const command = String((e as unknown as { command?: string }).command ?? '').trim()
    const check = await checkArtisan($, splitArgs(command))
    if (check.refused) {
      return { result: `Refused: ${check.refused}. Ask the user to run it themselves with /laravel-artisan ${command}` }
    }
    if (check.error) return { result: check.error }
    const run = await runCommand($, 'artisan ' + command, ['php', 'artisan', ...splitArgs(command), '--no-interaction'], 300_000)
    return { result: formatRun(run) }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__laravel__service' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const args = e as unknown as { name?: string; action?: string }
    return { result: await serviceAction($, String(args.name), String(args.action ?? 'status')) }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__laravel__logs' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const args = e as unknown as { level?: string; count?: number }
    const level = (['errors', 'warnings', 'all'].includes(String(args.level)) ? args.level : 'errors') as 'errors' | 'warnings' | 'all'
    await logsLoaded()
    return { result: logsText(level, Math.min(50, Math.max(1, Number(args.count) || 5))) }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__laravel__queue' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const args = e as unknown as { action?: string; id?: string }
    if (args.action === 'retry') return { result: args.id ? await retryFailed($, String(args.id)) : 'Give the failed job id, or "all".' }
    await refreshQueue($)
    if (args.action === 'failed') {
      return { result: snapshot ? `${plural(snapshot.failedTotal, 'failed job')}:\n` + formatFailed(snapshot.failed, 5) : snapshotError }
    }
    const worker = services.queue.run ? `${services.queue.label} running (started by this session).` : `${services.queue.label} not started by this session.`
    return { result: [worker, queueSummary(), snapshotError ? 'Note: ' + snapshotError : ''].filter(Boolean).join('\n') }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__laravel__routes' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const list = await loadRoutes($)
    if (typeof list === 'string') return { result: list }
    const filter = String((e as unknown as { filter?: string }).filter ?? '')
    const shown = filterRoutes(list, filter)
    return { result: tail(`${shown.length} of ${list.length} routes\n` + shown.map(formatRoute).join('\n')) }
  }).catch(toolFailed)

  // ── When Claude edits PHP: restart the queue worker, and remember the file for Pint ──

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const result = await next(e)
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
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && editedPhp.size) {
      const files = [...editedPhp].filter(f => !f.includes('/vendor/'))
      editedPhp.clear()
      if (settings.pintAfterTurn && hasPint && files.length) {
        void (async () => {
          try {
            const r = await $.process.run(['vendor/bin/pint', ...files], { timeoutMs: 120_000 })
            $.ui.log(r.exitCode === 0 ? `laravel: Pint formatted ${plural(files.length, 'file')}` : `laravel: Pint failed: ${stripAnsi(r.stdout + r.stderr).trim().slice(0, 300)}`)
          } catch (err) {
            $.ui.log('laravel: Pint failed: ' + String(err))
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
    if (!running.length && !unseenErrors && !failedStored && !pendingMigrations) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const theirs = await next(e)
    const parts = []
    for (const s of running) {
      const extra = s.name === 'queue' && (stats.done || stats.failed) ? ` ${stats.done}✓${stats.failed ? ` ${stats.failed}✗` : ''}` : ''
      parts.push(<Text color="green">{'● '}</Text>, <Text>{s.name + extra + '  '}</Text>)
    }
    if (unseenErrors) parts.push(<Text color="red">{`▲ ${plural(unseenErrors, 'new error')}  `}</Text>)
    if (failedStored) parts.push(<Text color="yellow">{`${plural(failedStored, 'failed job')}  `}</Text>)
    if (pendingMigrations) parts.push(<Text color="yellow">{`${plural(pendingMigrations, 'pending migration')}  `}</Text>)

    const target: Tab = unseenErrors ? 'log' : failedStored ? 'queue' : 'services'
    const band = (
      <Box flexDirection="row">
        <Text dimColor>{'laravel  '}</Text>
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
      body = (
        <Box flexDirection="column">
          {Object.values(services).map(svc => (
            <Box flexDirection="row" columnGap={1}>
              <Text color={svc.run ? 'green' : undefined} dimColor={!svc.run}>
                {svc.run ? '●' : '○'}
              </Text>
              <Text bold>{svc.label.padEnd(13)}</Text>
              <Text dimColor>{(svc.run ? 'running ' + ago(svc.startedAt ?? Date.now()) : 'stopped').padEnd(13)}</Text>
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
          {(shown?.lines.length ? shown.lines.slice(-(rows - Object.keys(services).length - 4)) : ['(no output yet)']).map(l => line(l, true))}
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
            : line(services.queue.run ? 'Waiting for jobs…' : 'Start the worker (Services tab or /laravel-queue start) to see jobs here.', true)}
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
                <Button key={'ask-' + f.id} label="ask Claude" plain onPress={() => askAboutFailedJob($, f)} />
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
            {latestError && <Button key="ask-error" label="ask Claude about latest error" plain onPress={() => askAboutError($, latestError)} />}
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
          {pendingMigrations > 0 && line(`${plural(pendingMigrations, 'pending migration')}: run /laravel-artisan migrate`, false, 'yellow')}
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
              void loadAbout($)
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
