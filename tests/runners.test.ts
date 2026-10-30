import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { appJwt, github, releaseSha } from '../src/forges/github.ts'
import { launchAgentPlist, loadDefinitions, mirabRelease } from '../src/runners.ts'

let dir: string
beforeAll(async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    dir = await mkdtemp(join(resolve('.tmp'), 'runners-'))
    await writeFile(join(dir, 'token'), 'ghp_test_token\n', { mode: 0o600 })
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

type Call = { method: string; url: string; auth?: string; body?: any }
/** A GitHub API that records calls and answers from a table. */
function fakeApi(answer: (call: Call) => { status?: number; json?: unknown }) {
    const calls: Call[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>
        const call: Call = { method: init.method!, url, auth: headers.authorization, body: init.body ? JSON.parse(String(init.body)) : undefined }
        calls.push(call)
        const { status = 200, json } = answer(call)
        return new Response(status === 204 ? null : JSON.stringify(json ?? {}), { status })
    }) as unknown as typeof fetch
    return { calls, fetcher }
}

const SHA = 'c'.repeat(64)
const release = { tag_name: 'v2.338.2', body: `## SHA-256\n- actions-runner-linux-arm64-2.338.2.tar.gz <!-- BEGIN SHA linux-arm64 -->${SHA}<!-- END SHA linux-arm64 -->\n` }

describe('the GitHub forge adapter', () => {
    test('a ticket is a just-in-time config for one runner, with self-hosted, OS and arch labels added', async () => {
        const api = fakeApi(c => c.url.endsWith('generate-jitconfig') ? { status: 201, json: { encoded_jit_config: 'JIT-BLOB', runner: { id: 7 } } } : {})
        const forge = github({ scope: 'zegadb', token: `file:${join(dir, 'token')}` }, api.fetcher)
        const t = await forge.ticket({ name: 'simien-zeg-abc123', labels: ['mirab'], platform: 'linux-arm64' })
        expect(t).toEqual({ name: 'simien-zeg-abc123', secret: { jit: 'JIT-BLOB' }, meta: { id: '7' } })
        expect(api.calls[0]!.url).toBe('https://api.github.com/orgs/zegadb/actions/runners/generate-jitconfig')
        expect(api.calls[0]!.auth).toBe('Bearer ghp_test_token')
        expect(api.calls[0]!.body).toEqual({ name: 'simien-zeg-abc123', runner_group_id: 1, labels: ['self-hosted', 'Linux', 'ARM64', 'mirab'], work_folder: '_work' })
        const repo = github({ scope: 'addiscorp/runner-smoke', token: `file:${join(dir, 'token')}` }, api.fetcher)
        await repo.ticket({ name: 'x', labels: [], platform: 'linux-x64' })
        expect(api.calls[1]!.url).toBe('https://api.github.com/repos/addiscorp/runner-smoke/actions/runners/generate-jitconfig')
        expect(api.calls[1]!.body.labels).toEqual(['self-hosted', 'Linux', 'X64'])
    })

    test('a GitHub App signs a JWT and reuses its installation token', async () => {
        const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
        await writeFile(join(dir, 'app.pem'), privateKey, { mode: 0o600 })
        const api = fakeApi(c => c.url.endsWith('/access_tokens')
            ? { status: 201, json: { token: 'ghs_install', expires_at: new Date(Date.now() + 3600_000).toISOString() } }
            : { status: 201, json: { encoded_jit_config: 'J', runner: { id: 1 } } })
        const forge = github({ scope: 'zegadb', app: { id: 42, installation: 99, key: `file:${join(dir, 'app.pem')}` } }, api.fetcher)
        await forge.ticket({ name: 'a', labels: [], platform: 'linux-arm64' })
        await forge.ticket({ name: 'b', labels: [], platform: 'linux-arm64' })
        const minted = api.calls.filter(c => c.url.endsWith('/access_tokens'))
        expect(minted).toHaveLength(1)
        expect(minted[0]!.url).toBe('https://api.github.com/app/installations/99/access_tokens')
        const jwt = minted[0]!.auth!.replace('Bearer ', '')
        const [head, body, sig] = jwt.split('.')
        expect(createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true)
        expect(JSON.parse(Buffer.from(body!, 'base64url').toString()).iss).toBe(42)
        expect(api.calls.filter(c => c.url.endsWith('generate-jitconfig')).every(c => c.auth === 'Bearer ghs_install')).toBe(true)
        expect(appJwt(1, privateKey, 0).split('.')).toHaveLength(3)
    })

    test('the runner release is checked against the SHA-256 GitHub publishes, before unpacking', async () => {
        expect(releaseSha(release.body, 'linux-arm64')).toBe(SHA)
        expect(releaseSha(release.body, 'linux-x64')).toBeUndefined()
        const api = fakeApi(() => ({ json: release }))
        const forge = github({ scope: 'zegadb', token: `file:${join(dir, 'token')}` }, api.fetcher)
        const install = await forge.guest.install('linux-arm64')
        expect(install.key).toBe(`actions-runner 2.338.2 ${SHA}`)
        const script = install.steps[0]!.argv[2]!
        expect(script).toContain('https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-arm64-2.338.2.tar.gz')
        expect(script.indexOf('sha256sum -c -')).toBeGreaterThan(0)
        expect(script.indexOf('tar -xzf')).toBeGreaterThan(script.indexOf('sha256sum -c -'))
        await expect(forge.guest.install('linux-x64')).rejects.toThrow(/no published SHA-256/)
    })

    test('the one-job config travels as a root-only tmpfs file, read into env, never argv', () => {
        const forge = github({ scope: 'zegadb', token: `file:${join(dir, 'token')}` })
        const job = forge.guest.job({ name: 'a', secret: { jit: 'JIT-BLOB-SECRET' } })
        expect(job.files).toEqual([{ path: '/run/mirab/jit', mode: 0o600, content: 'JIT-BLOB-SECRET', secret: true }])
        const step = job.steps[0]!
        expect(step.asRoot).toBe(true)
        expect(step.argv.join(' ')).not.toContain('JIT-BLOB-SECRET')
        const sh = step.argv[2]!
        expect(sh.indexOf('rm -f /run/mirab/jit')).toBeLessThan(sh.indexOf('exec setpriv'))
        expect(sh).toContain('exec setpriv --reuid=1001 --regid=1001 --init-groups ./run.sh')
        expect(forge.guest.started('2026-10-28 08:00:00Z: Running job: build')).toBe(true)
        expect(forge.guest.started('Listening for Jobs')).toBe(false)
    })

    test('reconcile deletes only this host\'s stale registrations, across pages, and skips busy ones', async () => {
        const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `other-${i}`, busy: false }))
        const page2 = [{ id: 501, name: 'simien-zeg-aaaaaa', busy: false }, { id: 502, name: 'simien-zeg-bbbbbb', busy: true }, { id: 503, name: 'simien-zeg-live01', busy: false }, { id: 504, name: 'aux-zeg-cccccc', busy: false }]
        const api = fakeApi(c => {
            if (c.method === 'GET') return { json: { runners: c.url.endsWith('&page=1') ? page1 : page2 } }
            if (c.url.endsWith('/502')) return { status: 422, json: { message: 'busy' } }
            return { status: 204 }
        })
        const forge = github({ scope: 'zegadb', token: `file:${join(dir, 'token')}` }, api.fetcher)
        await forge.reconcile('simien-zeg-', ['simien-zeg-live01'])
        const deleted = api.calls.filter(c => c.method === 'DELETE').map(c => c.url.split('/').pop())
        expect(deleted).toEqual(['501', '502'])
    })

    test('credentials are file references, and exactly one kind', () => {
        expect(() => github({ scope: 'zegadb', token: 'ghp_inline' })).toThrow(/file reference/)
        expect(() => github({ scope: 'zegadb' })).toThrow(/exactly one/)
    })
})

