// snapshot.test.ts — encodeSnapshot / decodeSnapshot beyond the I12 property: what the encoder
// strips, that parked ops and the formatting lamport travel (E11, review P4/P8), what the decoder
// REFUSES (prototype-polluting keys, foreign mark names, malformed ids, orphans, cycles, an sv that
// does not cover an item, a parked op that is malformed or satisfiable), and that nothing from the
// raw input is kept by reference (review P11).
import { describe, expect, it } from 'vitest';
import { apply, canonicalString, decodeSnapshot, emptyDoc, encodeSnapshot, idKey, MAX_LAMPORT, pendingCount, ROOT, svEqual, type Snapshot } from '../src/index.ts';
import { applied, blk, block, char, del, fmt, id, ins, R, Replica, text } from './helpers.ts';

function sample(): { rep: Replica; snap: Snapshot } {
  const rep = new Replica(R.a);
  rep.type(0, 'abc');
  rep.insert(3, block({ type: 'heading', level: 1 }, R.a));
  rep.format(0, 2, 'bold', true);
  rep.format(1, 2, 'link', true, 'https://weft.test/');
  rep.delete(2, 3);
  return { rep, snap: encodeSnapshot(rep.doc) };
}

/** Define an OWN property named `key` — what JSON.parse does for `"__proto__"`. Plain assignment of `__proto__` would set the prototype instead and prove nothing. */
function own(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/** A deep JSON clone with one path mutated, as hostile input would arrive: parsed from text. */
function mutate(snap: Snapshot, edit: (raw: Record<string, unknown> & { items: Record<string, unknown>[] }) => void): Snapshot {
  const raw = JSON.parse(JSON.stringify(snap));
  edit(raw);
  return raw as Snapshot;
}

describe('encodeSnapshot', () => {
  it('strips the text of deleted characters but keeps their id, parent and side', () => {
    const { snap } = sample();
    const tomb = snap.items.find((it) => it.deleted);
    expect(tomb).toMatchObject({ id: id(R.a, 3), parent: id(R.a, 2), side: 'R', content: { kind: 'char', text: '' } });
  });

  it('lists items in traversal order, so two converged replicas encode byte-identical snapshots', () => {
    const { rep } = sample();
    const other = new Replica(R.b);
    other.receiveAll(rep.log);
    expect(JSON.stringify(encodeSnapshot(other.doc))).toBe(JSON.stringify(encodeSnapshot(rep.doc)));
  });

  it('carries parked ops sorted by id, so a doc with an unsatisfiable dependency can still be snapshotted and two replicas holding the same parked set encode the same bytes (review P4)', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'a');
    const dangling = del(id(R.b, 1), id(R.c, 1_000_000_000));
    const orphan = ins(id(R.c, 1), id(R.d, 1), 'R', char('x'));
    const late = new Replica(R.b);
    late.receiveAll([...rep.log, orphan, dangling]);
    expect(pendingCount(late.doc)).toBe(2);
    const snap = encodeSnapshot(late.doc);
    expect(snap.pending).toEqual([dangling, orphan]);
    // The other replica received everything in a different order: parked ops and sv keys must still serialise identically.
    const other = new Replica(R.c);
    other.receiveAll([dangling, orphan, ...rep.log]);
    expect(JSON.stringify(encodeSnapshot(other.doc))).toBe(JSON.stringify(snap));
    const back = decodeSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(pendingCount(back)).toBe(2);
    expect(svEqual(back.sv, late.doc.sv)).toBe(true);
    // The re-parked ops still drain when their dependency lands.
    const r = apply(back, ins(id(R.d, 1), id(R.a, 1), 'R', char('d')));
    expect(r.kind).toBe('applied');
    expect(text(r.doc)).toBe('adx');
    expect(pendingCount(r.doc)).toBe(1);
  });

  it('carries formatLamport explicitly, so a lamport that no register kept (a blk on a character) survives the round trip (review P8)', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'a');
    const doc = applied(rep.doc, blk(id(R.b, 1), id(R.a, 1), { type: 'quote' }, 50));
    expect(doc.formatLamport).toBe(50);
    const back = decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(doc))));
    expect(back.formatLamport).toBe(50);
    const atBound = applied(rep.doc, fmt(id(R.b, 1), [id(R.a, 1)], 'bold', true, MAX_LAMPORT));
    expect(decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(atBound)))).formatLamport).toBe(MAX_LAMPORT);
  });
});

