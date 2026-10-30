/**
 * Filesystem layout and atomic JSON persistence for the customer-service desk.
 *
 * Everything lives under DSH_HOME so it survives plugin upgrades and never
 * lands in the user's workspace. Secrets (platform app keys) stay on this
 * machine; the browser only ever sees masked values.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DATA_DIR_NAME = 'kefu'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function dataDir() {
  return path.join(dshHome(), DATA_DIR_NAME)
}

export function dataPath(...parts) {
  return path.join(dataDir(), ...parts)
}

export async function ensureDir(dir = dataDir()) {
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** Read JSON, returning `fallback` for a missing or corrupt file. */
export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Write JSON atomically (temp file + rename) with 0600. Platform keys live in
 * these files, so a half-written config must never be observable.
 */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temp, file)
  try {
    await fs.chmod(file, 0o600)
  } catch {
    /* Windows ignores POSIX modes; the file stays under the user profile. */
  }
  return value
}

export async function removeFile(file) {
  try {
    await fs.unlink(file)
    return true
  } catch {
    return false
  }
}

/** Mask a credential for display: keep the head, hide the rest. */
export function maskSecret(value) {
  const text = String(value ?? '')
  if (text === '') return ''
  if (text.length <= 4) return '*'.repeat(text.length)
  if (text.length <= 8) return `${text.slice(0, 1)}${'*'.repeat(text.length - 2)}${text.slice(-1)}`
  return `${text.slice(0, 3)}${'*'.repeat(Math.min(8, text.length - 6))}${text.slice(-3)}`
}
