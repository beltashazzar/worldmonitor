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


// ── Keyless military ADS-B fallback ───────────────────────────────────────────
// OpenSky 429s every anonymous request we make, which left the map's military layer
// empty the moment its cache was lost. adsb.lol and adsb.fi publish a global military
// snapshot with no key and no quota, so it leads here and OpenSky becomes the fallback.
//
// The snapshot is fetched ONCE and shared by every bounding-box query — the client asks
// for four boxes per poll, and re-fetching the world for each would be wasteful and rude.
//
// Responses are shaped as OpenSky state vectors so src/services/military-flights.ts needs
// no change. ⚠️ That means converting back into OpenSky's units: it reports metres and
// m/s and the client multiplies them out to feet and knots, whereas ADS-B publishes feet
// and knots directly. Emitting the raw ADS-B numbers here would read ~3.3x high.
const ADSB_MIL_ENDPOINTS = [
  'https://api.adsb.lol/v2/mil',
  'https://opendata.adsb.fi/api/v2/mil',
];
const ADSB_SNAPSHOT_TTL_MS = 60_000;
const FT_TO_M = 0.3048;
const KT_TO_MS = 0.514444;
const FTMIN_TO_MS = 0.00508;

let adsbSnapshot = { aircraft: [], expiresAt: 0, source: null };
let adsbInflight = null;

async function fetchAdsbSnapshot() {
  const now = Date.now();
  if (adsbSnapshot.expiresAt > now) return adsbSnapshot;
  if (adsbInflight) return adsbInflight;

  adsbInflight = (async () => {
    let lastError = null;
    for (const url of ADSB_MIL_ENDPOINTS) {
      const host = new URL(url).host;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'WorldMonitor/1.0 (+https://worldmonitor.app)',
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`ADS-B ${host} error: ${response.status}`);
        const data = await response.json();
        const aircraft = Array.isArray(data.ac) ? data.ac : [];
        if (aircraft.length === 0) throw new Error(`ADS-B ${host} returned no aircraft`);
        adsbSnapshot = { aircraft, expiresAt: Date.now() + ADSB_SNAPSHOT_TTL_MS, source: host };
        console.log(`[OpenSkyProxy] ADS-B snapshot from ${host}: ${aircraft.length} aircraft`);
        return adsbSnapshot;
      } catch (err) {
        lastError = err;
        console.warn('[OpenSkyProxy] ADS-B source failed:', err.message);
      } finally {
        clearTimeout(timeoutId);
      }
    }
    throw lastError || new Error('No ADS-B source returned data');
  })().finally(() => { adsbInflight = null; });

  return adsbInflight;
}

// Shape ADS-B aircraft as OpenSky state vectors, clipped to the requested bounding box.
// Index 2 (origin_country) is left blank: these feeds do not carry it, and the client
// attributes by hex range and callsign anyway, using it only as a hint.
function toOpenSkyStates(aircraft, box) {
  const states = [];
  for (const a of aircraft) {
    if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
    if (box && (a.lat < box.lamin || a.lat > box.lamax || a.lon < box.lomin || a.lon > box.lomax)) continue;

    const baroFt = typeof a.alt_baro === 'number' ? a.alt_baro : null;
    const geomFt = typeof a.alt_geom === 'number' ? a.alt_geom : null;

    const state = new Array(17).fill(null);
    state[0] = String(a.hex || '').trim();
    state[1] = String(a.flight || '').trim();
    state[2] = '';
    state[5] = a.lon;
    state[6] = a.lat;
    state[7] = baroFt === null ? null : baroFt * FT_TO_M;
    state[8] = a.alt_baro === 'ground';
    state[9] = typeof a.gs === 'number' ? a.gs * KT_TO_MS : null;
    state[10] = typeof a.track === 'number' ? a.track : null;
    state[11] = typeof a.baro_rate === 'number' ? a.baro_rate * FTMIN_TO_MS : null;
    state[13] = geomFt === null ? null : geomFt * FT_TO_M;
    state[14] = a.squawk || null;
    if (!state[0]) continue;
    states.push(state);
  }
  return states;
}

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

  // ADS-B first — see the note above; OpenSky is the fallback because it rate-limits us.
  const box = ['lamin', 'lomin', 'lamax', 'lomax'].every(k => url.searchParams.get(k))
    ? {
        lamin: Number(url.searchParams.get('lamin')),
        lomin: Number(url.searchParams.get('lomin')),
        lamax: Number(url.searchParams.get('lamax')),
        lomax: Number(url.searchParams.get('lomax')),
      }
    : null;

  try {
    const snapshot = await fetchAdsbSnapshot();
    const data = { time: Math.floor(Date.now() / 1000), states: toOpenSkyStates(snapshot.aircraft, box) };
    cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return Response.json(data, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=15',
        'X-Cache': 'MISS',
        'X-Source': `adsb:${snapshot.source}`,
      },
    });
  } catch (adsbError) {
    console.warn('[OpenSkyProxy] ADS-B unavailable, trying OpenSky:', adsbError.message);
  }

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
