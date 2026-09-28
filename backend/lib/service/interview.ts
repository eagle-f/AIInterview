import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INTERVIEW_DURATION_MINUTES, type InterviewFeedback, type InterviewMessage, type InterviewReport, type InterviewSessionView, type InterviewTurn } from "../../../shared/interview";

export class InterviewError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface Session {
  messages: InterviewMessage[];
  turns: InterviewTurn[];
  timeline: number;
  startedAt: number;
  endedAt?: number;
  ended: boolean;
  memory?: unknown;
  memoryIndex?: number;
  pendingReply?: Promise<void>;
  snapshot?: InterviewMessage[];
  report?: InterviewReport;
  reportPromise?: Promise<InterviewReport>;
}

export class InterviewStore {
  private sessions = new Map<string, Session>();
  constructor(private directory?: string) {
    if (directory) mkdirSync(directory, { recursive: true });
  }

  private file(sessionId: string) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(sessionId)) throw new InterviewError(400, "会话 ID 无效");
    return path.join(this.directory!, `${sessionId}.json`);
  }

  private save(sessionId: string, session: Session) {
    if (!this.directory) return;
    const target = this.file(sessionId);
    const temporary = `${target}.tmp`;
    const { pendingReply: _pending, reportPromise: _report, ...saved } = session;
    // Each small session is replaced atomically; an interrupted write leaves the previous file intact.
    writeFileSync(temporary, JSON.stringify({ version: 1, ...saved }), "utf8");
    renameSync(temporary, target);
  }

  private load(sessionId: string): Session | undefined {
    const cached = this.sessions.get(sessionId);
    if (cached || !this.directory) return cached;
    const target = this.file(sessionId);
    if (!existsSync(target)) return undefined;
    try {
      const saved = JSON.parse(readFileSync(target, "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.messages) || !Array.isArray(saved.turns) ||
          typeof saved.startedAt !== "number" || typeof saved.timeline !== "number" || typeof saved.ended !== "boolean" ||
          !saved.messages.every((message: InterviewMessage) => typeof message.id === "string" && typeof message.content === "string" && ["user", "assistant"].includes(message.role)) ||
          !saved.turns.every((turn: InterviewTurn) => typeof turn.requestId === "string" && ["pending", "completed", "failed"].includes(turn.status))) {
        throw new Error("Invalid saved session");
      }
      const session: Session = { ...saved, pendingReply: undefined, reportPromise: undefined };
      // A model stream cannot survive a process restart. Keep the answer, allow retry with its original ID.
      for (const turn of session.turns) {
        if (turn.status === "pending") turn.status = "failed";
        delete turn.channel;
      }
      this.sessions.set(sessionId, session);
      return session;
    } catch {
      throw new InterviewError(503, "面试记录暂时无法读取，请检查服务端存储后重试");
    }
  }

  get(sessionId: string): InterviewSessionView {
    const session = this.load(sessionId);
    if (!session) throw new InterviewError(404, "未找到本场面试记录");
    return {
      sessionId, messages: session.messages.map((message) => ({ ...message })), timeline: session.timeline,
      status: session.report ? "finished" : session.ended ? (session.reportPromise ? "finishing" : "report_error") : "active",
      lastTurn: session.turns.at(-1) ? { ...session.turns.at(-1)! } : undefined,
      report: session.report,
    };
  }

  findTurn(sessionId: string, requestId: string, content: string) {
    const session = this.load(sessionId);
    const turn = session?.turns.find((entry) => entry.requestId === requestId);
    if (turn && session!.messages.find((message) => message.id === turn.userMessageId)?.content !== content) {
      throw new InterviewError(409, "同一个请求 ID 不能用于不同的回答");
    }
    return turn;
  }

  progress(sessionId: string, timeline: number) {
    const session = this.load(sessionId);
    if (!session) throw new InterviewError(404, "未找到本场面试记录");
    if (!session.ended) {
      session.timeline = Math.max(session.timeline, Math.min(INTERVIEW_DURATION_MINUTES, timeline));
      this.save(sessionId, session);
    }
  }

  getMemory(sessionId: string) { return this.load(sessionId)?.memory; }

  updateMemory(sessionId: string, userMessageId: string, memory: unknown) {
    const session = this.load(sessionId);
    if (!session || !memory || typeof memory !== "object" || Array.isArray(memory)) return;
    const fields = memory as Record<string, unknown>;
    if (!Array.isArray(fields.askedQuestions) || typeof fields.interviewSummary !== "string") return;
    const index = session.messages.findIndex((message) => message.id === userMessageId);
    if (index < 0 || index < (session.memoryIndex ?? -1)) return;
    session.memory = memory;
    session.memoryIndex = index;
    this.save(sessionId, session);
  }

  beginTurn(sessionId: string, content: string, requestId = randomUUID(), timeline = 0) {
    let session = this.load(sessionId);
    if (!session) {
      session = { messages: [], turns: [], timeline: 0, startedAt: Date.now(), ended: false };
      this.sessions.set(sessionId, session);
    }
    if (session.ended) throw new InterviewError(409, "本场面试已结束，请查看面试反馈");
    if (session.pendingReply) throw new InterviewError(409, "请等待当前回复完成");
    let turn = this.findTurn(sessionId, requestId, content);
    if (turn && (turn.status !== "failed" || turn !== session.turns.at(-1))) {
      throw new InterviewError(409, "该回答已处理，请恢复最新面试记录");
    }
    if (!turn && session.turns.at(-1)?.status === "failed") {
      throw new InterviewError(409, "上一轮尚未完成，请先重试该轮回复或结束面试");
    }
    const userMessage: InterviewMessage = turn
      ? session.messages.find((message) => message.id === turn!.userMessageId)!
      : { id: randomUUID(), role: "user", content, timestamp: Date.now() };
    const previousMessages = session.messages.slice(0, turn ? session.messages.findIndex((message) => message.id === userMessage.id) : session.messages.length);
    if (!turn) {
      turn = { requestId, userMessageId: userMessage.id, assistantMessageId: randomUUID(), status: "pending" };
      session.messages.push(userMessage);
      session.turns.push(turn);
    }
    turn.status = "pending";
    delete turn.channel;
    session.timeline = Math.max(session.timeline, Math.min(INTERVIEW_DURATION_MINUTES, timeline));
    try { this.save(sessionId, session); } catch {
      turn.status = "failed";
      throw new InterviewError(503, "面试记录保存失败，请检查服务端存储后重试");
    }
    let resolveReply!: () => void;
    session.pendingReply = new Promise<void>((resolve) => { resolveReply = resolve; });
    let completed = false;
    return {
      userMessage, assistantMessageId: turn.assistantMessageId, previousMessages,
      setChannel: (channel: string) => { turn.channel = channel; },
      complete: (reply?: string) => {
        if (completed) return;
        completed = true;
        const assistant: InterviewMessage | undefined = reply?.trim()
          ? { id: turn.assistantMessageId, role: "assistant", content: reply, timestamp: Date.now() } : undefined;
        if (assistant) session.messages.push(assistant);
        turn.status = assistant ? "completed" : "failed";
        try {
          this.save(sessionId, session);
        } catch (error) {
          if (assistant) session.messages.pop();
          turn.status = "failed";
          throw error;
        } finally {
          session.pendingReply = undefined;
          resolveReply();
        }
      },
    };
  }

  finish(sessionId: string, generate: (messages: readonly InterviewMessage[]) => Promise<InterviewFeedback>): Promise<InterviewReport> {
    const session = this.load(sessionId);
    if (!session) throw new InterviewError(404, "未找到本场面试，请先完成对话");
    if (session.report) return Promise.resolve(session.report);
    if (session.reportPromise) return session.reportPromise;
    session.ended = true;
    session.endedAt ??= Date.now();
    this.save(sessionId, session);
    const request = (async () => {
      await session.pendingReply;
      session.snapshot ??= session.messages.map((message) => ({ ...message }));
      this.save(sessionId, session);
      const feedback = await generate(session.snapshot);
      const report: InterviewReport = {
        ...feedback, sessionId, generatedAt: Date.now(), durationMinutes: session.timeline,
        messages: session.snapshot,
      };
      session.report = report;
      try { this.save(sessionId, session); } catch (error) { session.report = undefined; throw error; }
      return report;
    })();
    session.reportPromise = request.finally(() => { session.reportPromise = undefined; });
    return session.reportPromise;
  }
}
