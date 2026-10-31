import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
    BIN_LINK, DEFINITIONS, LIB_DIR, SERVICE_HOME, SERVICE_LOGIN, UNIT_FILE, UNIT_NAME,
    installLinuxService, loginForService, uninstallLinuxService, unitFile,
    type MirabHost, type ServiceSystem,
} from '../src/linux-service.ts'
import { notWritable, writePrivate } from '../src/private-file.ts'
import { deviceLogin } from '../src/forges/github-login.ts'

/** A Linux host that records what install does to it, in order. */
function fakeHost(o: { root?: boolean; nixos?: boolean; systemd?: boolean; compiled?: boolean; user?: boolean; kvm?: boolean; loggedIn?: boolean; dirs?: string[] } = {}) {
    const events: string[] = []
    const files = new Map<string, { content: string; mode: number; owner?: string }>()
    const dirs = new Map<string, string | undefined>()
    let user = o.user ?? false
    if (o.loggedIn) files.set(SERVICE_LOGIN, { content: '{}', mode: 0o600, owner: 'woreda' })
    const sys: ServiceSystem = {
        platform: 'linux',
        isRoot: () => o.root ?? true,
        nixos: o.nixos ?? false,
        systemd: o.systemd ?? true,
        execPath: '/home/me/.woreda/bin/woreda',
        compiled: o.compiled ?? true,
        userExists: () => user,
        groupExists: (g) => g === 'kvm' && (o.kvm ?? true),
        run(argv) { events.push(`run ${argv.join(' ')}`); if (argv[0] === 'useradd') user = true },
        exists: (p) => files.has(p) || dirs.has(p) || p === '/usr/sbin/nologin' || (o.dirs ?? ['/home/me/runners']).includes(p) || p === '/home/me/one.ts',
        isDir: (p) => (o.dirs ?? ['/home/me/runners']).includes(p),
        write(path, content, mode, owner) { events.push(`write ${path}`); files.set(path, { content, mode, owner }) },
        copyFile(from, to, mode) { events.push(`copy ${from} ${to}`); files.set(to, { content: from, mode }) },
        copyTree(from, to) { events.push(`copytree ${from} ${to}`) },
        link(target, path) { events.push(`link ${path} -> ${target}`) },
        dir(path, _mode, owner) { events.push(`dir ${path} ${owner ?? 'root'}`); dirs.set(path, owner) },
        chownTree(path, owner) { events.push(`chown ${path} ${owner}`) },
        remove(path) { events.push(`remove ${path}`); files.delete(path) },
    }
    const mirabCalls: string[] = []
    const mirab: MirabHost = {
        installFirecracker: async (dir) => (mirabCalls.push(`firecracker ${dir}`), join(dir, 'firecracker')),
        setupLinuxNetwork: (n) => void mirabCalls.push(`network ${n.user} ${n.slots}`),
        removeLinuxNetwork: () => void mirabCalls.push('network remove'),
    }
    return { sys, events, files, dirs, mirab, mirabCalls, login: (written = true) => async () => { events.push('login'); if (written) files.set(SERVICE_LOGIN, { content: '{}', mode: 0o600 }) } }
}

describe('sudo woreda serve <path> --install (Linux)', () => {
    test('a fresh machine: user, binary on PATH, firecracker, definitions, owned state, network, unit, login, start', async () => {
        const h = fakeHost()
        const r = await installLinuxService('/home/me/runners', { slots: 8, mirab: h.mirab, login: h.login() }, h.sys)
        expect(h.events).toContain('run useradd --system --home-dir /var/lib/woreda --no-create-home --shell /usr/sbin/nologin woreda')
        expect(h.events).toContain('run usermod --append --groups kvm woreda')
        expect(h.events).toContain(`copy /home/me/.woreda/bin/woreda ${LIB_DIR}/woreda`)
        expect(h.events).toContain(`link ${BIN_LINK} -> ${LIB_DIR}/woreda`)
        expect(h.mirabCalls).toEqual([`firecracker ${LIB_DIR}`, 'network woreda 8'])
        expect(h.events).toContain(`copytree /home/me/runners ${DEFINITIONS}`)
        // Every folder the service writes is the service user's, before its first start.
        for (const d of [SERVICE_HOME, `${SERVICE_HOME}/.config`, `${SERVICE_HOME}/.config/woreda`, `${SERVICE_HOME}/.config/mirab`])
            expect(h.dirs.get(d)).toBe('woreda')
        expect(JSON.parse(h.files.get(`${SERVICE_HOME}/.config/mirab/isolation.json`)!.content)).toEqual({ vm: { firecracker: `${LIB_DIR}/firecracker` } })
        expect(h.files.get(`${SERVICE_HOME}/.config/mirab/isolation.json`)!.owner).toBe('woreda')
        // The unit is written and enabled before the login; it starts only once logged in.
        const at = (e: string) => h.events.indexOf(e)
        expect(at(`run systemctl enable ${UNIT_NAME}`)).toBeLessThan(at('login'))
        expect(at('login')).toBeLessThan(at(`run systemctl restart ${UNIT_NAME}`))
        expect(h.events).toContain(`chown ${SERVICE_HOME}/.config woreda`)
        expect(r).toMatchObject({ installed: true, loggedIn: true, logs: `journalctl -u ${UNIT_NAME} -f` })
        expect(r.next).toBeUndefined()
    })

    test('the unit runs woreda from /usr/local/bin as woreda, with systemd owning its state folder', () => {
        const u = unitFile()
        expect(u).toMatch(/^User=woreda$/m)
        expect(u).toMatch(/^StateDirectory=woreda$/m)
        expect(u).toMatch(/^ExecStart=\/usr\/local\/bin\/woreda serve \/etc\/woreda\/runners$/m)
        expect(u).toMatch(/^Requires=mirab-vm-network.service$/m)
        expect(u).toMatch(/^TimeoutStopSec=11min$/m)
    })

    test('without a terminal (no login callback) it installs but waits, and says the one step left', async () => {
        const h = fakeHost()
        const r = await installLinuxService('/home/me/runners', { mirab: h.mirab }, h.sys)
        expect(h.events.some((e) => e.includes('systemctl restart'))).toBe(false)
        expect(r.loggedIn).toBe(false)
        expect(r.next).toMatch(/sudo woreda login --service/)
    })

    test('already logged in: no login, straight to (re)start; an existing user is reused', async () => {
        const h = fakeHost({ loggedIn: true, user: true })
        await installLinuxService('/home/me/runners', { mirab: h.mirab, login: h.login() }, h.sys)
        expect(h.events).not.toContain('login')
        expect(h.events.some((e) => e.startsWith('run useradd'))).toBe(false)
        expect(h.events).toContain(`run systemctl restart ${UNIT_NAME}`)
    })

    test('one definition file goes into the definitions folder', async () => {
        const h = fakeHost()
        await installLinuxService('/home/me/one.ts', { mirab: h.mirab }, h.sys)
        expect(h.events).toContain(`copy /home/me/one.ts ${DEFINITIONS}/one.ts`)
    })

    test('refuses before touching anything: not root, NixOS, no systemd, running under bun, missing definitions', async () => {
        for (const [opts, path, msg] of [
            [{ root: false }, '/home/me/runners', /sudo woreda serve/],
            [{ nixos: true }, '/home/me/runners', /NixOS module/],
            [{ systemd: false }, '/home/me/runners', /needs systemd/],
            [{ compiled: false }, '/home/me/runners', /release binary/],
            [{}, '/home/me/missing', /no runner definitions/],
        ] as [Parameters<typeof fakeHost>[0], string, RegExp][]) {
            const h = fakeHost(opts)
            await expect(installLinuxService(path, { mirab: h.mirab }, h.sys)).rejects.toThrow(msg)
            expect(h.events).toEqual([])
            expect(h.mirabCalls).toEqual([])
        }
    })
})

