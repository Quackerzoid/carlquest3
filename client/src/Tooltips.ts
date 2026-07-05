/**
 * Hover-tooltip mechanism for the arcade-pop UI (readable-game overhaul §F).
 *
 * ONE absolutely-positioned `#tooltip` div, driven by delegated mouseover/mouseout
 * (and focus/blur for keyboard) on any `[data-tip]` element anywhere in the DOM.
 * No library, no per-element listeners: a single set of document-level handlers
 * reads the hovered element's `data-tip` (body) and optional `data-tip-title`, and
 * positions the div near the cursor, flipping to stay on-screen. Cheap and global —
 * new `[data-tip]` nodes rendered by DraftScreen/UIModule just work.
 */

import type { AbilityId } from '@carlquest/shared';

/**
 * Honest, player-facing ability descriptions. Each line is written to match the
 * REAL ability semantics in shared/src/abilities.ts (the mods each ability derives)
 * — no invented powers. Kept in British English, arcade-terse.
 */
export const ABILITY_TEXT: Record<AbilityId, string> = {
  CLUTCH_SWING: 'Swings for extra power in the final innings, when the pressure is on.',
  CURVEBALL_MASTER:
    'Bends the ball hard late in its flight — the curve only bites near the batter, so it is tough to read.',
  LONG_REACH: 'Reaches further for a catch while stood still — a wider grab from a set position.',
  QUICK_DRAW: 'Releases a throw twice as fast after gathering the ball — lightning relays.',
  CANNON_ARM:
    'Bowls with a stronger arm and gives the batter a tighter timing window to connect.',
  SWITCH: 'Reads spin either way — immune to the spin-read penalty on their swing timing.',
  IMMOVABLE: 'A guaranteed catch when stood still — no dice roll, the ball sticks.',
  POWER_BASE: 'Adds power to any well-timed contact — a cleanly struck ball flies further.',
  BUTTERFINGERS: 'Prone to fumbling — sometimes spills a catch and drops the ball at their feet.',
  POWERHOUSE:
    'Never tires in the field — keeps a full catch radius and shrugs off fatigue when fresh.',
  WALL: 'A living backstop — plants themselves in the field and stops the ball dead on contact.',
};

/** Full words for the draft sheet's stat abbreviations. */
export const STAT_TEXT: Record<string, string> = {
  spd: 'Speed — how fast they run and chase.',
  rch: 'Reach — how far they can stretch for a catch.',
  pwr: 'Power — how hard they hit the ball.',
  pit: 'Pitch — bowling arm strength and pace.',
  spn: 'Spin — how much curve they put on a delivery.',
  stm: 'Stamina — how long before fatigue sets in.',
  rfx: 'Reflex — reaction speed when the ball comes fast.',
  ins: 'Instinct — reading the play and getting into position.',
  nrv: 'Nerve — composure under pressure on the base paths.',
};

/** Wires the single tooltip div to document-level hover/focus. Call once at boot. */
export function initTooltips(tooltip: HTMLElement): void {
  const titleQuery = tooltip.querySelector<HTMLElement>('.tip-title');
  const bodyQuery = tooltip.querySelector<HTMLElement>('.tip-body');
  if (!titleQuery || !bodyQuery)
    throw new Error('#tooltip is missing its .tip-title/.tip-body spans');
  // Rebind as non-null so the closures below don't re-narrow.
  const titleEl: HTMLElement = titleQuery;
  const bodyEl: HTMLElement = bodyQuery;

  let current: HTMLElement | null = null;

  /** Nearest ancestor (or self) carrying a non-empty data-tip. */
  function tipTarget(node: EventTarget | null): HTMLElement | null {
    if (!(node instanceof Element)) return null;
    const el = node.closest<HTMLElement>('[data-tip]');
    if (!el) return null;
    // An explicitly empty data-tip means "no tip right now" (e.g. the READY button
    // when hidden); treat it as no target so the div hides.
    return el.dataset['tip'] ? el : null;
  }

  function place(clientX: number, clientY: number): void {
    // Offset from the cursor; flip left/up near the right/bottom edges.
    const pad = 14;
    const rect = tooltip.getBoundingClientRect();
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + rect.width + pad > window.innerWidth) x = clientX - rect.width - pad;
    if (y + rect.height + pad > window.innerHeight) y = clientY - rect.height - pad;
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    tooltip.style.left = `${String(x)}px`;
    tooltip.style.top = `${String(y)}px`;
  }

  function show(el: HTMLElement, clientX: number, clientY: number): void {
    current = el;
    titleEl.textContent = el.dataset['tipTitle'] ?? '';
    bodyEl.textContent = el.dataset['tip'] ?? '';
    tooltip.classList.add('is-visible');
    place(clientX, clientY);
  }

  function hide(): void {
    current = null;
    tooltip.classList.remove('is-visible');
  }

  document.addEventListener('mouseover', (event) => {
    const el = tipTarget(event.target);
    if (el && el !== current) show(el, event.clientX, event.clientY);
  });
  document.addEventListener('mousemove', (event) => {
    if (!current) return;
    // If the pointer has left the tip target entirely, hide.
    if (tipTarget(event.target) !== current) {
      hide();
      return;
    }
    place(event.clientX, event.clientY);
  });
  document.addEventListener('mouseout', (event) => {
    // Hide when leaving the current target for something that isn't it.
    if (current && tipTarget(event.relatedTarget) !== current) hide();
  });
  // Keyboard accessibility: focus shows the tip anchored to the element.
  document.addEventListener('focusin', (event) => {
    const el = tipTarget(event.target);
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.bottom);
  });
  document.addEventListener('focusout', () => {
    if (current) hide();
  });
}
