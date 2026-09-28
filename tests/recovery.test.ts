import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InterviewStore } from "../backend/lib/service/interview";
import { HttpError, requestJson } from "../src/lib/http";
import { feedbackFixture, launchMockInterview } from "./helpers/mockInterview";
import { parseFeedback } from "../backend/lib/service/feedback";
import type { InterviewSessionView } from "../shared/interview";

test("disk sessions preserve completed answers, progress, memory and reports", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "interview-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new InterviewStore(directory);
  const turn = first.beginTurn("saved", "我的回答", "request-1", 3.5);
  turn.complete("已完成的回复");
  first.progress("saved", 7.5);
  first.updateMemory("saved", turn.userMessage.id, { interviewSummary: "已保存的摘要", askedQuestions: ["项目经历"] });
  const restored = new InterviewStore(directory);
  assert.equal(restored.get("saved").messages.length, 2);
  assert.equal(restored.get("saved").timeline, 7.5);
  assert.deepEqual(restored.getMemory("saved"), { interviewSummary: "已保存的摘要", askedQuestions: ["项目经历"] });
  const report = await restored.finish("saved", async (messages) => parseFeedback(JSON.stringify(feedbackFixture(messages)), messages));
  const reloaded = new InterviewStore(directory);
  assert.deepEqual(reloaded.get("saved").report, report);
  assert.deepEqual(await reloaded.finish("saved", async () => { throw new Error("must use persisted report"); }), report);
});

test("process restart makes an in-flight reply retryable without duplicating the user message", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "interview-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new InterviewStore(directory);
  const original = first.beginTurn("crash", "保留这个回答", "request-1", 2);
  original.setChannel("old-channel");
  const restored = new InterviewStore(directory);
  assert.equal(restored.get("crash").lastTurn?.status, "failed");
  assert.equal(restored.get("crash").lastTurn?.channel, undefined);
  const retry = restored.beginTurn("crash", "保留这个回答", "request-1", 2);
  assert.equal(retry.userMessage.id, original.userMessage.id);
  assert.equal(retry.assistantMessageId, original.assistantMessageId);
  assert.equal(retry.previousMessages.length, 0);
  retry.complete("重新生成的完整回复");
  assert.equal(restored.get("crash").messages.length, 2);
  assert.throws(() => restored.findTurn("crash", "request-1", "不同的回答"), /不同/);
});

test("corrupted stored data fails visibly instead of silently starting an empty session", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "interview-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "broken.json");
  writeFileSync(file, "broken data");
  const store = new InterviewStore(directory);
  assert.throws(() => store.get("broken"), /无法读取/);
  assert.throws(() => store.beginTurn("broken", "test", "r1"), /无法读取/);
  assert.equal(readFileSync(file, "utf8"), "broken data");
  assert.throws(() => store.get("../outside"), /ID 无效/);
});

test("transport retries are bounded, use backoff, and never retry permanent request errors", async () => {
  let calls = 0;
  const waits: number[] = [];
  const bodies: unknown[] = [];
  const value = await requestJson<{ ok: boolean }>("http://fixture", { method: "POST", body: '{"requestId":"same-id"}' }, {
    fetchImpl: async (_url, init) => {
      calls++; bodies.push(init?.body);
      if (calls === 1) throw new TypeError("network failed");
      return calls === 2 ? new Response('{}', { status: 503 }) : new Response('{"ok":true}');
    }, wait: async (ms) => { waits.push(ms); },
  });
  assert.equal(value.ok, true);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(new Set(bodies).size, 1);
  calls = 0;
  await assert.rejects(requestJson("http://fixture", {}, { fetchImpl: async () => { calls++; return new Response('{}', { status: 400 }); } }), HttpError);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(requestJson("http://fixture", {}, { fetchImpl: async () => { calls++; throw new TypeError("offline"); }, wait: async () => {} }));
  assert.equal(calls, 3);
});

test("lost POST response reuses the original turn and completed response", { timeout: 30_000 }, async (t) => {
  const app = await launchMockInterview();
  t.after(() => app.close());
  const body = JSON.stringify({ sessionId: "lost-response", requestId: "stable-request", message: "我负责组件库维护", timeline: 1 });
  let calls = 0;
  const response = await requestJson<{ session: InterviewSessionView; channel: string }>(`${app.baseUrl}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  }, {
    fetchImpl: async (url, init) => {
      const result = await fetch(url, init);
      if (++calls === 1) { await result.text(); throw new TypeError("response lost after server accepted"); }
      return result;
    }, wait: async () => {},
  });
  await (await fetch(`${app.baseUrl}/event?channel=${response.channel}`)).text();
  const repeated = await requestJson<{ session: InterviewSessionView }>(`${app.baseUrl}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(repeated.session.messages.length, 2);
  assert.equal(repeated.session.lastTurn?.status, "completed");
  assert.equal(app.replyCalls(), 1);
});

test("truncated model output is retryable and partial text is not treated as a completed answer", { timeout: 30_000 }, async (t) => {
  const app = await launchMockInterview({ truncateFirstReply: true });
  t.after(() => app.close());
  const payload = { sessionId: "truncated", requestId: "same-answer", message: "我参与组件维护", timeline: 1 };
  const post = (retry = false) => requestJson<{ channel: string; session: InterviewSessionView }>(`${app.baseUrl}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, retry }) });
  const first = await post();
  assert.match(await (await fetch(`${app.baseUrl}/event?channel=${first.channel}`)).text(), /reply-error/);
  const failed = await requestJson<InterviewSessionView>(`${app.baseUrl}/interview/truncated`);
  assert.equal(failed.lastTurn?.status, "failed");
  assert.equal(failed.messages.length, 1);
  assert.equal((await post()).session.lastTurn?.status, "failed");
  assert.equal(app.replyCalls(), 1);
  const retry = await post(true);
  await (await fetch(`${app.baseUrl}/event?channel=${retry.channel}`)).text();
  const completed = await requestJson<InterviewSessionView>(`${app.baseUrl}/interview/truncated`);
  assert.equal(completed.messages.length, 2);
  assert.equal(completed.messages[0].id, failed.messages[0].id);
  assert.equal(completed.lastTurn?.status, "completed");
  assert.equal(app.replyCalls(), 2);
});

test("HTTP resume survives backend restart during a reply and after report completion", { timeout: 60_000 }, async (t) => {
  const app = await launchMockInterview({ replyDelayMs: 1500 });
  t.after(() => app.close());
  const payload = { sessionId: "restart", requestId: "original-request", message: "请保留这条回答", timeline: 4 };
  const post = (url: string, body: object) => requestJson<any>(`${app.baseUrl}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const first = await post("/chat", payload);
  await app.restart();
  const restored = await requestJson<InterviewSessionView>(`${app.baseUrl}/interview/restart`);
  assert.equal(restored.messages[0].id, first.userMessage.id);
  assert.equal(restored.lastTurn?.status, "failed");
  assert.equal(restored.timeline, 4);
  const retry = await post("/chat", { ...payload, retry: true });
  await (await fetch(`${app.baseUrl}/event?channel=${retry.channel}`)).text();
  const report = await post("/interview/finish", { sessionId: "restart", timeline: 8.5 });
  assert.equal(report.messages.length, 2);
  await app.restart();
  const finished = await requestJson<InterviewSessionView>(`${app.baseUrl}/interview/restart`);
  assert.equal(finished.status, "finished");
  assert.equal(finished.timeline, 8.5);
  assert.deepEqual(finished.report, report);
  assert.deepEqual(await post("/interview/finish", { sessionId: "restart" }), report);
  assert.equal(app.reportCalls(), 1);
});
