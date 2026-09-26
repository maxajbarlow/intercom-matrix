'use strict';
// Unit tests for lib/conference-match — deciding when conferences on different
// systems are the same channel. Cases are real names from the F1, F2/F3 and ROC
// Geneva prints.

const { test } = require('node:test');
const assert = require('node:assert');
const { matchKey, clusterDests } = require('../lib/conference-match');

const C = (name, label = '', kind = 'conference') => ({ name, label, kind });
const same = (a, b) => assert.ok(matchKey(a) && matchKey(a) === matchKey(b), `${a.name} ≈ ${b.name}`);
const differ = (a, b) => assert.notStrictEqual(matchKey(a), matchKey(b), `${a.name} ≠ ${b.name}`);

test('matchKey: identical names match', () => same(C('Race Control'), C('Race Control')));

test('matchKey: case, punctuation and word order are ignored', () => {
  same(C('Thomas Tanja', 'T&T'), C('thomas-tanja', 'T&T'));
  same(C('IT/F3', 'ITF3'), C('F3/IT', 'F3/IT'));
  same(C('F2<>Intercom', 'F2<>IC'), C('Intercom<>F2', 'IC<>F2'));
  same(C('F2/Sysops'), C('SysOps/F2'));
});

test('matchKey: system tags (IM- prefix, [BRACKET] tags) are stripped', () => {
  same(C('Radio Safety Car Main SC', 'Main'), C('IM-Radio Safety Car Main SC', 'Main'));
  same(C('Radio Safety Car Main SC', 'Main'), C('[FIA] RADIO SAFETY CAR MAIN SC', 'Main'));
  same(C('Red Bull Audio VERSTAPPEN', 'VER'), C('[DRV] RED BULL AUDIO VERSTAPPEN', 'VER'));
  same(C('Sky TV Audio Sky', 'TV'), C('[TV] SKY TV AUDIO Sky', 'TV'));
});

test('matchKey: a trailing copy of the conference\'s own label is stripped', () => {
  same(C('F1AC Prema Pitstand'), C('F1AC Prema Pitstand PRPStand', 'PRPStand'));
  same(C('F1AC Prema TP<>TM', 'PRTM<>TP'), C('F1AC Prema TP<>TM PRTM<>TP', 'PRTM<>TP'));
});

test('matchKey: repeated words collapse', () => same(C('F3 Geneva Stewards', 'GenStwF3'), C('F3 Geneva Stewards F3', 'Gen')));

test('matchKey: different numbers never match', () => {
  differ(C('PMSC Driver 08 PMSC'), C('PMSC Driver 09 PMSC'));
  differ(C('F2 AIX Car 2 #25', 'BAR'), C('F2 AIX Car 2 #21', 'SHI'));
});

test('matchKey: default placeholders never match anything', () => {
  assert.equal(matchKey(C('Conference #001 CNF', '#001')), null);
  assert.equal(matchKey(C('DynaConf', 'DynaConf')), null);
  assert.equal(matchKey(C('DYNACONF', 'DYNACONF')), null);
});

test('matchKey: a conference and a group never match', () => differ(C('All Call', '', 'conference'), C('All Call', '', 'group')));

const SYSTEMS = [{ id: 'f1', name: 'F1' }, { id: 'f2f3', name: 'F2 / F3' }, { id: 'roc', name: 'ROC Geneva' }];

test('clusterDests: merges one conference per system, named after the first system', () => {
  const out = clusterDests(SYSTEMS, {
    f1: [C('Race Control', 'RC'), C('Stewards')],
    f2f3: [C('IM-Race Control', 'RC'), C('F2 Only')],
    roc: [C('[FIA] RACE CONTROL', 'RC')],
  });
  const rc = out.find((d) => d.name === 'Race Control');
  assert.deepStrictEqual(rc.variants.map((v) => [v.system, v.name]), [['f1', 'Race Control'], ['f2f3', 'IM-Race Control'], ['roc', '[FIA] RACE CONTROL']]);
  assert.equal(rc.matched, true);
  assert.equal(rc.label, 'RC');
  const solo = out.find((d) => d.name === 'F2 Only');
  assert.equal(solo.matched, false);
  assert.deepStrictEqual(solo.variants.map((v) => v.system), ['f2f3']);
  assert.equal(out.length, 3);
});

test('clusterDests: the display name follows system order, not input order', () => {
  const out = clusterDests(SYSTEMS, { roc: [C('[FIA] RACE CONTROL')], f2f3: [C('IM-Race Control')] });
  assert.equal(out[0].name, 'IM-Race Control');
});

test('clusterDests: placeholders stay one column per system', () => {
  const out = clusterDests(SYSTEMS, { f1: [C('Conference #001 CNF', '#001')], f2f3: [C('Conference #001 CNF', '#001')] });
  assert.equal(out.length, 2);
  assert.ok(out.every((d) => !d.matched && d.variants.length === 1));
});

test('clusterDests: a key that is ambiguous within one system is not merged', () => {
  // two F1 conferences reduce to the same key → neither is paired with F2/F3's
  const out = clusterDests(SYSTEMS, {
    f1: [C('Race Control'), C('IM-Race Control')],
    f2f3: [C('Race Control')],
  });
  assert.equal(out.length, 3);
  assert.ok(out.every((d) => d.variants.length === 1));
});

test('clusterDests: ids are unique and stable', () => {
  const input = { f1: [C('A'), C('B')], f2f3: [C('A'), C('B', '', 'group')] };
  const a = clusterDests(SYSTEMS, input), b = clusterDests(SYSTEMS, input);
  assert.deepStrictEqual(a.map((d) => d.id), b.map((d) => d.id));
  assert.equal(new Set(a.map((d) => d.id)).size, a.length);
});