describe('sudo woreda login --service', () => {
    test('saves the login where the service reads it, owned by woreda, then restarts the service', async () => {
        const h = fakeHost({ user: true })
        h.files.set(UNIT_FILE, { content: '', mode: 0o644 })
        let file = ''
        await loginForService(async (f) => { file = f }, h.sys)
        expect(file).toBe(SERVICE_LOGIN)
        expect(h.dirs.get(`${SERVICE_HOME}/.config/woreda`)).toBe('woreda')
        expect(h.events.indexOf(`chown ${SERVICE_HOME}/.config woreda`)).toBeLessThan(h.events.indexOf(`run systemctl restart ${UNIT_NAME}`))
    })

    test('says to install first when there is no service', async () => {
        const h = fakeHost({ user: false })
        await expect(loginForService(async () => {}, h.sys)).rejects.toThrow(/serve <path> --install/)
    })
})

describe('sudo woreda serve --uninstall', () => {
    test('stops and removes the unit, the network and the binary; keeps the login, state and definitions', () => {
        const h = fakeHost({ user: true })
        const r = uninstallLinuxService({ mirab: h.mirab }, h.sys)
        expect(h.events[0]).toBe(`run systemctl disable --now ${UNIT_NAME}`)
        expect(h.events).toContain(`remove ${UNIT_FILE}`)
        expect(h.events).toContain(`remove ${BIN_LINK}`)
        expect(h.mirabCalls).toEqual(['network remove'])
        expect(h.events.some((e) => e.includes(SERVICE_HOME) || e.includes(DEFINITIONS))).toBe(false)
        expect(r.kept).toContain(SERVICE_HOME)
    })
})

describe('a config folder woreda cannot write', () => {
    test('says which folder, whose it is, and the fix, instead of a bare EACCES', async () => {
        if (process.getuid?.() === 0) return
        const base = await mkdtemp(join(resolve('.tmp'), 'perm-'))
        const locked = join(base, 'locked')
        await mkdir(locked)
        await chmod(locked, 0o500)
        try {
            await expect(writePrivate(join(locked, 'woreda', 'github-login.json'), '{}')).rejects.toThrow(
                new RegExp(`woreda can't write ${locked}/woreda/github-login.json: ${locked} belongs to .* \\(EACCES\\)\\. Fix with: sudo chown -R`),
            )
        } finally {
            await chmod(locked, 0o700)
        }
    })

    test("the service's own folder points at login --service", () => {
        const e = notWritable(`${SERVICE_HOME}/.config/woreda/github-login.json`, Object.assign(new Error('x'), { code: 'EACCES' }))
        expect(e.message).toMatch(/sudo woreda login --service/)
    })
})

test('login refuses before showing a code when the login could not be saved', async () => {
    if (process.getuid?.() === 0) return
    const base = await mkdtemp(join(resolve('.tmp'), 'perm-'))
    const locked = join(base, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o500)
    let asked = false, shown = false
    const fetcher = (async () => { asked = true; return new Response('{}') }) as unknown as typeof fetch
    try {
        await expect(deviceLogin({ file: join(locked, 'woreda', 'github-login.json'), fetcher, show: () => { shown = true } })).rejects.toThrow(/woreda can't write/)
        expect(asked).toBe(false)
        expect(shown).toBe(false)
    } finally {
        await chmod(locked, 0o700)
    }
})
