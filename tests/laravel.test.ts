import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LOG } from './fixtures'

/** Stand in for a Laravel project on disk and for php/npm, so no real process runs.
 * Background work at start (log tail, migrate:status, queue snapshot) also lands in `ran`. */
/** `herd`: the binary `herd php` reports; `shellPhp`: what plain `php` reports; `composerShim`: Composer on PATH is a shell script. */
type Fake = { history?: string; live?: string; snapshot?: unknown; herd?: string; shellPhp?: string; composerShim?: boolean; spawned?: string[][] }

const COMPOSER = '/opt/bin/composer'
const HERD_BIN = '/Users/me/Library/Application Support/Herd/bin'
const HERD_CLI = HERD_BIN + '/herd'

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
  mock.store(on)
  const clock = mock.clock(on)
  on('fs.exists', ($, e) => ({
    value: ['artisan', 'composer.json', 'pnpm-lock.yaml'].some(f => e.path === f || e.path.endsWith('/' + f)) || [fake.herd, fake.shellPhp ?? '/usr/bin/php', COMPOSER, HERD_CLI].includes(e.path),
  }))
  on('session.start', ($, e) => e)
  on('fs.read', () => ({ value: '{"require":{"laravel/framework":"^12.0"}}' }))
  on('command.register', () => ({ value: {} }))
  on('tool.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/app' }))
  on('fs.list', () => ({ value: [] }))
  // tail -F of the log: a quiet stream that ends at once
  on('process.spawn', async function* ($, e) {
    fake.spawned?.push([...e.argv])
    if (e.argv[0] === 'tail' && fake.live) yield { stream: 'stdout' as const, text: fake.live }
    return { value: { code: 0, signal: null } }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'tail') return ok(fake.history ?? '')
    // Herd: which binary serves this folder, and Composer's path; without Herd there's no `herd` on PATH
    const missing = { value: { exitCode: 1, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'herd') return fake.herd ? ok(`${fake.herd}\n8.3.21`) : missing
    if (argv.join(' ') === 'which herd') return fake.herd ? ok(HERD_CLI) : missing
    if (argv.join(' ') === 'which composer') return ok(COMPOSER)
    if (argv[0] === 'php' && argv[2]?.includes('PHP_BINARY')) return ok(`${fake.shellPhp ?? '/usr/bin/php'}\n8.4.1`)
    if (argv[1] === COMPOSER && argv[2] === '--version') return ok(fake.composerShim ? '#!/usr/bin/env bash\nexec mise x -- composer "$@"' : 'Composer version 2.10.2')
    if (argv[0] === 'php' && argv[1] === '-r') return ok(fake.snapshot ? JSON.stringify(fake.snapshot) : 'no snapshot')
    // `artisan help <name>` resolves abbreviations and case the way Symfony does
    if (argv[2] === 'help') {
      const name = HELP[argv[3]!.toLowerCase()]
      if (!name) return { value: { exitCode: 1, stdout: `ERROR  Command "${argv[3]}" is not defined.`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      return ok(JSON.stringify({ name, description: '' }))
    }
    if (argv.join(' ') === 'php artisan route:list --json') {
      const routes = [
        { method: 'GET|HEAD', uri: '/', name: null, action: 'Closure' },
        { method: 'GET|HEAD', uri: 'users', name: 'users.index', action: 'App\\Http\\Controllers\\UserController@index' },
        { method: 'POST', uri: 'api/posts', name: 'posts.store', action: 'App\\Http\\Controllers\\PostController@store' },
      ]
      return { value: { exitCode: 0, stdout: JSON.stringify(routes), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: '\u001b[32mDONE\u001b[39m ' + argv.join(' '), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return clock
}

test('/laravel-artisan runs php artisan with the arguments and returns clean output', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.command.run({ command: 'laravel-artisan', args: 'make:model Post -m' })
  expect(ran.find(argv => argv[2] === 'make:model')).toEqual(['php', 'artisan', 'make:model', 'Post', '-m', '--no-interaction'])
  expect(answer.text).toContain('✓ artisan make:model Post -m')
  expect(answer.text).not.toContain('\u001b[')
})

test('/laravel-npm uses the package manager from the lockfile', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  await $.command.run({ command: 'laravel-npm', args: 'build' })
  expect(ran.find(argv => argv[1] === 'run')).toEqual(['pnpm', 'run', 'build'])
})

test('/laravel-routes filters the route list', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.command.run({ command: 'laravel-routes', args: 'posts' })
  expect(answer.text).toContain('1 of 3 routes')
  expect(answer.text).toContain('posts.store')
  expect(answer.text).not.toContain('users.index')
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
    const answer = await $.tool.call({ tool: 'mcp__laravel__artisan', command })
    expect(JSON.stringify(answer)).toContain('Refused')
    // at most the `help` lookup ran, never the command itself
    expect(ran.slice(before).filter(argv => argv[2] !== 'help')).toEqual([])
  }
})

test('the artisan tool runs safe commands once artisan has resolved the name', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.tool.call({ tool: 'mcp__laravel__artisan', command: 'make:model Post -m' })
  expect(JSON.stringify(answer)).toContain('✓ artisan make:model Post -m')
  expect(ran).toContainEqual(['php', 'artisan', 'help', 'make:model', '--format=json', '--no-interaction'])
  expect(ran).toContainEqual(['php', 'artisan', 'make:model', 'Post', '-m', '--no-interaction'])
})

test('the artisan tool does not run a name artisan cannot resolve', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.tool.call({ tool: 'mcp__laravel__artisan', command: 'nope:thing' })
  expect(JSON.stringify(answer)).toContain('could not resolve')
  expect(ran.some(argv => argv[2] === 'nope:thing')).toBe(false)
})

