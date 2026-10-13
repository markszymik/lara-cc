# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.13.0] - 2026-10-13

### Added

- **Since Claude's edits**: lara-cc notes which files Claude edits (paths and kinds, never contents) and lists which checks ran on them: Syntax, Tests, Pint, Migrations, Routes, Views and the queue worker, each `passed`, `failed`, `not run`, `skipped`, `unknown` or `done`. A check passes only if it ran after the last edit. The list sits on top of the Tests tab with a button per step and on the Services tab, and opens Claude's `health` tool, which tells Claude to say which checks passed rather than "verified".
- `php -l` on the PHP files Claude edited when its turn ends: parse-only, at most 20 files, never an env-named file or a link leading outside the project, and on by default (**syntax check after each turn** on the Services tab). A file that fails or isn't reached is checked again at the next turn's end, until it parses.
- Errors in the log since the first edit are counted per window (`so far` for ten minutes after the turn), and only when the log was followed the whole time, never read as a pass.
- Once a turn ends, the band shows `✗ syntax error` or `✎ N files: tests not run`, never green, and a toast says the same once.

### Changed

- Pint after a turn runs after the syntax check, so it may start a few seconds later.
- A failed automatic queue restart is said as failed, not assumed done; a worker reading cached config is not counted as reloaded by a restart.
- A test run Claude starts through Bash that dies before printing a summary counts as failed; a command that only names the runner (`ls vendor/bin/pest`) doesn't count as a run.

## [0.12.0] - 2026-10-12

### Added

- A read-only `health` tool for Claude: what the checks found, what they couldn't tell, what's stale and what's fine, each line marked seen, inferred or unknown with its age, and each problem with its next step and whether that runs on its own, asks you, or is your button to press. It re-runs the checks, the queue read and `migrate:status` first, and sends only counts, drivers, local ports, file names and error types.
- The Services tab's first row says when the checks last ran, with **recheck**, and lists what they couldn't check.

### Changed

- The band marks what lara-cc saw with `⚠` and conclusions or things it couldn't check with `?` (`? 3 jobs waiting, no worker in this session`, `? Herd MySQL unchecked`, and new: `? Vite unchecked (public/hot)` when curl gets no clear answer). A folded band says `? N unchecked` when nothing was seen for certain, checks that stopped running show `? checks stale` with **recheck**, and a count whose re-read failed stays, dim, marked `(last read failed)`.
- A test result from before Claude edited PHP no longer counts as current: a pass leaves the band, a failure turns yellow (`✗ 1 test failed, edited since`).
- Claude's queue and service replies no longer state that a worker, Vite or the scheduler isn't running when only this session's process is known: "not running in this session; lara-cc can't see one run elsewhere".
- A failed `artisan about` or `migrate:status` keeps its last result, dated and marked stale, instead of dropping it; a worker elsewhere draining the queue is judged over minute ticks, so frequent reads don't flip it back to "no worker".

### Fixed

- `/lara-test` without arguments no longer labels its run `test ` with a trailing space.

### Security

- Hosts other than this machine are redacted from everything that reaches Claude: host keys, URLs after a redacted user, server URLs, and MySQL and Postgres connection errors (including the database user in Postgres' `pg_hba.conf` rejection). The queue tool's error note used to pass a database host through.
- Errors that reach Claude from the queue read are reduced to their type (e.g. `QueryException, SQLSTATE[HY000] [2002]`), never their message.

## [0.11.4] - 2026-10-11

### Changed

- The stated minimum Claude Code version is now v2.1.295, the oldest the tests pass on: since 0.9.0, older versions (2.1.287 to 2.1.294) can't draw the pane's Routes tab. CI now runs on both v2.1.295 and v2.1.296, and checks the README names each.

### Security

- CI runs with a read-only token and doesn't keep the checkout's credentials on disk while it runs code installed from npm.

## [0.11.3] - 2026-10-11

### Added

- CI on GitHub Actions: every push and pull request validates the mod (`--strict`) and runs its tests on the Claude Code version they were last validated on. The README states the minimum and last validated Claude Code versions, and the type check, which needs files only a signed-in Claude Code writes, runs before each release.

### Changed

- The code type-checks with no errors (it had 114 known ones, all in types, none in behaviour), so a new type error stands out.

## [0.11.2] - 2026-10-11

### Changed

- Claude running `artisan test` asks first unless `phpunit.xml` sends the tests to an in-memory database, since `RefreshDatabase` resets whichever database the tests use; `/lara-test` and the Tests tab don't ask.
- Only Laravel's own `make:*` generators (and Livewire's, Volt's and Filament's file generators) run unasked; a package's `make:` command such as `make:filament-user`, which writes to the database, asks.
- `config:show` or `db:show` output shown on Claude's request is kept and drawn whole on the Commands tab, so you can scroll to what Claude asked about.
- `route:list` for Claude keeps the middleware with `-v`, keeps the requested timeout, shows on the Commands tab, and lists routes like the `routes` tool.

### Fixed

- Redaction keeps up on long words after an auth scheme (`token aaaa…` took most of a second).

