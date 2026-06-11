// UCDP (Uppsala Conflict Data Program) proxy
// Returns conflict classification per country with intensity levels
// As of 2026 the UCDP API requires an access token (x-ucdp-access-token header).
// Token is free but manually issued — email mertcan.yilmaz@pcr.uu.se. Set it via
// the UCDP_ACCESS_TOKEN env var; without it UCDP returns 401 and this panel stays empty.
export const config = { runtime: 'edge' };

// Build request headers, attaching the UCDP token when configured.
const ucdpHeaders = () => {
  const token = (typeof process !== 'undefined' && process.env && process.env.UCDP_ACCESS_TOKEN) || '';
  const headers = { 'Accept': 'application/json' };
  if (token) headers['x-ucdp-access-token'] = token;
  return headers;
};

import { getCachedJson, setCachedJson } from './_upstash-cache.js';
import { recordCacheTelemetry } from './_cache-telemetry.js';

const CACHE_KEY = 'ucdp:country-conflicts:v2';
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours (annual data)
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;
const RESPONSE_CACHE_CONTROL = 'public, max-age=3600';

// In-memory fallback when Redis is unavailable.
let fallbackCache = { data: null, timestamp: 0 };

function isValidResult(data) {
  return Boolean(
    data &&
    typeof data === 'object' &&
    Array.isArray(data.conflicts)
  );
}

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'unknown error');
}

export default async function handler(req) {
  const now = Date.now();
  const cached = await getCachedJson(CACHE_KEY);
  if (isValidResult(cached)) {
    recordCacheTelemetry('/api/ucdp', 'REDIS-HIT');
    return Response.json(cached, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': RESPONSE_CACHE_CONTROL,
        'X-Cache': 'REDIS-HIT',
      },
    });
  }

  if (isValidResult(fallbackCache.data) && now - fallbackCache.timestamp < CACHE_TTL_MS) {
    recordCacheTelemetry('/api/ucdp', 'MEMORY-HIT');
    return Response.json(fallbackCache.data, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': RESPONSE_CACHE_CONTROL,
        'X-Cache': 'MEMORY-HIT',
      },
    });
  }

  try {
    // Fetch all pages of conflicts
    let allConflicts = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
      const response = await fetch(`https://ucdpapi.pcr.uu.se/api/ucdpprioconflict/24.1?pagesize=100&page=${page}`, {
        headers: ucdpHeaders(),
      });

      if (!response.ok) {
        throw new Error(`UCDP API error: ${response.status}`);
      }

      const rawData = await response.json();
      totalPages = rawData.TotalPages || 1;
      const conflicts = rawData.Result || [];
      allConflicts = allConflicts.concat(conflicts);
      page++;
    }

    // Fields are snake_case: conflict_id, location, side_a, side_b, year, intensity_level, type_of_conflict
    const countryConflicts = {};
    for (const c of allConflicts) {
      const name = c.location || '';
      const year = parseInt(c.year, 10) || 0;
      const intensity = parseInt(c.intensity_level, 10) || 0;

      const entry = {
        conflictId: parseInt(c.conflict_id, 10) || 0,
        conflictName: c.side_b || '',
        location: name,
        year,
        intensityLevel: intensity,
        typeOfConflict: parseInt(c.type_of_conflict, 10) || 0,
        startDate: c.start_date,
        startDate2: c.start_date2,
        sideA: c.side_a,
        sideB: c.side_b,
        region: c.region,
      };

      // Keep most recent / highest intensity per location
      if (!countryConflicts[name] || year > countryConflicts[name].year ||
          (year === countryConflicts[name].year && intensity > countryConflicts[name].intensityLevel)) {
        countryConflicts[name] = entry;
      }
    }

    const result = {
      success: true,
      count: Object.keys(countryConflicts).length,
      conflicts: Object.values(countryConflicts),
      cached_at: new Date().toISOString(),
    };

    fallbackCache = { data: result, timestamp: now };
    void setCachedJson(CACHE_KEY, result, CACHE_TTL_SECONDS);
    recordCacheTelemetry('/api/ucdp', 'MISS');

    return Response.json(result, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': RESPONSE_CACHE_CONTROL,
        'X-Cache': 'MISS',
      },
    });
  } catch (error) {
    if (isValidResult(fallbackCache.data)) {
      recordCacheTelemetry('/api/ucdp', 'STALE');
      return Response.json(fallbackCache.data, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=600, s-maxage=600, stale-while-revalidate=120',
          'X-Cache': 'STALE',
        },
      });
    }

    recordCacheTelemetry('/api/ucdp', 'ERROR');
    return Response.json({ error: `Fetch failed: ${toErrorMessage(error)}`, conflicts: [] }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}
