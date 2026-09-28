import EventEmitter from "events";
import merge from "lodash.merge";

import { Bot, ChatBot, WorkState } from "./bot";
import { Tube } from "./tube";
import type { ChatConfig, ChatOptions } from "./types";
import { shortId, sleep } from "./utils";

export type { ChatConfig, ChatOptions } from "./types";
export type { Tube } from "./tube";

export class AImanage extends EventEmitter {
  protected _tube: Tube;
  protected customParams: Record<string, string> = {};
  protected bots: Bot[] = [];
  protected session_id: string = shortId();
  private _promise: Promise<any> | null = null;
  private _tasks: Promise<any>[] = [];
  constructor(
    protected config: ChatConfig,
    protected options: ChatOptions = {},
  ) {
    super();
    this.config = config;
    this.options = options;
    if (config.session_id) {
      this.session_id = config.session_id;
      delete config.session_id;
    }
    this._tube = new Tube(this.session_id);
    if (config.sse) {
      this._tube.setSSE(true);
    }
    this._tube.on("message", (message) => {
      this.emit("message", message);
    });
    this._tube.on("finished", () => {
      this.emit("finished");
    });
    this._tube.on("canceled", () => {
      this.emit("canceled");
    });
  }
  handleTask(task: () => Promise<any>) {
    return new Promise((resolve, reject) => {
      this._tasks.push(task().then(resolve).catch(reject));
    });
  }
  get promise() {
    if (!this._promise) {
      this._promise = new Promise((resolve, reject) => {
        let result: any = {};
        this.on("inference-done", (content, bot) => {
          let output = bot.isJSONFormat() ? JSON.parse(content) : content;
          if (bot.root !== null) {
            result[bot.root] = output;
          } else {
            result = merge(result, output);
          }
          setTimeout(async () => {
            if (
              this.bots.every(
                (_bot: Bot) =>
                  _bot.state === WorkState.INFERENCE_DONE ||
                  _bot.state === WorkState.FINISHED ||
                  _bot.state === WorkState.ERROR ||
                  bot === _bot,
              )
            ) {
              await Promise.all(this._tasks);
              resolve(result);
            }
          });
        });
        this.once("error", (error, bot) => {
          reject(error);
        });
      });
    }
    return this._promise;
  }

  createBot(
    root: string | null = null,
    config: Partial<ChatConfig> = {},
    options: Partial<ChatOptions> = {},
  ) {
    const bot = new ChatBot(
      this.tube,
      { ...this.config, ...config },
      { ...this.options, ...options },
    );
    bot.setJSONRoot(root);
    bot.setCustomParams(this.customParams);
    bot.on("error", (error) => {
      this.emit("error", error, bot);
    });
    bot.on("inference-done", (content) => {
      this.emit("inference-done", content, bot);
    });
    this.bots.push(bot);
    return bot;
  }
  addBot(bot: Bot) {
    this.bots.push(bot);
  }
  setCustomParams(params: Record<string, any>) {
    this.customParams = { ...params };
  }
  setSSE(sse: boolean) {
    this._tube.setSSE(sse);
  }

  protected isAllBotsFinished() {
    return this.bots.every(
      (bot) =>
        bot.state === WorkState.FINISHED ||
        bot.state === WorkState.INFERENCE_DONE ||
        bot.state === WorkState.ERROR,
    );
  }

  async close() {
    while (!this.isAllBotsFinished()) {
      await sleep(100);
    }
    await sleep(500);
    if (!this.isAllBotsFinished()) {
      this.close();
      return;
    }
    await Promise.all(this._tasks);
    this._tube.close();
    this.bots = [];
    this._tasks = [];
  }

  async cancel() {
    this._tube.cancel();
    this.bots = [];
    this._tasks = [];
  }

  sendEvent(event: any) {
    this._tube.enqueue(event);
  }
  get tube() {
    return this._tube;
  }

  get model() {
    return this.config.model_name;
  }

  get stream() {
    return this._tube.stream;
  }

  get canceled() {
    return this._tube.canceled;
  }

  get closed() {
    return this._tube.closed;
  }

  get id() {
    return this.session_id;
  }
}
