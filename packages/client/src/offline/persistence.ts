import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

type IndexeddbPersistenceInstance = InstanceType<typeof IndexeddbPersistence>;

/**
 * 离线优先本地持久化，基于 IndexedDB + y-indexeddb。
 *
 * 三类数据（库 blockeditor-<docId>）：
 *  1. Yjs 文档状态 —— 由 IndexeddbPersistence 在每次事务后增量落盘，
 *     重新打开页面时先加载本地状态，实现"秒开 + 断网全量编辑"；
 *  2. pending-updates —— 本地待同步的二进制增量队列（SyncQueue）；
 *  3. temp-state       —— 临时文档状态（滚动位置、草稿设置等，可丢弃）。
 */

const DB_VERSION = 1;
/** 该库内本模块使用的全部 store（升级 / 建库时一并创建）。 */
const STORE_NAMES = ['pending-updates', 'temp-state'];

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (STORE_NAMES.every((name) => db.objectStoreNames.contains(name))) {
        resolve(db);
        return;
      }
      // 旧版本库缺少 store：关库升级版本重建（理论上 DB_VERSION=1 不会走到，
      // 保留以兼容手工建库 / 旧数据）。
      db.close();
      const upgrade = indexedDB.open(dbName, DB_VERSION + 1);
      upgrade.onupgradeneeded = () => {
        const d = upgrade.result;
        for (const name of STORE_NAMES) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'key' });
        }
      };
      upgrade.onsuccess = () => resolve(upgrade.result);
      upgrade.onerror = () => reject(upgrade.error);
      upgrade.onblocked = () => reject(upgrade.error ?? new Error('IndexedDB 升级被阻塞'));
    };
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 简单的 key/value 存储（pending 队列与临时状态共用）。
 *
 * 关键约束：IndexedDB 事务在其中最后一个请求完成后立即自动失效
 * （TransactionInactiveError），因此**每次读写都新开一个事务**，
 * 绝不缓存 IDBObjectStore 跨调用复用。
 */
export class KeyValueStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly dbName: string,
    private readonly store: string,
  ) {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb(this.dbName);
    return this.dbPromise;
  }

  /** 新开一个事务，在其生命周期内执行一次 store 操作。 */
  private async withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.db();
    if (db.objectStoreNames.contains(this.store)) {
      return this.run(db, mode, fn);
    }
    // 极端情况下库被降级（无该 store）：重新开库。
    this.dbPromise = null;
    return this.run(await this.db(), mode, fn);
  }

  private run<T>(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const tx = db.transaction(this.store, mode);
    // Promise 链一直引用 tx，直到请求回调结束，事务不会中途失效。
    return requestToPromise(fn(tx.objectStore(this.store)));
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.withStore('readwrite', (s) => s.put({ key, value }));
  }

  async get<T>(key: string): Promise<T | undefined> {
    const row = await this.withStore('readonly', (s) =>
      s.get(key),
    );
    return (row as { value: T } | undefined)?.value;
  }

  async getAll<T>(): Promise<T[]> {
    const rows = await this.withStore('readonly', (s) => s.getAll());
    return (rows as Array<{ value: T }>).map((r) => r.value);
  }

  async delete(key: string): Promise<void> {
    await this.withStore('readwrite', (s) => s.delete(key));
  }

  async clear(): Promise<void> {
    await this.withStore('readwrite', (s) => s.clear());
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
  const dbName = `blockeditor-${docId}`;
  const persistence = new IndexeddbPersistence(docId, doc);

  const queue = new KeyValueStore(dbName, 'pending-updates');
  const temp = new KeyValueStore(dbName, 'temp-state');

  const whenSynced = new Promise<void>((resolve) => {
    persistence.once('synced', () => resolve());
    // y-indexeddb 在无历史数据时也会触发 synced。
  });

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
