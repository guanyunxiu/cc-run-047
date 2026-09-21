import type { Frame } from '@blockeditor/proto';

export type TransportStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'error';

export type TransportKind = 'websocket' | 'longpoll';

export interface TransportOptions {
  docId: string;
  token: string | null;
  /** 客户端 awareness clientID。 */
  clientId: number;
  /** WebSocket 基址，如 ws://host:3000/collab/ws；长轮询形如 http://host:3000/api。 */
  url: string;
}

export interface Transport {
  readonly kind: TransportKind;
  readonly status: TransportStatus;
  /** 收到一批帧（物理消息中可含多帧）。 */
  onMessage: ((frames: Frame[]) => void) | null;
  onStatus: ((status: TransportStatus, detail?: string) => void) | null;
  connect(): void;
  disconnect(): void;
  send(frames: Frame[]): void;
  /**
   * 首轮 y-protocols 同步（step1/step2）已完成。
   * 在此之前传输层不得中断正在进行的请求 —— 服务端只在逻辑会话
   * 首次接入时把欢迎帧（step1）放入这一次响应，掐掉就再也收不到。
   */
  markInitialSynced?(): void;
}
