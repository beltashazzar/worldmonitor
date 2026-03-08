import { Panel } from './Panel';
import type { PredictionMarket } from '@/types';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

export class PredictionPanel extends Panel {
  private lastUpdated: Date | null = null;

  constructor() {
    super({
      id: 'polymarket',
      title: 'Prediction Markets',
      infoTooltip: `<strong>Prediction Markets</strong>
        Real-money forecasting markets:
        <ul>
          <li>Prices reflect crowd probability estimates</li>
          <li>Higher volume = more reliable signal</li>
          <li>Geopolitical and current events focus</li>
        </ul>
        Source: Polymarket (polymarket.com)`,
    });
  }

  private formatVolume(volume?: number): string {
    if (!volume) return '';
    if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(1)}M`;
    if (volume >= 1_000) return `$${(volume / 1_000).toFixed(0)}K`;
    return `$${volume.toFixed(0)}`;
  }

  private timeSince(date: Date): string {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
  }

  public renderPredictions(data: PredictionMarket[]): void {
    if (data.length === 0) {
      this.showError('Failed to load predictions');
      return;
    }

    this.lastUpdated = new Date();

    const html = data
      .map((p) => {
        const yesPercent = Math.round(p.yesPrice);
        const noPercent = 100 - yesPercent;
        const volumeStr = this.formatVolume(p.volume);

        const safeUrl = sanitizeUrl(p.url || '');
        const titleHtml = safeUrl
          ? `<a href="${safeUrl}" target="_blank" rel="noopener" class="prediction-question prediction-link">${escapeHtml(p.title)}</a>`
          : `<div class="prediction-question">${escapeHtml(p.title)}</div>`;

        return `
      <div class="prediction-item">
        ${titleHtml}
        ${volumeStr ? `<div class="prediction-volume">Vol: ${volumeStr}</div>` : ''}
        <div class="prediction-bar">
          <div class="prediction-yes" style="width: ${yesPercent}%">
            <span class="prediction-label">Yes ${yesPercent}%</span>
          </div>
          <div class="prediction-no" style="width: ${noPercent}%">
            <span class="prediction-label">No ${noPercent}%</span>
          </div>
        </div>
      </div>
    `;
      })
      .join('');

    const ago = this.lastUpdated ? this.timeSince(this.lastUpdated) : '';

    this.setContent(`
      ${html}
      <div class="prediction-footer">
        <span class="prediction-source">Polymarket</span>
        <span class="prediction-updated">${ago}</span>
      </div>
      <style>
        .prediction-footer { display: flex; justify-content: space-between; padding: 8px 8px 0; color: #555; font-size: 10px; }
      </style>
    `);
  }
}
