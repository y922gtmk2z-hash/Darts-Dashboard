// Shared presentation helpers for the admin and TV pages (DOM-free strings).
import { teamById } from './logic/tournament.js';
import { bestOfFor, legsToWin } from './logic/config.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function stageName(f, { short = false } = {}) {
  switch (f.stage) {
    case 'league': return short ? `#${f.order}` : `League · Match ${f.order}`;
    case 'semi': return short ? `SF${f.id === 'SF1' ? 1 : 2}` : `Semi-final ${f.id === 'SF1' ? 1 : 2}`;
    case 'third': return short ? '3rd' : '3rd place play-off';
    case 'final': return 'Final';
    default: return f.stage;
  }
}

export function slotName(state, f, side) {
  const id = side === 'home' ? f.homeId : f.awayId;
  if (id) return teamById(state, id)?.name ?? '?';
  if (f.stage === 'final') return `Winner SF${side === 'home' ? 1 : 2}`;
  if (f.stage === 'third') return `Loser SF${side === 'home' ? 1 : 2}`;
  return 'TBD';
}

export function playersText(state, id) {
  const p = teamById(state, id)?.players ?? [];
  return p.filter(Boolean).join(' & ');
}

/** "First to 3 legs (best of 5)" — the way organisers talk about a match length. */
export function legsFormat(bestOf, { capital = false, short = false } = {}) {
  const need = legsToWin(bestOf);
  const first = `${capital ? 'F' : 'f'}irst to ${need}${short ? '' : need === 1 ? ' leg' : ' legs'}`;
  return bestOf === 1 ? `${capital ? 'S' : 's'}ingle leg` : `${first} (best of ${bestOf})`;
}

export function formatLine(state, f) {
  const parts = [legsFormat(bestOfFor(state.config, f.stage), { capital: true })];
  if (state.config.gameType) parts.push(state.config.gameType);
  return parts.join(' · ');
}

export function phaseLabel(phase) {
  return { setup: 'Setup', league: 'League', knockout: 'Knockout', complete: 'Complete' }[phase] ?? phase;
}

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Apply the configured accent colour as a CSS variable. */
export function applyTheme(state) {
  if (state?.config?.accent) document.documentElement.style.setProperty('--accent', state.config.accent);
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
