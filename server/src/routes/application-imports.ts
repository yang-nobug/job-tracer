import { Router } from 'express'
import multer from 'multer'
import { db } from '../db.js'
import { IMPORT_LIMITS } from '../../../shared/application-import.js'
import { activeImports, cleanupExpiredImports, createImport, deleteImport, getImport, getImportRow, getMaterials, ImportError, materialPath } from '../application-materials.js'
import { analyzeImport, extractionConfig } from '../application-extraction.js'

export const applicationImportsRouter = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { files: IMPORT_LIMITS.images, fileSize: IMPORT_LIMITS.imageBytes, fields: 3, fieldSize: IMPORT_LIMITS.text * 4 + 2000, parts: IMPORT_LIMITS.images + 3 } }).array('images', IMPORT_LIMITS.images)
// Limit concurrent uploads too, so the multipart byte limits bound peak memory.
let uploading = false
applicationImportsRouter.get('/config', (_req, res) => res.json(extractionConfig()))
applicationImportsRouter.post('/', (req, res, next) => {
  if (uploading) { res.status(429).json({ message: '另一个材料正在上传，请稍后重试' }); return }
  uploading = true
  upload(req, res, error => {
    uploading = false
    if (error) { res.status(422).json({ message: '上传失败：仅支持最多 9 张、每张不超过 10 MB 的图片，文字最多 20000 字' }); return }
    try {
      cleanupExpiredImports()
      let metadata: unknown
      try { metadata = JSON.parse(req.body?.metadata ?? '{}') } catch { throw new ImportError('材料信息格式不正确') }
      res.status(201).json(createImport(req.body?.text ?? '', (req.files ?? []) as Express.Multer.File[], metadata))
    } catch (err) { next(err) }
  })
})
applicationImportsRouter.get('/:id', (req, res) => res.json(getImport(String(req.params.id))))
applicationImportsRouter.get('/:id/sources/:sourceId/file', (req, res) => {
  getImportRow(String(req.params.id))
  const source = getMaterials(String(req.params.id)).find(source => source.id === req.params.sourceId)
  if (!source?.stored_name) throw new ImportError('图片不存在', 404)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.type(source.mime!).sendFile(materialPath(source.stored_name))
})
applicationImportsRouter.post('/:id/analyze', async (req, res) => {
  const id = String(req.params.id)
  if (getImportRow(id).application_id) throw new ImportError('已保存的材料不能重新识别', 409)
  if (activeImports.size) throw new ImportError('已有识别任务进行中，请稍后再试', 409)
  const controller = new AbortController()
  activeImports.set(id, controller)
  const onClose = () => { if (!res.writableEnded) controller.abort() }
  res.on('close', onClose)
  try {
    const analysis = await analyzeImport(id, controller.signal)
    controller.signal.throwIfAborted()
    db.prepare('UPDATE application_imports SET analysis_json=? WHERE id=? AND application_id IS NULL').run(JSON.stringify(analysis), id)
    res.json(getImport(id))
  } finally { res.off('close', onClose); activeImports.delete(id) }
})
applicationImportsRouter.delete('/:id', (req, res) => { deleteImport(String(req.params.id)); res.json({ ok: true }) })
applicationImportsRouter.use((err: Error, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
  if (!res.headersSent && !res.destroyed) res.status(err instanceof ImportError ? err.status : 500).json({ message: err instanceof ImportError ? err.message : '材料处理失败，请重试' })
})
