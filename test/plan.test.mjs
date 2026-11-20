import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import { buildCertifications } from '../tools/evidence.mjs';
import { analyzeImpact } from '../tools/impact.mjs';
import { buildPlan, computeStock, parseParcelNeeds } from '../tools/plan.mjs';

const bundle = readBundle();
const pre = buildCertifications(bundle.reports, bundle.batches, { corrected: false });
const post = buildCertifications(bundle.reports, bundle.batches, { corrected: true });
const impact = analyzeImpact(bundle, pre, post);
const plan = buildPlan(bundle, post.certs, impact);

test('包裹需求解析：施胶模式、最低温度、组件要求', () => {
  const p1 = parseParcelNeeds(bundle.parcels.find(parcel => parcel.id === 'p1'));
  assert.equal(p1.mode, '冷车施胶');
  assert.equal(p1.minTempC, -10);
  assert.deepEqual(p1.requiredComponents, ['内膜', '胶带']); // 必须同时出一套内膜和胶带
  const p3 = parseParcelNeeds(bundle.parcels.find(parcel => parcel.id === 'p3'));
  assert.ok(p3.forbidStandaloneFilm); // 怕压，不得用单独内膜
  const p4 = parseParcelNeeds(bundle.parcels.find(parcel => parcel.id === 'p4'));
  assert.equal(p4.mode, '室温施胶');
  assert.equal(p4.minTempC, null);
});

test('逐包裹评估：可行与不可行都给出原因', () => {
  const byCert = Object.fromEntries(plan.evaluations.get('p2').map(entry => [entry.cert.id, entry]));
  assert.ok(byCert['cert:b29+f41'].feasible); // 0.89 ≤ 0.9，需随附覆膜 t01
  assert.ok(!byCert['cert:b42+f52'].feasible); // 0.85 < 0.89
  assert.ok(byCert['cert:b42+f52'].reasons.some(reason => reason.includes('0.85')));
  assert.ok(!byCert['cert:b17+f16'].feasible); // r1 不支持冷粘
  const p5 = Object.fromEntries(plan.evaluations.get('p5').map(entry => [entry.cert.id, entry]));
  assert.ok(p5['cert:b17+f16'].feasible); // 1.18 ≤ 1.2
  assert.ok(!p5['cert:b17+s81'].feasible); // 1.18 > 1.1
});

test('先保已确认且可行的承诺，再按优先级与货架实数分配', () => {
  const decision = id => plan.decisions.get(id);
  assert.equal(decision('p4').kind, 'covered'); // w4 依据未受影响，继续有效
  assert.equal(decision('p3').kind, 'sealed-affected'); // 已封，只能跟进
  assert.equal(decision('p1').kind, 'assigned');
  assert.equal(decision('p1').cert.id, 'cert:b42+f52'); // 覆膜 t01 让予只能走 b29+f41 的 p2
  assert.equal(decision('p2').cert.id, 'cert:b29+f41');
  assert.equal(decision('p5').cert.id, 'cert:b17+f16');
  assert.equal(decision('p6').kind, 'unfulfilled'); // 货架不足，不硬凑
});

test('并列与备选：可行但未采纳的方案说明去向', () => {
  const p1 = plan.decisions.get('p1');
  const alternative = p1.alternatives.find(entry => entry.cert.id === 'cert:b29+f41');
  assert.ok(alternative.note.includes('t01'));
  assert.ok(alternative.note.includes('p2'));
});

test('退料在途不计入可分配库存，未满足包裹给出下一步', () => {
  assert.equal(plan.stock.available.get('b42'), 1); // 货架实数 1，在途退料不另加
  assert.ok(plan.stock.inTransit.some(pick => pick.id === 'w5'));
  const p6 = plan.decisions.get('p6');
  assert.ok(p6.nextSteps.some(step => step.includes('在途') && step.includes('不计入库存')));
});

test('已确认且待领的承诺会预留货架额度', () => {
  const batches = [{ id: 'x1', component: '胶带', product: 'P', recipe: 'R', units: 2, shelf: '冷线库' }];
  const picklists = [
    { id: 'w', parcel: 'p', stage: '待领', components: ['x1'], reports: [], time: '2026-11-19T00:00:00+08:00' },
  ];
  const stock = computeStock(batches, picklists, new Set(['w']));
  assert.equal(stock.available.get('x1'), 1); // 2 件货架数预留 1 件给有效待领单
  assert.deepEqual(stock.reserved, [{ picklist: 'w', batch: 'x1' }]);
});