### Security

- `about` for Claude is built from its JSON with an allow-list (versions, drivers, environment, plain words); the address filter missed URLs in JSON (PHP escapes their slashes) and IP hosts.
- URL credentials containing `;`, `(`, `)` and the like, which userinfo allows, are redacted again.
- An upper-case `BEARER` (or `BASIC`, `TOKEN`) credential, and secrets under quoted key names longer than 40 characters, are redacted again.
- `route:list` output for Claude is redacted, so a secret in a route's path (a webhook token) is hidden.
- Answering "Show me" for `config:show`/`db:show` no longer runs it if the session moved to another folder while the question was open.

## [0.11.1] - 2026-10-11

### Changed

- `config:show` and `db:show` now run for you instead of being refused or sent: their output shows only on the pane's Commands tab, never in the conversation. When Claude asks for one you're asked first, and Claude is told it was shown, not what it said; typed with `/lara-artisan`, it just shows.
- Claude's artisan tool runs without asking only the commands lara-cc knows stay in the project folder (`make:*`, route/config/view/event caches, `about`, `model:show`, `migrate:status`…); any other command asks first, so a package's command that runs jobs or deletes rows can't slip through.
- The question before such a command says when lara-cc hasn't read APP_ENV or the app's servers yet, instead of reporting none found, and a yes no longer applies if the session moved to another folder meanwhile.

### Fixed

- Text like "CSRF token mismatch" or "Basic authentication failed" is no longer redacted; only a credential-looking value after Bearer, Basic or Token is.
- Long command output kept only a few trailing characters when its last line was long, or nothing when it had no spaces; error headlines could end up as a bare "…".
- Redaction stays fast on long words; a 30,000-character line took seconds.

### Security

- `artisan about` sent the app's URL, and `artisan route:list` route domains, into the conversation (Claude's tool and `/lara-artisan`); both still work, with the URL and the domains left out.
- `db:show` printed the database's host and user straight into the conversation through Claude's artisan tool (and was suggested in the tool's description); its output is now shown only to you.
- A URL in JSON could swallow the next field's secret key and leave the end of its value visible; a URL's credentials now stop at the URL.
- A secret containing a quote in a PHP-serialized queue payload was left as is.
- Command output and queue/routes errors are redacted whole before they're shortened, so a cut can't part a key from its value.

## [0.11.0] - 2026-10-11

### Added

- README: a table of what Claude can do on its own, what asks you and what's refused, and suggested Claude Code deny rules for the Bash and Read access lara-cc's checks don't cover.

### Changed

- Claude's artisan tool asks you before commands that reach past the project folder into the database, queue or cache (`migrate`, `queue:retry`/`work`/`restart`, `schedule:*`, `cache:clear`, `optimize:clear`, Horizon controls). The question shows `APP_ENV` and which of the app's servers are on this machine; a no, or nobody there to answer, runs nothing.
- Retrying failed jobs (one or all) and starting the queue worker, Horizon or the scheduler ask you first when Claude does it, or when a slash command you didn't type does. Restarting a worker that's already running doesn't ask, so Claude can still reload job code.
- `/lara-composer` and `/lara-npm` ask first when you didn't type them yourself.

### Security

- Redaction now also catches usernames, `APP_KEY`-style `base64:` keys with slashes, AWS key ids, Stripe and Slack keys, GitHub tokens, JWTs, lower-case auth schemes, Sentry-style DSN keys, URL passwords containing `@`, the user in database login errors, secrets in escaped JSON and in PHP-serialized queue payloads, and SQL `update … set` values.
- Long output is cut at a line or word boundary, so a cut can no longer separate a key from its value or leave a token fragment too short to recognise; a failed job's exception is redacted before its headline is shortened.
- What the artisan tool returns when artisan can't resolve a command, and the messages of failed lara-cc tools and commands, are redacted; they used to reach Claude as is.

## [0.10.0] - 2026-10-11

### Fixed

- A Herd service whose port can't be checked (no `nc`, or `nc` failing) shows as "unchecked" in the band and on the Services tab, instead of passing as running; starting it no longer reports "running" without having checked.
- When the session moves to another folder, nothing of the previous project carries over: a Horizon setup no longer sticks to an app without Horizon, the processes the session started there are stopped, and its logs, jobs, queue state, service output, last command and Herd debug capture are cleared. Results still arriving for the folder left behind are dropped, and the background timers aren't doubled.

## [0.9.0] - 2026-10-11

### Added

- Browse routes with the arrow keys on the Routes tab; Enter asks whether to open the route's code (controller method, closure or view, at its line, in the editor Laravel's `editor` setting or your terminal names) or its page in the browser, asking for any URL parameter without a default. Laravel's own URL generator builds the URL from `APP_URL` and PHP opens it, so the URL, and a route's domain, never reach the mod or Claude.

### Changed

