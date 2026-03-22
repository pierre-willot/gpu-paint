// ── SessionStore ──────────────────────────────────────────────────────────────
// Pure IndexedDB abstraction. No GPU, no app state, no imports from the rest
// of the codebase. Everything here is plain data in / plain data out.
//
// Three object stores:
//   'session'     — single metadata record (canvas size, seq range, timestamp)
//   'commands'    — one record per command, keyed by monotonic seq number
//   'checkpoints' — compressed layer snapshots, keyed by undo stack length
//
// Seq numbers are monotonic and never reused. They form a sparse range:
// [minSeq, maxSeq] where some seqs in between may have been deleted (redo
// invalidation removes commands that were undone then abandoned).

const DB_NAME    = 'gpaint';
const DB_VERSION = 2;

// ── Record types ──────────────────────────────────────────────────────────────

export interface SessionMeta {
    id:                    'meta';   // single-record key
    canvasWidth:           number;
    canvasHeight:          number;
    minSeq:                number;   // seq of oldest command in undo stack
    maxSeq:                number;   // seq of newest command (-1 if empty)
    checkpointStackOffset: number;   // cumulative oldest-drops, applied on restore
    timestamp:             number;   // Date.now() of last explicit save
    version:               number;   // schema version for future migrations
}

export interface StoredCommandRecord {
    seq:           number;          // IDB key — monotonic, never reused
    type:          string;
    label:         string;
    layerIndex?:   number;
    beforeBuffer?: ArrayBuffer;     // stroke/smudge/cut/selection — before state pixels or mask
    afterBuffer?:  ArrayBuffer;     // stroke/smudge/cut/paste/selection — after state
    maskWidth?:    number;          // selection only
    maskHeight?:   number;          // selection only
    operation?:    string;          // selection only — for display
}

export interface StoredCheckpointRecord {
    stackLength:      number;         // IDB key — undo stack length at snapshot time
    activeLayerIndex: number;
    snapshots: Array<{
        dataBuffer:  ArrayBuffer;     // compressed Uint8Array.buffer
        bytesPerRow: number;
        meta: {
            opacity:   number;
            blendMode: string;
            visible:   boolean;
            name:      string;
        };
    }>;
}

// ── SessionStore ──────────────────────────────────────────────────────────────

export class SessionStore {
    private db: IDBDatabase | null = null;

    /**
     * Opens the IndexedDB, creating or upgrading stores as needed.
     * Must be called before any other method.
     */
    async open(): Promise<void> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = (e.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains('session')) {
                    db.createObjectStore('session', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('commands')) {
                    db.createObjectStore('commands', { keyPath: 'seq' });
                }
                if (!db.objectStoreNames.contains('checkpoints')) {
                    db.createObjectStore('checkpoints', { keyPath: 'stackLength' });
                }
            };

            req.onsuccess = (e) => {
                this.db = (e.target as IDBOpenDBRequest).result;

                // Handle connection loss gracefully
                this.db.onversionchange = () => this.db?.close();
                resolve();
            };

            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IndexedDB blocked — another tab may be open'));
        });
    }

    /** Returns true if a non-empty previous session exists. */
    async hasSession(): Promise<boolean> {
        const meta = await this.getSessionMeta();
        return meta !== null && meta.maxSeq >= meta.minSeq && meta.maxSeq >= 0;
    }

    async getSessionMeta(): Promise<SessionMeta | null> {
        return this.getRecord<SessionMeta>('session', 'meta');
    }

    async updateSessionMeta(meta: SessionMeta): Promise<void> {
        return this.putRecord('session', meta);
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    async appendCommand(record: StoredCommandRecord): Promise<void> {
        return this.putRecord('commands', record);
    }

    async deleteCommand(seq: number): Promise<void> {
        return this.deleteRecord('commands', seq);
    }

    /**
     * Deletes all command records with seq strictly greater than cutoffSeq.
     * Called when redo is invalidated by a new command.
     */
    async deleteCommandsAboveSeq(cutoffSeq: number): Promise<void> {
        return this.deleteCursorRange('commands', IDBKeyRange.lowerBound(cutoffSeq, true));
    }

    /**
     * Loads all command records in [minSeq, maxSeq] sorted by seq ascending.
     * The range may be sparse — some seqs may have been deleted.
     */
    async loadCommandRange(minSeq: number, maxSeq: number): Promise<StoredCommandRecord[]> {
        if (maxSeq < minSeq) return [];
        const db = this.assertDb();
        return new Promise((resolve, reject) => {
            const tx    = db.transaction('commands', 'readonly');
            const range = IDBKeyRange.bound(minSeq, maxSeq);
            const req   = tx.objectStore('commands').getAll(range);
            req.onsuccess = () => {
                // Sort by seq to guarantee correct replay order
                const sorted = (req.result as StoredCommandRecord[])
                    .sort((a, b) => a.seq - b.seq);
                resolve(sorted);
            };
            req.onerror = () => reject(req.error);
        });
    }

    // ── Checkpoints ───────────────────────────────────────────────────────────

    async putCheckpoint(record: StoredCheckpointRecord): Promise<void> {
        return this.putRecord('checkpoints', record);
    }

    /**
     * Deletes all checkpoint records with stackLength strictly greater than
     * cutoff. Called when redo is invalidated — those checkpoints are stale.
     */
    async deleteCheckpointsAboveStack(cutoff: number): Promise<void> {
        return this.deleteCursorRange('checkpoints', IDBKeyRange.lowerBound(cutoff, true));
    }

    async loadAllCheckpoints(): Promise<StoredCheckpointRecord[]> {
        const db = this.assertDb();
        return new Promise((resolve, reject) => {
            const tx  = db.transaction('checkpoints', 'readonly');
            const req = tx.objectStore('checkpoints').getAll();
            req.onsuccess = () => resolve(req.result as StoredCheckpointRecord[]);
            req.onerror  = () => reject(req.error);
        });
    }

    // ── Full clear ────────────────────────────────────────────────────────────

    /** Wipes all stores. Called when user chooses "Start Fresh" on the restore banner. */
    async clearAll(): Promise<void> {
        const db = this.assertDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['session', 'commands', 'checkpoints'], 'readwrite');
            tx.objectStore('session').clear();
            tx.objectStore('commands').clear();
            tx.objectStore('checkpoints').clear();
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private assertDb(): IDBDatabase {
        if (!this.db) throw new Error('SessionStore not opened — call open() first');
        return this.db;
    }

    private getRecord<T>(store: string, key: IDBValidKey): Promise<T | null> {
        const db = this.assertDb();
        return new Promise((resolve, reject) => {
            const tx  = db.transaction(store, 'readonly');
            const req = tx.objectStore(store).get(key);
            req.onsuccess = () => resolve((req.result as T) ?? null);
            req.onerror   = () => reject(req.error);
        });
    }

    private putRecord(store: string, value: unknown): Promise<void> {
        const db = this.assertDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).put(value);
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }

    private deleteRecord(store: string, key: IDBValidKey): Promise<void> {
        const db = this.assertDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }

    private deleteCursorRange(store: string, range: IDBKeyRange): Promise<void> {
        const db = this.assertDb();
        return new Promise((resolve, reject) => {
            const tx  = db.transaction(store, 'readwrite');
            const req = tx.objectStore(store).openCursor(range);
            req.onsuccess = (e) => {
                const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
                if (cursor) { cursor.delete(); cursor.continue(); }
            };
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }
}
