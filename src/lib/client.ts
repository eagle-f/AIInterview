import { computed, ref, watch } from "vue";
import { JD_MAX_LENGTH, RESUME_MAX_LENGTH, type InterviewMessage, type InterviewProfile, type InterviewReport, type InterviewSessionView, type InterviewTurn } from "../../shared/interview";
import { StreamingSpeechPlayer } from "./streamingSpeechPlayer";
import { delay, HttpError, requestJson, retryable } from "./http";
import { clearSessionCache, readSessionCache, writeSessionCache, type PendingAnswer, type PendingStart } from "./sessionCache";

const cached = readSessionCache();
const sessionId = cached?.sessionId ?? crypto.randomUUID();
export const messages = ref<InterviewMessage[]>(cached?.messages ?? []);
export const currentTime = ref(cached?.timeline ?? 0);
export const draft = ref(cached?.draft ?? "");
export const sending = ref(false);
export const interviewStatus = ref<InterviewSessionView["status"]>(cached?.report ? "finished" : "active");
export const connectionStatus = ref<"ready" | "restoring" | "reconnecting" | "offline">(cached ? "restoring" : "ready");
export const recoveryNotice = ref("");
export const pendingAnswer = ref<PendingAnswer | null>(cached?.pending ?? null);
export const pendingStart = ref<PendingStart | null>(cached?.pendingStart ?? null);
export const profile = ref<InterviewProfile | null>(cached?.profile ?? null);
export const setupDraft = ref<InterviewProfile>(cached?.setupDraft ?? { resume: "", jobDescription: "" });
export const setupStep = ref<1 | 2>(cached?.setupStep === 2 ? 2 : 1);
export const setupError = ref("");
export const setupOpen = ref(!!pendingStart.value || !(cached?.hasInterview || cached?.messages.length || cached?.pending || cached?.report));
export const canRetryAnswer = computed(() => !!pendingAnswer.value && !sending.value && interviewStatus.value === "active" && connectionStatus.value === "ready");
export const buttonDisabled = computed(() => !hasInterview.value || !!pendingStart.value || sending.value || interviewStatus.value !== "active" || connectionStatus.value !== "ready" || !!pendingAnswer.value);
export const speechError = ref("");
export const chatError = ref("");
export const reportError = ref("");
export const report = ref<InterviewReport | null>(cached?.report ?? null);
export const hasInterview = ref(cached?.hasInterview ?? false);
let finishRequested = cached?.finishRequested ?? false;
let activeTurn: Promise<void> | null = null;
let resetting = false;
let checkpointTime = currentTime.value;

function saveCache() {
  if (resetting) return;
  writeSessionCache({ sessionId, timeline: currentTime.value, messages: messages.value, pending: pendingAnswer.value,
    draft: draft.value, hasInterview: hasInterview.value, finishRequested, report: report.value,
    profile: profile.value, setupDraft: setupDraft.value, setupStep: setupStep.value, pendingStart: pendingStart.value });
}
watch([currentTime, draft], saveCache);
watch([setupDraft, setupStep], saveCache, { deep: true });
window.addEventListener("beforeunload", saveCache);

watch(currentTime, (time) => {
  if (!hasInterview.value || pendingStart.value || connectionStatus.value !== "ready" || interviewStatus.value !== "active" || time - checkpointTime < 0.25) return;
  checkpointTime = time;
  void requestJson(`/api/interview/${sessionId}/progress`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeline: time }),
  }, { attempts: 1, timeoutMs: 5000 }).catch(() => {
    connectionStatus.value = "offline";
    recoveryNotice.value = "连接暂时中断，计时已暂停。点击“恢复面试”重新同步。";
    saveCache();
  });
});

const speechPlayer = new StreamingSpeechPlayer({
  synthesize: async (text, signal) => {
    const response = await fetch("/api/tts", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { message?: string } | null;
      throw new Error(detail?.message ?? "语音请求失败");
    }
    return response.arrayBuffer();
  },
});
speechPlayer.onError = (error) => { speechError.value = error.message; };
export const activateSpeechOutput = () => speechPlayer.activate();
window.addEventListener("pagehide", () => speechPlayer.cancel());

const onRetry = (attempt: number) => {
  connectionStatus.value = "reconnecting";
  recoveryNotice.value = `连接中断，正在重试（${attempt}/2）…`;
};
const readSession = () => requestJson<InterviewSessionView>(`/api/interview/${sessionId}`, { cache: "no-store" }, { onRetry });

