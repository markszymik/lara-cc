import { expect, test } from 'claude-code/testing'

import {
  artisanCommandName,
  composerDrift,
  durationMs,
  exceptionHeadline,
  feedLog,
  formatEntry,
  headline,
  helpName,
  isError,
  localHotUrl,
  newLogState,
  npmDrift,
  origin,
  parseSnapshot,
  parseWorkerLine,
  projectPath,
  queuesOf,
  refusedOptions,
  shortClass,
} from '../hooks/parse'
import { LOG } from './fixtures'


test('feedLog groups multi-line entries and keeps partial lines for the next chunk', () => {
  const state = newLogState()
  const half = LOG.indexOf('#1 ')
  const first = feedLog(state, LOG.slice(0, half))
  const second = feedLog(state, LOG.slice(half))
  expect(first.map(e => e.level)).toEqual(['INFO', 'WARNING', 'ERROR'])
  expect(second).toEqual([])
  const error = state.entries[2]!
  expect(isError(error)).toBe(true)
  expect(error.detail.some(l => l.includes('OrderController.php(42)'))).toBe(true)
})

test('headline drops the JSON context, origin points at the app frame, not vendor', () => {
  const state = newLogState()
  feedLog(state, LOG)
  const error = state.entries[2]!
  expect(headline(error)).toBe('Call to undefined method App\\Models\\Order::total()')
  expect(headline(state.entries[1]!)).toBe('Cache miss for key orders:1')
  expect(origin(error)).toBe('app/Http/Controllers/OrderController.php:42')
  expect(formatEntry(error)).toContain('at app/Http/Controllers/OrderController.php:42')
  expect(formatEntry(error)).toContain('#1 ')
  // With the real project root, paths are relative to it, even when it's called /app
  expect(origin(error, '/Users/mark/Sites/shop')).toBe('app/Http/Controllers/OrderController.php:42')
  expect(formatEntry(error, 15, '/Users/mark/Sites/shop')).toContain('#1 app/Http/Controllers/OrderController.php(42)')
  expect(projectPath('/app/app/Models/User.php', '/app')).toBe('app/Models/User.php')
})

test('parseWorkerLine reads queue:work output', () => {
  expect(parseWorkerLine('  2026-10-10 08:01:02 App\\Jobs\\SendInvoice .................... RUNNING')).toEqual({
    time: '2026-10-10 08:01:02',
    job: 'App\\Jobs\\SendInvoice',
    status: 'RUNNING',
    duration: undefined,
  })
  expect(parseWorkerLine('  2026-10-10 08:01:02 App\\Jobs\\SendInvoice ............... 23.45ms DONE')?.duration).toBe('23.45ms')
  expect(parseWorkerLine('\u001b[2m  2026-10-10 08:01:03 App\\Jobs\\ChargeCard ......\u001b[22m 1.2s \u001b[31;1mFAIL\u001b[39;22m')?.status).toBe('FAIL')
  expect(parseWorkerLine('   INFO  Processing jobs from the [default] queue.')).toBe(undefined)
  expect(durationMs('23.45ms')).toBe(23.45)
  expect(durationMs('1.2s')).toBe(1200)
})

test('small helpers', () => {
  expect(shortClass('App\\Jobs\\SendInvoice')).toBe('SendInvoice')
  expect(queuesOf(['php', 'artisan', 'queue:work', '--queue=high,default'])).toEqual(['high', 'default'])
  expect(exceptionHeadline('RuntimeException: Payment gateway down in /app/Jobs/Charge.php:12\nStack trace:')).toBe(
    'RuntimeException: Payment gateway down in /app/Jobs/Charge.php:12',
  )
  expect(parseSnapshot('PHP Warning: x\n{"connection":"redis","sizes":{"default":3},"failedTotal":0,"failed":[]}')?.sizes).toEqual({ default: 3 })
  expect(parseSnapshot('Fatal error')).toBe(undefined)
})

test('artisanCommandName skips options to find the command, as artisan does', () => {
  expect(artisanCommandName(['migrate:fresh', '--seed'])).toBe('migrate:fresh')
  expect(artisanCommandName(['-q', '--ansi', 'migrate:fresh'])).toBe('migrate:fresh')
  expect(artisanCommandName(['--', 'db:wipe'])).toBe('db:wipe')
  expect(artisanCommandName(['--version'])).toBe(undefined)
})

