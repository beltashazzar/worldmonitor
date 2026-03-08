import { createCircuitBreaker } from '@/utils';

export type XSentimentSeverity = 'critical' | 'high' | 'medium';
export type XSentimentCategory = 'conflict' | 'disaster' | 'political' | 'economic' | 'health' | 'cyber';

export interface XSentimentEvent {
  id: string;
  headline: string;
  summary: string;
  location: string;
  lat: number;
  lon: number;
  severity: XSentimentSeverity;
  category: XSentimentCategory;
  cachedAt: string;
}

interface ApiXSentimentEvent {
  headline: string;
  summary: string;
  location: string;
  lat: number;
  lon: number;
  severity: string;
  category: string;
}

const xSentimentBreaker = createCircuitBreaker<XSentimentEvent[]>({
  name: 'X Sentiment',
  cacheTtlMs: 30 * 60 * 1000,
});

async function fetchXSentimentEvents(): Promise<XSentimentEvent[]> {
  return xSentimentBreaker.execute(async () => {
    const response = await fetch('/api/x-sentiment', {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const result = await response.json();
    if (result.configured === false) throw new Error('X sentiment not configured');

    const events: ApiXSentimentEvent[] = result.data || [];
    const cachedAt = result.cached_at || new Date().toISOString();

    return events.map((e, i): XSentimentEvent => ({
      id: `xpulse-${i}-${Date.now()}`,
      headline: e.headline,
      summary: e.summary,
      location: e.location,
      lat: e.lat,
      lon: e.lon,
      severity: e.severity as XSentimentSeverity,
      category: e.category as XSentimentCategory,
      cachedAt,
    }));
  }, []);
}

export async function fetchXSentiment(): Promise<XSentimentEvent[]> {
  const events = await fetchXSentimentEvents();
  console.log(`[X Sentiment] Fetched ${events.length} events`);
  return events;
}

export function getXSentimentBreaker() {
  return xSentimentBreaker;
}
