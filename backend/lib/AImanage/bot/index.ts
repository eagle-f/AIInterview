import EventEmitter from "events";
import { Tube } from "../tube";
import nunjucks from "nunjucks";
import { getChatCompletions } from "../adapter";
import { shortId } from "../utils";

import type { ChatConfig, ChatOptions } from "../types";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionUserMessageParam,
  ChatCompletionContentPart,
} from "openai/resources/chat/completions";

type ChatCompletionMessageParam =
  | ChatCompletionSystemMessageParam
  | ChatCompletionAssistantMessageParam
  | ChatCompletionUserMessageParam;

export enum WorkState {
  INIT = "init",
  WORKING = "chatting",
  FINISHED = "finished",
  INFERENCE_DONE = "inference-done",
  ERROR = "error",
}

export abstract class Bot extends EventEmitter {
  abstract get state(): WorkState;
}

export class ChatBot extends Bot {
  public id: string;
  private prompts: ChatCompletionSystemMessageParam[] = [];
  private history: ChatCompletionMessageParam[] = [];
  private customParams: Record<string, string> = {};
  private chatState: WorkState = WorkState.INIT;
  private config: ChatConfig;
  private options: ChatOptions;

  constructor(
    private tube: Tube,
    config: ChatConfig,
    options: ChatOptions = {},
  ) {
    super();
    this.id = shortId();
    this.config = { ...config };
    this.options = { ...options };
  }

  isJSONFormat() {
    return this.options.response_format?.type === "json_object";
  }

  get root() {
    return this.options.response_format?.root;
  }

  setJSONRoot(root: string | null) {
    if (!this.options.response_format) {
      this.options.response_format = { type: "json_object", root };
    } else {
      this.options.response_format.root = root;
    }
  }

  setCustomParams(params: Record<string, string>) {
    this.customParams = { ...params };
  }

  addPrompt(promptTpl: string, promptData: Record<string, any> = {}) {
    const promptText = nunjucks.renderString(promptTpl, {
      chatConfig: this.config,
      chatOptions: this.options,
      ...this.customParams,
      ...promptData,
    });
    this.prompts.push({ role: "system", content: promptText });
  }

  setPrompt(promptTpl: string, promptData: Record<string, any> = {}) {
    this.prompts = [];
    this.addPrompt(promptTpl, promptData);
  }

  addHistory(message: ChatCompletionMessageParam[]) {
    this.history.push(...message);
  }

  setHistory(message: ChatCompletionMessageParam[]) {
    this.history = [...message];
  }

  addFilter(filter: ((data: unknown) => boolean) | string | RegExp) {
    this.tube.addFilter(filter);
  }
  clearFilters() {
    this.tube.clearFilters();
  }

  userMessage(message: string): ChatCompletionUserMessageParam {
    return { role: "user", content: message };
  }

  botMessage(message: string): ChatCompletionAssistantMessageParam {
    return { role: "assistant", content: message };
  }

  async chat(message: string | ChatCompletionContentPart[]) {
    try {
      this.chatState = WorkState.WORKING;
      const isJSONFormat = this.isJSONFormat();
      const prompts = this.prompts.length > 0 ? [...this.prompts] : [];
      if (prompts.length === 0 && isJSONFormat) {
        prompts.push({
          role: "system",
          content: `[Output]\nOutput with json format, starts with '{'\n[Example]\n{"answer": "My answer"}`,
        });
      }
      const messages = [
        ...prompts,
        ...this.history,
        { role: "user", content: message },
      ];
      return await getChatCompletions(
        this.tube,
        messages,
        this.config,
        this.options,
        (content) => {
          this.chatState = WorkState.FINISHED;
          this.emit("response", content);
        },
        (content) => {
          this.emit("string-response", content);
        },
        (content) => {
          this.emit("object-response", content);
        },
      ).then((content) => {
        this.chatState = WorkState.INFERENCE_DONE;
        this.emit("inference-done", content);
      });
    } catch (ex: any) {
      console.error(ex);
      this.chatState = WorkState.ERROR;
      this.emit("error", ex);
    }
  }

  finish() {
    this.emit("inference-done", "null");
    this.emit("response", "null");
    this.chatState = WorkState.FINISHED;
  }

  get state() {
    return this.chatState;
  }
}
