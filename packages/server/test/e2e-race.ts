// 严格竞态：两个长轮询客户端"同时"打开同一篇空文档，都在首轮同步后
// 立刻 ensureSeedParagraph，最终服务端与两端都必须只收敛为同一个起始段。
import * as Y from 'yjs';
import { BlockDoc, LOCAL_ORIGIN, SEED_BLOCK_ID } from '@blockeditor/core';
import {
  FrameKind,
  createSyncStep1Payload,
  encodeSyncUpdatePayload,
  packFrames,
  processSyncPayload,
  unpackFrames,
  type Frame,
} from '@blockeditor/proto';

const BASE = 'http://localhost:5191/api';
const POLL = 'http://localhost:5191/api/collab/poll';
let authToken: string | null = null;

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    body: JSON.stringify(body),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class PollClient {
  readonly blockDoc: BlockDoc;
  private readonly doc: Y.Doc;
  private outbound: Frame[] = [];
  private stopped = false;
  private polling = false;
  private currentController: AbortController | null = null;
  synced = false;
  private clientId: number;
  private handshakeSent = false;

  constructor(private token: string, private docId: string, name: string) {
    this.doc = new Y.Doc();
    this.clientId = Math.floor(Math.random() * 1e9) + 1;
    this.blockDoc = new BlockDoc(this.doc, { userId: name });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_ORIGIN || origin === this.blockDoc.undoManager) {
        this.send([{ kind: FrameKind.SyncUpdate, docId, clientId: this.clientId, payload: encodeSyncUpdatePayload(update), ref: `${this.clientId}:${Math.random()}` }]);
      }
    });
  }

  start(): void { void this.loop(); }
  stop(): void { this.stopped = true; this.currentController?.abort(); }
  send(frames: Frame[]): void {
    this.outbound.push(...frames);
    if (!this.stopped) { if (!this.polling) void this.loop(); else this.currentController?.abort(); }
  }
  private async loop(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    while (!this.stopped) {
      const frames = this.outbound;
      this.outbound = [];
      if (!this.handshakeSent) {
        this.handshakeSent = true;
        frames.unshift(
          { kind: FrameKind.Auth, docId: this.docId, clientId: this.clientId, payload: new TextEncoder().encode(this.token) },
          { kind: FrameKind.SyncStep1, docId: this.docId, clientId: this.clientId, payload: createSyncStep1Payload(this.doc) },
        );
      }
      const controller = new AbortController();
      this.currentController = controller;
      const timer = setTimeout(() => controller.abort(), 30_000);
      let bytes: Uint8Array;
      try {
        const res = await fetch(`${POLL}/${encodeURIComponent(this.docId)}?clientId=${this.clientId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-protobuf', Authorization: `Bearer ${this.token}` },
          body: packFrames(frames).buffer as ArrayBuffer,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`poll ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch {
        clearTimeout(timer);
        if (!this.stopped && controller.signal.aborted) continue;
        await sleep(500);
        continue;
      }
      for (const frame of unpackFrames(bytes)) this.handle(frame);
    }
    this.polling = false;
  }
  private handle(frame: Frame): void {
    if (frame.kind === FrameKind.SyncStep1 || frame.kind === FrameKind.SyncStep2 || frame.kind === FrameKind.SyncUpdate) {
      const reply = processSyncPayload(frame.payload, this.doc, Symbol('remote'));
      if (reply && frame.kind === FrameKind.SyncStep1) {
        this.send([{ kind: FrameKind.SyncStep2, docId: this.docId, payload: reply, clientId: this.clientId }]);
      }
      if (frame.kind === FrameKind.SyncStep2 && !this.synced) {
        this.synced = true;
        // 严格竞态：同步完成后立即垫段（两端都会执行）
        if (this.blockDoc.length === 0) this.blockDoc.ensureSeedParagraph();
      }
    }
  }
}

async function main(): Promise<void> {
  const { token } = await postJson('/auth/dev-login', { name: `race_${Date.now() % 100000}` });
  authToken = token;
  const doc = await postJson('/docs', { title: '竞态空文档' });

  const a = new PollClient(token, doc.id, 'alice');
  const b = new PollClient(token, doc.id, 'bob');
  // 真正同时启动（不人为间隔）
  a.start(); b.start();
  await sleep(4000);

  const ok =
    a.synced && b.synced &&
    a.blockDoc.length === 1 && b.blockDoc.length === 1 &&
    a.blockDoc.getIds()[0] === SEED_BLOCK_ID &&
    b.blockDoc.getIds()[0] === SEED_BLOCK_ID &&
    JSON.stringify(a.blockDoc.getIds()) === JSON.stringify(b.blockDoc.getIds());

  a.stop(); b.stop();
  if (!ok) {
    console.error('✖ 竞态收敛失败', {
      aSynced: a.synced, bSynced: b.synced,
      aLen: a.blockDoc.length, bLen: b.blockDoc.length,
      aIds: a.blockDoc.getIds(), bIds: b.blockDoc.getIds(),
    });
    process.exit(1);
  }
  console.log('✔ 两人同时打开空文档，起始段只收敛为同一个确定性块');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
