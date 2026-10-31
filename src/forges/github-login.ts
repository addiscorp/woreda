// `woreda login`: GitHub's device flow for the Woreda GitHub App (owned by
// addiscorp). No client secret exists or is needed; the token acts as the
// person who approved it, limited to the App's one permission (organisation
// self-hosted runners). It lasts 8 hours and is refreshed from the stored
// refresh token, which rotates on every refresh.
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The Woreda GitHub App (github.com/apps/woreda-workflow-runners): public. */
export const WOREDA_CLIENT_ID = 'Iv23liu5YW8cArbfuRQX'
export const defaultLoginFile = () => join(homedir(), '.config', 'woreda', 'github-login.json')

export interface StoredLogin {
    clientId: string
    user: string
    accessToken: string
    /** Absent when the App's tokens don't expire. */
    expiresAt?: string
    refreshToken?: string
    refreshExpiresAt?: string
}

type Fetch = typeof fetch
const GITHUB = 'https://github.com'

async function form<T>(fetcher: Fetch, url: string, fields: Record<string, string>): Promise<T> {
    const res = await fetcher(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'woreda' }, body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw Error(`GitHub ${new URL(url).pathname}: ${res.status}`)
    return await res.json() as T
}

const at = (seconds: number | undefined, now: number) => seconds ? new Date(now + seconds * 1000).toISOString() : undefined

type TokenReply = { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; error?: string; error_description?: string; interval?: number }

async function save(file: string, login: StoredLogin) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(login, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
}

export async function loadLogin(file = defaultLoginFile()): Promise<StoredLogin | undefined> {
    try { return JSON.parse(await readFile(file, 'utf8')) as StoredLogin } catch { return undefined }
}

/** The device flow: shows a code to enter at github.com/login/device, waits for approval, stores the tokens. */
export async function deviceLogin(o: { clientId?: string; file?: string; show?: (code: { uri: string; code: string }) => void; fetcher?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
    const clientId = o.clientId ?? WOREDA_CLIENT_ID, file = o.file ?? defaultLoginFile(), fetcher = o.fetcher ?? fetch
    const show = o.show ?? (c => console.error(`Open ${c.uri} and enter: ${c.code}`)), sleep = o.sleep ?? (ms => Bun.sleep(ms)), now = o.now ?? Date.now
    const code = await form<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>(fetcher, `${GITHUB}/login/device/code`, { client_id: clientId })
    show({ uri: code.verification_uri, code: code.user_code })
    const deadline = now() + code.expires_in * 1000
    let interval = (code.interval || 5) * 1000
    for (;;) {
        if (now() > deadline) throw Error('the code expired before it was approved; run woreda login again')
        await sleep(interval)
        const r = await form<TokenReply>(fetcher, `${GITHUB}/login/oauth/access_token`, { client_id: clientId, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
        if (r.error === 'authorization_pending') continue
        if (r.error === 'slow_down') { interval = (r.interval ?? interval / 1000 + 5) * 1000; continue }
        if (r.error === 'access_denied') throw Error('the request was declined on GitHub')
        if (r.error || !r.access_token) throw Error(`GitHub login failed: ${r.error_description ?? r.error ?? 'no token'}`)
        const user = await fetcher('https://api.github.com/user', { headers: { authorization: `Bearer ${r.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'woreda' } }).then(res => res.ok ? res.json() as Promise<{ login: string }> : { login: 'unknown' })
        const t = now()
        const login: StoredLogin = { clientId, user: user.login, accessToken: r.access_token, expiresAt: at(r.expires_in, t), refreshToken: r.refresh_token, refreshExpiresAt: at(r.refresh_token_expires_in, t) }
        await save(file, login)
        return { user: login.user, file, expiresAt: login.expiresAt ?? null, refreshExpiresAt: login.refreshExpiresAt ?? null }
    }
}

/** Only one process refreshes at a time: the refresh token rotates, and a second refresh with the old one would fail. */
async function withLock<T>(file: string, run: () => Promise<T>): Promise<T> {
    const lock = `${file}.lock`
    for (let i = 0; ; i++) {
        try { await mkdir(lock); break } catch {
            const age = await stat(lock).then(s => Date.now() - s.mtimeMs, () => 0)
            if (age > 60_000) { await rm(lock, { recursive: true, force: true }); continue }
            if (i > 300) throw Error(`${lock} is held; remove it if no woreda is running`)
            await Bun.sleep(200)
        }
    }
    try { return await run() } finally { await rm(lock, { recursive: true, force: true }) }
}

const fresh = (l: StoredLogin, now: number) => !l.expiresAt || now < Date.parse(l.expiresAt) - 5 * 60_000

/** A usable access token from `woreda login`, refreshed when it's within 5 minutes of expiring. */
export async function loginToken(o: { file?: string; fetcher?: Fetch; now?: () => number } = {}): Promise<string> {
    const file = o.file ?? defaultLoginFile(), fetcher = o.fetcher ?? fetch, now = o.now ?? Date.now
    const stored = await loadLogin(file)
    if (!stored) throw Error(`not logged in to GitHub: run woreda login (${file})`)
    if (fresh(stored, now())) return stored.accessToken
    return withLock(file, async () => {
        const current = (await loadLogin(file))!
        if (fresh(current, now())) return current.accessToken // another process refreshed it
        if (!current.refreshToken) throw Error('the GitHub login expired; run woreda login')
        const r = await form<TokenReply>(fetcher, `${GITHUB}/login/oauth/access_token`, { client_id: current.clientId, grant_type: 'refresh_token', refresh_token: current.refreshToken })
        if (r.error || !r.access_token) throw Error(`the GitHub login could not be refreshed (${r.error_description ?? r.error ?? 'no token'}); run woreda login`)
        const t = now()
        await save(file, { ...current, accessToken: r.access_token, expiresAt: at(r.expires_in, t), refreshToken: r.refresh_token ?? current.refreshToken, refreshExpiresAt: at(r.refresh_token_expires_in, t) ?? current.refreshExpiresAt })
        return r.access_token
    })
}

export async function logout(file = defaultLoginFile()) {
    const had = !!(await loadLogin(file))
    await rm(file, { force: true })
    return { removed: had, file, note: 'To revoke the approval itself: github.com/settings/apps/authorizations' }
}
