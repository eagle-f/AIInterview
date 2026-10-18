import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import rawDefaultJD from "../backend/lib/prompt/jd.prompt";
import { normalizeInterviewProfile } from "../backend/lib/service/interviewProfile";
import { InterviewStore } from "../backend/lib/service/interview";
import { JD_MAX_LENGTH, RESUME_MAX_LENGTH, type InterviewSessionView, type InterviewReport } from "../shared/interview";
import { HttpError, requestJson } from "../src/lib/http";
import { launchMockInterview } from "./helpers/mockInterview";
import { parseFeedback } from "../backend/lib/service/feedback";

const defaultJD = rawDefaultJD.trim();

test("setup trims text, resolves blank JD, and rejects missing or overlong fields", () => {
  for (const jd of [undefined, "", " \n\t "]) {
    assert.deepEqual(normalizeInterviewProfile(" 简历内容 \n", jd), { resume: "简历内容", jobDescription: defaultJD });
  }
  assert.deepEqual(normalizeInterviewProfile(" 简历 ", " 后端工程师 "), { resume: "简历", jobDescription: "后端工程师" });
  for (const resume of [undefined, null, 12, " \n", "a".repeat(RESUME_MAX_LENGTH + 1)]) assert.throws(() => normalizeInterviewProfile(resume));
  for (const jd of [null, 12, {}, "a".repeat(JD_MAX_LENGTH + 1)]) assert.throws(() => normalizeInterviewProfile("简历", jd));
});

test("opening stores background separately, survives restart, and cannot change another session's profile", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "interview-setup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profile = normalizeInterviewProfile("简历 A", "岗位 A");
  const store = new InterviewStore(directory);
  const opening = store.beginOpening("a", profile, "opening-a");
  store.beginOpening("b", normalizeInterviewProfile("简历 B"), "opening-b").complete("你好 B");
  assert.equal(store.get("a").messages.length, 0);
  assert.equal(store.get("a").lastTurn?.kind, "opening");
  assert.throws(() => store.beginTurn("a", "回答", "r1"), /等待/);
  const restored = new InterviewStore(directory);
  assert.equal(restored.get("a").lastTurn?.status, "failed");
  const retry = restored.beginOpening("a", profile, "opening-a");
  assert.equal(retry.assistantMessageId, opening.assistantMessageId);
  retry.complete("你好 A");
  assert.deepEqual(restored.get("a").messages.map((message) => message.role), ["assistant"]);
  assert.deepEqual(restored.getProfile("a"), profile);
  assert.equal(restored.getProfile("b").resume, "简历 B");
  assert.throws(() => restored.findOpening("a", "opening-a", normalizeInterviewProfile("不同简历", "岗位 A")), /不能更改/);
  assert.throws(() => restored.findTurn("a", "opening-a", "回答"), /不同/);
  store.beginTurn("legacy", "旧版本回答", "legacy-r").complete("回复");
  assert.equal(new InterviewStore(directory).getProfile("legacy").jobDescription, defaultJD);
});

