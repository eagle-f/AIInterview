// server/asrHandler.ts
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { BigmodelASRSession } from "./asr";

const ASR_RES_ID = "volc.seedasr.sauc.duration"; // 豆包流式 ASR 2.0 小时版

export function attachASRWebSocket(wss: WebSocketServer) {
  wss.on("connection", (clientWs: WebSocket, req: IncomingMessage) => {
    // dotenv 在 server.ts 初始化；连接时读取才能拿到 .env.local 中的密钥。
    const ASR_API_KEY = process.env.STT_API_KEY;
    // 这里可以加你自己的鉴权（cookie/session/token），和 ling 系统的鉴权保持一致
    if (!ASR_API_KEY) {
      clientWs.send(
        JSON.stringify({
          type: "asr_error",
          message: "后端未配置 STT_API_KEY，请在 backend/.env 中补充后重启",
        }),
      );
      clientWs.close();
      return;
    }

    const session = new BigmodelASRSession({
      apiKey: ASR_API_KEY,
      resourceId: ASR_RES_ID,
      enablePunc: true,
      enableITN: true,
      enableDDC: true, // 对话场景建议开，去"嗯/啊/那个"
      showUtterances: true,
      enableNonstream: false, // 要出 definite 最终句就开 true，首字延迟略大
      endWindowSize: 700,
    });

    let historyFinal = ""; // 已经 final 过的句子，避免 partial 重复下发
    const seenUtterances = new Set<string>(); // 记录已发过 final 的分句结束时间

    session.on("open", () => {
      clientWs.send(JSON.stringify({ type: "asr_ready" }));
    });
    session.on("text", (fullText: string, lastFinal: string) => {
      if (!fullText) return;
      if (clientWs.readyState !== WebSocket.OPEN) return;
      // partial = fullText 去掉历史 final 部分
      const partial = historyFinal
        ? fullText.slice(historyFinal.length)
        : fullText;
      const trimmed = partial.trimStart();
      if (!trimmed) return;
      clientWs.send(
        JSON.stringify({
          type: "asr_partial",
          text: partial.trimStart(),
          full: fullText,
        }),
      );
    });
    session.on(
      "final",
      (u: { text: string; start_time: number; end_time: number }) => {
        const text: string = (u.text || "").trim();
        if (!text) return;
        const endTime = typeof u.end_time === "number" ? u.end_time : -1;
        const key = `${endTime}::${text}`;
        if (seenUtterances.has(key)) return; // 同一个分句重复下发，跳过
        seenUtterances.add(key);
        // console.log("[final]", u.start_time, "->", u.end_time, u.text);
        historyFinal += u.text;
        if (clientWs.readyState !== WebSocket.OPEN) return;
        clientWs.send(
          JSON.stringify({
            type: "asr_final",
            text: u.text,
          }),
        );
        // ⬇️ 对话核心：拿到 final 句子 → 调 LLM → 调你已有的 TTS → 推给前端播放
        // handleUserUtterance(u.text).catch(console.error);
      },
    );

    session.on("error", (err: any) => {
      // err 可能不是 Error 对象，可能是 Buffer/string
      let message = "unknown error";
      if (err instanceof Error) message = err.message;
      else if (typeof err === "string") message = err;
      else if (Buffer.isBuffer(err)) message = `binary error(${err.length}B)`;
      else message = JSON.stringify(err);
      if (!message) {
        message = err?.code === "EACCES"
          ? "无法访问语音识别服务，请检查网络权限"
          : "语音识别服务连接失败";
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "asr_error", message }));
      }
    });
    session.on("close", () => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "asr_closed" }));
        clientWs.close(); // 这才是真正关前端 ws 的时机
      }
    });

    clientWs.on("message", (data: Buffer, isBinary) => {
      // 浏览器推上来的必须是 16k/16bit/mono PCM（二进制帧）
      if (isBinary) {
        session.pushAudio(data);
      } else {
        // JSON 控制指令
        try {
          const msg = JSON.parse(data.toString("utf-8"));
          if (msg.type === "stop") session.finish();
        } catch {}
      }
    });
    clientWs.on("close", () => session.close());

    session.connect().catch((err: Error) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({ type: "asr_error", message: err.message }),
        );
        clientWs.close();
      }
    });
  });
}
