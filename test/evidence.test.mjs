import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import {
  SEQUENCE,
  buildCertifications,
  extractLoadKg,
  extractTemperatureC,
  parseReport,
} from '../tools/evidence.mjs';

const bundle = readBundle();
const reportById = Object.fromEntries(bundle.reports.map(report => [report.id, report]));

test('温度与计量单位换算：华氏、零下、负十度、克与公斤', () => {
  assert.equal(extractTemperatureC(reportById.r5.text).celsius, -10); // 华氏14度
  assert.equal(extractTemperatureC(reportById.r1.text).celsius, -10); // 零下10℃
  assert.equal(extractTemperatureC(reportById.r2.text).celsius, -10); // −10 °C
  assert.equal(extractTemperatureC(reportById.r7.text).celsius, -10); // 负十度
  assert.equal(extractLoadKg(reportById.r3.text).kg, 0.95); // 950 g
  assert.equal(extractLoadKg(reportById.r1.text).kg, 1.2); // 1.2 kg
  assert.equal(extractLoadKg(reportById.r2.text).kg, 0.9); // 0.9 公斤
  assert.equal(extractLoadKg(reportById.r6.text).kg, 1.1); // 1.1 kg 以下
});

test('操作先后取报告原话，分清冷态封口与室温施胶', () => {
  const r1 = parseReport(reportById.r1);
  assert.equal(r1.sequence, SEQUENCE.WARM_COOL);
  assert.equal(r1.coldTack, false); // 不支持冷粘
  assert.ok(r1.sequenceRaw.includes('室温粘好再降'));
  const r2 = parseReport(reportById.r2);
  assert.equal(r2.sequence, SEQUENCE.COLD);
  assert.equal(r2.coldTack, true);
  const r5 = parseReport(reportById.r5);
  assert.equal(r5.coldTack, true);
  assert.equal(r5.filmFree, true); // 无需覆膜
  const r6 = parseReport(reportById.r6);
  assert.equal(r6.sequence, SEQUENCE.ROOM);
  assert.equal(r6.coldTack, false); // 冷线上不能施胶
});

test('试验对象与失败项：整套包装 / 组合 / 单层材料', () => {
  const r2 = parseReport(reportById.r2);
  assert.equal(r2.scope, '整套包装'); // 整包
  const r3 = parseReport(reportById.r3);
  assert.equal(r3.scope, '组合'); // 随气泡内层
  assert.ok(r3.failures.some(clause => clause.includes('单独内膜') && clause.includes('破裂')));
  assert.ok(r3.inheritsYesterday);
  const r7 = parseReport(reportById.r7);
  assert.equal(r7.scope, '单层材料'); // F1 中层单独低温放置
  assert.equal(r7.comboTested, false); // 未做组合封口
});

test('沿用昨日样件：继承同一作者前一天的前处理', () => {
  const { certs } = buildCertifications(bundle.reports, bundle.batches);
  const cert = certs.find(row => row.id === 'cert:b29+f41');
  assert.ok(cert.inherited.some(note => note.includes('r3') && note.includes('r2')));
  assert.equal(cert.sequence, SEQUENCE.COLD); // r3 继承 r2 的冷态封口前处理
});

test('更正只补条件：r2/r3 结论改为仅在随附覆膜时有效，原记录保留', () => {
  const pre = buildCertifications(bundle.reports, bundle.batches, { corrected: false });
  const post = buildCertifications(bundle.reports, bundle.batches, { corrected: true });
  const preCert = pre.certs.find(row => row.id === 'cert:b29+f41');
  const postCert = post.certs.find(row => row.id === 'cert:b29+f41');
  assert.equal(preCert.requiresFilm, null); // 班组当时看到的承诺不含覆膜条件
  assert.equal(postCert.requiresFilm.batch, 't01');
  assert.deepEqual([...postCert.corrections].sort(), ['r4', 'r8']);
  assert.equal(postCert.tempC, -10);
  assert.equal(postCert.loadKg, 0.9); // r2 的 0.9 与 r3 的 0.95 取更严
  assert.ok(postCert.requiredBatches.includes('t01'));
});

test('不同批次组之间不互借结论', () => {
  const { certs } = buildCertifications(bundle.reports, bundle.batches);
  const oldGlue = certs.find(row => row.id === 'cert:b17+f16');
  assert.equal(oldGlue.coldTack, false); // 旧胶黏剂仍不可冷粘，没借用 r2 的冷粘结论
  assert.equal(oldGlue.loadKg, 1.2);
  const newGlue = certs.find(row => row.id === 'cert:b29+f41');
  assert.equal(newGlue.loadKg, 0.9); // 新胶黏剂没借用 r1 的 1.2 kg 载重
});

test('单层放置的记录不能作为组合替代依据', () => {
  const { certs, rejected } = buildCertifications(bundle.reports, bundle.batches);
  assert.ok(!certs.some(cert => cert.batches.includes('f16') && cert.batches.includes('b29')));
  const r7 = rejected.find(row => row.reports.includes('r7'));
  assert.ok(r7);
  assert.ok(r7.notes.some(note => note.includes('同名不能互推'))); // 泊膜 L 有 F1/F2 两配方
});
