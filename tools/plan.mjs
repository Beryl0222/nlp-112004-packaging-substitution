// 包裹工况 × 证据组合 → 可行配组与优先级分配。
//
// 口径：
// - 先保已经确认且可行的备料承诺（待领的预留货架额度，已领/已封的不重派）。
// - 货架实数已扣除已领与在途退料；退料在途不计入可分配库存。
// - 报告写明某结果只在附加覆膜时有效，就把覆膜能否随班次领用纳入判断。
// - 同优先级并列方案全部列出交班组选择，不擅自释放已确认物料。

import { SEQUENCE } from './evidence.mjs';

export function parseParcelNeeds(parcel) {
  const { condition, laterUse } = parcel;
  const mode = /冷车内施胶|冷线/.test(condition) ? '冷车施胶'
    : /室温|常温/.test(condition) ? '室温施胶' : null;
  const tempMatch = condition.match(/最低\s*[−-]\s*(\d+(?:\.\d+)?)\s*°?\s*C/);
  const minTempC = tempMatch ? -Number(tempMatch[1]) : null;
  const requiredComponents = [];
  const both = laterUse.match(/必须同时出一套(\S+?)和(\S+?)[。，]/);
  if (both) requiredComponents.push(both[1], both[2]);
  if (/内膜不可漏/.test(laterUse)) requiredComponents.push('内膜');
  return {
    mode,
    minTempC,
    requiredComponents: [...new Set(requiredComponents)],
    forbidStandaloneFilm: /不得用单独内膜/.test(laterUse),
  };
}

// 逐证据组合评估包裹可行性；不可行时给出可读原因。
export function evaluateParcel(parcel, certs, ctx) {
  const needs = parseParcelNeeds(parcel);
  return certs.map(cert => {
    const reasons = [];
    const notes = [];
    if (needs.mode === '冷车施胶' && cert.coldTack !== true) {
      const detail = cert.coldTack === false ? '明确不可冷粘/冷线施胶' : '无冷态封口证据';
      reasons.push(`包裹需冷车内施胶，${cert.sources.join('＋')} ${detail}`);
    }
    if (needs.mode === '室温施胶' && cert.sequence !== SEQUENCE.WARM_COOL && cert.sequence !== SEQUENCE.ROOM) {
      reasons.push(`包裹需室温施胶后入冷车，${cert.sources.join('＋')} 无室温施胶证据`);
    }
    if (needs.minTempC !== null) {
      if (cert.tempC === null) reasons.push('试验未记录温度下限');
      else if (needs.minTempC < cert.tempC) {
        reasons.push(`试验温度仅覆盖至 ${cert.tempC}°C，线路最低 ${needs.minTempC}°C 无证据`);
      }
    }
    if (cert.loadKg === null) reasons.push('试验未记录载重上限');
    else if (parcel.limitKg > cert.loadKg) {
      reasons.push(`载重上限 ${cert.loadKg} kg 低于包裹限重 ${parcel.limitKg} kg`);
    }
    for (const component of needs.requiredComponents) {
      if (!cert.components.includes(component)) reasons.push(`缺少组件「${component}」`);
    }
    if (needs.forbidStandaloneFilm && cert.scope === '单层材料') {
      reasons.push('包裹怕压，不得用单独内膜');
    }
    if (cert.requiresFilm) {
      const filmBatch = ctx.batchById.get(cert.requiresFilm.batch);
      if (!filmBatch) {
        reasons.push(`覆膜 ${cert.requiresFilm.name} 无登记批次，不能随班次领用`);
      } else if ((ctx.available.get(filmBatch.id) ?? 0) <= 0) {
        reasons.push(`覆膜 ${filmBatch.id}（${filmBatch.product}）货架无可领数量，不能随班次领用`);
      } else {
        notes.push(`需随附覆膜 ${filmBatch.id}（${filmBatch.product}，${filmBatch.shelf}）`);
      }
    }
    return { cert, feasible: reasons.length === 0, reasons, notes };
  });
}

// 货架实数 − 有效待领承诺的预留 = 可分配数量。已领与在途退料本就不在货架数内。
export function computeStock(batches, picklists, validPicklistIds) {
  const available = new Map(batches.map(batch => [batch.id, batch.units]));
  const reserved = [];
  for (const pick of picklists) {
    if (pick.stage !== '待领' || !validPicklistIds.has(pick.id)) continue;
    for (const id of pick.components) {
      available.set(id, (available.get(id) ?? 0) - 1);
      reserved.push({ picklist: pick.id, batch: id });
    }
  }
  const inTransit = picklists.filter(pick => pick.stage === '退料在途');
  return { available, reserved, inTransit };
}

