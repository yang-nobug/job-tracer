import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REVIEWS_DIR } from './db.js'

// 文件名安全字符：去掉 Windows 不允许的字符
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 30)
}

export function reviewTemplate(company: string, round: string, scheduledAt: string): string {
  const date = scheduledAt.slice(0, 10)
  return `# 复盘：${company} · ${round}（${date}）

## 被问的问题
-

## 自我评价

### 答得好的
-

### 答得差的
-

## 改进点 / 下次要准备的
-
`
}

/** 创建复盘 md 文件，返回相对 data 目录的路径（如 reviews/xxx.md） */
export function createReviewFile(company: string, round: string, scheduledAt: string): string {
  const date = scheduledAt.slice(0, 10)
  const filename = `${date}-${sanitize(company)}-${sanitize(round)}.md`
  const filePath = path.join(REVIEWS_DIR, filename)

  if (!existsSync(filePath)) {
    writeFileSync(filePath, reviewTemplate(company, round, scheduledAt), 'utf-8')
  }
  return `reviews/${filename}`
}

export function readReviewFile(relPath: string): string {
  const filePath = path.join(REVIEWS_DIR, path.basename(relPath))
  if (!existsSync(filePath)) return ''
  return readFileSync(filePath, 'utf-8')
}

export function writeReviewFile(relPath: string, content: string): void {
  const filePath = path.join(REVIEWS_DIR, path.basename(relPath))
  writeFileSync(filePath, content, 'utf-8')
}
