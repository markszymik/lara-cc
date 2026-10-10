# Laravel mod for Claude Code (unofficial)

> **Unofficial.** This is a community project by [Mark Szymik](https://github.com/markszymik). It is not made, endorsed or supported by Laravel or Anthropic. "Laravel" is a trademark of its owner and is used here only to describe what the mod works with.

Laravel tooling inside [Claude Code](https://code.claude.com): a `/laravel` pane, managed dev processes (queue, Vite, scheduler), artisan/npm/composer commands, and tools Claude can call. It's a [mod](https://code.claude.com/docs/en/plugins/mods/overview), so it runs inside Claude Code and draws its own interface.

## Install

Needs Claude Code v2.1.287 or later (`claude --version`). In a Claude Code terminal session, run:

```
/plugin install laravel --marketplace markszymik/claude-code-laravel
```

Answer `y` to add the marketplace, then press Enter to install for your user. It's active straight away and loads in every session after that. To update later, run `/plugin`, open the **Installed** tab, and update it there.

Start Claude Code from your Laravel project's root (the folder with `artisan`).

> A mod is code that runs with your permissions: it starts processes and reads files in your project. Read `hooks/register.tsx` before installing if you want to see exactly what it does, or run `claude plugin validate` on a clone to list every call it makes.

## What you get

**Live log monitoring.** The mod follows the newest `storage/logs/laravel*.log` (single or daily channel) for the whole session. New errors pop up as a toast and a count in the status band. The **Log** tab shows entries coloured by level, with filters (all / warnings+ / errors). Each error shows where it happened, pointing at your own code rather than the `vendor/` frame it was thrown from. **ask Claude about latest error** sends the error and its stack to Claude to fix.

**Queue monitoring.** While the mod runs your queue worker, the **Queue** tab shows each job as it runs, finishes or fails, with timings and session totals. It also shows pending jobs per queue and your stored failed jobs (read from the app itself, so any failed-job driver works), each with **retry**, **forget** and **ask Claude**. A failing job raises a toast. If `QUEUE_CONNECTION=sync`, it tells you a worker isn't needed.

**Status band.** One line above the prompt, shown only when there's something to know: running processes, queue totals, new errors, failed jobs, pending migrations. Press **open** to jump to the right tab.

**Dev processes.** Queue worker (or Horizon), Vite and the scheduler, started and stopped from the **Services** tab or commands, with their output. Tick **autostart** to start them whenever you open Claude Code in this project.

**After Claude edits PHP.** The queue worker restarts so it runs the new code (on by default). Optionally, Pint formats the files Claude changed at the end of each turn (off by default).

**At start-up** it checks `migrate:status` and tells you about pending migrations.

## Commands

| Command | What it does |
| --- | --- |
| `/laravel [tab]` | Opens the pane: Services, Queue, Log, Routes, Commands, About (hotkeys `s q l r c a`) |
| `/laravel-logs [errors\|warnings\|all] [count]` | Recent log entries in the transcript, so Claude sees them too (default: last 5 errors) |
| `/laravel-queue [start\|stop\|restart\|logs\|status\|failed\|retry <id\|all>]` | Queue worker (`queue:work`, or `horizon` if installed) and failed jobs |
| `/laravel-vite [start\|stop\|restart\|logs]` | `npm run dev` (pnpm/yarn/bun detected from the lockfile) |
| `/laravel-schedule [start\|stop\|restart\|logs]` | `schedule:work` |
| `/laravel-artisan <args>` | `php artisan <args> --no-interaction`; output goes to the transcript so Claude sees it |
| `/laravel-test [args]` | `php artisan test`, e.g. `/laravel-test --filter=OrderTest` |
| `/laravel-routes [filter]` | Route list, filtered |
| `/laravel-npm <script>` | `npm run <script>` (defaults to `build`) |
| `/laravel-composer <args>` | Composer |

Type `/lar` to see them all. Processes run for the life of the session and stop when it ends. `/laravel`, `/laravel-logs`, `/laravel-queue`, `/laravel-vite` and `/laravel-schedule` work while Claude is mid-turn.

## What Claude gets

- **`logs` tool**: recent log entries with where they happened and the stack, so Claude can check for errors after running code or tests.
- **`queue` tool**: pending jobs, jobs run this session, failed jobs with their exceptions, and retrying them.
- **`artisan` tool**: runs artisan commands. Refuses `migrate:fresh/reset/refresh/rollback`, `db:wipe`, `db:seed`, `key:generate`, `down` and `queue:flush/clear`; run those yourself with `/laravel-artisan`.
- **`service` tool**: start, stop, restart or read the output of the queue worker, Vite and the scheduler.
- **`routes` tool**: filtered route list.

## Settings

Toggles on the **Services** tab, remembered between sessions: restart queue on PHP edits, Pint after each turn (when `vendor/bin/pint` exists), error toasts, status band, and autostart per process (per project).

## Requirements

macOS or Linux (log following uses `tail -F`), PHP on your `PATH`, and a Laravel app with `artisan` in the folder you start Claude Code from. Queue job tracking reads `queue:work` output; with Horizon you still get pending and failed jobs.

## Customise

Everything lives in `hooks/register.tsx`. Edit `SERVICES` (add Reverb, Pail, `php artisan serve`…), `QUICK` (the numbered buttons on the Commands tab) and `DESTRUCTIVE` at the top of the file.

## Develop

```bash
git clone https://github.com/markszymik/claude-code-laravel ~/mods/laravel
cd ~/Sites/your-laravel-app
claude --plugin-dir ~/mods/laravel   # hot-reloads on save

claude plugin validate ~/mods/laravel   # what it hooks and calls
claude plugin test ~/mods/laravel       # tests/ (stubbed php, no real processes)
```

Built and tested against Claude Code 2.1.296. Mod APIs can change between releases; issues and PRs welcome.

## License

MIT. See [LICENSE](LICENSE).
