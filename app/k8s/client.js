/**
 * Thin Kubernetes API client built on axios + the in-cluster ServiceAccount.
 *
 * We deliberately keep the proven axios approach from the original agent
 * (rather than @kubernetes/client-node) for consistency and low risk, but add:
 *   - automatic pagination (limit + continue) so large clusters never load a
 *     single giant response into memory,
 *   - per-call hard limits,
 *   - a softGet() that never throws (returns null + reason) so a missing API
 *     group (e.g. metrics-server) or an RBAC 403 degrades gracefully instead of
 *     dropping the whole collection cycle.
 */

const fs = require('fs');
const https = require('https');
const axios = require('axios');

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const BASE_URL = process.env.K8S_API_URL || 'https://kubernetes.default.svc';

function createClient() {
  let token = '';
  let httpsAgent;
  try {
    token = fs.readFileSync(`${SA_DIR}/token`, 'utf8');
    const ca = fs.readFileSync(`${SA_DIR}/ca.crt`);
    httpsAgent = new https.Agent({ ca });
  } catch (err) {
    // Allow running outside a cluster (tests / local) without crashing.
    console.error('[k8s] could not read service account credentials:', err.message);
    httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  const http = axios.create({
    baseURL: BASE_URL,
    httpsAgent,
    timeout: parseInt(process.env.K8S_API_TIMEOUT_MS || '15000', 10),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    // Large clusters produce large JSON bodies; lift the default 10MB cap.
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  /**
   * List every item of a collection path, following `continue` tokens.
   * Stops early once `maxItems` is reached (returns { items, truncated }).
   * @param {string} path e.g. "/api/v1/pods"
   */
  async function listAll(path, { maxItems = Infinity, pageSize = 500 } = {}) {
    const items = [];
    let cont = '';
    let truncated = false;
    /* eslint-disable no-await-in-loop */
    do {
      const params = { limit: pageSize };
      if (cont) params.continue = cont;
      const res = await http.get(path, { params });
      const body = res.data || {};
      for (const item of body.items || []) {
        items.push(item);
        if (items.length >= maxItems) {
          truncated = true;
          break;
        }
      }
      cont = truncated ? '' : (body.metadata && body.metadata.continue) || '';
    } while (cont);
    /* eslint-enable no-await-in-loop */
    return { items, truncated };
  }

  /**
   * Like listAll, but never throws. On failure returns
   * { items: [], truncated: false, error: { message, status } }.
   * Used for optional sources (metrics-server, events, endpointslices) so one
   * failure can't abort the whole snapshot.
   */
  async function softListAll(path, opts) {
    try {
      const result = await listAll(path, opts);
      return { ...result, error: null };
    } catch (err) {
      return {
        items: [],
        truncated: false,
        error: {
          message: err.message,
          status: err.response && err.response.status,
        },
      };
    }
  }

  return { http, listAll, softListAll, baseURL: BASE_URL };
}

module.exports = { createClient };
