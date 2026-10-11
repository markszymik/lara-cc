import { expect, test } from 'claude-code/testing'

import {
  artisanCommandName,
  composerDrift,
  durationMs,
  editorHref,
  exceptionHeadline,
  feedLog,
  formatEntry,
  headline,
  helpName,
  herdNeeds,
  herdServices,
  isError,
  isTestCommand,
  localHotUrl,
  methodLabel,
  newLogState,
  npmDrift,
  origin,
  pageNotOpened,
  parseConnections,
  parseDebugCapture,
  parseRoutes,
  parseSnapshot,
  parseTestRun,
  parseWorkerLine,
  phpJson,
  aboutForClaude,
  parseRouteList,
  testsUseMemoryDb,
  clip,
  tail,
  redact,
  redactData,
  projectPath,
  queuesOf,
  refusedOptions,
  routesPhp,
  routeWindow,
  shortClass,
  terminalEditor,
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

test('herdServices keeps type, name, port and version, and drops entries it cannot use', () => {
  const plist = JSON.stringify([
    { type: 'mysql', name: 'MySQL', port: '3306', version: '8.4.11', autoStart: true, source: 'https://download.herdphp.com/x.zip' },
    { type: 'redis', name: 'Redis', port: 'nope', version: '7' },
    { type: '"; do shell script "x', name: 'odd', port: '1' },
  ])
  expect(herdServices(plist)).toEqual([{ type: 'mysql', name: 'MySQL', port: 3306, version: '8.4.11' }])
  expect(herdServices('not json')).toEqual([])
  expect(herdServices('{}')).toEqual([])
})

test('parseConnections reads the JSON after any PHP warnings, and drops malformed entries', () => {
  const out = 'Deprecated: something\n{"connections":[{"use":"database","driver":"mysql","port":3306},{"use":"cache","driver":"redis","port":"6379"}]}'
  expect(parseConnections(out)).toEqual([{ use: 'database', driver: 'mysql', port: 3306 }])
  expect(parseConnections('PHP Fatal error: nope')).toBe(undefined)
})

test('herdNeeds matches connections to Herd services by type and port', () => {
  const mysql = { type: 'mysql', name: 'MySQL', port: 3306, version: '8.4' }
  const maria = { type: 'mariadb', name: 'MariaDB', port: 3307, version: '11' }
  const redis = { type: 'redis', name: 'Redis', port: 6379, version: '7' }
  const connections = [
    { use: 'database', driver: 'mysql', port: 3307 },
    { use: 'cache', driver: 'redis', port: 6379 },
    { use: 'queue', driver: 'redis', port: 6379 },
    // a port no Herd service has, and a port with a service of another type
    { use: 'session', driver: 'redis', port: 6380 },
    { use: 'scout', driver: 'meilisearch', port: 3306 },
  ]
  expect(herdNeeds(connections, [mysql, maria, redis])).toEqual([
    { service: maria, driver: 'mysql', uses: ['database'] },
    { service: redis, driver: 'redis', uses: ['cache', 'queue'] },
  ])
})

test('redact hides secrets by name, in URLs and headers, emails and random keys', () => {
  expect(redact('login failed password=hunter2 user=7')).toBe('login failed password=[redacted] user=7')
  expect(redact('{"api_key":"abc123","name":"x"}')).toBe('{"api_key":[redacted],"name":"x"}')
  expect(redact("['client_secret' => 'shh', 'id' => 4]")).toBe("['client_secret' => [redacted], 'id' => 4]")
  expect(redact('Could not connect to redis://default:s3cret@127.0.0.1:6379')).toBe('Could not connect to redis://[redacted]@127.0.0.1:6379')
  expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toContain('[redacted]')
  expect(redact('Mail to jane.doe+x@example.co.uk bounced')).toBe('Mail to [email] bounced')
  expect(redact('key base64:Q2xhdWRlQ29kZUxhcmF2ZWxNb2RLZXkxMjM0NTY3OA== in use')).toBe('key base64:[redacted] in use')
  expect(redact('sha 3f786850e387550fdab836ed7e6dc881de23001b')).toBe('sha [redacted]')
})

/**
 * Common Laravel secrets, each with the parts that must never reach Claude. What surrounds them is kept, so
 * Claude can still read the error.
 */
const SECRETS: [string, string, string[]][] = [
  // .env-style lines
  ['env password', 'DB_PASSWORD=hunter2', ['hunter2']],
  ['env username', 'DB_USERNAME=forge_admin', ['forge_admin']],
  ['env quoted', 'MAIL_PASSWORD="pa ss word"', ['pa ss word', 'ss word']],
  ['APP_KEY with slashes', 'APP_KEY=base64:k3Y/9fQ+abcDEF/0123456789abcdefghiJKLmno=', ['k3Y', '0123456789abcdefghi']],
  ['bare base64 key', 'cipher key base64:k3Y/9fQ+abcDEF/0123456789abcdefghiJKLmno= rejected', ['k3Y', '0123456789abcdefghi']],
  ['AWS secret', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', ['wJalrXUtnFEMI', 'bPxRfiCYEXAMPLEKEY']],
  ['AWS key id, bare', 'InvalidAccessKeyId: AKIAIOSFODNN7EXAMPLE does not exist', ['AKIAIOSFODNN7EXAMPLE']],
  ['Stripe key, bare', 'charge with sk_live_51HxYzAbCdEfGhIjKl failed', ['51HxYzAbCdEfGhIjKl']],
  ['Slack token, bare', 'posting with xoxb-123456789012-abcdefABCDEF failed', ['123456789012-abcdefABCDEF']],
  ['Redis URL, password only', 'REDIS_URL=redis://:p%40ss@cache.internal:6379', ['p%40ss']],
  // Headers
  ['cookies', 'Cookie: laravel_session=eyJpdiI6IkV4YW1wbGUifQ%3D%3D; XSRF-TOKEN=abc123def', ['eyJpdiI6IkV4YW1wbGUifQ', 'abc123def']],
  ['set-cookie', 'Set-Cookie: remember_web_59ba=abcDEF123456; path=/', ['abcDEF123456']],
  ['API key header', 'X-Api-Key: live_abc123', ['live_abc123']],
  ['basic auth', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', ['dXNlcjpwYXNzd29yZA']],
  ['bearer', 'Authorization: Bearer abc.def.ghi1234', ['abc.def.ghi1234']],
  ['digest auth', 'Authorization: Digest username="bob", realm="app", nonce="dcd98b"', ['bob']],
  ['lower-case bearer', 'authorization: bearer abc.def.ghi1234', ['abc.def.ghi1234']],
  ['JWT, bare', 'decoding eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz failed', ['eyJzdWIiOiIxIn0', 'c2lnbmF0dXJlMTIz']],
  // Signed URLs
  ['signed route', 'GET /download?expires=1700000000&signature=4f9a6c0e1d2b3a4f5e6d7c8b9a', ['4f9a6c0e1d2b3a4f5e6d7c8b9a']],
  [
    'S3 presigned URL',
    'https://bucket.s3.amazonaws.com/f.pdf?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261011&X-Amz-Signature=abcdef0123456789&X-Amz-Security-Token=FwoGZXIvYXdzEJr',
    ['AKIAIOSFODNN7EXAMPLE', 'abcdef0123456789', 'FwoGZXIvYXdzEJr'],
  ],
  // DSNs
  ['database DSN', 'could not connect to mysql://forge:s3cr3t@db.internal:3306/app', ['forge', 's3cr3t']],
  ['password with @', 'could not connect to pgsql://app:p@ss@db:5432', ['p@ss', 'ss@db']],
  ['Sentry DSN', 'SENTRY_LARAVEL_DSN=https://e5b2a1c3d4@o123.ingest.sentry.io/456', ['e5b2a1c3d4']],
  ['DSN in a sentence', 'Sentry rejected https://e5b2a1c3d4@o123.ingest.sentry.io/456', ['e5b2a1c3d4']],
  // Database errors
  ['MySQL user', "SQLSTATE[HY000] [1045] Access denied for user 'forge'@'10.0.0.5' (using password: YES)", ['forge', '10.0.0.5']],
  ['Postgres user', 'SQLSTATE[08006] [7] FATAL:  password authentication failed for user "app_user"', ['app_user']],
  ['SQL update binding', 'SQLSTATE[22001]: Data too long (Connection: mysql, SQL: update `users` set `password` = $2y$10$abcdefghij where `id` = 1)', ['$2y$10$abcdefghij']],
  // Stack frames
  ['frame arguments', "#0 /app/app/Auth.php(10): App\\Auth->login('jane', 'hunter2')", ['hunter2', "'jane'"]],
  // JSON, nested and escaped
  ['nested JSON', '{"user":{"id":1,"credentials":{"password":"hunter2"}},"token":"tok_123"}', ['hunter2', 'tok_123']],
  ['escaped JSON', String.raw`{"payload":"{\"password\":\"hunter2\",\"api_token\":\"abc123\"}"}`, ['hunter2', 'abc123']],
  ['JSON with escapes in the value', String.raw`{"password":"hun\"ter2"}`, ['hun', 'ter2']],
  // PHP serialize() in queue payloads
  ['serialized', 's:8:"password";s:7:"hunter2";s:2:"id";i:4;', ['hunter2']],
  [
    'serialized in a JSON payload, protected property',
    String.raw`{"data":{"command":"O:17:\"App\\Jobs\\Charge\":2:{s:8:\"password\";s:7:\"hunter2\";s:8:\"\u0000*\u0000token\";s:6:\"tok123\";}"}}`,
    ['hunter2', 'tok123'],
  ],
  ['URL next to a secret key in JSON', '{"REDIS_URL":"redis://127.0.0.1:6379","REDIS_PASSWORD":"p@ssw0rdTail"}', ['p@ssw0rd', 'ssw0rdTail']],
  ['URL password with ; in it', 'mysql://forge:pa;ss@db.internal/app', ['forge', 'pa;ss']],
  ['URL password with brackets', 'redis://user:se(cret)@h', ['user', 'se(cret)']],
  ['upper-case scheme', 'Authorization: BEARER abcdefgh12345678', ['abcdefgh12345678']],
  ['long quoted key', '{"services_payment_gateway_production_merchant_api_key":"supersecretvalue"}', ['supersecretvalue']],
  ['serialized value with a quote in it', 's:8:"password";s:7:"ab"cdef";s:2:"id";i:4;', ['ab"cdef', 'cdef']],
  // Multi-line errors
  ['multi-line', "Login failed\npassword: hunter2\n#0 /app/a.php(3): auth('hunter2')", ['hunter2']],
]

for (const [name, input, secrets] of SECRETS) {
  test(`redact hides ${name}`, () => {
    const out = redact(input)
    for (const secret of secrets) expect(out).not.toContain(secret)
    expect(out).not.toBe(input)
  })
}

test('tail starts at a line near the cut, and keeps a long last line; clip never leaves only an ellipsis', () => {
  expect(tail('aaaa\npassword=hunter2\nbbbb', 18)).toBe('…\nbbbb')
  expect(tail('x'.repeat(9000) + ' important error here\nexit 1')).toContain('important error here\nexit 1')
  expect(tail('y'.repeat(9000)).length).toBe(8001)
  expect(tail('short', 10)).toBe('short')
  expect(clip('password: hunter2 and more', 12)).toBe('password:…')
  expect(clip('/very/long/path/' + 'a'.repeat(400) + ' rest', 300)).toMatch(/^\/very\/long\/path\/a+…$/)
  expect(clip('b'.repeat(400), 300)).toBe('b'.repeat(300) + '…')
})

test('redact stays fast on long words, which every log line and output passes through', () => {
  const started = Date.now()
  for (const text of ['s:9:"' + 'a'.repeat(30000) + '";', 'a'.repeat(30000), 'password'.repeat(4000), 'token ' + 'a'.repeat(30000)]) redact(text)
  expect(Date.now() - started).toBeLessThan(1000)
})

test("aboutForClaude shows versions, drivers and the environment, and nothing that isn't on its allow-list", () => {
  const json = JSON.stringify({
    environment: { application_name: 'Shop', laravel_version: '12.x-dev', php_version: '8.3.21', environment: 'local', debug_mode: true, url: 'shop.example.com', timezone: 'Europe/Warsaw' },
    drivers: { database: 'mysql', queue: 'redis', mail: 'smtp' },
    pulse: { dashboard: 'https://admin.example.com/pulse' },
    reverb: { host: '10.1.2.3', path: '/var/www/shop' },
  }).replace(/\//g, '\\/')
  const out = aboutForClaude('Deprecated: x\n' + json)!
  for (const kept of ['Shop', '12.x-dev', '8.3.21', 'local', 'true', 'Europe/Warsaw', 'mysql', 'redis', 'smtp']) expect(out).toContain(kept)
  for (const hidden of ['example.com', '10.1.2.3', '/var/www']) expect(out).not.toContain(hidden)
  expect(out).toContain('  url: [not shown]')
  expect(aboutForClaude('  ERROR  boom')).toBeUndefined()
})

test("parseRouteList reads route:list's JSON with whether a route has a domain, never the domain", () => {
  const json = JSON.stringify([
    { domain: null, method: 'GET|HEAD', uri: 'users', name: 'users.index', action: 'App\\Http\\Controllers\\UserController@index', middleware: ['web'] },
    { domain: '{account}.example.com', method: 'GET|HEAD', uri: 'team', name: null, action: 'Closure', middleware: [] },
  ])
  const routes = parseRouteList('Deprecated: x\n' + json)!
  expect(routes[1]).toEqual({ method: 'GET|HEAD', uri: 'team', name: null, action: 'Closure', onDomain: true, middleware: [] })
  expect(JSON.stringify(routes)).not.toContain('example.com')
  expect(parseRouteList("  ERROR  Your application doesn't have any routes.")).toBeUndefined()
})

test('testsUseMemoryDb trusts only a live in-memory DB_DATABASE in phpunit.xml', () => {
  expect(testsUseMemoryDb('<php><env name="DB_CONNECTION" value="sqlite"/><env name="DB_DATABASE" value=":memory:"/></php>')).toBe(true)
  expect(testsUseMemoryDb('<php><!-- <env name="DB_DATABASE" value=":memory:"/> --></php>')).toBe(false)
  expect(testsUseMemoryDb('<php><env name="DB_DATABASE" value="testing"/></php>')).toBe(false)
})

test('redact keeps what Claude needs to debug', () => {
  const kept = [
    'Undefined variable $order at app/Http/Controllers/OrderController.php:42',
    'Job 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d failed',
    'database/migrations/2024_01_01_000000_create_users_table.php',
    'The password field is required.',
    'Illuminate\\Database\\QueryException',
    'CSRF token mismatch.',
    'Basic authentication failed',
    'The token has expired.',
    'Token Mismatch',
    'Bearer token missing from the request',
  ]
  for (const line of kept) expect(redact(line)).toBe(line)
})

test('redact cuts SQL values and stack frame arguments', () => {
  const mysql =
    "SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry 'jane@example.com' for key 'users_email_unique' (Connection: mysql, SQL: insert into `users` (`email`, `name`) values (jane@example.com, Jane Doe))"
  expect(redact(mysql)).toBe(
    "SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry '?' for key 'users_email_unique' (Connection: mysql, SQL: insert into `users` (`email`, `name`) values …)",
  )
  const pgsql = 'SQLSTATE[23505]: Unique violation: 7 ERROR: duplicate key DETAIL: Key (email)=(jane@x.io) already exists. (Connection: pgsql, SQL: select * from "users" where "token" = abc limit 1)'
  expect(redact(pgsql)).toBe('SQLSTATE[23505]: Unique violation: 7 ERROR: duplicate key DETAIL: Key (email)=(?) already exists. (Connection: pgsql, SQL: select * from "users" where …)')
  expect(redact("#3 /app/app/Services/Pay.php(12): App\\Services\\Pay->charge('4242424242424242', Object(App\\Models\\User))")).toBe(
    '#3 /app/app/Services/Pay.php(12): App\\Services\\Pay->charge(...)',
  )
  expect(redact('#4 /app/vendor/x.php(9): Foo->bar()')).toBe('#4 /app/vendor/x.php(9): Foo->bar()')
  expect(redact('#5 {main}')).toBe('#5 {main}')
})

const ARTISAN_TEST = String.raw`
   PASS  Tests\Unit\ExampleTest
  ✓ that true is true                                                    0.01s

   FAIL  Tests\Feature\OrderTest
  ⨯ it creates an order                                                  0.05s
  ✓ it lists orders                                                      0.02s
  ─────────────────────────────────────────────────────────────────────────────
   FAILED  Tests\Feature\OrderTest > it creates an order
  Expected response status code [201] but received 500.
Failed asserting that 500 is identical to 201.

  at tests/Feature/OrderTest.php:19
     18▕     $response = $this->post('/orders', ['total' => 10]);
  ➜  19▕     $response->assertCreated();


  Tests:    1 failed, 2 passed, 1 skipped (5 assertions)
  Duration: 0.21s
`

test('parseTestRun reads artisan test / Pest output with each failure', () => {
  const run = parseTestRun(ARTISAN_TEST)!
  expect([run.passed, run.failed, run.skipped]).toEqual([2, 1, 1])
  expect(run.failures.map(f => f.name)).toEqual(['Tests\\Feature\\OrderTest > it creates an order'])
  expect(run.failures[0]!.detail[0]).toBe('Expected response status code [201] but received 500.')
  expect(run.failures[0]!.detail.join('\n')).toContain('at tests/Feature/OrderTest.php:19')
  expect(run.failures[0]!.detail.join('\n')).not.toContain('Tests:')
})

test('parseTestRun reads PHPUnit output, and nothing without a summary', () => {
  const phpunit = `There was 1 failure:

1) Tests\\Feature\\OrderTest::test_it_creates_an_order
Failed asserting that 500 is identical to 201.

/app/tests/Feature/OrderTest.php:19

FAILURES!
Tests: 12, Assertions: 30, Failures: 1, Skipped: 2.`
  const run = parseTestRun(phpunit)!
  expect([run.passed, run.failed, run.skipped]).toEqual([9, 1, 2])
  expect(run.failures[0]).toEqual({ name: 'Tests\\Feature\\OrderTest::test_it_creates_an_order', detail: ['Failed asserting that 500 is identical to 201.', '', '/app/tests/Feature/OrderTest.php:19'] })
  expect(parseTestRun('OK (12 tests, 30 assertions)')).toEqual({ passed: 12, failed: 0, skipped: 0, failures: [] })
  // Skipped and risky tests are numbered too, but aren't failures
  const skipped = `There were 2 skipped tests:

1) Tests\\Unit\\A::test_a
2) Tests\\Unit\\B::test_b

OK, but some tests were skipped!
Tests: 10, Assertions: 20, Skipped: 2.`
  expect(parseTestRun(skipped)!.failures).toEqual([])
  expect(parseTestRun('Running tests...')).toBe(undefined)
})

test('isTestCommand spots test runs', () => {
  for (const c of ['php artisan test --filter=Order', 'vendor/bin/pest', './vendor/bin/phpunit tests/Unit', 'composer test', 'herd php artisan test']) expect(isTestCommand(c)).toBe(true)
  for (const c of ['php artisan migrate', 'npm run build', 'git status', 'php artisan make:test OrderTest', 'cat phpunit.xml', 'composer require pestphp/pest-plugin-laravel', 'composer require pestphp/pest']) {
    expect(isTestCommand(c)).toBe(false)
  }
})

test('parseDebugCapture counts what Herd recorded, and keeps text that is not JSON', () => {
  expect(parseDebugCapture('{"queries":[{},{}],"logs":[{}],"dumps":[]}').summary).toBe('2 queries, 1 logs')
  expect(parseDebugCapture('[{"type":"query"},{"type":"query"},{"type":"http"}]').summary).toBe('2 query, 1 http')
  expect(parseDebugCapture('')).toEqual({ data: '', summary: 'nothing captured' })
})

test('redactData withholds bindings, headers and secrets, and redacts every string', () => {
  const data = { queries: [{ sql: 'select * from users where email = ?', bindings: ['jane@x.io'], time: 1.2 }], http: [{ url: 'https://api.test', headers: { Authorization: 'Bearer abc' }, api_key: 'k' }], note: 'mail jane@x.io' }
  let deep: unknown = { cookie: 'c', note: 'jane@x.io' }
  for (let i = 0; i < 30; i++) deep = { child: deep }
  expect(JSON.stringify(redactData(deep))).not.toContain('jane@x.io')
  expect(redactData(data)).toEqual({
    queries: [{ sql: 'select * from users where email = ?', bindings: '[redacted]', time: 1.2 }],
    http: [{ url: 'https://api.test', headers: '[redacted]', api_key: '[redacted]' }],
    note: 'mail [email]',
  })
})

test('methodLabel drops HEAD, and says ANY only for a route that takes every method', () => {
  expect(methodLabel('GET|HEAD')).toBe('GET')
  expect(methodLabel('PUT|PATCH')).toBe('PUT|PATCH')
  expect(methodLabel('GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS')).toBe('ANY')
  expect(methodLabel('GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|QUERY')).toBe('ANY')
  expect(methodLabel('GET|HEAD|POST|PUT|PATCH|DELETE')).toBe('GET|POST|PUT|PATCH|DELETE')
  expect(methodLabel('HEAD')).toBe('HEAD')
})

test("routesPhp keeps a route's domain in PHP, saying only whether it has one", () => {
  expect(routesPhp()).toContain("'onDomain' => $route->getDomain() !== null")
  expect(routesPhp()).not.toMatch(/'domain'\s*=>/)
})

test('parseRoutes reads the JSON after PHP warnings, keeps a file only with its line, and drops odd entries', () => {
  const routes = [
    { id: 1, method: 'GET|HEAD', uri: 'users', name: 'users.index', action: 'App\\Http\\Controllers\\UserController@index', file: 'app/Http/Controllers/UserController.php', line: 12, params: [], onDomain: false },
    { id: 2, method: 'GET|HEAD', uri: 'old', name: null, action: 'Illuminate\\Routing\\RedirectController', file: null, line: null, params: [], onDomain: false },
    { id: 3, method: 'GET|HEAD', uri: 'x', name: null, action: 'Closure', file: 'x\u001b[2J.php', line: 3, params: ['ok', 'not ok'], onDomain: true, domain: 'admin.example.test' },
    { id: 'four', method: 'GET|HEAD', uri: 'y', name: null, action: 'Closure' },
  ]
  const parsed = parseRoutes('Deprecated: x\n' + JSON.stringify({ routes, editor: 'phpstorm' }))!
  expect(parsed.routes).toEqual([
    { id: 1, method: 'GET|HEAD', uri: 'users', name: 'users.index', action: 'App\\Http\\Controllers\\UserController@index', file: 'app/Http/Controllers/UserController.php', line: 12, params: [], onDomain: false },
    { id: 2, method: 'GET|HEAD', uri: 'old', name: null, action: 'Illuminate\\Routing\\RedirectController', params: [], onDomain: false },
    { id: 3, method: 'GET|HEAD', uri: 'x', name: null, action: 'Closure', params: ['ok'], onDomain: true },
  ])
  expect(parsed.editor).toBe('phpstorm')
  // Only a plain editor name: anything else (a custom href) is dropped
  expect(parseRoutes(JSON.stringify({ routes: [], editor: 'vscode://vscode-remote/ssh-remote+host{file}' }))!.editor).toBe('')
  expect(parseRoutes('no json')).toBe(undefined)
})

test('pageNotOpened says why PHP did not open the page, in its own fixed words', () => {
  expect(pageNotOpened('Deprecated: x\n{"opened":true}')).toBe('')
  expect(pageNotOpened('{"opened":false,"why":"APP_URL is not an http(s) URL"}')).toBe('APP_URL is not an http(s) URL')
  expect(pageNotOpened('Fatal error')).toBe('PHP could not build the URL')
})

test('editorHref links to the file at the line in Laravel-named editors, encoding the path', () => {
  expect(editorHref('vscode', '/Users/me/My Sites/shop/app/X.php', 9)).toBe('vscode://file/Users/me/My%20Sites/shop/app/X.php:9')
  expect(editorHref('phpstorm', '/app/a&b/X.php', 3)).toBe('phpstorm://open?file=/app/a%26b/X.php&line=3')
  expect(editorHref('sublime', '/app/X.php', 1)).toBe('subl://open?url=file:///app/X.php&line=1')
  expect(editorHref('atom', '/app/X.php', 4)).toBe('atom://core/open/file?filename=/app/X.php&line=4')
  expect(editorHref('netbeans', '/app/X.php', 4)).toBe('netbeans://open/?f=/app/X.php:4')
  expect(editorHref('myeditor', '/app/X.php', 2)).toBe('myeditor://open?file=/app/X.php&line=2')
  // A name that is also an object property isn't taken for an editor's link
  expect(editorHref('toString', '/app/X.php', 2)).toBe('toString://open?file=/app/X.php&line=2')
})

test('terminalEditor names the editor whose terminal Claude Code runs in, and nothing in a plain terminal', () => {
  expect(terminalEditor('com.todesktop.230313mzl4w4u92', 'vscode')).toBe('cursor')
  expect(terminalEditor('com.microsoft.VSCode', 'vscode')).toBe('vscode')
  expect(terminalEditor(undefined, 'vscode')).toBe('vscode')
  expect(terminalEditor(undefined, undefined, 'JetBrains-JediTerm')).toBe('phpstorm')
  expect(terminalEditor('com.googlecode.iterm2', 'iTerm.app')).toBe('')
  expect(terminalEditor('constructor')).toBe('')
})

test('routeWindow keeps a row drawn on each side of the selected one, so the next arrow lands on a drawn row', () => {
  // 10 rows of 30: moving down from the top scrolls once the selected row reaches the last-but-one
  expect(routeWindow(0, 0, 10, 30)).toBe(0)
  expect(routeWindow(8, 0, 10, 30)).toBe(0)
  expect(routeWindow(9, 0, 10, 30)).toBe(1)
  // ...and up from the bottom, likewise at the second row
  expect(routeWindow(11, 10, 10, 30)).toBe(10)
  expect(routeWindow(10, 10, 10, 30)).toBe(9)
  // The ends: the last row shows at the bottom, a short list never scrolls
  expect(routeWindow(29, 10, 10, 30)).toBe(20)
  expect(routeWindow(4, 3, 10, 5)).toBe(0)
  // A window under 3 rows still shows the selected row
  expect(routeWindow(5, 0, 1, 10)).toBe(5)
  expect(routeWindow(5, 0, 2, 10)).toBe(4)
})

test('phpJson reads the object PHP printed, skipping what app code printed around it', () => {
  expect(phpJson('Deprecated: x\n{"routes":[],"editor":null}\nWarning: at shutdown')).toEqual({ routes: [], editor: null })
  expect(phpJson('hello from a provider {"x":1} {"routes":[1]}\n', '{"routes"')).toEqual({ routes: [1] })
  expect(phpJson('[1,2]')).toBe(undefined)
  expect(phpJson('no json')).toBe(undefined)
  expect(phpJson('{"routes": broken', '{"routes"')).toBe(undefined)
})
