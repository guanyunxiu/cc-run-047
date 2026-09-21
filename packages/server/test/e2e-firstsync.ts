// 回归：长轮询首轮同步必须收完。精确复刻 NetworkManager 时序 ——
// 握手帧（Auth + Step1）在传输层 onStatus('online') 回调里发出；
// 该回调在 loop 内 "fetch 已 resolve、arrayBuffer 尚未执行" 的窗口触发。
// 旧实现里出站 urgent 帧会在此时 abort 当前请求，打断首个响应的 body
// 读取，异常逃逸杀死整个 poll 循环，页面永久卡在同步中。
// @ts-nocheck
import { LongPollTransport } from '../../client/src/network/longpoll-transport.js';
import {
  FrameKind,
  createSyncStep1Payload,
  processSyncPayload,
  type Frame,
} from '@blockeditor/proto';
import * as Y from 'yjs';
import { REMOTE_ORIGIN } from '@blockeditor/core';

const BASE = 'http://localhost:5191/api';
let authToken: string | null = null;
async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
(globalThis as any).window = { addEventListener() {}, removeEventListener() {} };

async function main(): Promise<void> {
  const { token } = await postJson('/auth/dev-login', { name: `fs_${Date.now() % 100000}` });
  authToken = token;
  const doc = await postJson('/docs', { title: '首轮同步文档' });

  const ydoc = new Y.Doc();
  let gotStep1 = false;
  let gotStep2 = false;
  let onlineCount = 0;

  const transport = new LongPollTransport({
    docId: doc.id, token,
    clientId: Math.floor(Math.random() * 1e9) + 1,
    url: 'http://localhost:5191',
  });

  // 复刻 NetworkManager：上线回调里立刻握手（Auth + Step1）
  transport.onStatus = (status: string) => {
    if (status === 'online') {
      onlineCount++;
      transport.send([
        { kind: FrameKind.Auth, docId: doc.id, payload: new TextEncoder().encode(token) },
        { kind: FrameKind.SyncStep1, docId: doc.id, payload: createSyncStep1Payload(ydoc) },
      ]);
    }
  };
  transport.onMessage = (frames: Frame[]) => {
    for (const frame of frames) {
      const reply = processSyncPayload(frame.payload, ydoc, REMOTE_ORIGIN);
      if (frame.kind === FrameKind.SyncStep1) gotStep1 = true;
      if (frame.kind === FrameKind.SyncStep2) gotStep2 = true;
      if (reply && frame.kind === FrameKind.SyncStep1) {
        transport.send([{ kind: FrameKind.SyncStep2, docId: doc.id, payload: reply }]);
      }
    }
  };
  transport.connect();

  await sleep(2500);
  transport.disconnect();

  const ok = gotStep1 && gotStep2 && onlineCount >= 1;
  if (!ok) {
    console.error('✖ 首轮同步失败', { gotStep1, gotStep2, onlineCount });
    process.exit(1);
  }
  console.log('✔ onStatus 时序下发握手，首轮 step1/step2 均收到，poll 循环存活');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
