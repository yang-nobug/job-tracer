export interface TranscriptChunk {
  index: number
  start: number
  end: number
  text: string
}

export const RECORDING_CHUNK_THRESHOLD = 16_000
const DEFAULT_CHUNK_SIZE = 12_000
const DEFAULT_OVERLAP = 600
const MAX_CHUNKS = 60

/** 按字符偏移稳定分段；优先在靠近边界的换行处切分，并保留少量上下文重叠。 */
export function splitRecordingTranscript(
  transcript: string,
  requestedSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP
): TranscriptChunk[] {
  if (!transcript) return []
  const size = Math.max(
    overlap + 1000,
    requestedSize,
    // 边界可能向前回退到 85% 处的换行，预留这部分余量仍保证不超过 MAX_CHUNKS。
    Math.ceil((transcript.length + (MAX_CHUNKS - 1) * overlap) / (MAX_CHUNKS * 0.85))
  )
  const chunks: TranscriptChunk[] = []
  let start = 0
  while (start < transcript.length) {
    let end = Math.min(transcript.length, start + size)
    if (end < transcript.length) {
      const newline = transcript.lastIndexOf('\n', end)
      if (newline >= start + Math.floor(size * 0.85)) end = newline + 1
    }
    chunks.push({ index: chunks.length, start, end, text: transcript.slice(start, end) })
    if (end >= transcript.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return chunks
}
