const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const videoId = /^[A-Za-z0-9_-]{11}$/;

function json(status: number, value: object) {
  return Response.json(value, { status, headers: { ...cors, "Cache-Control": "no-store" } });
}

function failure(status: number, code: string) {
  return json(status, { code });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return failure(405, "method_not_allowed");
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return failure(401, "session_required");

  const data = await request.json().catch(() => null);
  const query = typeof data?.query === "string" ? data.query.trim() : "";
  if (query.length < 2 || query.length > 120 || typeof data?.space !== "string" || !uuid.test(data.space))
    return failure(400, "invalid_search");

  const base = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !anon || !service) return failure(503, "unavailable");

  try {
    const user = await fetch(base + "/auth/v1/user", {
      headers: { apikey: anon, authorization },
      signal: AbortSignal.timeout(5000),
    });
    if (user.status === 401 || user.status === 403) return failure(401, "session_required");
    if (!user.ok) return failure(503, "unavailable");
    const { id } = await user.json();
    if (typeof id !== "string" || !uuid.test(id)) return failure(401, "session_required");

    const key = Deno.env.get("YOUTUBE_API_KEY");
    if (!key) return failure(503, "not_configured");
    const quota = await fetch(base + "/rest/v1/rpc/take_youtube_search", {
      method: "POST",
      headers: { apikey: service, authorization: "Bearer " + service, "Content-Type": "application/json" },
      body: JSON.stringify({ search_space: data.space, search_user: id }),
      signal: AbortSignal.timeout(5000),
    });
    if (!quota.ok) return failure(503, "unavailable");
    const decision = await quota.json();
    if (decision === "pair_required") return failure(403, decision);
    if (decision === "daily_limit" || decision === "slow_down") return failure(429, decision);
    if (decision !== "allowed") return failure(503, "unavailable");

    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: "6",
      q: query,
      fields: "items(id/videoId,snippet(title,channelTitle))",
    });
    const result = await fetch("https://www.googleapis.com/youtube/v3/search?" + params, {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (result.status === 403 || result.status === 429) {
      const error = await result.json().catch(() => null);
      const reason = error?.error?.errors?.[0]?.reason;
      if (result.status === 429 || reason === "quotaExceeded" || reason === "dailyLimitExceeded")
        return failure(429, "daily_limit");
    }
    if (!result.ok) return failure(502, "unavailable");

    const { items } = await result.json() as {
      items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }>;
    };
    const videos = (items ?? []).flatMap(({ id, snippet }) => {
      if (!id?.videoId || !videoId.test(id.videoId) || !snippet?.title) return [];
      return [{ id: id.videoId, title: snippet.title, channel: snippet.channelTitle ?? "" }];
    });
    return json(200, { videos });
  } catch {
    return failure(502, "unavailable");
  }
});
