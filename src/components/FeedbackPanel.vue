<script setup lang="ts">
import { computed } from "vue";
import type { FeedbackLevel, InterviewReport } from "../../shared/interview";

const props = defineProps<{ report: InterviewReport }>();
const emit = defineEmits<{ selectEvidence: [messageId: string] }>();
const levels: Record<FeedbackLevel, string> = {
  strong: "表现较好", developing: "基本掌握", needs_work: "需要加强", not_covered: "未覆盖",
};
const coveredCount = computed(() => props.report.dimensions.filter((dimension) => dimension.level !== "not_covered").length);
const answerCount = computed(() => props.report.messages.filter((message) => message.role === "user").length);
</script>

<template>
  <section class="feedback-panel" aria-labelledby="feedback-title">
    <header class="report-header">
      <p class="eyebrow">本场复盘</p>
      <h2 id="feedback-title">面试反馈</h2>
      <p class="metadata">{{ answerCount }} 次回答 · {{ coveredCount }}/4 个维度有评价依据</p>
      <p class="summary">{{ report.summary }}</p>
      <p class="hint">反馈基于本场回答生成；点击引用可以回到对应问答。</p>
    </header>

    <div class="dimension-grid">
      <article v-for="dimension in report.dimensions" :key="dimension.id" class="dimension-card">
        <div class="dimension-heading">
          <h3>{{ dimension.title }}</h3>
          <span class="level" :class="dimension.level">{{ levels[dimension.level] }}</span>
        </div>
        <p class="assessment">{{ dimension.assessment }}</p>
        <div v-if="dimension.strengths.length" class="detail">
          <h4>做得好的地方</h4>
          <ul><li v-for="strength in dimension.strengths" :key="strength">{{ strength }}</li></ul>
        </div>
        <div v-if="dimension.improvements.length" class="detail">
          <h4>{{ dimension.level === 'not_covered' ? '下次可以补充' : '建议这样练习' }}</h4>
          <ul><li v-for="improvement in dimension.improvements" :key="improvement">{{ improvement }}</li></ul>
        </div>
        <div v-if="dimension.evidence.length" class="evidence-list">
          <h4>你的回答依据</h4>
          <button
            v-for="(evidence, index) in dimension.evidence"
            :key="`${evidence.messageId}-${index}`"
            type="button"
            class="evidence"
            @click="emit('selectEvidence', evidence.messageId)"
          >
            <span>“{{ evidence.quote }}”</span>
            <span class="evidence-link">查看对应问答 →</span>
          </button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.feedback-panel { text-align: left; color: #253047; }
.report-header { padding: 24px; background: #f3f3ff; border: 1px solid #dedff5; border-radius: 12px; }
.eyebrow { font-size: 12px; font-weight: 700; color: #5957bb; letter-spacing: 2px; }
h2 { margin: 8px 0; font-size: 25px; color: #202746; }
.metadata, .hint { font-size: 12px; color: #666d83; }
.summary { margin: 18px 0 10px; font-size: 15px; line-height: 1.8; white-space: pre-wrap; }
.dimension-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 16px; }
.dimension-card { padding: 20px; border: 1px solid #e0e4ee; border-radius: 12px; background: #fff; overflow-wrap: anywhere; }
.dimension-heading { display: flex; gap: 8px; justify-content: space-between; align-items: center; }
h3 { margin: 0; font-size: 17px; }
h4 { margin: 0 0 6px; font-size: 13px; color: #515b73; }
.level { flex-shrink: 0; border-radius: 20px; padding: 3px 9px; font-size: 11px; line-height: 1.6; }
.strong { color: #176646; background: #e3f5ec; }
.developing { color: #315da6; background: #eaf0ff; }
.needs_work { color: #995416; background: #fff1dc; }
.not_covered { color: #666b78; background: #f0f1f4; }
.assessment { margin: 16px 0; font-size: 14px; line-height: 1.8; }
.detail { margin-top: 14px; }
ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.8; }
li + li { margin-top: 6px; }
.evidence-list { margin-top: 18px; }
.evidence { display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 8px; padding: 12px; text-align: left; font: inherit; font-size: 13px; line-height: 1.7; color: #424d66; background: #f8f9fc; border: 1px solid #e9ecf2; border-left: 3px solid #8b8de0; border-radius: 6px; cursor: pointer; }
.evidence:hover { background: #f0f0ff; }
.evidence:focus-visible { outline: 2px solid #646cff; outline-offset: 3px; }
.evidence-link { color: #5753b9; font-size: 12px; }
@media (max-width: 760px) { .dimension-grid { grid-template-columns: 1fr; } .report-header, .dimension-card { padding: 16px; } }
</style>
