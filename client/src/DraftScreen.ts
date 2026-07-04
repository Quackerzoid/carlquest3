import { CHARACTERS, type Character } from '@carlquest/shared';
import type { MatchStateView, Net } from './NetModule';

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

type Mode = 'none' | 'draft' | 'pitcher';

/**
 * Renders (a) the DRAFT-phase pick grid — one row per roster character, clickable
 * on your turn, greyed + side-badged once picked, leftover stays greyed unbadged —
 * and (b) the pitcher strip during INITIAL_POSITIONING/PRE_PLAY for the fielding
 * side: your squad's rows, current bowler marked, click to nominate.
 */
export function createDraftScreen(container: HTMLElement, net: Net): DraftScreen {
  container.innerHTML = '';
  container.classList.add('draft-sheet');

  const heading = document.createElement('div');
  heading.className = 'draft-sheet-heading';
  container.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'draft-sheet-rows';
  container.appendChild(list);

  const rows = new Map<string, HTMLButtonElement>();
  for (const character of CHARACTERS) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'draft-row';
    row.dataset['id'] = character.id;

    const name = document.createElement('span');
    name.className = 'draft-row-name';
    name.textContent = character.name;

    const stats = document.createElement('span');
    stats.className = 'draft-row-stats';
    stats.textContent = `${statLine(character)}  [${character.ability.toLowerCase()}]`;

    const badge = document.createElement('span');
    badge.className = 'draft-row-badge';

    row.append(name, stats, badge);
    list.appendChild(row);
    rows.set(character.id, row);
  }

  // Container-scoped delegation: one listener on `list`, no window-level
  // handlers — so this module needs no detach/teardown on match re-entry.
  list.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('.draft-row') : null;
    if (!(target instanceof HTMLButtonElement) || target.disabled) return;
    const id = target.dataset['id'];
    if (!id) return;
    if (list.dataset['mode'] === 'draft') {
      net.sendDraftPick({ id });
      target.disabled = true; // optimistic double-click guard; next state patch re-derives the real value
    } else if (list.dataset['mode'] === 'pitcher') {
      net.sendSetPitcher({ id });
      target.disabled = true; // optimistic double-click guard; next state patch re-derives the real value
    }
  });

  function resolveMode(state: MatchStateView, mySide: 'A' | 'B' | null): Mode {
    if (state.phase === 'DRAFT') return 'draft';
    if (
      (state.phase === 'INITIAL_POSITIONING' || state.phase === 'PRE_PLAY') &&
      mySide !== null &&
      state.battingSide !== mySide
    ) {
      return 'pitcher';
    }
    return 'none';
  }

  return {
    update(state, mySide) {
      const mode = resolveMode(state, mySide);
      container.hidden = mode === 'none';
      if (mode === 'none') return;
      list.dataset['mode'] = mode;

      const draftRemaining = state.draftRemaining ?? [];
      const squadAIds = state.squadAIds ?? [];
      const squadBIds = state.squadBIds ?? [];
      const myTurn = mode === 'draft' && mySide !== null && state.draftTurn === mySide;

      heading.textContent =
        mode === 'draft'
          ? myTurn
            ? 'draft — your pick'
            : `draft — waiting on ${state.draftTurn || '—'}`
          : 'nominate bowler';

      for (const [id, row] of rows) {
        const badge = row.querySelector<HTMLSpanElement>('.draft-row-badge');
        if (!badge) continue;

        if (mode === 'draft') {
          const takenByA = squadAIds.includes(id);
          const takenByB = squadBIds.includes(id);
          const remaining = draftRemaining.includes(id);
          row.hidden = false;
          row.disabled = !myTurn || !remaining;
          row.classList.toggle('is-taken', takenByA || takenByB);
          badge.textContent = takenByA ? '[A]' : takenByB ? '[B]' : '';
        } else {
          // Pitcher strip: only this client's own squad, current bowler marked.
          const mySquad = mySide === 'A' ? squadAIds : squadBIds;
          const inSquad = mySquad.includes(id);
          row.hidden = !inSquad;
          if (!inSquad) {
            badge.textContent = '';
            row.classList.remove('is-taken');
            continue;
          }
          const isBowler = state.currentPitcherId === id;
          row.disabled = isBowler;
          row.classList.toggle('is-taken', isBowler);
          badge.textContent = isBowler ? '[bowling]' : '';
        }
      }
    },
  };
}
