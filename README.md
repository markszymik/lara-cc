# lara-cc

An unofficial [Claude Code](https://code.claude.com) mod for Laravel apps.

> **Unofficial.** This is a community project by [Mark Szymik](https://github.com/markszymik). It is not made, endorsed or supported by Laravel LLC or Anthropic. "Laravel" is a trademark of Laravel LLC and is used here only to describe what the mod works with.

Tooling for Laravel apps inside Claude Code: a `/lara` pane, managed dev processes (queue, Vite, scheduler), artisan/npm/composer commands, and tools Claude can call. It's a [mod](https://code.claude.com/docs/en/plugins/mods/overview), so it runs inside Claude Code and draws its own interface.

## Install

Needs Claude Code v2.1.287 or later (`claude --version`). In a Claude Code terminal session, run:

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

**Status band.** One line above the prompt, shown only when there's something to know: running processes, queue totals, new errors, failed jobs, pending migrations. Press **open** to jump to the right tab.

It also flags the things that make a change "not work" without an error, and the Services tab explains each one and how to fix it:

- **A process that crashed**, e.g. `✗ vite exited (1)`, until you open the Services tab.
- **`public/hot` with no Vite behind it**: pages load without CSS and JS. Vite running in another terminal counts; only dev servers on this machine (`localhost`, `*.test`) are ever checked.
- **Cached config, routes or events**: edits to them don't take effect until the cache is cleared.
- **Maintenance mode**, and **APP_ENV=production** on your machine (read from `artisan about`, not from `.env`).
- **`composer install needed`** when `vendor/` differs from `composer.lock`, and **`npm install needed`** when `node_modules` differs from `package-lock.json` (for pnpm, Yarn and Bun, when `node_modules` is missing), e.g. after a `git pull`.

The checks run at start-up, after each of Claude's turns, after commands and every minute. They read lockfiles and Laravel's marker files, never `.env`.

**Dev processes.** Queue worker (or Horizon), Vite and the scheduler, started and stopped from the **Services** tab or commands, with their output. Tick **autostart** to start them whenever you open Claude Code in this project.

**After Claude edits PHP.** The queue worker restarts so it runs the new code (on by default). Optionally, Pint formats the files Claude changed at the end of each turn (off by default).

**Herd's PHP version.** When the `php` on your PATH is [Laravel Herd](https://herd.laravel.com)'s, artisan, Composer, Pint and the managed processes run on the PHP binary Herd serves your site with, so an isolated site (`herd isolate 8.3`) gets its own version even when `php` in your shell is another one. The Services tab shows which version, and says when your shell's `php` differs. If your PATH `php` comes from somewhere else (Homebrew, asdf), the mod keeps using it. The mod asks Herd only about the current folder: it reads no site list and no `.env`.

**At start-up** it checks `migrate:status` and tells you about pending migrations.

## Commands

| Command | What it does |
| --- | --- |
| `/lara [tab]` | Opens the pane: Services, Queue, Log, Routes, Commands, About (hotkeys `s q l r c a`) |
| `/lara-logs [errors\|warnings\|all] [count]` | Recent log entries in the transcript, so Claude sees them too (default: last 5 errors) |
| `/lara-queue [start\|stop\|restart\|logs\|status\|failed\|retry <id\|all>]` | Queue worker (`queue:work`, or `horizon` if installed) and failed jobs |
| `/lara-vite [start\|stop\|restart\|logs]` | `npm run dev` (pnpm/yarn/bun detected from the lockfile) |
| `/lara-schedule [start\|stop\|restart\|logs]` | `schedule:work` |
| `/lara-artisan <args>` | `php artisan <args> --no-interaction`; output goes to the transcript so Claude sees it |
| `/lara-test [args]` | `php artisan test`, e.g. `/lara-test --filter=OrderTest` |
| `/lara-routes [filter]` | Route list, filtered |
| `/lara-npm <script>` | `npm run <script>` (defaults to `build`) |
| `/lara-composer <args>` | Composer |

Type `/lar` to see them all. Processes run for the life of the session and stop when it ends. `/lara`, `/lara-logs`, `/lara-queue`, `/lara-vite` and `/lara-schedule` work while Claude is mid-turn.

## What Claude gets

- **`logs` tool**: recent log entries with where they happened and the stack, so Claude can check for errors after running code or tests.
- **`queue` tool**: pending jobs, jobs run this session, failed jobs with their exceptions, and retrying them.
- **`artisan` tool**: runs artisan commands. Refuses anything that can destroy data or run arbitrary code: `migrate:fresh/reset/refresh/rollback`, `db:wipe`, `db:seed`, `key:generate`, `down`, `queue:flush/clear/forget`, the `prune`/`clear` commands of the queue, models, Horizon, Telescope and Pulse, `tinker`, and the `--force`, `--env`, `--prune` and `--seed` options. Artisan resolves the command name first, so abbreviations like `migr:fr` are caught too. Run those yourself with `/lara-artisan`, which skips the check only when you type it (not when it's relayed from another session, a channel or a plugin).
- **`service` tool**: start, stop, restart or read the output of the queue worker, Vite and the scheduler.
- **`routes` tool**: filtered route list.

## Settings

Toggles on the **Services** tab, remembered between sessions: restart queue on PHP edits, Pint after each turn (when `vendor/bin/pint` exists), error toasts, status band, and autostart per process (per project).

## Requirements

macOS or Linux (log following uses `tail -F`), PHP on your `PATH` (or Herd), and a Laravel app with `artisan` in the folder you start Claude Code from. Queue job tracking reads `queue:work` output; with Horizon you still get pending and failed jobs.

## Customise

Everything lives in `hooks/register.tsx`. Edit `SERVICES` (add Reverb, Pail, `php artisan serve`…), `QUICK` (the numbered buttons on the Commands tab), and `DESTRUCTIVE` / `DESTRUCTIVE_OPTIONS` (what Claude's `artisan` tool refuses) at the top of the file.

## Develop

```bash
git clone https://github.com/markszymik/lara-cc ~/mods/lara-cc
cd ~/Sites/your-laravel-app
claude --plugin-dir ~/mods/lara-cc   # hot-reloads on save

claude plugin validate ~/mods/lara-cc   # what it hooks and calls
claude plugin test ~/mods/lara-cc       # tests/ (stubbed php, no real processes)
```

Built and tested against Claude Code 2.1.296. Mod APIs can change between releases; issues and PRs welcome.

## License

MIT. See [LICENSE](LICENSE).