describe('decodeSnapshot accepts', () => {
  it('its own output, reproducing canonical bytes, sv, tombstones and marks', () => {
    const { rep, snap } = sample();
    const back = decodeSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(canonicalString(back)).toBe(canonicalString(rep.doc));
    expect(svEqual(back.sv, rep.doc.sv)).toBe(true);
    expect(text(back)).toBe('ab▮');
    expect(back.items.get(idKey(id(R.a, 3)))?.deleted).toBe(true);
    expect(back.formatLamport).toBe(rep.doc.formatLamport);
  });

  it('an empty snapshot as an empty doc', () => {
    const back = decodeSnapshot(encodeSnapshot(emptyDoc()));
    expect(text(back)).toBe('');
    expect(back.items.size).toBe(1);
  });

  it('and builds fresh objects: mutating the raw snapshot afterwards changes nothing in the doc (review P11)', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'a');
    rep.insert(1, block({ type: 'heading', level: 2 }, R.a));
    const doc = applied(rep.doc, fmt(id(R.b, 1), [id(R.a, 1)], 'link', true, 1, 'https://weft.test/'));
    const orphan = ins(id(R.c, 1), id(R.d, 1), 'R', char('x'));
    const parked = apply(doc, orphan).doc;
    const raw = JSON.parse(JSON.stringify(encodeSnapshot(parked)));
    const back = decodeSnapshot(raw);
    const before = canonicalString(back);
    raw.items[0].content.text = 'HACKED';
    raw.items[0].marks.link.active = false;
    raw.items[0].marks.link.href = 'javascript:alert(1)';
    raw.items[1].content.attrs.type = 'quote';
    raw.items[1].content.attrs.level = 3;
    raw.pending[0].content.text = 'HACKED';
    raw.pending[0].parent.seq = 1;
    raw.sv[R.a] = 99;
    expect(canonicalString(back)).toBe(before);
    expect(back.sv).toEqual(parked.sv);
    expect([...back.pending.values()].flat()).toEqual([orphan]);
  });
});

