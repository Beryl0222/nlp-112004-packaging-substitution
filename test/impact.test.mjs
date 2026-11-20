import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import { buildCertifications } from '../tools/evidence.mjs';
import { analyzeImpact, buildNextSteps } from '../tools/impact.mjs';
import { buildPlan } from '../tools/plan.mjs';
import { buildReport } from '../tools/handover.mjs';

const bundle = readBundle();
const batchById = new Map(bundle.batches.map(batch => [batch.id, batch]));
const pre = buildCertifications(bundle.reports, bundle.batches, { corrected: false });
const post = buildCertifications(bundle.reports, bundle.batches, { corrected: true });
const impact = analyzeImpact(bundle, pre, post);
const plan = buildPlan(bundle, post.certs, impact);

test('更正只波及依赖被更正证据的承诺，不一并作废', () => {
  const affectedIds = impact.affected.map(entry => entry.picklist.id).sort();
  assert.deepEqual(affectedIds, ['w1', 'w2', 'w3']); // 都建立在被更正的 r2/r3 上
  const unaffectedIds = impact.unaffected.map(entry => entry.picklist.id).sort();
  assert.deepEqual(unaffectedIds, ['w4', 'w5']); // r1、r5 未被更正
  for (const entry of impact.affected) {
    assert.deepEqual(entry.missing, ['t01']); // 更正补记的覆膜
    assert.ok(entry.preCert); // 能还原当时看到的承诺
  }
});

test('按状态给出可执行的下一步', () => {
  const byId = Object.fromEntries(impact.affected.map(entry => [entry.picklist.id, entry]));
  const parcelOf = entry => bundle.parcels.find(parcel => parcel.id === entry.picklist.parcel);
  const stepsOf = entry => buildNextSteps(entry, parcelOf(entry), plan.decisions.get(entry.picklist.parcel), batchById);

  const w1 = stepsOf(byId.w1).join('\n');
  assert.ok(w1.includes('暂缓领料')); // 待领：暂缓并改派
  assert.ok(w1.includes('b42')); // 改派去向与班组视图一致

  const w2 = stepsOf(byId.w2).join('\n');
  assert.ok(w2.includes('暂停封车')); // 已领未封：补领或退换
  assert.ok(w2.includes('补领 t01'));
  assert.ok(w2.includes('退换'));

  const w3 = stepsOf(byId.w3).join('\n');
  assert.ok(w3.includes('需跟进通知')); // 已封：只能跟进并留记录
  assert.ok(w3.includes('保留实际使用记录'));
  assert.ok(!w3.includes('退换'));
});

test('交接报告：班组能看懂用法与不可换原因，质量能回查原文', () => {
  const report = buildReport(bundle);
  // 班组视图
  assert.ok(report.includes('必须随附覆膜 盖片 D（t01）'));
  assert.ok(report.includes('预先冷到华氏14度后封合')); // 操作先后取原话
  assert.ok(report.includes('载重上限 0.85 kg 低于包裹限重 0.89 kg')); // 不可换原因
  assert.ok(report.includes('不支持冷粘'));
  // 质量视图
  assert.ok(report.includes('当时承诺')); // 受影响包裹当时看到的承诺
  assert.ok(report.includes('整包先冷透至')); // 试验原文
  assert.ok(report.includes('冷粘前该层已经带盖片 D')); // 更正原文
  assert.ok(report.includes('在途退料不计入可分配库存'));
  assert.ok(report.includes('同名不能互推')); // r7 不可作为依据
});
