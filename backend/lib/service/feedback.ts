import OpenAI from "openai";
import feedbackPrompt from "../prompt/feedback.prompt";
import jobDescription from "../prompt/jd.prompt";
import {
  FEEDBACK_DIMENSIONS,
  type FeedbackDimension,
  type InterviewFeedback,
  type InterviewMessage,
} from "../../../shared/interview";

export type FeedbackCompletion = (input: string, correction?: string) => Promise<string>;

export class FeedbackInputError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("反馈字段必须是对象");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, maxLength = 1200): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error("反馈文本缺失或过长");
  }
  return value.trim();
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error("建议或亮点必须是最多 3 条的数组");
  return value.map((item) => text(item, 500));
}

/** Validate structure AND evidence against the authoritative, frozen transcript. */
export function parseFeedback(raw: string, messages: readonly InterviewMessage[]): InterviewFeedback {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error("反馈不是合法 JSON"); }
  const data = object(parsed);
  const summary = text(data.summary);
  if (!Array.isArray(data.dimensions) || data.dimensions.length !== FEEDBACK_DIMENSIONS.length) {
    throw new Error("反馈必须包含四个维度");
  }
  const entries = data.dimensions.map(object);
  const dimensions = FEEDBACK_DIMENSIONS.map(({ id, title }): FeedbackDimension => {
    const matches = entries.filter((entry) => entry.id === id);
    if (matches.length !== 1) throw new Error(`维度 ${id} 缺失或重复`);
    const entry = matches[0]!;
    if (!["strong", "developing", "needs_work", "not_covered"].includes(entry.level as string)) {
      throw new Error(`维度 ${id} 等级无效`);
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length > 3) throw new Error("引用必须是最多 3 条的数组");
    const evidence = entry.evidence.map((item) => {
      const reference = object(item);
      const messageId = text(reference.messageId, 100);
      const quote = text(reference.quote, 300);
      const original = messages.find((message) => message.id === messageId && message.role === "user");
      if (!original || !original.content.includes(quote)) {
        throw new Error("引用必须逐字匹配对应候选人消息中的原文");
      }
      return { messageId, quote };
    });
    const strengths = textList(entry.strengths);
    if (entry.level === "not_covered" ? evidence.length > 0 || strengths.length > 0 : evidence.length === 0) {
      throw new Error("已评价维度必须有候选人原文依据，未覆盖维度不能有引用或亮点");
    }
    return {
      id, title, level: entry.level as FeedbackDimension["level"],
      assessment: text(entry.assessment), strengths,
      improvements: textList(entry.improvements), evidence,
    };
  });
  return { summary, dimensions };
}

export async function generateFeedback(
  messages: readonly InterviewMessage[],
  complete: FeedbackCompletion,
): Promise<InterviewFeedback> {
  const input = JSON.stringify({ transcript: messages });
  // Never silently truncate evidence used for a report.
  if (input.length > 80_000) throw new FeedbackInputError("本场记录超过 80,000 字符，暂不支持生成完整反馈，请缩短下一场面试的内容");
  let correction: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await complete(input, correction);
    try {
      return parseFeedback(raw, messages);
    } catch (error) {
      if (attempt === 1) throw error;
      correction = error instanceof Error ? error.message : "格式校验失败";
    }
  }
  throw new Error("反馈生成失败");
}

export function createFeedbackGenerator(config: { apiKey: string; endpoint: string; model: string }) {
  return async (messages: readonly InterviewMessage[]) => {
    if (!config.apiKey || !config.endpoint || !config.model) throw new Error("模型服务未配置");
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.endpoint.replace(/\/chat\/completions\/?$/, ""),
      timeout: 60_000,
      maxRetries: 0,
    });
    return generateFeedback(messages, async (input, correction) => {
      const response = await client.chat.completions.create({
        model: config.model,
        stream: false,
        temperature: 0.2,
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${feedbackPrompt}\n\n岗位要求：\n${jobDescription}` },
          ...(correction ? [{ role: "system" as const, content: `上一次输出校验未通过：${correction}。请重新严格按规则输出。` }] : []),
          { role: "user", content: input },
        ],
      });
      return response.choices[0]?.message.content ?? "";
    });
  };
}
