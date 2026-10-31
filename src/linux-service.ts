// `sudo woreda serve <path> --install` on Linux: woreda as a systemd service,
// set up by woreda itself, so nobody makes users, folders or units by hand.
//
//   user        woreda (system account, no login shell, in kvm)
//   binary      /usr/local/lib/woreda/woreda, linked as /usr/local/bin/woreda (on PATH)
//   firecracker /usr/local/lib/woreda/firecracker (mirab's pinned release, checked)
//   definitions /etc/woreda/runners (a copy: install again to change them)
//   state       /var/lib/woreda, owned by woreda (its login and VM images)
//   network     mirab's VM network for woreda (bridge, taps, filtered egress)
//   unit        /etc/systemd/system/woreda.service
//
// `sudo woreda login --service` saves the GitHub login where the service reads
// it, owned by woreda. On NixOS, where /etc and users come from the
// configuration, the NixOS module does all of this declaratively instead.
import { spawnSync } from 'node:child_process'
import {
    chmodSync,
    chownSync,
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const SERVICE_USER = 'woreda'
export const SERVICE_HOME = '/var/lib/woreda'
export const LIB_DIR = '/usr/local/lib/woreda'
export const BIN_LINK = '/usr/local/bin/woreda'
export const DEFINITIONS = '/etc/woreda/runners'
export const UNIT_NAME = 'woreda.service'
export const UNIT_FILE = `/etc/systemd/system/${UNIT_NAME}`
export const SERVICE_LOGIN = join(SERVICE_HOME, '.config', 'woreda', 'github-login.json')

export function unitFile(): string {
    return `[Unit]
Description=woreda: CI runners in fresh mirab VMs
After=network-online.target mirab-vm-network.service
Wants=network-online.target
Requires=mirab-vm-network.service
[Service]
User=${SERVICE_USER}
Group=${SERVICE_USER}
SupplementaryGroups=kvm
# systemd creates /var/lib/woreda owned by woreda, so its login and VM images
# always have a home it can write.
StateDirectory=woreda
StateDirectoryMode=0700
Environment=HOME=${SERVICE_HOME}
ExecStart=${BIN_LINK} serve ${DEFINITIONS}
Restart=on-failure
RestartSec=30
# A stop waits for a running job: serve's grace is 10 minutes.
TimeoutStopSec=11min
KillMode=mixed
[Install]
WantedBy=multi-user.target
`
}

/** What install and uninstall touch on the machine; tests pass their own. */
export interface ServiceSystem {
    platform: NodeJS.Platform
    isRoot(): boolean
    nixos: boolean
    systemd: boolean
    /** This woreda's own executable (a release binary, not `bun woreda.ts`). */
    execPath: string
    compiled: boolean
    userExists(name: string): boolean
    groupExists(name: string): boolean
    run(argv: string[]): void
    exists(path: string): boolean
    isDir(path: string): boolean
    /** Writes a file atomically, owned by `owner` (root when absent). */
    write(path: string, content: string, mode: number, owner?: string): void
    copyFile(from: string, to: string, mode: number): void
    copyTree(from: string, to: string): void
    link(target: string, path: string): void
    /** mkdir -p, then owner and mode on the last part. */
    dir(path: string, mode: number, owner?: string): void
    chownTree(path: string, owner: string): void
    remove(path: string): void
}

function ids(user: string): { uid: number; gid: number } {
    const r = spawnSync('id', ['-u', user], { encoding: 'utf8' })
    const g = spawnSync('id', ['-g', user], { encoding: 'utf8' })
    if (r.status !== 0 || g.status !== 0) throw Error(`no user ${user}`)
    return { uid: Number(r.stdout), gid: Number(g.stdout) }
}

export const realSystem: ServiceSystem = {
    platform: process.platform,
    isRoot: () => process.getuid?.() === 0,
    nixos: existsSync('/etc/NIXOS'),
    systemd: existsSync('/run/systemd/system'),
    execPath: process.execPath,
    compiled: !/\/bun(-[a-z0-9]+)?$/.test(process.execPath),
    userExists: (n) => spawnSync('id', ['-u', n]).status === 0,
    groupExists: (n) => spawnSync('getent', ['group', n]).status === 0,
    run(argv) {
        const r = spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit' })
        if (r.status !== 0) throw Error(`${argv.join(' ')} failed (${r.status ?? r.signal})`)
    },
    exists: (p) => existsSync(p),
    isDir: (p) => existsSync(p) && statSync(p).isDirectory(),
    write(path, content, mode, owner) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
        const tmp = `${path}.new`
        writeFileSync(tmp, content, { mode })
        chmodSync(tmp, mode)
        const { uid, gid } = owner ? ids(owner) : { uid: 0, gid: 0 }
        chownSync(tmp, uid, gid)
        renameSync(tmp, path)
    },
    copyFile(from, to, mode) {
        mkdirSync(dirname(to), { recursive: true, mode: 0o755 })
        const tmp = `${to}.new`
        cpSync(from, tmp)
        chmodSync(tmp, mode)
        chownSync(tmp, 0, 0)
        renameSync(tmp, to)
    },
    copyTree(from, to) {
        rmSync(to, { recursive: true, force: true })
        mkdirSync(dirname(to), { recursive: true, mode: 0o755 })
        cpSync(from, to, { recursive: true, dereference: true })
        spawnSync('chown', ['-R', 'root:root', to])
        spawnSync('chmod', ['-R', 'u=rwX,go=rX', to])
    },
    link(target, path) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
        try {
            if (lstatSync(path)) rmSync(path)
        } catch {}
        symlinkSync(target, path)
    },
    dir(path, mode, owner) {
        mkdirSync(path, { recursive: true, mode })
        chmodSync(path, mode)
        const { uid, gid } = owner ? ids(owner) : { uid: 0, gid: 0 }
        chownSync(path, uid, gid)
    },
    chownTree(path, owner) {
        spawnSync('chown', ['-R', `${owner}:${owner}`, path])
    },
    remove(path) {
        rmSync(path, { recursive: true, force: true })
    },
}

