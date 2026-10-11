import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PHP_OPTIONS } from '../hooks/parse'
import { LOG } from './fixtures'

/**
 * Stand in for a Laravel project on disk and for php/npm, so no real process runs.
 * Background work at start (log tail, migrate:status, queue snapshot) also lands in `ran`.
 *
 * `herd`: the binary `herd php` reports; `shellPhp`: what plain `php` reports; `composerShim`: Composer on PATH is
 * a shell script; `files`: extra files in the project and their contents; `env`: the environment `artisan about`
 * reports; `exits`: exit code of spawned processes by command (`pnpm`); `curl`: curl's exit code; `connections`: the
 * local servers the app's config names (connectionsPhp); `herdServices`: Herd's services.plist as plutil turns it into JSON; `closed`: ports
 * nothing listens on; `share`: the answer to the "send to Claude?" question (default Send redacted), whose
 * questions land in `asked`; `tests`: what `php artisan test` prints; `debug`: what Herd's debug session hands back;
 * `pending`: migrations migrate:status lists as pending, until `migrate` runs; `answers`: answers to the next
 * questions, in turn, before `share`; `editor`: the editor Laravel's `app.editor` names; `noEditor`: its links don't open;
 * `routesFail`: what routesPhp prints as it fails; `raw`: every command run or spawned, PHP_OPTIONS included (`ran`
 * and `spawned` leave them out, so they read as typed); `dir`: the session's folder (default /app); `nc`: nc is
 * missing, or the exit code it gives every port; `hold`: spawned processes whose argv has one of these keep running
 * until stopped; `aboutGate`: `artisan about` answers once it resolves, with the env at the time it was asked;
 * `toasts`: the toasts shown; `says`: printed by artisan commands, held processes and a name artisan can't resolve,
 * on top of what they print anyway; `snapshot` as a string: what the queue snapshot prints instead of JSON; `run`: the answer to "Claude wants to run…" (default Run it). `share` or `run` null:
 * nobody is there to answer (`claude -p`), so the question fails.
 */
type Fake = {
  history?: string
  live?: string
  snapshot?: unknown
  herd?: string
  shellPhp?: string
  composerShim?: boolean
  spawned?: string[][]
  raw?: string[][]
  files?: Record<string, string>
  env?: string
  exits?: Record<string, number>
  curl?: number
  reads?: string[]
  connections?: { use: string; driver: string; port: number }[]
  herdServices?: unknown[]
  closed?: number[]
  share?: string | null
  run?: string | null
  says?: string
  asked?: string[]
  tests?: string
  debug?: string
  pending?: number
  answers?: string[]
  editor?: string
  noEditor?: boolean
  routesFail?: string
  dir?: string
  nc?: 'missing' | number
  hold?: string[]
  aboutGate?: Promise<void>
  toasts?: string[]
}

const COMPOSER = '/opt/bin/composer'

/** `argv` without PHP_OPTIONS after its PHP binary. */
const plain = (argv: readonly string[]) => {
  const at = argv.findIndex((a, i) => a === PHP_OPTIONS[0] && argv[i + 1] === PHP_OPTIONS[1])
  return at < 0 ? [...argv] : [...argv.slice(0, at), ...argv.slice(at + PHP_OPTIONS.length)]
}

/**
 * What routesPhp prints: route:list's columns, with where each route's code is. `domain` on `team` is what the
 * mod must drop if PHP ever printed it.
 */
const TAB_ROUTES = [
  { id: 0, method: 'GET|HEAD', uri: '/', name: null, action: 'Closure', file: 'routes/web.php', line: 5, params: [], onDomain: false },
  { id: 2, method: 'POST', uri: 'api/posts', name: 'posts.store', action: 'App\\Http\\Controllers\\PostController@store', file: 'app/Http/Controllers/PostController.php', line: 20, params: [], onDomain: false },
  { id: 1, method: 'GET|HEAD', uri: 'users', name: 'users.index', action: 'App\\Http\\Controllers\\UserController@index', file: 'app/Http/Controllers/UserController.php', line: 12, params: [], onDomain: false },
  { id: 3, method: 'GET|HEAD', uri: 'users/{user}', name: 'users.show', action: 'App\\Http\\Controllers\\UserController@show', file: 'app/Http/Controllers/UserController.php', line: 18, params: ['user'], onDomain: false },
  { id: 4, method: 'GET|HEAD', uri: 'team', name: null, action: 'Closure', file: 'routes/web.php', line: 9, params: ['account'], onDomain: true, domain: '{account}.example.test' },
  { id: 5, method: 'GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS', uri: 'webhook', name: null, action: 'App\\Http\\Controllers\\WebhookController', file: 'app/Http/Controllers/WebhookController.php', line: 7, params: [], onDomain: false },
]
const HERD_BIN = '/Users/me/Library/Application Support/Herd/bin'
const HERD_CLI = HERD_BIN + '/herd'
const HERD_PLIST = '/Users/me/Library/Application Support/Herd/config/services.plist'

/** What the fake `php artisan help <name>` resolves each (lower-cased) name to. */
const HELP: Record<string, string> = {
  'make:model': 'make:model',
  migrate: 'migrate',
  test: 'test',
  'migrate:fresh': 'migrate:fresh',
  'migr:fr': 'migrate:fresh',
  'd:w': 'db:wipe',
  dow: 'down',
  tin: 'tinker',
  tinker: 'tinker',
}

