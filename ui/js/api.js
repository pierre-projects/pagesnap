// Talking to lib/server.js: JSON requests and the URLs of capture files.

export async function api(path, init) {
  let r;
  try { r = await fetch(path, init); }
  catch { throw new Error('The pagesnap server did not reply. Make sure that it is running.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `The server sent HTTP ${r.status}.`);
  return data;
}

// fetch() options for a JSON POST.
export const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const fileUrl = (name, download) => `/files/${encodeURIComponent(name)}${download ? '?download' : ''}`;
export const zipUrl = (c) => `/api/captures/${encodeURIComponent(c.id)}/zip`;
