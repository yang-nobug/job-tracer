import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DATA_DIR } from './data-paths.js'

const SECRET_DIR = path.join(DATA_DIR, 'secrets')
const configuredKeyDir = process.env.JOB_TRACER_KEY_DIR?.trim()
const defaultKeyDir = process.env.LOCALAPPDATA?.trim()
  ? path.join(process.env.LOCALAPPDATA.trim(), 'job-tracer')
  : path.join(os.homedir(), '.job-tracer')
const KEY_DIR = configuredKeyDir ? path.resolve(configuredKeyDir) : defaultKeyDir
const MASTER_KEY_PATH = path.join(KEY_DIR, 'mail-master.key')
const QQ_CREDENTIAL_REF = 'qq-mail-v1'
const QQ_CREDENTIAL_PATH = path.join(SECRET_DIR, `${QQ_CREDENTIAL_REF}.json`)

export interface EncryptedSecret {
  version: 1
  algorithm: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
}

function ensureSecretDir(): void {
  mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 })
  try { chmodSync(SECRET_DIR, 0o700) } catch { /* Windows 不完整支持 POSIX mode，忽略 */ }
}

function loadOrCreateMasterKey(): Buffer {
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 })
  try { chmodSync(KEY_DIR, 0o700) } catch { /* Windows 不完整支持 POSIX mode，忽略 */ }
  if (!existsSync(MASTER_KEY_PATH)) {
    try {
      writeFileSync(MASTER_KEY_PATH, randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const key = readFileSync(MASTER_KEY_PATH)
  if (key.length !== 32) throw new Error('本机邮箱凭据密钥损坏，请删除邮箱连接后重新配置')
  try { chmodSync(MASTER_KEY_PATH, 0o600) } catch { /* Windows 不完整支持 POSIX mode，忽略 */ }
  return key
}

function credentialAad(email: string): Buffer {
  return Buffer.from(`job-tracer:mail:qq:${email.trim().toLowerCase()}`, 'utf8')
}

export function encryptSecret(secret: string, key: Buffer, aad: Buffer): EncryptedSecret {
  if (key.length !== 32) throw new Error('加密密钥长度无效')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

export function decryptSecret(payload: EncryptedSecret, key: Buffer, aad: Buffer): string {
  if (payload.version !== 1 || payload.algorithm !== 'aes-256-gcm') throw new Error('不支持的邮箱凭据格式')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8')
}

export function storeQqAuthorizationCode(email: string, authorizationCode: string): string {
  ensureSecretDir()
  const key = loadOrCreateMasterKey()
  const payload = encryptSecret(authorizationCode, key, credentialAad(email))
  const tempPath = `${QQ_CREDENTIAL_PATH}.${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
  renameSync(tempPath, QQ_CREDENTIAL_PATH)
  try { chmodSync(QQ_CREDENTIAL_PATH, 0o600) } catch { /* Windows 不完整支持 POSIX mode，忽略 */ }
  return QQ_CREDENTIAL_REF
}

export function loadQqAuthorizationCode(credentialRef: string, email: string): string {
  if (credentialRef !== QQ_CREDENTIAL_REF || !existsSync(QQ_CREDENTIAL_PATH)) {
    throw new Error('本机没有找到邮箱授权码，请重新连接')
  }
  try {
    const payload = JSON.parse(readFileSync(QQ_CREDENTIAL_PATH, 'utf8')) as EncryptedSecret
    return decryptSecret(payload, loadOrCreateMasterKey(), credentialAad(email))
  } catch (error) {
    if ((error as Error).message.includes('本机没有找到')) throw error
    throw new Error('本机邮箱凭据无法解密，请删除连接后重新配置')
  }
}

export function hasQqAuthorizationCode(credentialRef: string): boolean {
  return credentialRef === QQ_CREDENTIAL_REF
    && existsSync(QQ_CREDENTIAL_PATH)
    && existsSync(MASTER_KEY_PATH)
}

export function deleteQqAuthorizationCode(credentialRef: string): void {
  if (credentialRef !== QQ_CREDENTIAL_REF) return
  rmSync(QQ_CREDENTIAL_PATH, { force: true })
}
