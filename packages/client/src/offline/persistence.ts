import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

type IndexeddbPersistenceInstance = InstanceType<typeof IndexeddbPersistence>;

/**
 * 离线优先本地持久化，基于 IndexedDB + y-indexeddb。
 *
 * 复用 y-indexeddb 创建的同一个数据库（库名即 docId）：
 *  1. updates  store —— Yjs 文档状态，由 IndexeddbPersistence 每次事务后增量落盘，
 *     重新打开页面时先加载本地状态，实现"秒开 + 断网全量编辑"；
 *  2. custom   store —— y-indexeddb 预留的通用 key/value，我们以键前缀隔离出：
 *       queue:* 本地待同步二进制增量（SyncQueue）；
 *       temp:*  临时文档状态（滚动位置等，可丢弃）。
 *
 * 不自己 createObjectStore、不提高数据库版本：否则升级时 y-indexeddb 持有
 * 的旧版本连接会被浏览器以 versionchange 关闭且不会重开，反而打断它对
 * Yjs 状态的持续落盘。
 */

/** 打开数据库连接（不传版本，与 y-indexeddb 一致，绝不触发版本升级）。 */
function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // bindIndexedDB 先构造 IndexeddbPersistence，它负责建库 / 建 store；
    // 这里无版本打开只会拿到已就绪的连接。
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB 打开被阻塞'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 简单的 key/value 存储（映射到 y-indexeddb 的 custom store）。
 *
 * 注意：只缓存 IDBDatabase，绝不缓存 IDBObjectStore / IDBTransaction ——
 * IndexedDB 事务在事件循环一轮空闲后自动结束，复用一个已结束事务的
 * store 会抛 TransactionInactiveError。因此每次读写都新开一个事务。
 */
export class KeyValueStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * @param dbName 数据库名（blockeditor-<docId>）
   * @param keyPrefix 键前缀，多个逻辑存储共用 custom store 时互相隔离
   * @param ready 数据库（含 custom store）已由 y-indexeddb 创建好的承诺；
   *              必须等它 resolve 后再无版本打开，否则两个无版本 open
   *              竞争时可能由本类先建出空库，导致 y-indexeddb 不再升级建 store。
   */
  constructor(
    private readonly dbName: string,
    private readonly keyPrefix: string,
    private readonly ready?: Promise<unknown>,
  ) {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= (async () => {
      await this.ready;
      return openDatabase(this.dbName);
    })();
    return this.dbPromise;
  }

  /** 在一个全新的 readwrite 事务内操作 custom store，自动加 / 去键前缀。 */
  private async withStore<T>(fn: (store: IDBObjectStore, fullKey: string) => IDBRequest<T>, key = ''): Promise<T> {
    const db = await this.db();
    const tx = db.transaction('custom', 'readwrite');
    return requestToPromise(fn(tx.objectStore('custom'), this.keyPrefix + key));
  }

  async put<T>(key: string, value: T): Promise<void> {
    // custom 是 out-of-line-key store，必须把完整键作为第二参数显式传入。
    await this.withStore((s, fullKey) => s.put({ key: fullKey, value }, fullKey), key);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const row = await this.withStore(
      (s, fullKey) => s.get(fullKey) as IDBRequest<{ value: T } | undefined>,
      key,
    );
    return row?.value;
  }

  async getAll<T>(): Promise<T[]> {
    const db = await this.db();
    const tx = db.transaction('custom', 'readonly');
    // 只取本逻辑存储前缀下的行，不影响 custom 里的其他键。
    const range = IDBKeyRange.bound(this.keyPrefix, this.keyPrefix + '￻');
    const rows = (await requestToPromise(tx.objectStore('custom').getAll(range))) as Array<{
      value: T;
    }>;
    return rows.map((r) => r.value);
  }

  async delete(key: string): Promise<void> {
    await this.withStore((s, fullKey) => s.delete(fullKey), key);
  }

  async clear(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction('custom', 'readwrite');
    const store = tx.objectStore('custom');
    const range = IDBKeyRange.bound(this.keyPrefix, this.keyPrefix + '￻');
    await requestToPromise(store.delete(range));
  }
}

export interface PersistenceHandle {
  /** y-indexeddb 实例，初次本地加载完成后 resolve。 */
  persistence: IndexeddbPersistenceInstance;
  whenSynced: Promise<void>;
  /** 待同步二进制增量队列。 */
  queue: KeyValueStore;
  /** 临时文档状态。 */
  temp: KeyValueStore;
  /** 关闭并刷盘。 */
  destroy: () => void;
}

export function bindIndexedDB(doc: Y.Doc, docId: string): PersistenceHandle {
  // y-indexeddb 直接以 docId 作为 IndexedDB 库名（内含 updates/custom store）。
  // 队列 / 临时状态复用同一个库的 custom store —— 必须同名，
  // 否则会打开另一个永远没有 custom store 的空库。
  const dbName = docId;
  // IndexeddbPersistence 负责创建数据库与 updates/custom store。
  const persistence = new IndexeddbPersistence(docId, doc);

  const whenSynced = new Promise<void>((resolve) => {
    persistence.once('synced', () => resolve());
    // y-indexeddb 在无历史数据时也会触发 synced。
  });

  // 两类键值数据复用 custom store，以前缀隔离；等 y-indexeddb 建库后再打开。
  const queue = new KeyValueStore(dbName, 'queue:', whenSynced);
  const temp = new KeyValueStore(dbName, 'temp:', whenSynced);

  return {
    persistence,
    whenSynced,
    queue,
    temp,
    destroy: () => {
      persistence.destroy();
    },
  };
}