function applySession(session: InterviewSessionView) {
  const pending = pendingAnswer.value;
  messages.value = session.messages;
  currentTime.value = Math.max(currentTime.value, session.timeline);
  hasInterview.value = session.messages.length > 0 || !!session.profile;
  profile.value = session.profile ?? null;
  report.value = session.report ?? null;
  interviewStatus.value = finishRequested && session.status === "active" ? "finishing" : session.status;
  const turn = session.lastTurn;
  if (turn?.kind === "opening" && turn.status !== "completed" && session.status === "active" && session.profile) {
    pendingStart.value = { requestId: turn.requestId, ...session.profile };
    setupDraft.value = { ...session.profile };
    setupStep.value = 2;
    setupOpen.value = true;
    if (turn.status === "failed") setupError.value = "开场回复未完成，资料已保存。点击“重试开始面试”继续。";
  } else {
    pendingStart.value = null;
    setupOpen.value = false;
    setupError.value = "";
  }
  if (turn && turn.kind !== "opening" && turn.status !== "completed") {
    const answer = session.messages.find((message) => message.id === turn.userMessageId);
    if (answer) {
      if (pending && pending.requestId !== turn.requestId && !draft.value) draft.value = pending.content;
      pendingAnswer.value = { requestId: turn.requestId, content: answer.content, timeline: session.timeline };
    }
  } else if (turn?.requestId === pending?.requestId || session.status !== "active") {
    pendingAnswer.value = null;
  }
  chatError.value = turn?.status === "failed" && turn.kind !== "opening" ? "本轮回复未完成，你的回答已保存。点击“重试本轮回复”继续。" : "";
  if (session.status === "report_error") reportError.value = "面试已结束，可以重新生成反馈。";
  if (session.report) { reportError.value = ""; pendingAnswer.value = null; }
  saveCache();
}

