import * as Y from 'yjs';
import { BlockNode, createYBlock, type YBlock } from './block-node.js';
import { BlockRegistry } from './registry.js';
import type {
  BlockAttributes,
  BlockChange,
  BlockChangeType,
  BlockMeta,
  CreateBlockOptions,
  DeltaItem,
  DocChangeEvent,
  DocChangeHandler,
  InlineAttributes,
} from './types.js';

/**
 * 事务 origin 约定 —— 渲染层、持久化层、撤销栈都依赖它区分变更来源：
 *  - LOCAL_ORIGIN：本机用户主动编辑（进入 UndoManager，可撤销）
 *  - REMOTE_ORIGIN：WebSocket / 长轮询拉取的远端更新（不可撤销）
 *  - UNDO_ORIGIN / REDO_ORIGIN：Yjs UndoManager 自动产生（在线离线共用同一栈）
 */
export const LOCAL_ORIGIN: unique symbol = Symbol('blockdoc:local');
export const REMOTE_ORIGIN: unique symbol = Symbol('blockdoc:remote');
export const UNDO_ORIGIN: unique symbol = Symbol('blockdoc:undo');
export const REDO_ORIGIN: unique symbol = Symbol('blockdoc:redo');
/**
 * 内核自身的"结构不变量维护"事务（目前仅用于清理 yOrder 中的重复块 ID）。
 * 属于本机产生的真实变更（必须同步给对端、需要落盘），但不进撤销栈：
 * 用户撤销自己的编辑时不应把收敛逻辑的删除也撤回去。
 */
