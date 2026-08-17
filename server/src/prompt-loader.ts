import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 提示词文件加载：server/src/prompts/*.md
// 每次调用时从磁盘读取，改提示词无需重启服务
// user 模板支持 {{var}} 占位符替换

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PROMPTS_DIR = path.resolve(__dirname, 'prompts')

export function loadPrompt(filename: string): string {
  const filePath = path.join(PROMPTS_DIR, filename)
  if (!existsSync(filePath)) {
    throw new Error(`提示词文件缺失：${filePath}`)
  }
  return readFileSync(filePath, 'utf-8').trim()
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match)
}
