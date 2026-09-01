const BASE = '/api'
export class ApiError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown>) { super(message) }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError((body as { message?: string }).message || `请求失败 (${res.status})`, res.status, body)
  }
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(data ?? {}) }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data ?? {}) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  // 上传简历（multipart）
  uploadResume: (file: File, note?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (note) form.append('note', note)
    return fetch(`${BASE}/resumes`, { method: 'POST', body: form }).then(async (res) => {
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((body as { message?: string }).message || '上传失败')
      return body
    })
  },

  // 上传知识库截图（multipart，挂在面经下）
  uploadKnowledgeImage: (sourceId: number, file: File, inferenceFile: File) => {
    const form = new FormData()
    form.append('source_id', String(sourceId))
    form.append('file', file)
    form.append('inference_file', inferenceFile)
    return fetch(`${BASE}/knowledge/images`, { method: 'POST', body: form }).then(async (res) => {
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((body as { message?: string }).message || '上传失败')
      return body
    })
  },

  // 上传面试录音（multipart，触发转写+复盘管道）
  uploadRecording: (interviewId: number, file: File) => {
    const form = new FormData()
    form.append('interview_id', String(interviewId))
    form.append('audio', file)
    return fetch(`${BASE}/recordings`, { method: 'POST', body: form }).then(async (res) => {
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((body as { message?: string }).message || '上传失败')
      return body
    })
  }
}
