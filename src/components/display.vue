<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Timeline from "./Timeline.vue";
import ChatDisplay from "./ChatDisplay.vue";
import MessageInput from "./MessageInput.vue";
import FeedbackPanel from "./FeedbackPanel.vue";
import { INTERVIEW_DURATION_MINUTES } from "../../shared/interview";
import {
  messages,
  currentTime,
  sendMessage,
  buttonDisabled,
  speechError,
  chatError,
  hasInterview,
  interviewStatus,
  report,
  reportError,
  finishInterview,
  sending,
  connectionStatus,
  recoveryNotice,
  canRetryAnswer,
  retryLastAnswer,
  restoreInterview,
  startNewInterview,
} from "../lib/client";

// 面试总时长（分钟）
const totalDuration = INTERVIEW_DURATION_MINUTES;
// 面试是否已开始（第一轮对话开始后启动计时）
const started = computed(() => hasInterview.value && connectionStatus.value === "ready" && !canRetryAnswer.value);
const voiceBusy = ref(false);
const chatDisplay = ref<InstanceType<typeof ChatDisplay> | null>(null);
const activeView = ref<"chat" | "feedback">(report.value ? "feedback" : "chat");
watch(report, (value) => { if (value) activeView.value = "feedback"; });
onMounted(restoreInterview);

const viewEvidence = (id: string) => {
  activeView.value = "chat";
  void chatDisplay.value?.focusMessage(id);
};

const timerText = computed(() => {
  const totalSeconds = Math.floor(currentTime.value * 60);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `00:${mm}:${ss}`;
});

const updateTime = (time: number) => {
  currentTime.value = time;
};
</script>

<template>
  <div class="interview-page">
    <!-- 左侧时间轴 -->
    <aside class="sidebar">
      <div class="timer">{{ timerText }}</div>
      <Timeline
        :currentTime="currentTime"
        :totalDuration="totalDuration"
        :started="started && interviewStatus === 'active'"
        @update-time="updateTime"
      />
    </aside>

    <!-- 右侧主内容 -->
    <div class="main">
      <header class="interview-header">
        <div>
          <h1>前端模拟面试</h1>
          <p>{{ interviewStatus === 'active' ? '围绕你的经历，逐步深入交流' : '面试已结束，回顾表现与改进方向' }}</p>
        </div>
        <button
          v-if="interviewStatus === 'active'"
          type="button"
          class="finish-button"
          :disabled="(!hasInterview && !sending) || voiceBusy || connectionStatus !== 'ready'"
          @click="finishInterview"
        >结束面试并生成反馈</button>
        <button v-if="report || connectionStatus === 'offline'" type="button" class="secondary-button" @click="startNewInterview">开始新面试</button>
      </header>
      <section v-if="recoveryNotice" class="recovery-status" role="status" aria-live="polite">
        <p>{{ recoveryNotice }}</p>
        <button v-if="connectionStatus === 'offline'" type="button" class="finish-button" :disabled="sending" @click="restoreInterview">恢复面试</button>
      </section>
      <p v-if="voiceBusy" class="status-hint">请先停止录音并发送回答，再结束面试。</p>
      <p v-if="currentTime >= totalDuration && interviewStatus === 'active'" class="status-hint">已到预定时长，完成当前回答后可结束面试。</p>
      <nav v-if="report" class="view-tabs" aria-label="面试内容">
        <button type="button" :aria-pressed="activeView === 'feedback'" @click="activeView = 'feedback'">面试反馈</button>
        <button type="button" :aria-pressed="activeView === 'chat'" @click="activeView = 'chat'">问答记录</button>
      </nav>
      <section v-if="interviewStatus === 'finishing'" class="report-status" role="status" aria-live="polite">
        <strong>{{ sending ? '等待本轮回复完成…' : '正在生成面试反馈…' }}</strong>
        <p>正在回顾本场回答、整理评价依据，请稍候。</p>
      </section>
      <section v-if="reportError" class="report-status report-failure" role="alert">
        <p>{{ reportError }}</p>
        <button v-if="interviewStatus === 'report_error'" type="button" class="finish-button" @click="finishInterview">重新生成反馈</button>
      </section>
      <FeedbackPanel v-if="report && activeView === 'feedback'" :report="report" @select-evidence="viewEvidence" />
      <!-- 对话窗口 -->
      <div v-show="activeView === 'chat'" class="chat-window">
        <ChatDisplay ref="chatDisplay" :messages="messages" />
      </div>
      <p v-if="chatError && interviewStatus === 'active'" class="speech-error" role="alert">{{ chatError }}</p>
      <button v-if="canRetryAnswer" type="button" class="finish-button retry-answer" @click="retryLastAnswer">重试本轮回复</button>
      <p v-if="speechError && interviewStatus === 'active'" class="speech-error" role="alert">
        语音播放失败：{{ speechError }}
      </p>

      <!-- 输入窗口 -->
      <MessageInput
        v-if="interviewStatus === 'active'"
        :disabled="buttonDisabled"
        @send-message="sendMessage"
        @voice-busy="voiceBusy = $event"
      />
    </div>
  </div>