function fakeProject(on: On, ran: string[][], fake: Fake = {}) {
  // Hooks see absolute paths, resolved against the working directory
  const file = (path: string) => {
    const key = Object.keys(fake.files ?? {}).find(f => path === f || path.endsWith('/' + f))
    return key === undefined ? undefined : fake.files![key]
  }
  mock.store(on)
  mock.env(on, { HOME: '/Users/me' })
  if (fake.herdServices) fake.files = { ...fake.files, [HERD_PLIST]: '<?xml version="1.0"?><plist/>' }
  const clock = mock.clock(on)
  on('fs.exists', ($, e) => ({
    value:
      ['artisan', 'composer.json', 'pnpm-lock.yaml'].some(f => e.path === f || e.path.endsWith('/' + f)) ||
      [fake.herd, fake.shellPhp ?? '/usr/bin/php', COMPOSER, HERD_CLI].includes(e.path) ||
      file(e.path) !== undefined,
  }))
  on('fs.stat', ($, e) => {
    if (file(e.path) === undefined) throw new Error('ENOENT: ' + e.path)
    return { value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } as never }
  })
  on('session.start', ($, e) => e)
  on('fs.read', ($, e) => {
    fake.reads?.push(e.path)
    return { value: file(e.path) ?? '{"require":{"laravel/framework":"^12.0"}}' }
  })
  on('command.register', () => ({ value: {} }))
  on('tool.register', () => ({ value: {} }))
  on('ui.toast', ($, e) => {
    fake.toasts?.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = String((e as unknown as { questions: { question: string }[] }).questions[0]?.question)
    fake.asked?.push(question)
    const answer = question.startsWith('Claude (or a command') ? (fake.run === undefined ? 'Run it' : fake.run) : (fake.answers?.shift() ?? (fake.share === undefined ? 'Send redacted' : fake.share))
    if (answer === null) throw new Error('nobody to ask')
    return { result: { answers: { [question]: answer } } } as never
  })
  on('session.cwd', () => ({ value: fake.dir ?? '/app' }))
  on('fs.list', () => ({ value: [] }))
  // Nothing else draws in the band
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  // tail -F of the log: a quiet stream that ends at once
  on('process.spawn', async function* ($, e, next) {
    fake.raw?.push([...e.argv])
    fake.spawned?.push(plain(e.argv))
    if (e.argv[0] === 'tail' && fake.live) yield { stream: 'stdout' as const, text: fake.live }
    if (fake.hold?.some(word => e.argv.includes(word))) {
      yield { stream: 'stdout' as const, text: 'started\n' + (fake.says ? fake.says + '\n' : '') }
      // Runs until the mod closes the stream
      await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve()))
      return { value: { code: null, signal: 'SIGTERM' as const } }
    }
    return { value: { code: fake.exits?.[e.argv[0]!] ?? 0, signal: null } }
  })
  on('process.run', async ($, e) => {
    fake.raw?.push([...e.argv])
    const argv = plain(e.argv)
    ran.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const missing = { value: { exitCode: 1, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'tail') return ok(fake.history ?? '')
    if (argv[0] === 'curl') return { value: { exitCode: fake.curl ?? 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv.join(' ') === 'php artisan about --json') {
      const env = fake.env ?? 'local'
      await fake.aboutGate
      return ok(JSON.stringify({ environment: { environment: env } }))
    }
    if (argv[0] === 'plutil') return argv.at(-1) === HERD_PLIST && fake.herdServices ? ok(JSON.stringify(fake.herdServices)) : missing
    // Herd starts the service: its port answers from then on
    if (argv.includes('migrate:status')) return ok(Array.from({ length: fake.pending ?? 0 }, (_, i) => `2026_01_0${i + 1}_000000_x ..... Pending`).join('\n'))
    if (argv[0] === 'php' && argv[2] === 'migrate') fake.pending = 0
    if (argv[0] === 'osascript' && argv.join(' ').includes('dumps')) return ok(argv.join(' ').includes('dumps stop debug') ? (fake.debug ?? '{}') : '')
    if (argv[0] === 'php' && argv[1] === 'artisan' && argv[2] === 'test' && fake.tests !== undefined) return { value: { exitCode: 1, stdout: fake.tests, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'osascript') {
      fake.closed = fake.closed?.filter(port => port !== Number(argv.at(-2)))
      return ok('')
    }
    if (argv[0] === 'nc') {
      if (fake.nc === 'missing') throw new Error('spawn nc ENOENT')
      const exitCode = fake.nc ?? (fake.closed?.includes(Number(argv.at(-1))) ? 1 : 0)
      return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // Herd: which binary serves this folder, and Composer's path; without Herd there's no `herd` on PATH
    if (argv[0] === 'herd') return fake.herd ? ok(`${fake.herd}\n8.3.21`) : missing
    if (argv.join(' ') === 'which herd') return fake.herd ? ok(HERD_CLI) : missing
    if (argv.join(' ') === 'which composer') return ok(COMPOSER)
    if (argv[0] === 'php' && argv[2]?.includes('PHP_BINARY')) return ok(`${fake.shellPhp ?? '/usr/bin/php'}\n8.4.1`)
    if (argv[1] === COMPOSER && argv[2] === '--version') return ok(fake.composerShim ? '#!/usr/bin/env bash\nexec mise x -- composer "$@"' : 'Composer version 2.10.2')
    if (argv[0] === 'php' && argv[1] === '-r' && argv[2]?.includes("'connections'")) return ok('Deprecated: x\n' + JSON.stringify({ connections: fake.connections ?? [] }))
    if (argv[0] === 'php' && argv[1] === '-r' && argv[2]?.includes("'onDomain'")) {
      if (fake.routesFail) return { value: { exitCode: 1, stdout: fake.routesFail, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      return ok('Deprecated: x\n' + JSON.stringify({ routes: TAB_ROUTES, editor: fake.editor ?? null }))
    }
    if (argv[0] === 'php' && argv[1] === '-r' && argv[2]?.includes('proc_open')) return ok('{"opened":true}')
    if (argv.join(' ') === 'uname -s') return ok('Darwin\n')
    // An editor whose link macOS can't open (not installed)
    if (argv[0] === 'open' && fake.noEditor && argv[1]?.includes('://')) return missing
    if (argv[0] === 'php' && argv[1] === '-r') return ok(typeof fake.snapshot === 'string' ? fake.snapshot : fake.snapshot ? JSON.stringify(fake.snapshot) : 'no snapshot')
    // `artisan help <name>` resolves abbreviations and case the way Symfony does
    if (argv[2] === 'help') {
      const name = HELP[argv[3]!.toLowerCase()]
      if (!name) return { value: { exitCode: 1, stdout: `ERROR  Command "${argv[3]}" is not defined.\n${fake.says ?? ''}`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      return ok(JSON.stringify({ name, description: '' }))
    }
    return { value: { exitCode: 0, stdout: '\u001b[32mDONE\u001b[39m ' + argv.join(' ') + (fake.says ? '\n' + fake.says : ''), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return clock
}

test('/lara-artisan runs php artisan with the arguments and returns clean output', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.command.run({ command: 'lara-artisan', args: 'make:model Post -m' })
  expect(ran.find(argv => argv[2] === 'make:model')).toEqual(['php', 'artisan', 'make:model', 'Post', '-m', '--no-interaction'])
  expect(answer.text).toContain('✓ artisan make:model Post -m')
  expect(answer.text).not.toContain('\u001b[')
})

test('/lara-npm uses the package manager from the lockfile', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  await $.command.run({ command: 'lara-npm', args: 'build' })
  expect(ran.find(argv => argv[1] === 'run')).toEqual(['pnpm', 'run', 'build'])
})

test('/lara-routes filters the route list', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.command.run({ command: 'lara-routes', args: 'posts' })
  expect(answer.text).toContain('1 of 6 routes')
  expect(answer.text).toContain('posts.store')
  expect(answer.text).not.toContain('users.index')
  // The same list as the Routes tab: one PHP boot, no route:list, and no route's domain
  expect(ran.some(argv => argv.join(' ') === 'php artisan route:list --json')).toBe(false)
  expect((await $.command.run({ command: 'lara-routes', args: '' })).text).not.toContain('example')
})

test("the routes tool redacts why the routes couldn't be read", async ($, on) => {
  const ran: string[][] = []
  const routesFail = 'Deprecated: f(): Implicitly nullable\n\n  Illuminate\\Database\\QueryException\n\n  SQLSTATE[HY000] [1045] Access denied for jane@example.com (password: hunter2secret)\n'
  fakeProject(on, ran, { routesFail })
  await $.session.start({ cwd: '/app' })

  const answer = await $.tool.call({ tool: 'mcp__lara-cc__routes' } as never)
  const text = JSON.stringify(answer)
  expect(text).toContain('QueryException: SQLSTATE[HY000]')
  expect(text).not.toContain('hunter2secret')
  expect(text).not.toContain('jane@example.com')
})

test('the artisan tool refuses destructive commands', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const attempts = [
    'migrate:fresh',
    '-q migrate:fresh',
    'migr:fr',
    'MIGRATE:FRESH',
    'd:w',
    'dow',
    'tin --execute="App\\Models\\User::truncate()"',
    'migrate --force',
    'make:model Post -mf',
    'migrate --env=production',
    'test --env testing',
    'migrate --seed',
  ]
  for (const command of attempts) {
    const before = ran.length
    const answer = await $.tool.call({ tool: 'mcp__lara-cc__artisan', command })
    expect(JSON.stringify(answer)).toContain('Refused')
    // at most the `help` lookup ran, never the command itself
    expect(ran.slice(before).filter(argv => argv[2] !== 'help')).toEqual([])
  }
})

test('the artisan tool runs safe commands once artisan has resolved the name', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'make:model Post -m' })
  expect(JSON.stringify(answer)).toContain('✓ artisan make:model Post -m')
  expect(ran).toContainEqual(['php', 'artisan', 'help', 'make:model', '--format=json', '--no-interaction'])
  expect(ran).toContainEqual(['php', 'artisan', 'make:model', 'Post', '-m', '--no-interaction'])
})

test('the artisan tool does not run a name artisan cannot resolve', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'nope:thing' })
  expect(JSON.stringify(answer)).toContain('could not resolve')
  expect(ran.some(argv => argv[2] === 'nope:thing')).toBe(false)
})

test('/lara-artisan from a plugin or relayed message gets the same check', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.command.run({ command: 'lara-artisan', args: 'migr:fr' })
  expect(answer.text).toContain('Refused: migrate:fresh can destroy data')
  expect(ran.some(argv => argv[2] === 'migr:fr')).toBe(false)
})

