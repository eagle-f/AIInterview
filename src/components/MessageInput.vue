<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { ASRMic } from "../lib/asrMic";
import { activateSpeechOutput, draft as message } from "../lib/client";

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{
  sendMessage: [message: string];
  voiceBusy: [busy: boolean];
}>();

const SILENCE_TIMEOUT_MS = 2000;
const voiceStatus = ref<"idle" | "connecting" | "recording" | "stopping">(
  "idle",
);
watch(voiceStatus, (status) => emit("voiceBusy", status !== "idle"));
const voiceError = ref("");
const mic = new ASRMic();
let textBeforeRecording = "";
let finalTranscript = "";
let partialTranscript = "";
let startAttempt = 0;
let silenceTimer: ReturnType<typeof setTimeout> | null = null;
let autoSendPending = false;

const clearSilenceTimer = () => {
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = null;
};

const hasVoiceTranscript = () =>
  Boolean((finalTranscript + partialTranscript).trim());

const scheduleAutoSend = () => {
  clearSilenceTimer();
  if (voiceStatus.value !== "recording" || !hasVoiceTranscript()) return;
  silenceTimer = setTimeout(() => {
    silenceTimer = null;
    if (voiceStatus.value === "recording" && hasVoiceTranscript()) {
      stopRecording(true);
    }
  }, SILENCE_TIMEOUT_MS);
};

const updateVoiceMessage = () => {
  const transcript = finalTranscript + partialTranscript;
  message.value =
    textBeforeRecording +
    (textBeforeRecording && transcript ? "\n" : "") +
    transcript;
};

mic.onPartial = (text) => {
  const changed = partialTranscript !== text;
  partialTranscript = text;
  updateVoiceMessage();
  if (changed) scheduleAutoSend();
};
mic.onFinal = (text) => {
  finalTranscript += text;
  partialTranscript = "";
  updateVoiceMessage();
  scheduleAutoSend();
};
mic.onVoiceActivity = scheduleAutoSend;
mic.onReady = () => {
  voiceStatus.value = "recording";
  scheduleAutoSend();
};
mic.onError = (error) => {
  voiceError.value = error;
  autoSendPending = false;
  clearSilenceTimer();
};
mic.onClosed = () => {
  clearSilenceTimer();
  // 即使服务端未返回 final，也保留最后可见的识别文本。
  finalTranscript += partialTranscript;
  partialTranscript = "";
  updateVoiceMessage();
  voiceStatus.value = "idle";
  const shouldAutoSend =
    autoSendPending && !voiceError.value && hasVoiceTranscript();
  autoSendPending = false;
  if (shouldAutoSend) handleSendMessage();
};

const handleStartRecording = async () => {
  if (voiceStatus.value !== "idle" || props.disabled) return;
  activateSpeechOutput();
  voiceError.value = "";
  clearSilenceTimer();
  autoSendPending = false;
  textBeforeRecording = message.value;
  finalTranscript = "";
  partialTranscript = "";
  voiceStatus.value = "connecting";
  const attempt = ++startAttempt;
  try {
    await mic.start();
  } catch (error) {
    if (attempt === startAttempt) {
      if (!voiceError.value) {
        voiceError.value =
          error instanceof Error ? error.message : "麦克风打开失败";
      }
      voiceStatus.value = "idle";
    }
  }
};

const stopRecording = (sendAfterStop: boolean) => {
  if (voiceStatus.value !== "recording") return;
  clearSilenceTimer();
  autoSendPending = sendAfterStop;
  voiceStatus.value = "stopping";
  mic.stop();
};

const handleStopRecording = () => stopRecording(false);

onUnmounted(() => {
  clearSilenceTimer();
  autoSendPending = false;
  mic.dispose();
  emit("voiceBusy", false);
});

const handleSendMessage = () => {
  if (!props.disabled && voiceStatus.value === "idle" && message.value.trim()) {
    emit("sendMessage", message.value);
    message.value = "";
  }
};

const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    handleSendMessage();
    e.preventDefault(); // 阻止默认换行行为
  }
};
</script>

<template>
  <div class="message-input-container">
    <textarea
      v-model="message"
      class="message-input"
      placeholder="请输入您的回答..."
      :disabled="props.disabled || voiceStatus !== 'idle'"
      @keydown="handleKeyDown"
    />
    <div class="actions">
      <button
        v-if="voiceStatus === 'recording'"
        type="button"
        class="voice-button recording"
        @click="handleStopRecording"
      >
        停止录音
      </button>
      <button
        v-else
        type="button"
        class="voice-button"
        :disabled="props.disabled || voiceStatus !== 'idle'"
        @click="handleStartRecording"
      >
        {{
          voiceStatus === "connecting"
            ? "连接中…"
            : voiceStatus === "stopping"
              ? "识别中…"
              : "语音输入"
        }}
      </button>
      <button
        class="send-button"
        @click="handleSendMessage"
        :disabled="props.disabled || voiceStatus !== 'idle'"
      >
        发送
      </button>
    </div>
    <p v-if="voiceStatus === 'recording'" class="voice-hint">
      识别到语音后，静音 3 秒自动发送
    </p>
    <p v-if="voiceError" class="voice-error" role="alert">{{ voiceError }}</p>
  </div>
</template>

<style scoped>
.message-input-container {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background-color: #fff;
  border-top: 1px solid #eee;
  border-radius: 0 0 8px 8px;
}

.message-input {
  min-height: 80px;
  max-height: 120px;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  resize: vertical;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  outline: none;
  transition: border-color 0.2s;
}

.message-input:focus {
  border-color: #646cff;
  box-shadow: 0 0 0 2px rgba(100, 108, 255, 0.2);
}

.message-input:disabled {
  background-color: #f8f8f8;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.voice-button {
  padding: 8px 16px;
  border: 1px solid #646cff;
  border-radius: 4px;
  color: #646cff;
  background: #fff;
  cursor: pointer;
  font-weight: 500;
}

.voice-button.recording {
  color: #fff;
  border-color: #d33;
  background: #d33;
}

.voice-button:disabled {
  border-color: #ccc;
  color: #999;
  cursor: not-allowed;
}

.voice-error {
  margin: 0;
  color: #d33;
  font-size: 13px;
}

.voice-hint {
  margin: 0;
  color: #666;
  font-size: 13px;
}

.send-button {
  padding: 8px 16px;
  background-color: #646cff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
  transition: background-color 0.2s;
}

.send-button:hover {
  background-color: #535bf2;
}

.send-button:disabled {
  background-color: #ccc;
  cursor: not-allowed;
}
</style>
