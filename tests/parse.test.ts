import { expect, test } from 'claude-code/testing'

import {
  artisanCommandName,
  durationMs,
  exceptionHeadline,
  feedLog,
  formatEntry,
  headline,
  helpName,
  isError,
  newLogState,
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
