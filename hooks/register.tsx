import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

/**
 * Unofficial Laravel mod for Claude Code. Not affiliated with or endorsed by Laravel or Anthropic.
 *
 *   /laravel                   open the Laravel pane (overview, services, routes, commands, log)
 *   /laravel-artisan <args>    run `php artisan <args>`; output lands in the transcript for Claude
 *   /laravel-queue|-vite|-schedule [start|stop|restart|logs]   manage long-running processes
 *   /laravel-routes [filter]   route list
 *   /laravel-npm <script>      `npm run <script>` (pnpm / yarn / bun detected from the lockfile)
 *   /laravel-composer <args>   run composer
 *
 * Claude also gets three tools: artisan, service and routes.
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

/** Artisan commands Claude's tool refuses. You can still run them yourself with /laravel-artisan. */
const DESTRUCTIVE = /^(migrate:(fresh|reset|refresh|rollback)|db:wipe|db:seed|key:generate|down)\b/

const PANE = 'laravel'
const MAX_LOG_LINES = 400
const MAX_TEXT = 8000

// ─── State (module variables reset when the mod reloads; child processes die with it) ──

type Run = { stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>; done: Promise<void> }
type Service = { name: string; label: string; argv: string[]; run?: Run; lines: string[]; startedAt?: number; partial: string }
type LastRun = { label: string; isRunning: boolean; exitCode?: number; output: string }
type Route = { method: string; uri: string; name: string | null; action: string }

const services: Record<string, Service> = {}
for (const [name, def] of Object.entries(SERVICES)) {
  services[name] = { name, label: def.label, argv: [...def.argv], lines: [], partial: '' }
}

let isLaravel = false
let pm = 'npm'
let tab: 'overview' | 'services' | 'routes' | 'commands' | 'log' = 'services'
let logOf = 'queue'
let autoRestartQueue = true
let restartTimer: { cancel: () => void } | undefined
let lastRun: LastRun | undefined
let about: Record<string, Record<string, unknown>> | undefined
let routes: Route[] | undefined
let routeFilter = ''
let appLog = ''

// ─── Helpers ───────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

function tail(text: string, max = MAX_TEXT): string {
  return text.length > max ? '…' + text.slice(-max) : text
}

/** Split "make:model Post -m --force" into argv, keeping quoted strings together. */
function splitArgs(input: string): string[] {
  const out: string[] = []
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm'
}

function pushText(svc: Service, text: string) {
  const parts = (svc.partial + stripAnsi(text)).split('\n')
  svc.partial = parts.pop() ?? ''
  svc.lines.push(...parts.filter(line => line.trim() !== ''))
  if (svc.lines.length > MAX_LOG_LINES) svc.lines.splice(0, svc.lines.length - MAX_LOG_LINES)
}

function redraw($: Api) {
  $.ui.invalidate('ui.render')
}

function updateStatus($: Api) {
  const running = Object.values(services).filter(s => s.run).map(s => s.name)
  $.ui.status(running.length ? '▶ ' + running.join(' · ') : undefined)
}

function notLaravel(): string {
  return 'No `artisan` file in this directory, so this does not look like a Laravel project. Start Claude Code from the project root.'
}

// ─── Running commands ──────────────────────────────────────────────────────

/** Run a one-shot command, keep its output for the Commands tab, and return it. */
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

// ─── Long-running services ─────────────────────────────────────────────────

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
        pushText(svc, step.value.text)
        redraw($)
        step = await stream.next()
      }
      // A stream closed by stopService ends without a result
      const end = step.value as ProcessSpawnResult | undefined
      if (!end || end.signal) svc.lines.push('■ stopped')
      else svc.lines.push(`■ exited with code ${end.code}`)
      if (end?.code) $.ui.toast(`${svc.label} exited with code ${end.code}`)
    } catch (err) {
      svc.lines.push('■ ' + String(err))
    }
    if (svc.run === run) {
      svc.run = undefined
      svc.startedAt = undefined
    }
    finish()
    updateStatus($)
    redraw($)
  })()

  updateStatus($)
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
  updateStatus($)
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
  if (action === 'logs') return `${svc.label} — last 60 lines:\n` + svc.lines.slice(-60).join('\n')
  return svc.run ? `${svc.label} is running (${ago(svc.startedAt ?? Date.now())}).` : `${svc.label} is stopped.`
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
  return `${method} /${r.uri.replace(/^\//, '')}${r.name ? '  ' + r.name : ''}  ${r.action.replace(/^App\\Http\\Controllers\\/, '')}`
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

