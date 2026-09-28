import OpenAI from "openai";

import type { ChatConfig, ChatOptions } from "../types";
import { Tube } from "../tube";
import { JSONParser } from "../parser";
import { sleep } from "../utils";

const DEFAULT_CHAT_OPTIONS = {
  temperature: 0.9,
  top_p: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
};

export async function getChatCompletions(
  tube: Tube,
  messages: any[],
  config: ChatConfig,
  options?: ChatOptions,
  onComplete?: (content: string) => void,
  onStringResponse?: (
    content: { uri: string | null; delta: string } | string,
  ) => void,
  onObjectResponse?: (content: { uri: string | null; delta: any }) => void,
) {
  options = { ...DEFAULT_CHAT_OPTIONS, ...options };
  if (options.response_format) {
    options.response_format = {
      type: options.response_format.type,
      root: options.response_format.root,
    };
  }
  options.max_tokens = options.max_tokens || config.max_tokens || 4096;

  const isQuiet: boolean = !!options.quiet;
  delete options.quiet;

  const isJSONFormat: boolean = options.response_format?.type === "json_object";

  let client: OpenAI;
  let model: string = "";
  // console.log(config);
  const { model_name, api_key, endpoint } = config as ChatConfig;
  model = model_name;
  client = new OpenAI({
    apiKey: api_key,
    baseURL: endpoint.replace(/\/chat\/completions$/, ""),
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
  });
  const parentPath = options.response_format?.root;
  delete options.response_format?.root;
  const events = await client.chat.completions.create({
    messages,
    ...options,
    model,
    stream: true,
  }, { signal: AbortSignal.timeout(60_000) });
  let content = "";
  const buffer: any[] = [];
  let done = false;
  let failed = false;
  let finishReason: string | null = null;

  let parser: JSONParser | undefined;

  if (isJSONFormat) {
    parser = new JSONParser({
      parentPath,
      autoFix: true,
    });
    parser.on("data", (data) => {
      buffer.push(data);
    });
    parser.on("string-resolve", (content) => {
      if (onStringResponse) {
        onStringResponse(content);
      }
    });
    parser.on("object-resolve", (content) => {
      if (onObjectResponse) {
        onObjectResponse(content);
      }
    });
  }
  const promises: any[] = [
    (async () => {
      try {
        for await (const event of events) {
          if (tube.canceled) break;
          const choice = event.choices[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (choice && choice.delta) {
            if (choice.delta.content) {
              content += choice.delta.content;
            }
            if (parser) {
              if (choice.delta.content) parser.trace(choice.delta.content);
            } else {
              buffer.push({ uri: parentPath, delta: choice.delta.content });
            }
          }
        }
        if (!tube.canceled && finishReason !== "stop") throw new Error("模型回复未完整结束，请重试本轮回复");
        if (parser) parser.finish();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        done = true;
      }
    })(),
    (async () => {
      let i = 0;
      while (!(done && i >= buffer.length)) {
        if (i < buffer.length) {
          tube.enqueue(buffer[i], isQuiet);
          i++;
        }
        const delta = buffer.length - i;
        if (done || delta <= 0) await sleep(10);
        else await sleep(Math.max(10, 1000 / delta));
      }
      if (!tube.canceled && !failed && onComplete) {
        onComplete(content);
      }
    })(),
  ];
  await Promise.all(promises);
  if (!isJSONFormat && onStringResponse) {
    onStringResponse({ uri: parentPath, delta: content });
  }
  return content;
}
