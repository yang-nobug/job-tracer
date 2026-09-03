import {
  ImapFlow, type FetchMessageObject, type MailboxObject, type MessageStructureObject
} from 'imapflow'

export const QQ_IMAP_HOST = 'imap.qq.com'
export const QQ_IMAP_PORT = 993
export const QQ_IMAP_MAILBOX = 'INBOX'

export interface MailPreview {
  uid: number
  subject: string
  from: string
  sentAt: string | null
  isRead: boolean
}

export interface MailboxInspection {
  messageCount: number
  readOnly: true
  recent: MailPreview[]
}

export interface MailboxScanBatch {
  uidValidity: string
  previousUid: number
  lastUid: number
  hasMore: boolean
  scanned: MailPreview[]
}

export interface MailMessageBody {
  plainText: string
  html: string
  messageSize: number
  truncated: boolean
}

export class MailConnectionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'MailConnectionError'
  }
}

export function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new MailConnectionError('请输入完整的邮箱地址，例如 123456@qq.com', 'INVALID_EMAIL')
  }
  return email
}

export function normalizeAuthorizationCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim() : ''
  if (code.length < 8 || code.length > 128 || /[\s\u0000-\u001f\u007f]/.test(code)) {
    throw new MailConnectionError('授权码格式不正确，请重新复制 QQ 邮箱生成的授权码', 'INVALID_AUTHORIZATION_CODE')
  }
  return code
}

