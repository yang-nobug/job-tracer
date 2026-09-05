const MAX_INFERENCE_EDGE = 2048
const MAX_ORIGINAL_INFERENCE_BYTES = 5 * 1024 * 1024
const JPEG_QUALITY = 0.86

/**
 * 小图直接作为视觉输入，避免不必要的文字细节损失。只有尺寸或体积较大时，
 * 才生成受限的 JPEG 副本；原始文件始终单独保留用于本地核对。
 */
export async function createInferenceImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file)
  try {
    if (Math.max(bitmap.width, bitmap.height) <= MAX_INFERENCE_EDGE && file.size <= MAX_ORIGINAL_INFERENCE_BYTES) {
      return file
    }
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
