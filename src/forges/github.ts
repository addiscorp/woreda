// The GitHub Actions adapter for mirab runners: one just-in-time runner per
// job, registered on an organisation or a repository. Every forge-specific
// word lives here; mirab only sees the Forge interface.
import { createSign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dropToRunner, isDarwin, secretDir, type Forge, type RunnerPlatform } from 'mirab'
import { loginToken } from './github-login.ts'
import { z } from 'zod'

/** Where a credential is read from, each time it's needed: `file:<path>`. Never inline. */
const secretRef = z
    .string()
    .regex(/^file:.+/, 'a credential is a file reference: file:/path/to/it')

export const githubOptionsSchema = z.strictObject({
    /** An organisation (`zegadb`) or one repository (`addiscorp/runner-smoke`). */
    scope: z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/),
    /** A GitHub App installed on the scope, permission "Self-hosted runners:
     *  read & write" (org) or "Administration: read & write" (repo) only. */
    app: z
        .strictObject({
            id: z.number().int().positive(),
            installation: z.number().int().positive(),
            key: secretRef,
        })
        .optional(),
    /** Or a fine-grained token with that same single permission. */
    token: secretRef.optional(),
    /** Or `woreda login` (the device flow, acting as whoever approved it, with
     *  the Woreda App's one permission): true for the default login file. */
    login: z.union([z.literal(true), z.strictObject({ file: z.string() })]).optional(),
    /** Organisation runner group (1 = Default). */
    runnerGroup: z.number().int().positive().default(1),
    api: z.string().url().default('https://api.github.com'),
})
export type GithubOptions = z.input<typeof githubOptionsSchema>

const RUNNER_DIR = '/opt/actions-runner'
const jitFile = (p: RunnerPlatform) => `${secretDir(p)}/jit`

/** GitHub's name for a platform in runner release assets. */
export const runnerAsset = (p: RunnerPlatform) => (p === 'darwin-arm64' ? 'osx-arm64' : p)

/** The SHA-256 GitHub publishes for one platform in a runner release's notes. */
export function releaseSha(body: string, platform: RunnerPlatform): string | undefined {
    const a = runnerAsset(platform)
    const m = new RegExp(`BEGIN SHA ${a} -->\\s*([0-9a-f]{64})\\s*<!-- END SHA ${a}`).exec(body)
    return m?.[1]
}

export const runnerTarball = (version: string, platform: RunnerPlatform) =>
    `https://github.com/actions/runner/releases/download/v${version}/actions-runner-${runnerAsset(platform)}-${version}.tar.gz`

const expand = (path: string) => (path.startsWith('~/') ? homedir() + path.slice(1) : path)
const readRef = async (ref: string) => (await readFile(expand(ref.slice('file:'.length)), 'utf8')).trim()

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url')

/** A GitHub App JWT (RS256, 9 minutes, backdated a minute for clock skew). */
export function appJwt(appId: number, privateKey: string, now = Date.now()): string {
    const iat = Math.floor(now / 1000) - 60
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const body = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }))
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey)
    return `${head}.${body}.${b64url(sig)}`
}

export type Fetch = typeof fetch

/** The labels a GitHub runner carries: GitHub's own (self-hosted, OS, arch)
 *  and mirab's. One function, so a registration and the queued-jobs count
 *  can't disagree about which jobs a runner takes. */
export function githubLabels(labels: string[], platform: RunnerPlatform): string[] {
    const os = isDarwin(platform) ? 'macOS' : 'Linux'
    return [...new Set(['self-hosted', os, platform.endsWith('-arm64') ? 'ARM64' : 'X64', ...labels])]
}

/** A job GitHub would give a runner with `labels`: every label it asks for is
 *  one the runner has (GitHub compares labels without case). */
export function takes(labels: string[], wants: string[]): boolean {
    const have = new Set(labels.map((l) => l.toLowerCase()))
    return wants.length > 0 && wants.every((w) => have.has(w.toLowerCase()))
}

/** Repositories pushed to this recently are asked about every poll; the rest
 *  only when the repository list is refreshed. */
const ACTIVE_MS = 14 * 24 * 3600_000
const REPOS_REFRESH_MS = 10 * 60_000