function clipped(value: string | undefined, fallback: string): string {
  const text = value?.trim() || fallback
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

function formatSender(message: FetchMessageObject): string {
  const senders = message.envelope?.from ?? []
  if (!senders.length) return '未知发件人'
  const result = senders.map(sender => {
    const name = sender.name?.trim()
    const address = sender.address?.trim()
    if (name && address) return `${name} <${address}>`
    return name || address || '未知发件人'
  }).join('、')
  return clipped(result, '未知发件人')
}

function safeIsoDate(value: Date | string | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function mapConnectionError(error: unknown): MailConnectionError {
  if (error instanceof MailConnectionError) return error
  const detail = error as NodeJS.ErrnoException & {
    authenticationFailed?: boolean
    serverResponseCode?: string
  }
  if (detail.authenticationFailed || detail.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return new MailConnectionError(
      'QQ 邮箱拒绝登录。请确认已开启 IMAP/SMTP，并使用授权码而不是 QQ 密码',
      'AUTHENTICATION_FAILED'
    )
  }
  if (['CONNECT_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(detail.code ?? '')) {
    return new MailConnectionError('连接 QQ 邮箱超时，请检查网络后重试', 'CONNECTION_TIMEOUT')
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'ECONNRESET'].includes(detail.code ?? '')) {
    return new MailConnectionError('无法连接 QQ 邮箱服务器，请检查网络后重试', 'NETWORK_ERROR')
  }
  if ((detail.code ?? '').startsWith('CERT_') || ['DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(detail.code ?? '')) {
    return new MailConnectionError('QQ 邮箱的 TLS 证书校验失败，请检查系统时间和网络代理', 'TLS_ERROR')
  }
  return new MailConnectionError('QQ 邮箱连接失败，请稍后重试；授权码不会记录到日志', 'IMAP_ERROR')
}

function createQqClient(email: string, authorizationCode: string): ImapFlow {
  const client = new ImapFlow({
    host: QQ_IMAP_HOST,
    port: QQ_IMAP_PORT,
    secure: true,
    auth: { user: email, pass: authorizationCode },
    disableAutoIdle: true,
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    maxLineLength: 512 * 1024,
    maxLiteralSize: 1024 * 1024,
    maxResponseSize: 2 * 1024 * 1024,
    clientInfo: { name: 'job-tracer', version: '1.0.0', vendor: 'local' }
  })
  // ImapFlow 会通过 error 事件报告连接异常；此处只消费事件，不输出可能含账号信息的原始错误。
  client.on('error', () => undefined)
  return client
}

async function withReadOnlyInbox<T>(
  email: string,
  authorizationCode: string,
  operation: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>
): Promise<T> {
  const client = createQqClient(email, authorizationCode)
  try {
    await client.connect()
    const lock = await client.getMailboxLock(QQ_IMAP_MAILBOX, { readOnly: true, acquireTimeout: 10_000 })
    try {
      if (!client.mailbox || client.mailbox.readOnly !== true) {
        throw new MailConnectionError('邮箱服务器未确认只读模式，已停止读取', 'READ_ONLY_NOT_CONFIRMED')
      }
      return await operation(client, client.mailbox)
    } finally {
      lock.release()
    }
  } catch (error) {
    throw mapConnectionError(error)
  } finally {
    if (client.usable) {
      try { await client.logout() } catch { client.close() }
    } else {
      client.close()
    }
  }
}

function toMailPreview(message: FetchMessageObject): MailPreview {
  return {
    uid: message.uid,
    subject: clipped(message.envelope?.subject, '（无主题）'),
    from: formatSender(message),
    sentAt: safeIsoDate(message.envelope?.date ?? message.internalDate),
    isRead: message.flags?.has('\\Seen') ?? false
  }
}

const ENVELOPE_QUERY = {
  uid: true,
  envelope: true,
  internalDate: true,
  flags: true
} as const

export async function inspectQqMailbox(
  email: string,
  authorizationCode: string,
  previewLimit = 5
): Promise<MailboxInspection> {
  return withReadOnlyInbox(email, authorizationCode, async (client, mailbox) => {
      const messageCount = mailbox.exists
      const recent: MailPreview[] = []
      const limit = Math.min(10, Math.max(1, Math.floor(previewLimit)))
      if (messageCount > 0) {
        const start = Math.max(1, messageCount - limit + 1)
        for await (const message of client.fetch(`${start}:${messageCount}`, ENVELOPE_QUERY)) {
          recent.push(toMailPreview(message))
        }
      }
      recent.reverse()
      return { messageCount, readOnly: true, recent }
  })
}

/**
 * 首次只看最近 initialLimit 封；后续按 UID 每批最多 batchLimit 个，避免一次读取整个大邮箱。
 * 只请求 ENVELOPE/INTERNALDATE/FLAGS，不请求正文、附件或写入命令。
 */
export async function scanQqMailboxEnvelopes(
  email: string,
  authorizationCode: string,
  state?: { uidValidity: string; lastUid: number } | null,
  initialLimit = 100,
  batchLimit = 500
): Promise<MailboxScanBatch> {
  return withReadOnlyInbox(email, authorizationCode, async (client, mailbox) => {
    const uidValidity = String(mailbox.uidValidity)
    const canContinue = state?.uidValidity === uidValidity && Number.isInteger(state.lastUid) && state.lastUid > 0
    const previousUid = canContinue ? state.lastUid : 0
    const scanned: MailPreview[] = []
    let lastUid = previousUid
    let hasMore = false

    if (canContinue) {
      const highestPossibleUid = Math.max(0, mailbox.uidNext - 1)
      if (previousUid < highestPossibleUid) {
        const upperUid = Math.min(highestPossibleUid, previousUid + Math.min(1000, Math.max(1, batchLimit)))
        for await (const message of client.fetch(`${previousUid + 1}:${upperUid}`, ENVELOPE_QUERY, { uid: true })) {
          scanned.push(toMailPreview(message))
        }
        // UID 区间内可能包含已删除邮件；仍推进到本批上界，避免反复扫描空洞。
        lastUid = upperUid
        hasMore = lastUid < highestPossibleUid
      }
    } else if (mailbox.exists > 0) {
      const limit = Math.min(500, Math.max(1, initialLimit))
      const startSequence = Math.max(1, mailbox.exists - limit + 1)
      for await (const message of client.fetch(`${startSequence}:${mailbox.exists}`, ENVELOPE_QUERY)) {
        scanned.push(toMailPreview(message))
      }
      lastUid = scanned.reduce((max, message) => Math.max(max, message.uid), 0)
    }

    scanned.sort((a, b) => a.uid - b.uid)
    return { uidValidity, previousUid, lastUid, hasMore, scanned }
  })
}

interface TextBodyPart { part: string; size: number }

function textBodyParts(structure: MessageStructureObject): { plain: TextBodyPart[]; html: TextBodyPart[] } {
  const plain: TextBodyPart[] = []
  const html: TextBodyPart[] = []
  const visit = (node: MessageStructureObject) => {
    if (node.childNodes?.length) {
      for (const child of node.childNodes) visit(child)
      return
    }
    if (node.disposition?.toLowerCase() === 'attachment') return
    const part = node.part || '1'
    const bodyPart = { part, size: Number(node.size) || 0 }
    const type = node.type.toLowerCase()
    if (type === 'text/plain') plain.push(bodyPart)
    if (type === 'text/html' || type === 'text/x-amp-html') html.push(bodyPart)
  }
  visit(structure)
  const unique = (parts: TextBodyPart[]) => [...new Map(parts.map(item => [item.part, item])).values()]
  return { plain: unique(plain), html: unique(html) }
}

async function streamText(content: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** 按 UID 只下载正文文本部件；附件部件不会请求，邮箱始终以只读模式打开。 */
export async function fetchQqMessageBody(
  email: string,
  authorizationCode: string,
  uidValidity: string,
  uid: number,
  maxBytesPerPart = 256 * 1024
): Promise<MailMessageBody> {
  if (!Number.isInteger(uid) || uid <= 0) throw new MailConnectionError('邮件 UID 无效', 'MESSAGE_NOT_FOUND')
  const limit = Math.min(512 * 1024, Math.max(64 * 1024, Math.floor(maxBytesPerPart)))
  return withReadOnlyInbox(email, authorizationCode, async (client, mailbox) => {
    if (String(mailbox.uidValidity) !== uidValidity) {
      throw new MailConnectionError('收件箱已重建，请重新扫描后再分析这封邮件', 'MAILBOX_CHANGED')
    }
    const message = await client.fetchOne(String(uid), { uid: true, size: true, bodyStructure: true }, { uid: true })
    if (!message || !message.bodyStructure) throw new MailConnectionError('邮件已不存在，请重新扫描', 'MESSAGE_NOT_FOUND')
    const parts = textBodyParts(message.bodyStructure)
    const plainParts = parts.plain.slice(0, 2)
    const htmlParts = parts.html.slice(0, 1)
    const plain: string[] = []
    const html: string[] = []
    let truncated = parts.plain.length > plainParts.length || parts.html.length > htmlParts.length
      || [...plainParts, ...htmlParts].some(item => item.size > limit)

    for (const part of plainParts) {
      const download = await client.download(String(uid), part.part, { uid: true, maxBytes: limit })
      if (!download?.content) continue
      const value = await streamText(download.content)
      truncated ||= Buffer.byteLength(value, 'utf8') >= limit
      plain.push(value)
    }
    for (const part of htmlParts) {
      const download = await client.download(String(uid), part.part, { uid: true, maxBytes: limit })
      if (!download?.content) continue
      const value = await streamText(download.content)
      truncated ||= Buffer.byteLength(value, 'utf8') >= limit
      html.push(value)
    }
    return {
      plainText: plain.join('\n\n'),
      html: html.join('\n\n'),
      messageSize: message.size ?? 0,
      truncated
    }
  })
}
