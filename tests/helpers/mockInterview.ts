import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InterviewMessage } from "../../shared/interview";

/** Deterministic local model fixture; never calls a paid model or speech service. */
export function feedbackFixture(messages: readonly InterviewMessage[]) {
  const answer = messages.find((message) => message.role === "user");
  if (!answer) return {
    summary: "本场尚未回答问题，暂无足够依据评价表现。",
    dimensions: ["technical", "project", "reasoning", "communication"].map((id) => ({
      id, level: "not_covered", assessment: "候选人尚未回答问题，无法评价。", strengths: [], improvements: [], evidence: [],
    })),
  };
  return {
    summary: "本场主要交流了组件库维护经历，能够说明个人职责。技术原理和复杂问题分析尚未充分展开，以下反馈仅针对已表达的内容。",
    dimensions: [
      { id: "technical", level: "not_covered", assessment: "尚未回答涉及技术原理的具体问题，无法评价技术基础。", strengths: [], improvements: ["下次选择一个组件，解释其响应式更新和事件传递机制。"], evidence: [] },
      { id: "project", level: "developing", assessment: "说明了组件库维护的职责，但还缺少具体问题、方案选择与验证结果。", strengths: ["能明确说明自己参与的工作。"], improvements: ["准备一个完整案例，按问题、方案、取舍、验证结果展开。"], evidence: [{ messageId: answer.id, quote: answer.content.slice(0, 100) }] },
      { id: "reasoning", level: "not_covered", assessment: "尚未展开具体问题的分析过程。", strengths: [], improvements: ["说明定位问题时排除了哪些可能原因。"], evidence: [] },
      { id: "communication", level: "developing", assessment: "回答简洁，能够直接说明经历；可以增加一项细节帮助听者理解工作内容。", strengths: ["表达围绕个人经历展开。"], improvements: ["用一个具体场景替代笼统的职责描述。"], evidence: [{ messageId: answer.id, quote: answer.content.slice(0, 100) }] },
    ],
  };
}

export async function launchMockInterview(options: { port?: number; failFirstReport?: boolean; failFirstReply?: boolean; truncateFirstReply?: boolean; replyDelayMs?: number } = {}) {
  const requests: Array<Record<string, any>> = [];
  let reportCalls = 0;
  let replyCalls = 0;
  const directory = mkdtempSync(path.join(tmpdir(), "aiinterview-test-"));
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (!body.stream) {
      reportCalls++;
      if (options.failFirstReport && reportCalls === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fixture temporary failure" } }));
        return;
      }
      const transcript = JSON.parse(body.messages.find((message: any) => message.role === "user").content).transcript;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "fixture-report", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(feedbackFixture(transcript)) }, finish_reason: "stop" }] }));
      return;
    }
    const isReply = body.response_format?.type !== "json_object";
    if (isReply) replyCalls++;
    if (isReply && options.failFirstReply && replyCalls === 1) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture reply failure" } }));
      return;
    }
    const truncate = isReply && options.truncateFirstReply && replyCalls === 1;
    const content = isReply ? "请举一个组件库维护中的具体问题，并说明你如何验证修复效果。" : "{}";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // Include an empty delta, as real providers do, and split the reply into chunks.
    const send = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture-chat", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: "assistant", content: "" });
    send({ content: content.slice(0, 1) });
    setTimeout(() => {
      if (res.destroyed) return;
      if (truncate) { res.end(); return; }
      send({ content: content.slice(1) });
      send({}, "stop");
      res.end("data: [DONE]\n\n");
    }, isReply ? options.replyDelayMs ?? 150 : 150);
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const modelPort = (model.address() as { port: number }).port;
  let port = options.port ?? 0;
  let child: ReturnType<typeof spawn>;
  const start = async () => {
  child = spawn(process.execPath, ["--import", "jiti/register", "backend/server.ts"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, PORT: String(port), INTERVIEW_DATA_DIR: directory, BASE_URL: `http://127.0.0.1:${modelPort}/v1`, DEEPSEEK_API_KEY: "test-only", AI_MODEL: "fixture", TTS_API_KEY: "", STT_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  child.stderr!.on("data", (data) => { output += data.toString(); });
    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Test server startup timed out: ${output}`)), 20_000);
      child.stdout!.on("data", (data) => {
        output += data.toString();
        const match = output.match(/Server is running on port (\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Test server exited (${code}): ${output}`)); });
    });
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  };
  try {
    await start();
    return {
      get baseUrl() { return `http://127.0.0.1:${port}`; }, requests,
      reportCalls: () => reportCalls,
      replyCalls: () => replyCalls,
      restart: async () => { await stop(); await start(); },
      close: async () => {
        await stop();
        model.closeAllConnections();
        await new Promise<void>((resolve) => model.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stop();
    model.closeAllConnections();
    model.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