export const MAINTENANCE_ORIGIN: unique symbol = Symbol('blockdoc:maintenance');
function generateBlockId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `blk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 按字符串偏移切分 Delta，返回 start 之后的片段（保留行内属性）。 */
export function sliceDeltaAfter(delta: DeltaItem[], start: number): DeltaItem[] {
  const out: DeltaItem[] = [];
  let offset = 0;
  for (const op of delta) {
    if (typeof op.insert === 'string') {
      const len = op.insert.length;
      if (offset + len > start) {
        out.push({
          insert: op.insert.slice(Math.max(0, start - offset)),
          ...(op.attributes ? { attributes: op.attributes } : {}),
        });
      }
      offset += len;
    }
  }
  return out;
}

export interface BlockDocOptions {
  /** 复用已有全局注册表；默认创建含四类内置块的注册表。 */
  registry?: BlockRegistry;
  /** 当前用户 ID，写入新块的 createdBy。 */
  userId?: string | null;
  /** Yjs 文档在顶层使用的命名空间（默认 'blockdoc'）。 */
  rootKey?: string;
}

/**
 * BlockDoc —— 块文档模型内核。
 *
 * 所有块的新增 / 删除 / 修改 / 移动都封装为带 LOCAL_ORIGIN 的 Yjs 事务；
 * 远端更新以 REMOTE_ORIGIN applyUpdate 进入同一棵 CRDT 树，
 * 冲突合并由 Yjs 自动完成（无锁、无中心裁决）。
 */
export class BlockDoc {
  readonly doc: Y.Doc;
  readonly registry: BlockRegistry;
  /** 撤销/重做管理器：其 undo()/redo() 产生的事务 origin 就是该实例。 */
  readonly undoManager: Y.UndoManager;
  userId: string | null;

  private readonly yBlocks: Y.Map<YBlock>;
  private readonly yOrder: Y.Array<string>;
  /** YBlock -> blockId，用于在深度 observe 事件中反查块 ID。 */
  private readonly blockToId = new WeakMap<YBlock, string>();

  private readonly handlers = new Set<DocChangeHandler>();
  /** 一次事务内累积的归一化变更，afterTransaction 时统一派发。 */
  private pending = new Map<string, BlockChangeType>();
  private transactionOrigin: unknown = null;

  constructor(doc: Y.Doc, options: BlockDocOptions = {}) {
    this.doc = doc;
    this.registry = options.registry ?? BlockRegistry.createDefault();
    this.userId = options.userId ?? null;
    const rootKey = options.rootKey ?? 'blockdoc';

    this.yBlocks = doc.getMap<YBlock>(`${rootKey}:blocks`);
    this.yOrder = doc.getArray<string>(`${rootKey}:order`);

    // 恢复已有映射（IndexedDB 重新加载 / 服务端房间持久化场景）。
    for (const [id, yBlock] of this.yBlocks) this.blockToId.set(yBlock, id);

    this.yBlocks.observeDeep((events) => this.collectBlockEvents(events));
    this.yOrder.observe((event) => this.collectOrderEvents(event));
    this.doc.on('afterTransaction', (transaction) => this.flush(transaction));
    // 结构不变量：yOrder 中同一 blockId 至多出现一次。
    // 两人几乎同时打开同一篇空文档、各自插入"文档级起始段落"时，
    // CRDT 合并后 yOrder 会出现两个相同 ID；这里在每次事务后做
    // 确定性归一化（保留第一个，删除其余），两端独立算出的结果
    // 完全一致并相互传播，最终收敛为一段。
    this.doc.on('afterTransaction', (transaction) => {
      if (transaction.origin === MAINTENANCE_ORIGIN) return;
      // transaction.changed 是 Map<AbstractType, Set<string|null>>；
      // yjs 泛型声明在 YMap 与 AbstractType 之间有逆变噪音，按 unknown 键判定。
      const changed = transaction.changed as Map<unknown, unknown>;
      if (!changed.has(this.yBlocks) && !changed.has(this.yOrder)) return;
      this.normalizeDuplicateOrder();
    });

    // 统一撤销重做栈：仅追踪本地事务；远端合并不进栈，
    // 因此在线 / 离线状态下行为完全一致（"在线离线通用栈"）。
    // captureTimeout=0：每个 transactLocal 是独立撤销单元
    // （createBlock / splitBlock 等内部虽为一个事务，但与其他操作不合并）。
    this.undoManager = new Y.UndoManager([this.yBlocks, this.yOrder], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 0,
    });
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  get length(): number {
    return this.yOrder.length;
  }

  getIds(): string[] {
    return this.yOrder.toArray();
  }

  getBlock(id: string): BlockNode | null {
    const yBlock = this.yBlocks.get(id);
    return yBlock ? new BlockNode(yBlock) : null;
  }

  getBlockAt(index: number): BlockNode | null {
    const id = this.yOrder.get(index);
    return id ? this.getBlock(id) : null;
  }

  indexOf(id: string): number {
    return this.yOrder.toArray().indexOf(id);
  }

  getMetaList(): BlockMeta[] {
    return this.getIds()
      .map((id) => this.getBlock(id)?.getMeta())
      .filter((m): m is BlockMeta => m !== null && m !== undefined);
  }

  // -------------------------------------------------------------------------
  // 变更订阅（渲染引擎的唯一数据源）
  // -------------------------------------------------------------------------

  on(handler: DocChangeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private mark(id: string, type: BlockChangeType): void {
    const priority: Record<BlockChangeType, number> = { delete: 4, add: 3, move: 2, update: 1 };
    const current = this.pending.get(id);
    if (!current || priority[type] > priority[current]) this.pending.set(id, type);
  }

  private collectBlockEvents(events: Y.YEvent<Y.AbstractType<unknown>>[]): void {
    for (const event of events) {
      if (event.target === this.yBlocks) {
        // 根 Map：块新增 / 删除。
        event.changes.keys.forEach((change, id) => {
          if (change.action === 'delete') {
            this.mark(id, 'delete');
          } else if (change.action === 'add') {
            const yBlock = this.yBlocks.get(id);
            if (yBlock) this.blockToId.set(yBlock, id);
            this.mark(id, 'add');
          } else {
            this.mark(id, 'update');
          }
        });
        continue;
      }
      // 嵌套事件：path[0] 是 yBlocks 中的块 ID。
      const id = event.path[0];
      if (typeof id === 'string' && this.yBlocks.has(id)) this.mark(id, 'update');
    }
  }

  private collectOrderEvents(event: Y.YArrayEvent<string>): void {
    for (const item of event.delta) {
      const inserted = Array.isArray(item.insert) ? (item.insert as string[]) : [];
      const deleted = typeof item.delete === 'number' ? item.delete : 0;
      void deleted;
      // insert/delete 的具体 ID 已被块事件归一化为 add/delete；
      // 仍存活的块若顺序变化则标记 move（moveBlock 的删除+插入落在同一事务）。
      for (const id of inserted) {
        if (this.yBlocks.has(id) && this.pending.get(id) !== 'add') this.mark(id, 'move');
      }
    }
  }

  private flush(transaction: Y.Transaction): void {
    if (this.pending.size === 0) return;
    const changes: BlockChange[] = Array.from(this.pending, ([id, type]) => ({ id, type }));
    this.pending = new Map();
    const local = transaction.origin === LOCAL_ORIGIN;
    const event: DocChangeEvent = {
      changes,
      transaction,
      local,
      origin: transaction.origin,
    };
    for (const handler of [...this.handlers]) handler(event);
  }

  /**
   * yOrder 去重归一化：保留每个 blockId 的第一次出现，删除其余位置。
   *
   * 两人几乎同时打开同一篇空文档、各自插入"文档级起始段落"时，两端使用
   * 同一个文档绑定块 ID，CRDT 合并后 yOrder 会出现两个相同 ID。这里在
   * 每次相关事务后做确定性归一化（保留第一个、删除其余），两端独立算出
   * 的结果完全一致并相互传播，最终收敛为一段。
   *
   * 不能在 afterTransaction 回调内直接开新事务（Yjs 禁止事务重入），
   * 用微任务延迟到当前提交收尾后执行；维护事务自身触发的事件会照常
   * 经 collectOrderEvents 派发给渲染层。
   */
  private normalizeScheduled = false;

  private normalizeDuplicateOrder(): void {
    if (this.normalizeScheduled) return;
    if (!this.hasDuplicateOrderId()) return;
    this.normalizeScheduled = true;
    queueMicrotask(() => {
      this.normalizeScheduled = false;
      // 微任务执行前可能又被远端更新改变，重新计算一次；从后往前删，
      // 一次事务完成。
      const current = this.yOrder.toArray();
      const seen = new Set<string>();
      const toDelete: number[] = [];
      for (let i = 0; i < current.length; i++) {
        if (seen.has(current[i])) toDelete.push(i);
        else seen.add(current[i]);
      }
      if (toDelete.length === 0) return;
      this.doc.transact(
        () => {
          for (let k = toDelete.length - 1; k >= 0; k--) {
            this.yOrder.delete(toDelete[k], 1);
          }
        },
        MAINTENANCE_ORIGIN,
      );
    });
  }

  private hasDuplicateOrderId(): boolean {
    const ids = this.yOrder.toArray();
    return new Set(ids).size !== ids.length;
  }

  // -------------------------------------------------------------------------
  // 事务封装：所有写操作唯一入口
  // -------------------------------------------------------------------------

  /**
   * 在一个本地 Yjs 事务中执行块操作。
   * 同一事务内多次块修改只产生一个二进制增量、一条撤销记录、一次渲染调度。
   */
  transactLocal<T>(fn: () => T): T {
    let result: T;
    this.doc.transact(() => {
      result = fn();
    }, LOCAL_ORIGIN);
    return result!;
  }

  /** 供网络层使用：以远端 origin 应用更新（不进撤销栈）。 */
  applyRemoteUpdate(update: Uint8Array): void {
    this.doc.transact(() => {
      Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
    }, REMOTE_ORIGIN);
  }

  // -------------------------------------------------------------------------
  // 块 CRUD + 移动
  // -------------------------------------------------------------------------

  createBlock(options: CreateBlockOptions): string {
    const type = this.registry.resolveType(options.type);
    const id = options.id ?? generateBlockId();
    if (this.yBlocks.has(id)) throw new Error(`块 ID ${id} 已存在`);
    const now = Date.now();
    const attrs: BlockAttributes = {
      ...this.registry.defaultAttrs(type),
      ...(options.attrs ?? {}),
    };

    this.transactLocal(() => {
      const yBlock = createYBlock({
        id,
        type,
        now,
        createdBy: this.userId,
        parentId: options.parentId ?? null,
        attrs,
      });
      this.yBlocks.set(id, yBlock);
      const index = options.index ?? this.yOrder.length;
      this.yOrder.insert(Math.max(0, Math.min(index, this.yOrder.length)), [id]);
      if (options.content) new BlockNode(yBlock).applyDelta(options.content);
    });
    return id;
  }

  deleteBlock(id: string): void {
    this.transactLocal(() => {
      if (!this.yBlocks.has(id)) return;
      // 删除该块在 order 中的全部位置（正常情况只有一个；并发插入
      // 文档级起始段落、去重尚未跑完时可能短暂存在重复）。
      let index = this.yOrder.toArray().indexOf(id);
      while (index >= 0) {
        this.yOrder.delete(index, 1);
        index = this.yOrder.toArray().indexOf(id);
      }
      this.yBlocks.delete(id);
    });
  }

  /** 移动块到新位置（toIndex 基于"先移除后插入"语义，直观对应拖拽落点）。 */
  moveBlock(id: string, toIndex: number): void {
    this.transactLocal(() => {
      const order = this.yOrder.toArray();
      const from = order.indexOf(id);
      if (from < 0) return;
      this.yOrder.delete(from, 1);
      const clamped = Math.max(0, Math.min(toIndex, this.yOrder.length));
      this.yOrder.insert(clamped, [id]);
    });
  }

  setBlockType(id: string, type: string, attrs?: BlockAttributes): void {
    this.transactLocal(() => {
      const node = this.getBlock(id);
      if (!node) return;
      node.setType(this.registry.resolveType(type));
      if (attrs) node.setAttrs(attrs);
    });
  }

  setBlockAttrs(id: string, attrs: BlockAttributes): void {
    this.transactLocal(() => this.getBlock(id)?.setAttrs(attrs));
  }

  setBlockAttr(id: string, key: string, value: unknown): void {
    this.transactLocal(() => this.getBlock(id)?.setAttr(key, value));
  }

  // -------------------------------------------------------------------------
  // 行内文本编辑（全部走 Yjs XmlText 事务）
  // -------------------------------------------------------------------------

  insertText(id: string, index: number, text: string, attributes?: InlineAttributes): void {
    this.transactLocal(() => this.getBlock(id)?.insertText(index, text, attributes));
  }

  /** 先删后插（IME 选词提交使用）：同一事务、同一撤销单元。 */
  replaceText(
    id: string,
    index: number,
    deleteLength: number,
    text: string,
    attributes?: InlineAttributes,
  ): void {
    this.transactLocal(() => {
      const node = this.getBlock(id);
      if (!node) return;
      if (deleteLength > 0) node.deleteText(index, deleteLength);
      if (text.length > 0) node.insertText(index, text, attributes);
    });
  }

  deleteText(id: string, index: number, length: number): void {
    this.transactLocal(() => this.getBlock(id)?.deleteText(index, length));
  }

  formatText(id: string, index: number, length: number, attributes: InlineAttributes): void {
    this.transactLocal(() => this.getBlock(id)?.formatText(index, length, attributes));
  }

  /**
   * 在块内 caretIndex 处拆分块。
   * 标题拆出的新块降级为段落；其余类型继承自身类型与属性。
   * 行内格式随文本切片保留。
   */
  splitBlock(id: string, caretIndex: number): { newId: string; caret: { blockId: string; index: number } } {
    const newId = generateBlockId();
    this.transactLocal(() => {
      const node = this.getBlock(id);
      if (!node) return;
      const tailDelta = sliceDeltaAfter(node.getDelta(), caretIndex);
      node.deleteText(caretIndex, Math.max(0, node.text.length - caretIndex));

      const nextType = node.type === 'heading' ? 'paragraph' : node.type;
      const yBlock = createYBlock({
        id: newId,
        type: this.registry.resolveType(nextType),
        now: Date.now(),
        createdBy: this.userId,
        attrs: { ...node.getAttrs() },
      });
      const insertIndex = this.yOrder.toArray().indexOf(id) + 1;
      this.yBlocks.set(newId, yBlock);
      this.yOrder.insert(insertIndex, [newId]);
      if (tailDelta.length) new BlockNode(yBlock).applyDelta(tailDelta);
    });
    return { newId, caret: { blockId: newId, index: 0 } };
  }

  /** 将块合并到上一块末尾（Backspace 于块首时触发）。 */
  mergeWithPrevious(id: string): { targetId: string; caretIndex: number } | null {
    const currentIndex = this.yOrder.toArray().indexOf(id);
    if (currentIndex <= 0) return null;
    const targetId = this.yOrder.get(currentIndex - 1);

    this.transactLocal(() => {
      const target = this.getBlock(targetId);
      const current = this.getBlock(id);
      if (!target || !current) return;
      const caretIndex = target.text.length;
      for (const op of current.getDelta()) {
        if (typeof op.insert === 'string') {
          target.insertText(target.text.length, op.insert, op.attributes);
        }
      }
      const index = this.yOrder.toArray().indexOf(id);
      this.yOrder.delete(index, 1);
      this.yBlocks.delete(id);
      void caretIndex;
    });
    return { targetId, caretIndex: this.getBlock(targetId)?.text.length ?? 0 };
  }

  // -------------------------------------------------------------------------
  // 统一撤销 / 重做（在线离线共用）
  // -------------------------------------------------------------------------

  undo(): void {
    this.undoManager.undo();
  }

  redo(): void {
    this.undoManager.redo();
  }

  canUndo(): boolean {
    return this.undoManager.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.undoManager.redoStack.length > 0;
  }

  /** 导出全量状态（首帧同步 / 调试使用）。 */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }
}
