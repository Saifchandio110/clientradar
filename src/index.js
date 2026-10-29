import { normalizePost } from "../public/bluesky.js";

const PDS = "https://bsky.social/xrpc";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// Log in with the app password. Returns { jwt } or { error }.
async function login(env) {
  let res;
  try {
    res = await fetch(PDS + "/com.atproto.server.createSession", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: env.BSKY_IDENTIFIER, password: env.BSKY_APP_PASSWORD })
    });
  } catch (e) {
    return { error: "Could not reach Bluesky to log in.", status: 502 };
  }
  if (res.status === 401 || res.status === 400) {
    return { error: "Bluesky login failed. Check BSKY_IDENTIFIER and BSKY_APP_PASSWORD.", status: 502 };
  }
  if (res.status === 429) return { error: "Bluesky login rate limited. Wait a few minutes.", status: 429 };
  if (!res.ok) return { error: "Bluesky login returned HTTP " + res.status + ".", status: 502 };
  const data = await res.json().catch(() => null);
  if (!data || !data.accessJwt) return { error: "Bluesky login response was unexpected.", status: 502 };
  return { jwt: data.accessJwt };
}

async function handleSearchTest(request, url, env) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const missing = ["ADMIN_TOKEN", "BSKY_IDENTIFIER", "BSKY_APP_PASSWORD"].filter((k) => !env[k]);
  if (missing.length) return json({ error: "Server is missing secret(s): " + missing.join(", ") }, 500);

  const token = request.headers.get("x-admin-token") || "";
  if (!safeEqual(token, env.ADMIN_TOKEN)) return json({ error: "Wrong admin token." }, 401);

  const q = (url.searchParams.get("q") || "").trim();
  const cursor = url.searchParams.get("cursor") || "";
  if (q.length < 1 || q.length > 200) return json({ error: "Search phrase must be 1 to 200 characters." }, 400);
  if (cursor.length > 500) return json({ error: "Invalid cursor." }, 400);

  const session = await login(env);
  if (session.error) return json({ error: session.error }, session.status);

  const u = new URL(PDS + "/app.bsky.feed.searchPosts");
  u.searchParams.set("q", q);
  u.searchParams.set("sort", "latest");
  u.searchParams.set("limit", "25");
  if (cursor) u.searchParams.set("cursor", cursor);

  let res;
  try {
    res = await fetch(u.toString(), { headers: { authorization: "Bearer " + session.jwt } });
  } catch (e) {
    return json({ error: "Could not reach Bluesky search." }, 502);
  }
  if (res.status === 429) return json({ error: "Bluesky search rate limited. Retry later." }, 429);
  if (!res.ok) return json({ error: "Bluesky search returned HTTP " + res.status + "." }, 502);

  const data = await res.json().catch(() => null);
  if (!data) return json({ error: "Bluesky search sent invalid JSON." }, 502);
  const posts = (Array.isArray(data.posts) ? data.posts : []).map(normalizePost).filter(Boolean);
  return json({ ok: true, posts: posts, cursor: data.cursor || null, hits: data.hitsTotal == null ? null : data.hitsTotal });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/search-test") return await handleSearchTest(request, url, env);
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: "Unexpected server error." }, 500);
    }
  }
};
