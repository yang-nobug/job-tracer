import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { db, now, APPLICATION_MATERIALS_DIR } from './db.js'
import { IMPORT_LIMITS, isCalendarDate, type ImportSource, type ImportDraft, type ImportAnalysis } from '../../shared/application-import.js'

export class ImportError extends Error {
  constructor(message: string, public status = 422) { super(message) }
}
interface ImportRow { id: string; application_id: number | null; analysis_json: string | null; confirmed_json: string | null; expires_at: string }
interface MaterialRow extends Omit<ImportSource, 'url'> { stored_name: string | null }
export const activeImports = new Map<string, AbortController>()

export function materialPath(name: string): string {
  if (path.basename(name) !== name || !/^[\da-f-]+\.(png|jpg|webp)$/.test(name)) throw new ImportError('无效的材料路径')
  return path.join(APPLICATION_MATERIALS_DIR, name)
}

/** Read real file signatures and dimensions; never trust multipart MIME or extension. */
export function inspectImage(bytes: Buffer): { mime: string; ext: string; width: number; height: number } {
  let mime = '', ext = '', width = 0, height = 0
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    mime = 'image/png'; ext = 'png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
    let offset = 8, first = true, complete = false
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
      if (length > bytes.length - offset - 12 || (first && (type !== 'IHDR' || length !== 13))) break
      offset += length + 12; first = false
      if (type === 'IEND' && length === 0 && offset === bytes.length) { complete = true; break }
    }
    if (!complete) { mime = ''; width = 0; height = 0 }
  } else if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) break
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); mime = 'image/jpeg'; ext = 'jpg'; break
      }
      offset += length
    }
    if (mime && !(bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9)) { mime = ''; width = 0; height = 0 }
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16)
    if (chunk === 'VP8X') {
      if (bytes[20] & 2) throw new ImportError('不支持动画 WebP，请上传静态截图')
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3)
    } else if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1
    } else if (chunk === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff
    }
    if (bytes.readUInt32LE(4) + 8 === bytes.length) { mime = 'image/webp'; ext = 'webp' }
  }
  if (!width || !height || !mime) throw new ImportError('图片文件无效，仅支持 PNG、JPEG、静态 WebP')
  if (width * height > IMPORT_LIMITS.pixels || width > 24000 || height > 24000) throw new ImportError('图片过长或像素过大，请分段截图后上传（每张最多 1600 万像素）')
  return { mime, ext, width, height }
}

