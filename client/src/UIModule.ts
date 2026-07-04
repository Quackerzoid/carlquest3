/**
 * In-match HUD (M10): scorer's board, event feed, contextual key legend and the
 * GAME_OVER result overlay. One module owning the in-match DOM — the old
 * `#status` debug line retires. All wording that the acceptance asserts on
 * (describeResolution, legend text, board labels) lives HERE, not in main.ts.
 */
import { CHARACTERS, CONST, type PlayOutcome, type PlayResolution } from '@carlquest/shared';
import type { MatchStateView, Net } from './NetModule';

/** Tolerant roster lookup for display (unlike shared getCharacter, which throws). */
function characterName(id: string): string {
  return CHARACTERS.find((c) => c.id === id)?.name ?? '—';
}

/** `Carl [clutch_swing]` — the draft sheet's bracketed-ability idiom. */
function nameWithAbility(id: string): string {
  const character = CHARACTERS.find((c) => c.id === id);
  if (!character) return '—';
  return `${character.name} [${character.ability.toLowerCase()}]`;
}

function describeCause(cause: PlayOutcome): string {
  switch (cause.kind) {
    case 'caught':
      return `caught by ${characterName(cause.by)}`;
    case 'runOut':
      return `${characterName(cause.runnerId)} run out at post ${String(cause.atPost)}`;
    case 'safe':
      return `${characterName(cause.runnerId)} safe at post ${String(cause.atPost)}`;
    case 'rounder':
      return 'rounder!';
  }
}

/** Feed wording for a play resolution — EXACT strings preserved from the M5 status line. */
export function describeResolution(resolution: PlayResolution): string {
  const parts = [describeCause(resolution.cause)];
  if (resolution.scoreDeltaHalves > 0) parts.push(`+${String(resolution.scoreDeltaHalves)}½`);
  if (resolution.outs.length > 0) parts.push(`out: ${resolution.outs.map(characterName).join(', ')}`);
  return parts.join(' · ');
}

export interface UI {
  /** Re-render board/legend/result from synced state; call on every onStateChange. */
  update(state: MatchStateView, net: Net): void;
  /** Push a plain-English line onto the event feed (newest first, keeps 6). */
  pushEvent(text: string): void;
  /** Clear the feed and hide overlays (rematch and lobby-return call this). */
  reset(): void;
  /**
   * Override the legend with a standing notice (e.g. `reconnecting…` while no
   * patches can arrive), or clear it with null. Cleared by reset() too.
   * (Deliberate addition to the brief's five-method surface: the reconnect flow
   * needs a legend override that no state patch can drive.)
   */
  setNotice(text: string | null): void;
  /** Result-overlay button hooks, wired once by main.ts. */
  onRematchClick(cb: () => void): void;
  onLeaveClick(cb: () => void): void;
}

const FEED_MAX = 6;

/** The full key vocabulary, in scorer's-card order; the legend lights the active subset. */
interface LegendItem {
  key: string;
  label: string;
}
const LEGEND_VOCABULARY: readonly LegendItem[] = [
  { key: 'A/S/D', label: 'spin' },
  { key: 'P', label: 'pitch' },
  { key: 'Space', label: 'swing' },
  { key: 'R', label: 'run' },
  { key: 'T', label: 'stop' },
  { key: 'Enter', label: 'confirm/ready' },
  { key: 'N', label: 'rematch' },
];

/** Which vocabulary keys are live for MY side in this phase (spec §1 mapping). */
function litKeys(state: MatchStateView, net: Net): ReadonlySet<string> {
  const side = net.mySide();
  if (side === null) return new Set();
  switch (state.phase) {
    case 'INITIAL_POSITIONING':
    case 'PRE_PLAY':
      return new Set(['Enter']);
    case 'PLAY':
      return net.myRole() === 'batting'
        ? new Set(['Space', 'R', 'T'])
        : new Set(['A/S/D', 'P']);
    case 'GAME_OVER':
      return new Set(['N']);
    default:
      return new Set(); // LOBBY, DRAFT — mouse only
  }
}

/** Contextual mouse note appended after the key vocabulary (DRAFT turn, fielding hints). */
function legendHint(state: MatchStateView, net: Net): string {
  const side = net.mySide();
  if (state.phase === 'DRAFT') {
    return side !== null && state.draftTurn === side
      ? 'your pick — click a row on the sheet'
      : 'opponent picks';
  }
  const positioning = state.phase === 'INITIAL_POSITIONING' || state.phase === 'PRE_PLAY';
  const fielding = side !== null && state.battingSide !== side;
  if (positioning && fielding) return 'click fielder → click ground · Esc clear';
  return '';
}

/**
 * Client-side PRESSURE derivation, mirroring server/src/modules/RulesModule.ts
 * `pressure()` exactly: `tiebreak || isFinalInnings() || runnersOnPosts >= 2`, where
 * `isFinalInnings()` = `tiebreak || inningsIndex >= totalSlots - 2` (the whole final
 * A/B pair, not just its last slot — no schema addition, so `tiebreak` is read
 * straight from state and the innings/runner-count halves are re-derived here).
 */
function underPressure(state: MatchStateView): boolean {
  if (state.tiebreak) return true;
  if (state.inningsIndex >= CONST.GAME.INNINGS_COUNT * 2 - 2) return true;
  let onPosts = 0;
  for (const runner of state.runners.values()) if (runner.atPost >= 1) onPosts += 1;
  return onPosts >= 2;
}

function requireChild<T extends Element>(container: HTMLElement, selector: string): T {
  const el = container.querySelector<T>(selector);
  if (!el) throw new Error(`Missing HUD element ${selector}`);
  return el;
}

/** Builds one `label ······ value` scorer's-board row. */
function boardRow(label: string, value: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'board-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'board-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'board-value';
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  return row;
}

