import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBundle, readCollection } from '../tools/materials.mjs';

test('接件资料包含原文和原始记录', () => {
  const bundle = readBundle();
  const excerpts = [["reports", "r4", "该层已经带盖片"], ["reports", "r1", "不支持冷粘"], ["reports", "r5", "华氏14度"], ["picklists", "w5", ""], ["parcels", "p2", "与 p1 同车"]];
  for (const [group, id, phrase] of excerpts) {
    const entry = bundle[group].find(row => row.id === id);
    assert.ok(entry, `${group}/${id} 缺少来件`);
    if (phrase) assert.ok(Object.values(entry).some(value => typeof value === 'string' && value.includes(phrase)), `${group}/${id} 的源文字缺少约定片段`);
  }
});

test('拒绝缺少正式字段的接件', t => {
  const directory = mkdtempSync(join(tmpdir(), 'packaging-substitution-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'batches.json'), JSON.stringify([{ id: 'bad' }]));
  assert.throws(() => readCollection('batches', pathToFileURL(directory + sep)), TypeError);
});

test('已领备料单保留批签和原试验单的接件时间', () => {
  const { picklists, reports, parcels } = readBundle();
  for (const pick of picklists) {
    assert.ok(pick.components.length);
    assert.ok(parcels.find(row => row.id === pick.parcel).limitKg > 0);
    for (const id of pick.reports) {
      assert.ok(Date.parse(reports.find(row => row.id === id).date) <= Date.parse(pick.time));
    }
  }
});