test('/lara-schedule reports the scheduler', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.command.run({ command: 'lara-schedule', args: '' })
  expect(answer.text).toBe('Scheduler is stopped.')
})

test('the logs tool returns errors from the history and the live tail, with origin', async ($, on) => {
  const ran: string[][] = []
  const split = LOG.indexOf('[2026-10-10 08:01:02]')
  const clock = fakeProject(on, ran, { history: LOG.slice(0, split), live: LOG.slice(split) })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const all = await $.tool.call({ tool: 'mcp__lara-cc__logs', level: 'all', count: 10 })
  expect(JSON.stringify(all)).toContain('User 1 logged in')

  const errors = JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__logs' }))
  expect(errors).toContain('Call to undefined method')
  expect(errors).toContain('app/Http/Controllers/OrderController.php:42')
  expect(errors).not.toContain('logged in')
})

test('the queue tool lists failed jobs and retries one', async ($, on) => {
  const ran: string[][] = []
  const snapshot = {
    connection: 'redis',
    sizes: { default: 4 },
    failedTotal: 1,
    failed: [{ id: 'abc-123', queue: 'default', job: 'App\\Jobs\\ChargeCard', failedAt: '2026-10-10 08:01:03', exception: 'RuntimeException: Payment gateway down in /app/app/Jobs/ChargeCard.php:12\nStack trace:\n#0 ...' }],
  }
  fakeProject(on, ran, { snapshot })
  await $.session.start({ cwd: '/app' })

  const status = JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__queue', action: 'status' }))
  expect(status).toContain('default=4')
  expect(status).toContain('Failed jobs stored: 1')

  const failed = JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__queue', action: 'failed' }))
  expect(failed).toContain('abc-123')
  expect(failed).toContain('RuntimeException: Payment gateway down')

  await $.tool.call({ tool: 'mcp__lara-cc__queue', action: 'retry', id: 'abc-123' })
  expect(ran.some(argv => argv.join(' ') === 'php artisan queue:retry abc-123')).toBe(true)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`every pane tab and the band draw on ${surface}`, async ($, on) => {
    const ran: string[][] = []
    const split = LOG.indexOf('[2026-10-10 08:01:02]')
    const snapshot = {
      connection: 'redis',
      sizes: { default: 1 },
      failedTotal: 1,
      failed: [{ id: 'abc-123', queue: 'default', job: 'App\\Jobs\\ChargeCard', failedAt: '2026-10-10 08:01:03', exception: 'RuntimeException: down\n#0 x' }],
    }
    const clock = fakeProject(on, ran, { history: LOG.slice(0, split), live: LOG.slice(split), snapshot })
    on('ui.open', () => ({ value: undefined }))
    const asked: string[] = []
    on('prompt.submit', ($, e) => {
      asked.push(e.text)
      return { text: e.text }
    })
    await $.session.start({ cwd: '/app' })
    await clock.settle()

    const band = await $.ui.mount({
      plugin: 'lara-cc',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 } as never,
    })
    const drawn = JSON.stringify(await band.drawn())
    expect(drawn).toContain('▲ 1 new error ')
    expect(drawn).toContain('1 failed job')

    const pane = await $.ui.mount({
      plugin: 'lara-cc',
      surface,
      component: 'Pane',
      requestId: 'lara',
      props: { title: 'lara-cc', isFocused: true, bodyColumns: 100, placement: 'dock' } as never,
    })
    for (const tab of ['services', 'queue', 'log', 'routes', 'commands', 'about']) {
      await pane.press({ key: 'tab-' + tab })
      expect((await pane.findAll({ type: 'Button' })).length).toBeGreaterThan(0)
    }
    await pane.press({ key: 'tab-log' })
    expect(JSON.stringify(await pane.drawn())).toContain('app/Http/Controllers/OrderController.php:42')
    await pane.press({ key: 'tab-queue' })
    expect(JSON.stringify(await pane.drawn())).toContain('ChargeCard')
    await pane.press({ key: 'ask-abc-123' })
    expect(asked[0]).toContain('Failed job id: abc-123')

    // Viewing the log clears the "new errors" count in the band
    expect(JSON.stringify(await band.drawn())).not.toContain('new error')
  })
}

test('with Herd as the PATH php, artisan, composer and services run on the binary Herd serves the folder with', async ($, on) => {
  const herd = HERD_BIN + '/php83'
  const ran: string[][] = []
  const spawned: string[][] = []
  fakeProject(on, ran, { herd, shellPhp: HERD_BIN + '/php84', spawned })
  await $.session.start({ cwd: '/app' })

  await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'migrate' })
  expect(ran).toContainEqual([herd, 'artisan', 'help', 'migrate', '--format=json', '--no-interaction'])
  expect(ran).toContainEqual([herd, 'artisan', 'migrate', '--no-interaction'])

  await $.command.run({ command: 'lara-composer', args: 'install' })
  expect(ran).toContainEqual([herd, COMPOSER, 'install', '--no-interaction'])

  const started = await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'start' })
  expect(spawned).toContainEqual([herd, 'artisan', 'queue:work', '--tries=1'])
  // Claude is told the binary that really runs, not `php`
  expect(JSON.stringify(started)).toContain(`php83 ${PHP_OPTIONS.join(' ')} artisan queue:work`)
  expect(ran.some(argv => argv[0] === 'php' && argv[1] === 'artisan')).toBe(false)
})

test("every PHP the mod starts sends PHP's own warnings to stderr, so stdout holds only what it prints", async ($, on) => {
  const herd = HERD_BIN + '/php83'
  const ran: string[][] = []
  const raw: string[][] = []
  const clock = fakeProject(on, ran, { herd, shellPhp: HERD_BIN + '/php84', raw })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'migrate' })
  await $.command.run({ command: 'lara-composer', args: 'install' })
  await $.tool.call({ tool: 'mcp__lara-cc__routes' } as never)
  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'start' })
  // Every launch of PHP: the probes, artisan, the php -r snippets, Composer through PHP, the worker
  const php = raw.filter(argv => argv[0] === 'php' || argv[0] === herd || (argv[0] === 'herd' && argv[1] === 'php'))
  expect(php.some(argv => argv.includes('-r'))).toBe(true)
  expect(php.some(argv => argv.includes(COMPOSER))).toBe(true)
  expect(php.some(argv => argv.includes('queue:work'))).toBe(true)
  for (const argv of php) {
    // Composer's version check only decides how to run Composer
    if (argv[2] === '--version') continue
    const at = argv[0] === 'herd' ? 2 : 1
    expect(argv.slice(at, at + PHP_OPTIONS.length)).toEqual(PHP_OPTIONS)
  }
})

