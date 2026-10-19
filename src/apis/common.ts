export function textResult(text: string): object {
  return { content: [{ type: "text", text }] };
}

export async function fetchJsonApi(url: string, headers: HeadersInit = {}, timeoutMs = 30_000): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
  return response.json();
}

export async function fetchJsonCached(url: string, headers: HeadersInit = {}, timeoutMs = 30_000, ttlSeconds = 1800): Promise<unknown> {
  const cache = await caches.open("default");
  const key = new Request(`https://weather-cache.invalid/${encodeURIComponent(url)}`);
  const cached = await cache.match(key);
  if (cached) return cached.json();
  const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
  const body = await response.text();
  await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttlSeconds}` } }));
  return JSON.parse(body);
}
