// watchPods.js
// Kubernetes Pod Logs Watcher with bulk‐buffered socket emission, including nodeName (and alias node)

const fs = require('fs');
const axios = require('axios');
const https = require('https');
const readline = require('readline');
const apiKey = process.env.WATCHLOG_APIKEY;
const { emitWhenConnected } = require('./socketServer');

// --- Kubernetes API setup ---
const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
const httpsAgent = new https.Agent({ ca });
const headers = { Authorization: `Bearer ${token}` };
const baseURL = 'https://kubernetes.default.svc';
const CLUSTER = process.env.WATCHLOG_CLUSTER_NAME || 'default-cluster';

function watchPods(socket, opts = {}) {
  const { maxConcurrent = 5, reconnectDelay = 5000 } = opts;
  const active = new Map(); // key "namespace/podName" -> abortFn
  const queue = [];        // items: { namespace, podName, nodeName }

  function startNext() {
    while (active.size < maxConcurrent && queue.length) {
      const job = queue.shift();
      const key = `${job.namespace}/${job.podName}`;
      streamPodLogs(socket, job.namespace, job.podName, { ...opts, nodeName: job.nodeName })
        .then(abortFn => {
          active.set(key, abortFn);
        })
        .catch(err => {
          console.error(`Failed to start log stream for ${key}:`, err.message);
          // re-enqueue for retry
          setTimeout(() => {
            queue.push(job);
            startNext();
          }, reconnectDelay);
        });
    }
  }

  async function startWatch() {
    try {
      const res = await axios.get(`${baseURL}/api/v1/pods?watch=true`, {
        httpsAgent,
        headers,
        responseType: 'stream',
        timeout: 0
      });
      const rl = readline.createInterface({ input: res.data });

      rl.on('line', line => {
        if (!line.trim()) return;
        let evt;
        try { evt = JSON.parse(line); } catch { return; }

        const { type, object: pod } = evt;
        const ns = pod.metadata.namespace;
        const nm = pod.metadata.name;
        const node = pod.spec.nodeName;
        const key = `${ns}/${nm}`;

        if (type === 'ADDED') {
          if (!active.has(key) &&
              !queue.some(p => p.namespace === ns && p.podName === nm)) {
            queue.push({ namespace: ns, podName: nm, nodeName: node });
            startNext();
          }
        } else if (type === 'DELETED') {
          // stop and cleanup
          const abort = active.get(key);
          if (abort) {
            abort();
            active.delete(key);
          }
          // remove from queue if pending
          const idx = queue.findIndex(p => p.namespace === ns && p.podName === nm);
          if (idx !== -1) queue.splice(idx, 1);

          emitWhenConnected('podLogEnd', { namespace: ns, podName: nm, nodeName: node, cluster: CLUSTER, apiKey });
        }
      });

      rl.on('error', err => {
        console.error('watchPods readline error:', err.message);
        rl.close();
        res.data.destroy();
        setTimeout(startWatch, reconnectDelay);
      });

      rl.on('close', () => {
        res.data.destroy();
        setTimeout(startWatch, reconnectDelay);
      });
    } catch (err) {
      console.error('watchPods error:', err.message);
      setTimeout(startWatch, reconnectDelay);
    }
  }

  startWatch();
}


/** 
 * Extract a simple severity level from a log message. 
 */
function extractSeverity(message) {
  const p = message.match(/^\s*([IWE])\d{4}/);
  if (p) return p[1] === 'I' ? 'INFO' : p[1] === 'W' ? 'WARNING' : 'ERROR';
  const m = message.match(/\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i);
  if (m) {
    const lvl = m[1].toUpperCase();
    return lvl === 'WARN' ? 'WARNING' : lvl;
  }
  return 'UNKNOWN';
}

/**
 * Stream logs for a single Pod, buffer them, and emit via socket.
 * Returns a function that aborts the stream.
 */
async function streamPodLogs(socket, namespace, podName, opts = {}) {
  const {
    bulkSize = 100,
    bulkInterval = 10000,
    tailLines = 100,
    sinceSeconds = 60,
    includeTimestamps = true,
    containerName = null,
    nodeName = null,    // nodeName passed in from watchPods()
    reconnectDelay = 5000
  } = opts;

  // build the log URL
  const params = new URLSearchParams({ follow: 'true' });
  params.append('tailLines', tailLines);
  params.append('sinceSeconds', sinceSeconds);
  params.append('timestamps', includeTimestamps ? 'true' : 'false');
  if (containerName) params.append('container', containerName);
  const url = `${baseURL}/api/v1/namespaces/${namespace}/pods/${podName}/log?${params}`;

  let buffer = [];
  const flush = () => {
    if (buffer.length) {
      emitWhenConnected('podLogLines', buffer);
      buffer = [];
    }
  };
  const intervalId = setInterval(flush, bulkInterval);

  try {
    const res = await axios.get(url, {
      httpsAgent,
      headers,
      responseType: 'stream',
      timeout: 0
    });

    res.data.on('error', err => {
      console.error('HTTP stream error:', err.message);
      cleanup();
      // retry this pod after delay
      setTimeout(() => streamPodLogs(socket, namespace, podName, opts), reconnectDelay);
    });

    const rl = readline.createInterface({ input: res.data });
    rl.on('line', line => {
      if (!line.trim()) return;
      let ts, msg;
      if (includeTimestamps) {
        const i = line.indexOf(' ');
        ts = line.slice(0, i);
        msg = line.slice(i + 1);
      } else {
        ts = new Date().toISOString();
        msg = line;
      }
      buffer.push({
        namespace,
        podName,
        containerName,
        nodeName,
        node: nodeName,
        timestamp: ts,
        message: msg,
        severity: extractSeverity(msg),
        cluster: CLUSTER
      });
      if (buffer.length >= bulkSize) flush();
    });

    rl.on('error', err => {
      console.error('StreamPodLogs readline error:', err.message);
      cleanup();
      setTimeout(() => streamPodLogs(socket, namespace, podName, opts), reconnectDelay);
    });

    rl.on('close', () => {
      cleanup();
      emitWhenConnected('podLogEnd', { namespace, podName, nodeName, node: nodeName, cluster: CLUSTER });
    });

    function cleanup() {
      clearInterval(intervalId);
      flush();
      try { res.data.destroy(); } catch {}
      try { rl.close(); } catch {}
    }

    // return abort function
    return () => {
      cleanup();
      emitWhenConnected('podLogEnd', { namespace, podName, nodeName, node: nodeName, cluster: CLUSTER });
    };

  } catch (err) {
    clearInterval(intervalId);
    console.error(`streamPodLogs error for ${namespace}/${podName}:`, err.message);
    emitWhenConnected('podLogError', { namespace, podName, nodeName, node: nodeName, error: err.message, cluster: CLUSTER });
    // retry on failure
    setTimeout(() => streamPodLogs(socket, namespace, podName, opts), reconnectDelay);
    // return a no-op abort
    return () => {};
  }
}

module.exports = { watchPods, streamPodLogs };
