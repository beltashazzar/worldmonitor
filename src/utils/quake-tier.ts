// Earthquake severity tiers, shared by the map rings (DeckGLMap) and the click popup
// (MapPopup) so the two can never disagree. Labels follow USGS wording for each whole
// magnitude band. The feed is floored at M4.0 server-side, so 'light' is the lowest tier
// that ever reaches the map.

export interface QuakeTier {
  label: 'LIGHT' | 'MODERATE' | 'STRONG' | 'MAJOR';
  rgb: [number, number, number];
  /** Text colour that stays legible on a badge filled with `rgb`. */
  onFill: string;
}

const LIGHT: QuakeTier = { label: 'LIGHT', rgb: [80, 80, 80], onFill: '#e0e0e0' };
const MODERATE: QuakeTier = { label: 'MODERATE', rgb: [160, 160, 160], onFill: '#000' };
const STRONG: QuakeTier = { label: 'STRONG', rgb: [255, 140, 0], onFill: '#000' };
const MAJOR: QuakeTier = { label: 'MAJOR', rgb: [255, 0, 0], onFill: '#fff' };

export function quakeTier(magnitude: number | null | undefined): QuakeTier {
  const mag = magnitude ?? 0;
  if (mag >= 7) return MAJOR;
  if (mag >= 6) return STRONG;
  if (mag >= 5) return MODERATE;
  return LIGHT;
}