test('with Herd installed but another php on PATH, the PATH php stays', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran, { herd: HERD_BIN + '/php83', shellPhp: '/opt/homebrew/bin/php' })
  await $.session.start({ cwd: '/app' })

  await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'migrate' })
  expect(ran).toContainEqual(['php', 'artisan', 'migrate', '--no-interaction'])
  await $.command.run({ command: 'lara-composer', args: 'install' })
  expect(ran).toContainEqual(['composer', 'install', '--no-interaction'])
})

test('with Herd, a Composer that is a shell shim runs as is, not through PHP', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran, { herd: HERD_BIN + '/php83', shellPhp: HERD_BIN + '/php84', composerShim: true })
  await $.session.start({ cwd: '/app' })

  await $.command.run({ command: 'lara-composer', args: 'install' })
  expect(ran).toContainEqual(['composer', 'install', '--no-interaction'])
})

test('without Herd, php and composer come from PATH', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  await $.command.run({ command: 'lara-composer', args: 'install' })
  expect(ran).toContainEqual(['composer', 'install', '--no-interaction'])
  expect(ran.some(argv => argv.join(' ') === 'which composer')).toBe(false)
})

/** The band as drawn. */
async function drawBand($: Engine): Promise<string> {
  const band = await $.ui.mount({
    plugin: 'lara-cc',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 200 } as never,
  })
  return JSON.stringify(await band.drawn())
}

test('the band flags a production environment, maintenance mode and cached config, without reading .env', async ($, on) => {
  const ran: string[][] = []
  const reads: string[] = []
  const files = { 'storage/framework/down': '{}', 'bootstrap/cache/config.php': '<?php', 'bootstrap/cache/routes-v7.php': '<?php' }
  const clock = fakeProject(on, ran, { files, env: 'production', reads })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const drawn = await drawBand($)
  expect(drawn).toContain('env: production')
  expect(drawn).toContain('maintenance mode')
  expect(drawn).toContain('config+routes cached')
  expect(reads.some(path => path.includes('.env'))).toBe(false)
})

test('the band flags public/hot when the Vite it names is gone', async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran, { files: { 'public/hot': 'http://[::1]:5173' }, curl: 7 })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  expect(await drawBand($)).toContain('Vite not running (public/hot)')
  expect(ran).toContainEqual(['curl', '-q', '-s', '-o', '/dev/null', '-m', '2', '-k', 'http://[::1]:5173/'])
})

test('public/hot is fine while Vite answers, e.g. run in another terminal', async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran, { files: { 'public/hot': 'https://shop.test:5173' }, curl: 0 })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  expect(await drawBand($)).not.toContain('public/hot')
})

test('public/hot naming another machine is never probed', async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran, { files: { 'public/hot': 'http://example.com:5173' }, curl: 7 })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  expect(ran.some(argv => argv[0] === 'curl')).toBe(false)
  expect(await drawBand($)).not.toContain('public/hot')
})

test('the band flags dependencies out of step with the lockfiles', async ($, on) => {
  const ran: string[][] = []
  const files = {
    'composer.lock': JSON.stringify({ packages: [{ name: 'acme/billing', version: '2.1.0' }] }),
    'vendor/composer/installed.json': JSON.stringify({ packages: [{ name: 'acme/billing', version: '2.0.0' }], dev: true }),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0',
  }
  const clock = fakeProject(on, ran, { files })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const drawn = await drawBand($)
  expect(drawn).toContain('composer install needed')
  // no node_modules at all
  expect(drawn).toContain('pnpm install needed')
})

test('a crashed process shows in the band until the Services tab is opened', async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran, { exits: { pnpm: 1 } })
  on('ui.open', () => ({ value: undefined }))
  await $.session.start({ cwd: '/app' })
  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'vite', action: 'start' })
  await clock.settle()

  expect(await drawBand($)).toContain('✗ vite exited (1)')
  await $.command.run({ command: 'lara', args: 'services' })
  expect(await drawBand($)).not.toContain('exited')
})

const MYSQL = { type: 'mysql', name: 'MySQL', port: '3306', version: '8.4.11', autoStart: true }
const MYSQL_80 = { type: 'mysql', name: 'MySQL 8.0', port: '3307', version: '8.0.40', autoStart: true }
const REDIS = { type: 'redis', name: 'Redis', port: '6379', version: '7.0.0', autoStart: true }

test('the band flags a stopped Herd service the app connects to, reading only services.plist', async ($, on) => {
  const ran: string[][] = []
  const reads: string[] = []
  const connections = [
    { use: 'database', driver: 'mysql', port: 3307 },
    { use: 'cache', driver: 'redis', port: 6379 },
    { use: 'queue', driver: 'redis', port: 6379 },
  ]
  // MySQL 8.4 on 3306 is up, but the app uses 8.0 on 3307
  const clock = fakeProject(on, ran, { connections, herdServices: [MYSQL, MYSQL_80, REDIS], closed: [3307], reads })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const drawn = await drawBand($)
  expect(drawn).toContain('Herd MySQL 8.0 stopped')
  expect(drawn).not.toContain('Redis stopped')
  expect(ran).toContainEqual(['nc', '-z', '-w', '1', 'localhost', '3307'])
  // No AppleScript, no herd CLI beyond `herd php`, no .env
  expect(ran.some(argv => argv[0] === 'osascript' || (argv[0] === 'herd' && argv[1] !== 'php'))).toBe(false)
  expect(reads.some(path => path.includes('.env'))).toBe(false)
})

test('a stopped Herd service the app does not connect to is not flagged', async ($, on) => {
  const ran: string[][] = []
  // The database is on a port no Herd service has (Docker, DBngin), and nothing uses Redis
  const connections = [{ use: 'database', driver: 'mysql', port: 33060 }]
  const clock = fakeProject(on, ran, { connections, herdServices: [MYSQL, REDIS], closed: [3306, 6379] })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  expect(await drawBand($)).not.toContain('stopped')
})

test('log entries go to Claude only after asking, redacted, and not at all on no', async ($, on) => {
  const ran: string[][] = []
  const asked: string[] = []
  const history = '[2026-10-10 10:00:00] local.ERROR: Login failed for jane@example.com password=hunter2 {"exception":"x"}\n'
  const clock = fakeProject(on, ran, { history, asked, share: "Don't send" })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const declined = JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__logs' }))
  expect(asked[0]).toContain('confidential')
  expect(declined).toContain('chose not to send')
  expect(declined).not.toContain('Login failed')
})

test('allowing for the session stops the asking, and what is sent is redacted', async ($, on) => {
  const ran: string[][] = []
  const asked: string[] = []
  const history = '[2026-10-10 10:00:00] local.ERROR: Login failed for jane@example.com password=hunter2 {"exception":"x"}\n'
  const clock = fakeProject(on, ran, { history, asked, share: 'Allow this session' })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const first = JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__logs' }))
  await $.tool.call({ tool: 'mcp__lara-cc__logs' })
  expect(asked.length).toBe(1)
  expect(first).toContain('Login failed for [email] password=[redacted]')
  expect(first).not.toContain('hunter2')
})

test('the artisan tool refuses commands that print secrets', async ($, on) => {
  const ran: string[][] = []
  HELP['config:show'] = 'config:show'
  const clock = fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const out = JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'config:show database' }))
  expect(out).toContain('Refused')
  // Typed by the person too: the output would land where Claude reads it
  const typed = JSON.stringify(await $.command.run({ command: 'lara-artisan', args: 'config:show database', origin: { kind: 'composer' } } as never))
  expect(typed).toContain('own terminal')
  expect(ran.some(argv => argv.includes('config:show') && !argv.includes('help'))).toBe(false)
})