</template>

<style scoped>
.interview-page {
  box-sizing: border-box;
  width: 100%;
  max-width: 1126px;
  min-height: 100vh;
  margin: 0 auto;
  padding: 32px 48px 40px;
  display: flex;
  gap: 24px;
  background: #ffffff;
  border: 1px dashed #c9cdd4;
  border-radius: 8px;
  color: #253047;
  color-scheme: light;
}

.sidebar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  max-height: 620px;
}

.sidebar :deep(.timeline-container) {
  flex: 1;
  min-height: 0;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.timer {
  font-size: 18px;
  color: #1f2329;
  font-variant-numeric: tabular-nums;
}

.chat-window {
  height: 480px;
  flex-shrink: 0;
  border: 1px solid #d7dae0;
  border-radius: 8px;
  background: #ffffff;
  overflow: hidden;
}

.speech-error {
  margin: 0;
  color: #c62828;
  font-size: 13px;
}

.interview-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; text-align: left; }
.interview-header h1 { font-size: 23px; letter-spacing: 0; margin: 0 0 8px; color: #202746; }
.interview-header p, .status-hint { font-size: 12px; color: #71778a; }
.finish-button { padding: 9px 13px; background: #646cff; color: white; border: 0; border-radius: 6px; font-size: 13px; cursor: pointer; }
.finish-button:disabled { background: #c4c7d5; cursor: not-allowed; }
.finish-button:focus-visible, .view-tabs button:focus-visible { outline: 2px solid #646cff; outline-offset: 3px; }
.view-tabs { display: flex; gap: 8px; border-bottom: 1px solid #e0e4ee; }
.view-tabs button { padding: 10px 16px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: #626a7e; cursor: pointer; }
.view-tabs button[aria-pressed='true'] { color: #5653b7; border-bottom-color: #646cff; font-weight: 600; }
.report-status { padding: 20px; background: #f4f4ff; border-radius: 8px; text-align: left; font-size: 14px; }
.report-status p { margin: 8px 0; }
.report-failure { background: #fff3ec; color: #9b431b; }
.recovery-status { padding: 12px 16px; background: #f1f6ff; color: #36567c; border-radius: 8px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; font-size: 13px; text-align: left; }
.secondary-button { border: 1px solid #cdd2df; border-radius: 6px; background: white; padding: 8px 12px; color: #4f5870; cursor: pointer; }
.retry-answer { align-self: flex-start; }
@media (max-width: 760px) {
  .interview-page { padding: 20px 14px; gap: 12px; }
  .sidebar { display: none; }
  .interview-header h1 { font-size: 21px; }
  .chat-window { height: 420px; }
}
</style>
