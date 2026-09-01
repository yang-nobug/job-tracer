<script setup lang="ts">
import type { ImportDraft } from '../../../shared/application-import'
defineProps<{ imports: ImportDraft[] }>()
</script>
<template>
  <section v-if="imports.length" class="original-materials">
    <h4>原始招聘材料</h4>
    <div v-for="item in imports" :key="item.id">
      <div class="images">
        <figure v-for="(source, index) in item.sources.filter(source => source.url)" :key="source.id">
          <el-image :src="source.url!" :preview-src-list="item.sources.flatMap(source => source.url ? [source.url] : [])" :initial-index="index" preview-teleported fit="contain" class="source-image" />
          <figcaption>{{ source.filename }}<br v-if="source.captured_at" />{{ source.captured_at ? `截图日期：${source.captured_at}` : '' }}</figcaption>
        </figure>
      </div>
      <details v-for="source in item.sources.filter(source => source.kind === 'text')" :key="source.id">
        <summary>查看原始文字{{ source.captured_at ? `（复制日期 ${source.captured_at}）` : '' }}</summary>
        <pre>{{ source.text }}</pre>
      </details>
      <details v-if="item.analysis">
        <summary>查看识别时的日期原文（保存值以已核对的表单为准）</summary>
        <pre v-for="(fact, index) in item.analysis.extraction.date_facts" :key="index">{{ fact.raw }}
{{ fact.evidence.map(e => `${e.source_id}：「${e.quote}」`).join('\n') }}</pre>
        <p>{{ item.analysis.model }} · 提示词 {{ item.analysis.prompt_version }}</p>
      </details>
    </div>
  </section>
</template>
<style scoped>
.original-materials { background: #f7f9fc; border-radius: 10px; padding: 14px; }
h4 { margin: 0 0 10px; font-size: 14px; }
.images { display: flex; gap: 12px; flex-wrap: wrap; }
figure { margin: 0 0 10px; width: 110px; }
.source-image { width: 110px; height: 110px; background: white; border: 1px solid #dce3ee; border-radius: 6px; }
figcaption, details { font-size: 12px; color: #69788b; overflow-wrap: anywhere; }
details { margin-top: 8px; }
summary { color: #409eff; cursor: pointer; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; font: inherit; }
</style>