test('a stopped Herd service starts from its button on the Services tab, with values passed as arguments', async ($, on) => {
  const ran: string[][] = []
  const connections = [{ use: 'database', driver: 'mysql', port: 3306 }]
  const clock = fakeProject(on, ran, { connections, herdServices: [MYSQL], closed: [3306] })
  on('ui.open', () => ({ value: undefined }))
  await $.session.start({ cwd: '/app' })
  await clock.settle()
  expect(await drawBand($)).toContain('Herd MySQL stopped')

  const pane = await $.ui.mount({
    plugin: 'lara-cc',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'lara',
    props: { title: 'lara-cc', isFocused: true, bodyColumns: 100, placement: 'dock' } as never,
  })
  await pane.press({ key: 'tab-services' })
  await pane.press({ key: 'herd-start-3306' })
  await clock.settle()

  const osascript = ran.find(argv => argv[0] === 'osascript')!
  expect(osascript.slice(-3)).toEqual(['mysql', '3306', '8.4.11'])
  // The script text is fixed: nothing from the plist is written into it
  expect(osascript.filter((_, i) => osascript[i - 1] === '-e').join('\n')).not.toContain('mysql')
  expect(await drawBand($)).not.toContain('stopped')
})

for (const nc of ['missing', 2] as const) {
  test(`a Herd service nc can't check (${nc === 'missing' ? 'nc missing' : 'exit ' + nc}) reads as unchecked, never running or stopped`, async ($, on) => {
    const ran: string[][] = []
    const toasts: string[] = []
    const connections = [{ use: 'database', driver: 'mysql', port: 3306 }]
    const clock = fakeProject(on, ran, { connections, herdServices: [MYSQL, REDIS], nc, toasts })
    on('ui.open', () => ({ value: undefined }))
    await $.session.start({ cwd: '/app' })
    await clock.settle()

    const band = await drawBand($)
    expect(band).toContain('Herd MySQL unchecked')
    expect(band).not.toContain('stopped')
    // Redis isn't used, so it isn't flagged either way
    expect(band).not.toContain('Redis')

    const pane = await mountPane($)
    await pane.press({ key: 'tab-services' })
    const drawn = JSON.stringify(await pane.drawn())
    expect(drawn).toContain('? MySQL 8.4.11 :3306 unchecked')
    expect(drawn).not.toContain('● MySQL')

    // Herd is asked, but the toast doesn't claim it's running, and a probe that can't answer gets a few tries, not 20
    const probes = () => ran.filter(argv => argv[0] === 'nc' && argv.at(-1) === '3306').length
    const before = probes()
    await pane.press({ key: 'herd-start-3306' })
    // Past the two retries, half a second apart
    await clock.advance(1000)
    expect(toasts.at(-1)).toContain("couldn't check port 3306")
    // Three for the start, one for the checks that run after it
    expect(probes() - before).toBe(4)
  })
}

test('moving to another folder leaves nothing of the last: Horizon, its worker and output, logs and checks', async ($, on) => {
  const ran: string[][] = []
  const spawned: string[][] = []
  const fake: Fake = { spawned, hold: ['horizon'], history: LOG, env: 'production', files: { 'composer.json': '{"require":{"laravel/horizon":"^5.0"}}' } }
  const clock = fakeProject(on, ran, fake)
  await $.session.start({ cwd: '/app' })
  await clock.settle()
  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'start' })
  await clock.settle()
  expect(spawned).toContainEqual(['php', 'artisan', 'horizon'])
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'status' }))).toContain('Horizon')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__logs' }))).toContain('Call to undefined method')
  expect(await drawBand($)).toContain('env: production')

  // A plain Laravel app, without Horizon
  Object.assign(fake, { dir: '/other', history: '', env: 'local', files: {} })
  await $.session.start({ cwd: '/other' })
  await clock.settle()

  const status = JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'status' }))
  expect(status).not.toContain('Horizon')
  expect(status).not.toContain('started')
  // Not even the old worker's dying words
  const output = JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'logs' }))
  expect(output).not.toContain('artisan horizon')
  expect(output).not.toContain('■')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__logs' }))).not.toContain('Call to undefined method')
  expect(await drawBand($)).not.toContain('env: production')

  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'start' })
  await clock.settle()
  expect(spawned.at(-1)).toContain('queue:work')
})

test('what the last folder answers after the session has moved on is dropped', async ($, on) => {
  const ran: string[][] = []
  let answer = () => {}
  // The first folder's `artisan about` is slow, and says production
  const fake: Fake = { env: 'production', aboutGate: new Promise<void>(resolve => (answer = resolve)) }
  const clock = fakeProject(on, ran, fake)
  await $.session.start({ cwd: '/app' })

  Object.assign(fake, { dir: '/other', env: 'local', aboutGate: undefined })
  await $.session.start({ cwd: '/other' })
  await clock.settle()
  answer()
  await clock.settle()

  expect(await drawBand($)).not.toContain('env: production')
})

test('a session that starts again in the same folder keeps its worker, its output and what is still on its way', async ($, on) => {
  const ran: string[][] = []
  let answer = () => {}
  let answerAgain = () => {}
  // The first start's `artisan about` is slow, and says production
  const fake: Fake = { hold: ['queue:work'], env: 'production', aboutGate: new Promise<void>(resolve => (answer = resolve)) }
  const clock = fakeProject(on, ran, fake)
  on('ui.open', () => ({ value: undefined }))
  await $.session.start({ cwd: '/app' })
  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'start' })
  await $.command.run({ command: 'lara-artisan', args: 'make:model Post' })

  Object.assign(fake, { env: 'local', aboutGate: new Promise<void>(resolve => (answerAgain = resolve)) })
  await $.session.start({ cwd: '/app' })
  answer()
  await clock.settle()

  // The late answer is this folder's, so it counts
  expect(await drawBand($)).toContain('env: production')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'logs' }))).toContain('started')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'start' }))).toContain('already running')
  const pane = await mountPane($)
  await pane.press({ key: 'tab-commands' })
  expect(JSON.stringify(await pane.drawn())).toContain('artisan make:model Post')
  answerAgain()
  await clock.settle()
})

/** Secrets of several kinds, and the parts of them that must never reach Claude. */
const LEAKY = 'password=hunter2 Authorization: Bearer abcdef123456 mysql://forge:s3cr3t@db.internal:3306 sk_live_51HxYzAbCdEfGhIjKl'
const LEAKED = ['hunter2', 'abcdef123456', 's3cr3t', 'forge', '51HxYzAbCdEfGh']