- The Routes tab draws routes in aligned columns with coloured methods and highlighted `{parameters}`, shows where the selected route's code is, says why loading failed instead of loading forever (and tries again when you come back to the tab), fits narrow and short panes, and `f` jumps to the filter. The filter matches the method as shown (`ANY`, no `HEAD`).
- `/lara-routes` and Claude's `routes` tool read the same list as the Routes tab, from one PHP boot instead of `route:list`, and `/lara-routes <filter>` filters the open tab too.

### Fixed

- Every PHP the mod starts sends PHP's own warnings to stderr, so a package that warns on a newer PHP no longer breaks what the mod reads from PHP's output (routes, queue state, the About tab, the artisan tool's command check), whether the warning comes before the output or at shutdown.

### Security

- When the routes can't be read, the reason Claude's `routes` tool and `/lara-routes` return is redacted; it used to be PHP's raw output, which can name database hosts and users.

## [0.8.0] - 2026-10-10

### Added

- One-press fixes in the status band and on the Services tab: restart a crashed process, start the worker, migrate, start Vite, clear the config/route/event caches that exist (never `optimize:clear`), `artisan up`, Composer/npm install, start a Herd service. Only the person's press runs them; the band drops them before folding warnings when it's narrow.
- The band flags jobs waiting with no worker in this session, unless the queue is draining; the queue is checked every minute while no worker runs.
- Test results from every run in the session (`/lara-test`, the Tests tab, the artisan tool, and the Pest/PHPUnit runs Claude does through Bash): failing tests show in the band until a run passes, a passing run shows next to anything else the band shows, and a new **Tests** tab (hotkey `t`) lists the failures with **run tests** and **ask Claude**.
- Start and stop Herd's debug session (Herd Pro) from the Services tab; what it records stays in the mod until you send it, asked first, with bindings, headers and bodies withheld and the rest redacted.
- With Laravel Boost installed, its log tools ask first and are redacted like lara-cc's `logs` tool, its `get-config` refuses keys that can hold secrets (`app.key`, passwords, tokens, URLs), every other Boost tool's output (`tinker`, `database-query`…) is redacted, and its two log tools step behind lara-cc's so Claude doesn't have both.

## [0.7.0] - 2026-10-10

### Added

- A **start** button next to each stopped Herd service on the Services tab, through Herd's AppleScript command with the service's type, port and version passed as arguments. Only the person's press starts one; Claude has no tool for it.

## [0.6.0] - 2026-10-10

### Added

- The status band flags a Herd service the app connects to that isn't running (e.g. MySQL on the port the database connection uses), and the Services tab lists Herd's services with their status. Only the driver and port of the app's local connections leave PHP; no credentials, URLs or remote hosts reach the mod or Claude, and Herd's site list is never read.

### Security

- Log entries and failed-job exceptions go to Claude only after you agree in a dialog that explains they can contain confidential data (Send redacted, Allow this session, Don't send); dismissed or headless means nothing is sent.
- Text sent to Claude (log entries, exceptions, artisan/test/npm/Composer and process output) is redacted first: passwords, tokens and keys, URL credentials, bearer tokens, email addresses, SQL values, stack frame arguments and long random strings.
- Claude's `artisan` tool refuses `config:show`, `env:encrypt` and `env:decrypt`, which print secrets; `/lara-artisan` refuses them too, since its output lands in the conversation.

## [0.5.0] - 2026-10-10

### Added

- The status band flags a crashed dev process, a `public/hot` pointing at a Vite that isn't running, cached config/routes/events, maintenance mode, a production environment, and Composer or node packages out of step with the lockfiles; the Services tab explains each and how to fix it.

## [0.4.0] - 2026-10-10

### Changed

- Renamed the mod from `laravel` to `lara-cc` (marketplace `markszymik-lara-cc`, repo `markszymik/lara-cc`) so it doesn't use the Laravel trademark as its name. Commands are now `/lara`, `/lara-artisan`, `/lara-queue`…, and Claude's tools `mcp__lara-cc__*`. Uninstall the old `laravel` plugin and install `lara-cc`; the pane's settings may start from their defaults again.

## [0.3.0] - 2026-10-10

### Added

- When the PATH `php` is Laravel Herd's, artisan, Composer, Pint and the queue worker, scheduler and Horizon run on the PHP binary Herd serves the folder with, so isolated sites use their own PHP version; the Services tab shows it and flags when the shell's `php` differs.

### Security

- Claude's `artisan` tool now asks artisan to resolve the command name before checking it, so abbreviations (`migr:fr`, `d:w`), odd casing (`MIGRATE:FRESH`) and leading options (`-q migrate:fresh`) can no longer bypass the destructive-command guard.
- The `artisan` tool refuses `tinker`, which runs arbitrary PHP; the tool's description no longer suggests it.
- The `artisan` tool refuses `--force`/`-f`, `--env`, `--prune`, `--seed` and `--seeder` on any command, and more destructive commands: `queue:forget`, `queue:prune-failed`, `queue:prune-batches`, `model:prune`, `horizon:clear`, `horizon:forget`, `telescope:clear`, `telescope:prune` and `pulse:clear`.
- `/laravel-artisan` skips the guard only when you type it; runs relayed from another session, a channel or a plugin get the same check as Claude's tool.
