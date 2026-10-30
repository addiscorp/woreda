#!/usr/bin/env bun
/** One Bun/TypeScript entry point, also compiled into a standalone executable. */
import { Command, Help, InvalidArgumentError } from 'commander'
import chalk, { Chalk } from 'chalk'
import inquirer from 'inquirer'
import { z } from 'zod'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pkg from '../package.json'
import type { RunnerState } from 'mirab/runner'
import { buildImages, defaultMirabConfig, installService, pools, serve } from './runners.ts'
import { WOREDA_CLIENT_ID, defaultLoginFile, deviceLogin, logout } from './forges/github-login.ts'

const identifier = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/)
const scopeSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/)
const addressSchema = z.string().regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/)
const directorySchema = z.string().regex(/^\/(?:[^\x00-\x1f]+)$/).refine(path => !path.split('/').includes('..') && path !== '/', 'Use an absolute runner directory, without ..')
const hostSchema = z.object({ ssh: addressSchema, directories: z.array(directorySchema).default([]) })
const configSchema = z.object({ schema: z.literal(1), hosts: z.record(identifier, hostSchema), scopes: z.array(scopeSchema), registrations: z.record(z.string(), z.object({ host: identifier, directory: directorySchema })).default({}) })
export type Settings = z.infer<typeof configSchema>
export type Host = z.infer<typeof hostSchema>
export type LocalRunner = { scope: string; name: string; id: number; directory: string; unit: string; active: boolean; state: string; pid: number | null }
export type Machine = { os: string; arch: string; home: string; user: string; reachable: boolean; prerequisites: string[]; runners: LocalRunner[]; error?: string }
export type GitHubRunner = { id: number; name: string; os: string; status: string; busy: boolean; labels: { name: string; type: string }[] }
export type Row = { selector: string; scope: string; name: string; id?: number; host: string | null; os?: string; arch?: string; status: string; githubStatus?: string; busy: boolean | null; labels: string[]; service: LocalRunner | null }
export type Snapshot = { hosts: Record<string, Machine>; runners: Row[]; errors: { target: string; message: string }[] }
type Globals = { config?: string; human?: boolean; nopretty?: boolean; json?: boolean }
type Group = { id: number; name: string; visibility: string; allows_public_repositories: boolean; inherited?: boolean }
type Archive = { url: string; sha256: string; version: string }
const sensitive = new Set<string>()
export const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export function redact(value: string) { for (const secret of sensitive) if (secret) value = value.replaceAll(secret, '[redacted]'); return value }
export const endpoint = (scope: string) => `${scope.includes('/') ? 'repos' : 'orgs'}/${scopeSchema.parse(scope)}/actions`
export const defaultConfigPath = (home = homedir()) => {
    const current = join(home, '.config', 'woreda', 'config.json')
    const legacy = join(home, '.config', 'runnerwatch', 'config.json')
    return !existsSync(current) && existsSync(legacy) ? legacy : current
}
const configPath = () => program.opts<Globals>().config ?? defaultConfigPath()

export async function loadSettings(path = configPath()): Promise<Settings> {
    try { return configSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1, hosts: {}, scopes: [], registrations: {} }; throw error }
}
export async function saveSettings(settings: Settings, path = configPath()) {
    configSchema.parse(settings)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, path)
}
export async function execute(args: string[], stdin?: string, timeout = 30_000): Promise<string> {
    const child = Bun.spawn(args, { stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' })
    let expired = false
    const timer = setTimeout(() => { expired = true; child.kill() }, timeout)
    try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        if (expired) throw Error(`${args[0]} timed out after ${Math.round(timeout / 1000)} seconds.`)
        if (code) throw Error(redact((err || out || `${args[0]} failed (${code})`).trim().slice(-1600)))
        return out
    } finally { clearTimeout(timer) }
}
export async function gh<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const out = await execute(['gh', 'api', '-X', method, path, ...(body === undefined ? [] : ['--input', '-'])], body === undefined ? undefined : JSON.stringify(body))
    return out.trim() ? JSON.parse(out) as T : undefined as T
}
async function pages<T>(path: string, key: string): Promise<T[]> {
    const output: T[] = []
    for (let page = 1; ; page++) {
        const data = await gh<Record<string, unknown>>(`${path}?per_page=100&page=${page}`)
        const entries = data[key] as T[]
        output.push(...entries)
        if (!entries.length || output.length >= Number(data.total_count)) return output
    }
}
export const listRunners = (scope: string) => pages<GitHubRunner>(`${endpoint(scope)}/runners`, 'runners')
const sshArgs = (host: Host) => ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', addressSchema.parse(host.ssh)]
export const remote = (host: Host, script: string, timeout = 30_000) => execute([...sshArgs(host), 'sh -s'], script, timeout)
export async function stream(host: Host, script: string) {
    const child = Bun.spawn([...sshArgs(host), 'sh -s'], { stdin: new TextEncoder().encode(script), stdout: 'inherit', stderr: 'inherit' })
    const cancel = () => child.kill()
    process.on('SIGINT', cancel)
    try { if (await child.exited) throw Error('Remote log stream ended with an error.') } finally { process.off('SIGINT', cancel) }
}