test('representative secrets reach Claude through no lara-cc route: tools, commands and ask Claude buttons', async ($, on) => {
  const ran: string[][] = []
  const sent: string[] = []
  const history = `[2026-10-11 09:00:00] local.ERROR: Login failed ${LEAKY} {"exception":"x"}\n`
  const exception = `RuntimeException: ${LEAKY} in /app/app/Jobs/Charge.php:12\n#0 /app/app/Jobs/Charge.php(3): App\\Jobs\\Charge->pay('hunter2')`
  const snapshot = { connection: 'redis', sizes: { default: 0 }, failedTotal: 1, failed: [{ id: 'f-1', queue: 'default', job: 'App\\Jobs\\Charge', failedAt: '2026-10-11 09:00:01', exception }] }
  const clock = fakeProject(on, ran, { history, snapshot, hold: ['queue:work'], says: LEAKY, tests: FAILING.replace('jane@example.com', LEAKY) })
  on('ui.open', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const outputs: Record<string, unknown> = {
    'logs tool': await $.tool.call({ tool: 'mcp__lara-cc__logs' }),
    '/lara-logs': await $.command.run({ command: 'lara-logs', args: 'errors' }),
    'queue tool, failed': await $.tool.call({ tool: 'mcp__lara-cc__queue', action: 'failed' }),
    '/lara-queue failed': await $.command.run({ command: 'lara-queue', args: 'failed' }),
    'artisan tool output': await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'make:model Post' }),
    "artisan tool, a name artisan can't resolve": await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'nosuch:thing' }),
    '/lara-artisan output': await $.command.run({ command: 'lara-artisan', args: 'make:model Post', origin: { kind: 'composer' } } as never),
    '/lara-test': await $.command.run({ command: 'lara-test', args: '' }),
  }
  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'start' })
  await clock.settle()
  outputs['service tool, logs'] = await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'logs' })

  // The ask Claude buttons send the person's message: the log error, the failed job, the failing test
  const pane = await mountPane($)
  await pane.press({ key: 'tab-log' })
  await pane.press({ key: 'ask-error' })
  await pane.press({ key: 'tab-queue' })
  await pane.press({ key: 'ask-f-1' })
  await pane.press({ key: 'tab-tests' })
  await pane.press({ key: 'ask-test-0' })
  await clock.settle()
  expect(sent.length).toBe(3)
  sent.forEach((text, i) => (outputs[`ask Claude ${i + 1}`] = text))

  for (const [route, output] of Object.entries(outputs)) {
    const text = JSON.stringify(output)
    for (const secret of LEAKED) expect({ route, leaked: text.includes(secret) ? secret : undefined }).toEqual({ route, leaked: undefined })
  }
  // Still what Claude needs: the error and where
  expect(JSON.stringify(outputs['logs tool'])).toContain('Login failed')
  expect(JSON.stringify(outputs['queue tool, failed'])).toContain('RuntimeException')
})

test("the queue state's error reaches Claude redacted", async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran, { snapshot: `PDOException: could not connect to ${LEAKY}` })
  await $.session.start({ cwd: '/app' })

  const status = JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__queue', action: 'status' }))
  expect(status).toContain('PDOException')
  for (const secret of LEAKED) expect(status).not.toContain(secret)
})

test('with nobody to answer (claude -p), logs, failed jobs and Boost logs are not sent', async ($, on) => {
  const ran: string[][] = []
  const history = `[2026-10-11 09:00:00] local.ERROR: Login failed ${LEAKY} {"exception":"x"}\n`
  const snapshot = { connection: 'redis', sizes: {}, failedTotal: 1, failed: [{ id: 'f-1', queue: 'default', job: 'App\\Jobs\\Charge', failedAt: 'x', exception: 'RuntimeException: boom' }] }
  const clock = fakeProject(on, ran, { history, snapshot, share: null, files: { 'composer.json': '{"require-dev":{"laravel/boost":"^1.0"}}' } })
  let boostRan = false
  on('tool.call', { tool: 'mcp__laravel-boost__last-error' }, () => {
    boostRan = true
    return { result: 'Login failed' } as never
  })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  for (const output of [
    await $.tool.call({ tool: 'mcp__lara-cc__logs' }),
    await $.command.run({ command: 'lara-logs', args: '' }),
    await $.tool.call({ tool: 'mcp__lara-cc__queue', action: 'failed' }),
    await $.tool.call({ tool: 'mcp__laravel-boost__last-error' } as never),
  ]) {
    const text = JSON.stringify(output)
    expect(text).toContain('chose not to send')
    expect(text).not.toContain('Login failed')
    expect(text).not.toContain('RuntimeException')
  }
  expect(boostRan).toBe(false)
})

test("Claude's artisan tool asks before commands that reach past the folder, saying where they land, and runs nothing on no", async ($, on) => {
  const ran: string[][] = []
  const asked: string[] = []
  const connections = [{ use: 'database', driver: 'mysql', port: 3306 }]
  const fake: Fake = { asked, connections, run: "Don't run" }
  const clock = fakeProject(on, ran, fake)
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const refused = JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'migrate' }))
  expect(refused).toContain('chose not to run')
  expect(ran.some(argv => argv.join(' ').startsWith('php artisan migrate --no-interaction'))).toBe(false)
  expect(asked.at(-1)).toContain('php artisan migrate, which changes the database schema')
  expect(asked.at(-1)).toContain('APP_ENV is local')
  expect(asked.at(-1)).toContain('database mysql:3306')

  // Nobody there to answer is no too
  fake.run = null
  await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'migrate' })
  expect(ran.some(argv => argv.join(' ').startsWith('php artisan migrate --no-interaction'))).toBe(false)

  fake.run = 'Run it'
  await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'migrate' })
  expect(ran.some(argv => argv.join(' ').startsWith('php artisan migrate --no-interaction'))).toBe(true)

  // Files in the folder only: no question
  const before = asked.length
  await $.tool.call({ tool: 'mcp__lara-cc__artisan', command: 'make:model Post' })
  expect(asked.length).toBe(before)
})

test('retrying failed jobs and starting a worker ask when Claude does it, not when the person types or presses', async ($, on) => {
  const ran: string[][] = []
  const spawned: string[][] = []
  const asked: string[] = []
  const snapshot = { connection: 'redis', sizes: {}, failedTotal: 7, failed: [] }
  const fake: Fake = { asked, snapshot, spawned, run: "Don't run" }
  fakeProject(on, ran, fake)
  await $.session.start({ cwd: '/app' })
  const retries = () => ran.filter(argv => argv[2] === 'queue:retry').length

  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__lara-cc__queue', action: 'retry', id: 'all' }))).toContain('chose not to run')
  expect(asked.at(-1)).toContain('queue:retry all (7 failed jobs)')
  await $.command.run({ command: 'lara-queue', args: 'retry all' })
  expect(retries()).toBe(0)

  // Typed by the person: no question
  const before = asked.length
  await $.command.run({ command: 'lara-queue', args: 'retry all', origin: { kind: 'composer' } } as never)
  expect(retries()).toBe(1)
  expect(asked.length).toBe(before)

  // The worker and the scheduler run jobs and tasks; Vite doesn't
  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'start' })
  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'schedule', action: 'restart' })
  expect(spawned.some(argv => argv.includes('queue:work') || argv.includes('schedule:work'))).toBe(false)
  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'vite', action: 'start' })
  expect(spawned.some(argv => argv.includes('dev'))).toBe(true)
})

test('restarting a worker the person started needs no question, so Claude can reload job code', async ($, on) => {
  const ran: string[][] = []
  const spawned: string[][] = []
  const asked: string[] = []
  fakeProject(on, ran, { asked, spawned, hold: ['queue:work'], run: "Don't run" })
  await $.session.start({ cwd: '/app' })
  await $.command.run({ command: 'lara-queue', args: 'start', origin: { kind: 'composer' } } as never)

  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'restart' })
  expect(spawned.filter(argv => argv.includes('queue:work')).length).toBe(2)
  expect(asked.length).toBe(0)
})

test('/lara-composer and /lara-npm ask when the person did not type them', async ($, on) => {
  const ran: string[][] = []
  const asked: string[] = []
  fakeProject(on, ran, { asked, run: "Don't run" })
  await $.session.start({ cwd: '/app' })

  expect((await $.command.run({ command: 'lara-composer', args: 'require evil/pkg' })).text).toContain('chose not to run')
  expect((await $.command.run({ command: 'lara-npm', args: 'build' })).text).toContain('chose not to run')
  expect(ran.some(argv => argv.includes('evil/pkg') || argv.join(' ') === 'pnpm run build')).toBe(false)
  expect(asked.length).toBe(2)

  await $.command.run({ command: 'lara-composer', args: 'require laravel/pail', origin: { kind: 'composer' } } as never)
  expect(ran.some(argv => argv.includes('laravel/pail'))).toBe(true)
  expect(asked.length).toBe(2)
})

