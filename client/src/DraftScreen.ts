import { CHARACTERS, type Character } from '@carlquest/shared';
import type { MatchStateView, Net } from './NetModule';
import type { SelectionStore } from './PositioningControls';
import { ABILITY_TEXT, STAT_TEXT } from './Tooltips';

export interface DraftScreen {
  /** Re-render from synced state; call on every onStateChange. Cheap (11 cards). */
  update(state: MatchStateView, mySide: 'A' | 'B' | null): void;
}

/** Ordered stat abbreviation → value pairs for a character (for the tipped stat line). */
function statPairs(c: Character): readonly [string, number][] {
  const s = c.stats;
  return [
    ['spd', s.speed],
    ['rch', s.reach],
    ['pwr', s.power],
    ['pit', s.pitch],
    ['spn', s.spin],
    ['stm', s.stamina],
    ['rfx', s.reflex],
    ['ins', s.instinct],
    ['nrv', s.nerve],
  ];
}

/**
 * Builds the tipped stat-line DOM: each abbreviation is a `.tip` span carrying a
 * hover tooltip that spells out the stat in full. `· ` separators between them.
 */
function fillStatsElement(target: HTMLElement, c: Character): void {
  const pairs = statPairs(c);
  pairs.forEach(([abbr, value], i) => {
    if (i > 0) target.append(' · ');
    const span = document.createElement('span');
    span.className = 'tip';
    span.textContent = `${abbr} ${String(value)}`;
    span.dataset['tipTitle'] = abbr.toUpperCase();
    span.dataset['tip'] = STAT_TEXT[abbr] ?? abbr;
    target.appendChild(span);
  });
}

type Mode = 'none' | 'draft' | 'fielding' | 'batting';

const CHARACTER_BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));

function characterName(id: string): string {
  return CHARACTER_BY_ID.get(id)?.name ?? id;
}

/**
 * Builds one clickable sheet row. Stats render as tipped abbreviation spans; when
 * `showAbility` is set the row gets an ability chip (its own hover tooltip). The
 * caller fills the badge text and (optionally) a `data-tip` action hint on the row,
 * then listens via delegation on the list.
 */
function buildRow(id: string, showAbility: boolean): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'draft-row';
  row.dataset['id'] = id;

  const name = document.createElement('span');
  name.className = 'draft-row-name';
  name.textContent = characterName(id);

  const stats = document.createElement('span');
  stats.className = 'draft-row-stats';
  const character = CHARACTER_BY_ID.get(id);
  if (character) fillStatsElement(stats, character);
  else stats.textContent = '—';

  const badge = document.createElement('span');
  badge.className = 'draft-row-badge';

  row.append(name, stats, badge);

  if (showAbility && character) {
    const ability = document.createElement('span');
    ability.className = 'draft-row-ability draft-row-wide';
    ability.textContent = character.ability.replaceAll('_', ' ').toLowerCase();
    ability.dataset['tipTitle'] = character.ability.replaceAll('_', ' ');
    ability.dataset['tip'] = ABILITY_TEXT[character.ability];
    row.appendChild(ability);
  }

  return row;
}

function buildSectionLabel(text: string): HTMLDivElement {
  const label = document.createElement('div');
  label.className = 'draft-sheet-section';
  label.textContent = text;
  return label;
}

/** Non-clickable full-width informational row (now batting / parked runners). */
function buildInfoRow(text: string): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'draft-row';
  row.disabled = true;
  const span = document.createElement('span');
  span.className = 'draft-row-name draft-row-wide';
  span.textContent = text;
  row.append(span);
  return row;
}

/**
 * Renders (a) the DRAFT-phase pick grid — one row per roster character, clickable
 * on your turn, greyed + side-badged once picked, leftover stays greyed unbadged —
 * and (b) the positioning sheet during INITIAL_POSITIONING/PRE_PLAY: the fielding
 * side sees its on-field rows (click selects for reposition; the bowler row
 * nominates a new pitcher instead) plus a bench section (click with a selection
 * substitutes) and a subs-used counter; the batting side sees its upcoming-batter
 * queue (click sets the next batter, current batter marked).
 */