function compareVector(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

// 回溯搜索最优指派：按优先级从高到低，逐位比较「是否满足」，
// 收集全部最优解以识别并列方案。
export function allocate(demands, available) {
  const order = [...demands].sort(
    (a, b) => b.parcel.priority - a.parcel.priority || a.parcel.id.localeCompare(b.parcel.id),
  );
  const best = { vector: null, plans: [] };
  const hasStock = (remaining, ids) => ids.every(id => (remaining.get(id) ?? 0) > 0);
  const search = (index, remaining, assignment) => {
    if (index === order.length) {
      const vector = order.map(demand => (assignment.has(demand.parcel.id) ? 1 : 0));
      if (!best.vector || compareVector(vector, best.vector) > 0) {
        best.vector = vector;
        best.plans = [new Map(assignment)];
      } else if (compareVector(vector, best.vector) === 0) {
        best.plans.push(new Map(assignment));
      }
      return;
    }
    const demand = order[index];
    for (const cert of demand.options) {
      if (!hasStock(remaining, cert.requiredBatches)) continue;
      for (const id of cert.requiredBatches) remaining.set(id, remaining.get(id) - 1);
      assignment.set(demand.parcel.id, cert);
      search(index + 1, remaining, assignment);
      assignment.delete(demand.parcel.id);
      for (const id of cert.requiredBatches) remaining.set(id, remaining.get(id) + 1);
    }
    search(index + 1, remaining, assignment); // 该包裹暂不配组
  };
  search(0, new Map(available), new Map());
  return { order, ...best };
}

function remainingAfter(available, assignment) {
  const remaining = new Map(available);
  for (const cert of assignment.values()) {
    for (const id of cert.requiredBatches) remaining.set(id, (remaining.get(id) ?? 0) - 1);
  }
  return remaining;
}

export function buildPlan(bundle, certs, impact) {
  const batchById = new Map(bundle.batches.map(batch => [batch.id, batch]));
  const affectedIds = new Set(impact.affected.map(entry => entry.picklist.id));
  const validPicklistIds = new Set(
    bundle.picklists.filter(pick => !affectedIds.has(pick.id)).map(pick => pick.id),
  );
  const stock = computeStock(bundle.batches, bundle.picklists, validPicklistIds);

  const evaluations = new Map();
  for (const parcel of bundle.parcels) {
    evaluations.set(parcel.id, evaluateParcel(parcel, certs, { batchById, available: stock.available }));
  }

  const decisions = new Map();
  const demands = [];
  for (const parcel of bundle.parcels) {
    const picks = bundle.picklists.filter(pick => pick.parcel === parcel.id);
    const sealed = picks.find(pick => pick.stage === '已封');
    if (sealed) {
      decisions.set(parcel.id, {
        kind: affectedIds.has(sealed.id) ? 'sealed-affected' : 'sealed-ok',
        picklist: sealed,
      });
      continue;
    }
    const covering = picks.find(pick => validPicklistIds.has(pick.id) && pick.stage !== '退料在途');
    if (covering) {
      const cert = certs.find(c =>
        c.requiredBatches.length === covering.components.length
        && c.requiredBatches.every(id => covering.components.includes(id)));
      decisions.set(parcel.id, { kind: 'covered', picklist: covering, cert: cert ?? null });
      continue;
    }
    const options = evaluations.get(parcel.id).filter(entry => entry.feasible).map(entry => entry.cert);
    demands.push({ parcel, options });
  }

  const allocation = allocate(demands, stock.available);
  const chosen = allocation.plans[0] ?? new Map();
  const remaining = remainingAfter(stock.available, chosen);

  for (const demand of allocation.order) {
    const { parcel, options } = demand;
    const certsAcrossOptima = [...new Map(
      allocation.plans.filter(plan => plan.has(parcel.id)).map(plan => [plan.get(parcel.id).id, plan.get(parcel.id)]),
    ).values()];
    if (certsAcrossOptima.length > 1) {
      decisions.set(parcel.id, { kind: 'options', certs: certsAcrossOptima });
      continue;
    }
    if (certsAcrossOptima.length === 1) {
      const cert = certsAcrossOptima[0];
      const alternatives = options.filter(option => option.id !== cert.id).map(option => {
        const missing = option.requiredBatches.filter(id => (remaining.get(id) ?? 0) <= 0);
        const holders = [...chosen.entries()]
          .filter(([parcelId, chosenCert]) => parcelId !== parcel.id
            && chosenCert.requiredBatches.some(id => missing.includes(id)))
          .map(([parcelId]) => parcelId);
        const note = missing.length
          ? `缺 ${missing.join('、')}${holders.length ? `（已分给 ${holders.join('、')}）` : ''}`
          : '货架可满足，可与建议方案并列由班组选择';
        return { cert: option, note };
      });
      decisions.set(parcel.id, { kind: 'assigned', cert, alternatives });
      continue;
    }
    // 未满足：列出每个候选卡在哪，并给出可执行的下一步。
    const blocks = evaluations.get(parcel.id).map(entry => {
      if (!entry.feasible) return { cert: entry.cert, blockedBy: entry.reasons };
      const missing = entry.cert.requiredBatches.filter(id => (remaining.get(id) ?? 0) <= 0);
      const holders = [...chosen.entries()]
        .filter(([, chosenCert]) => chosenCert.requiredBatches.some(id => missing.includes(id)))
        .map(([parcelId]) => parcelId);
      return { cert: entry.cert, blockedBy: [`货架不足：缺 ${missing.join('、')}${holders.length ? `（已分给 ${holders.join('、')}）` : ''}`] };
    });
    const transitBatches = stock.inTransit.flatMap(pick => pick.components);
    const nextSteps = [];
    for (const entry of evaluations.get(parcel.id)) {
      if (!entry.feasible) continue;
      const missing = entry.cert.requiredBatches.filter(id => (remaining.get(id) ?? 0) <= 0);
      if (missing.length && missing.every(id => transitBatches.includes(id))) {
        nextSteps.push(`跟进退料在途单（${missing.join('、')}）到库复检后按 ${entry.cert.sources.join('＋')} 用法再领；在途退料不计入库存`);
      }
    }
    if (!nextSteps.length) nextSteps.push('申请新批次，或请质量补充试验证据后再评估');
    decisions.set(parcel.id, { kind: 'unfulfilled', blocks, nextSteps });
  }

  return { decisions, evaluations, stock: { ...stock, remaining }, allocation };
}
