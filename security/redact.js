// Redaction for anything that is logged. Two layers:
// 1. exact values of secrets loaded at runtime (registerSecret)
// 2. known token shapes + sensitive object keys
const knownSecrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) knownSecrets.add(value);
}

const SENSITIVE_KEY = /(secret|token|password|passwd|authorization|api[-_]?key|cookie|signature|private[-_]?key|credential)/i;

const PATTERNS = [
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
  /figd_[A-Za-z0-9_-]{20,}/g, // Figma PAT
  /ATATT[A-Za-z0-9_=-]{20,}/g, // Atlassian API token
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic key
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /sha256=[a-f0-9]{64}/gi,
];

export function redactString(s) {
  let out = s;
  for (const secret of knownSecrets) out = out.split(secret).join('[REDACTED]');
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

export function redact(value, depth = 0) {
  if (depth > 8) return '[Truncated]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(String(value.message)), code: value.code };
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
