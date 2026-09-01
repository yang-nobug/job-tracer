const MAX_INFERENCE_EDGE = 2048
const JPEG_QUALITY = 0.86

/**
 * 生成只供视觉模型使用的副本。原始文件仍单独上传并用于本地预览，
 * 这里统一限制最长边并去掉 EXIF 等非像素元数据。
 */
export async function createInferenceImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_INFERENCE_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('浏览器无法创建图片处理画布')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片压缩失败')), 'image/jpeg', JPEG_QUALITY)
    })
    const base = file.name.replace(/\.[^.]+$/, '').slice(0, 120) || 'image'
    return new File([blob], `${base}.inference.jpg`, { type: 'image/jpeg', lastModified: file.lastModified })
  } finally {
    bitmap.close()
  }
}
