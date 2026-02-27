// OpenSky Network API proxy - v4
// Added server-side in-memory cache to avoid burning OpenSky rate limits.
// Cache TTL (600s) exceeds client poll interval (300s) so most requests
// are served from cache without hitting OpenSky.
export const config = { runtime: 'edge' };

const CACHE_TTL_MS = 600_000; // 10 minutes
const cache = new Map(); // key: sorted query params → { data, expiresAt }

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}, 60_000).unref?.();

export default async function handler(req) {
  const url = new URL(req.url);

  // Build cache key from bounding box params
  const paramKeys = ['lamin', 'lomin', 'lamax', 'lomax'];
  const parts = paramKeys.map(k => `${k}=${url.searchParams.get(k) || ''}`);
  const cacheKey = parts.join('&');

  // Serve from cache if fresh
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return Response.json(cached.data, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=15',
        'X-Cache': 'HIT',
      },
    });
  }

  // Build OpenSky API URL with bounding box params
  const params = new URLSearchParams();
  paramKeys.forEach(key => {
    const val = url.searchParams.get(key);
    if (val) params.set(key, val);
  });

  const openskyUrl = `https://opensky-network.org/api/states/all${params.toString() ? '?' + params.toString() : ''}`;

  try {
    const response = await fetch(openskyUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
    });

    if (response.status === 429) {
      // Rate limited — serve stale cache if available, otherwise error
      if (cached) {
        return Response.json(cached.data, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=30',
            'X-Cache': 'STALE',
          },
        });
      }
      return Response.json({ error: 'Rate limited', time: Date.now(), states: null }, {
        status: 429,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (!response.ok) {
      const text = await response.text();
      return Response.json({
        error: `OpenSky HTTP ${response.status}: ${text.substring(0, 200)}`,
        time: Date.now(),
        states: null
      }, {
        status: response.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    const data = await response.json();

    // Store in cache
    cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });

    return Response.json(data, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=15',
        'X-Cache': 'MISS',
      },
    });
  } catch (error) {
    // On fetch error, serve stale cache if available
    if (cached) {
      return Response.json(cached.data, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=30',
          'X-Cache': 'STALE',
        },
      });
    }
    return Response.json({
      error: `Fetch failed: ${error.name} - ${error.message}`,
      time: Date.now(),
      states: null
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}