function listenReply(turn: InterviewTurn, speak: boolean): Promise<void> {
  if (!turn.channel) return Promise.reject(new Error("对话通道已失效，请恢复面试"));
  // Replaying an SSE channel always starts from an empty assistant message, never appends twice.
  messages.value = messages.value.filter((message) => message.id !== turn.assistantMessageId);
  const response: InterviewMessage = { id: turn.assistantMessageId, role: "assistant", content: "", timestamp: Date.now() };
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/event?channel=${encodeURIComponent(turn.channel!)}`);
    let settled = false;
    const timer = setTimeout(() => settle(new Error("回复等待超时")), 70_000);
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.close();
      if (error) { speechPlayer.cancel(); reject(error); return; }
      if (speak && !finishRequested && interviewStatus.value === "active") void speechPlayer.finish();
      resolve();
    };
    source.addEventListener("message", (event) => {
      try {
        const { delta, uri } = JSON.parse(event.data);
        if (uri !== "reply" || typeof delta !== "string" || !delta) return;
        response.content += delta;
        const index = messages.value.findIndex((message) => message.id === response.id);
        if (index < 0) messages.value.push({ ...response });
        else messages.value[index] = { ...response };
        if (speak && !finishRequested && interviewStatus.value === "active") speechPlayer.append(delta);
      } catch { settle(new Error("回复格式异常")); }
    });
    source.addEventListener("response-finished", () => settle());
    source.addEventListener("finished", () => settle());
    source.addEventListener("reply-error", () => settle(new Error("模型回复失败")));
    source.onerror = () => settle(new Error("对话连接中断"));
  });
}

async function loadReport() {
  interviewStatus.value = "finishing";
  reportError.value = "";
  try {
    const result = await requestJson<InterviewReport>("/api/interview/finish", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, timeline: currentTime.value }),
    }, { attempts: 1, timeoutMs: 150_000 });
    report.value = result;
    messages.value = result.messages;
    pendingAnswer.value = null;
    interviewStatus.value = "finished";
  } catch (error) {
    interviewStatus.value = "report_error";
    reportError.value = error instanceof Error ? error.message : "反馈生成失败，请重试";
  }
  saveCache();
}

async function recover(initial?: InterviewSessionView, speak = false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let session = initial ?? await readSession();
      initial = undefined;
      applySession(session);
      connectionStatus.value = "ready";
      if (session.status === "finishing") { await loadReport(); return; }
      if (session.lastTurn?.status === "pending" && session.status === "active") {
        await listenReply(session.lastTurn, speak);
        session = await readSession();
        applySession(session);
      }
      if (session.lastTurn?.status === "pending" && session.status === "active") throw new Error("正在恢复未完成的回复");
      if (finishRequested && session.status === "active") {
        interviewStatus.value = "report_error";
        reportError.value = "结束请求尚未确认，请点击重新生成反馈。";
      }
      connectionStatus.value = "ready";
      recoveryNotice.value = "已同步保存的面试记录。";
      saveCache();
      return;
    } catch (error) {
      speak = false;
      speechPlayer.cancel();
      if (error instanceof HttpError && error.status === 404 && !hasInterview.value) {
        connectionStatus.value = "ready";
        recoveryNotice.value = pendingStart.value ? "开始请求尚未确认，可重试开始面试。" : pendingAnswer.value ? "上次回答尚未确认提交，可以重试发送。" : "已恢复输入草稿。";
        return;
      }
      if (attempt < 2 && (!(error instanceof HttpError) || retryable(error))) {
        onRetry(attempt + 1);
        await delay(1000 * 2 ** attempt);
      } else {
        connectionStatus.value = "offline";
        recoveryNotice.value = error instanceof HttpError && error.status === 404
          ? "服务器未找到本场记录，请检查服务是否使用原来的数据目录，或开始新面试。"
          : "暂时无法连接，已保留本地记录。网络恢复后可点击“恢复面试”。";
        saveCache();
        return;
      }
    }
  }
}

async function submitAnswer(answer: PendingAnswer, retry: boolean) {
  sending.value = true;
  chatError.value = "";
  speechError.value = "";
  pendingAnswer.value = answer;
  if (!retry) messages.value.push({ id: `local-${answer.requestId}`, role: "user", content: answer.content, timestamp: Date.now() });
  saveCache(); // Persist the request ID BEFORE sending, including when the POST response is lost.
  speechPlayer.start();
  try {
    const data = await requestJson<{ session: InterviewSessionView; assistantMessageId: string }>("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: answer.content, sessionId, timeline: answer.timeline, requestId: answer.requestId, retry }),
    }, { onRetry });
    if (data.session.messages.some((message) => message.id === data.assistantMessageId)) pendingAnswer.value = null;
    await recover(data.session, true);
  } catch (error) {
    speechPlayer.cancel();
    if (error instanceof HttpError && !retryable(error) && error.status !== 409) {
      chatError.value = error.message;
      connectionStatus.value = "ready";
      draft.value = answer.content;
      pendingAnswer.value = null;
      messages.value = messages.value.filter((message) => message.id !== `local-${answer.requestId}`);
    } else {
      await recover(); // Inspect the server before deciding whether a failed POST was accepted.
    }
  } finally {
    sending.value = false;
    saveCache();
  }
}

export function sendMessage(content: string) {
  if (buttonDisabled.value || !content.trim()) return;
  activeTurn = submitAnswer({ requestId: crypto.randomUUID(), content: content.trim(), timeline: currentTime.value }, false);
}

export function retryLastAnswer() {
  if (!canRetryAnswer.value || !pendingAnswer.value) return;
  activeTurn = submitAnswer(pendingAnswer.value, true);
}

async function submitStart(start: PendingStart) {
  sending.value = true;
  setupError.value = "";
  pendingStart.value = start;
  saveCache();
  speechPlayer.start();
  try {
    const data = await requestJson<{ session: InterviewSessionView }>("/api/interview/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, ...start, retry: true }),
    }, { onRetry });
    await recover(data.session, true);
  } catch (error) {
    speechPlayer.cancel();
    if (error instanceof HttpError && !retryable(error) && error.status !== 409) {
      pendingStart.value = null;
      connectionStatus.value = "ready";
    } else {
      await recover();
    }
    if (setupOpen.value) setupError.value = error instanceof Error ? error.message : "开始面试失败，请重试";
  } finally {
    sending.value = false;
    saveCache();
  }
}

export function startInterview() {
  if (sending.value || connectionStatus.value !== "ready" || (hasInterview.value && !pendingStart.value)) return;
  if (!setupDraft.value.resume.trim() || setupDraft.value.resume.length > RESUME_MAX_LENGTH || setupDraft.value.jobDescription.length > JD_MAX_LENGTH) {
    setupError.value = "请填写简历，并检查简历和 JD 是否超过长度限制。";
    return;
  }
  activateSpeechOutput();
  activeTurn = submitStart(pendingStart.value ?? { requestId: crypto.randomUUID(), resume: setupDraft.value.resume.trim(), jobDescription: setupDraft.value.jobDescription.trim() });
}

export function restoreInterview() {
  if (sending.value || interviewStatus.value === "finishing") return;
  if (!hasInterview.value && !pendingAnswer.value && !pendingStart.value) {
    connectionStatus.value = "ready";
    recoveryNotice.value = "";
    return;
  }
  sending.value = true;
  connectionStatus.value = "restoring";
  recoveryNotice.value = "正在恢复面试记录…";
  activeTurn = recover().finally(() => { sending.value = false; saveCache(); });
}
window.addEventListener("online", () => { if (connectionStatus.value === "offline") restoreInterview(); });
window.addEventListener("offline", () => {
  connectionStatus.value = "offline";
  recoveryNotice.value = "网络已断开，计时已暂停，回答和草稿已保留。";
  speechPlayer.cancel();
  saveCache();
});

export async function finishInterview() {
  if (pendingStart.value || interviewStatus.value === "finishing" || report.value || (!hasInterview.value && !sending.value)) return;
  finishRequested = true;
  saveCache();
  interviewStatus.value = "finishing";
  speechPlayer.cancel();
  await activeTurn;
  if (!hasInterview.value) { finishRequested = false; interviewStatus.value = "active"; saveCache(); return; }
  await loadReport();
}

export function startNewInterview() {
  resetting = true;
  clearSessionCache();
  location.reload();
}
