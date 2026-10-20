# Woreda

A Bun/TypeScript CLI for the whole lifecycle of GitHub Actions self-hosted runners:
add a machine, install and register runners, monitor real service health, inspect
jobs and logs, manage labels, update or repair services, and remove registrations.

One TypeScript entry point compiles into a standalone executable. Uses Zega CLI’s
stack and conventions: Bun, Commander commands, Inquirer setup prompts, Zod input
validation, JSON by default (coloured and indented in terminals, compact in pipes), `--human` for readable help and command output, `--nopretty` for compact JSON everywhere, and nonzero exit codes on failure.
No dashboard server, remote Bun/Python installation, or separate runner database.

## Install

Download an executable from [Releases](https://github.com/addiscorp/woreda/releases),
make it executable, and put it on your PATH. The compiled executable does not need Bun.
Or use the source:

```sh
bun install
bun src/woreda.ts --help
bun run build darwin-arm64  # choose your controller’s platform
mkdir -p "$HOME/.local/bin"
install -m 755 dist/woreda-darwin-arm64 "$HOME/.local/bin/woreda"
woreda --version
```

The controller needs [GitHub CLI](https://cli.github.com/) authenticated with
permission to administer the selected repository’s runners or organization runners,
and SSH access to each machine. Authenticate using `gh auth login`.
`gh auth status` confirms your login. Organization registration may require the
classic `admin:org` scope; repository registration requires repository admin access.
Fine-grained tokens need the corresponding GitHub runner administration permissions.

Machines need macOS or Linux with a non-root SSH account, `curl`, `tar`, `base64`,
and a SHA-256 tool (`shasum` or `sha256sum`). Linux also needs systemd and passwordless
sudo for GitHub’s service/dependency scripts. The wizard can install runner OS
libraries on Linux. macOS uses the SDK’s launchd agent in the logged-in user’s
session; it is not a pre-login system daemon. OS provisioning, SSH key distribution,
and project-specific build tools are prerequisites, not silently installed.

## From a new machine to an online runner

```sh
woreda init --human
```

The wizard asks for SSH address, GitHub organization/repository, runner name,
labels, and an access group for organization runners. It checks SSH, detects the
native architecture, downloads the official runner archive, verifies its SHA-256,
registers using a fresh temporary GitHub token, installs its service, and waits for
both a running service and GitHub’s online status. Setup can be retried after a
partial failure; it never replaces another installation with the same name.

For scripts or agents, provide the choices explicitly:

```sh
woreda hosts add builder --ssh sami@builder
woreda add --host builder --scope addiscorp/woreda --name builder \
  --labels woreda,release --install-dependencies
```

Organization runners use selected repository access rather than an unrestricted
new group:

```sh
woreda add --host builder --scope tana3d --name builder \
  --group studio-releases --repos tana3d/studio --allow-public \
  --labels studio,release --install-dependencies
```

An existing group is reused. Requested repositories must already be allowed in
that group; Woreda does not silently broaden existing access. New groups
need `--repos`; public repository access requires `--allow-public`. Route only
trusted workflows to persistent machines. Pull requests from forks must not run
arbitrary code on these hosts.

Use `add ... --dry-run` to inspect the proposed installation without registering,
downloading, or changing access groups. `--version 2.337.0` pins an official SDK
version. `--directory /absolute/path` chooses its installation location. Default:
`~/.local/share/woreda/runners/<scope>--<runner>`.

## Everyday use

```sh
woreda status --human
woreda watch
woreda doctor --human
woreda jobs tana3d/studio
woreda logs tana3d/builder --lines 50
woreda logs tana3d/builder --jobs --follow
woreda restart tana3d/builder
woreda labels tana3d/builder --set studio,release,darwin-x64
woreda update tana3d/builder
woreda repair tana3d/builder
```

`status` joins GitHub registration/connectivity with launchd/systemd state and PID.
A registration on an unconfigured machine stays visible as unmanaged. `watch`
refreshes a terminal dashboard every 15 seconds (or `--interval 5`); when piped,
it writes JSON snapshots. `doctor` exits nonzero for managed unhealthy runners or
failed probes/API lookups. An empty installation is valid; it does not claim to
have executed a workflow. `jobs` provides recent workflow states and links.

`start`, `restart`, `repair`, and `update` verify reconnection after service work.
Stopping, restarting, and updating refuse busy or uncertain runners unless
`--force` is explicitly supplied. `repair` is manual; it never loops restarting
healthy workers. Service managers retain GitHub’s own restart behavior. GitHub’s
SDK also updates automatically; `update` provides explicit maintenance control.

Labels describe routing/capabilities. Adding `darwin-x64` to an Apple Silicon
machine does not change its native architecture: workflows still need to select
an Intel build target and package Intel dependencies.

## Retirement

```sh
woreda remove tana3d/builder --yes
woreda remove tana3d/another-builder --yes --purge
woreda hosts remove builder --yes
```

Removal stops/uninstalls the selected service and unregisters from GitHub, then
verifies both sides. Files are retained by default. `--purge` deletes only an
installation marked as created by Woreda, after successful unregistering.
Removing a machine’s config refuses to abandon remaining runner installations.
Busy workers require `--force`; noninteractive destructive actions require `--yes`.
If the machine cannot be reached, no remote cleanup is claimed; restore SSH access
before removal. For a permanently lost host, `remove <runner> --github-only --yes`
revokes its GitHub registration while explicitly leaving the remote service/files.
`hosts remove <machine> --forget --yes` can then abandon monitoring; it does not
unregister anything. Other organizations’ services on the same machine are untouched.

## Configuration and credentials

Configuration is private JSON at `~/.config/woreda/config.json`. Existing Runnerwatch users continue using `~/.config/runnerwatch/config.json` until a Woreda config exists. Legacy runner directories and managed markers remain supported. `--config`
selects another file. It contains host addresses and installation mappings, not
tokens. Existing `~/actions-runner*` installations are discovered automatically.
Explicit custom roots can be added under each host’s `directories`:

```json
{
  "schema": 1,
  "hosts": {
    "bugsy": {"ssh": "sami@bugsy", "directories": []},
    "demon": {"ssh": "sami@demon", "directories": []}
  },
  "scopes": ["tana3d"],
  "registrations": {}
}
```

GitHub authentication remains in the controller’s `gh` credential store. Only
short-lived SDK registration/removal tokens travel over SSH; they are never saved
in Woreda config or printed. GitHub’s SDK manages its own credentials on the
runner host. Metadata probes never read those credential files. SDK diagnostic
logs can contain operational information, so treat `logs` output accordingly.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

`src/woreda.ts` contains the CLI and exported operations. Builds produce
standalone macOS ARM64/Intel and Linux ARM64/x64 executables in `dist/`. To build
just one: `bun run build darwin-arm64`.

Runner lifecycle and API reference:
[GitHub self-hosted runners](https://docs.github.com/en/rest/actions/self-hosted-runners),
[runner access groups](https://docs.github.com/en/rest/actions/self-hosted-runner-groups),
[services](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application).