describe('queued jobs (for on-demand pools)', () => {
    /** An org with three repositories, answering 304 to a matching If-None-Match. */
    function org() {
        const day = 24 * 3600_000
        const routes: Record<string, unknown> = {
            '/orgs/zegadb/repos': [
                { full_name: 'zegadb/zega', pushed_at: new Date(Date.now() - day).toISOString(), archived: false },
                { full_name: 'zegadb/old', pushed_at: new Date(Date.now() - 60 * day).toISOString(), archived: false },
                { full_name: 'zegadb/attic', pushed_at: new Date().toISOString(), archived: true },
            ],
            '/repos/zegadb/zega/actions/runs?status=queued': { workflow_runs: [{ id: 1 }] },
            '/repos/zegadb/zega/actions/runs?status=in_progress': { workflow_runs: [{ id: 2 }] },
            '/repos/zegadb/zega/actions/runs/1/jobs': { jobs: [
                { status: 'queued', labels: ['mirab-linux-arm64'] },
                { status: 'queued', labels: ['ubuntu-latest'] },
                { status: 'in_progress', labels: ['mirab-linux-arm64'] },
            ] },
            // A later job of a running workflow, asking in other case.
            '/repos/zegadb/zega/actions/runs/2/jobs': { jobs: [{ status: 'queued', labels: ['self-hosted', 'linux', 'arm64'] }] },
            '/repos/zegadb/old/actions/runs?status=queued': { workflow_runs: [{ id: 3 }] },
            '/repos/zegadb/old/actions/runs?status=in_progress': { workflow_runs: [] },
            '/repos/zegadb/old/actions/runs/3/jobs': { jobs: [{ status: 'queued', labels: ['mirab-linux-arm64'] }] },
            // x64 only: not for an arm64 runner.
            '/repos/zegadb/attic/actions/runs?status=queued': { workflow_runs: [] },
        }
        const calls: { path: string; ifNoneMatch?: string; status: number }[] = []
        const fetcher = (async (url: string, init: RequestInit) => {
            const u = new URL(url)
            const status = u.searchParams.get('status')
            const path = u.pathname + (status ? `?status=${status}` : '')
            const headers = init.headers as Record<string, string>
            const etag = `"${path}"`
            const body = routes[path]
            if (body === undefined) { calls.push({ path, status: 404 }); return new Response('{}', { status: 404 }) }
            if (headers['if-none-match'] === etag) { calls.push({ path, ifNoneMatch: etag, status: 304 }); return new Response(null, { status: 304 }) }
            calls.push({ path, status: 200 })
            return new Response(JSON.stringify(body), { status: 200, headers: { etag } })
        }) as unknown as typeof fetch
        return { calls, fetcher }
    }

    test('counts queued jobs whose labels the runner has (any case), in queued and running workflows; skips archived repos', async () => {
        const api = org()
        const forge = github({ scope: 'zegadb', token: `file:${join(dir, 'token')}` }, api.fetcher)
        // First poll refreshes the repository list and asks every live repository.
        expect(await forge.queued!({ labels: ['mirab-linux-arm64'], platform: 'linux-arm64' })).toBe(3)
        expect(api.calls.some((c) => c.path.startsWith('/repos/zegadb/attic'))).toBe(false)
        // An x64 runner takes none of them.
        expect(await forge.queued!({ labels: ['mirab-linux-x64'], platform: 'linux-x64' })).toBe(0)
    })

    test('later polls ask only recently pushed repositories, with If-None-Match, and a 304 keeps the last answer', async () => {
        const api = org()
        const forge = github({ scope: 'zegadb', token: `file:${join(dir, 'token')}` }, api.fetcher)
        await forge.queued!({ labels: ['mirab-linux-arm64'], platform: 'linux-arm64' })
        const first = api.calls.length
        expect(await forge.queued!({ labels: ['mirab-linux-arm64'], platform: 'linux-arm64' })).toBe(2)
        const second = api.calls.slice(first)
        expect(second.some((c) => c.path.startsWith('/repos/zegadb/old'))).toBe(false)
        expect(second.length).toBeGreaterThan(0)
        expect(second.every((c) => c.status === 304 && c.ifNoneMatch)).toBe(true)
    })

    test('without "Actions: read" the error says so', async () => {
        const forge = github({ scope: 'addiscorp/runner-smoke', token: `file:${join(dir, 'token')}` },
            (async () => new Response('{"message":"Resource not accessible by integration"}', { status: 403 })) as unknown as typeof fetch)
        await expect(forge.queued!({ labels: [], platform: 'linux-arm64' })).rejects.toThrow(/needs "Actions: read"/)
    })
})