export function createDraftScreen(
  container: HTMLElement,
  net: Net,
  selection: SelectionStore,
): DraftScreen {
  container.innerHTML = '';
  container.classList.add('draft-sheet');

  const heading = document.createElement('div');
  heading.className = 'draft-sheet-heading';
  container.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'draft-sheet-rows';
  container.appendChild(list);

  // Container-scoped delegation: one listener on `list`, no window-level
  // handlers — so this module needs no detach/teardown on match re-entry.
  list.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('.draft-row') : null;
    if (!(target instanceof HTMLButtonElement) || target.disabled) return;
    const id = target.dataset['id'];
    if (!id) return;
    const mode = list.dataset['mode'];
    if (mode === 'draft') {
      net.sendDraftPick({ id });
      target.disabled = true; // optimistic double-click guard; next state patch re-derives the real value
    } else if (mode === 'fielding') {
      if (target.dataset['role'] === 'bowler') {
        net.sendSetPitcher({ id });
        target.disabled = true; // optimistic double-click guard; next state patch re-derives the real value
      } else if (target.dataset['role'] === 'bench') {
        const outId = selection.get();
        if (outId === null) return; // no fielder selected — nothing sensible to substitute out
        net.sendSubstitute({ outId, inId: id });
        // Clear immediately: outId is about to be benched, so bench rows must
        // disable (no selection) and a second substitute can't be sent against it.
        selection.set(null);
      } else {
        selection.set(id);
      }
    } else if (mode === 'batting') {
      net.sendSetBatter({ id });
    }
  });

  function resolveMode(state: MatchStateView, mySide: 'A' | 'B' | null): Mode {
    if (state.phase === 'DRAFT') return 'draft';
    if (
      (state.phase === 'INITIAL_POSITIONING' || state.phase === 'PRE_PLAY') &&
      mySide !== null
    ) {
      return state.battingSide === mySide ? 'batting' : 'fielding';
    }
    return 'none';
  }

  return {
    update(state, mySide) {
      const mode = resolveMode(state, mySide);
      container.hidden = mode === 'none';
      if (mode === 'none') {
        list.innerHTML = '';
        return;
      }
      list.dataset['mode'] = mode;

      const draftRemaining = state.draftRemaining ?? [];
      const squadAIds = state.squadAIds ?? [];
      const squadBIds = state.squadBIds ?? [];
      const myTurn = mode === 'draft' && mySide !== null && state.draftTurn === mySide;

      if (mode === 'draft') {
        heading.textContent = myTurn
          ? 'draft — your pick'
          : `draft — waiting on ${state.draftTurn || '—'}`;
        list.innerHTML = '';
        for (const character of CHARACTERS) {
          const row = buildRow(character.id, true);
          const badge = row.querySelector<HTMLSpanElement>('.draft-row-badge');
          const takenByA = squadAIds.includes(character.id);
          const takenByB = squadBIds.includes(character.id);
          const remaining = draftRemaining.includes(character.id);
          row.disabled = !myTurn || !remaining;
          row.classList.toggle('is-taken', takenByA || takenByB);
          row.classList.toggle('is-team-a', takenByA);
          row.classList.toggle('is-team-b', takenByB);
          if (!takenByA && !takenByB && myTurn) {
            row.dataset['tip'] = `Draft ${character.name} onto your squad.`;
          }
          if (badge) badge.textContent = takenByA ? '[A]' : takenByB ? '[B]' : '';
          list.appendChild(row);
        }
        return;
      }

      if (mode === 'fielding') {
        const mySquad = mySide === 'A' ? squadAIds : squadBIds;
        const bench = (mySide === 'A' ? state.benchA : state.benchB) ?? [];
        const subsUsed = (mySide === 'A' ? state.subsUsedA : state.subsUsedB) ?? 0;
        const onField = mySquad.filter((id) => !bench.includes(id));

        heading.textContent = `positioning — subs used: ${String(subsUsed)}`;
        list.innerHTML = '';

        const teamClass = mySide === 'A' ? 'is-team-a' : 'is-team-b';
        for (const id of onField) {
          const row = buildRow(id, false);
          row.classList.add(teamClass);
          const badge = row.querySelector<HTMLSpanElement>('.draft-row-badge');
          const isBowler = state.currentPitcherId === id;
          const isSelected = selection.get() === id;
          row.dataset['role'] = isBowler ? 'bowler' : 'field';
          row.disabled = isBowler;
          row.classList.toggle('is-taken', isBowler);
          row.classList.toggle('is-selected', isSelected);
          row.dataset['tip'] = isBowler
            ? `${characterName(id)} is bowling. Click a bench player to nominate a new bowler instead.`
            : isSelected
              ? `${characterName(id)} selected — click the pitch to move them, or a bench player to sub them off.`
              : `Select ${characterName(id)}, then click the pitch to reposition them.`;
          if (badge) badge.textContent = isBowler ? '[bowling]' : isSelected ? '[selected]' : '';
          list.appendChild(row);
        }

        list.appendChild(buildSectionLabel('bench'));
        if (bench.length === 0) {
          // Full-width so the note reads as one line, not a word-per-line wrap in the
          // 5.5em name column (exact text is frozen — the M8 acceptance asserts it).
          list.appendChild(buildInfoRow('bench — awaiting roster growth'));
        } else {
          for (const id of bench) {
            const row = buildRow(id, false);
            row.classList.add(teamClass);
            row.dataset['role'] = 'bench';
            row.disabled = selection.get() === null;
            row.dataset['tip'] =
              selection.get() === null
                ? 'Select an on-field fielder first, then click here to sub them off for this player.'
                : `Sub the selected fielder off for ${characterName(id)}.`;
            list.appendChild(row);
          }
        }
        return;
      }

      // mode === 'batting'
      const queue = state.queueIds ?? [];
      heading.textContent = 'next batter';
      list.innerHTML = '';

      // Current batter is NOT in queueIds (spec: queue excludes them) — render as an
      // informational header row above the queue (M10: `now batting: Name`).
      if (state.currentBatterId) {
        list.appendChild(buildInfoRow(`now batting: ${characterName(state.currentBatterId)}`));
      }

      const teamClass = mySide === 'A' ? 'is-team-a' : 'is-team-b';
      for (const id of queue) {
        const row = buildRow(id, false);
        row.classList.add(teamClass);
        row.dataset['tip'] = `Send ${characterName(id)} in next to bat.`;
        list.appendChild(row);
      }

      // Parked runners (M10, informational): survivors standing at a post between
      // plays — atPost ≥ 1, not out, not mid-run. The queue cannot summon them.
      const parked = [...state.runners.values()].filter(
        (runner) => runner.atPost >= 1 && !runner.out && !runner.running,
      );
      if (parked.length > 0) {
        list.appendChild(buildSectionLabel('parked'));
        for (const runner of parked) {
          list.appendChild(
            buildInfoRow(`parked: ${characterName(runner.id)} @ post ${String(runner.atPost)}`),
          );
        }
      }
    },
  };
}
