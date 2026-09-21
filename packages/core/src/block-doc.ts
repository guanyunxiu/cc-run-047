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
 * 起始空段落的确定性 ID —— 对同一篇文档的所有客户端都相同。
 *
 * 必须是 CRDT 结构本身能收敛的值（不能用随机 UUID）：两人几乎同时打开
 * 空文档时，两端都会执行 ensureSeedParagraph，同 ID 的块经 Y.Map 键收敛
 * 为同一个块，最终只剩一段。它是"虚拟首块"：存在性由 seed 单槽 Y.Map
 * 承载（同键 put 幂等），块自身不进 order Y.Array（数组同值插入无法
 * 去重），语义上永远位于文档开头。
 */
export const SEED_BLOCK_ID = 'blockdoc:seed-paragraph';
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
  /**
   * 起始段落单槽：key 固定为 {@link SEED_BLOCK_ID}。
   * 多端同时 put 同一键时 Y.Map 只保留一个条目（CRDT 收敛），
   * 这是"同时打开也只有一段"的关键，order Y.Array 无法表达这种去重。
   */
  private readonly ySeed: Y.Map<boolean>;
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
    this.ySeed = doc.getMap<boolean>(`${rootKey}:seed`);

    // 恢复已有映射（IndexedDB 重新加载 / 服务端房间持久化场景）。
    for (const [id, yBlock] of this.yBlocks) this.blockToId.set(yBlock, id);

    this.yBlocks.observeDeep((events) => this.collectBlockEvents(events));
    this.ySeed.observe((event) => this.collectBlockEvents([event]));
    this.yOrder.observe((event) => this.collectOrderEvents(event));
    this.doc.on('afterTransaction', (transaction) => this.flush(transaction));

    // 统一撤销重做栈：仅追踪本地事务；远端合并不进栈，
    // 因此在线 / 离线状态下行为完全一致（"在线离线通用栈"）。
    // captureTimeout=0：每个 transactLocal 是独立撤销单元
    // （createBlock / splitBlock 等内部虽为一个事务，但与其他操作不合并）。
    // 起始段落（ySeed）是会话自动垫出的、不是用户编辑，不进撤销栈。
    this.undoManager = new Y.UndoManager([this.yBlocks, this.yOrder], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 0,
    });
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /** 起始段落是否仍是文档当前的虚拟首块（块与单槽都在）。 */
  private get seedActive(): boolean {
    return this.ySeed.has(SEED_BLOCK_ID) && this.yBlocks.has(SEED_BLOCK_ID);
  }

  /** order 中的块 ID 序列（不含虚拟起始段）。 */
  private orderedIds(): string[] {
    return this.yOrder.toArray().filter((id) => this.yBlocks.has(id));
  }

  get length(): number {
    return this.yOrder.length + (this.seedActive ? 1 : 0);
  }

  getIds(): string[] {
    // 虚拟起始段永远语义置顶；order 只承载用户 / 客户端显式创建的块。
    return this.seedActive ? [SEED_BLOCK_ID, ...this.orderedIds()] : this.orderedIds();
  }

  getBlock(id: string): BlockNode | null {
    const yBlock = this.yBlocks.get(id);
    return yBlock ? new BlockNode(yBlock) : null;
  }

  getBlockAt(index: number): BlockNode | null {
    const id = this.getIds()[index];
    return id ? this.getBlock(id) : null;
  }

  indexOf(id: string): number {
    return this.getIds().indexOf(id);
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

  private collectBlockEvents(events: Y.YEvent<any>[]): void {
    for (const event of events) {
      if (event.target === this.ySeed) {
        // 起始段槽位获得 -> 虚拟首块新增（与块本身的 add 事件经 mark 归一）。
        // 槽位移除（转为普通块 / 删除）由 yOrder / yBlocks 事件表达。
        event.changes.keys.forEach((_change, id) => {
          if (id === SEED_BLOCK_ID && this.seedActive) this.mark(id, 'add');
        });
        continue;
      }
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

  /**
   * 确保起始空段落存在（幂等、可多端并发调用）。
   *
   * 返回起始段的块 ID。两端同时打开同一篇空文档时：两端各执行一次，
   * yBlocks 同 ID 与 ySeed 同键在 CRDT 层各自收敛为一个，
   * getIds() 因而只含一段 —— 后打开的人看到的就是先打开者那一段。
   */
  ensureSeedParagraph(): string {
    if (this.seedActive) return SEED_BLOCK_ID;
    this.transactLocal(() => {
      if (!this.yBlocks.has(SEED_BLOCK_ID)) {
        const yBlock = createYBlock({
          id: SEED_BLOCK_ID,
          type: this.registry.resolveType('paragraph'),
          now: Date.now(),
          createdBy: this.userId,
          parentId: null,
          attrs: this.registry.defaultAttrs('paragraph'),
        });
        this.yBlocks.set(SEED_BLOCK_ID, yBlock);
      }
      this.ySeed.set(SEED_BLOCK_ID, true);
    });
    return SEED_BLOCK_ID;
  }

  /** 删除起始段标记（块仍保留时转为普通块并入 order 头部）。 */
  private unseedInPlace(): void {
    if (this.seedActive && !this.yOrder.toArray().includes(SEED_BLOCK_ID)) {
      this.yOrder.insert(0, [SEED_BLOCK_ID]);
    }
    this.ySeed.delete(SEED_BLOCK_ID);
  }

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
      // 概念索引（含虚拟起始段）-> order 数组内索引。
      let index = options.index ?? this.length;
      index = Math.max(0, Math.min(index, this.length));
      if (this.seedActive) index -= 1;
      index = Math.max(0, Math.min(index, this.yOrder.length));
      this.yOrder.insert(index, [id]);
      if (options.content) new BlockNode(yBlock).applyDelta(options.content);
    });
    return id;
  }

  deleteBlock(id: string): void {
    this.transactLocal(() => {
      if (!this.yBlocks.has(id)) return;
      if (id === SEED_BLOCK_ID) {
        // 虚拟起始段：先转成普通首块，再正常删除（保持语义统一）。
        if (this.ySeed.has(id)) this.unseedInPlace();
      }
      const index = this.yOrder.toArray().indexOf(id);
      if (index >= 0) this.yOrder.delete(index, 1);
      this.yBlocks.delete(id);
      this.ySeed.delete(id);
    });
  }

  /** 移动块到新位置（toIndex 基于"先移除后插入"语义，直观对应拖拽落点）。 */
  moveBlock(id: string, toIndex: number): void {
    if (id === SEED_BLOCK_ID && this.seedActive) return; // 虚拟起始段固定在开头
    this.transactLocal(() => {
      const raw = this.yOrder.toArray();
      const from = raw.indexOf(id);
      if (from < 0) return;
      this.yOrder.delete(from, 1);
      // 概念索引 -> order 内索引（虚拟起始段占去概念位 0）。
      let target = Math.max(0, toIndex) - (this.seedActive ? 1 : 0);
      const clamped = Math.max(0, Math.min(target, this.yOrder.length));
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

  /** 在单个本地事务内删除区间并插入文本（输入法替换选区用，单步可撤销）。 */
  replaceText(
    id: string,
    index: number,
    length: number,
    text: string,
    attributes?: InlineAttributes,
  ): void {
    this.transactLocal(() => {
      const node = this.getBlock(id);
      if (!node) return;
      if (length > 0) node.deleteText(index, length);
      node.insertText(index, text, attributes);
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

      // 起始段被拆分：原段先转成普通首块（入 order），拆出的新块紧随其后。
      // 转换必须在新块插入之前完成，否则 order 中会有重复 ID。
      if (id === SEED_BLOCK_ID && this.ySeed.has(id)) this.unseedInPlace();

      const nextType = node.type === 'heading' ? 'paragraph' : node.type;
      const yBlock = createYBlock({
        id: newId,
        type: this.registry.resolveType(nextType),
        now: Date.now(),
        createdBy: this.userId,
        attrs: { ...node.getAttrs() },
      });
      // 概念索引（被拆块之后）-> order 内索引。
      const conceptIndex = this.getIds().indexOf(id) + 1;
      let orderIndex = conceptIndex;
      if (this.seedActive) orderIndex -= 1;
      orderIndex = Math.max(0, Math.min(orderIndex, this.yOrder.length));
      this.yBlocks.set(newId, yBlock);
      this.yOrder.insert(orderIndex, [newId]);
      if (tailDelta.length) new BlockNode(yBlock).applyDelta(tailDelta);
    });
    return { newId, caret: { blockId: newId, index: 0 } };
  }

  /** 将块合并到上一块末尾（Backspace 于块首时触发）。 */
  mergeWithPrevious(id: string): { targetId: string; caretIndex: number } | null {
    const conceptIndex = this.indexOf(id);
    if (conceptIndex <= 0) return null;
    const targetId = this.getIds()[conceptIndex - 1];

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
      // 删除当前块（order 内定位；起始段不会是合并主体以外的特例）。
      const orderIndex = this.yOrder.toArray().indexOf(id);
      if (orderIndex >= 0) this.yOrder.delete(orderIndex, 1);
      this.yBlocks.delete(id);
      this.ySeed.delete(id);
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
