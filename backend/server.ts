import * as dotenv from "dotenv";
import express from "express";
import { AImanage } from "./lib/AImanage";
import { pipeline } from "node:stream/promises";
import { getContext } from "./lib/config/context.config";
import {
  createEventChannel,
  getEventChannel,
} from "./lib/service/eventChannel";
import { getInterviewMemory } from "./lib/service/memory";
import memoryPrompt from "./lib/prompt/memory.prompt";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachASRWebSocket } from "./lib/service/asrHandler";
import { synthesizeSpeech } from "./lib/service/tts";
import { InterviewError, InterviewStore } from "./lib/service/interview";
import { createFeedbackGenerator, FeedbackInputError } from "./lib/service/feedback";
import { normalizeInterviewProfile, ProfileInputError } from "./lib/service/interviewProfile";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const desktop = process.env.AIINTERVIEW_DESKTOP === "1";
if (!desktop) dotenv.config({
  path: [
    path.resolve(__dirname, "../.env.local"),
    path.resolve(__dirname, "../.env"),
  ],
});

const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const endpoint = process.env.BASE_URL ?? "";
const modelName = process.env.AI_MODEL ?? "";
const ttsOptions = {
  apiKey: process.env.TTS_API_KEY ?? "",
  resourceId: process.env.TTS_RESOURCE_ID ?? "",
  voiceName: process.env.TTS_VOICE_NAME ?? "",
};

const app = express();
const api = express.Router();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? (desktop ? "127.0.0.1" : "0.0.0.0");
const desktopToken = process.env.AIINTERVIEW_DESKTOP_TOKEN;
if (desktop && !desktopToken) throw new Error("Desktop backend requires an access token");

// Electron injects this per-launch token; ordinary browser pages cannot call the desktop API.
const authorized = (req: import("node:http").IncomingMessage) => {
  if (!desktop) return true;
  const origin = req.headers.origin;
  return req.headers["x-aiinterview-token"] === desktopToken &&
    (!origin || origin === `http://${req.headers.host}` || origin === process.env.AIINTERVIEW_DEV_ORIGIN);
};
app.use((req, res, next) => {
  if (!authorized(req)) { res.sendStatus(403); return; }
  next();
});
const interviews = new InterviewStore(process.env.INTERVIEW_DATA_DIR ?? path.resolve(__dirname, ".data/sessions"));
const generateReport = createFeedbackGenerator({ apiKey, endpoint, model: modelName });
const validSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);

app.use(express.json({ limit: "256kb" }));
api.get("/health", (_req, res) => res.json({ status: "ok" }));

api.post("/tts", async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || !text.trim() || text.length > 500) {
    res.status(400).json({ message: "语音文本长度必须在 1 到 500 字之间" });
    return;
  }
  if (!ttsOptions.apiKey || !ttsOptions.resourceId || !ttsOptions.voiceName) {
    res.status(503).json({ message: "语音服务未配置" });
    return;
  }
  try {
    const audio = await synthesizeSpeech(text, ttsOptions);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(audio);
  } catch (error) {
    console.error("语音生成失败:", error);
    res.status(502).json({ message: "语音生成失败" });
  }
});

api.post("/interview/start", (req, res) => {
  const { sessionId, requestId, resume, jobDescription, retry = false } = req.body ?? {};
  if (!validSessionId(sessionId) || !validSessionId(requestId) || typeof retry !== "boolean") {
    res.status(400).json({ message: "开始面试参数无效" }); return;
  }
  try {
    const profile = normalizeInterviewProfile(resume, jobDescription);
    const existing = interviews.findOpening(sessionId, requestId, profile);
    if (existing && (existing.status !== "failed" || !retry)) {
      res.json({ session: interviews.get(sessionId), channel: existing.channel, assistantMessageId: existing.assistantMessageId });
      return;
    }
    if (!apiKey || !endpoint || !modelName) {
      res.status(503).json({ message: "模型服务未配置" }); return;
    }
    const turn = interviews.beginOpening(sessionId, profile, requestId);
    res.json(startReply(sessionId, 0, turn));
  } catch (error) {
    res.status(error instanceof ProfileInputError ? 400 : error instanceof InterviewError ? error.status : 500)
      .json({ message: error instanceof Error ? error.message : "开始面试失败，请重试" });
  }
});

