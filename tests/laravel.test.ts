import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/** Stand in for a Laravel project on disk and for php/npm, so no real process runs. */
function fakeProject(on: On, ran: string[][]) {
  on('fs.exists', ($, e) => ({ value: ['artisan', 'composer.json', 'pnpm-lock.yaml'].some(f => e.path === f || e.path.endsWith('/' + f)) }))
  on('session.start', ($, e) => e)
  on('fs.read', () => ({ value: '{"require":{"laravel/framework":"^12.0"}}' }))
  on('command.register', () => ({ value: {} }))
  on('tool.register', () => ({ value: {} }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    ran.push(argv)
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
}

test('/laravel-artisan runs php artisan with the arguments and returns clean output', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  const answer = await $.command.run({ command: 'laravel-artisan', args: 'make:model Post -m' })
  expect(ran.at(-1)).toEqual(['php', 'artisan', 'make:model', 'Post', '-m', '--no-interaction'])
  expect(answer.text).toContain('✓ artisan make:model Post -m')
  expect(answer.text).not.toContain('\u001b[')
})

test('/laravel-npm uses the package manager from the lockfile', async ($, on) => {
  const ran: string[][] = []
  fakeProject(on, ran)
  await $.session.start({ cwd: '/app' })

  await $.command.run({ command: 'laravel-npm', args: 'build' })
  expect(ran.at(-1)).toEqual(['pnpm', 'run', 'build'])
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
