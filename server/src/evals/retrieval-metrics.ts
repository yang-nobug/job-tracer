export interface RetrievalMetricFixture {
  relevant: Set<string>
  returned: string[]
}

export function retrievalMetrics(fixtures: RetrievalMetricFixture[], k: number): { recallAtK: number; mrr: number } {
  if (!fixtures.length) return { recallAtK: 0, mrr: 0 }
  let recall = 0
  let reciprocalRank = 0
  for (const fixture of fixtures) {
    const top = fixture.returned.slice(0, k)
    const hits = new Set(top.filter(value => fixture.relevant.has(value)))
    recall += fixture.relevant.size ? hits.size / fixture.relevant.size : 1
    const first = top.findIndex(value => fixture.relevant.has(value))
    reciprocalRank += first >= 0 ? 1 / (first + 1) : 0
  }
  return {
    recallAtK: Number((recall / fixtures.length).toFixed(4)),
    mrr: Number((reciprocalRank / fixtures.length).toFixed(4))
  }
}
