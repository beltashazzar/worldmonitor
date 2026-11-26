/**
 * Reloads the page once a week, Sunday 04:04 America/New_York (Daniel, 2026-11-25).
 *
 * The office screen is a 4 GB MacBook Air whose Safari tab had grown to ~5 GB (peak 8.3 GB)
 * after 17 days, with 3.4 GB in swap; a fresh tab sits at ~0.6 GB. A weekly reload caps that.
 * The cost: the 24-hour geo-convergence window and the risk score restart from a fresh-tab
 * baseline early on Sunday morning.
 *
 * It never reloads under someone's hands: it waits until 10 minutes pass with no input, as long
 * as that happens before the day ends, and never while the Live News panel is playing video.
 * Input inside an iframe (the heatmap, a YouTube player) never reaches this window, so watching
 * video would otherwise look idle. A page that has just reloaded counts as loaded after the
 * slot, so the reload cannot loop.
 */
const TIME_ZONE = 'America/New_York';
const RELOAD_WEEKDAY = 'Sun';
const RELOAD_MINUTE_OF_DAY = 4 * 60 + 4;
const IDLE_REQUIRED_MS = 10 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 1000;

const etFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function etParts(epochMs: number): { date: string; weekday: string; minuteOfDay: number } {
  const parts = Object.fromEntries(etFormat.formatToParts(new Date(epochMs)).map(p => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday ?? '',
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Pure decision, exported for tests. */
export function isWeeklyReloadDue(loadedAt: number, now: number, lastInputAt: number): boolean {
  const n = etParts(now);
  if (n.weekday !== RELOAD_WEEKDAY || n.minuteOfDay < RELOAD_MINUTE_OF_DAY) return false;
  const l = etParts(loadedAt);
  if (l.date === n.date && l.minuteOfDay >= RELOAD_MINUTE_OF_DAY) return false; // already reloaded this slot
  return now - lastInputAt >= IDLE_REQUIRED_MS;
}

export function startWeeklyReload(): void {
  // Same clock as the checks below: performance.timeOrigin can disagree with Date.now().
  const loadedAt = Date.now();
  let lastInputAt = Date.now();
  const touch = () => { lastInputAt = Date.now(); };
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, touch, { passive: true, capture: true });
  }
  setInterval(() => {
    // `.panel` matters: the Panels settings list also carries data-panel="live-news".
    const watchingVideo = !!document.querySelector('.panel[data-panel="live-news"]:not(.live-news-heatmap-mode)');
    if (!watchingVideo && isWeeklyReloadDue(loadedAt, Date.now(), lastInputAt)) {
      console.log('[weekly-reload] Sunday 04:04 ET slot reached and idle for 10 min: reloading');
      location.reload();
    }
  }, CHECK_EVERY_MS);
}