test('/laravel-artisan from a plugin or relayed message gets the same check', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.command.run({ command: 'laravel-artisan', args: 'migr:fr' })
  expect(answer.text).toContain('Refused: migrate:fresh can destroy data')
  expect(ran.some(argv => argv[2] === 'migr:fr')).toBe(false)
})

test('/laravel-schedule reports the scheduler', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.command.run({ command: 'laravel-schedule', args: '' })
  expect(answer.text).toBe('Scheduler is stopped.')
})

test('the logs tool returns errors from the history and the live tail, with origin', async ($, on) => {
  const ran: string[][] = []
  const split = LOG.indexOf('[2026-10-10 08:01:02]')
  const clock = fakeProject(on, ran, { history: LOG.slice(0, split), live: LOG.slice(split) })
  await $.session.start({ cwd: '/app' })
  await clock.settle()

  const all = await $.tool.call({ tool: 'mcp__laravel__logs', level: 'all', count: 10 })
  expect(JSON.stringify(all)).toContain('User 1 logged in')

  const errors = JSON.stringify(await $.tool.call({ tool: 'mcp__laravel__logs' }))
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

  const status = JSON.stringify(await $.tool.call({ tool: 'mcp__laravel__queue', action: 'status' }))
  expect(status).toContain('default=4')
  expect(status).toContain('Failed jobs stored: 1')

  const failed = JSON.stringify(await $.tool.call({ tool: 'mcp__laravel__queue', action: 'failed' }))
  expect(failed).toContain('abc-123')
  expect(failed).toContain('RuntimeException: Payment gateway down')

  await $.tool.call({ tool: 'mcp__laravel__queue', action: 'retry', id: 'abc-123' })
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
    // Nothing else draws in the band
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
    await $.session.start({ cwd: '/app' })
    await clock.settle()

    const band = await $.ui.mount({
      plugin: 'laravel',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 } as never,
    })
    const drawn = JSON.stringify(await band.drawn())
    expect(drawn).toContain('▲ 1 new error ')
    expect(drawn).toContain('1 failed job')

    const pane = await $.ui.mount({
      plugin: 'laravel',
      surface,
      component: 'Pane',
      requestId: 'laravel',
      props: { title: 'Laravel', isFocused: true, bodyColumns: 100, placement: 'dock' } as never,
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

  await $.tool.call({ tool: 'mcp__laravel__artisan', command: 'migrate' })
  expect(ran).toContainEqual([herd, 'artisan', 'help', 'migrate', '--format=json', '--no-interaction'])
  expect(ran).toContainEqual([herd, 'artisan', 'migrate', '--no-interaction'])

  await $.command.run({ command: 'laravel-composer', args: 'install' })
  expect(ran).toContainEqual([herd, COMPOSER, 'install', '--no-interaction'])

  const started = await $.tool.call({ tool: 'mcp__laravel__service', name: 'queue', action: 'start' })
  expect(spawned).toContainEqual([herd, 'artisan', 'queue:work', '--tries=1'])
  // Claude is told the binary that really runs, not `php`
  expect(JSON.stringify(started)).toContain('php83 artisan queue:work')
  expect(ran.some(argv => argv[0] === 'php' && argv[1] === 'artisan')).toBe(false)
})

test('with Herd installed but another php on PATH, the PATH php stays', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran, { herd: HERD_BIN + '/php83', shellPhp: '/opt/homebrew/bin/php' })
  await $.session.start({ cwd: '/app' })

  await $.tool.call({ tool: 'mcp__laravel__artisan', command: 'migrate' })
  expect(ran).toContainEqual(['php', 'artisan', 'migrate', '--no-interaction'])
  await $.command.run({ command: 'laravel-composer', args: 'install' })
  expect(ran).toContainEqual(['composer', 'install', '--no-interaction'])
})

test('with Herd, a Composer that is a shell shim runs as is, not through PHP', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran, { herd: HERD_BIN + '/php83', shellPhp: HERD_BIN + '/php84', composerShim: true })
  await $.session.start({ cwd: '/app' })

  await $.command.run({ command: 'laravel-composer', args: 'install' })
  expect(ran).toContainEqual(['composer', 'install', '--no-interaction'])
})

test('without Herd, php and composer come from PATH', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  await $.command.run({ command: 'laravel-composer', args: 'install' })
  expect(ran).toContainEqual(['composer', 'install', '--no-interaction'])
  expect(ran.some(argv => argv.join(' ') === 'which composer')).toBe(false)
})
