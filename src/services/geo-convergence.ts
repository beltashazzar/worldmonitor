import type { SocialUnrestEvent, MilitaryFlight, MilitaryVessel, Earthquake } from '@/types';
import { generateSignalId } from '@/utils/analysis-constants';
import type { CorrelationSignalCore } from './analysis-core';
import { INTEL_HOTSPOTS, CONFLICT_ZONES, STRATEGIC_WATERWAYS } from '@/config/geo';

export type GeoEventType = 'protest' | 'military_flight' | 'military_vessel' | 'earthquake';

// Each type holds the DISTINCT events seen in the cell (event key -> last seen), not a tally.
// Every poll re-delivers the same aircraft, vessels and quakes, so a counter grew with how long
// the tab had been open rather than with what was happening: a screen left up for a day showed
// far higher convergence scores than a fresh one. The size of the map is the event count.
interface GeoCell {
  id: string;
  lat: number;
  lon: number;
  events: Map<GeoEventType, Map<string, Date>>;
  firstSeen: Date;
}

const cells = new Map<string, GeoCell>();
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CONVERGENCE_THRESHOLD = 3;

export function getCellId(lat: number, lon: number): string {
  return `${Math.floor(lat)},${Math.floor(lon)}`;
}

export function ingestGeoEvent(
  lat: number,
  lon: number,
  type: GeoEventType,
  key: string,
  timestamp: Date = new Date()
): void {
  const cellId = getCellId(lat, lon);

  let cell = cells.get(cellId);
  if (!cell) {
    cell = {
      id: cellId,
      lat: Math.floor(lat) + 0.5,
      lon: Math.floor(lon) + 0.5,
      events: new Map(),
      firstSeen: timestamp,
    };
    cells.set(cellId, cell);
  }

  let seen = cell.events.get(type);
  if (!seen) {
    seen = new Map();
    cell.events.set(type, seen);
  }
  const previous = seen.get(key);
  if (!previous || timestamp.getTime() > previous.getTime()) {
    seen.set(key, timestamp);
  }
}

function eventCount(cell: GeoCell): number {
  let total = 0;
  for (const seen of cell.events.values()) total += seen.size;
  return total;
}

function pruneOldEvents(): void {
  const cutoff = Date.now() - WINDOW_MS;

  for (const [cellId, cell] of cells) {
    for (const [type, seen] of cell.events) {
      for (const [key, lastSeen] of seen) {
        if (lastSeen.getTime() < cutoff) seen.delete(key);
      }
      if (seen.size === 0) cell.events.delete(type);
    }
    if (cell.events.size === 0) {
      cells.delete(cellId);
    }
  }
}

export function ingestProtests(events: SocialUnrestEvent[]): void {
  for (const e of events) {
    ingestGeoEvent(e.lat, e.lon, 'protest', e.id, e.time);
  }
}

export function ingestFlights(flights: MilitaryFlight[]): void {
  for (const f of flights) {
    ingestGeoEvent(f.lat, f.lon, 'military_flight', f.hexCode || f.id, f.lastSeen);
  }
}

export function ingestVessels(vessels: MilitaryVessel[]): void {
  for (const v of vessels) {
    ingestGeoEvent(v.lat, v.lon, 'military_vessel', v.mmsi || v.id, v.lastAisUpdate);
  }
}

export function ingestEarthquakes(quakes: Earthquake[]): void {
  for (const q of quakes) {
    ingestGeoEvent(q.lat, q.lon, 'earthquake', q.id, q.time);
  }
}

export interface GeoConvergenceAlert {
  cellId: string;
  lat: number;
  lon: number;
  types: GeoEventType[];
  totalEvents: number;
  score: number;
}

export function detectGeoConvergence(seenAlerts: Set<string>): GeoConvergenceAlert[] {
  pruneOldEvents();

  const alerts: GeoConvergenceAlert[] = [];

  for (const [cellId, cell] of cells) {
    if (cell.events.size >= CONVERGENCE_THRESHOLD) {
      if (seenAlerts.has(cellId)) continue;

      const types = Array.from(cell.events.keys());
      const totalEvents = eventCount(cell);

      const typeScore = cell.events.size * 25;
      const countBoost = Math.min(25, totalEvents * 2);
      const score = Math.min(100, typeScore + countBoost);

      alerts.push({ cellId, lat: cell.lat, lon: cell.lon, types, totalEvents, score });
      seenAlerts.add(cellId);
    }
  }

  return alerts.sort((a, b) => b.score - a.score);
}

const TYPE_LABELS: Record<GeoEventType, string> = {
  protest: 'protests',
  military_flight: 'military flights',
  military_vessel: 'naval vessels',
  earthquake: 'seismic activity',
};