api.post("/chat", async (req, res) => {
  const { message, sessionId, timeline, requestId = crypto.randomUUID(), retry = false } = req.body ?? {};
  if (!validSessionId(sessionId) || typeof message !== "string" || !message.trim() || message.length > 10_000 ||
      typeof timeline !== "number" || !Number.isFinite(timeline) || timeline < 0 ||
      !validSessionId(requestId) || typeof retry !== "boolean") {
    res.status(400).json({ message: "对话参数无效" });
    return;
  }
  let turn: ReturnType<InterviewStore["beginTurn"]>;
  try {
    const existing = interviews.findTurn(sessionId, requestId, message.trim());
    if (existing && (existing.status !== "failed" || !retry)) {
      const session = interviews.get(sessionId);
      res.json({ session, channel: existing.channel, userMessage: session.messages.find((entry) => entry.id === existing.userMessageId), assistantMessageId: existing.assistantMessageId });
      return;
    }
    if (!apiKey || !endpoint || !modelName) {
      res.status(503).json({ message: "模型服务未配置" });
      return;
    }
    turn = interviews.beginTurn(sessionId, message.trim(), requestId, timeline);
  } catch (error) {
    res.status(error instanceof InterviewError ? error.status : 500).json({ message: error instanceof Error ? error.message : "创建对话失败" });
    return;
  }
  try {
    res.send(startReply(sessionId, timeline, turn));
  } catch (error) {
    console.error("创建对话失败:", error);
    res.status(500).json({ message: "创建对话失败，请稍后重试" });
  }
});

function startReply(sessionId: string, timeline: number, turn: ReturnType<InterviewStore["beginTurn"]> | ReturnType<InterviewStore["beginOpening"]>) {
  try {
    const config = {
      model_name: modelName,
      api_key: apiKey,
      endpoint: endpoint,
      sse: true,
    };
    const context = getContext(timeline, interviews.getProfile(sessionId));
    const savedMemory = interviews.getMemory(sessionId);
    const memory = savedMemory ?? getInterviewMemory(sessionId);

    const memoryStr = `# memory
    ${JSON.stringify(memory)}
    `;

    const aiManager = new AImanage(config);
    // 防止单个 bot 的 error 事件没人监听导致进程崩溃
    aiManager.on("error", (err) => {
      console.error("AI 调用出错:", err?.message || err);
    });
    const bot = aiManager.createBot(
      "reply",
      {},
      {
        response_format: { type: "text" },
      },
    );
    // Insert candidate text as template data so {{...}} in resumes stays literal.
    bot.addPrompt("{{ context | safe }}", { context });
    bot.addPrompt("{{ memory | safe }}", { memory: memoryStr });
    // If memory was not saved yet (e.g. the process stopped), recover context from the transcript.
    const history = savedMemory ? turn.previousMessages.slice(-2) : turn.previousMessages;
    bot.addHistory(history.map(({ role, content }) => ({ role, content })));
    bot.on("inference-done", (content: string) => {
      turn.complete(content);
      aiManager.sendEvent({ event: "response-finished" });
    });
    bot.on("error", () => {
      try { turn.complete(); } catch { /* the turn remains retryable if persistence failed */ }
      aiManager.sendEvent({ event: "reply-error", message: "面试官回复失败，请重试或结束面试查看已完成的记录" });
    });

    // 开场没有候选人回答，不生成回答摘要。
    if ("userMessage" in turn) {
      const memoryBot = aiManager.createBot(
        "memory",
        {},
        {
          quiet: true,
        },
      );

      memoryBot.on("inference-done", (content) => {
        try {
          // 模型可能输出 markdown 代码块包裹的 JSON，先尝试直接解析，失败则提取花括号内容
          let memory;
          try {
            memory = JSON.parse(content);
          } catch {
            const match = content.match(/\{[\s\S]*\}/);
            if (!match) return;
            memory = JSON.parse(match[0]);
          }
          interviews.updateMemory(sessionId, turn.userMessage.id, memory);
        } catch (err) {
          console.error("解析记忆失败:", err);
        }
      });
      memoryBot.addPrompt(memoryPrompt, { memory: memoryStr });
      memoryBot.chat(`# 历史对话内容
      ## 提问
      ${turn.previousMessages.at(-1)?.content || ""}
      ## 回答
      ${turn.userMessage.content}
      请更新记忆
    `);
    }

    void bot.chat("userMessage" in turn ? turn.userMessage.content : "请开始本场面试。你已经阅读候选人的简历，请简短欢迎并提出一个开场问题，引导候选人简短介绍，不要再次要求粘贴简历。");
    aiManager.close();
    const channel = createEventChannel(aiManager);
    turn.setChannel(channel.channel);
    return { ...channel, userMessage: "userMessage" in turn ? turn.userMessage : undefined, assistantMessageId: turn.assistantMessageId, session: interviews.get(sessionId) };
  } catch (error) {
    try { turn.complete(); } catch { /* surface setup or persistence failure */ }
    console.error("创建对话失败:", error);
    throw error;
  }
}

