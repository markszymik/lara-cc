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

## Commands

| Command | What it does |
| --- | --- |
| `/laravel` | Opens the pane: Services, Commands, Routes, Log, About (hotkeys `s c r l a`) |
| `/laravel-queue [start\|stop\|restart\|logs]` | Queue worker (`queue:work`, or `horizon` if installed) |
| `/laravel-vite [start\|stop\|restart\|logs]` | `npm run dev` (pnpm/yarn/bun detected from the lockfile) |
| `/laravel-schedule [start\|stop\|restart\|logs]` | `schedule:work` |
| `/laravel-artisan <args>` | `php artisan <args> --no-interaction`; output goes to the transcript so Claude sees it |
| `/laravel-routes [filter]` | Route list, filtered |
| `/laravel-npm <script>` | `npm run <script>` (defaults to `build`) |
| `/laravel-composer <args>` | Composer |

Type `/lar` to see them all. Processes run for the life of the session and stop when it ends. `/laravel`, `/laravel-queue`, `/laravel-vite` and `/laravel-schedule` work while Claude is mid-turn.

## What Claude gets

- **`artisan` tool**: runs artisan commands. Refuses `migrate:fresh/reset/refresh/rollback`, `db:wipe`, `db:seed`, `key:generate` and `down`; run those yourself with `/laravel-artisan`.
- **`service` tool**: start, stop, restart or read logs of the queue worker, Vite and the scheduler.
- **`routes` tool**: filtered route list.
- **Queue auto-restart**: when Claude edits a `.php` file while the queue worker runs, the worker restarts 2s later so it picks up the new code. Toggle it on the Services tab.

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
