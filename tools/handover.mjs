// 交接视图入口：班组视图（可换方案与用法、不能换的原因）＋
// 质量视图（更正影响、承诺快照与试验原文、更正后待办）。
//
//   node tools/handover.mjs

import { readBundle } from './materials.mjs';
import { buildCertifications } from './evidence.mjs';
import { buildPlan } from './plan.mjs';
import { analyzeImpact, buildNextSteps } from './impact.mjs';

function batchLabel(batchById, id) {
  const batch = batchById.get(id);
  return batch ? `${id}（${batch.component} ${batch.product}/${batch.recipe}）` : id;
}

function certLabel(cert, batchById) {
  return cert.requiredBatches.map(id => batchLabel(batchById, id)).join(' ＋ ');
}

function formatParcelLine(parcel) {
  return `【${parcel.id}】${parcel.route} · 优先级 ${parcel.priority} · 限重 ${parcel.limitKg} kg · ${parcel.condition}`;
}

function formatTeamView(bundle, plan, impact, batchById) {
  const lines = ['========== 班组视图（可换方案与用法） ==========', ''];
  const affectedByPicklist = new Map(impact.affected.map(entry => [entry.picklist.id, entry]));
  const parcels = [...bundle.parcels].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  for (const parcel of parcels) {
    const decision = plan.decisions.get(parcel.id);
    const evaluation = plan.evaluations.get(parcel.id);
    lines.push(formatParcelLine(parcel));
    lines.push(`  同车班限制：${parcel.laterUse}`);
    if (!decision) continue;
    switch (decision.kind) {
      case 'assigned': {
        lines.push(`  建议配组：${certLabel(decision.cert, batchById)}`);
        lines.push(`    用法：${decision.cert.usage}`);
        for (const alternative of decision.alternatives) {
          lines.push(`  备选（未采纳）：${certLabel(alternative.cert, batchById)} —— ${alternative.note}`);
        }
        break;
      }
      case 'options':
        lines.push('  并列方案（交班组选择，不擅自释放已确认物料）：');
        for (const cert of decision.certs) {
          lines.push(`    · ${certLabel(cert, batchById)}`);
          lines.push(`      用法：${cert.usage}`);
        }
        break;
      case 'covered': {
        lines.push(`  已确认承诺继续有效：${decision.picklist.id}（${decision.picklist.stage}，${decision.picklist.components.join('＋')}）`);
        if (decision.cert) lines.push(`    用法：${decision.cert.usage}`);
        break;
      }
      case 'sealed-affected':
        lines.push(`  已封（${decision.picklist.id}）：依据已被更正，见质量视图 —— 发出需跟进通知，保留实际使用记录`);
        break;
      case 'sealed-ok':
        lines.push(`  已封（${decision.picklist.id}）：依据未受影响`);
        break;
      case 'unfulfilled':
        lines.push('  暂无可用配组。各候选情况：');
        for (const block of decision.blocks) {
          lines.push(`    ✗ ${certLabel(block.cert, batchById)} —— ${block.blockedBy.join('；')}`);
        }
        for (const step of decision.nextSteps) lines.push(`  下一步：${step}`);
        break;
      default:
        break;
    }
    // 不可换的原因（已建议/已覆盖的组合不重复列出）。
    const shown = new Set();
    if (decision.cert) shown.add(decision.cert.id);
    if (decision.certs) for (const cert of decision.certs) shown.add(cert.id);
    if (decision.alternatives) for (const alt of decision.alternatives) shown.add(alt.cert.id);
    const infeasible = (evaluation ?? []).filter(entry => !entry.feasible && !shown.has(entry.cert.id));
    if (infeasible.length && decision.kind !== 'unfulfilled' && !decision.kind.startsWith('sealed')) {
      lines.push('  不可换：');
      for (const entry of infeasible) {
        lines.push(`    ✗ ${certLabel(entry.cert, batchById)} —— ${entry.reasons.join('；')}`);
      }
    }
    const pick = bundle.picklists.find(row => row.parcel === parcel.id && affectedByPicklist.has(row.id));
    if (pick && decision.kind === 'assigned') {
      lines.push(`  注：原承诺 ${pick.id}（${pick.components.join('＋')}）因更正失去依据，已按上表处理。`);
    }
    lines.push('');
  }
  return lines;
}

function formatQualityView(bundle, plan, impact, post, batchById) {
  const lines = ['========== 质量视图（更正影响与追溯） ==========', ''];
  lines.push('更正登记：');
  for (const correction of impact.corrections) {
    lines.push(`  ${correction.id}（${correction.author}，${correction.date}）修订 ${correction.revises}：「${correction.text}」`);
  }
  lines.push('');
  lines.push('受影响的替代承诺：');
  const reportById = new Map(bundle.reports.map(report => [report.id, report]));
  for (const entry of impact.affected) {
    const { picklist } = entry;
    const parcel = bundle.parcels.find(row => row.id === picklist.parcel);
    const decision = plan.decisions.get(parcel.id);
    const steps = buildNextSteps(entry, parcel, decision, batchById);
    lines.push(`  ${picklist.id}（${parcel.id}，${picklist.stage}，${picklist.time} 登记）`);
    lines.push(`    当时承诺：${picklist.components.join('＋')} —— ${entry.preCert ? entry.preCert.usage : '（无匹配证据组合）'}`);
    lines.push(`    试验原文：${picklist.reports.map(id => `${id}「${reportById.get(id).text}」`).join('；')}`);
    lines.push(`    更正原文：${entry.corrections.map(report => `${report.id}「${report.text}」`).join('；')}`);
    lines.push(`    失去依据：缺 ${entry.missing.map(id => batchLabel(batchById, id)).join('、') || '更正后新增条件'}`);
    for (const step of steps) lines.push(`    下一步：${step}`);
  }
  lines.push('');
  lines.push('未受影响（不一并作废）：');
  for (const entry of impact.unaffected) {
    const extra = entry.picklist.stage === '退料在途' ? '；在途退料不计入可分配库存，到库复检后方可再领' : '';
    lines.push(`  ${entry.picklist.id}（${entry.picklist.parcel}，${entry.picklist.stage}）：${entry.reason}${extra}`);
  }
  lines.push('');
  lines.push('不可作为替代依据的记录：');
  for (const rejected of post.rejected) {
    lines.push(`  ${rejected.reports.join('＋')}（${rejected.batches.join('＋')}）：${rejected.reason}`);
    for (const note of rejected.notes) lines.push(`    ${note}`);
  }
  lines.push('');
  const remaining = [...plan.stock.remaining.entries()].map(([id, units]) => `${id} ${units}`).join('、');
  lines.push(`库存口径：货架实数已扣除已领与在途退料；有效待领承诺已预留额度。本次分配后余量：${remaining}。`);
  return lines;
}

export function buildReport(bundle) {
  const batchById = new Map(bundle.batches.map(batch => [batch.id, batch]));
  const pre = buildCertifications(bundle.reports, bundle.batches, { corrected: false });
  const post = buildCertifications(bundle.reports, bundle.batches, { corrected: true });
  const impact = analyzeImpact(bundle, pre, post);
  const plan = buildPlan(bundle, post.certs, impact);
  return [
    ...formatTeamView(bundle, plan, impact, batchById),
    ...formatQualityView(bundle, plan, impact, post, batchById),
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(buildReport(readBundle()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
