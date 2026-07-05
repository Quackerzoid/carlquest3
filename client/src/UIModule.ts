/**
 * In-match HUD (M10): scorer's board, event feed, contextual key legend and the
 * GAME_OVER result overlay. One module owning the in-match DOM — the old
 * `#status` debug line retires. All wording that the acceptance asserts on
 * (describeResolution, legend text, board labels) lives HERE, not in main.ts.
 */
import {
  CHARACTERS,
  CONST,
  type AbilityId,
  type PlayOutcome,
  type PlayResolution,
  type RollEvent,
} from '@carlquest/shared';
import type { MatchStateView, Net } from './NetModule';
import { ABILITY_TEXT } from './Tooltips';

/** Tolerant roster lookup for display (unlike shared getCharacter, which throws). */
function characterName(id: string): string {
  return CHARACTERS.find((c) => c.id === id)?.name ?? '—';
}

/** The character's ability id (or null when the id is unknown / empty). */
function abilityOf(id: string): AbilityId | null {
  return CHARACTERS.find((c) => c.id === id)?.ability ?? null;
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
  /**
   * Flash a dice-moment banner centre-top for ~1.4 s (max 2 stacked; oldest drops)
   * AND echo the same line onto the event feed. The star moment of the autoplay
   * identity — every `roll` broadcast lands here.
   */
  showRoll(e: RollEvent): void;
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
const ROLL_BANNER_MAX = 2;
const ROLL_BANNER_MS = 1400;

/**
 * The key vocabulary after the autoplay redesign: plays resolve themselves, so the
 * only keys left are the management pair. Camera and repositioning are mouse-driven
 * (surfaced through the contextual hint, not this list).
 */
interface LegendItem {
  key: string;
  label: string;
  tip: string;
}
const LEGEND_VOCABULARY: readonly LegendItem[] = [
  {
    key: 'Enter',
    label: 'confirm/ready',
    tip: 'Lock in your setup (or ready up) and tell your opponent you are set. Same as the READY button.',
  },
  { key: 'N', label: 'rematch', tip: 'Start a fresh match against the same opponent.' },
];

/** Hover tip for the camera controls, shown on the mouse-hint segment. */
const CAMERA_TIP =
  'Drag to orbit the pitch · scroll to zoom · Home or double-click to reset the view.';

/** Which vocabulary keys are live for MY side in this phase (autoplay legend mapping). */
function litKeys(state: MatchStateView, net: Net): ReadonlySet<string> {
  const side = net.mySide();
  if (side === null) return new Set();
  switch (state.phase) {
    case 'INITIAL_POSITIONING':
    case 'PRE_PLAY':
      return new Set(['Enter']);
    case 'GAME_OVER':
      return new Set(['N']);
    default:
      return new Set(); // LOBBY, DRAFT, PLAY — mouse only / hands off
  }
}

/** Contextual mouse note appended after the key vocabulary (DRAFT turn, mouse hints). */
function legendHint(state: MatchStateView, net: Net): string {
  const side = net.mySide();
  if (state.phase === 'DRAFT') {
    return side !== null && state.draftTurn === side
      ? 'your pick — click a row on the sheet'
      : 'opponent picks';
  }
  if (state.phase === 'PLAY') return 'play in progress — the dice decide';
  const positioning = state.phase === 'INITIAL_POSITIONING' || state.phase === 'PRE_PLAY';
  if (positioning) {
    const fielding = side !== null && state.battingSide !== side;
    const camera = 'drag to orbit · wheel to zoom · Home resets';
    return fielding ? `click fielder → click ground · Esc clear · ${camera}` : camera;
  }
  return '';
}

// ---- Roll-banner wording: `KIAN PITCHES — SPIN 8+ (0.62) — RIPS THE SPIN!` ----

const ROLL_VERBS: Record<RollEvent['contest'], string> = {
  pitch: 'pitches',
  swing: 'swings',
  run: 'on the paths',
  catch: 'under the ball',
};

function rollVerdict(e: RollEvent): string {
  switch (e.contest) {
    case 'pitch':
      return e.success ? 'rips the spin!' : 'keeps it straight';
    case 'swing':
      return e.success ? 'connects!' : 'beaten!';
    case 'run':
      return e.success ? 'goes!' : 'holds!';
    case 'catch':
      return e.success ? 'taken!' : 'dropped!';
  }
}

/** One line per dice moment — the banner uppercases it via CSS; the feed shows it as-is. */
export function describeRoll(e: RollEvent): string {
  return `${characterName(e.actorId)} ${ROLL_VERBS[e.contest]} — ${e.detail} — ${rollVerdict(e)}`;
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

/** Builds one stacked `LABEL / value` stat tile for the score strip (innings / outs). */
function boardTile(label: string, value: string): HTMLDivElement {
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

/**
 * Builds a batter/bowler card: fat team-colour tab, role label, the character's
 * name, and a hover-tipped ability chip. `subsText` is appended only when given
 * (bowler card, when I am the fielding side).
 */
function playerCard(
  role: 'bat' | 'bowl',
  roleLabel: string,
  id: string,
  subsText: string | null,
): HTMLDivElement {
  const card = document.createElement('div');
  card.className = `player-card card is-${role}`;

  const roleEl = document.createElement('div');
  roleEl.className = 'player-role';
  roleEl.textContent = roleLabel;

  const nameEl = document.createElement('div');
  nameEl.className = 'player-name';
  nameEl.textContent = characterName(id);

  card.append(roleEl, nameEl);

  const ability = abilityOf(id);
  if (ability) {
    const chip = document.createElement('span');
    chip.className = 'player-ability';
    chip.textContent = ability.replaceAll('_', ' ').toLowerCase();
    chip.dataset['tipTitle'] = ability.replaceAll('_', ' ');
    chip.dataset['tip'] = ABILITY_TEXT[ability];
    card.appendChild(chip);
  }

  if (subsText !== null) {
    const subs = document.createElement('span');
    subs.className = 'player-subs';
    subs.textContent = subsText;
    card.appendChild(subs);
  }

  return card;
}

export function createUI(container: HTMLElement): UI {
  const board = requireChild<HTMLElement>(container, '#hud-board');
  const boardPhase = requireChild<HTMLSpanElement>(container, '#board-phase');
  const boardYou = requireChild<HTMLSpanElement>(container, '#board-you');
  const boardScore = requireChild<HTMLDivElement>(container, '#board-score');
  const boardBadges = requireChild<HTMLDivElement>(container, '#board-badges');
  const boardRows = requireChild<HTMLDivElement>(container, '#board-rows');
  const players = requireChild<HTMLDivElement>(container, '#hud-players');
  const feed = requireChild<HTMLOListElement>(container, '#hud-feed');
  const rollBanners = requireChild<HTMLDivElement>(container, '#roll-banners');
  const legend = requireChild<HTMLDivElement>(container, '#hud-legend');
  const result = requireChild<HTMLDivElement>(container, '#hud-result');
  const resultScore = requireChild<HTMLDivElement>(container, '#result-score');
  const resultWinner = requireChild<HTMLDivElement>(container, '#result-winner');
  const resultLine = requireChild<HTMLDivElement>(container, '#result-line');
  const rematchButton = requireChild<HTMLButtonElement>(container, '#result-rematch');
  const leaveButton = requireChild<HTMLButtonElement>(container, '#result-leave');

  function pushEvent(text: string): void {
    const entry = document.createElement('li');
    entry.className = 'feed-entry';
    entry.textContent = text;
    feed.prepend(entry);
    while (feed.children.length > FEED_MAX) feed.lastElementChild?.remove();
  }

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
      span.dataset['tip'] = item.tip;
      const key = document.createElement('span');
      key.className = 'legend-key';
      key.textContent = item.key;
      span.append(key, item.label);
      legend.appendChild(span);
    }
    const hint = legendHint(state, net);
    if (hint) {
      const span = document.createElement('span');
      span.className = 'legend-item is-lit legend-hint';
      span.textContent = hint;
      // The hint mentions camera controls in the positioning phases — tip them.
      if (hint.includes('orbit')) span.dataset['tip'] = CAMERA_TIP;
      legend.appendChild(span);
    }
  }

  function renderBoard(state: MatchStateView, net: Net): void {
    const side = net.mySide();
    const fielding = side !== null && state.battingSide !== side;

    boardPhase.textContent = state.phase.replaceAll('_', ' ').toLowerCase();
    boardYou.textContent =
      side === null ? '' : `you · ${side} · ${fielding ? 'fielding' : 'batting'}`;

    // Two-tone score: A navy, B maroon, dash faint — the two teams read at a glance.
    boardScore.innerHTML = '';
    const scoreA = document.createElement('span');
    scoreA.className = 'score-a';
    scoreA.textContent = `A ${String(state.scoreHalvesA)}½`;
    const dash = document.createElement('span');
    dash.className = 'score-dash';
    dash.textContent = ' – ';
    const scoreB = document.createElement('span');
    scoreB.className = 'score-b';
    scoreB.textContent = `B ${String(state.scoreHalvesB)}½`;
    boardScore.append(scoreA, dash, scoreB);

    boardBadges.innerHTML = '';
    if (state.tiebreak) {
      const badge = document.createElement('span');
      badge.className = 'board-badge badge-tiebreak';
      badge.textContent = 'TIEBREAK';
      boardBadges.appendChild(badge);
    }
    const inGame =
      state.phase === 'INITIAL_POSITIONING' ||
      state.phase === 'PRE_PLAY' ||
      state.phase === 'PLAY';
    if (inGame && underPressure(state)) {
      const badge = document.createElement('span');
      badge.className = 'board-badge';
      badge.textContent = 'PRESSURE';
      boardBadges.appendChild(badge);
    }

    boardRows.innerHTML = '';
    boardRows.appendChild(boardTile('innings', String(state.inningsIndex + 1)));
    boardRows.appendChild(boardTile('outs', String(state.outs)));

    // Batter & bowler cards (own strip). Hidden pre-toss when there is no batter yet.
    players.innerHTML = '';
    if (state.currentBatterId || state.currentPitcherId) {
      players.appendChild(playerCard('bat', 'now batting', state.currentBatterId, null));
      const subsText = fielding
        ? `subs used: ${String((side === 'A' ? state.subsUsedA : state.subsUsedB) ?? 0)}`
        : null;
      players.appendChild(playerCard('bowl', 'bowling', state.currentPitcherId, subsText));
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
      const boardHidden = state.phase === 'LOBBY' || state.phase === 'DRAFT';
      board.hidden = boardHidden;
      if (boardHidden) {
        players.innerHTML = ''; // no batter/bowler cards outside a live match
      } else {
        renderBoard(state, net);
      }
      renderLegend(state, net);
      renderResult(state);
    },
    pushEvent,
    showRoll(e) {
      const line = describeRoll(e);
      const banner = document.createElement('div');
      banner.className = `roll-banner ${e.success ? 'is-success' : 'is-fail'}`;
      banner.dataset['contest'] = e.contest;
      const contest = document.createElement('span');
      contest.className = 'roll-contest';
      contest.textContent = e.contest;
      const text = document.createElement('span');
      text.className = 'roll-text';
      text.textContent = line;
      banner.append(contest, text);
      rollBanners.appendChild(banner);
      // Max 2 stacked: drop the oldest immediately when a third arrives.
      while (rollBanners.children.length > ROLL_BANNER_MAX) rollBanners.firstElementChild?.remove();
      window.setTimeout(() => {
        banner.remove();
      }, ROLL_BANNER_MS);
      pushEvent(line);
    },
    reset() {
      notice = null;
      feed.innerHTML = '';
      rollBanners.innerHTML = '';
      players.innerHTML = '';
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