function capturedAt(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !isCalendarDate(value)) throw new ImportError('材料截取日期格式不正确')
  return value
}
function filename(value: string): string {
  const decoded = Buffer.from(value, 'latin1').toString('utf8')
  return path.basename(decoded.includes('\ufffd') ? value : decoded).slice(0, 200)
}
export function createImport(text: unknown, files: Express.Multer.File[], meta: unknown): ImportDraft {
  if (typeof text !== 'string' || text.length > IMPORT_LIMITS.text) throw new ImportError(`文字最多 ${IMPORT_LIMITS.text} 字`)
  if (!text.trim() && !files.length) throw new ImportError('请添加文字或截图')
  if (files.length > IMPORT_LIMITS.images || files.reduce((sum, file) => sum + file.size, 0) > IMPORT_LIMITS.totalBytes) throw new ImportError('最多 9 张图片，总大小不超过 30 MB')
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new ImportError('材料信息格式不正确')
  const metadata = meta as { image_dates?: unknown; text_date?: unknown }
  const dates = metadata.image_dates ?? files.map(() => null)
  if (!Array.isArray(dates) || dates.length !== files.length) throw new ImportError('截图日期必须与图片一一对应')
  const images = files.map((file, i) => ({ file, info: inspectImage(file.buffer), date: capturedAt(dates[i]) }))
  const textDate = capturedAt(metadata.text_date)
  const id = randomUUID()
  const written: string[] = []
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO application_imports(id, created_at, expires_at) VALUES (?, ?, ?)').run(id, now(), new Date(Date.now() + 24 * 3600_000).toISOString())
      const insert = db.prepare('INSERT INTO application_materials(import_id,id,kind,text,filename,stored_name,mime,captured_at) VALUES (?,?,?,?,?,?,?,?)')
      if (text.trim()) insert.run(id, 'text_1', 'text', text.trim(), null, null, null, textDate)
      images.forEach(({ file, info, date }, i) => {
        const name = `${randomUUID()}.${info.ext}`
        writeFileSync(materialPath(name), file.buffer, { flag: 'wx' }); written.push(name)
        insert.run(id, `image_${i + 1}`, 'image', null, filename(file.originalname), name, info.mime, date)
      })
    })()
  } catch (error) { written.forEach(removeFile); throw error }
  return getImport(id)
}
function removeFile(name: string): void {
  try { unlinkSync(materialPath(name)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
export function getMaterialFileNames(id: string): string[] {
  return getMaterials(id).flatMap(source => source.stored_name ? [source.stored_name] : [])
}
export function removeMaterialFiles(names: string[]): void {
  for (const name of names) removeFile(name)
}
export function getImportRow(id: string): ImportRow {
  const row = db.prepare('SELECT * FROM application_imports WHERE id=?').get(id) as ImportRow | undefined
  if (!row) throw new ImportError('材料不存在或已清理，请重新上传', 404)
  if (!row.application_id && row.expires_at <= now()) throw new ImportError('临时材料已过期，请重新上传', 410)
  return row
}
export function getMaterials(id: string): MaterialRow[] {
  return db.prepare('SELECT * FROM application_materials WHERE import_id=? ORDER BY rowid').all(id) as MaterialRow[]
}
export function getImport(id: string): ImportDraft {
  const row = getImportRow(id)
  return {
    id, application_id: row.application_id, analysis: row.analysis_json ? JSON.parse(row.analysis_json) as ImportAnalysis : null,
    sources: getMaterials(id).map(({ stored_name, ...source }) => ({ ...source, url: stored_name ? `/api/application-imports/${id}/sources/${source.id}/file` : null }))
  }
}
export function imageDataUrl(importId: string, sourceId: string): string {
  const image = getMaterials(importId).find(source => source.id === sourceId && source.kind === 'image')
  if (!image?.stored_name) throw new ImportError('图片不存在', 404)
  return `data:${image.mime};base64,${readFileSync(materialPath(image.stored_name)).toString('base64')}`
}
export function deleteImport(id: string, allowCommitted = false): void {
  const row = db.prepare('SELECT * FROM application_imports WHERE id=?').get(id) as ImportRow | undefined
  if (!row) return
  if (row.application_id && !allowCommitted) throw new ImportError('已保存的原始材料不能从临时入口删除', 409)
  activeImports.get(id)?.abort()
  const files = getMaterialFileNames(id)
  db.prepare('DELETE FROM application_imports WHERE id=?').run(id)
  removeMaterialFiles(files)
}
export function cleanupExpiredImports(): void {
  const expired = db.prepare('SELECT id FROM application_imports WHERE application_id IS NULL AND expires_at <= ?').all(now()) as { id: string }[]
  for (const { id } of expired) if (!activeImports.has(id)) deleteImport(id)
}
export function findDuplicates(fields: { company: string; position: string; location?: string | null; jd_link?: string | null }, exclude?: number): ImportAnalysis['duplicates'] {
  return db.prepare(`SELECT id,company,position,location FROM applications WHERE id != ? AND
    ((? != '' AND jd_link=?) OR (lower(trim(company))=lower(trim(?)) AND lower(trim(position))=lower(trim(?))
     AND (? = '' OR coalesce(location,'') = '' OR lower(trim(location))=lower(trim(?))))) LIMIT 10`)
    .all(exclude ?? -1, fields.jd_link ?? '', fields.jd_link ?? '', fields.company, fields.position, fields.location ?? '', fields.location ?? '') as ImportAnalysis['duplicates']
}