describe('decodeSnapshot rejects', () => {
  const { snap } = sample();
  const reject = (edit: Parameters<typeof mutate>[1], why: RegExp): void => {
    expect(() => decodeSnapshot(mutate(snap, edit))).toThrow(why);
  };

  it('a "__proto__" key inside marks', () => {
    reject((raw) => {
      own((raw.items[0] as { marks: object }).marks, '__proto__', { active: true, lamport: 1, replica: R.a });
    }, /mark/);
  });

  it('a "constructor" key inside marks', () => {
    reject((raw) => {
      (raw.items[0] as { marks: Record<string, unknown> }).marks['constructor'] = { active: true, lamport: 1, replica: R.a };
    }, /mark/);
  });

  it('a "__proto__" key on the snapshot, an item, or the state vector', () => {
    reject((raw) => {
      own(raw, '__proto__', {});
    }, /exactly/);
    reject((raw) => {
      own(raw.items[0] as object, '__proto__', {});
    }, /keys/);
    reject((raw) => {
      own(raw.sv as object, '__proto__', 1);
    }, /replica id/);
  });

  it('a mark name outside MarkName, and a mark register with a bad shape', () => {
    reject((raw) => {
      (raw.items[0] as { marks: Record<string, unknown> }).marks['underline'] = { active: true, lamport: 1, replica: R.a };
    }, /mark/);
    reject((raw) => {
      (raw.items[0] as { marks: Record<string, unknown> }).marks['bold'] = { active: 'yes', lamport: 1, replica: R.a };
    }, /mark/);
    reject((raw) => {
      (raw.items[0] as { marks: Record<string, unknown> }).marks['bold'] = { active: true, lamport: 1, replica: R.a, extra: 1 };
    }, /mark/);
  });

  it('a parked op that is malformed, not covered by the sv, a duplicate of an item or of another parked op, or has every dependency present', () => {
    const rep = new Replica(R.a);
    rep.type(0, 'a');
    const orphan = ins(id(R.c, 1), id(R.d, 1), 'R', char('x'));
    const withPending = encodeSnapshot(apply(rep.doc, orphan).doc);
    const rejectPending = (edit: (pending: Record<string, unknown>[]) => void, why: RegExp): void => {
      expect(() => decodeSnapshot(mutate(withPending, (raw) => edit(raw['pending'] as Record<string, unknown>[])))).toThrow(why);
    };
    rejectPending((p) => {
      p[0]!['parent'] = null;
    }, /pending op is MALFORMED/);
    rejectPending((p) => {
      p[0]!['t'] = 'mov';
    }, /pending op is MALFORMED/);
    rejectPending((p) => {
      p[0]!['parent'] = ROOT.id;
      p[0]!['side'] = 'L';
    }, /pending op is BAD_PARENT_SIDE/);
    rejectPending((p) => {
      (p[0]!['id'] as { seq: number }).seq = 2;
    }, /not covered by sv/);
    rejectPending((p) => {
      p[0]!['id'] = id(R.a, 1);
    }, /duplicates an item/);
    rejectPending((p) => {
      p.push({ ...p[0]! });
    }, /duplicates an item or another pending op/);
    rejectPending((p) => {
      p[0]!['parent'] = id(R.a, 1);
    }, /every dependency present/);
    expect(() => decodeSnapshot(mutate(withPending, (raw) => void (raw['pending'] = {})))).toThrow(/pending is not an array/);
    expect(() => decodeSnapshot(mutate(withPending, (raw) => void (raw['formatLamport'] = -1)))).toThrow(/formatLamport/);
    expect(() => decodeSnapshot(mutate(withPending, (raw) => void (raw['formatLamport'] = MAX_LAMPORT + 1)))).toThrow(/formatLamport/);
  });

  it('a formatLamport below a register it must have seen', () => {
    reject((raw) => {
      raw['formatLamport'] = 0;
    }, /below a register/);
  });

  it('a tombstone may carry the stripped text "" but a visible character may not, and a register without seq is refused', () => {
    reject((raw) => {
      (raw.items[0]!['content'] as { text: string }).text = '';
    }, /content/);
    reject((raw) => {
      delete (raw.items[0]!['marks'] as Record<string, Record<string, unknown>>)['bold']!['seq'];
    }, /mark/);
    reject((raw) => {
      delete (raw.items[3]!['content'] as Record<string, unknown>)['seq'];
    }, /content/);
  });

  it('the wrong version, a non-object, a missing field, or an extra field', () => {
    reject((raw) => {
      raw['v'] = 2;
    }, /version/);
    reject((raw) => {
      raw['extra'] = true;
    }, /exactly/);
    expect(() => decodeSnapshot(null as unknown as Snapshot)).toThrow(/exactly/);
    expect(() => decodeSnapshot([] as unknown as Snapshot)).toThrow(/exactly/);
    reject((raw) => {
      (raw as Record<string, unknown>)['items'] = {};
    }, /array/);
  });

  it('a state vector that is not an object, has a non-replica key, or a non-integer value', () => {
    reject((raw) => {
      raw['sv'] = [];
    }, /sv/);
    reject((raw) => {
      (raw.sv as Record<string, unknown>)['not-a-replica'] = 1;
    }, /replica id/);
    reject((raw) => {
      (raw.sv as Record<string, unknown>)[R.a] = 1.5;
    }, /integer/);
    reject((raw) => {
      (raw.sv as Record<string, unknown>)[R.a] = -1;
    }, /integer/);
  });

  it('an item the state vector does not cover', () => {
    reject((raw) => {
      (raw.sv as Record<string, unknown>)[R.a] = 2;
    }, /covered/);
  });

  it('malformed ids, sides, content and flags on an item', () => {
    reject((raw) => {
      raw.items[0]!['id'] = { replica: 'short', seq: 1 }; // no such replica in sv, whose keys are regex-checked
    }, /not covered by sv/);
    reject((raw) => {
      raw.items[0]!['id'] = { replica: 42, seq: 1 };
    }, /malformed/);
    reject((raw) => {
      raw.items[0]!['id'] = { replica: R.a, seq: 0 };
    }, /malformed/);
    reject((raw) => {
      raw.items[0]!['parent'] = { replica: R.a, seq: '0' };
    }, /parent/);
    reject((raw) => {
      raw.items[0]!['side'] = 'M';
    }, /side/);
    reject((raw) => {
      raw.items[0]!['content'] = { kind: 'char' };
    }, /content/);
    reject((raw) => {
      raw.items[0]!['content'] = { kind: 'block', attrs: { type: 'table' }, lamport: 0, replica: R.a };
    }, /content/);
    reject((raw) => {
      raw.items[0]!['content'] = { kind: 'block', attrs: { type: 'heading', level: 4 }, lamport: 0, replica: R.a };
    }, /content/);
    reject((raw) => {
      raw.items[0]!['deleted'] = 'no';
    }, /deleted/);
  });

  it('a self-parent, a left child of ROOT, a duplicate id, an unknown parent, and a cycle', () => {
    reject((raw) => {
      raw.items[0]!['parent'] = raw.items[0]!['id'];
    }, /own parent/);
    reject((raw) => {
      raw.items[0]!['side'] = 'L';
    }, /left child of ROOT/);
    reject((raw) => {
      raw.items.push({ ...raw.items[0]! });
    }, /duplicate/);
    reject((raw) => {
      raw.items[1]!['parent'] = { replica: R.d, seq: 9 };
    }, /unknown parent/);
    reject((raw) => {
      // items 1 and 2 point at each other: neither hangs from ROOT any more.
      raw.items[1]!['parent'] = raw.items[2]!['id'];
      raw.items[2]!['parent'] = raw.items[1]!['id'];
      raw.items[3]!['parent'] = raw.items[0]!['id'];
    }, /cycle/);
    reject((raw) => {
      // a longer cycle hanging off itself, with a tail item pointing into it
      raw.items[0]!['parent'] = raw.items[3]!['id'];
    }, /cycle/);
  });

  it('an item that names ROOT’s own id', () => {
    reject((raw) => {
      raw.items[0]!['id'] = ROOT.id;
    }, /malformed|duplicate/);
  });
});