export function createUI(container: HTMLElement): UI {
  const board = requireChild<HTMLElement>(container, '#hud-board');
  const boardPhase = requireChild<HTMLSpanElement>(container, '#board-phase');
  const boardYou = requireChild<HTMLSpanElement>(container, '#board-you');
  const boardScore = requireChild<HTMLDivElement>(container, '#board-score');
  const boardBadges = requireChild<HTMLDivElement>(container, '#board-badges');
  const boardRows = requireChild<HTMLDivElement>(container, '#board-rows');
  const feed = requireChild<HTMLOListElement>(container, '#hud-feed');
  const legend = requireChild<HTMLDivElement>(container, '#hud-legend');
  const result = requireChild<HTMLDivElement>(container, '#hud-result');
  const resultScore = requireChild<HTMLDivElement>(container, '#result-score');
  const resultWinner = requireChild<HTMLDivElement>(container, '#result-winner');
  const resultLine = requireChild<HTMLDivElement>(container, '#result-line');
  const rematchButton = requireChild<HTMLButtonElement>(container, '#result-rematch');
  const leaveButton = requireChild<HTMLButtonElement>(container, '#result-leave');

  let notice: string | null = null;
  let rematchCallback: (() => void) | null = null;
  let leaveCallback: (() => void) | null = null;
  rematchButton.addEventListener('click', () => rematchCallback?.());
  leaveButton.addEventListener('click', () => leaveCallback?.());

  function renderLegend(state: MatchStateView | null, net: Net | null): void {
    legend.innerHTML = '';
    // Standing notice (reconnecting…) beats everything; paused beats the key map.
    const override =
      notice ?? (state?.paused === true ? 'paused — waiting for reconnect' : null);
    if (override !== null) {
      const span = document.createElement('span');
      span.className = 'legend-notice';
      span.textContent = override;
      legend.appendChild(span);
      return;
    }
    if (!state || !net) return;
    const lit = litKeys(state, net);
    for (const item of LEGEND_VOCABULARY) {
      const span = document.createElement('span');
      span.className = `legend-item${lit.has(item.key) ? ' is-lit' : ''}`;
      const key = document.createElement('span');
      key.className = 'legend-key';
      key.textContent = `[${item.key}]`;
      span.append(key, ` ${item.label}`);
      legend.appendChild(span);
    }
    const hint = legendHint(state, net);
    if (hint) {
      const span = document.createElement('span');
      span.className = 'legend-item is-lit legend-hint';
      span.textContent = hint;
      legend.appendChild(span);
    }
  }

  function renderBoard(state: MatchStateView, net: Net): void {
    const side = net.mySide();
    const fielding = side !== null && state.battingSide !== side;

    boardPhase.textContent = state.phase.replaceAll('_', ' ').toLowerCase();
    boardYou.textContent =
      side === null ? '' : `you are ${side} · ${fielding ? 'fielding' : 'batting'}`;
    boardScore.textContent =
      `A ${String(state.scoreHalvesA)}½ – B ${String(state.scoreHalvesB)}½`;

    boardBadges.innerHTML = '';
    const badges: string[] = [];
    if (state.tiebreak) badges.push('TIEBREAK');
    const inGame =
      state.phase === 'INITIAL_POSITIONING' ||
      state.phase === 'PRE_PLAY' ||
      state.phase === 'PLAY';
    if (inGame && underPressure(state)) badges.push('PRESSURE');
    for (const text of badges) {
      const badge = document.createElement('span');
      badge.className = 'board-badge';
      badge.textContent = `[${text}]`;
      boardBadges.appendChild(badge);
    }

    boardRows.innerHTML = '';
    boardRows.appendChild(boardRow('innings', String(state.inningsIndex + 1)));
    boardRows.appendChild(boardRow('outs', String(state.outs)));
    boardRows.appendChild(boardRow('batting', nameWithAbility(state.currentBatterId)));
    boardRows.appendChild(boardRow('bowling', nameWithAbility(state.currentPitcherId)));
    if (fielding) {
      const subsUsed = (side === 'A' ? state.subsUsedA : state.subsUsedB) ?? 0;
      boardRows.appendChild(boardRow('subs used', String(subsUsed)));
    }
  }

  function renderResult(state: MatchStateView): void {
    const over = state.phase === 'GAME_OVER';
    result.hidden = !over;
    if (!over) return;
    resultScore.textContent =
      `A ${String(state.scoreHalvesA)}½ – B ${String(state.scoreHalvesB)}½`;
    resultWinner.textContent = state.winner ? `WINNER: ${state.winner}` : 'RESULT';
    resultLine.textContent =
      `after ${String(state.inningsIndex + 1)} innings${state.tiebreak ? ' · tiebreak' : ''}`;
  }

  return {
    update(state, net) {
      container.hidden = state.phase === 'LOBBY';
      board.hidden = state.phase === 'LOBBY' || state.phase === 'DRAFT';
      renderBoard(state, net);
      renderLegend(state, net);
      renderResult(state);
    },
    pushEvent(text) {
      const entry = document.createElement('li');
      entry.className = 'feed-entry';
      entry.textContent = text;
      feed.prepend(entry);
      while (feed.children.length > FEED_MAX) feed.lastElementChild?.remove();
    },
    reset() {
      notice = null;
      feed.innerHTML = '';
      result.hidden = true;
      container.hidden = true;
      renderLegend(null, null);
    },
    setNotice(text) {
      notice = text;
      // Re-render immediately: while disconnected no state patch will arrive to do it.
      renderLegend(null, null);
      if (text !== null) container.hidden = false;
    },
    onRematchClick(cb) {
      rematchCallback = cb;
    },
    onLeaveClick(cb) {
      leaveCallback = cb;
    },
  };
}
