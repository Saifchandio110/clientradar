// Bluesky search helpers. Read-only: only GET requests, nothing is ever posted.
export const API = "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts";

// Build the link to the original post from its at:// URI.
export function postUrl(uri, handle) {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri || "");
  if (!m || !handle) return null;
  return "https://bsky.app/profile/" + handle + "/post/" + m[2];
}

// Turn one raw API post into the small shape we store later. Returns null if invalid.
export function normalizePost(p) {
  if (!p || typeof p.uri !== "string" || !p.record || typeof p.record.text !== "string") return null;
  const handle = (p.author && p.author.handle) || "";
  return {
    uri: p.uri,
    cid: p.cid || null,
    author_handle: handle,
    author_name: (p.author && p.author.displayName) || "",
    text: p.record.text,
        is_reply: !!p.record.reply,
    url: postUrl(p.uri, handle),
    created_at: p.record.createdAt || p.indexedAt || null,
    indexed_at: p.indexedAt || null
  };
}

// Search one query. Never throws: returns { ok:true, posts, cursor, hits } or { ok:false, kind, message }.
export async function searchPosts(query, opts) {
  const o = opts || {};
  const fetchFn = o.fetchFn || fetch;
  const u = new URL(API);
  u.searchParams.set("q", query);
  u.searchParams.set("sort", "latest");
  u.searchParams.set("limit", String(o.limit || 25));
  if (o.cursor) u.searchParams.set("cursor", o.cursor);

  let res;
  try {
    res = await fetchFn(u.toString(), { headers: o.headers || {} });
  } catch (e) {
    return { ok: false, kind: "network", message: "Network error: " + (e && e.message ? e.message : "request failed") };
  }
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    return { ok: false, kind: "rate_limit", status: 429, message: "Rate limited by Bluesky. Retry after " + (retry || "a short while") + "." };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "auth", status: res.status, message: "Bluesky requires login for post search (HTTP " + res.status + ")." };
  }
  if (!res.ok) {
    return { ok: false, kind: "http", status: res.status, message: "Bluesky returned HTTP " + res.status + "." };
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { ok: false, kind: "parse", message: "Bluesky sent a response that is not valid JSON." };
  }
  const posts = (Array.isArray(data.posts) ? data.posts : []).map(normalizePost).filter(Boolean);
  return { ok: true, posts: posts, cursor: data.cursor || null, hits: data.hitsTotal == null ? null : data.hitsTotal };
}
