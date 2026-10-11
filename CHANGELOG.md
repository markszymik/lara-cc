# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