async function mountPane($: Engine) {
  return $.ui.mount({
    plugin: 'lara-cc',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'lara',
    props: { title: 'lara-cc', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
  })
}

async function mountBand($: Engine, bodyColumns = 200) {
  return $.ui.mount({
    plugin: 'lara-cc',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns } as never,
  })
}

test('band fixes run on a press: up for maintenance, only the caches that exist, never optimize:clear', async ($, on) => {
  const ran: string[][] = []
  const files = { 'storage/framework/down': '{}', 'bootstrap/cache/config.php': '<?php', 'bootstrap/cache/routes-v7.php': '<?php' }
  const clock = fakeProject(on, ran, { files })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const band = await mountBand($)
  expect(ran.some(argv => argv.includes('up') || argv.includes('config:clear'))).toBe(false)
  await band.press({ key: 'fix-up' })
  await band.press({ key: 'fix-clear' })
  await clock.settle()
  expect(ran).toContainEqual(['php', 'artisan', 'up', '--no-interaction'])
  expect(ran).toContainEqual(['php', 'artisan', 'config:clear', '--no-interaction'])
  expect(ran).toContainEqual(['php', 'artisan', 'route:clear', '--no-interaction'])
  expect(ran.some(argv => argv.includes('event:clear') || argv.includes('optimize:clear') || argv.includes('cache:clear'))).toBe(false)
})

test('a narrow band drops the fix buttons before folding the warnings', async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran, { files: { 'storage/framework/down': '{}' } })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const narrow = JSON.stringify(await (await mountBand($, 34)).drawn())
  expect(narrow).toContain('maintenance mode')
  expect(narrow).not.toContain('fix-up')
})

test('jobs waiting with no worker show in the band with a start button; a draining queue does not', async ($, on) => {
  const ran: string[][] = []
  const spawned: string[][] = []
  const snapshot = { connection: 'database', sizes: { default: 3, emails: 0 }, failedTotal: 0, failed: [] }
  const fake = { snapshot, spawned }
  const clock = fakeProject(on, ran, fake)
  on('ui.open', () => ({ value: undefined }))
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const band = await mountBand($)
  expect(JSON.stringify(await band.drawn())).toContain('3 jobs waiting, no worker')
  await band.press({ key: 'fix-start worker' })
  await clock.settle()
  expect(spawned.some(argv => argv.includes('queue:work'))).toBe(true)
  await $.tool.call({ tool: 'mcp__lara-cc__service', name: 'queue', action: 'stop' })

  // A worker elsewhere drains it: fewer than last time
  fake.snapshot = { ...snapshot, sizes: { default: 1, emails: 0 } }
  await $.command.run({ command: 'lara-queue', args: 'status' })
  await clock.settle()
  expect(JSON.stringify(await band.drawn())).not.toContain('waiting, no worker')
})

const FAILING = String.raw`
   FAILED  Tests\Feature\OrderTest > it creates an order
  Expected response status code [201] but received 500 for jane@example.com.

  at tests/Feature/OrderTest.php:19

  Tests:    1 failed, 4 passed (9 assertions)
`

test('a failing test run shows in the band and the Tests tab, and goes to Claude redacted', async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran, { tests: FAILING })
  on('ui.open', () => ({ value: undefined }))
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/app' })
  await $.command.run({ command: 'lara-test', args: '' })
  await clock.settle()

  expect(JSON.stringify(await (await mountBand($)).drawn())).toContain('✗ 1 test failing')
  const pane = await mountPane($)
  await pane.press({ key: 'tab-tests' })
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('✗ 1 failed, 4 passed')
  expect(drawn).toContain('it creates an order')
  await pane.press({ key: 'ask-test-0' })
  expect(sent[0]).toContain('Tests\\Feature\\OrderTest > it creates an order')
  expect(sent[0]).toContain('[email]')
  expect(sent[0]).not.toContain('jane@example.com')
})

test('tests Claude runs through Bash show too', async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran)
  let bashRuns = 0
  on('tool.call', { tool: 'Bash' }, () => {
    bashRuns++
    return { result: { stdout: 'OK (12 tests, 30 assertions)', stderr: '', interrupted: false } } as never
  })
  on('ui.open', () => ({ value: undefined }))
  await $.session.start({ cwd: '/app' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'vendor/bin/phpunit' } as never)
  // The band shows a passing run only next to something else; the Tests tab always does
  const pane = await mountPane($)
  await pane.press({ key: 'tab-tests' })
  expect(JSON.stringify(await pane.drawn())).toContain('✓ 12 passed')
  expect(bashRuns).toBe(1)
})

test("Boost's log tools ask first and are redacted; its tinker output is redacted", async ($, on) => {
  const ran: string[][] = []
  const asked: string[] = []
  const fake: Parameters<typeof fakeProject>[2] = { asked, share: "Don't send" }
  const clock = fakeProject(on, ran, fake)
  let boostRan = 0
  on('tool.call', { tool: ['mcp__laravel-boost__read-log-entries', 'mcp__laravel-boost__tinker'] }, () => {
    boostRan++
    return { result: 'login failed password=hunter2 for jane@example.com' } as never
  })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const declined = JSON.stringify(await $.tool.call({ tool: 'mcp__laravel-boost__read-log-entries', entries: 5 } as never))
  expect(declined).toContain('chose not to send')
  expect(boostRan).toBe(0)
  fake.share = 'Send redacted'
  const sent = JSON.stringify(await $.tool.call({ tool: 'mcp__laravel-boost__read-log-entries', entries: 5 } as never))
  expect(sent).toContain('password=[redacted] for [email]')
  const tinker = JSON.stringify(await $.tool.call({ tool: 'mcp__laravel-boost__tinker', code: 'User::first()' } as never))
  expect(tinker).not.toContain('hunter2')
})

test("Herd's debug session starts and stops on a press, and goes to Claude only when asked, withheld and redacted", async ($, on) => {
  const ran: string[][] = []
  const asked: string[] = []
  const debug = JSON.stringify({ queries: [{ sql: 'select * from users where email = ?', bindings: ['jane@example.com'] }], logs: [{ message: 'hi' }] })
  const clock = fakeProject(on, ran, { herdServices: [MYSQL], asked, debug })
  on('ui.open', () => ({ value: undefined }))
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const pane = await mountPane($)
  await pane.press({ key: 'tab-services' })
  await pane.press({ key: 'herd-debug' })
  await clock.settle()
  expect(ran).toContainEqual(['osascript', '-e', 'tell application "Herd" to dumps start debug'])
  await pane.press({ key: 'herd-debug' })
  await clock.settle()
  expect(JSON.stringify(await pane.drawn())).toContain('1 queries, 1 logs')
  expect(sent.length).toBe(0)

  await pane.press({ key: 'debug-ask' })
  expect(asked.at(-1)).toContain('debug session')
  expect(sent[0]).toContain('"bindings": "[redacted]"')
  expect(sent[0]).not.toContain('jane@example.com')
})

test("Boost's get-config refuses keys that can hold secrets and redacts the rest", async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran)
  const read: string[] = []
  on('tool.call', { tool: 'mcp__laravel-boost__get-config' }, ($, e) => {
    read.push(String((e as unknown as { key: string }).key))
    return { result: '{"key":"mail.from.address","value":"jane@example.com"}' } as never
  })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  for (const key of ['app.key', 'database.connections.mysql.password', 'services.stripe.secret', 'database.redis.default.url']) {
    expect(JSON.stringify(await $.tool.call({ tool: 'mcp__laravel-boost__get-config', key } as never))).toContain('refused')
  }
  expect(read).toEqual([])
  const fine = JSON.stringify(await $.tool.call({ tool: 'mcp__laravel-boost__get-config', key: 'mail.from.address' } as never))
  expect(fine).toContain('[email]')
  expect(read).toEqual(['mail.from.address'])
})