test("HTTP start deduplicates lost responses; every reply and feedback uses the saved custom profile", { timeout: 40_000 }, async (t) => {
  const app = await launchMockInterview();
  t.after(() => app.close());
  const payload = { sessionId: "setup-custom", requestId: "opening-id", resume: "项目经历 {{ literal }} {% invalid %}，负责服务性能分析", jobDescription: "后端工程师：数据库与服务性能优化" };
  const post = <T>(url: string, body: object) => requestJson<T>(`${app.baseUrl}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { attempts: 1 });
  for (const bad of [{ ...payload, resume: " " }, { ...payload, jobDescription: null }]) {
    await assert.rejects(post("/interview/start", bad), (error: unknown) => error instanceof HttpError && error.status === 400);
  }
  await assert.rejects(requestJson(`${app.baseUrl}/interview/setup-custom`), (error: unknown) => error instanceof HttpError && error.status === 404);
  let calls = 0;
  const opening = await requestJson<{ session: InterviewSessionView; channel: string; assistantMessageId: string }>(`${app.baseUrl}/interview/start`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, { fetchImpl: async (url, init) => {
    const response = await fetch(url, init);
    if (++calls === 1) { await response.text(); throw new TypeError("response lost"); }
    return response;
  }, wait: async () => {} });
  await (await fetch(`${app.baseUrl}/event?channel=${opening.channel}`)).text();
  const repeated = await post<{ session: InterviewSessionView; assistantMessageId: string }>("/interview/start", payload);
  assert.equal(repeated.assistantMessageId, opening.assistantMessageId);
  assert.equal(repeated.session.messages.length, 1);
  assert.equal(repeated.session.messages[0].role, "assistant");
  assert.equal(app.replyCalls(), 1);
  await assert.rejects(post("/interview/start", { ...payload, resume: "新简历" }), (error: unknown) => error instanceof HttpError && error.status === 409);
  await app.restart();
  const answer = "我通过慢查询日志定位数据库问题，并使用执行计划验证索引效果。";
  const chat = await post<{ channel: string; userMessage: { id: string } }>("/chat", { sessionId: payload.sessionId, requestId: "answer-id", timeline: 11, message: answer });
  await (await fetch(`${app.baseUrl}/event?channel=${chat.channel}`)).text();
  const report = await post<InterviewReport>("/interview/finish", { sessionId: payload.sessionId });
  assert.deepEqual(report.profile, { resume: payload.resume, jobDescription: payload.jobDescription });
  assert.deepEqual(report.messages.filter((message) => message.role === "user").map((message) => message.content), [answer]);
  assert.equal(report.dimensions[1].evidence[0].messageId, chat.userMessage.id);
  const replies = app.requests.filter((request) => request.stream && request.response_format.type === "text");
  assert.equal(replies.length, 2);
  for (const request of replies) {
    const context = request.messages.filter((message: any) => message.role === "system").map((message: any) => message.content).join("\n");
    assert.ok(context.includes(payload.resume));
    assert.ok(context.includes(payload.jobDescription));
    assert.ok(!context.includes(defaultJD));
  }
  const feedback = app.requests.find((request) => !request.stream)!;
  assert.deepEqual(JSON.parse(feedback.messages.find((message: any) => message.role === "user").content).profile, report.profile);
  await app.restart();
  const finished = await requestJson<InterviewSessionView>(`${app.baseUrl}/interview/${payload.sessionId}`);
  assert.equal(finished.status, "finished");
  assert.deepEqual(finished.profile, report.profile);
});

test("failed opening restarts with the same ID and default JD without inventing a candidate answer", { timeout: 40_000 }, async (t) => {
  const app = await launchMockInterview({ truncateFirstReply: true });
  t.after(() => app.close());
  const payload = { sessionId: "setup-default", requestId: "opening-default", resume: "我维护组件库", jobDescription: " \n " };
  const post = (retry = false) => requestJson<{ channel: string; assistantMessageId: string; session: InterviewSessionView }>(`${app.baseUrl}/interview/start`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, retry }),
  });
  const first = await post();
  assert.match(await (await fetch(`${app.baseUrl}/event?channel=${first.channel}`)).text(), /reply-error/);
  assert.equal((await post()).session.lastTurn?.status, "failed");
  assert.equal(app.replyCalls(), 1);
  await app.restart();
  const retry = await post(true);
  assert.equal(retry.assistantMessageId, first.assistantMessageId);
  await (await fetch(`${app.baseUrl}/event?channel=${retry.channel}`)).text();
  const session = await requestJson<InterviewSessionView>(`${app.baseUrl}/interview/${payload.sessionId}`);
  assert.equal(session.profile?.jobDescription, defaultJD);
  assert.equal(session.messages.length, 1);
  assert.equal(session.lastTurn?.status, "completed");
  assert.equal(session.timeline, 0);
  assert.ok(app.requests.filter((request) => request.stream).every((request) => request.messages[0].content.includes(JSON.stringify(defaultJD).slice(1, -1))));
  const report = await requestJson<InterviewReport>(`${app.baseUrl}/interview/finish`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: payload.sessionId }),
  });
  assert.ok(report.dimensions.every((dimension) => dimension.level === "not_covered" && dimension.evidence.length === 0));
  assert.equal(report.messages.filter((message) => message.role === "user").length, 0);
  const forged = { ...report, dimensions: report.dimensions.map((dimension) => ({ ...dimension })) };
  forged.dimensions[0] = { ...forged.dimensions[0], level: "strong", evidence: [{ messageId: "resume", quote: payload.resume }] };
  assert.throws(() => parseFeedback(JSON.stringify(forged), report.messages), /逐字匹配/);
});
