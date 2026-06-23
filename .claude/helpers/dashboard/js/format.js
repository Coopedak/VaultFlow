export const fmtNum = (n) => (n == null ? '0' : Number(n).toLocaleString('en-US'));
export const fmtAgo = (h) => (h == null ? 'never' : `${Number(h).toFixed(1)}h ago`);
export const fmtBytesMb = (mb) => `${Math.round(Number(mb) || 0)} MB`;
export const pct = (part, total) => (total ? Math.round((100 * part) / total) : 0);
export const healthTone = ({ ok = 0, warn = 0, fail = 0 }) => (fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'ok');