/** The mirab pieces the install needs (passed in, so tests don't touch the host). */
export interface MirabHost {
    installFirecracker(dir: string, o?: { log?: (line: string) => void }): Promise<string>
    setupLinuxNetwork(o: { user?: string; slots?: number; log?: (line: string) => void }): void
    removeLinuxNetwork(o: { log?: (line: string) => void }): void
}

function precheck(sys: ServiceSystem, verb: string) {
    if (sys.platform !== 'linux') throw Error('this is the Linux service install')
    if (sys.nixos)
        throw Error(
            'on NixOS, users, units and /etc come from your configuration: use the woreda NixOS module (services.woreda) instead of --install',
        )
    if (!sys.systemd) throw Error('the Linux service install needs systemd')
    if (!sys.isRoot()) throw Error(`run it with sudo: sudo woreda ${verb}`)
}

export interface InstallResult {
    installed: true
    unit: string
    definitions: string
    loggedIn: boolean
    logs: string
    stop: string
    next?: string
}

/** Installs (or updates) woreda as a systemd service serving `path`'s definitions. */
export async function installLinuxService(
    path: string,
    o: {
        slots?: number
        mirab: MirabHost
        /** Runs the GitHub login for the service now; absent when no one is at a terminal. */
        login?: () => Promise<void>
        /** Throws if the definitions won't load (checked after root and NixOS). */
        validate?: () => Promise<unknown>
        log?: (line: string) => void
    },
    sys: ServiceSystem = realSystem,
): Promise<InstallResult> {
    const log = o.log ?? (() => {})
    precheck(sys, `serve ${path} --install`)
    if (!sys.compiled)
        throw Error('install from a woreda release binary (this is woreda running under bun)')
    const source = resolve(path)
    if (!sys.exists(source)) throw Error(`no runner definitions at ${source}`)
    await o.validate?.()

    if (!sys.userExists(SERVICE_USER)) {
        log(`creating the ${SERVICE_USER} system user`)
        const shell = sys.exists('/usr/sbin/nologin') ? '/usr/sbin/nologin' : '/sbin/nologin'
        sys.run(['useradd', '--system', '--home-dir', SERVICE_HOME, '--no-create-home', '--shell', shell, SERVICE_USER])
    }
    // Firecracker opens /dev/kvm.
    if (sys.groupExists('kvm')) sys.run(['usermod', '--append', '--groups', 'kvm', SERVICE_USER])

    log(`installing woreda at ${BIN_LINK}`)
    sys.copyFile(sys.execPath, join(LIB_DIR, 'woreda'), 0o755)
    sys.link(join(LIB_DIR, 'woreda'), BIN_LINK)
    const firecracker = await o.mirab.installFirecracker(LIB_DIR, { log })

    log(`copying the runner definitions to ${DEFINITIONS}`)
    if (sys.isDir(source)) sys.copyTree(source, DEFINITIONS)
    else {
        sys.remove(DEFINITIONS)
        sys.dir(DEFINITIONS, 0o755)
        sys.copyFile(source, join(DEFINITIONS, basename(source)), 0o644)
    }

    // The service's home: systemd's StateDirectory makes it at start, but the
    // login (and mirab's settings) are written before the first start.
    for (const d of [SERVICE_HOME, join(SERVICE_HOME, '.config'), join(SERVICE_HOME, '.config', 'woreda'), join(SERVICE_HOME, '.config', 'mirab')])
        sys.dir(d, 0o700, SERVICE_USER)
    sys.write(
        join(SERVICE_HOME, '.config', 'mirab', 'isolation.json'),
        JSON.stringify({ vm: { firecracker } }, null, 2) + '\n',
        0o600,
        SERVICE_USER,
    )

    o.mirab.setupLinuxNetwork({ user: SERVICE_USER, slots: o.slots, log })

    sys.write(UNIT_FILE, unitFile(), 0o644)
    sys.run(['systemctl', 'daemon-reload'])
    sys.run(['systemctl', 'enable', UNIT_NAME])

    let loggedIn = sys.exists(SERVICE_LOGIN)
    if (!loggedIn && o.login) {
        log('woreda needs your approval on GitHub to register runners:')
        await o.login()
        sys.chownTree(join(SERVICE_HOME, '.config'), SERVICE_USER)
        loggedIn = sys.exists(SERVICE_LOGIN)
    }
    if (loggedIn) sys.run(['systemctl', 'restart', UNIT_NAME])
    return {
        installed: true,
        unit: UNIT_FILE,
        definitions: DEFINITIONS,
        loggedIn,
        logs: `journalctl -u ${UNIT_NAME} -f`,
        stop: `sudo systemctl stop ${UNIT_NAME}`,
        ...(loggedIn ? {} : { next: 'sudo woreda login --service (then it starts by itself)' }),
    }
}

