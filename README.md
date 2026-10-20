# Woreda

**GitHub Actions self-hosting.** Set up your own runners, see whether they're working, and manage them from your terminal.

## Get started

Install [Bun](https://bun.sh) and the [GitHub CLI](https://cli.github.com/), then:

```sh
npm install -g woreda
gh auth login
woreda init --human
```

Version 6 is the new runner management CLI; earlier npm releases were a different project. Prefer a single executable? Use the [standalone downloads](https://github.com/addiscorp/woreda/releases/tag/v6.0.0), which do not need Bun.

The setup wizard asks which machine to connect to and which GitHub repository or organization it should work for. For example: `sami@bugsy` and `tana3d/studio`. It installs GitHub's runner, starts the service, and checks that GitHub sees it online.

Your machine needs to be reachable over SSH first. macOS and Linux runners are supported; Linux needs systemd and passwordless sudo. Your GitHub login needs permission to manage the selected runners.

## See what's happening

Show each runner and whether it's idle, busy or stopped:

```sh
woreda status --human
```

Keep a live dashboard open:

```sh
woreda watch
```

Check for problems:

```sh
woreda doctor --human
```

## Add a machine that already has runners

```sh
woreda hosts add bugsy --ssh sami@bugsy
woreda status --human
```

Existing installations in `~/actions-runner*` are discovered automatically. Adding a machine here does not create a new runner.

## Add another runner

Use the wizard again:

```sh
woreda add --human
```

Or tell it exactly what to set up. This adds a machine called `builder`, then registers it for one repository:

```sh
woreda hosts add builder --ssh sami@builder
woreda add --host builder --scope tana3d/studio --name builder --labels studio --install-dependencies
```

## Inspect a job or restart a runner

```sh
woreda jobs tana3d/studio --human
woreda logs tana3d/studio/builder --lines 50
woreda restart tana3d/studio/builder --human
```

Copy the runner name from `woreda status` when using logs, restart, update or removal. Repository runners use `owner/repo/runner`; organization runners use `org/runner`. Woreda refuses to interrupt a busy runner by default.

## Update, repair or remove

```sh
woreda update tana3d/studio/builder --human
woreda repair tana3d/studio/builder --human
woreda remove tana3d/studio/builder --yes
```

Removal unregisters the runner and removes its service, keeping its files. Add `--purge` to delete an installation created by Woreda too.

## More details

Output is JSON by default: coloured and indented in a terminal, compact when piped or saved to a file. Use `--human` for readable help, tables and text. `--json` overrides `--human`; `--nopretty` forces compact, uncoloured JSON.

```sh
woreda --human                   # readable help with a yellow banner in a terminal
woreda hosts list                # pretty JSON in a terminal
woreda hosts list > hosts.json   # compact JSON in a file
woreda hosts list --nopretty      # compact JSON everywhere
```

Help stays indented when piped unless `--nopretty` is supplied. Banners appear only in terminals and are omitted with `--json` or `--nopretty`. JSON watch output is one compact snapshot per line. The detailed [reference](docs/reference.md) covers access groups, labels, configuration, credentials, custom folders and recovery.

To develop locally:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

The CLI lives in one TypeScript file, `src/woreda.ts`. Standalone releases include the runtime. No dashboard server or separate database is needed.

For releases, see [npm publishing](docs/publishing.md).
