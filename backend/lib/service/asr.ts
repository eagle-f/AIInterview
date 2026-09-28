// server/asr.ts
import WebSocket from "ws";
import crypto from "crypto";
import zlib from "zlib";

export interface ASROptions {
  apiKey: string;
  resourceId?: string; // 默认 volc.seedasr.sauc.duration（2.0 小时版）
  uid?: string;
  // 识别增强开关
  showUtterances?: boolean; // 返回分句/分词/时间戳
  enablePunc?: boolean; // 标点（默认 true）
  enableITN?: boolean; // 数字规整（默认 true）
  enableDDC?: boolean; // 顺滑/去语气词（默认 false，实时对话建议开）
  enableSpeaker?: boolean; // 说话人分离（需开启 nonstream 二遍）
  enableNonstream?: boolean; // 二遍识别（出 definite=true 的最终句，准确率更高）
  endWindowSize?: number; // VAD 判停静音时长 ms（默认 800，实时对话建议 600~800）
  resultType?: "full" | "single";
}

type EventName = "open" | "partial" | "final" | "text" | "error" | "close";

const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_REQUEST = 0b0010;
const FULL_SERVER_RESPONSE = 0b1001;
const SERVER_ERROR_RESPONSE = 0b1111;

const FLAG_NONE = 0b0000; // 不带 sequence（推荐）
const FLAG_POS_SEQ = 0b0001; // 带正 sequence
const FLAG_NEG_LAST = 0b0010; // 最后一包，不带 sequence
const FLAG_NEG_SEQ = 0b0011; // 最后一包，带负 sequence

const SER_JSON = 0b0001;
const COMPRESS_GZIP = 0b0001;

export class BigmodelASRSession {
  private ws: WebSocket | null = null;
  private closed = false;
  private listeners: { [k in EventName]?: Function[] } = {};

  constructor(private opts: ASROptions) {}

