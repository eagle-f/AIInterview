import assert from "node:assert/strict";
import test from "node:test";
import { FeedbackInputError, generateFeedback, parseFeedback } from "../backend/lib/service/feedback";
import { InterviewError, InterviewStore } from "../backend/lib/service/interview";
import type { InterviewMessage, InterviewReport } from "../shared/interview";
import { feedbackFixture, launchMockInterview } from "./helpers/mockInterview";

const transcript: InterviewMessage[] = [
  { id: "a1", role: "assistant", content: "请介绍你的组件库维护经历。", timestamp: 1 },
  { id: "u1", role: "user", content: "我在华为参与前端业务开发，也负责组件库维护。", timestamp: 2 },
];
const validFeedback = () => parseFeedback(JSON.stringify(feedbackFixture(transcript)), transcript);

test("valid feedback keeps exact evidence and server-owned dimension titles", () => {
  const result = validFeedback();
  assert.equal(result.dimensions[1].title, "项目深度");
  assert.equal(result.dimensions[1].evidence[0].quote, transcript[1].content);
  assert.equal(result.dimensions[0].level, "not_covered");
});

test("rejects invented, altered, and interviewer-only evidence", () => {
  for (const evidence of [
    { messageId: "missing", quote: transcript[1].content },
    { messageId: "u1", quote: "我使组件库性能提升了 80%" },
    { messageId: "a1", quote: transcript[0].content },
  ]) {
    const fixture = feedbackFixture(transcript);
    fixture.dimensions[1].evidence = [evidence];
    assert.throws(() => parseFeedback(JSON.stringify(fixture), transcript), /逐字匹配/);
  }
});

test("rejects missing dimensions, unsupported levels, and ratings without evidence", () => {
  const fixture = feedbackFixture(transcript);
  fixture.dimensions[0].level = "needs_work";
  assert.throws(() => parseFeedback(JSON.stringify(fixture), transcript), /必须有候选人原文/);
  fixture.dimensions[0].level = "excellent";
  assert.throws(() => parseFeedback(JSON.stringify(fixture), transcript), /等级无效/);
  fixture.dimensions.pop();
  assert.throws(() => parseFeedback(JSON.stringify(fixture), transcript), /四个维度/);
});

test("invalid model output retries once against the same complete transcript", async () => {
  const inputs: string[] = [];
  const result = await generateFeedback(transcript, async (input, correction) => {
    inputs.push(input);
    if (inputs.length === 1) return "invalid json";
    assert.match(correction!, /JSON/);
    return JSON.stringify(feedbackFixture(transcript));
  });
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0], inputs[1]);
  assert.equal(JSON.parse(inputs[0]).transcript.length, 2);
  assert.equal(result.dimensions.length, 4);
  let calls = 0;
  await assert.rejects(generateFeedback(transcript, async () => { calls++; return "{}"; }));
  assert.equal(calls, 2);
});

test("overlong transcripts fail explicitly without truncation or calling the model", async () => {
  const messages: InterviewMessage[] = [{ ...transcript[1], content: "a".repeat(80_001) }];
  let calls = 0;
  await assert.rejects(generateFeedback(messages, async () => { calls++; return "{}"; }), FeedbackInputError);
  assert.equal(calls, 0);
});

test("finish waits for the last reply, freezes chat, and deduplicates concurrent requests", async () => {
  const store = new InterviewStore();
  const turn = store.beginTurn("session", "我的回答");
  let calls = 0;
  const generate = async (messages: readonly InterviewMessage[]) => {
    calls++;
    assert.equal(messages.length, 2);
    assert.equal(messages[1].content, "最后的回复");
    return validFeedback();
  };
  const first = store.finish("session", generate);
  assert.equal(store.finish("session", generate), first);
  assert.equal(calls, 0);
  assert.throws(() => store.beginTurn("session", "下一轮"), (error: unknown) => error instanceof InterviewError && error.status === 409);
  turn.complete("最后的回复");
  turn.complete("重复结束回调");
  const report = await first;
  assert.equal(report.messages.length, 2);
  assert.equal(await store.finish("session", generate), report);
  assert.equal(calls, 1);
});

