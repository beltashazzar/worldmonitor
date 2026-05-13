// X Sentiment API - global crisis events from X/Twitter via xAI Grok
// Uses xAI Responses API with x_search + web_search tools
// LLM_CAPABILITY_TIER: x-sentiment (requires xAI x_search tool)
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getCachedJson, setCachedJson } from './_upstash-cache.js';
import { recordCacheTelemetry } from './_cache-telemetry.js';
import { createIpRateLimiter } from './_ip-rate-limit.js';

export const config = { runtime: 'edge' };

const CACHE_KEY = 'x-sentiment:v1';
const CACHE_TTL_SECONDS = 30 * 60;
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;

let fallbackCache = { data: null, timestamp: 0 };

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 1000;
const rateLimiter = createIpRateLimiter({
  limit: RATE_LIMIT,
  windowMs: RATE_WINDOW_MS,
  maxEntries: 5000,
});

function getClientIp(req) {
  return req.headers.get('x-forwarded-for')?.split(',')[0] ||
    req.headers.get('x-real-ip') ||
    'unknown';
}

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'unknown error');
}

const SYSTEM_PROMPT = `You are a global crisis analyst. Search X/Twitter and the web for the 6 most significant global crises, conflicts, disasters, or major geopolitical events in the last 12 hours.

Return ONLY a valid JSON array with exactly 6 items. Each item must have:
- "headline": concise headline (under 80 chars)
- "summary": 2-3 sentence summary of what's happening and X/Twitter sentiment
- "location": "City, Country" or "Region, Country"
- "lat": latitude as a number
- "lon": longitude as a number
- "severity": one of "critical", "high", or "medium"
- "category": one of "conflict", "disaster", "political", "economic", "health", "cyber"

Prioritize events with high social media engagement, breaking developments, and human impact.
Ensure geographic diversity — avoid clustering all events in one region.
Return ONLY the JSON array, no markdown, no explanation.`;

function extractJsonArray(text) {
  // Try direct parse first
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* continue */ }

  // Try to find JSON array in the text
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch { /* continue */ }
  }
  return null;
}

function validateEvent(e) {
  return (
    typeof e.headline === 'string' && e.headline.length > 0 &&
    typeof e.summary === 'string' &&
    typeof e.location === 'string' &&
    typeof e.lat === 'number' && Number.isFinite(e.lat) && e.lat !== 0 &&
    typeof e.lon === 'number' && Number.isFinite(e.lon) && e.lon !== 0 &&
    ['critical', 'high', 'medium'].includes(e.severity) &&
    ['conflict', 'disaster', 'political', 'economic', 'health', 'cyber'].includes(e.category)
  );
}

function sanitizeEvent(e) {
  return {
    headline: String(e.headline).substring(0, 120),
    summary: String(e.summary).substring(0, 500),
    location: String(e.location).substring(0, 100),
    lat: e.lat,
    lon: e.lon,
    severity: e.severity,
    category: e.category,
  };
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    if (isDisallowedOrigin(req)) {
      return new Response(null, { status: 403, headers: corsHeaders });
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return Response.json({ error: 'Method not allowed', data: [] }, {
      status: 405,
      headers: corsHeaders,
    });
  }

  if (isDisallowedOrigin(req)) {
    return Response.json({ error: 'Origin not allowed', data: [] }, {
      status: 403,
      headers: corsHeaders,
    });
  }

  const ip = getClientIp(req);
  if (!rateLimiter.check(ip)) {
    return Response.json({ error: 'Rate limited', data: [] }, {
      status: 429,
      headers: {
        ...corsHeaders,
        'Retry-After': '60',
      },
    });
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'X sentiment not configured', data: [], configured: false }, {
      status: 200,
      headers: corsHeaders,
    });
  }

  const now = Date.now();
  const cached = await getCachedJson(CACHE_KEY);
  if (cached && typeof cached === 'object' && Array.isArray(cached.data)) {
    recordCacheTelemetry('/api/x-sentiment', 'REDIS-HIT');
    return Response.json(cached, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
        'X-Cache': 'REDIS-HIT',
      },
    });
  }

  if (fallbackCache.data && now - fallbackCache.timestamp < CACHE_TTL_MS) {
    recordCacheTelemetry('/api/x-sentiment', 'MEMORY-HIT');
    return Response.json(fallbackCache.data, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
        'X-Cache': 'MEMORY-HIT',
      },
    });
  }

  try {
    const response = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.XAI_MODEL || 'grok-4.3',
        tools: [
          { type: 'web_search' },
          { type: 'x_search' },
        ],
        input: SYSTEM_PROMPT,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[x-sentiment] xAI API error ${response.status}: ${text.substring(0, 200)}`);
      throw new Error(`xAI API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract output text from Responses API format
    let outputText = '';
    for (const item of data.output || []) {
      if (item.type === 'message') {
        for (const content of item.content || []) {
          if (content.type === 'output_text') {
            outputText = content.text;
            break;
          }
        }
        if (outputText) break;
      }
    }
    if (!outputText && data.output_text) {
      outputText = data.output_text;
    }

    if (!outputText) {
      throw new Error('No output text from xAI');
    }

    const events = extractJsonArray(outputText);
    if (!events) {
      console.error('[x-sentiment] Failed to parse JSON from response:', outputText.substring(0, 300));
      throw new Error('Failed to parse events JSON');
    }

    const validated = events
      .filter(validateEvent)
      .map(sanitizeEvent)
      .slice(0, 6);

    const result = {
      success: true,
      count: validated.length,
      data: validated,
      cached_at: new Date().toISOString(),
    };

    fallbackCache = { data: result, timestamp: now };
    void setCachedJson(CACHE_KEY, result, CACHE_TTL_SECONDS);
    recordCacheTelemetry('/api/x-sentiment', 'MISS');

    return Response.json(result, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
        'X-Cache': 'MISS',
      },
    });
  } catch (error) {
    if (fallbackCache.data) {
      recordCacheTelemetry('/api/x-sentiment', 'STALE');
      return Response.json(fallbackCache.data, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=30',
          'X-Cache': 'STALE',
        },
      });
    }

    recordCacheTelemetry('/api/x-sentiment', 'ERROR');
    return Response.json({ error: `Fetch failed: ${toErrorMessage(error)}`, data: [] }, {
      status: 500,
      headers: corsHeaders,
    });
  }
}
