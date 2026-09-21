import { FrameKind, packFrames, unpackFrames, type Frame } from '@blockeditor/proto';
import type { Transport, TransportOptions, TransportStatus } from './transport.js';

/** 需要即时送达、值得中断挂起 poll 立即续发的帧（打字 / 同步握手）。 */
function isUrgent(frame: Frame): boolean {
  return (
    frame.kind === FrameKind.SyncUpdate ||
    frame.kind === FrameKind.SyncStep1 ||
    frame.kind === FrameKind.SyncStep2 ||
    frame.kind === FrameKind.Auth
  );
}

/**
 * HTTP 长轮询降级传输。
 *
 * 交互模型：
 *  - 客户端持续挂一个 POST /api/collab/poll/<docId> 请求（二进制 body 为本端帧）；
 *  - 服务端阻塞至"有下行帧"或 25s 超时后返回（可能仅含 Pong）；
 *  - 客户端收到响应后立刻发起下一次 poll，形成等价于推送的通道；
 *  - 上行帧随每次 poll body 捎带，无额外连接，天然穿透严格代理。
 */
export class LongPollTransport implements Transport {
  readonly kind = 'longpoll' as const;
  status: TransportStatus = 'idle';
  onMessage: ((frames: Frame[]) => void) | null = null;
  onStatus: ((status: TransportStatus, detail?: string) => void) | null = null;

  private stopped = false;
  private polling = false;
  /** 当前挂起 poll 的中断器：有新上行帧时中断它，立即续发捎带帧。 */
  private currentController: AbortController | null = null;
  /** 等待下一次 poll 捎带上行的帧。 */
  private outbound: Frame[] = [];
  private readonly endpoint: string;
  private online = false;
  /**
   * 是否已收到首个 poll 响应。
   *
   * 服务端只在会话首次接入的那次响应里放入入房欢迎帧（sync step1），
   * 客户端握手 step1 的 step2 也追加在同一响应。首轮同步完成之前若为
   * 捎带新帧掐掉挂起请求，欢迎数据不会重发，页面将永远卡在同步中。
   * 因此首响应落地前一律不中断；之后才允许"内容帧即到即发"的优化。
   */
  private welcomed = false;

  constructor(private readonly options: TransportOptions) {
    // 服务端路由为 POST /api/collab/poll/:docId（文档 ID 在路径中），
    // options.url 是 HTTP 基址（开发态为空串，经 Vite /api 代理到后端）。
    const base = this.options.url.replace(/\/$/, '');
    this.endpoint = `${base}/api/collab/poll/${encodeURIComponent(this.options.docId)}`;
  }

  connect(): void {
    this.stopped = false;
    this.welcomed = false;
    this.setStatus('connecting');
    this.loop();
    // 断网恢复后立即补一次 poll，而不是等当前请求超时。
    window.addEventListener('online', this.kick);
  }

  private readonly kick = (): void => {
    if (this.stopped) return;
    if (!this.polling) {
      void this.loop();
    } else if (this.welcomed && this.outbound.some(isUrgent)) {
      // 当前 poll 正阻塞在服务端等待下行帧。内容帧（打字 / 格式 / 同步）
      // 需要即时到达：中断挂起请求并立刻续发捎带帧；awareness（光标）
      // 等低优先帧不中断，随下一次 poll 捎带，避免请求风暴。
      // 首个响应（含入房欢迎帧 + 首轮 step2）落地前不中断。
      this.currentController?.abort();
    }
  };

  disconnect(): void {
    this.stopped = true;
    window.removeEventListener('online', this.kick);
    this.currentController?.abort();
    this.setStatus('idle');
  }

  send(frames: Frame[]): void {
    this.outbound.push(...frames);
    this.kick();
  }

  private async loop(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    while (!this.stopped) {
      const frames = this.outbound;
      this.outbound = [];
      const controller = new AbortController();
      this.currentController = controller;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 30_000);
      let response: Response;
      try {
        response = await fetch(
          `${this.endpoint}?clientId=${this.options.clientId}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-protobuf',
              ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
            },
            body: packFrames(frames).buffer as ArrayBuffer,
            signal: controller.signal,
            credentials: 'include',
          },
        );
      } catch (err) {
        clearTimeout(timer);
        // 为捎带新上行帧而主动中断：立即续发，不算离线。
        if (!this.stopped && !timedOut && controller.signal.aborted) continue;
        if (!this.stopped) {
          this.online = false;
          this.setStatus('offline', err instanceof Error ? err.message : String(err));
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        continue;
      }
      clearTimeout(timer);
      if (!response.ok) {
        this.online = false;
        this.setStatus('offline', `长轮询 HTTP ${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      if (!this.online) {
        this.online = true;
        this.setStatus('online');
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (err) {
        // 响应头已返回后再 abort（仅可能发生在首轮之后的轮次）：本次响应
        // 未能读完，按主动中断处理，立即续发下一次 poll，绝不让异常逃逸
        // 杀死整个轮询循环（否则会永久卡在"同步中"）。
        if (!this.stopped && controller.signal.aborted) continue;
        if (!this.stopped) {
          this.online = false;
          this.setStatus('offline', err instanceof Error ? err.message : String(err));
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        continue;
      }
      // 首轮响应已落地：入房欢迎帧（server step1）+ 本端 step1 的 step2
      // 都在这批数据里，此后中断挂起 poll 才不会丢掉任何同步数据。
      this.welcomed = true;
      if (bytes.length) this.onMessage?.(unpackFrames(bytes));
      // 响应期间攒了内容帧：立即续发（循环内 kick 不会重入，直接 continue）；
      // 只有光标等低优先帧时保持挂起节奏，由当前 poll 捎带。
      if (this.outbound.some(isUrgent)) continue;
    }
    this.currentController = null;
    this.polling = false;
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    this.status = status;
    this.onStatus?.(status, detail);
  }
}
