export const config = { runtime: 'edge' };

// The map shows quakes from M4.0 up, fading out over a seven-day decay, so this needs a
// WEEK of data down to M4.0 — the 4.5_day feed this used to proxy could satisfy neither.
// 2.5_week is the narrowest USGS summary that spans the whole range; filtering to M4.0
// here rather than in the browser drops it from ~260KB to ~115KB, and the shape stays
// GeoJSON so the client parser is unchanged.
const USGS_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson';
const MIN_MAGNITUDE = 4.0;

export default async function handler() {
  try {
    const response = await fetch(USGS_FEED, { headers: { 'Accept': 'application/json' } });

    if (!response.ok) {
      return new Response(await response.text(), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const data = await response.json();
    const features = Array.isArray(data.features)
      ? data.features.filter(f => (f?.properties?.mag ?? 0) >= MIN_MAGNITUDE)
      : [];

    return new Response(JSON.stringify({ ...data, features }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: `Fetch failed: ${error.message}` }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