// Haversine distance in km
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Reverse geocode coordinates to human-readable location
export function getLocationName(lat: number, lon: number): string {
  // Check conflict zones first (most relevant for convergence)
  for (const zone of CONFLICT_ZONES) {
    const [zoneLon, zoneLat] = zone.center;
    const dist = haversineKm(lat, lon, zoneLat, zoneLon);
    if (dist < 300) {
      return zone.name.replace(' Conflict', '').replace(' Civil War', '');
    }
  }

  // Check strategic waterways
  for (const waterway of STRATEGIC_WATERWAYS) {
    const dist = haversineKm(lat, lon, waterway.lat, waterway.lon);
    if (dist < 200) {
      return waterway.name;
    }
  }

  // Check intel hotspots (major cities)
  let nearestHotspot: { name: string; dist: number } | null = null;
  for (const hotspot of INTEL_HOTSPOTS) {
    const dist = haversineKm(lat, lon, hotspot.lat, hotspot.lon);
    if (dist < 150 && (!nearestHotspot || dist < nearestHotspot.dist)) {
      nearestHotspot = { name: hotspot.name, dist };
    }
  }
  if (nearestHotspot) {
    // Return just the name - caller adds "in" prefix
    return nearestHotspot.name;
  }

  // Regional fallback based on lat/lon ranges
  if (lat >= 25 && lat <= 40 && lon >= 25 && lon <= 75) return 'Middle East';
  if (lat >= 30 && lat <= 45 && lon >= 100 && lon <= 145) return 'East Asia';
  if (lat >= -10 && lat <= 25 && lon >= 90 && lon <= 130) return 'Southeast Asia';
  if (lat >= 35 && lat <= 70 && lon >= -10 && lon <= 40) return 'Europe';
  if (lat >= 44 && lat <= 75 && lon >= 20 && lon <= 180) return 'Russia';
  if (lat >= -35 && lat <= 35 && lon >= -20 && lon <= 55) return 'Africa';
  if (lat >= 25 && lat <= 50 && lon >= -125 && lon <= -65) return 'North America';
  if (lat >= -60 && lat <= 15 && lon >= -80 && lon <= -30) return 'South America';

  return `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
}

export function geoConvergenceToSignal(alert: GeoConvergenceAlert): CorrelationSignalCore {
  const typeDescriptions = alert.types.map(t => TYPE_LABELS[t]).join(', ');
  const locationName = getLocationName(alert.lat, alert.lon);

  return {
    id: generateSignalId(),
    type: 'geo_convergence',
    title: `Geographic Convergence (${alert.types.length} types)`,
    description: `${typeDescriptions} in ${locationName} - ${alert.totalEvents} events/24h`,
    confidence: alert.score / 100,
    timestamp: new Date(),
    data: {
      newsVelocity: alert.totalEvents,
      relatedTopics: alert.types,
    },
  };
}

export function detectConvergence(): GeoConvergenceAlert[] {
  return detectGeoConvergence(new Set());
}

export function clearCells(): void {
  cells.clear();
}

export function getCellCount(): number {
  return cells.size;
}

export function debugInjectTestEvents(): void {
  const now = new Date();
  const testLat = 25.5;
  const testLon = 121.5;
  ingestGeoEvent(testLat, testLon, 'protest', 'debug-protest', now);
  ingestGeoEvent(testLat, testLon, 'military_flight', 'debug-military_flight', now);
  ingestGeoEvent(testLat, testLon, 'military_vessel', 'debug-military_vessel', now);
  ingestGeoEvent(testLat + 0.3, testLon + 0.2, 'earthquake', 'debug-earthquake', now);
  console.log('[GeoConvergence] Injected 4 test events at Taiwan Strait region');
}

export function debugGetCells(): Map<string, unknown> {
  return new Map(cells);
}

export function getAlertsNearLocation(lat: number, lon: number, radiusKm: number): { score: number; types: number } | null {
  pruneOldEvents();

  let maxScore = 0;
  let maxTypes = 0;

  for (const cell of cells.values()) {
    const dist = haversineKm(lat, lon, cell.lat, cell.lon);
    if (dist <= radiusKm && cell.events.size >= 2) {
      const types = cell.events.size;
      const totalEvents = eventCount(cell);
      const typeScore = types * 25;
      const countBoost = Math.min(25, totalEvents * 2);
      const score = Math.min(100, typeScore + countBoost);

      if (score > maxScore) {
        maxScore = score;
        maxTypes = types;
      }
    }
  }

  return maxScore > 0 ? { score: maxScore, types: maxTypes } : null;
}
