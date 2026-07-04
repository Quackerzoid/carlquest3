import { CHARACTERS, type Character } from '@carlquest/shared';
import type { MatchStateView, Net } from './NetModule';
import type { SelectionStore } from './PositioningControls';

export interface DraftScreen {
  /** Re-render from synced state; call on every onStateChange. Cheap (11 cards). */
  update(state: MatchStateView, mySide: 'A' | 'B' | null): void;
}

/** `spd 7 · rch 6 · pwr 8 · pit 5 · spn 5 · stm 7 · rfx 6 · ins 6 · nrv 8` */
function statLine(c: Character): string {
  const s = c.stats;
  return [
    `spd ${String(s.speed)}`,
    `rch ${String(s.reach)}`,
    `pwr ${String(s.power)}`,
    `pit ${String(s.pitch)}`,
    `spn ${String(s.spin)}`,
    `stm ${String(s.stamina)}`,
    `rfx ${String(s.reflex)}`,
    `ins ${String(s.instinct)}`,
    `nrv ${String(s.nerve)}`,
  ].join(' · ');
}

type Mode = 'none' | 'draft' | 'fielding' | 'batting';

const CHARACTER_BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));

function characterName(id: string): string {
  return CHARACTER_BY_ID.get(id)?.name ?? id;
}

/** Stat line for a roster id; falls back to an em dash if the id is unknown (defensive — server-driven). */
function statLineForId(id: string): string {
  const character = CHARACTER_BY_ID.get(id);
  return character ? statLine(character) : '—';
}

/** Builds one clickable sheet row; caller fills in stats/badge text and listens via delegation. */
function buildRow(id: string, statsText: string): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'draft-row';
  row.dataset['id'] = id;

  const name = document.createElement('span');
  name.className = 'draft-row-name';
  name.textContent = characterName(id);

  const stats = document.createElement('span');
  stats.className = 'draft-row-stats';
  stats.textContent = statsText;

  const badge = document.createElement('span');
  badge.className = 'draft-row-badge';

  row.append(name, stats, badge);
  return row;
}

function buildSectionLabel(text: string): HTMLDivElement {
  const label = document.createElement('div');
  label.className = 'draft-sheet-section';
  label.textContent = text;
  return label;
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
          const row = buildRow(
            character.id,
            `${statLine(character)}  [${character.ability.toLowerCase()}]`,
          );
          const badge = row.querySelector<HTMLSpanElement>('.draft-row-badge');
          const takenByA = squadAIds.includes(character.id);
          const takenByB = squadBIds.includes(character.id);
          const remaining = draftRemaining.includes(character.id);
          row.disabled = !myTurn || !remaining;
          row.classList.toggle('is-taken', takenByA || takenByB);
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

        for (const id of onField) {
          const row = buildRow(id, statLineForId(id));
          const badge = row.querySelector<HTMLSpanElement>('.draft-row-badge');
          const isBowler = state.currentPitcherId === id;
          const isSelected = selection.get() === id;
          row.dataset['role'] = isBowler ? 'bowler' : 'field';
          row.disabled = isBowler;
          row.classList.toggle('is-taken', isBowler);
          row.classList.toggle('is-selected', isSelected);
          if (badge) badge.textContent = isBowler ? '[bowling]' : isSelected ? '[selected]' : '';
          list.appendChild(row);
        }

        list.appendChild(buildSectionLabel('bench'));
        if (bench.length === 0) {
          const empty = document.createElement('button');
          empty.type = 'button';
          empty.className = 'draft-row';
          empty.disabled = true;
          const name = document.createElement('span');
          name.className = 'draft-row-name';
          name.textContent = 'bench — awaiting roster growth';
          empty.append(name);
          list.appendChild(empty);
        } else {
          for (const id of bench) {
            const row = buildRow(id, statLineForId(id));
            row.dataset['role'] = 'bench';
            row.disabled = selection.get() === null;
            list.appendChild(row);
          }
        }
        return;
      }

      // mode === 'batting'
      const queue = state.queueIds ?? [];
      heading.textContent = 'next batter';
      list.innerHTML = '';
      for (const id of queue) {
        const row = buildRow(id, statLineForId(id));
        const badge = row.querySelector<HTMLSpanElement>('.draft-row-badge');
        const isBatting = state.currentBatterId === id;
        row.disabled = isBatting;
        row.classList.toggle('is-taken', isBatting);
        if (badge) badge.textContent = isBatting ? '[batting]' : '';
        list.appendChild(row);
      }
    },
  };
}
