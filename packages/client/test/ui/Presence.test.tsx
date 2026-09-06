// @vitest-environment jsdom
// Presence.test.tsx — the avatar stack is the honest-degradation object made visual (03-UI §4.2):
// connected and alone reads "Only you"; connected with peers shows their avatars and a "+N" overflow
// past four; DISCONNECTED shows the slashed ghost and "Peers unknown", never "Only you". Rendered
// with react-dom into jsdom; the three states come straight from the peer table and the connected
// flag.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReplicaId } from '@weft/crdt';
import type { PresenceState } from '@weft/protocol';
import { emptyPeers, upsertPeer, type PeerTable } from '../../src/presence/awareness.ts';
import { Presence } from '../../src/ui/Presence.tsx';

const self = { replica: 'bcdefghijklmn' as ReplicaId, name: 'abheet', color: 4 };

function peersOf(n: number): PeerTable {
  let table = emptyPeers;
  for (let i = 0; i < n; i++) {
    const id = (String.fromCharCode(99 + i) + 'cdefghijklmn').slice(0, 13) as ReplicaId;
    table = upsertPeer(table, id, { name: `Peer${i}`, color: i } as PresenceState, 1_000);
  }
  return table;
}

describe('Presence avatar stack', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });
  function render(peers: PeerTable, connected: boolean): HTMLElement {
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<Presence self={self} peers={peers} connected={connected} follow={null} onFollow={() => {}} />));
    return host;
  }

  it('reads "Only you" when connected and alone', () => {
    const el = render(emptyPeers, true);
    expect(el.querySelector('[data-testid="presence-label"]')?.textContent).toBe('Only you');
    expect(el.querySelector('.av.ghost')).toBeNull();
  });

  it('shows peer avatars and no label when connected with peers', () => {
    const el = render(peersOf(2), true);
    expect(el.querySelector('[data-testid="presence-label"]')).toBeNull();
    // self + 2 peers = 3 avatars, none a ghost.
    expect(el.querySelectorAll('.stack .av:not(.more)').length).toBe(3);
  });

  it('collapses peers past four into a +N overflow', () => {
    const el = render(peersOf(6), true);
    expect(el.querySelector('.av.more')?.textContent).toBe('+2');
  });

  it('reads "Peers unknown" with a slashed ghost when disconnected, never "Only you"', () => {
    const el = render(peersOf(2), false);
    expect(el.querySelector('[data-testid="presence-label"]')?.textContent).toBe('Peers unknown');
    expect(el.querySelector('.av.ghost')).not.toBeNull();
  });
});