  on(event: EventName, fn: Function) {
    (this.listeners[event] ||= []).push(fn);
    return this;
  }
  private emit(event: EventName, ...args: any[]) {
    this.listeners[event]?.forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {
        console.error("asr listener error", e);
      }
    });
  }

  async connect(): Promise<void> {
    const endpoint =
      "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint, {
        headers: {
          "X-Api-Key": this.opts.apiKey,
          "X-Api-Resource-Id":
            this.opts.resourceId || "volc.seedasr.sauc.duration",
          "X-Api-Request-Id": crypto.randomUUID(),
          "X-Api-Sequence": "-1",
        },
      });
      this.ws = ws;
      ws.binaryType = "nodebuffer";

      ws.on("open", () => {
        this.sendFullClientRequest();
        this.emit("open");
        resolve();
      });
      ws.on("message", (buf: Buffer) => this.handleServerMessage(buf));
      ws.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
      ws.on("close", (code, reason) => {
        this.closed = true;
        this.emit("close", code, reason?.toString());
      });
    });
  }

  /**
   * 写入一段 16kHz/16bit/mono PCM，推荐 100~200ms 一块（1600~3200 样本 = 3200~6400 字节）
   */
  private finishedSent = false;
  private wsClosed = false;
  pushAudio(pcmChunk: Buffer) {
    if (
      this.closed ||
      this.finishedSent ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    )
      return;
    const payload = zlib.gzipSync(pcmChunk);
    const header = this.buildHeader(
      AUDIO_ONLY_REQUEST,
      FLAG_NONE, // ← 改：不手动传 sequence
      0 /*SER_NONE*/,
      COMPRESS_GZIP,
    );
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length, 0);
    this.ws.send(Buffer.concat([header, size, payload]));
  }

  /**
   * 结束输入（发最后一包/负包）。服务端会回最后一个 definite 结果然后关闭。
   */
  finish() {
    if (this.finishedSent || this.wsClosed) return;
    this.finishedSent = true;
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN)
      return;
    // 最后一包用 FLAG_NEG_LAST (0b0010 = 2)，表示"最后一包"，不带 sequence，payload size=0
    const header = this.buildHeader(AUDIO_ONLY_REQUEST, FLAG_NEG_LAST, 0, 0);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(0, 0);
    // 帧结构：header(4) + payload_size(4)，没有 seqBuf、没有 payload
    this.ws.send(Buffer.concat([header, size]));
  }
  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
  }

  // --- 内部 ---

  private sendFullClientRequest() {
    if (!this.ws) return;
    const req = {
      user: { uid: this.opts.uid || "bearbobo" },
      audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
      request: {
        model_name: "bigmodel",
        enable_itn: this.opts.enableITN ?? true,
        enable_punc: this.opts.enablePunc ?? true,
        enable_ddc: this.opts.enableDDC ?? false,
        show_utterances: this.opts.showUtterances ?? true,
        result_type: this.opts.resultType || "full",
        enable_nonstream: this.opts.enableNonstream ?? false,
        enable_speaker_info: this.opts.enableSpeaker ?? false,
        ssd_version: this.opts.enableSpeaker ? "200" : undefined,
        end_window_size: this.opts.endWindowSize ?? 800,
      },
    };
    const jsonStr = JSON.stringify(req);
    const payload = zlib.gzipSync(Buffer.from(jsonStr, "utf-8"));
    const header = this.buildHeader(
      FULL_CLIENT_REQUEST,
      FLAG_NONE,
      SER_JSON,
      COMPRESS_GZIP,
    );
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length, 0);
    this.ws.send(Buffer.concat([header, size, payload]));
  }

  private buildHeader(
    msgType: number,
    flags: number,
    ser: number,
    compress: number,
  ): Buffer {
    // byte0: version(4)=1 | header_size(4)=1 (1*4=4 bytes)
    // byte1: msg_type(4) | flags(4)
    // byte2: ser(4) | compress(4)
    // byte3: reserved=0
    const b = Buffer.alloc(4);
    b[0] = (0b0001 << 4) | 0b0001;
    b[1] = ((msgType & 0xf) << 4) | (flags & 0xf);
    b[2] = ((ser & 0xf) << 4) | (compress & 0xf);
    b[3] = 0x00;
    return b;
  }

  private handleServerMessage(buf: Buffer) {
    try {
      if (buf.length < 4) return;
      const msgType = (buf[1] >> 4) & 0xf;
      const flags = buf[1] & 0xf;
      const ser = (buf[2] >> 4) & 0xf;
      const compress = buf[2] & 0xf;
      const headerSizeNibble = buf[0] & 0x0f;
      const headerBytes = headerSizeNibble * 4;

      if (msgType === SERVER_ERROR_RESPONSE) {
        // 先按"有 sequence"试，不行再退到"无 sequence"
        const readError = (off: number) => {
          if (buf.length < off + 8) return null;
          const code = buf.readUInt32BE(off);
          const size = buf.readUInt32BE(off + 4);
          if (buf.length < off + 8 + size) return null;
          let msgBuf = buf.slice(off + 8, off + 8 + size);
          try {
            if (compress === COMPRESS_GZIP) msgBuf = zlib.gunzipSync(msgBuf);
          } catch {}
          return { code, msg: msgBuf.toString("utf-8") };
        };

        let err = readError(headerBytes + 4); // 先假设有 sequence
        if (!err) err = readError(headerBytes);
        if (!err) return;

        this.emit(
          "error",
          new Error(`ASR server error code=${err.code}: ${err.msg}`),
        );
        return;
      }

      if (msgType !== FULL_SERVER_RESPONSE) return;

      // ------- 正常响应帧：0b1001 -------
      // 服务端响应帧结构：header(h 字节) | [sequence(4)?] | payload_size(4) | payload
      // 文档里 flags 取值：
      //   0b0000 / 0b0010  → 无 sequence
      //   0b0001 / 0b0011  → 有 4 字节 sequence
      // 实测中服务端下发帧的 flags 不一定严格是上面这几个值（会带其他标志位），
      // 所以这里用"先假设无 sequence，若 gunzip+JSON 失败再试有 sequence"的方式探测。
      function tryParse(fromOffset: number): { payload: Buffer; ok: boolean } {
        if (buf.length < fromOffset + 4)
          return { payload: Buffer.alloc(0), ok: false };
        const size = buf.readUInt32BE(fromOffset);
        fromOffset += 4;
        if (size === 0 || buf.length < fromOffset + size)
          return { payload: Buffer.alloc(0), ok: false };
        let p = buf.slice(fromOffset, fromOffset + size);
        if (compress === COMPRESS_GZIP) {
          try {
            p = zlib.gunzipSync(p);
          } catch {
            return { payload: p, ok: false };
          }
        }
        try {
          const m = JSON.parse(p.toString("utf-8"));
          return { payload: p, ok: true };
        } catch {
          return { payload: p, ok: false };
        }
      }

      let parsed: { msg: any; payload: Buffer } | null = null;

      // 先试"有 sequence"（这是最常见的情况：服务端响应几乎都带 sequence）
      let payloadOffset = headerBytes + 4; // 跳过 4 字节 sequence
      let r = tryParse(payloadOffset);
      if (r.ok) {
        parsed = {
          msg: JSON.parse(r.payload.toString("utf-8")),
          payload: r.payload,
        };
      } else {
        // 再试"无 sequence"
        payloadOffset = headerBytes;
        r = tryParse(payloadOffset);
        if (r.ok) {
          parsed = {
            msg: JSON.parse(r.payload.toString("utf-8")),
            payload: r.payload,
          };
        }
      }

      if (!parsed) {
        // 两种 offset 都解析不了，打印原始字节方便定位
        console.warn(
          "[ASR] unable to parse payload, buf hex:",
          buf.slice(0, 64).toString("hex"),
        );
        return;
      }

      const msg = parsed.msg;
      if (!msg.result) return;
      // msg.result.text 是当前累积文本；utterances[i].definite=true 表示该分句已最终确认
      const text = msg?.result?.text ?? "";
      const utterances: any[] = msg?.result?.utterances ?? [];
      const finals = utterances.filter((u) => u.definite);
      const lastFiniteText = finals.length
        ? finals[finals.length - 1].text
        : "";

      if (finals.length) this.emit("final", finals[finals.length - 1], msg);
      this.emit("partial", text, msg);
      this.emit("text", text, lastFiniteText, msg);
    } catch (e) {
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
    }
  }
}
