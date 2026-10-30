/** mirab runners from woreda: load definition files, build their images, serve them, and report their pools. */
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import * as mirab from 'mirab'
import { MIRAB_VERSION, runnerHostVm, runnerImage, runnerRecipe, runnersDir, serveRunners, type BudgetSnapshot, type RunnerDefinition, type RunnerState } from 'mirab/runner'
import { z } from 'zod'
import pkg from '../package.json'
import * as woreda from './index.ts'

export const defaultMirabConfig = () => join(homedir(), '.config', 'mirab')

/** woreda carries mirab from git at a pinned commit; that commit's canary is the release whose VM image matches it. */
export function mirabRelease(dependency: string = pkg.dependencies.mirab, version = MIRAB_VERSION): string | undefined {
    const sha = /#([0-9a-f]{7,40})$/.exec(dependency)?.[1]
    return sha ? `${version}-canary-${sha.slice(0, 7)}` : undefined
}

let resolving = false
/** Definition files import 'mirab' and 'woreda'; they resolve to the copies inside woreda, so a folder of definitions needs no node_modules. */
function resolveImports() {
    if (resolving) return
    resolving = true
    Bun.plugin({
        name: 'woreda-runner-definitions',
        setup(build) {
            build.module('mirab', () => ({ exports: mirab as Record<string, unknown>, loader: 'object' }))
            build.module('woreda', () => ({ exports: woreda as Record<string, unknown>, loader: 'object' }))
        },
    })
}

const isDefinition = (value: unknown): value is RunnerDefinition =>
    !!value && typeof value === 'object' && typeof (value as RunnerDefinition).name === 'string' && typeof (value as RunnerDefinition).forge?.ticket === 'function'

/** The runner definitions in a .ts file, or in every .ts file of a folder (each exports defineRunner(...) as default). */
export async function loadDefinitions(path: string): Promise<RunnerDefinition[]> {
    resolveImports()
    const full = resolve(path)
    const files = (await stat(full)).isDirectory() ? (await readdir(full)).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts')).sort().map(name => join(full, name)) : [full]
    const defs: RunnerDefinition[] = []
    for (const file of files) {
        const module = await import(file)
        if (!isDefinition(module.default)) throw Error(`${file}: export default defineRunner({ ... })`)
        defs.push(module.default)
    }
    if (!defs.length) throw Error(`no runner definitions in ${path}`)
    return defs
}

export async function buildImages(path: string, configDir = defaultMirabConfig(), log: (line: string) => void = line => console.error(line)) {
    const defs = await loadDefinitions(path)
    const vm = await runnerHostVm(configDir, log, mirabRelease())
    const built = []
    for (const def of defs) {
        const image = await runnerImage({ configDir, vm, recipe: await runnerRecipe(def), log })
        built.push({ runner: def.name, image: image.meta.key, forge: image.meta.forge.key, tools: image.meta.tools.map(t => `${t.tool} ${t.version}`), builtAt: image.meta.builtAt })
    }
    return built
}

/** Serves until SIGINT/SIGTERM: busy jobs get their grace period, waiting slots stop at once. */
/** `<definitions>/host.json`: what this host lends runner VMs in all; the
 *  rest stays with the host. Absent: host RAM − 3 GiB and every CPU. */
export const hostConfigSchema = z.strictObject({
    vmMemoryMiB: z.number().int().min(1024).optional(),
    vmVcpus: z.number().int().min(1).optional(),
})
export type HostConfig = z.infer<typeof hostConfigSchema>

export async function loadHostConfig(path: string): Promise<HostConfig> {
    let text: string
    try { text = await readFile(join(resolve(path), 'host.json'), 'utf8') } catch { return {} }
    const parsed = hostConfigSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new Error(`${join(path, 'host.json')}: ${parsed.error.issues.map(i => `${i.path.join('.') || 'host'}: ${i.message}`).join('; ')}`)
    return parsed.data
}

export async function serve(path: string, configDir = defaultMirabConfig(), log: (line: string) => void = line => console.error(line)) {
    const defs = await loadDefinitions(path)
    const host = await loadHostConfig(path)
    const vm = await runnerHostVm(configDir, log, mirabRelease())
    const stop = new AbortController()
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { log(`${signal}: stopping`); stop.abort() })
    await serveRunners(defs, { configDir, vm, signal: stop.signal, log, budgetMiB: host.vmMemoryMiB, budgetVcpus: host.vmVcpus })
}

/** This host's runner budget as serve last wrote it: what's lent, held and waiting. */
export async function hostBudget(configDir = defaultMirabConfig()): Promise<BudgetSnapshot | undefined> {
    try { return JSON.parse(await readFile(join(runnersDir(configDir), 'host.json'), 'utf8')) } catch { return undefined }
}

/** What each runner on this host is doing, from mirab's state files. */
export async function pools(configDir = defaultMirabConfig()): Promise<RunnerState[]> {
    const dir = runnersDir(configDir)
    const names = await readdir(dir).catch(() => [] as string[])
    const states: RunnerState[] = []
    for (const name of names.sort()) {
        try { states.push(JSON.parse(await readFile(join(dir, name, 'state.json'), 'utf8'))) } catch {}
    }
    return states
}

export const LAUNCH_AGENT = 'gg.addis.woreda.serve'

/** A LaunchAgent that keeps `woreda serve <path>` running for this user (vz VMs run in the user's session). */
export function launchAgentPlist(program: string[], path: string, logFile: string): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const args = [...program, 'serve', resolve(path)].map(a => `    <string>${esc(a)}</string>`).join('\n')
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_AGENT}</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict></plist>
`
}

export async function installService(path: string) {
    if (process.platform !== 'darwin') return { installed: false, hint: 'On NixOS, run `woreda serve` from the infra flake (services.woreda); elsewhere, a systemd unit running `woreda serve <path>` as the user that owns ~/.config/mirab.' }
    await loadDefinitions(path) // refuse to install something that won't load
    const program = process.execPath.endsWith('/bun') ? [process.execPath, resolve(import.meta.dir, 'woreda.ts')] : [process.execPath]
    const agents = join(homedir(), 'Library', 'LaunchAgents'), logs = join(homedir(), 'Library', 'Logs')
    await mkdir(agents, { recursive: true }); await mkdir(logs, { recursive: true })
    const plist = join(agents, `${LAUNCH_AGENT}.plist`)
    await writeFile(plist, launchAgentPlist(program, path, join(logs, 'woreda-serve.log')))
    const domain = `gui/${process.getuid!()}`
    await Bun.spawn(['launchctl', 'bootout', `${domain}/${LAUNCH_AGENT}`], { stderr: 'ignore' }).exited
    const code = await Bun.spawn(['launchctl', 'bootstrap', domain, plist]).exited
    if (code !== 0) throw Error(`launchctl bootstrap ${domain} ${plist} failed (${code})`)
    return { installed: true, plist, log: join(logs, 'woreda-serve.log'), stop: `launchctl bootout ${domain}/${LAUNCH_AGENT}` }
}
