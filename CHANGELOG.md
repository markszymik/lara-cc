# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security

- Claude's `artisan` tool now asks artisan to resolve the command name before checking it, so abbreviations (`migr:fr`, `d:w`), odd casing (`MIGRATE:FRESH`) and leading options (`-q migrate:fresh`) can no longer bypass the destructive-command guard.
- The `artisan` tool refuses `tinker`, which runs arbitrary PHP; the tool's description no longer suggests it.
- The `artisan` tool refuses `--force`/`-f`, `--env`, `--prune`, `--seed` and `--seeder` on any command, and more destructive commands: `queue:forget`, `queue:prune-failed`, `queue:prune-batches`, `model:prune`, `horizon:clear`, `horizon:forget`, `telescope:clear`, `telescope:prune` and `pulse:clear`.
- `/laravel-artisan` skips the guard only when you type it; runs relayed from another session, a channel or a plugin get the same check as Claude's tool.
