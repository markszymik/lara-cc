# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
