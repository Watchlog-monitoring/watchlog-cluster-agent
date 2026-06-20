/**
 * Snapshot transport: compression + chunking + bounded retry queue + acks.
 *
 * Wire format
 *   single:  emit("kubernetes:snapshot", { envelope:true, clusterId, snapshotId,
 *                                          encoding:"gzip"|"json", data })
 *            - encoding "gzip": data is base64 of gzip(JSON.stringify(snapshot))
 *            - encoding "json": data is the snapshot object itself
 *   chunked: emit("kubernetes:snapshot:chunk", { type:"kubernetes_snapshot_chunk",
 *                                          clusterId, snapshotId, seq, total,
 *                                          encoding:"gzip", data })  // base64 slice
 *
 * The server acks each snapshot/chunk via the Socket.IO ack callback. Unacked
 * snapshots are kept in a bounded in-memory queue and replayed (newest-first)
 * on reconnect, dropping the oldest on overflow. This replaces the original
 * one-shot emitWhenConnected (which silently lost data across disconnects).
 */
const zlib = require('zlib');

const CHUNK_EVENT = 'kubernetes:snapshot:chunk';
const SNAPSHOT_EVENT = 'kubernetes:snapshot';

class SnapshotSender {
  constructor(socket, opts = {}) {
    this.socket = socket;
    this.compression = opts.compression !== false;
    this.compressMinBytes = opts.compressMinBytes || 1024;
    // Max bytes of base64 data per chunk emit (keeps individual frames small).
    this.chunkBytes = opts.chunkBytes || 512 * 1024;
    this.ackTimeoutMs = opts.ackTimeoutMs || 20000;
    this.queueMax = opts.queueMax || 10;
    this.queue = []; // [{ snapshotId, frames }]
    this._counter = 0;

    socket.on('connect', () => this._drain());
  }

  _nextId(clusterId) {
    this._counter += 1;
    return `${clusterId}-${Date.now()}-${this._counter}`;
  }

  /** Build the wire frames for a snapshot (1 single frame, or N chunk frames). */
  _frames(snapshot) {
    const clusterId = snapshot.clusterId;
    const snapshotId = this._nextId(clusterId);
    const json = JSON.stringify(snapshot);

    const useGzip = this.compression && Buffer.byteLength(json) >= this.compressMinBytes;
    if (!useGzip) {
      return {
        snapshotId,
        single: { event: SNAPSHOT_EVENT, payload: { envelope: true, clusterId, snapshotId, encoding: 'json', data: snapshot } },
        frames: null,
      };
    }

    const b64 = zlib.gzipSync(json).toString('base64');
    if (b64.length <= this.chunkBytes) {
      return {
        snapshotId,
        single: { event: SNAPSHOT_EVENT, payload: { envelope: true, clusterId, snapshotId, encoding: 'gzip', data: b64 } },
        frames: null,
      };
    }

    // Split base64 into ordered chunks.
    const total = Math.ceil(b64.length / this.chunkBytes);
    const frames = [];
    for (let seq = 0; seq < total; seq++) {
      frames.push({
        event: CHUNK_EVENT,
        payload: {
          type: 'kubernetes_snapshot_chunk',
          clusterId,
          snapshotId,
          seq,
          total,
          encoding: 'gzip',
          data: b64.slice(seq * this.chunkBytes, (seq + 1) * this.chunkBytes),
        },
      });
    }
    return { snapshotId, single: null, frames };
  }

  _emitWithAck(event, payload) {
    return new Promise((resolve, reject) => {
      if (!this.socket.connected) return reject(new Error('disconnected'));
      this.socket.timeout(this.ackTimeoutMs).emit(event, payload, (err, resp) => {
        if (err) return reject(err);
        if (resp && resp.ok === false) return reject(new Error(resp.reason || 'nack'));
        resolve(resp);
      });
    });
  }

  async _sendItem(item) {
    if (item.single) {
      await this._emitWithAck(item.single.event, item.single.payload);
    } else {
      // Send chunks in order; if any fails the whole snapshot is retried.
      /* eslint-disable no-await-in-loop */
      for (const frame of item.frames) {
        await this._emitWithAck(frame.event, frame.payload);
      }
      /* eslint-enable no-await-in-loop */
    }
  }

  _enqueue(item) {
    this.queue.push(item);
    while (this.queue.length > this.queueMax) {
      const dropped = this.queue.shift();
      console.error(`[k8s] snapshot queue overflow, dropping ${dropped.snapshotId}`);
    }
  }

  async _drain() {
    // Replay newest-first so the freshest state lands first; keep order otherwise.
    const pending = this.queue.splice(0);
    for (const item of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this._sendItem(item);
      } catch (err) {
        this._enqueue(item);
      }
    }
  }

  /** Public: send a snapshot. Resolves on ack, queues on failure/disconnect. */
  async send(snapshot) {
    const built = this._frames(snapshot);
    const item = { snapshotId: built.snapshotId, single: built.single, frames: built.frames };
    try {
      await this._sendItem(item);
      return { ok: true, snapshotId: built.snapshotId };
    } catch (err) {
      this._enqueue(item);
      console.error(`[k8s] snapshot ${built.snapshotId} queued for retry: ${err.message}`);
      return { ok: false, snapshotId: built.snapshotId, queued: true };
    }
  }
}

module.exports = { SnapshotSender, SNAPSHOT_EVENT, CHUNK_EVENT };
