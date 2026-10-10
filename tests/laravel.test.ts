import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LOG } from './fixtures'

/** Stand in for a Laravel project on disk and for php/npm, so no real process runs.
 * Background work at start (log tail, migrate:status, queue snapshot) also lands in `ran`. */
type Fake = { history?: string; live?: string; snapshot?: unknown }

function fakeProject(on: On, ran: string[][], fake: Fake = {}) {
  mock.store(on)
  const clock = mock.clock(on)
  on('fs.exists', ($, e) => ({ value: ['artisan', 'composer.json', 'pnpm-lock.yaml'].some(f => e.path === f || e.path.endsWith('/' + f)) }))
  on('session.start', ($, e) => e)
  on('fs.read', () => ({ value: '{"require":{"laravel/framework":"^12.0"}}' }))
  on('command.register', () => ({ value: {} }))
  on('tool.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/app' }))
  on('fs.list', () => ({ value: [] }))
  // tail -F of the log: a quiet stream that ends at once
  on('process.spawn', async function* ($, e) {
    if (e.argv[0] === 'tail' && fake.live) yield { stream: 'stdout' as const, text: fake.live }
    return { value: { code: 0, signal: null } }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'tail') return ok(fake.history ?? '')
    if (argv[0] === 'php' && argv[1] === '-r') return ok(fake.snapshot ? JSON.stringify(fake.snapshot) : 'no snapshot')
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

  const answer = await $.tool.call({ tool: 'mcp__laravel__artisan', command: 'migrate:fresh --seed' })
  expect(JSON.stringify(answer)).toContain('Refused')
  expect(ran.some(argv => argv.includes('migrate:fresh'))).toBe(false)
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
