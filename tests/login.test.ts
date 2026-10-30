import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WOREDA_CLIENT_ID, deviceLogin, loadLogin, loginToken, logout } from '../src/forges/github-login.ts'
import { github } from '../src/forges/github.ts'

let dir: string
beforeAll(async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    dir = await mkdtemp(join(resolve('.tmp'), 'login-'))
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

type Call = { url: string; fields: Record<string, string>; auth?: string }
/** github.com's OAuth endpoints, answering from a script of replies. */
function fakeGithub(replies: Record<string, unknown[]>) {
    const calls: Call[] = []
    const fetcher = (async (url: string, init: RequestInit = {}) => {
        const headers = (init.headers ?? {}) as Record<string, string>
        calls.push({ url, fields: Object.fromEntries(new URLSearchParams(String(init.body ?? ''))), auth: headers.authorization })
        const path = new URL(url).pathname
        const queue = replies[path]
        if (!queue?.length) return new Response('{}', { status: 404 })
        return new Response(JSON.stringify(queue.length > 1 ? queue.shift() : queue[0]), { status: 200 })
    }) as unknown as typeof fetch
    return { calls, fetcher }
}

const device = { device_code: 'DEV', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }

describe('woreda login (device flow)', () => {
    test('shows the code, waits through pending and slow_down, stores the tokens 0600 with no secret sent', async () => {
        const file = join(dir, 'a', 'login.json')
        const gh = fakeGithub({
            '/login/device/code': [device],
            '/login/oauth/access_token': [
                { error: 'authorization_pending' },
                { error: 'slow_down', interval: 10 },
                { access_token: 'ghu_access', expires_in: 28800, refresh_token: 'ghr_refresh', refresh_token_expires_in: 15897600 },
            ],
            '/user': [{ login: 'samifouad' }],
        })
        const shown: unknown[] = [], slept: number[] = []
        const r = await deviceLogin({ file, fetcher: gh.fetcher, show: c => void shown.push(c), sleep: async ms => void slept.push(ms), now: () => 1_000_000 })
        expect(shown).toEqual([{ uri: 'https://github.com/login/device', code: 'WDJB-MJHT' }])
        expect(slept).toEqual([5000, 5000, 10000])
        expect(r.user).toBe('samifouad')
        expect(gh.calls[0]!.fields).toEqual({ client_id: WOREDA_CLIENT_ID })
        for (const c of gh.calls) expect(Object.keys(c.fields)).not.toContain('client_secret')
        const stored = (await loadLogin(file))!
        expect([stored.accessToken, stored.refreshToken, stored.expiresAt]).toEqual(['ghu_access', 'ghr_refresh', new Date(1_000_000 + 28800_000).toISOString()])
        expect((await stat(file)).mode & 0o777).toBe(0o600)
        expect((await stat(join(dir, 'a'))).mode & 0o777).toBe(0o700)
    })

    test('a declined request is an error, and nothing is stored', async () => {
        const file = join(dir, 'declined.json')
        const gh = fakeGithub({ '/login/device/code': [device], '/login/oauth/access_token': [{ error: 'access_denied' }] })
        await expect(deviceLogin({ file, fetcher: gh.fetcher, show: () => {}, sleep: async () => {} })).rejects.toThrow(/declined/)
        expect(await loadLogin(file)).toBeUndefined()
    })

    test('a fresh token is used as it is; an expiring one is refreshed once and the rotated refresh token kept', async () => {
        const file = join(dir, 'refresh.json')
        const t0 = Date.parse('2026-10-28T00:00:00Z')
        await writeFile(file, JSON.stringify({ clientId: WOREDA_CLIENT_ID, user: 'samifouad', accessToken: 'ghu_old', expiresAt: new Date(t0 + 3600_000).toISOString(), refreshToken: 'ghr_old' }))
        const gh = fakeGithub({ '/login/oauth/access_token': [{ access_token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_new', refresh_token_expires_in: 15897600 }] })
        expect(await loginToken({ file, fetcher: gh.fetcher, now: () => t0 })).toBe('ghu_old')
        expect(gh.calls).toHaveLength(0)
        // 3 minutes before expiry: refresh.
        const later = () => t0 + 3600_000 - 180_000
        expect(await loginToken({ file, fetcher: gh.fetcher, now: later })).toBe('ghu_new')
        expect(gh.calls[0]!.fields).toEqual({ client_id: WOREDA_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'ghr_old' })
        const stored = (await loadLogin(file))!
        expect([stored.accessToken, stored.refreshToken]).toEqual(['ghu_new', 'ghr_new'])
        // The new token is fresh: no second refresh.
        expect(await loginToken({ file, fetcher: gh.fetcher, now: later })).toBe('ghu_new')
        expect(gh.calls).toHaveLength(1)
    })

    test('a refresh GitHub refuses says to log in again; no login says how to', async () => {
        const file = join(dir, 'refused.json')
        await writeFile(file, JSON.stringify({ clientId: WOREDA_CLIENT_ID, user: 'u', accessToken: 'a', expiresAt: '2000-01-01T00:00:00Z', refreshToken: 'r' }))
        const gh = fakeGithub({ '/login/oauth/access_token': [{ error: 'bad_refresh_token' }] })
        await expect(loginToken({ file, fetcher: gh.fetcher })).rejects.toThrow(/run woreda login/)
        await expect(loginToken({ file: join(dir, 'none.json') })).rejects.toThrow(/not logged in to GitHub: run woreda login/)
    })

    test('github({ login }) registers runners with the login token', async () => {
        const file = join(dir, 'forge.json')
        await writeFile(file, JSON.stringify({ clientId: WOREDA_CLIENT_ID, user: 'u', accessToken: 'ghu_live' }))
        const calls: string[] = []
        const fetcher = (async (_url: string, init: RequestInit) => {
            calls.push((init.headers as Record<string, string>).authorization!)
            return new Response(JSON.stringify({ encoded_jit_config: 'J', runner: { id: 1 } }), { status: 201 })
        }) as unknown as typeof fetch
        await github({ scope: 'addiscorp', login: { file } }, fetcher).ticket({ name: 'a', labels: [], platform: 'linux-arm64' })
        expect(calls).toEqual(['Bearer ghu_live'])
        expect(() => github({ scope: 'addiscorp', login: true, token: 'file:/x' })).toThrow(/exactly one/)
    })

    test('logout removes the stored login', async () => {
        const file = join(dir, 'out.json')
        await writeFile(file, '{}')
        expect((await logout(file)).removed).toBe(true)
        await expect(readFile(file)).rejects.toThrow()
    })
})

describe('woreda login prints for a person', () => {
    const c = { uri: 'https://github.com/login/device', code: '10F9-0334' }
    test('in a terminal the URL is an OSC 8 hyperlink on its own line, so it opens with a tap', async () => {
        const { deviceCodeText } = await import('../src/woreda.ts')
        const text = deviceCodeText(c, true)
        expect(text).toContain(`\n    \x1b]8;;${c.uri}\x1b\\${c.uri}\x1b]8;;\x1b\\\n`)
        expect(text).toContain(c.code)
        expect(text).not.toContain('{')
    })
    test('piped, the text carries no escape codes', async () => {
        const { deviceCodeText } = await import('../src/woreda.ts')
        const text = deviceCodeText(c, false)
        expect(text).not.toContain('\x1b')
        expect(text).toContain(`\n    ${c.uri}\n`)
        expect(text).toContain(`\n    ${c.code}\n`)
    })
})
