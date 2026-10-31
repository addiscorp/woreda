// Writes a private file (its folder 0700, the file 0600) atomically, and turns
// "permission denied" into what to do about it.
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SERVICE_HOME } from './linux-service.ts'

const userName = (uid: number) => {
    const r = spawnSync('id', ['-nu', String(uid)], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : `uid ${uid}`
}

/** Why `file` can't be written, and the fix: the closest existing folder is someone else's. */
export function notWritable(file: string, cause: NodeJS.ErrnoException): Error {
    let dir = dirname(file)
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
    const owner = statSync(dir).uid, me = process.getuid?.() ?? -1
    const fix = file.startsWith(`${SERVICE_HOME}/`)
        ? 'That is the woreda service\'s; log it in with: sudo woreda login --service'
        : `Fix with: sudo chown -R ${userName(me)} ${dir}`
    return Error(`woreda can't write ${file}: ${dir} belongs to ${userName(owner)}${owner === me ? ' but is not writable' : ', not you'} (${cause.code}). ${fix}`)
}

export async function writePrivate(file: string, content: string) {
    try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        const tmp = `${file}.${process.pid}.tmp`
        await writeFile(tmp, content, { mode: 0o600 })
        await chmod(tmp, 0o600)
        await rename(tmp, file)
    } catch (e) {
        const err = e as NodeJS.ErrnoException
        throw err.code === 'EACCES' || err.code === 'EPERM' ? notWritable(file, err) : err
    }
}

/** Throws the same explanation now if `file` won't be writable later (before
 *  asking someone to approve a login that couldn't be saved). */
export async function checkWritable(file: string) {
    const probe = `${file}.${process.pid}.check`
    try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        await writeFile(probe, '', { mode: 0o600 })
        await rm(probe, { force: true })
    } catch (e) {
        const err = e as NodeJS.ErrnoException
        throw err.code === 'EACCES' || err.code === 'EPERM' ? notWritable(file, err) : err
    }
}
