// 公司首字头像颜色：按公司名哈希取色，保证同一公司颜色稳定
const AVATAR_COLORS = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#9a6fe0', '#17a2b8', '#ff85c0', '#5cdbd3']

export function avatarColor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