async function loadLog($: Api) {
  try {
    const r = await $.process.run(['tail', '-n', '120', 'storage/logs/laravel.log'], { timeoutMs: 10_000 })
    appLog = r.exitCode === 0 ? stripAnsi(r.stdout) : 'No storage/logs/laravel.log yet.'
  } catch (err) {
    appLog = String(err)
  }
  redraw($)
}

async function detectProject($: Api) {
  isLaravel = await $.fs.exists('artisan')
  if (!isLaravel) return

  if (await $.fs.exists('bun.lock')) pm = 'bun'
  else if (await $.fs.exists('bun.lockb')) pm = 'bun'
  else if (await $.fs.exists('pnpm-lock.yaml')) pm = 'pnpm'
  else if (await $.fs.exists('yarn.lock')) pm = 'yarn'
  services.vite.argv = [pm, 'run', 'dev']
  for (const q of QUICK) if (q.argv[0] === 'npm') q.argv = [pm, ...q.argv.slice(1)], q.label = q.label.replace('npm', pm)

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

const commandFailed = (_$: Api, _e: unknown, next: { error: { message?: string } }) => ({ text: 'laravel: ' + (next.error.message ?? 'failed') })
const toolFailed = (_$: Api, _e: unknown, next: { error: { message?: string } }) => ({ result: 'laravel: ' + (next.error.message ?? 'failed') })

// ─── The mod ───────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await detectProject($)

    const commands = [
      { name: 'laravel', description: 'Open the Laravel pane', immediate: true as const },
      { name: 'laravel-artisan', description: 'Run php artisan <args>', argumentHint: '<command> [args]' },
      { name: 'laravel-queue', description: 'Queue worker: start, stop, restart, logs', argumentHint: '[start|stop|restart|logs]', immediate: true as const },
      { name: 'laravel-vite', description: 'Vite dev server: start, stop, restart, logs', argumentHint: '[start|stop|restart|logs]', immediate: true as const },
      { name: 'laravel-schedule', description: 'Scheduler (schedule:work): start, stop, restart, logs', argumentHint: '[start|stop|restart|logs]', immediate: true as const },
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
        'Run a Laravel artisan command in the project and return its output, e.g. "route:list --path=api", "make:model Post -m", "tinker --execute=\'dump(App\\\\Models\\\\User::count())\'". Destructive database commands are refused.',
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
      name: 'routes',
      description: 'List the Laravel routes (method, URI, name, action), optionally filtered by a substring.',
      inputSchema: { type: 'object', properties: { filter: { type: 'string' } } },
      isDeferred: false,
    })

    return next(e)
  })

  // ── Slash commands ──

  on('command.run', { command: 'laravel' }, async $ => {
    if (!isLaravel) return { text: notLaravel() }
    await $.ui.open({ id: PANE, title: 'Laravel', focus: true, closeOnEscape: true })
    if (!about) void loadAbout($)
    return {}
  }).catch(commandFailed)

  on('command.run', { command: 'laravel-artisan' }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    if (!e.args.trim()) return { text: 'Usage: /laravel-artisan <command> [args], e.g. /laravel-artisan make:model Post -m' }
    const run = await runCommand($, 'artisan ' + e.args, ['php', 'artisan', ...splitArgs(e.args), '--no-interaction'])
    return { text: formatRun(run) }
  }).catch(commandFailed)

  on('command.run', { command: ['laravel-queue', 'laravel-vite', 'laravel-schedule'] }, async ($, e) => {
    if (!isLaravel) return { text: notLaravel() }
    const action = e.args.trim() || 'status'
    return { text: await serviceAction($, e.command.replace('laravel-', ''), action) }
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
    if (DESTRUCTIVE.test(command)) {
      return { result: `Refused: "${command}" can destroy data. Ask the user to run it themselves with /laravel-artisan ${command}` }
    }
    const run = await runCommand($, 'artisan ' + command, ['php', 'artisan', ...splitArgs(command), '--no-interaction'], 300_000)
    return { result: formatRun(run) }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__laravel__service' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const args = e as unknown as { name?: string; action?: string }
    return { result: await serviceAction($, String(args.name), String(args.action ?? 'status')) }
  }).catch(toolFailed)

  on('tool.call', { tool: 'mcp__laravel__routes' }, async ($, e) => {
    if (!isLaravel) return { result: notLaravel() }
    const list = await loadRoutes($)
    if (typeof list === 'string') return { result: list }
    const filter = String((e as unknown as { filter?: string }).filter ?? '')
    const shown = filterRoutes(list, filter)
    return { result: tail(`${shown.length} of ${list.length} routes\n` + shown.map(formatRoute).join('\n')) }
  }).catch(toolFailed)

  // ── Restart the queue worker after Claude edits PHP, so it runs the new code ──

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const result = await next(e)
    const path = String((e as unknown as { file_path?: string }).file_path ?? '')
    if (autoRestartQueue && services.queue.run && path.endsWith('.php')) {
      restartTimer?.cancel()
      restartTimer = $.clock.after(2000, async () => {
        await restartService($, 'queue')
        $.ui.toast(`${services.queue.label} restarted after PHP edits`)
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  // ── The pane ──

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Text fields exist in the terminal and the Desktop app, not in VS Code or mobile
    const Input = 'Input' in elements ? elements.Input : undefined
    const width = e.props.bodyColumns ?? 80
    const rows = Math.max(8, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30) - 6)

    const tabButton = (id: typeof tab, label: string, hotkey: string) => (
      <Button
        key={'tab-' + id}
        label={label}
        hotkey={hotkey}
        plain
        dimColor={tab !== id}
        onPress={() => {
          tab = id
          if (id === 'overview' && !about) void loadAbout($)
          if (id === 'routes' && !routes) void loadRoutes($)
          if (id === 'log') void loadLog($)
          redraw($)
        }}
      />
    )

    const header = (
      <Box flexDirection="row" columnGap={2}>
        {tabButton('services', 'Services', 's')}
        {tabButton('commands', 'Commands', 'c')}
        {tabButton('routes', 'Routes', 'r')}
        {tabButton('log', 'Log', 'l')}
        {tabButton('overview', 'About', 'a')}
      </Box>
    )

    const line = (text: string, dim = false) => (
      <Text dimColor={dim} wrap="truncate-end">
        {text.slice(0, width + 20) || ' '}
      </Text>
    )

    let body
    if (tab === 'services') {
      const shown = services[logOf]
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
                label="log"
                dimColor={logOf !== svc.name}
                onPress={() => {
                  logOf = svc.name
                  redraw($)
                }}
              />
            </Box>
          ))}
          <Button
            key="auto-restart"
            label={`auto-restart ${services.queue.label.toLowerCase()} on PHP edits: ${autoRestartQueue ? 'on' : 'off'}`}
            plain
            dimColor
            onPress={() => {
              autoRestartQueue = !autoRestartQueue
              redraw($)
            }}
          />
          <Text> </Text>
          <Text bold>{shown?.label ?? ''} output</Text>
          {(shown?.lines.length ? shown.lines.slice(-(rows - Object.keys(services).length - 3)) : ['(no output yet)']).map(l =>
            line(l, true),
          )}
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
          {Input && <Input
            key="artisan-input"
            label="artisan"
            placeholder="make:model Post -m"
            value=""
            submitLabel="run"
            onSubmit={value => {
              if (value.trim()) void runCommand($, 'artisan ' + value, ['php', 'artisan', ...splitArgs(value), '--no-interaction'])
            }}
          />}
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
          {Input && <Input
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
          />}
          {!routes ? <Text dimColor>Loading routes…</Text> : <Text dimColor>{`${shown.length} of ${routes.length}`}</Text>}
          {shown.slice(0, rows - 3).map(r => line(formatRoute(r)))}
          <Button key="routes-refresh" label="refresh" plain dimColor onPress={() => void loadRoutes($)} />
        </Box>
      )
    } else if (tab === 'log') {
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Button key="log-refresh" label="refresh" plain onPress={() => void loadLog($)} />
            <Button
              key="log-clear"
              label="clear laravel.log"
              plain
              dimColor
              onPress={async () => {
                await $.fs.write('storage/logs/laravel.log', '')
                await loadLog($)
              }}
            />
          </Box>
          {(appLog || 'Loading…').split('\n').slice(-(rows - 2)).map(l => line(l, true))}
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column">
          {!about && <Text dimColor>Loading `php artisan about`…</Text>}
          {about &&
            Object.entries(about).map(([section, values]) => (
              <Box flexDirection="column">
                <Text bold>{section}</Text>
                {Object.entries(values ?? {}).map(([k, v]) => line(`  ${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`, true))}
              </Box>
            ))}
          <Button key="about-refresh" label="refresh" plain dimColor onPress={() => void loadAbout($)} />
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
