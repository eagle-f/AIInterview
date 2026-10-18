<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { JD_MAX_LENGTH, RESUME_MAX_LENGTH, type InterviewProfile } from "../../shared/interview";

const props = defineProps<{ draft: InterviewProfile; step: 1 | 2; busy: boolean; locked: boolean; disabled: boolean; error: string }>();
const emit = defineEmits<{
  "update:draft": [value: InterviewProfile];
  "update:step": [value: 1 | 2];
  start: [];
  close: [];
  restore: [];
  restart: [];
}>();
const dialog = ref<HTMLDialogElement | null>(null);
const field = ref<HTMLTextAreaElement | null>(null);
const resumeValid = computed(() => !!props.draft.resume.trim() && props.draft.resume.length <= RESUME_MAX_LENGTH);
const jdValid = computed(() => props.draft.jobDescription.length <= JD_MAX_LENGTH);
const updateField = (event: Event) => {
  const value = (event.target as HTMLTextAreaElement).value;
  emit("update:draft", { ...props.draft, [props.step === 1 ? "resume" : "jobDescription"]: value });
};
const focusField = () => { void nextTick(() => field.value?.focus()); };
onMounted(() => { dialog.value?.showModal(); focusField(); });
watch(() => props.step, focusField);
const submit = () => {
  if (props.busy || props.disabled || !resumeValid.value || !jdValid.value) return;
  if (props.step === 1) emit("update:step", 2);
  else emit("start");
};
const cancel = (event: Event) => {
  event.preventDefault();
  if (!props.busy && !props.locked) emit("close");
};
</script>

<template>
  <dialog ref="dialog" class="setup-dialog" aria-labelledby="setup-title" aria-describedby="setup-description" @cancel="cancel">
    <form @submit.prevent="submit" :aria-busy="busy">
      <div class="setup-topline">
        <span class="step-label">面试准备 · {{ step }}/2</span>
        <button type="button" class="close-button" aria-label="暂时关闭面试准备" :disabled="busy || locked" @click="emit('close')">×</button>
      </div>
      <h2 id="setup-title">{{ step === 1 ? '先介绍一下你的经历' : '这次想面试什么职位？' }}</h2>
      <p id="setup-description" class="description">{{ step === 1 ? '粘贴简历内容，面试官会围绕你的项目和经历提问。' : '粘贴职位 JD；留空将使用默认的前端工程师（应届生）岗位。' }}</p>
      <label :for="step === 1 ? 'setup-resume' : 'setup-jd'">{{ step === 1 ? '简历内容（必填）' : '职位 JD（选填）' }}</label>
      <textarea
        :key="step" ref="field" :id="step === 1 ? 'setup-resume' : 'setup-jd'"
        :value="step === 1 ? draft.resume : draft.jobDescription" :disabled="busy || locked"
        :maxlength="step === 1 ? RESUME_MAX_LENGTH : JD_MAX_LENGTH" :required="step === 1"
        :placeholder="step === 1 ? '教育背景、工作经历、项目经历、专业技能……' : '岗位职责、任职要求、加分项……'"
        @input="updateField"
      />
      <p class="field-hint">{{ (step === 1 ? draft.resume.length : draft.jobDescription.length).toLocaleString() }} / {{ (step === 1 ? RESUME_MAX_LENGTH : JD_MAX_LENGTH).toLocaleString() }} 字符</p>
      <p v-if="error" class="setup-error" role="alert">{{ error }}</p>
      <p v-if="busy" class="starting-hint" role="status">正在准备面试官的开场问题，请稍候…</p>
      <div class="setup-actions">
        <button v-if="locked && error && !busy" type="button" class="back-button" @click="emit('restart')">开始新面试</button>
        <button v-if="disabled && !busy" type="button" class="back-button" @click="emit('restore')">重新连接</button>
        <button v-if="step === 2" type="button" class="back-button" :disabled="busy || locked" @click="emit('update:step', 1)">上一步</button>
        <button type="submit" class="setup-submit" :disabled="busy || disabled || !resumeValid || !jdValid">{{ busy ? '正在开始…' : step === 1 ? '下一步：填写职位 JD' : locked ? '重试开始面试' : '开始面试' }}</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.setup-dialog { box-sizing: border-box; width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); padding: 28px; border: 1px solid #e0e4ee; border-radius: 16px; background: #fff; color: #253047; color-scheme: light; box-shadow: 0 24px 80px #17224733; text-align: left; }
.setup-dialog::backdrop { background: #17224766; }
form { display: flex; flex-direction: column; gap: 12px; }
.setup-topline { display: flex; justify-content: space-between; align-items: center; }
.step-label { color: #646cff; font-size: 13px; font-weight: 600; }
.close-button { border: 0; background: transparent; color: #71778a; font-size: 26px; cursor: pointer; padding: 0 4px; }
h2 { margin: 0; font-size: 24px; color: #202746; line-height: 1.4; }
.description, .field-hint, .starting-hint { color: #71778a; font-size: 13px; line-height: 1.6; margin: 0; }
label { font-size: 14px; font-weight: 600; margin-top: 8px; }
textarea { box-sizing: border-box; width: 100%; min-height: 230px; max-height: 40dvh; border: 1px solid #d7dae0; border-radius: 8px; padding: 12px; font-family: inherit; line-height: 1.7; font-size: 14px; resize: vertical; background: white; color: #253047; }
textarea:focus { outline: 2px solid #646cff; outline-offset: 1px; }
textarea:disabled { background: #f8f8fb; }
.field-hint { text-align: right; }
.setup-error { margin: 0; padding: 10px 12px; border-radius: 6px; background: #fff3ec; color: #9b431b; font-size: 13px; line-height: 1.6; }
.setup-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
.setup-submit, .back-button { border-radius: 7px; padding: 10px 16px; font-size: 14px; cursor: pointer; }
.setup-submit { border: 0; background: #646cff; color: #fff; }
.back-button { border: 1px solid #d7dae0; background: #fff; color: #4f5870; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible { outline: 2px solid #646cff; outline-offset: 3px; }
@media (max-width: 600px) { .setup-dialog { padding: 20px; } h2 { font-size: 21px; } textarea { min-height: 180px; } }
</style>