/** Saves the GitHub login for the service (as root), owned by its user, then starts it. */
export async function loginForService(
    login: (file: string) => Promise<unknown>,
    sys: ServiceSystem = realSystem,
) {
    precheck(sys, 'login --service')
    if (!sys.userExists(SERVICE_USER))
        throw Error('woreda is not installed as a service here: sudo woreda serve <path> --install')
    sys.dir(join(SERVICE_HOME, '.config', 'woreda'), 0o700, SERVICE_USER)
    const result = await login(SERVICE_LOGIN)
    sys.chownTree(join(SERVICE_HOME, '.config'), SERVICE_USER)
    if (sys.exists(UNIT_FILE)) sys.run(['systemctl', 'restart', UNIT_NAME])
    return result
}

/** Stops and removes the service, its binary and its VM network; keeps its state and definitions. */
export function uninstallLinuxService(
    o: { mirab: MirabHost; log?: (line: string) => void },
    sys: ServiceSystem = realSystem,
) {
    const log = o.log ?? (() => {})
    precheck(sys, 'serve --uninstall')
    try {
        sys.run(['systemctl', 'disable', '--now', UNIT_NAME])
    } catch {
        // not installed, or already stopped
    }
    sys.remove(UNIT_FILE)
    sys.run(['systemctl', 'daemon-reload'])
    o.mirab.removeLinuxNetwork({ log })
    sys.remove(BIN_LINK)
    sys.remove(LIB_DIR)
    return {
        uninstalled: true,
        kept: [DEFINITIONS, SERVICE_HOME, `user ${SERVICE_USER}`],
        purge: `sudo rm -r ${DEFINITIONS} ${SERVICE_HOME} && sudo userdel ${SERVICE_USER}`,
    }
}