export function github(input: GithubOptions, fetcher: Fetch = fetch): Forge {
    const o = githubOptionsSchema.parse(input)
    if ([o.app, o.token, o.login].filter(Boolean).length !== 1) throw new Error('github(): give exactly one of app, token or login')
    const repo = o.scope.includes('/')
    const base = repo ? `${o.api}/repos/${o.scope}` : `${o.api}/orgs/${o.scope}`
    let cached: { token: string; until: number } | undefined
    // Conditional GETs: GitHub answers 304 when nothing changed, and a 304
    // doesn't count against the rate limit, so polling queued jobs is cheap.
    const etags = new Map<string, { etag: string; body: unknown }>()
    let repos: { all: string[]; active: string[]; at: number } | undefined

    async function call<T>(method: string, url: string, token: string | null, body?: unknown): Promise<T> {
        const res = await fetcher(url, {
            method,
            headers: {
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
                'user-agent': 'woreda',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            const err = new Error(`GitHub ${method} ${new URL(url).pathname}: ${res.status} ${text.slice(0, 200)}`)
            Object.assign(err, { status: res.status })
            throw err
        }
        return (res.status === 204 ? undefined : await res.json()) as T
    }

    async function cachedGet<T>(url: string, t: string): Promise<T> {
        const prior = etags.get(url)
        const res = await fetcher(url, {
            headers: {
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
                'user-agent': 'woreda',
                authorization: `Bearer ${t}`,
                ...(prior ? { 'if-none-match': prior.etag } : {}),
            },
            signal: AbortSignal.timeout(30_000),
        })
        if (res.status === 304 && prior) return prior.body as T
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            const hint = res.status === 403 || res.status === 404 ? ' (the GitHub App needs "Actions: read" to see queued jobs)' : ''
            throw new Error(`GitHub GET ${new URL(url).pathname}: ${res.status}${hint} ${text.slice(0, 120)}`)
        }
        const body = (await res.json()) as T
        const etag = res.headers.get('etag')
        if (etag) etags.set(url, { etag, body })
        return body
    }

    /** The repositories to look at this poll. */
    async function reposToAsk(t: string): Promise<string[]> {
        if (repo) return [o.scope]
        const now = Date.now()
        if (repos && now - repos.at < REPOS_REFRESH_MS) return repos.active
        const all: { full_name: string; pushed_at: string | null; archived: boolean }[] = []
        // 100 per page, at most 10 pages (1,000 repositories).
        for (let page = 1; page <= 10; page++) {
            const r = await cachedGet<typeof all>(`${o.api}/orgs/${o.scope}/repos?type=all&sort=pushed&per_page=100&page=${page}`, t)
            all.push(...r)
            if (r.length < 100) break
        }
        const live = all.filter((r) => !r.archived)
        repos = {
            all: live.map((r) => r.full_name),
            active: live.filter((r) => r.pushed_at && now - Date.parse(r.pushed_at) < ACTIVE_MS).map((r) => r.full_name),
            at: now,
        }
        // This poll is the refresh: ask every repository once.
        return repos.all
    }

    async function token(): Promise<string> {
        if (o.token) return readRef(o.token)
        if (o.login) return loginToken({ file: o.login === true ? undefined : expand(o.login.file), fetcher })
        if (cached && Date.now() < cached.until) return cached.token
        const jwt = appJwt(o.app!.id, await readRef(o.app!.key))
        const r = await call<{ token: string; expires_at: string }>(
            'POST',
            `${o.api}/app/installations/${o.app!.installation}/access_tokens`,
            jwt,
        )
        // Installation tokens last an hour; renew ten minutes early.
        cached = { token: r.token, until: Date.parse(r.expires_at) - 10 * 60_000 }
        return r.token
    }

    return {
        name: 'github',
        async ticket({ name, labels, platform }) {
            const r = await call<{ encoded_jit_config: string; runner: { id: number } }>(
                'POST',
                `${base}/actions/runners/generate-jitconfig`,
                await token(),
                {
                    name,
                    runner_group_id: o.runnerGroup,
                    labels: githubLabels(labels, platform),
                    work_folder: '_work',
                },
            )
            return { name, secret: { jit: r.encoded_jit_config }, meta: { id: String(r.runner.id) } }
        },
        guest: {
            async install(platform) {
                // The latest release: GitHub retires old runner versions, and a runner
                // that has to update itself would download on every job.
                const rel = await call<{ tag_name: string; body: string }>(
                    'GET',
                    `${o.api}/repos/actions/runner/releases/latest`,
                    await token().catch(() => null),
                )
                const version = rel.tag_name.replace(/^v/, '')
                const sha = releaseSha(rel.body ?? '', platform)
                if (!sha) throw new Error(`actions/runner ${version}: no published SHA-256 for ${platform}`)
                const tarball = `${RUNNER_DIR}/runner.tar.gz`
                return {
                    key: `actions-runner ${version} ${sha}`,
                    steps: [
                        {
                            argv: [
                                'sh',
                                '-euc',
                                [
                                    `mkdir -p ${RUNNER_DIR}`,
                                    `curl -fsSL -o ${tarball} '${runnerTarball(version, platform)}'`,
                                    `echo '${sha}  ${tarball}' | ${isDarwin(platform) ? 'shasum -a 256' : 'sha256sum'} -c -`,
                                    `tar -xzf ${tarball} -C ${RUNNER_DIR}`,
                                    `rm -f ${tarball}`,
                                    // Linux only: the runner's libraries (macOS has them).
                                    isDarwin(platform) ? 'true' : `${RUNNER_DIR}/bin/installdependencies.sh`,
                                    // The runner may update itself in place; let it.
                                    `chown -R 1001:1001 ${RUNNER_DIR}`,
                                ].join(' && '),
                            ],
                        },
                    ],
                }
            },
            buildEgress: ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'],
            job(ticket, platform) {
                const JIT_FILE = jitFile(platform)
                return {
                    // The one-job config: a root-only file on tmpfs, read into the
                    // runner's env and removed before the runner starts, never argv.
                    files: [{ path: JIT_FILE, mode: 0o600, content: ticket.secret.jit!, secret: true }],
                    steps: [
                        {
                            asRoot: true,
                            argv: [
                                'sh',
                                '-c',
                                `ACTIONS_RUNNER_INPUT_JITCONFIG=$(cat ${JIT_FILE}); export ACTIONS_RUNNER_INPUT_JITCONFIG; rm -f ${JIT_FILE}; cd ${RUNNER_DIR}; exec ${dropToRunner(platform).join(' ')} ./run.sh`,
                            ],
                        },
                    ],
                    env: { RUNNER_ALLOW_RUNASROOT: '0' },
                }
            },
            started: (line) => /Running job: /.test(line),
        },
        /** Queued jobs, in the scope's recently pushed repositories, that a
         *  runner with these labels would be given. A queued job can sit in a
         *  run GitHub calls queued, pending (often a pull request's run while
         *  no runner has its labels yet), requested or in_progress: all count. */
        async queued({ labels, platform }) {
            const t = await token()
            const mine = githubLabels(labels, platform)
            let n = 0
            const ask = async (full: string) => {
                for (const status of ['queued', 'pending', 'requested', 'in_progress']) {
                    const runs = await cachedGet<{ workflow_runs: { id: number }[] }>(
                        `${o.api}/repos/${full}/actions/runs?status=${status}&per_page=50`,
                        t,
                    )
                    for (const run of runs.workflow_runs) {
                        const jobs = await cachedGet<{ jobs: { status: string; labels: string[] }[] }>(
                            `${o.api}/repos/${full}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
                            t,
                        )
                        n += jobs.jobs.filter((j) => j.status === 'queued' && takes(mine, j.labels)).length
                    }
                }
            }
            const list = await reposToAsk(t)
            // A few at a time: kind to the API, quick enough for a 15 s poll.
            for (let i = 0; i < list.length; i += 6) await Promise.all(list.slice(i, i + 6).map(ask))
            return n
        },
        async reconcile(prefix, live) {
            const t = await token()
            // 100 per page; 50 pages (5,000 runners) is far past any real scope, and bounds a misbehaving API.
      for (let page = 1; page <= 50; page++) {
                const r = await call<{ runners: { id: number; name: string; busy: boolean }[] }>(
                    'GET',
                    `${base}/actions/runners?per_page=100&page=${page}`,
                    t,
                )
                for (const runner of r.runners)
                    if (runner.name.startsWith(prefix) && !live.includes(runner.name))
                        await call('DELETE', `${base}/actions/runners/${runner.id}`, t).catch((e) => {
                            // A runner GitHub still sees as busy can't be deleted yet; the next sweep gets it.
                            if ((e as { status?: number }).status !== 422) throw e
                        })
                if (r.runners.length < 100) break
            }
        },
    }
}
