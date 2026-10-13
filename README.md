# lara-cc

[![CI](https://github.com/markszymik/lara-cc/actions/workflows/ci.yml/badge.svg)](https://github.com/markszymik/lara-cc/actions/workflows/ci.yml)

An unofficial [Claude Code](https://code.claude.com) mod for Laravel apps.

> **Unofficial.** This is a community project by [Mark Szymik](https://github.com/markszymik). It is not made, endorsed or supported by Laravel LLC or Anthropic. "Laravel" is a trademark of Laravel LLC and is used here only to describe what the mod works with.

Tooling for Laravel apps inside Claude Code: a `/lara` pane, managed dev processes (queue, Vite, scheduler), artisan/npm/composer commands, and tools Claude can call. It's a [mod](https://code.claude.com/docs/en/plugins/mods/overview), so it runs inside Claude Code and draws its own interface.

## Install

Needs Claude Code v2.1.295 or later (`claude --version`). In a Claude Code terminal session, run:

```
/plugin install lara-cc --marketplace markszymik/lara-cc
```

Answer `y` to add the marketplace, then press Enter to install for your user. It's active straight away and loads in every session after that. To update later, run `/plugin`, open the **Installed** tab, and update it there.

Start Claude Code from your Laravel project's root (the folder with `artisan`).

**Coming from the old `laravel` plugin?** This mod used to be called `laravel` (marketplace `markszymik-laravel`), with `/laravel-*` commands. Uninstall that one from `/plugin` → **Installed**, then install `lara-cc` as above. The commands are now `/lara`, `/lara-artisan` and so on, and the pane's toggles may start from their defaults again.

> A mod is code that runs with your permissions: it starts processes and reads files in your project. Read `hooks/register.tsx` before installing if you want to see exactly what it does, or run `claude plugin validate` on a clone to list every call it makes.

## What you get

**Live log monitoring.** The mod follows the newest `storage/logs/laravel*.log` (single or daily channel) for the whole session. New errors pop up as a toast and a count in the status band. The **Log** tab shows entries coloured by level, with filters (all / warnings+ / errors). Each error shows where it happened, pointing at your own code rather than the `vendor/` frame it was thrown from. **ask Claude about latest error** sends the error and its stack to Claude to fix.

**Queue monitoring.** While the mod runs your queue worker, the **Queue** tab shows each job as it runs, finishes or fails, with timings and session totals. It also shows pending jobs per queue and your stored failed jobs (read from the app itself, so any failed-job driver works), each with **retry**, **forget** and **ask Claude**. A failing job raises a toast. If `QUEUE_CONNECTION=sync`, it tells you a worker isn't needed.

**Status band.** One line above the prompt, shown only when there's something to know: running processes, queue totals, new errors, failed jobs, failing tests, pending migrations. Press **open** to jump to the right tab.

It also flags the things that make a change "not work" without an error, and the Services tab explains each one. Most come with a one-press fix next to them, in the band and on the Services tab. A fix runs only when you press it, never from Claude, and its output lands on the Commands tab:

- **A process that crashed**, e.g. `✗ vite exited (1)`, until you open the Services tab. Fix: **restart**.
- **Jobs waiting with no worker**, e.g. `? 3 jobs waiting, no worker in this session`, when this session runs no worker and the count hasn't dropped since a minute before (a worker elsewhere would drain it, and lara-cc can't see one). Fix: **start worker**. The queue is checked every minute while no worker runs.
- **Pending migrations.** Fix: **migrate**.
- **`public/hot` with no Vite behind it**: pages load without CSS and JS. Vite running in another terminal counts; only dev servers on this machine (`localhost`, `*.test`) are ever checked. Fix: **start vite**. When curl gets no answer either way (a timeout, a certificate or DNS error, no curl), it shows `? Vite unchecked (public/hot)` instead, until Vite answers.
- **Cached config, routes or events**: edits to them don't take effect until the cache is cleared. Fix: **clear** runs `config:clear`, `route:clear` or `event:clear` for the caches that exist; not `optimize:clear`, which would also empty your application cache.
- **Maintenance mode** (fix: **up**), and **APP_ENV=production** on your machine (read from `artisan about`, not from `.env`).
- **A stopped Herd service the app connects to**, e.g. `Herd MySQL stopped` while the database connection points at its port (also Redis, PostgreSQL, MariaDB, MongoDB, Reverb, Meilisearch, Typesense). The Services tab lists every Herd service under **Herd services (port check)**: a port that answers means something listens there, not proof that it's Herd's service. A stopped one has a **start** button. It uses Herd's own AppleScript command, the same one Herd's MCP server uses; macOS asks once whether your terminal may control Herd. Only your press starts a service: Claude has no tool for it. The mod reads Herd's `services.plist` (type, port and version, no credentials) and asks the app's config for the driver and port of each server on this machine it uses (database, cache, queue, session, broadcasting, Scout). Only those two values come back: passwords, usernames, URLs and remote hosts stay inside PHP and never reach the mod or Claude. A server on a port no Herd service has (Docker, DBngin) is left alone, and Herd is never asked for its site list.
- **`composer install needed`** when `vendor/` differs from `composer.lock`, and **`npm install needed`** when `node_modules` differs from `package-lock.json` (for pnpm, Yarn and Bun, when `node_modules` is missing), e.g. after a `git pull`. Fix: **composer install** / **npm install**.

`⚠` marks something the mod saw (a file exists, nothing answers on the port) and `?` a conclusion or something it couldn't check, e.g. `? 3 jobs waiting, no worker in this session` or `? Herd MySQL unchecked` when `nc` can't probe the port. A count whose re-read failed (or, for failed jobs, couldn't count them) stays, dim, as `1 failed job (last read failed)` or `2 pending migrations (last check failed)`, rather than disappearing; failed jobs that were never counted show as `? failed jobs unknown`. If the checks stop finishing, the band shows `? checks stale` with **recheck**.

When the band is too narrow, the fix buttons go first, then the warnings fold into a count (`? 2 unchecked` when none of them was seen for certain).

The checks run at start-up, after each of Claude's turns, after commands and every minute. They read lockfiles, Laravel's marker files and Herd's service list, never `.env`. The Services tab's first row says when they last ran, with **recheck**, and lists what they couldn't check (`not checked: APP_ENV (artisan about failed), migrations (migrate:status failed)`…), so nothing unchecked passes for fine. A process row reads `not started` or `stopped`, which means in this session: lara-cc can't see one run elsewhere.

**Test results.** Every test run in the session counts: `/lara-test`, the Tests tab, the Commands tab, Claude's `artisan` tool, and the `php artisan test`, Pest or PHPUnit runs Claude does through Bash. The band shows `✗ 2 tests failing` until a run passes (and `✓ 32 tests` next to anything else it shows). Once Claude edits PHP, during the run or after, the result no longer covers the code: a passing run leaves the band, a failing one turns yellow (`✗ 2 tests failed, edited since`), and the Tests tab says it wasn't re-run. The **Tests** tab shows the last run, each failure with its message and where it failed, **run tests**, and **ask Claude** for one failure or all of them, redacted like everything sent.

**Since Claude's edits.** lara-cc notes which files Claude edits with its Edit, Write and NotebookEdit tools (paths inside the project and what kind each is, never contents), and lists the checks that apply to them: Syntax, Tests, Pint, Migrations, Routes, Views and the queue worker. The list is at the top of the **Tests** tab, one line on the Services tab, and Claude's `health` tool reads the same rows. Each reads `passed`, `failed`, `not run`, `skipped` (a setting says not to), `unknown` (lara-cc can't tell) or `done` (the worker restarted). A check passes only if it ran after the last edit and succeeded: a test run from before the edit reads `not run`, a subset (`--filter`, `--dirty` and the like) says so, a run that dies before printing a summary is `failed` (for Claude's own Bash runs, only when the runner actually started: the command is the runner, or PHPUnit's or Pest's banner is in the output, so `ls vendor/bin/pest` failing is not a crashed run) and one that exits non-zero after a summary is `unknown`, and an edited migration is never `passed` since lara-cc runs none. No error in the log is not a pass: the log gets its own sentence (`no errors have arrived since 14:03:10 so far`, and, once ten minutes after the turn have passed, `no errors arrived 14:03:10-14:13:40`), only when the log was followed the whole time, and is unknown otherwise. Once a turn ends the band shows `✗ syntax error` or `✎ 2 files: tests not run`, never green, and a toast says the same.

`php -l` on each PHP file Claude edited, when the turn ends, is the only new automatic step here (the queue restart and Pint, below, already ran on their own, each with its own setting): it only parses (no autoloader, no app boot, no database), for at most 20 files, never an env file (`.env.php`), and never a file whose real path is outside the project (a symlink): that one is counted as not linted, and the row says so. A file that failed to parse, or that the check didn't reach or that was edited while it ran, is carried into the next stretch and checked again at its end, so a fix made in your editor clears it; until then the row says it is still failing from before. **syntax check after each turn** on the Services tab turns it off, and the Syntax row then says `skipped` (naming a parse error left over from before that nothing re-checks while it is off: `failed before: app/Models/Order.php line 41`). Everything else is suggested, never run for you: the report names the artisan or service step with whether it asks first, like Claude's tools do, and each row's own button (**migrate**, **restart queue** and so on) is drawn under it on the Tests tab for you to press; the Tests row has none of its own, **run tests** at the top of the tab is it. When the queue worker should read edited config or `.env` values but config is cached, a restart isn't enough: the row says `not run`, and to clear the config cache first. A parse error's text is shown only to you, on the Tests tab; Claude gets the file and line. Claude can't fix anything through this, and gets nothing pushed into the conversation: it reads the report when it calls `health`.

It doesn't see changes made through Claude's Bash tool, git, `artisan make:*` or your editor (the report says so), nor anything under `vendor/`, `node_modules/`, `storage/` or `bootstrap/cache/` at the project root. A `.env` edit is classified by name only: the report says the worker and cached config keep the old values. `php -l` runs on the PHP lara-cc uses (Herd's for the site), which can differ from the app's, so a failure says `did not parse on this PHP`.

**Routes.** The **Routes** tab lists every route in aligned columns: the method in colour, the URI with its `{parameters}` picked out, the name and the controller. Type in **filter** (or press `f`) to narrow it; Enter there moves to the list. The ↑ and ↓ keys walk the rows (marked `›`) and the list scrolls with them; the line under it shows where the selected route's code is. Enter on a route asks whether to open its **code** (the controller method, closure or view, at its line) or its **page** in the browser; when only one applies (a `POST` route has no page), it opens that. A page whose URL has parameters asks for each value it needs first (`1`, or type one): a parameter with a route default or a `URL::defaults` value takes that, and optional ones are left out. Laravel's own URL generator builds the URL, so the port and the route's domain are as the app has them. `/lara-routes` and Claude's `routes` tool read the same list. The file opens in the editor named by Laravel's own `editor` setting in `config/app.php` (the one its error page uses, e.g. `phpstorm`, `vscode`, `cursor`, `zed`), otherwise the editor whose terminal Claude Code runs in, otherwise (or when the editor's link doesn't open) whatever opens `.php` files.

**Herd debug session.** With Herd Pro, **start Herd debug session** on the Services tab makes Herd record the queries, logs, dumps and HTTP calls the app makes; **stop** hands them to the mod, which shows a count of each. They stay in the mod: **ask Claude** asks you first, withholds query bindings, headers, cookies and request bodies, and redacts the rest. (Herd's Xdebug isn't something a mod can switch: Herd turns it on by itself when a request asks for a debug session.)

**Laravel Boost.** When the app has [Laravel Boost](https://github.com/laravel/boost), its `read-log-entries`, `last-error` and `browser-logs` tools ask you and are redacted exactly like lara-cc's `logs` tool. Its `get-config` refuses keys that can hold a secret (`app.key`, `*.password`, `*.secret`, tokens, URLs), and the output of every other Boost tool (`tinker`, `database-query`, schema, app info) is redacted. Boost's two log tools step behind lara-cc's `logs` tool (they load on request) and say to prefer it, so Claude doesn't have two tools for the same thing.

**Dev processes.** Queue worker (or Horizon), Vite and the scheduler, started and stopped from the **Services** tab or commands, with their output. Tick **autostart** to start them whenever you open Claude Code in this project.

**After Claude edits PHP.** The queue worker restarts so it runs the new code (on by default; a restart that doesn't keep the worker up for a second is said, not assumed). At the end of each turn, `php -l` checks the PHP files Claude changed for syntax errors (on by default; see Since Claude's edits). Optionally, Pint formats them too (off by default).

**Herd's PHP version.** When the `php` on your PATH is [Laravel Herd](https://herd.laravel.com)'s, artisan, Composer, Pint and the managed processes run on the PHP binary Herd serves your site with, so an isolated site (`herd isolate 8.3`) gets its own version even when `php` in your shell is another one. The Services tab shows which version, and says when your shell's `php` differs. If your PATH `php` comes from somewhere else (Homebrew, asdf), the mod keeps using it. The mod asks Herd only about the current folder: it reads no site list and no `.env`.

**At start-up** it checks `migrate:status` and tells you about pending migrations.

## Commands

| Command | What it does |
| --- | --- |
| `/lara [tab]` | Opens the pane: Services, Queue, Log, Tests, Routes, Commands, About (hotkeys `s q l t r c a`) |
| `/lara-logs [errors\|warnings\|all] [count]` | Recent log entries in the transcript, so Claude sees them too (default: last 5 errors) |
| `/lara-queue [start\|stop\|restart\|logs\|status\|failed\|retry <id\|all>]` | Queue worker (`queue:work`, or `horizon` if installed) and failed jobs |
| `/lara-vite [start\|stop\|restart\|logs]` | `npm run dev` (pnpm/yarn/bun detected from the lockfile) |
| `/lara-schedule [start\|stop\|restart\|logs]` | `schedule:work` |
| `/lara-artisan <args>` | `php artisan <args> --no-interaction`; output goes to the transcript so Claude sees it |
| `/lara-test [args]` | `php artisan test`, e.g. `/lara-test --filter=OrderTest` |
| `/lara-routes [filter]` | Route list, filtered |
| `/lara-npm <script>` | `npm run <script>` (defaults to `build`) |
| `/lara-composer <args>` | Composer |

A command you type runs as typed. One that reaches the mod some other way (Claude, a plugin, a relayed message) gets the same checks as Claude's tools: see [What Claude can do on its own](#what-claude-can-do-on-its-own).

Type `/lar` to see them all. Processes run for the life of the session and stop when it ends. `/lara`, `/lara-logs`, `/lara-queue`, `/lara-vite` and `/lara-schedule` work while Claude is mid-turn.

## What Claude gets

- **`logs` tool**: recent log entries with where they happened and the stack, so Claude can check for errors after running code or tests. Asks you first (see [Privacy](#privacy)).
- **`queue` tool**: pending jobs, jobs run this session, failed jobs with their exceptions (asks you first), and retrying them (asks you first).
- **`artisan` tool**: runs artisan commands. Refuses anything that can destroy data or run arbitrary code: `migrate:fresh/reset/refresh/rollback`, `db:wipe`, `db:seed`, `key:generate`, `down`, `queue:flush/clear/forget`, the `prune`/`clear` commands of the queue, models, Horizon, Telescope and Pulse, `tinker`, and the `--force`, `--env`, `--prune` and `--seed` options. It also refuses `env:encrypt` and `env:decrypt`, which write files and print the encryption key; `/lara-artisan` refuses those too, since its output goes into the conversation, so run them in your own terminal. `config:show` and `db:show` print passwords, keys, hosts and users, so their output is shown only to you, on the pane's **Commands** tab, and Claude is told it was shown, not what it said; when Claude asks for one, you're asked first, and when you type it with `/lara-artisan` it just shows. Two everyday commands keep working for Claude with the confidential part taken out: `about` with only versions, drivers, the environment and other plain values (it's read as JSON, and the app's URL, hosts, IPs, paths and anything else not on that list show as `[not shown]`), and `route:list` without route domains (it runs as `--json` so the domain can be dropped, with whatever options were asked for; a route with its own domain says so). Artisan resolves the command name first, so abbreviations like `migr:fr` are caught too. Run those yourself with `/lara-artisan`, which skips the check only when you type it (not when it's relayed from another session, a channel or a plugin). Commands that reach past the project folder ask you first (see below).
- **`service` tool**: start, stop, restart or read the output of the queue worker, Vite and the scheduler. Starting the queue worker, Horizon or the scheduler asks you first.
- **`routes` tool**: filtered route list.
- **`health` tool**: what lara-cc knows about the app's health and how it knows it: each problem, what it couldn't tell and what it found fine, marked seen, inferred or unknown with its age, and for each problem the next step and whether it runs on its own, asks you, or is yours to do. It re-runs the checks, the queue read and `migrate:status`, changes nothing, and sends only counts, drivers, local ports and file names, never log or exception text. After Claude edits files it also lists which checks ran on those edits and which passed, failed, were skipped or not run (see Since Claude's edits above); a parse error reaches Claude as a file and a line.

### What Claude can do on its own

| | Examples | Asks you? |
| --- | --- | --- |
| Reads | routes, queue counts, process status and output, health (what the checks found, marked seen, inferred or unknown, and what ran on Claude's edits) | No (output redacted) |
| Reads that can hold confidential data | log entries, failed-job exceptions, Boost's log tools, a Herd debug session | Yes, see [Privacy](#privacy) |
| Changes inside the project folder | Laravel's `make:*` generators (and Livewire's, Volt's and Filament's file generators), `route:cache`, `config:clear`, `view:clear`; Vite; stopping a process, or restarting one that's running (so Claude can reload the worker after changing job code) | No |
| Reaches past the folder: the database, the queue, the cache | `migrate`, `queue:retry` (and the queue tool's retry), `queue:work`, `queue:restart`, `schedule:run`/`test`/`work`, `cache:clear`, `optimize:clear`, Horizon's `terminate`/`pause`/`continue`, `test` unless `phpunit.xml` sends the tests to an in-memory database (`RefreshDatabase` would reset a real one), and any artisan command lara-cc doesn't know to stay in the folder (a package's own, such as `make:filament-user`); starting the queue worker, Horizon or the scheduler; `/lara-composer` and `/lara-npm` when you didn't type them | Yes |
| Prints secrets | `config:show`, `db:show` | Yes, and the output is shown only to you, in full, on the pane's Commands tab |
| Can destroy data or run any code | `migrate:fresh` and the other rollbacks, `db:wipe`, `db:seed`, `tinker`, `--force`, `--env`… (listed above) | Refused |

The question names the command, what it does, `APP_ENV`, and which of the app's servers lara-cc found on this machine (driver and port only; if it hasn't read them yet or couldn't, it says so, and if `artisan about` has failed since, how old `APP_ENV` is), because a database or cache can be shared or not on this machine at all, and `APP_ENV=local` doesn't prove otherwise. **Don't run** sends Claude a refusal it's told not to retry. With nobody to answer (`claude -p`), the answer is no. What you press in the pane or the band, and commands you type, never ask.

These checks cover lara-cc's own tools and commands only. Claude Code's Bash and Read tools are separate: Claude could still run `php artisan migrate:fresh` or read `.env` through them if your permissions allow it. To block that, add deny rules to your Claude Code settings (`.claude/settings.json` in the project, or `~/.claude/settings.json`):

```json
{
  "permissions": {
    "deny": [
      "Bash(php artisan migrate:fresh:*)",
      "Bash(php artisan migrate:refresh:*)",
      "Bash(php artisan migrate:reset:*)",
      "Bash(php artisan migrate:rollback:*)",
      "Bash(php artisan db:wipe:*)",
      "Bash(php artisan db:seed:*)",
      "Bash(php artisan tinker:*)",
      "Bash(php artisan config:show:*)",
      "Bash(php artisan queue:retry:*)",
      "Read(./.env)",
      "Read(./.env.*)"
    ]
  }
}
```

Deny rules match a command's beginning, so they're a speed bump rather than a wall (`php -r`, a script or another spelling gets past them). Keep Claude Code asking before Bash commands you haven't allowed if that matters to you.

## Privacy

Laravel logs and failed-job exceptions can contain confidential data: email addresses, SQL values, tokens, request data. The mod reads them to show you the Log and Queue tabs, toasts and the band, and none of that goes to Claude.

They reach Claude only through the `logs` and `queue` tools, `/lara-logs`, `/lara-queue failed`, Laravel Boost's log tools, a Herd debug session's **ask Claude**, and the other **ask Claude** buttons. Each time, the mod first asks you in a dialog that explains this: **Send redacted**, **Allow this session**, or **Don't send**. If you dismiss the dialog, or nobody is there to answer (`claude -p`), nothing is sent.

Before anything is sent, and in every command output that goes into the conversation (artisan, tests, npm, Composer, process output, error messages), the mod hides what looks confidential:

- passwords, tokens, keys, cookies, signatures and usernames by name, in `.env` lines, headers, query strings, PHP arrays, JSON (also JSON escaped inside a string) and PHP-serialized queue payloads
- hosts other than this machine (`localhost`, `127.0.0.1`, `::1`): under a host key (`Host:`, `DB_HOST=`, `"host":`), after a URL's user, in server URLs like `tcp://10.0.0.5:6379`, and in database connection errors
- credentials in URLs and DSNs (a password containing `@` included), bearer and basic auth, the user in digest auth, `base64:` keys
- tokens recognisable by their shape: AWS key ids, Stripe and Slack keys, GitHub tokens, JWTs, and other long random strings
- email addresses, SQL values (the statement is kept up to `where`/`values`/`set`), the user named in a database login error, and stack frame arguments

Long output is redacted whole and only then shortened, so a cut can't separate a key from its value or leave a piece of a token too short to recognise. The tests feed representative secrets through every way text reaches Claude.

**Redaction is best effort, not a guarantee.** It recognises secrets by their name or shape, and can't know that an unlabelled value in your data is confidential. That's why logs and exceptions still need your yes.

The route list (the Routes tab, `/lara-routes` and the `routes` tool) comes from PHP with `route:list`'s columns plus file paths, line numbers, parameter names and the name of the editor `config/app.php` sets. A route's domain stays in PHP: the tab only says a route has its own. To open a page, the mod hands PHP only the route's place in the list and the values you typed; Laravel builds the URL from `APP_URL` and PHP opens it in the browser, so the URL never reaches the mod or Claude. When the routes can't be read, the reason Claude gets is redacted.

Whatever goes into the conversation, from Claude's tools or from slash commands you type, gets these rules; what lara-cc shows only to you, in its pane, can be complete. The mod never reads `.env`. Outside the mod, Claude Code's own Read and Bash tools can still open `storage/logs` or run `php artisan config:show` if you allow them; add deny rules in your Claude Code permissions to block that.

## Settings

Toggles on the **Services** tab, remembered between sessions: restart queue on PHP edits, syntax check after each turn, Pint after each turn (when `vendor/bin/pint` exists), error toasts, status band, and autostart per process (per project).

## Requirements

macOS or Linux (log following uses `tail -F`), PHP on your `PATH` (or Herd), and a Laravel app with `artisan` in the folder you start Claude Code from. Queue job tracking reads `queue:work` output; with Horizon you still get pending and failed jobs.

**Compatibility.** Needs Claude Code v2.1.295 or later; last validated on v2.1.296. CI validates the mod and runs its tests on both on every push and pull request (older versions can't draw the pane's Routes tab). Mod APIs are early access and can change between Claude Code releases, so a newer version may need a lara-cc update.

## Customise

Everything lives in `hooks/register.tsx`. Edit `SERVICES` (add Reverb, Pail, `php artisan serve`…), `QUICK` (the numbered buttons on the Commands tab), and `DESTRUCTIVE` / `DESTRUCTIVE_OPTIONS` (what Claude's `artisan` tool refuses) at the top of the file.

## Develop

```bash
git clone https://github.com/markszymik/lara-cc ~/mods/lara-cc
cd ~/Sites/your-laravel-app
claude --plugin-dir ~/mods/lara-cc   # hot-reloads on save

claude plugin validate --strict ~/mods/lara-cc   # what it hooks and calls
claude plugin test ~/mods/lara-cc                # tests/ (stubbed php, no real processes)
npx -y -p typescript@5.6.3 tsc -p ~/mods/lara-cc --noEmit   # type check
```

CI runs the validate and test commands on every push and pull request. Run the type check yourself: it needs the API types Claude Code writes to `.claude-plugin/types/` once it has loaded the mod, and a `tsconfig.json` of `{ "extends": "./.claude-plugin/types/tsconfig.json" }`. Both are gitignored, so create the `tsconfig.json` in your clone. A release needs all three to pass, the type check with no errors.

Issues and PRs welcome.

## License

MIT. See [LICENSE](LICENSE).
