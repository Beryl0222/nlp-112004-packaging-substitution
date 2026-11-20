// 更正影响分析：试验记录被补记后，定位哪些替代承诺失去依据。
//
// 口径：
// - 只波及引用了被更正报告、且组件不满足更正后条件的备料单；
//   不依赖被更正证据的备料单一律保留，不一并作废。
// - 待领、已领未封给出可执行的下一步；已封只能发出需跟进通知并保留实际使用记录。
// - 退料在途不计入可分配库存，到库复检后方可再领。

function sameSet(a, b) {
  return a.length === b.length && a.every(value => b.includes(value));
}

export function analyzeImpact(bundle, pre, post) {
  const corrections = bundle.reports.filter(report => report.revises);
  const revisedIds = new Set(corrections.map(report => report.revises));
  const affected = [];
  const unaffected = [];
  for (const pick of bundle.picklists) {
    const hits = pick.reports.filter(id => revisedIds.has(id));
    if (!hits.length) {
      unaffected.push({ picklist: pick, reason: `依据 ${pick.reports.join('＋')} 未被更正` });
      continue;
    }
    // 更正前与该承诺组件完全匹配的证据组合，及其更正后的形态。
    const preCert = pre.certs.find(cert =>
      sameSet(cert.requiredBatches, pick.components)
      && cert.sources.some(source => pick.reports.includes(source)));
    const postCert = preCert ? post.certs.find(cert => cert.id === preCert.id) : null;
    if (postCert && sameSet(postCert.requiredBatches, pick.components)) {
      unaffected.push({ picklist: pick, reason: '组件已满足更正后条件' });
      continue;
    }
    const missing = postCert
      ? postCert.requiredBatches.filter(id => !pick.components.includes(id))
      : [];
    affected.push({
      picklist: pick,
      missing,
      preCert: preCert ?? null,
      postCert: postCert ?? null,
      corrections: corrections.filter(report => hits.includes(report.revises)),
    });
  }
  return { corrections, affected, unaffected };
}

// 按备料单状态给出可执行的下一步；planDecision 为规划模块对该包裹的决定。
export function buildNextSteps(entry, parcel, planDecision, batchById) {
  const { picklist, missing } = entry;
  const label = id => {
    const batch = batchById.get(id);
    return batch ? `${id}（${batch.component} ${batch.product}）` : id;
  };
  const missingLabel = missing.map(label).join('、') || '更正后新增条件';
  const correctionIds = entry.corrections.map(report => report.id).join('、');
  switch (picklist.stage) {
    case '待领': {
      const steps = [`暂缓领料：原承诺缺 ${missingLabel}，依据已被 ${correctionIds} 更正`];
      steps.push(planDecision?.cert
        ? `按新方案改派：${planDecision.cert.requiredBatches.map(label).join(' ＋ ')}`
        : '暂无可行替代，待质量意见');
      return steps;
    }
    case '已领未封': {
      const steps = [`暂停封车：已领组合缺 ${missingLabel}，依据已被 ${correctionIds} 更正`];
      const cert = planDecision?.cert;
      const repairable = cert
        && missing.every(id => cert.requiredBatches.includes(id))
        && picklist.components.every(id => cert.requiredBatches.includes(id));
      if (repairable) {
        steps.push(`补领 ${missingLabel} 后按更正后用法封合（见班组视图 ${parcel.id}）`);
        steps.push(`若无法补领，将已领 ${picklist.components.join('、')} 退换并改派`);
      } else if (cert) {
        steps.push(`将已领 ${picklist.components.join('、')} 退换，改派 ${cert.requiredBatches.map(label).join(' ＋ ')}`);
      } else {
        steps.push(`退换已领 ${picklist.components.join('、')}，等待质量意见`);
      }
      return steps;
    }
    case '已封':
      return [
        `已封车，不追回：发出需跟进通知（实际使用 ${picklist.components.join('、')}，缺 ${missingLabel}）`,
        '保留实际使用记录',
      ];
    case '退料在途':
      return [
        '退料在途不计入可分配库存',
        `到库后按更正后依据复检（缺 ${missingLabel}）`,
      ];
    default:
      return ['请质量复核'];
  }
}
