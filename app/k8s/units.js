/**
 * Kubernetes quantity parsing and unit normalization.
 *
 * The v2 contract normalizes CPU to CORES (float) and memory/storage to BYTES
 * (integer) once, at collection time, so downstream stores and the UI never
 * have to deal with raw nanocores / Ki-Mi-Gi suffixes again.
 *
 * Pure functions only — unit tested without a cluster.
 */

// CPU suffix multipliers expressed in CORES.
//   "100m" = 0.1 cores ; "250000u" = 0.00025 cores ; "1000000000n" = 1 core
const CPU_SUFFIX_TO_CORES = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
};

/**
 * Parse a Kubernetes CPU quantity to cores (float). Returns null for missing.
 *   parseCpuCores("500m") === 0.5
 *   parseCpuCores("2")    === 2
 */
function parseCpuCores(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value;
  const str = String(value).trim();
  const match = str.match(/^([0-9.]+)([a-zA-Z]*)$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (Number.isNaN(num)) return null;
  const suffix = match[2];
  if (!suffix) return num;
  const mult = CPU_SUFFIX_TO_CORES[suffix];
  return mult === undefined ? num : num * mult;
}

// Memory/storage binary (Ki/Mi/...) and decimal (k/M/...) suffix multipliers in BYTES.
const MEM_SUFFIX_TO_BYTES = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

/**
 * Parse a Kubernetes memory/storage quantity to bytes (integer). null if missing.
 *   parseBytes("128Mi") === 134217728
 *   parseBytes("1Gi")   === 1073741824
 *   parseBytes("1000")  === 1000
 */
function parseBytes(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Math.round(value);
  const str = String(value).trim();
  // Binary suffix (two chars ending in 'i') first, then single-char decimal.
  const biMatch = str.match(/^([0-9.]+)([KMGTPE]i)$/);
  if (biMatch) {
    return Math.round(parseFloat(biMatch[1]) * MEM_SUFFIX_TO_BYTES[biMatch[2]]);
  }
  const decMatch = str.match(/^([0-9.]+)([kKMGTPE])?$/);
  if (decMatch) {
    const num = parseFloat(decMatch[1]);
    if (Number.isNaN(num)) return null;
    const suffix = decMatch[2];
    return Math.round(suffix ? num * MEM_SUFFIX_TO_BYTES[suffix] : num);
  }
  return null;
}

/** Parse a plain integer quantity (e.g. pods count). */
function parseIntSafe(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

/** Sum an array of values, treating null/undefined as 0. Returns 0 for empty. */
function sumNullable(values) {
  return values.reduce((acc, v) => acc + (v || 0), 0);
}

/**
 * Age helper: returns { seconds, humanReadable } from a creation timestamp.
 * `now` is injectable so this is deterministic in tests.
 */
function calculateAge(creationTimestamp, now = new Date()) {
  if (!creationTimestamp) return null;
  const created = new Date(creationTimestamp);
  const diff = now - created;
  return { seconds: Math.floor(diff / 1000), humanReadable: formatDuration(diff) };
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

module.exports = {
  parseCpuCores,
  parseBytes,
  parseIntSafe,
  sumNullable,
  calculateAge,
  formatDuration,
};