api.get("/interview/:sessionId", (req, res) => {
  if (!validSessionId(req.params.sessionId)) { res.status(400).json({ message: "会话 ID 无效" }); return; }
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(interviews.get(req.params.sessionId));
  } catch (error) {
    res.status(error instanceof InterviewError ? error.status : 503).json({ message: error instanceof InterviewError ? error.message : "读取面试记录失败，请重试" });
  }
});

api.patch("/interview/:sessionId/progress", (req, res) => {
  const timeline = req.body?.timeline;
  if (!validSessionId(req.params.sessionId) || typeof timeline !== "number" || !Number.isFinite(timeline) || timeline < 0) {
    res.status(400).json({ message: "面试进度参数无效" }); return;
  }
  try {
    interviews.progress(req.params.sessionId, timeline);
    res.sendStatus(204);
  } catch (error) {
    res.status(error instanceof InterviewError ? error.status : 503).json({ message: "面试进度暂时无法保存" });
  }
});

api.post("/interview/finish", async (req, res) => {
  const sessionId = req.body?.sessionId;
  if (!validSessionId(sessionId)) {
    res.status(400).json({ message: "面试会话参数无效" });
    return;
  }
  try {
    const timeline = req.body?.timeline;
    if (typeof timeline === "number" && Number.isFinite(timeline) && timeline >= 0) interviews.progress(sessionId, timeline);
    const report = await interviews.finish(sessionId, generateReport);
    res.setHeader("Cache-Control", "no-store");
    res.json(report);
  } catch (error) {
    if (error instanceof InterviewError) {
      res.status(error.status).json({ message: error.message });
    } else if (error instanceof FeedbackInputError) {
      res.status(413).json({ message: error.message });
    } else {
      console.error("面试反馈生成失败:", error instanceof Error ? error.message : "unknown error");
      res.status(502).json({ message: "反馈暂时生成失败，面试记录已保留，请重试" });
    }
  }
});

api.get("/event", async (req, res) => {
  const lastEventId = req.headers["last-event-id"] as string | undefined;
  const eventChannel = getEventChannel(req.query.channel as string);
  if (!eventChannel) {
    res.status(404).json({ message: "对话通道已失效" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (!desktop) res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const { stream } = eventChannel.getStream(lastEventId);
  try {
    await pipeline(stream, res);
  } catch {
    // pipeline cancels the readable stream when the browser disconnects.
  }
});

app.use("/api", api);
if (!desktop) app.use(api); // Keep the existing Vite proxy and standalone server compatible.
if (desktop && process.env.AIINTERVIEW_STATIC_DIR) {
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    next();
  });
  app.use(express.static(process.env.AIINTERVIEW_STATIC_DIR));
}

export const server = createServer(app);
const asrWebSocketServer = new WebSocketServer({ noServer: true });
attachASRWebSocket(asrWebSocketServer);

server.on("upgrade", (req, socket, head) => {
  // Vite 将 /api/asr 重写成 /asr，和现有 HTTP API 使用同一代理。
  const pathname = req.url?.split("?")[0];
  if (!authorized(req) || (pathname !== "/asr" && pathname !== "/api/asr")) {
    socket.destroy();
    return;
  }
  asrWebSocketServer.handleUpgrade(req, socket, head, (ws) => {
    asrWebSocketServer.emit("connection", ws, req);
  });
});

server.listen(port, host, () => {
  const address = server.address();
  console.log(`Server is running on port ${typeof address === "object" ? address?.port : port}`);
});
