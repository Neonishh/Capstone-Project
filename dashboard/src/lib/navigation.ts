export function safeReturnPath(value: string | null, origin: string) {
  if (!value?.startsWith('/')) return '/';
  try { const url = new URL(value, origin); return url.origin === origin ? url.pathname + url.search + url.hash : '/'; }
  catch { return '/'; }
}