describe('runner definitions', () => {
    test('a folder of definitions imports mirab and woreda without node_modules of its own', async () => {
        const defs = join(dir, 'defs')
        await mkdir(defs)
        await writeFile(join(defs, 'zeg.ts'), `import { defineRunner } from 'mirab'
import { github } from 'woreda'
export default defineRunner({ name: 'zeg', forge: github({ scope: 'zegadb', token: 'file:/nonexistent' }), labels: ['mirab'] })
`)
        await writeFile(join(defs, 'notes.d.ts'), 'export {}\n')
        const loaded = await loadDefinitions(defs)
        expect(loaded.map(d => [d.name, d.forge.name, d.labels])).toEqual([['zeg', 'github', ['mirab']]])
        await writeFile(join(defs, 'broken.ts'), 'export default 42\n')
        await expect(loadDefinitions(defs)).rejects.toThrow(/defineRunner/)
    })

    test('the LaunchAgent keeps serve running and escapes its arguments', () => {
        const plist = launchAgentPlist(['/usr/local/bin/woreda'], '/Users/sami/runners & co', '/Users/sami/Library/Logs/woreda-serve.log')
        expect(plist).toContain('<string>gg.addis.woreda.serve</string>')
        expect(plist).toContain('<string>serve</string>')
        expect(plist).toContain('<string>/Users/sami/runners &amp; co</string>')
        expect(plist).toContain('<key>KeepAlive</key><true/>')
    })
})

test('the VM image is the canary of the mirab commit woreda pins', () => {
    expect(mirabRelease('github:addiscorp/mirab#997919bf1f07c29ebb690c643fd074bc3ec476f9', '0.2.0')).toBe('0.2.0-canary-997919b')
    expect(mirabRelease('^0.3.0', '0.3.0')).toBeUndefined()
    expect(mirabRelease()).toMatch(/^\d+\.\d+\.\d+-canary-[0-9a-f]{7}$/)
})