test('refusedOptions finds long options with or without a value, and short ones in a group', () => {
  const refused = ['--force', '-f', '--env']
  expect(refusedOptions(['migrate', '--force'], refused)).toEqual(['--force'])
  expect(refusedOptions(['migrate', '--env=production'], refused)).toEqual(['--env=production'])
  expect(refusedOptions(['make:model', 'Post', '-mf'], refused)).toEqual(['-mf'])
  expect(refusedOptions(['make:model', 'Post', '-m', '--forced-thing'], refused)).toEqual([])
})

test('helpName reads the resolved name from artisan help JSON, after any PHP warnings', () => {
  expect(helpName('{"name":"migrate:fresh","description":"Drop all tables"}')).toBe('migrate:fresh')
  expect(helpName('PHP Deprecated: x\n{"name":"down"}')).toBe('down')
  expect(helpName('ERROR  Command "mi" is ambiguous.')).toBe(undefined)
})

test('composerDrift lists packages that differ from composer.lock', () => {
  const lock = JSON.stringify({ packages: [{ name: 'a/one', version: '1.0.0' }, { name: 'a/two', version: '2.0.0' }], 'packages-dev': [{ name: 'a/dev', version: '1.0.0' }] })
  const same = JSON.stringify({ packages: [{ name: 'a/one', version: '1.0.0' }, { name: 'a/two', version: '2.0.0' }, { name: 'a/dev', version: '1.0.0' }], dev: true })
  expect(composerDrift(lock, same)).toEqual([])
  const changed = JSON.stringify({ packages: [{ name: 'a/one', version: '0.9.0' }, { name: 'a/gone', version: '1.0.0' }, { name: 'a/dev', version: '1.0.0' }], dev: true })
  expect(composerDrift(lock, changed)).toEqual(['a/gone', 'a/one', 'a/two'])
  // --no-dev leaves dev packages out on purpose; Composer 1 wrote a plain list
  expect(composerDrift(lock, JSON.stringify({ packages: [{ name: 'a/one', version: '1.0.0' }, { name: 'a/two', version: '2.0.0' }], dev: false }))).toEqual([])
  expect(composerDrift(lock, JSON.stringify([{ name: 'a/one', version: '1.0.0' }, { name: 'a/two', version: '2.0.0' }, { name: 'a/dev', version: '1.0.0' }]))).toEqual([])
})

test('npmDrift compares package-lock.json with what npm installed, ignoring optional packages for other platforms', () => {
  const lock = JSON.stringify({
    packages: {
      '': { name: 'app' },
      'node_modules/vite': { version: '6.0.0' },
      'node_modules/@esbuild/linux-x64': { version: '0.24.0', optional: true },
      'node_modules/axios': { version: '1.7.0' },
    },
  })
  const same = JSON.stringify({ packages: { 'node_modules/vite': { version: '6.0.0' }, 'node_modules/axios': { version: '1.7.0' } } })
  expect(npmDrift(lock, same)).toEqual([])
  const changed = JSON.stringify({ packages: { 'node_modules/vite': { version: '5.4.0' }, 'node_modules/left-pad': { version: '1.0.0' } } })
  expect(npmDrift(lock, changed)).toEqual(['axios', 'left-pad', 'vite'])
})

test('npmDrift accepts --omit=dev installs, workspace packages and dev-only optional packages', () => {
  const lock = JSON.stringify({
    packages: {
      '': { name: 'app' },
      'packages/ui': { version: '1.0.0' },
      'node_modules/ui': { link: true },
      'node_modules/axios': { version: '1.7.0' },
      'node_modules/vite': { version: '6.0.0', dev: true },
      'node_modules/fsevents': { version: '2.3.3', dev: true, devOptional: true },
    },
  })
  const prodOnly = JSON.stringify({ packages: { 'node_modules/ui': { link: true }, 'node_modules/axios': { version: '1.7.0' } } })
  expect(npmDrift(lock, prodOnly)).toEqual([])
  // With dev packages installed, a missing one still counts
  const partial = JSON.stringify({ packages: { 'node_modules/ui': {}, 'node_modules/axios': { version: '1.7.0' }, 'node_modules/fsevents': { version: '2.3.3' } } })
  expect(npmDrift(lock, partial)).toEqual(['vite'])
})

test('localHotUrl accepts only dev servers on this machine', () => {
  expect(localHotUrl('http://[::1]:5173\n')).toBe('http://[::1]:5173')
  expect(localHotUrl('http://localhost:5173')).toBe('http://localhost:5173')
  expect(localHotUrl('https://shop.test:5173/some/path')).toBe('https://shop.test:5173')
  expect(localHotUrl('http://example.com:5173')).toBe(undefined)
  expect(localHotUrl('file:///etc/passwd')).toBe(undefined)
  expect(localHotUrl('not a url')).toBe(undefined)
})