test("failed reports can retry using the frozen transcript", async () => {
  const store = new InterviewStore();
  const turn = store.beginTurn("retry", "已保存的回答");
  turn.complete();
  let snapshot: readonly InterviewMessage[] | undefined;
  await assert.rejects(store.finish("retry", async (messages) => {
    snapshot = messages;
    throw new Error("temporary failure");
  }));
  assert.throws(() => store.beginTurn("retry", "新回答"), /已结束/);
  const report = await store.finish("retry", async (messages) => {
    assert.equal(messages, snapshot);
    return validFeedback();
  });
  assert.equal(report.messages[0].content, "已保存的回答");
  assert.throws(() => store.finish("missing", async () => validFeedback()), (error: unknown) => error instanceof InterviewError && error.status === 404);
});

test("HTTP flow: chat → streaming → finish → retry → cached report with navigable evidence", { timeout: 30_000 }, async (t) => {
  const app = await launchMockInterview({ failFirstReport: true });
  t.after(() => app.close());
  const post = (path: string, body: object) => fetch(`${app.baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/interview/finish", { sessionId: "missing" })).status, 404);
  assert.equal((await post("/interview/finish", {})).status, 400);
  const response = await post("/chat", { sessionId: "http-test", message: transcript[1].content, timeline: 0 });
  assert.equal(response.status, 200);
  const chat = await response.json() as { channel: string; userMessage: InterviewMessage; assistantMessageId: string };
  const firstStream = await (await fetch(`${app.baseUrl}/event?channel=${chat.channel}`)).text();
  assert.match(firstStream, /response-finished/);
  const secondAnswer = "我先复现表格组件的重复渲染，再增加最小用例验证修复。";
  const secondResponse = await post("/chat", { sessionId: "http-test", message: secondAnswer, timeline: 1 });
  assert.equal(secondResponse.status, 200);
  const secondChat = await secondResponse.json() as { channel: string; assistantMessageId: string };
  const stream = fetch(`${app.baseUrl}/event?channel=${secondChat.channel}`).then((response) => response.text());
  // Finish immediately, while the mock model is still streaming the last reply.
  const failed = await post("/interview/finish", { sessionId: "http-test" });
  assert.equal(failed.status, 502);
  assert.match(await stream, /response-finished/);
  assert.equal((await post("/chat", { sessionId: "http-test", message: "不应写入", timeline: 1 })).status, 409);
  const result = await post("/interview/finish", { sessionId: "http-test" });
  assert.equal(result.status, 200);
  const report = await result.json() as InterviewReport;
  assert.equal(report.messages.length, 4);
  assert.equal(report.messages[0].id, chat.userMessage.id);
  assert.equal(report.messages[1].id, chat.assistantMessageId);
  assert.equal(report.messages[3].id, secondChat.assistantMessageId);
  assert.equal(report.dimensions[1].evidence[0].messageId, chat.userMessage.id);
  const repeated = await (await post("/interview/finish", { sessionId: "http-test" })).json();
  assert.deepEqual(repeated, report);
  assert.equal(app.reportCalls(), 2);
  const replyRequest = app.requests.find((request) => request.stream && request.response_format.type === "text")!;
  assert.equal(replyRequest.messages.filter((message: any) => message.role === "user" && message.content === transcript[1].content).length, 1);
  const secondReplyRequest = app.requests.filter((request) => request.stream && request.response_format.type === "text")[1];
  assert.deepEqual(secondReplyRequest.messages.filter((message: any) => message.role !== "system").map((message: any) => message.content), [transcript[1].content, report.messages[1].content, secondAnswer]);
  assert.equal((await fetch(`${app.baseUrl}/event?channel=unknown`)).status, 404);
});
