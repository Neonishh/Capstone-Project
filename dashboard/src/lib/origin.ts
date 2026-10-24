export function sameOrigin(req: Request) {
  try { return new URL(req.headers.get('origin') || '').host === req.headers.get('host'); }
  catch { return false; }
}
