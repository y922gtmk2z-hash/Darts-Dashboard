import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundRobinPairings, orderMatches, generateLeagueFixtures, backToBackCount } from '../js/logic/fixtures.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const pairKey = (m) => [m.homeId, m.awayId].sort().join('|');

for (let n = 2; n <= 16; n++) {
  test(`single round robin, ${n} teams: every pair exactly once, nobody twice in a round`, () => {
    const matches = roundRobinPairings(ids(n));
    assert.equal(matches.length, (n * (n - 1)) / 2);
    const pairs = new Map();
    for (const m of matches) {
      assert.notEqual(m.homeId, m.awayId);
      assert.ok(m.homeId && m.awayId, 'no bye placeholders in output');
      pairs.set(pairKey(m), (pairs.get(pairKey(m)) ?? 0) + 1);
    }
    assert.equal(pairs.size, (n * (n - 1)) / 2);
    assert.ok([...pairs.values()].every((c) => c === 1));

    const rounds = new Map();
    for (const m of matches) {
      const set = rounds.get(m.round) ?? new Set();
      assert.ok(!set.has(m.homeId) && !set.has(m.awayId), `team twice in round ${m.round}`);
      set.add(m.homeId).add(m.awayId);
      rounds.set(m.round, set);
    }
    assert.equal(rounds.size, n % 2 ? n : n - 1);
    // Odd count: exactly one team has a bye in each round.
    for (const set of rounds.values()) assert.equal(set.size, n % 2 ? n - 1 : n);
  });

  test(`double round robin, ${n} teams: every pair twice with home/away swapped`, () => {
    const matches = roundRobinPairings(ids(n), { double: true });
    assert.equal(matches.length, n * (n - 1));
    const directed = new Set(matches.map((m) => `${m.homeId}>${m.awayId}`));
    assert.equal(directed.size, n * (n - 1), 'each ordered pairing once');
    const counts = new Map();
    for (const m of matches) counts.set(pairKey(m), (counts.get(pairKey(m)) ?? 0) + 1);
    assert.ok([...counts.values()].every((c) => c === 2));
  });
}

test('home/away is reasonably balanced in a single round robin', () => {
  const n = 8;
  const home = new Map();
  for (const m of roundRobinPairings(ids(n))) home.set(m.homeId, (home.get(m.homeId) ?? 0) + 1);
  for (const id of ids(n)) {
    const h = home.get(id) ?? 0;
    assert.ok(h >= 2 && h <= 5, `${id} home ${h} times`);
  }
});

test('ordering keeps every match and avoids back-to-back where possible', () => {
  for (let n = 5; n <= 16; n++) {
    for (const double of [false, true]) {
      const matches = roundRobinPairings(ids(n), { double });
      const ordered = orderMatches(matches, 2);
      assert.equal(ordered.length, matches.length);
      assert.deepEqual(new Set(ordered.map((m) => `${m.homeId}>${m.awayId}`)), new Set(matches.map((m) => `${m.homeId}>${m.awayId}`)));
      // With two boards running, a team must never be in two adjacent matches.
      assert.equal(backToBackCount(ordered, 1), 0, `${n} teams double=${double}: adjacent clash`);
    }
  }
});

test('ordering with 8+ teams gives every team a rest of at least one match (gap 2)', () => {
  // With fewer than 8 teams and two boards running, a short rest is unavoidable.
  for (const n of [8, 9, 10, 11, 12, 13, 14, 15, 16]) {
    for (const double of [false, true]) {
      const ordered = orderMatches(roundRobinPairings(ids(n), { double }), 2);
      assert.equal(backToBackCount(ordered, 2), 0, `${n} teams double=${double}`);
    }
  }
});

test('4 teams still produces a complete, valid schedule', () => {
  const f = generateLeagueFixtures(ids(4), { double: true });
  assert.equal(f.length, 12);
});

test('generateLeagueFixtures returns scheduled fixtures with sequential order and unique ids', () => {
  const f = generateLeagueFixtures(ids(8), { double: false });
  assert.equal(f.length, 28);
  assert.deepEqual(f.map((x) => x.order), Array.from({ length: 28 }, (_, i) => i + 1));
  assert.equal(new Set(f.map((x) => x.id)).size, 28);
  for (const x of f) {
    assert.equal(x.stage, 'league');
    assert.equal(x.status, 'scheduled');
    assert.equal(x.homeLegs, 0);
    assert.equal(x.board, null);
  }
});
