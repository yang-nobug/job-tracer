import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 阿里云 OSS 极简封装（REST 签名 V1）：上传 / 生成临时签名 URL / 删除
// 仅服务录音转写管道中转使用，故不引 ali-oss SDK，用 node:crypto 手写签名
// 配置文件：项目根目录 config.json 的 oss 段（已 gitignore）

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../../config.json')

export interface OssConfig {
  accessKeyId: string
  accessKeySecret: string
  bucket: string
  region: string
}

export function loadOssConfig(): OssConfig | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as { oss?: Partial<OssConfig> }
    const oss = raw.oss
    if (!oss?.accessKeyId || !oss?.accessKeySecret || !oss?.bucket || !oss?.region) return null
    for (const v of [oss.accessKeyId, oss.accessKeySecret, oss.bucket, oss.region]) {
      if (String(v).includes('填入')) return null
    }
    return {
      accessKeyId: oss.accessKeyId,
      accessKeySecret: oss.accessKeySecret,
      bucket: oss.bucket,
      region: oss.region
    }
  } catch {
    return null
  }
}

function hmacSha1(secret: string, data: string): string {
  return createHmac('sha1', secret).update(data, 'utf-8').digest('base64')
}

function baseUrl(config: OssConfig): string {
  return `https://${config.bucket}.${config.region}.aliyuncs.com`
}

/** 上传本地文件到私有桶（PUT Object，签名 V1） */
export async function ossPut(config: OssConfig, objectKey: string, filePath: string, contentType: string): Promise<void> {
  const date = new Date().toUTCString()
  const signature = hmacSha1(
    config.accessKeySecret,
    `PUT\n\n${contentType}\n${date}\n/${config.bucket}/${objectKey}`
  )
  const res = await fetch(`${baseUrl(config)}/${objectKey}`, {
    method: 'PUT',
    headers: {
      Date: date,
      'Content-Type': contentType,
      Authorization: `OSS ${config.accessKeyId}:${signature}`
    },
    body: readFileSync(filePath)
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OSS 上传失败 (${res.status}): ${body.slice(0, 200)}`)
  }
}

/** 生成临时可下载的签名 URL（默认 1 小时），供 ASR 服务拉取音频 */
export function ossSignedUrl(config: OssConfig, objectKey: string, expiresSec = 3600): string {
  const expires = Math.floor(Date.now() / 1000) + expiresSec
  const signature = hmacSha1(
    config.accessKeySecret,
    `GET\n\n\n${expires}\n/${config.bucket}/${objectKey}`
  )
  return `${baseUrl(config)}/${objectKey}?OSSAccessKeyId=${encodeURIComponent(config.accessKeyId)}&Expires=${expires}&Signature=${encodeURIComponent(signature)}`
}

/** 删除对象（转写完成后清理，不在 OSS 留音频副本） */
export async function ossDelete(config: OssConfig, objectKey: string): Promise<void> {
  const date = new Date().toUTCString()
  const signature = hmacSha1(
    config.accessKeySecret,
    `DELETE\n\n\n${date}\n/${config.bucket}/${objectKey}`
  )
  const res = await fetch(`${baseUrl(config)}/${objectKey}`, {
    method: 'DELETE',
    headers: {
      Date: date,
      Authorization: `OSS ${config.accessKeyId}:${signature}`
    }
  })
  // 404 = 本来就不存在，视为删除成功；其余失败抛错（调用方记录但不中断）
  if (!res.ok && res.status !== 404) {
    throw new Error(`OSS 删除失败 (${res.status})`)
  }
}