test('the band migrate fix runs migrate and counts the pending migrations again', async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran, { pending: 2 })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const band = await mountBand($)
  expect(JSON.stringify(await band.drawn())).toContain('2 pending migrations')
  await band.press({ key: 'fix-migrate' })
  await clock.settle()
  expect(ran).toContainEqual(['php', 'artisan', 'migrate', '--no-interaction'])
  expect(JSON.stringify(await band.drawn())).not.toContain('pending migration')
})

test('the Routes tab: rows are buttons the arrows walk, and Enter opens the code or the page, asking which', async ($, on) => {
  const ran: string[][] = []
  const fake: Fake = { answers: [], asked: [], editor: 'phpstorm' }
  const clock = fakeProject(on, ran, fake)
  on('ui.open', () => ({ value: undefined }))
  // The engine's end of the focus ring: the move lands
  on('ui.focus', () => ({}))
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const pane = await mountPane($)
  await pane.press({ key: 'tab-routes' })
  await clock.settle()
  const rows = async () => (await pane.findAll({ type: 'Button' })).filter(b => /^route-\d+$/.test(String(b.key)))
  expect(await rows()).toHaveLength(6)
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('users.index')
  // One PHP boot for the list and where the code is; a route's domain never reaches the mod
  expect(ran.some(argv => argv.join(' ') === 'php artisan route:list --json')).toBe(false)
  expect(drawn).not.toContain('example')

  // GET /users: asked, then the file opens at its line in the editor the app names
  fake.answers!.push('Open UserController.php:12')
  await pane.press({ key: 'route-2' })
  expect(fake.asked).toContain('GET /users: open its code or its page?')
  expect(ran).toContainEqual(['open', 'phpstorm://open?file=/app/app/Http/Controllers/UserController.php&line=12'])

  // ...or the page: PHP finds the route by its id and builds the URL; the mod hands over no URL
  fake.answers!.push('Open in browser')
  await pane.press({ key: 'route-2' })
  expect(ran.find(argv => argv[2]?.includes('proc_open'))!.slice(3)).toEqual(['--', '1', 'GET|HEAD', 'users', '{}'])

  // A parameter's value is asked for; Cancel, or no value, opens nothing
  fake.answers!.push('Open in browser', '42')
  await pane.press({ key: 'route-3' })
  expect(fake.asked).toContain('Value for {user} in GET /users/{user}?')
  expect(ran.filter(argv => argv[2]?.includes('proc_open')).at(-1)!.slice(3)).toEqual(['--', '3', 'GET|HEAD', 'users/{user}', '{"user":"42"}'])
  const opened = ran.length
  fake.answers!.push('Open in browser', 'Cancel', 'Open in browser', '  ')
  await pane.press({ key: 'route-3' })
  await pane.press({ key: 'route-3' })
  expect(ran.slice(opened).some(argv => argv[2]?.includes('proc_open'))).toBe(false)

  // POST has no page, so Enter opens the file without asking
  const questions = fake.asked!.length
  await pane.press({ key: 'route-1' })
  expect(fake.asked).toHaveLength(questions)
  expect(ran).toContainEqual(['open', 'phpstorm://open?file=/app/app/Http/Controllers/PostController.php&line=20'])

  // An arrow press landing the ring on a row selects it: the line under the list says where Enter goes
  await $.ui.focus({ component: 'Pane', requestId: 'lara', plugin: 'lara-cc', element: 'route-1', origin: { kind: 'person' } } as never)
  expect(JSON.stringify(await pane.drawn())).toContain('→ app/Http/Controllers/PostController.php:20')
  // Where the arrows scroll the pane instead, the selection moves with them; End goes to the last route
  const scroll = (by: number) => $.ui.scroll({ component: 'Pane', requestId: 'lara', offset: 0, by, bodyRows: 30, contentRows: 14, origin: { kind: 'person' } } as never)
  await scroll(3)
  expect(JSON.stringify(await pane.drawn())).toContain('(on its own domain)')
  await scroll(14)
  expect(JSON.stringify(await pane.drawn())).toContain('→ app/Http/Controllers/WebhookController.php:7')

  // The filter narrows the rows, matching the method as shown
  await pane.input({ key: 'route-filter', text: 'posts', kind: 'change' })
  expect(await rows()).toHaveLength(1)
  await pane.input({ key: 'route-filter', text: 'any', kind: 'change' })
  expect(await rows()).toHaveLength(1)
  await pane.input({ key: 'route-filter', text: 'head', kind: 'change' })
  expect(await rows()).toHaveLength(0)
})

test('Routes tab rows fit a narrow, short pane: one line each, and only as many as fit', async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran)
  on('ui.open', () => ({ value: undefined }))
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const pane = await $.ui.mount({
    plugin: 'lara-cc',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'lara',
    props: { title: 'lara-cc', isFocused: true, bodyColumns: 36, placement: 'dock', scroll: { offset: 0, bodyRows: 12 } } as never,
  })
  await pane.press({ key: 'tab-routes' })
  await clock.settle()
  // A row's text is its Text children, in order
  const textOf = (node: unknown): string =>
    typeof node === 'string' ? node : ((node as { children?: unknown[] })?.children ?? []).map(textOf).join('')
  const found: { props?: { key?: string } }[] = []
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const el = node as { type?: string; props?: { key?: string }; children?: unknown[] }
    if (el.type === 'Button' && /^route-\d+$/.test(String(el.props?.key))) found.push(el)
    for (const child of el.children ?? []) walk(child)
  }
  walk(await pane.drawn())
  expect(found.length).toBeGreaterThan(0)
  // 12 rows: the header (3 at 36 columns), a blank, the filter, the summary (3), the selected route's line, a spare
  expect(found.length).toBeLessThanOrEqual(12 - 10)
  for (const row of found) expect(textOf(row).length).toBeLessThanOrEqual(36)
})

test('without an editor, a route file opens as a plain file', async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran, { answers: ['Open UserController.php:12'] })
  on('ui.open', () => ({ value: undefined }))
  await $.session.start({ cwd: '/app' })
  await clock.settle()
  const pane = await mountPane($)
  await pane.press({ key: 'tab-routes' })
  await clock.settle()

  // No editor anywhere: macOS opens the file with whatever opens .php files
  await pane.press({ key: 'route-2' })
  expect(ran.filter(argv => argv[0] === 'open')).toEqual([['open', '/app/app/Http/Controllers/UserController.php']])
})

test("an editor link that doesn't open falls back to the plain file", async ($, on) => {
  const ran: string[][] = []
  const clock = fakeProject(on, ran, { answers: ['Open UserController.php:12'], editor: 'phpstorm', noEditor: true })
  on('ui.open', () => ({ value: undefined }))
  await $.session.start({ cwd: '/app' })
  await clock.settle()
  const pane = await mountPane($)
  await pane.press({ key: 'tab-routes' })
  await clock.settle()

  await pane.press({ key: 'route-2' })
  expect(ran.filter(argv => argv[0] === 'open').map(argv => argv[1])).toEqual([
    'phpstorm://open?file=/app/app/Http/Controllers/UserController.php&line=12',
    '/app/app/Http/Controllers/UserController.php',
  ])
})
