import type { Request, Response } from 'express'

// 规则解析 JD 文本：公司 / 职位 / 地点（不做薪资，按需求 v1.1）

const CITIES = [
  '北京', '上海', '深圳', '广州', '杭州', '成都', '武汉', '南京', '西安', '苏州',
  '长沙', '重庆', '天津', '合肥', '郑州', '厦门', '青岛', '无锡', '佛山', '东莞',
  '济南', '大连', '福州', '沈阳', '石家庄', '哈尔滨', '南昌', '贵阳', '太原', '昆明',
  '南宁', '兰州', '珠海', '宁波', '温州', '常州', '绍兴', '嘉兴', '香港', '台北'
]

const POSITION_KEYWORDS = [
  '工程师', '开发', '算法', '产品经理', '项目经理', '分析师', '设计师', '运营',
  '测试', '架构师', '顾问', '专员', '经理', '主管', '总监', '实习生', '研究员',
  '数据', '前端', '后端', '全栈', '安全', '运维', '客服', '销售', '人事', '行政'
]

export function parseJd(text: string): { company?: string; position?: string; location?: string } {
  const result: { company?: string; position?: string; location?: string } = {}
  if (!text) return result

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

  // 公司：优先显式标注，其次"XX有限公司/集团"模式
  const labeled = text.match(/(?:公司|企业)名称?[:：\s]+([^\s，,、;；]{2,25})/)
  if (labeled) {
    result.company = labeled[1]
  } else {
    const m = text.match(/([一-龥A-Za-z0-9·]{2,25}(?:有限公司|有限责任公司|股份有限公司|集团))/)
    if (m) result.company = m[1]
  }

  // 职位：优先显式标注；否则取第一个包含职位关键词且较短的行
  const labeledPos = text.match(/(?:职位|岗位|招聘|诚聘)[:：\s]+([^\s，,、;；]{2,30})/)
  if (labeledPos) {
    result.position = labeledPos[1].replace(/(急|急聘|诚聘)$/, '')
  } else {
    for (const line of lines.slice(0, 5)) {
      if (line.length <= 30 && POSITION_KEYWORDS.some((k) => line.includes(k)) && !line.includes('职责') && !line.includes('要求')) {
        result.position = line.replace(/^【|】$/g, '').trim()
        break
      }
    }
  }

  // 地点：优先显式标注，其次城市名首次出现
  const labeledLoc = text.match(/(?:工作地点|办公地点|地点|base|Base)[:：\s]+([^\n，,、;；]{2,20})/)
  if (labeledLoc) {
    result.location = labeledLoc[1]
  } else {
    for (const city of CITIES) {
      const idx = text.indexOf(city)
      if (idx >= 0) {
        // 尝试带上后续的区县信息，如 "北京市海淀区"
        const after = text.slice(idx, idx + 15)
        const m = after.match(new RegExp(`^(${city}市?[一-龥]{0,2}(?:区|县|镇)?)`))
        result.location = m ? m[1] : city
        break
      }
    }
  }

  return result
}

export function jdParseHandler(req: Request, res: Response): void {
  const { text } = req.body as { text?: string }
  if (!text || !text.trim()) {
    res.status(422).json({ message: 'text 不能为空' })
    return
  }
  res.json(parseJd(text))
}
