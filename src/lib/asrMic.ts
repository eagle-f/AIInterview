// 与 test 项目相同的链路：麦克风 PCM 16 kHz -> /api/asr WebSocket。
const VOICE_RMS_THRESHOLD = 0.02;

export class ASRMic {
  private ctx: AudioContext | null = null;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private ready = false;
  private capturing = false;
  private stopping = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastVoiceActivity = 0;

  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  onClosed?: () => void;
  onVoiceActivity?: () => void;

  async start(wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/asr`) {
    if (this.ws) return;
    this.stopping = false;
    this.ready = false;
    this.lastVoiceActivity = 0;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: { type?: string; text?: string; message?: string };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "asr_ready") {
        this.ready = true;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = null;
        if (this.capturing && !this.stopping) this.onReady?.();
      } else if (message.type === "asr_partial" && typeof message.text === "string") {
        this.onPartial?.(message.text);
      } else if (message.type === "asr_final" && typeof message.text === "string") {
        this.onFinal?.(message.text);
      } else if (message.type === "asr_error") {
        this.onError?.(message.message || "语音识别失败");
        this.cleanup();
      } else if (message.type === "asr_closed") {
        this.cleanup();
      }
    };
    ws.onclose = () => {
      const unexpected = !this.stopping;
      if (unexpected) this.onError?.("语音连接已断开");
      this.cleanup();
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const onClose = () => reject(new Error("语音连接已断开"));
        ws.addEventListener("close", onClose, { once: true });
        ws.onopen = () => {
          ws.removeEventListener("close", onClose);
          resolve();
        };
        ws.onerror = () => {
          ws.removeEventListener("close", onClose);
          reject(new Error("无法连接语音服务，请确认后端已启动"));
        };
      });
      ws.onerror = () => {
        this.onError?.("语音连接发生错误");
        this.cleanup();
      };
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("语音连接已断开");
      }
      this.stream = stream;

      this.ctx = new AudioContext();
      const sampleRate = this.ctx.sampleRate;
      await this.ctx.resume();
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
      const resample = createResampler(sampleRate, 16000);

      this.processor.onaudioprocess = (event) => {
        if (!this.ready || this.stopping || ws.readyState !== WebSocket.OPEN) return;
        const samples = event.inputBuffer.getChannelData(0);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const rms = Math.sqrt(energy / samples.length);
        const now = Date.now();
        if (rms >= VOICE_RMS_THRESHOLD && now - this.lastVoiceActivity >= 200) {
          this.lastVoiceActivity = now;
          this.onVoiceActivity?.();
        }
        ws.send(float32ToInt16PCM(resample(samples)));
      };
      this.source.connect(this.processor);
      this.processor.connect(this.ctx.destination);
      this.capturing = true;
      if (this.ready) {
        this.onReady?.();
      } else {
        this.readyTimer = setTimeout(() => {
          this.onError?.("语音服务连接超时");
          this.cleanup();
        }, 10000);
      }
    } catch (error) {
      if (this.ws === ws) this.cleanup();
      throw error;
    }
  }

  stop() {
    if (!this.ws || this.stopping) return;
    this.stopping = true;
    this.stopAudio();
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "stop" }));
      // 保留连接，等服务端下发最后一句；超时后释放资源。
      this.closeTimer = setTimeout(() => this.cleanup(), 8000);
    } else {
      this.cleanup();
    }
  }

  dispose() {
    this.cleanup();
  }

  private stopAudio() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.ctx?.close();
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.capturing = false;
  }

  private cleanup() {
    const hadSession = this.ws !== null || this.stream !== null;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.stopAudio();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.ready = false;
    if (hadSession) this.onClosed?.();
  }
}

function float32ToInt16PCM(input: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

// 沿用 test 的线性插值重采样。
function createResampler(fromRate: number, toRate: number) {
  return (input: Float32Array): Float32Array => {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const out = new Float32Array(Math.round(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio;
      const index = Math.floor(pos);
      const fraction = pos - index;
      const a = input[index] || 0;
      const b = input[index + 1] || a;
      out[i] = a + (b - a) * fraction;
    }
    return out;
  };
}