/** The probe uses only POSIX shell tools; a new host does not need Bun or Python. */
export function probeScript(directories: string[] = []): string {
    for (const directory of directories) directorySchema.parse(directory)
    return `set -eu
enc() { printf '%s' "$1" | base64 | tr -d '\\r\\n'; }
os=$(uname -s); arch=$(uname -m)
printf 'RW_HOST\\t%s\\t%s\\t%s\\t%s\\n' "$os" "$arch" "$(enc "$HOME")" "$(id -un)"
for tool in curl tar base64; do command -v "$tool" >/dev/null 2>&1 || printf 'RW_MISSING\\t%s\\n' "$tool"; done
if [ "$os" = Linux ]; then
 command -v systemctl >/dev/null 2>&1 || printf 'RW_MISSING\\tsystemctl\\n'
 sudo -n true 2>/dev/null || printf 'RW_MISSING\\tpasswordless-sudo\\n'
fi
for directory in "$HOME"/actions-runner* "$HOME"/.local/share/woreda/runners/* "$HOME"/.local/share/runnerwatch/runners/* ${directories.map(shell).join(' ')}; do
 [ -f "$directory/.runner" ] || continue
 unit=''; [ ! -f "$directory/.service" ] || unit=$(cat "$directory/.service")
 installed=0
 if [ "$os" = Darwin ]; then [ ! -f "$unit" ] || installed=1; else case "$unit" in actions.runner.*) [ ! -f "/etc/systemd/system/$unit" ] || installed=1;; esac; fi
 state='not-installed'; pid='0'
 if [ "$os" = Darwin ]; then
  unit=\${unit##*/}; unit=\${unit%.plist}
  case "$unit" in actions.runner.*)
   text=$(launchctl print "gui/$(id -u)/$unit" 2>/dev/null || true)
   pid=$(printf '%s\\n' "$text" | awk '/^[[:space:]]*pid = / {print $3; exit}')
   if [ -n "$pid" ] && [ "$pid" != 0 ]; then state=running; else state=stopped; pid=0; fi;; esac
 else
  case "$unit" in actions.runner.*)
   state=$(systemctl is-active "$unit" 2>/dev/null || true)
   pid=$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true);;
  esac
 fi
 if [ "$installed" = 0 ]; then state=not-installed; pid=0; fi
 printf 'RW_RUNNER\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(enc "$directory")" "$(enc "$unit")" "$state" "\${pid:-0}" "$(base64 < "$directory/.runner" | tr -d '\\r\\n')"
done
`
}
export function parseProbe(text: string): Machine {
    const machine: Machine = { os: '', arch: '', home: '', user: '', reachable: true, prerequisites: [], runners: [] }
    const decode = (text: string) => Buffer.from(text, 'base64').toString('utf8')
    for (const line of text.trim().split('\n')) {
        const [kind, ...fields] = line.split('\t')
        if (kind === 'RW_HOST') { machine.os = fields[0]!; machine.arch = fields[1]!; machine.home = decode(fields[2]!); machine.user = fields[3]! }
        if (kind === 'RW_MISSING') machine.prerequisites.push(fields[0]!)
        if (kind !== 'RW_RUNNER') continue
        const metadata = JSON.parse(decode(fields[4]!).replace(/^\uFEFF/, ''))
        const url = new URL(metadata.gitHubUrl)
        if (url.hostname !== 'github.com' || url.protocol !== 'https:') continue
        const scope = scopeSchema.parse(url.pathname.replace(/^\/|\/$/g, ''))
        const directory = directorySchema.parse(decode(fields[0]!))
        if (machine.runners.some(runner => runner.directory === directory)) continue
        const state = fields[2]!, pid = Number(fields[3]) || null
        machine.runners.push({ scope, name: metadata.agentName, id: metadata.agentId, directory, unit: decode(fields[1]!), state, pid, active: (state === 'running' || state === 'active') && pid !== null })
    }
    if (!machine.os || !machine.home) throw Error('The SSH host did not return a valid woreda probe.')
    return machine
}
export const probe = async (host: Host) => parseProbe(await remote(host, probeScript(host.directories)))
export function runnerHealth(github: GitHubRunner | undefined, local: LocalRunner | null, reachable = true) {
    if (!reachable) return 'unreachable'
    if (local && !local.active) return 'stopped'
    if (!github) return 'unverified'
    if (github.status !== 'online') return local?.active ? 'disconnected' : 'offline'
    return github.busy ? 'busy' : 'idle'
}
export async function snapshot(settings: Settings): Promise<Snapshot> {
    const hosts: Record<string, Machine> = {}, errors: Snapshot['errors'] = []
    await Promise.all(Object.entries(settings.hosts).map(async ([name, host]) => {
        try { hosts[name] = await probe(host) }
        catch (error) { hosts[name] = { os: '', arch: '', home: '', user: '', prerequisites: [], reachable: false, runners: [], error: String(error) }; errors.push({ target: name, message: redact(String(error)) }) }
    }))
    const scopes = new Set([...settings.scopes, ...Object.values(hosts).flatMap(host => host.runners.map(runner => runner.scope))])
    const runners: Row[] = [], matched = new Set<string>()
    await Promise.all([...scopes].map(async scope => {
        try {
            for (const entry of await listRunners(scope)) {
                const selector = `${scope}/${entry.name}`
                const matches = Object.entries(hosts).flatMap(([host, data]) => data.runners.filter(local => local.scope === scope && local.id === entry.id).map(local => ({ host, local })))
                if (matches.length > 1) throw Error(`Duplicate local installations for ${selector}.`)
                const match = matches[0], mapped = settings.registrations[selector]
                const host = match?.host ?? mapped?.host ?? null, local = match?.local ?? null
                if (match) matched.add(`${host}:${local!.directory}`)
                runners.push({ selector, scope, name: entry.name, id: entry.id, host, os: entry.os, arch: host ? hosts[host]?.arch : undefined, status: runnerHealth(entry, local, host ? hosts[host]?.reachable ?? false : true), githubStatus: entry.status, busy: entry.busy, labels: entry.labels.map(label => label.name), service: local })
            }
        } catch (error) { errors.push({ target: scope, message: redact(String(error)) }) }
    }))
    for (const [host, data] of Object.entries(hosts)) for (const local of data.runners) {
        if (!matched.has(`${host}:${local.directory}`)) runners.push({ selector: `${local.scope}/${local.name}`, scope: local.scope, name: local.name, id: local.id, host, os: data.os, arch: data.arch, status: runnerHealth(undefined, local), busy: null, labels: [], service: local })
    }
    return { hosts, runners: runners.sort((a, b) => a.selector.localeCompare(b.selector)), errors }
}
export function select(data: Snapshot, selector: string) {
    const matches = data.runners.filter(row => row.selector === selector)
    if (matches.length !== 1) throw Error('Use a unique full runner ID from status, such as tana3d/bugsy.')
    const runner = matches[0]!
    if (!runner.host || !runner.service) throw Error('This registration is not mapped to an SSH installation. Add its host first.')
    return runner as Row & { host: string; service: LocalRunner }
}
export function assertIdle(runner: Row, data: Snapshot, force = false) {
    if (!force && (runner.busy !== false || runner.githubStatus !== 'online' || data.errors.some(error => error.target === runner.scope || error.target === runner.host))) throw Error('Runner is busy, offline, or its GitHub state is uncertain. --force deliberately bypasses this job guard.')
}
export function serviceScript(directory: string, actions: string[], os: string, user: string): string {
    directorySchema.parse(directory)
    const allowed = ['install', 'start', 'stop', 'uninstall', 'status']
    if (actions.some(action => !allowed.includes(action))) throw Error('Invalid service action.')
    return `set -eu\ncd ${shell(directory)}\n` + actions.map(action => {
        const command = `${os === 'Linux' ? 'sudo -n ' : ''}./svc.sh ${action}${os === 'Linux' && action === 'install' ? ` ${shell(user)}` : ''}`
        // Linux svc.sh stop reports systemctl status's exit 3 even when stopping succeeded.
        if (os === 'Linux' && action === 'stop') return `${command} || { state=$(systemctl show "$(cat .service)" --property=ActiveState --value); case "$state" in inactive|failed) :;; *) exit 1;; esac; }\n`
        return `${command}\n`
    }).join('')
}
async function connected(settings: Settings, host: string, scope: string, name: string, timeout = 60_000) {
    const until = Date.now() + timeout
    do {
        const [machine, entries] = await Promise.all([probe(settings.hosts[host]!), listRunners(scope)])
        const local = machine.runners.find(runner => runner.scope === scope && runner.name === name)
        const github = entries.find(runner => runner.id === local?.id)
        if (local?.active && github?.status === 'online') return { host, selector: `${scope}/${name}`, status: github.busy ? 'busy' : 'idle', pid: local.pid, id: github.id }
        await Bun.sleep(2000)
    } while (Date.now() < until)
    throw Error(`Service setup finished, but ${scope}/${name} did not become online. Use doctor and logs; retry add or repair without creating a second registration.`)
}
async function control(selector: string, action: 'start' | 'stop' | 'restart', force = false) {
    const settings = await loadSettings(), data = await snapshot(settings), runner = select(data, selector)
    if (action !== 'start') assertIdle(runner, data, force)
    if (!/^actions\.runner\.[A-Za-z0-9_.-]+$/.test(runner.service.unit)) throw Error('No installed service. Use repair first.')
    const machine = data.hosts[runner.host]!
    await remote(settings.hosts[runner.host]!, serviceScript(runner.service.directory, action === 'restart' ? ['stop', 'start'] : [action], machine.os, machine.user), 60_000)
    if (action !== 'stop') return connected(settings, runner.host, runner.scope, runner.name)
    const after = await probe(settings.hosts[runner.host]!)
    if (after.runners.find(item => item.directory === runner.service.directory)?.active) throw Error('The service is still running after stop.')
    return { selector, status: 'stopped' }
}
export function platformFor(machine: Pick<Machine, 'os' | 'arch'>): string {
    const os = { Darwin: 'osx', Linux: 'linux' }[machine.os]
    const arch = { arm64: 'arm64', aarch64: 'arm64', x86_64: 'x64', amd64: 'x64', armv7l: 'arm' }[machine.arch]
    if (!os || !arch || (os === 'osx' && arch === 'arm')) throw Error(`Unsupported SSH runner host: ${machine.os} ${machine.arch}. This release manages macOS and Linux.`)
    return `${os}-${arch}`
}
async function archiveFor(machine: Machine, version?: string): Promise<Archive> {
    if (version && !/^\d+\.\d+\.\d+$/.test(version)) throw Error('Use a runner version such as 2.337.0.')
    const release = await gh<{ tag_name: string; assets: { name: string; browser_download_url: string; digest: string | null }[] }>(`repos/actions/runner/releases/${version ? `tags/v${version}` : 'latest'}`)
    const name = `actions-runner-${platformFor(machine)}-${release.tag_name.replace(/^v/, '')}.tar.gz`
    const asset = release.assets.find(asset => asset.name === name)
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw Error('The official runner archive has no verifiable SHA-256 digest; refusing installation.')
    if (!asset.browser_download_url.startsWith('https://github.com/actions/runner/releases/download/')) throw Error('Unexpected runner archive source.')
    return { url: asset.browser_download_url, sha256: asset.digest!.slice(7), version: release.tag_name.slice(1) }
}
export function downloadScript(archive: Archive): string {
    if (!/^[a-f0-9]{64}$/.test(archive.sha256)) throw Error('Invalid archive checksum.')
    return `archive=$(mktemp -d "\${TMPDIR:-/tmp}/woreda.XXXXXX")
trap 'rm -rf "$archive"' EXIT HUP INT TERM
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 ${shell(archive.url)} -o "$archive/runner.tar.gz"
if command -v shasum >/dev/null 2>&1; then sum=$(shasum -a 256 "$archive/runner.tar.gz" | awk '{print $1}'); else sum=$(sha256sum "$archive/runner.tar.gz" | awk '{print $1}'); fi
[ "$sum" = ${shell(archive.sha256)} ] || { echo 'Runner checksum mismatch' >&2; exit 1; }
`
}
type AddOptions = { host?: string; scope?: string; name?: string; labels?: string; group?: string; repos?: string; allowPublic?: boolean; installDependencies?: boolean; directory?: string; version?: string; dryRun?: boolean }
export function labelList(value = ''): string[] {
    const labels = value.split(',').map(label => label.trim()).filter(Boolean)
    if (labels.some(label => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(label))) throw Error('Labels may contain letters, digits, dots, underscores and hyphens.')
    return [...new Set(labels)]
}
async function ensureGroup(scope: string, options: AddOptions, registered?: GitHubRunner) {
    if (scope.includes('/')) { if (options.group || options.repos || options.allowPublic) throw Error('Runner groups apply to organization runners, not repository runners.'); return }
    if (!options.group) throw Error('Organization runners need --group. New groups also need --repos owner/repo,... to restrict access.')
    identifier.parse(options.group)
    const groups = await pages<Group>(`orgs/${scope}/actions/runner-groups`, 'runner_groups')
    const existing = groups.find(group => group.name === options.group)
    const repos = options.repos?.split(',').map(name => name.trim()).filter(Boolean) ?? []
    const ids: number[] = []
    let publicRepo = false
    for (const repo of repos) {
        scopeSchema.parse(repo)
        if (!repo.startsWith(`${scope}/`) || !repo.includes('/')) throw Error('Selected repositories must belong to the organization.')
        const info = await gh<{ id: number; private: boolean }>(`repos/${repo}`)
        ids.push(info.id); publicRepo ||= !info.private
    }
    if (existing) {
        if (existing.inherited) throw Error('An inherited runner group cannot be managed at organization scope.')
        if (ids.length) {
            const allowed = await pages<{ id: number }>(`orgs/${scope}/actions/runner-groups/${existing.id}/repositories`, 'repositories')
            if (ids.some(id => !allowed.some(repo => repo.id === id))) throw Error('The existing group does not allow all selected repositories. Change access explicitly in GitHub; woreda will not silently broaden it.')
        }
        if (publicRepo && !existing.allows_public_repositories) throw Error('This existing group does not allow public repositories.')
        if (registered) {
            const members = await pages<GitHubRunner>(`orgs/${scope}/actions/runner-groups/${existing.id}/runners`, 'runners')
            if (!members.some(member => member.id === registered.id)) throw Error('The existing runner belongs to a different group. Change its access group explicitly in GitHub.')
        }
        return existing
    }
    if (registered) throw Error('Existing registrations cannot be moved into a new group by retrying add.')
    if (!ids.length) throw Error('A new organization runner group needs --repos owner/repo,... .')
    if (publicRepo && !options.allowPublic) throw Error('Public repository access requires --allow-public. Only trusted workflows should use these machines.')
    if (options.dryRun) return { id: 0, name: options.group, visibility: 'selected', allows_public_repositories: !!options.allowPublic }
    return gh<Group>(`orgs/${scope}/actions/runner-groups`, 'POST', { name: options.group, visibility: 'selected', selected_repository_ids: ids, allows_public_repositories: !!options.allowPublic })
}
async function guided(settings: Settings, options: AddOptions): Promise<AddOptions> {
    if (!process.stdin.isTTY) { if (!options.host || !options.scope) throw Error('Noninteractive setup needs --host and --scope. Use hosts add first.'); return options }
    if (!Object.keys(settings.hosts).length) {
        const answers = await inquirer.prompt([{ name: 'name', message: 'Machine name:', validate: (value: string) => identifier.safeParse(value).success || 'Use a simple host name.' }, { name: 'ssh', message: 'SSH address (user@host or SSH alias):', validate: (value: string) => addressSchema.safeParse(value).success || 'Use user@host or an SSH alias.' }])
        await addHost(settings, answers.name, answers.ssh)
    }
    if (!options.host) options.host = (await inquirer.prompt([{ type: 'select', name: 'host', message: 'Which machine?', choices: Object.keys(settings.hosts) }])).host
    if (!options.scope) options.scope = (await inquirer.prompt([{ name: 'scope', message: 'GitHub organization or owner/repository:', validate: (value: string) => scopeSchema.safeParse(value).success || 'Use org or owner/repo.' }])).scope
    if (!options.name) options.name = (await inquirer.prompt([{ name: 'name', message: 'Runner name:', default: options.host, validate: (value: string) => identifier.safeParse(value).success || 'Use a simple runner name.' }])).name
    if (options.scope && !options.scope.includes('/') && !options.group) {
        const groups = await pages<Group>(`orgs/${options.scope}/actions/runner-groups`, 'runner_groups')
        const choice = (await inquirer.prompt([{ type: 'select', name: 'group', message: 'Runner access group:', choices: [...groups.filter(group => !group.inherited).map(group => ({ name: group.name, value: group.name })), { name: 'Create a group restricted to selected repositories', value: '__new' }] }])).group
        if (choice !== '__new') options.group = choice
        else {
            const answers = await inquirer.prompt([{ name: 'group', message: 'New group name:', default: 'woreda' }, { name: 'repos', message: 'Allowed repositories, comma separated (org/repo):' }, { type: 'confirm', name: 'allowPublic', message: 'Allow public repositories? Route only trusted workflows to persistent hosts.', default: false }])
            Object.assign(options, answers)
        }
    }
    if (options.labels === undefined) options.labels = (await inquirer.prompt([{ name: 'labels', message: 'Custom labels, comma separated:', default: 'woreda' }])).labels
    const machine = await probe(settings.hosts[options.host!]!)
    if (machine.os === 'Linux' && options.installDependencies === undefined) options.installDependencies = (await inquirer.prompt([{ type: 'confirm', name: 'install', message: 'Install runner OS dependencies with GitHub’s dependency script and sudo?', default: true }])).install
    return options
}
async function addHost(settings: Settings, name: string, address: string) {
    identifier.parse(name); addressSchema.parse(address)
    if (settings.hosts[name] && settings.hosts[name]!.ssh !== address) throw Error('That machine name already points elsewhere; remove its configuration before reusing it.')
    const host: Host = { ssh: address, directories: settings.hosts[name]?.directories ?? [] }
    const machine = await probe(host)
    platformFor(machine)
    settings.hosts[name] = host
    await saveSettings(settings)
    return { name, ssh: address, os: machine.os, arch: machine.arch, prerequisites: machine.prerequisites }
}
async function addRunner(raw: AddOptions) {
    const settings = await loadSettings(), options = await guided(settings, { ...raw })
    const hostName = identifier.parse(options.host), scope = scopeSchema.parse(options.scope), name = identifier.parse(options.name ?? hostName)
    const host = settings.hosts[hostName]
    if (!host) throw Error('Add this SSH machine with hosts add first.')
    const probeHost = options.directory ? { ...host, directories: [...host.directories, directorySchema.parse(options.directory)] } : host
    const machine = await probe(probeHost), archive = await archiveFor(machine, options.version), labels = labelList(options.labels ?? 'woreda')
    if (machine.user === 'root') throw Error('Use a non-root SSH account for runner installation.')
    if (machine.prerequisites.length) throw Error(`Host prerequisites missing: ${machine.prerequisites.join(', ')}. Fix SSH tools/passwordless sudo before registration.`)
    const directory = options.directory ? directorySchema.parse(options.directory) : `${machine.home}/.local/share/woreda/runners/${scope.replace('/', '--')}--${name}`
    if (directory === machine.home || machine.home.startsWith(directory + '/')) throw Error('Use a dedicated runner subdirectory, not the home directory or its ancestors.')
    const entries = await listRunners(scope), registered = entries.find(entry => entry.name === name)
    const local = machine.runners.find(runner => runner.directory === directory || (runner.scope === scope && runner.name === name))
    if (local && (local.scope !== scope || local.name !== name || local.directory !== directory)) throw Error('An installation already exists at a different path/scope. Use repair or choose a different runner name.')
    if (registered && registered.id !== local?.id) throw Error('This runner name is already registered elsewhere; refusing to replace it.')
    if (local && !registered) throw Error('Local registration is stale or GitHub access is inconsistent. Remove it explicitly before registering again.')
    const group = await ensureGroup(scope, options, registered)
    const plan = { host: hostName, ssh: host.ssh, scope, name, directory, platform: platformFor(machine), version: archive.version, labels, group: group?.name ?? null, installDependencies: !!options.installDependencies, existing: !!local }
    if (options.dryRun) return { dryRun: true, plan }
    progress(`Installing ${scope}/${name} on ${hostName}…`)
    let token = ''
    if (!local) { token = (await gh<{ token: string }>(`${endpoint(scope)}/runners/registration-token`, 'POST')).token; sensitive.add(token) }
    const script = `set -eu
umask 077
RW_TOKEN=${shell(token)}
directory=${shell(directory)}
if [ -e "$directory" ] && [ ! -f "$directory/.runner" ] && [ ! -f "$directory/.woreda-managed" ] && [ ! -f "$directory/.runnerwatch-managed" ] && [ -n "$(ls -A "$directory")" ]; then echo 'Refusing to overwrite a nonempty unmanaged directory' >&2; exit 1; fi
mkdir -p "$directory"
cd "$directory"
if [ ! -f .runner ]; then
 touch .woreda-managed
 ${downloadScript(archive)}
 tar -xzf "$archive/runner.tar.gz" -C "$directory"
 ${machine.os === 'Linux' && options.installDependencies ? 'sudo -n ./bin/installdependencies.sh' : ':'}
 ./config.sh --unattended --url ${shell(`https://github.com/${scope}`)} --token "$RW_TOKEN" --name ${shell(name)} --labels ${shell(labels.join(','))} --work _work ${group ? `--runnergroup ${shell(group.name)}` : ''} > "$archive/config-output" 2>&1 || { echo 'Runner registration failed. The verified SDK and diagnostic logs remain for repair.' >&2; exit 1; }
fi
`
    await remote(host, script, 600_000)
    // Save the mapping before service installation; an interrupted setup can be retried.
    if (!host.directories.includes(directory)) host.directories.push(directory)
    if (!settings.scopes.includes(scope)) settings.scopes.push(scope)
    settings.registrations[`${scope}/${name}`] = { host: hostName, directory }
    await saveSettings(settings)
    const installed = (await probe(host)).runners.find(runner => runner.directory === directory)
    if (!installed) throw Error('Registration did not produce valid local metadata.')
    if (!installed.active) {
        if (installed.unit && installed.state === 'not-installed') await remote(host, `set -eu\ncd ${shell(directory)}\nrm -f .service\n`)
        await remote(host, serviceScript(directory, installed.unit && installed.state !== 'not-installed' ? ['start'] : ['install', 'start'], machine.os, machine.user), 60_000)
    }
    const result = await connected(settings, hostName, scope, name)
    const actualVersion = (await remote(host, `set -eu\ncd ${shell(directory)}\n./bin/Runner.Listener --version\n`)).trim()
    return { ...result, directory, version: actualVersion, labels: registered ? registered.labels.map(label => label.name) : labels, group: group?.name ?? null }
}
async function repairRunner(selector: string, force = false) {
    const settings = await loadSettings(), data = await snapshot(settings), runner = select(data, selector), machine = data.hosts[runner.host]!
    const registered = (await listRunners(runner.scope)).find(entry => entry.id === runner.service.id)
    if (!registered) throw Error('The local runner is not registered in GitHub. Removal and fresh add are required.')
    if (registered.busy && !force) throw Error('Runner has an active job. Use --force to interrupt it deliberately.')
    if (runner.service.active && runner.githubStatus === 'online') return { selector, status: runner.status, changed: false }
    if (runner.service.unit && runner.service.state === 'not-installed') await remote(settings.hosts[runner.host]!, `set -eu\ncd ${shell(runner.service.directory)}\nrm -f .service\n`)
    const actions = runner.service.unit && runner.service.state !== 'not-installed' ? (runner.service.active ? ['stop', 'start'] : ['start']) : ['install', 'start']
    await remote(settings.hosts[runner.host]!, serviceScript(runner.service.directory, actions, machine.os, machine.user), 60_000)
    return { ...await connected(settings, runner.host, runner.scope, runner.name), changed: true }
}
async function updateRunner(selector: string, options: { force?: boolean; version?: string; dryRun?: boolean }) {
    const settings = await loadSettings(), data = await snapshot(settings), runner = select(data, selector), machine = data.hosts[runner.host]!
    assertIdle(runner, data, options.force)
    if (!runner.service.unit) throw Error('Repair the missing service before updating.')
    const archive = await archiveFor(machine, options.version)
    const current = (await remote(settings.hosts[runner.host]!, `set -eu\ncd ${shell(runner.service.directory)}\n./bin/Runner.Listener --version\n`)).trim()
    if (current === archive.version) return { selector, version: current, changed: false }
    if (options.dryRun) return { selector, from: current, to: archive.version, dryRun: true }
    const directory = runner.service.directory, host = settings.hosts[runner.host]!
    progress(`Updating ${selector}: ${current} → ${archive.version}…`)
    // Verify before stopping the service. If extraction fails, attempt to start it again.
    await remote(host, `set -eu\ncd ${shell(directory)}\n${downloadScript(archive)}\n${serviceScript(directory, ['stop'], machine.os, machine.user)}
restart() { ${machine.os === 'Linux' ? 'sudo -n ' : ''}./svc.sh start >/dev/null 2>&1 || true; rm -rf "$archive"; }
trap restart EXIT HUP INT TERM
tar -xzf "$archive/runner.tar.gz" -C ${shell(directory)}
${machine.os === 'Linux' ? 'sudo -n ' : ''}./svc.sh start
trap 'rm -rf "$archive"' EXIT HUP INT TERM
`, 600_000)
    return { ...await connected(settings, runner.host, runner.scope, runner.name), version: archive.version, changed: true }
}
async function confirmRemoval(message: string, yes = false) {
    if (yes) return
    if (!process.stdin.isTTY) throw Error('Removal needs --yes in noninteractive mode.')
    if (!(await inquirer.prompt([{ type: 'confirm', name: 'yes', message, default: false }])).yes) throw Error('Removal cancelled.')
}
async function removeRunner(selector: string, options: { yes?: boolean; force?: boolean; purge?: boolean; githubOnly?: boolean }) {
    const settings = await loadSettings(), data = await snapshot(settings)
    if (options.githubOnly) {
        if (options.purge) throw Error('--github-only cannot delete files on an unreachable host.')
        const rows = data.runners.filter(row => row.selector === selector && row.id && row.githubStatus)
        if (rows.length !== 1) throw Error('Use a unique GitHub registration ID from status.')
        const runner = rows[0]!
        const registered = (await listRunners(runner.scope)).find(entry => entry.id === runner.id)
        if (!registered) throw Error('GitHub registration is already missing.')
        if (registered.busy && !options.force) throw Error('Runner has an active job. --force deliberately interrupts it.')
        await confirmRemoval(`Unregister ${selector} from GitHub ONLY, leaving its remote service and files?`, options.yes)
        await gh(`${endpoint(runner.scope)}/runners/${runner.id}`, 'DELETE')
        if ((await listRunners(runner.scope)).some(entry => entry.id === runner.id)) throw Error('GitHub registration remains after deletion.')
        delete settings.registrations[selector]; await saveSettings(settings)
        return { selector, removed: true, githubOnly: true, serviceRemoved: false, filesRetained: true }
    }
    const runner = select(data, selector), machine = data.hosts[runner.host]!
    const registered = (await listRunners(runner.scope)).find(entry => entry.id === runner.service.id)
    if (!options.force && registered?.busy) throw Error('Runner has an active job. --force deliberately interrupts it.')
    await confirmRemoval(`Stop and unregister ${selector}${options.purge ? ', deleting its managed files' : ', retaining its files'}?`, options.yes)
    const host = settings.hosts[runner.host]!, directory = runner.service.directory
    if (options.purge) await remote(host, `set -eu\n{ [ -f ${shell(`${directory}/.woreda-managed`)} ] || [ -f ${shell(`${directory}/.runnerwatch-managed`)} ]; } || { echo 'Purge is only allowed for directories created by woreda' >&2; exit 1; }\n`)
    const token = registered ? (await gh<{ token: string }>(`${endpoint(runner.scope)}/runners/remove-token`, 'POST')).token : ''
    sensitive.add(token)
    if (runner.service.unit && runner.service.state !== 'not-installed') await remote(host, serviceScript(directory, ['uninstall'], machine.os, machine.user), 60_000)
    // Missing GitHub registration means a stale SDK: remove its local configuration with its documented local mode.
    await remote(host, `set -eu\ncd ${shell(directory)}\nRW_TOKEN=${shell(token)}\n${registered ? './config.sh remove --unattended --token "$RW_TOKEN" >/dev/null' : './config.sh remove --local >/dev/null'}\n`, 60_000)
    if ((await listRunners(runner.scope)).some(entry => entry.id === runner.service.id)) throw Error('GitHub still lists the runner after removal.')
    if ((await probe(host)).runners.some(entry => entry.directory === directory)) throw Error('Local registration remains after removal.')
    if (options.purge) await remote(host, `set -eu\n[ -f ${shell(`${directory}/.woreda-managed`)} ] || [ -f ${shell(`${directory}/.runnerwatch-managed`)} ]\nrm -rf -- ${shell(directory)}\n`)
    delete settings.registrations[selector]
    host.directories = host.directories.filter(path => path !== directory)
    await saveSettings(settings)
    return { selector, removed: true, filesRetained: !options.purge, directory }
}
async function setLabels(selector: string, labels: string) {
    const settings = await loadSettings(), data = await snapshot(settings), runner = select(data, selector)
    if (!runner.id) throw Error('Runner registration is unavailable.')
    const response = await gh<{ labels: { name: string }[] }>(`${endpoint(runner.scope)}/runners/${runner.id}/labels`, 'PUT', { labels: labelList(labels) })
    return { selector, labels: response.labels.map(label => label.name) }
}
async function logs(selector: string, options: { lines: number; follow?: boolean; jobs?: boolean }) {
    const settings = await loadSettings(), data = await snapshot(settings), runner = select(data, selector)
    await stream(settings.hosts[runner.host]!, `set -eu\ncd ${shell(runner.service.directory)}\nlog=$(ls -t _diag/${options.jobs ? 'Worker' : 'Runner'}_*.log 2>/dev/null | head -1)\n[ -n "$log" ] || { echo 'No diagnostic log found' >&2; exit 1; }\ntail -n ${options.lines} ${options.follow ? '-f' : ''} "$log"\n`)
}
async function jobs(scope: string, limit: number) {
    scopeSchema.parse(scope)
    if (!scope.includes('/')) throw Error('Jobs needs owner/repository.')
    const result = await gh<{ workflow_runs: { id: number; name: string; status: string; conclusion: string | null; html_url: string }[] }>(`repos/${scope}/actions/runs?per_page=${limit}`)
    return result.workflow_runs.map(run => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url }))
}
// Same JSON token colours and terminal policy as Zega's CLI.
export function paintJson(text: string): string {
    return text.replace(/("(?:[^"\\]|\\.)*")(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g,
        (found: string, string: string | undefined, colon: string | undefined) => {
            if (string !== undefined) return colon === undefined ? chalk.green(string) : chalk.cyan(string) + chalk.dim(colon)
            return /^[{}[\],:]$/.test(found) ? chalk.dim(found) : chalk.yellow(found)
        })
}
export function formatJson(value: unknown, options: { stream: 'stdout' | 'stderr'; nopretty?: boolean; always?: boolean }): string {
    const terminal = process[options.stream].isTTY === true && options.nopretty !== true
    // Help is indented even when piped; an explicit --nopretty still wins.
    if (options.nopretty || (!terminal && !options.always)) return JSON.stringify(value) + '\n'
    const text = JSON.stringify(value, null, 2)
    return (terminal ? paintJson(text) : text) + '\n'
}
const modes = (): { human: boolean; nopretty: boolean; json: boolean } => {
    const options = program.opts<Globals>(), argv = process.argv.slice(2)
    return { human: (options.human || argv.includes('--human')) && !(options.json || argv.includes('--json')), nopretty: options.nopretty || argv.includes('--nopretty'), json: options.json || argv.includes('--json') }
}
// Zega's five-row Cfh 3 block lettering, with yellow body and a darker shaded edge.
const MARK = {
    W: ['▐██   ▐██', '▐██   ▐██', '▐██▐█ ▐██', '▐██▐█▐██ ', '▐██▐██▐██'],
    O: ['▐██████', '▐██ ▐██', '▐██ ▐██', '▐██ ▐██', '▐██████'],
    R: ['▐██████', '▐██ ▐██', '▐█████ ', '▐██ ▐██', '▐██ ▐██'],
    E: ['▐██████', '▐██    ', '▐████  ', '▐██    ', '▐██████'],
    D: ['▐█████ ', '▐██ ▐██', '▐██ ▐██', '▐██ ▐██', '▐█████ '],
    A: ['▐██████', '▐██ ▐██', '▐██████', '▐██ ▐██', '▐██ ▐██'],
}
export function logo(color?: boolean): string {
    const paint = color === undefined ? chalk : new Chalk({ level: color ? 3 : 0 })
    const main = paint.level >= 3 ? paint.hex('#FFFF55') : paint.yellowBright
    const shade = paint.level >= 3 ? paint.hex('#AA8800') : paint.yellow
    return Array.from({ length: 5 }, (_, row) => '  ' + Object.values(MARK).map(glyph => glyph[row]).join('')
        .replace(/█+|▐+/g, run => run.startsWith('█') ? main(run) : shade(run))).join('\n')
}
const label = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, letter => letter.toUpperCase())
const cell = (value: unknown): string => value === null || value === undefined ? '—' : typeof value === 'boolean' ? value ? 'yes' : 'no' : Array.isArray(value) ? value.map(cell).join(', ') || 'none' : String(value)
export function humanText(value: unknown, indent = ''): string {
    if (Array.isArray(value)) {
        if (!value.length) return indent + 'No entries.'
        if (value.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
            const objects = value as Record<string, unknown>[]
            const keys = [...new Set(objects.flatMap(object => Object.keys(object)))]
            const rows = [keys.map(key => label(key).toUpperCase()), ...objects.map(object => keys.map(key => cell(object[key])))]
            const widths = keys.map((_, index) => Math.max(...rows.map(row => row[index]!.length)))
            return rows.map(row => indent + row.map((entry, index) => entry.padEnd(widths[index]!)).join('  ').trimEnd()).join('\n')
        }
        return value.map(item => indent + '• ' + cell(item)).join('\n')
    }
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value)
        if (!entries.length) return indent + 'No entries.'
        return entries.map(([key, item]) => item !== null && typeof item === 'object' && (!Array.isArray(item) || item.some(entry => typeof entry === 'object'))
            ? indent + label(key) + ':\n' + humanText(item, indent + '  ')
            : indent + label(key) + ': ' + cell(item)).join('\n')
    }
    return indent + cell(value)
}
function progress(message: string) { if (process.stderr.isTTY || modes().human) console.error(message) }
async function write(stream: 'stdout' | 'stderr', text: string) {
    await new Promise<void>(resolve => process[stream].write(text, () => resolve()))
}
async function output(value: unknown, event = false) {
    const options = modes()
    if (options.human) {
        const text = value && typeof value === 'object' && 'runners' in value && 'hosts' in value ? table(value as Snapshot) : humanText(value)
        await write('stdout', text.trimEnd() + '\n'); return
    }
    await write('stdout', formatJson(value, { stream: 'stdout', nopretty: event || options.nopretty }))
}
export function table(data: Snapshot) {
    const columns = [['RUNNER', 'MACHINE', 'STATE', 'SERVICE', 'TARGET LABELS'], ...data.runners.map(row => [row.selector, row.host ?? 'unmanaged', row.status, row.service?.pid ? `PID ${row.service.pid}` : row.service?.state ?? 'unmanaged', row.labels.filter(label => !['self-hosted', 'macOS', 'Linux', 'ARM64', 'X64'].includes(label)).join(', ')])]
    const widths = Array.from({ length: 4 }, (_, i) => Math.max(...columns.map(row => (row[i] ?? '').length)))
    const pools = (data as Snapshot & { pools?: RunnerState[] }).pools ?? []
    const poolLines = pools.length ? '\nVM POOLS (mirab)\n' + pools.map(p => `${p.name}  ${p.forge}  ${p.slots.map(slot => `${slot.vmName} ${slot.phase}`).join(', ') || 'no slot'}  jobs ${p.jobs}${p.lastError ? `  last error: ${p.lastError.message}` : ''}`).join('\n') + '\n' : ''
    return columns.map(row => row.map((cell, index) => index < 4 ? cell.padEnd(widths[index]!) : cell).join('  ')).join('\n') + '\n' + poolLines + data.errors.map(error => `${error.target}: ${error.message}`).join('\n')
}
function integer(name: string, min: number, max: number) {
    return (raw: string) => { const value = Number(raw); if (!Number.isInteger(value) || value < min || value > max) throw new InvalidArgumentError(`${name} must be between ${min} and ${max}.`); return value }
}
export const program = new Command().name('woreda').version(pkg.version).description('Manage GitHub Actions self-hosted runners from setup to retirement')
    .option('--config <path>', 'use a different config file')
    .option('--human', 'readable output for people')
    .option('--json', 'JSON output (the default; overrides --human)')
    .option('--nopretty', 'compact JSON')
    .helpCommand(false)
    .configureOutput({ outputError: (text, write) => { const options = modes(); write(options.human ? text : formatJson({ error: { code: 'usage', message: text.trim() } }, { stream: 'stderr', nopretty: options.nopretty })) } })
    .configureHelp({ showGlobalOptions: true, formatHelp: (command, helper) => {
        const options = modes()
        if (options.human) return new Help().formatHelp(command, helper)
        return formatJson({ name: command.name(), description: command.description(), usage: [command.name(), command.usage()].join(' '), options: command.options.map(option => ({ flags: option.flags, description: option.description, default: option.defaultValue })), commands: command.commands.map(child => ({ name: child.name(), description: child.description(), arguments: child.registeredArguments.map(argument => ({ name: argument.name(), required: argument.required })) })) }, { stream: 'stdout', always: true, nopretty: options.nopretty })
    } })
    .addHelpText('beforeAll', () => process.stdout.isTTY && !modes().nopretty && !modes().json ? '\n' + logo() + '\n' : '')
    .action(() => program.help())

function action<A extends unknown[]>(run: (...args: A) => Promise<unknown>) {
    return async (...args: A) => {
        try { const value = await run(...args); if (value !== undefined) await output(value) }
        catch (error) { const message = redact(error instanceof Error ? error.message : String(error)); const options = modes(); await write('stderr', options.human ? message + '\n' : formatJson({ error: { code: 'operation_failed', message } }, { stream: 'stderr', nopretty: options.nopretty })); process.exitCode = 1 }
    }
}
function addOptions(command: Command) {
    return command.option('--host <name>', 'configured SSH machine').option('--scope <org-or-repo>', 'GitHub org or owner/repo').option('--name <name>', 'runner name (default machine name)').option('--labels <csv>', 'custom labels (default woreda)').option('--group <name>', 'organization access group').option('--repos <csv>', 'selected repositories for a new group').option('--allow-public', 'allow public repositories in a new selected group').option('--install-dependencies', 'install Linux runner dependencies with sudo').option('--no-install-dependencies', 'keep existing Linux OS dependencies').option('--directory <path>', 'absolute remote runner directory').option('--version <version>', 'official runner version (default latest)').option('--dry-run', 'inspect and plan without tokens or runner/group changes')
}
addOptions(program.command('init').description('guided first-machine and runner setup')).action(action(addRunner))
addOptions(program.command('add').description('install, register, start and verify a runner; safe to retry')).action(action(addRunner))
const hosts = program.command('hosts').description('SSH machine configuration')
hosts.command('add').argument('<name>').requiredOption('--ssh <address>', 'SSH alias or user@host').description('check SSH access and save a machine').action(action(async (name: string, options: { ssh: string }) => addHost(await loadSettings(), name, options.ssh)))
hosts.command('list').description('show configured machines').action(action(async () => (await loadSettings()).hosts))
hosts.command('remove').argument('<name>').option('--yes', 'confirm configuration removal').option('--forget', 'explicitly abandon local monitoring; does not unregister runners').description('forget a machine configuration; does not delete services').action(action(async (name: string, options: { yes?: boolean; forget?: boolean }) => {
    const settings = await loadSettings(), host = settings.hosts[name]
    if (!host) throw Error('Unknown machine.')
    if (options.forget) {
        await confirmRemoval(`Forget ${name} and its monitoring mappings? GitHub registrations and remote services will remain.`, options.yes)
        delete settings.hosts[name]
        for (const [selector, mapping] of Object.entries(settings.registrations)) if (mapping.host === name) delete settings.registrations[selector]
        await saveSettings(settings); return { name, forgotten: true, remoteServicesRemoved: false }
    }
    const machine = await probe(host)
    if (machine.runners.length || Object.values(settings.registrations).some(runner => runner.host === name)) throw Error('Remove this machine’s runners first; refusing to abandon live registrations.')
    await confirmRemoval(`Forget machine ${name}?`, options.yes)
    delete settings.hosts[name]; await saveSettings(settings); return { name, removed: true }
}))
program.command('status').description('join GitHub state and actual SSH service health, and this host\'s mirab runner pools').action(action(async () => ({ ...(await snapshot(await loadSettings())), pools: await pools() })))
program.command('doctor').description('check runner health; nonzero exit if managed runners are unhealthy').action(action(async () => {
    const data = await snapshot(await loadSettings())
    if (data.errors.length || data.runners.some(row => row.host && !['idle', 'busy'].includes(row.status))) process.exitCode = 1
    return data
}))
program.command('watch').description('live terminal dashboard').option('--interval <seconds>', 'refresh interval', integer('Interval', 2, 3600), 15).option('--once', 'one dashboard snapshot').action(action(async (options: { interval: number; once?: boolean }) => {
    do {
        const data = await snapshot(await loadSettings())
        if (process.stdout.isTTY && !modes().json && !modes().nopretty) { process.stdout.write('\x1b[2J\x1b[H'); console.log(`${logo()}\n\nWoreda v${pkg.version} · ${new Date().toLocaleString()}\n${table(data)}`) } else await output(data, true)
        if (options.once) break
        await Bun.sleep(options.interval * 1000)
    } while (true)
}))
for (const verb of ['start', 'stop', 'restart'] as const) program.command(verb).argument('<runner>').description(`${verb} one runner service`).option('--force', 'explicitly bypass busy/uncertain state protection').action(action((selector: string, options: { force?: boolean }) => control(selector, verb, options.force)))
program.command('repair').argument('<runner>').description('restore a missing/stopped/disconnected service and verify connection').option('--force', 'allow interruption of an active job').action(action((selector: string, options: { force?: boolean }) => repairRunner(selector, options.force)))
program.command('update').argument('<runner>').description('verify and install the latest runner SDK, then reconnect').option('--version <version>', 'specific SDK version').option('--dry-run', 'show proposed version change').option('--force', 'allow interruption of busy/uncertain runner').action(action(updateRunner))
program.command('labels').argument('<runner>').requiredOption('--set <csv>', 'replace custom labels; automatic OS/architecture labels stay').description('manage workflow routing labels').action(action((selector: string, options: { set: string }) => setLabels(selector, options.set)))
program.command('remove').argument('<runner>').description('stop service and unregister from GitHub; keep files by default').option('--yes', 'confirm removal without prompting').option('--force', 'allow interruption of an active job').option('--purge', 'delete files created by woreda after successful removal').option('--github-only', 'revoke registration only; remote service/files remain').action(action(removeRunner))
program.command('logs').argument('<runner>').description('stream a selected SDK or job log (plain text)').option('--lines <count>', 'recent lines', integer('Lines', 1, 10000), 60).option('--follow', 'follow appended logs').option('--jobs', 'worker job log instead of runner log').action(action(logs))
// login and logout are for people at a terminal (an agent never approves a
// login), so they print readable text unless --json is asked for.
const humanUnlessJson = () => !modes().json
/** An OSC 8 hyperlink, so the URL opens with a click/tap even where the terminal wouldn't detect it. */
export const hyperlink = (url: string, tty = process.stderr.isTTY) => tty ? `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\` : url
/** OSC 52: asks the terminal (across SSH too) to put the text on the clipboard; terminals that don't allow it ignore it. */
const toClipboard = (text: string) => { if (process.stderr.isTTY) process.stderr.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`) }
export function deviceCodeText(c: { uri: string; code: string }, tty = process.stderr.isTTY) {
    return `\nTo let woreda register runners for you, open\n\n    ${hyperlink(c.uri, tty)}\n\nand enter the code\n\n    ${tty ? chalk.bold(c.code) : c.code}${tty ? '   (sent to your clipboard, if your terminal allows it)' : ''}\n\nWaiting for you to approve it on GitHub…`
}
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-CA', { dateStyle: 'medium' }) : null
program.command('login').description('authorize woreda on GitHub (device flow, the Woreda GitHub App), for woreda serve').option('--file <path>', 'where to keep the login', defaultLoginFile()).option('--client-id <id>', 'another GitHub App with the device flow', WOREDA_CLIENT_ID).action(action(async (options: { file: string; clientId: string }) => {
    const human = humanUnlessJson()
    const r = await deviceLogin({ file: options.file, clientId: options.clientId, show: c => { if (human) { toClipboard(c.code); console.error(deviceCodeText(c)) } else console.error(`Open ${c.uri} and enter: ${c.code}`) } })
    if (!human) return r
    const until = day(r.refreshExpiresAt)
    await write('stdout', `\nLogged in to GitHub as ${r.user}.${until ? ` woreda keeps the login fresh by itself until ${until}; run woreda login again after that.` : ''}\nSaved in ${r.file}.\n`)
}))
program.command('logout').description('forget the GitHub login on this machine').option('--file <path>', 'the login to remove', defaultLoginFile()).action(action(async (options: { file: string }) => {
    const r = await logout(options.file)
    if (!humanUnlessJson()) return r
    await write('stdout', `${r.removed ? 'Logged out: removed' : 'Not logged in: nothing at'} ${r.file}.\nTo revoke the approval on GitHub too: ${hyperlink('https://github.com/settings/apps/authorizations', process.stdout.isTTY)}\n`)
}))
program.command('serve').argument('<path>', 'a runner definition (.ts) or a folder of them').description('run each job in a fresh mirab VM, one runner per definition, until stopped').option('--install', 'keep it running for this user (macOS LaunchAgent)').option('--mirab-config <dir>', 'mirab config directory', defaultMirabConfig()).action(action(async (path: string, options: { install?: boolean; mirabConfig: string }) => options.install ? installService(path) : serve(path, options.mirabConfig)))
program.command('image').description('mirab runner images').command('build').argument('<path>', 'a runner definition (.ts) or a folder of them').description('build (or find cached) each definition\'s runner image').option('--mirab-config <dir>', 'mirab config directory', defaultMirabConfig()).action(action((path: string, options: { mirabConfig: string }) => buildImages(path, options.mirabConfig)))
program.command('jobs').argument('<owner/repo>').description('recent workflow runs and links').option('--limit <count>', 'number of runs', integer('Limit', 1, 100), 5).action(action((scope: string, options: { limit: number }) => jobs(scope, options.limit)))
program.command('groups').argument('<org>').description('list organization runner access groups').action(action((scope: string) => { identifier.parse(scope); return pages<Group>(`orgs/${scope}/actions/runner-groups`, 'runner_groups') }))

if (import.meta.main) {
    if (process.argv.length <= 2) program.help()
    await program.parseAsync()
    process.exit(process.exitCode ?? 0)
}
