// 试验记录原文 → 结构化事实 → 兼容合并为「证据组合」。
//
// 约定：
// - 结论只来自报告原文与登记批次；不同批次组之间不互借结论
//   （旧胶黏剂的冷粘表现不能贴到新胶黏剂的载重结论上）。
// - 更正报告（revises）只补充条件（例如前处理里漏记的覆膜），原记录保留。
// - 上限未注明严格小于时，等于该值仍属试验范围（见 README）。
// - 温度和载重做常规单位换算，操作先后保留报告原话。

export const SEQUENCE = {
  COLD: '冷态封口',
  WARM_COOL: '温态施胶后冷却',
  ROOM: '常温包装',
};

const CHINESE_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function parseChineseNumber(text) {
  if (!text) return null;
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    const t = tens === '' ? 1 : CHINESE_DIGITS[tens];
    const o = ones === '' ? 0 : CHINESE_DIGITS[ones];
    if (t === undefined || o === undefined) return null;
    return t * 10 + o;
  }
  return CHINESE_DIGITS[text] ?? null;
}

export function splitClauses(text) {
  return text.split(/[。；]/).map(clause => clause.trim()).filter(Boolean);
}

// 温度：识别 零下10℃、−10 °C、华氏14度、负十度，统一成摄氏度。
// 一条记录提到多个温度时取最冷值作为「试验覆盖至」。
export function extractTemperatureC(text) {
  const found = [];
  for (const match of text.matchAll(/华氏(\d+(?:\.\d+)?)度/g)) {
    found.push({ celsius: (Number(match[1]) - 32) * 5 / 9, raw: match[0] });
  }
  for (const match of text.matchAll(/零下\s*(\d+(?:\.\d+)?)\s*[°℃]\s*C?/g)) {
    found.push({ celsius: -Number(match[1]), raw: match[0] });
  }
  for (const match of text.matchAll(/[−-]\s*(\d+(?:\.\d+)?)\s*°\s*C/g)) {
    found.push({ celsius: -Number(match[1]), raw: match[0] });
  }
  for (const match of text.matchAll(/负([一二三四五六七八九十两]+)度/g)) {
    const value = parseChineseNumber(match[1]);
    if (value !== null) found.push({ celsius: -value, raw: match[0] });
  }
  if (!found.length) return null;
  found.sort((a, b) => a.celsius - b.celsius);
  return { celsius: found[0].celsius, raw: found[0].raw, all: found };
}

// 载重：识别 kg、公斤、千克、g、克，统一成 kg。取记录中最大的装样量。
export function extractLoadKg(text) {
  const found = [];
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(公斤|千克|kg|克|g)/gi)) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const kg = (unit === '克' || unit === 'g') ? value / 1000 : value;
    found.push({ kg, raw: match[0] });
  }
  if (!found.length) return null;
  found.sort((a, b) => b.kg - a.kg);
  return { kg: found[0].kg, raw: found[0].raw, all: found };
}

// 操作先后：先冷透再封口 = 冷态封口；室温粘好再降温 = 温态施胶后冷却；常温包装。
// 明确的否定表述（不支持冷粘 / 冷线上不能施胶）优先于其他推断。
export function extractSequence(text) {
  const clauses = splitClauses(text);
  for (const clause of clauses) {
    if (/(先|预先)[^，。；]*冷[^，。；]*[，、]?\s*(再|而后|后)[^，。；]*(封口|封合|施胶)/.test(clause)) {
      return { sequence: SEQUENCE.COLD, coldTack: true, raw: clause };
    }
  }
  for (const clause of clauses) {
    if (/(室温|常温)[^，。；]*(粘好|施胶|封口|封合|包装)[^，。；]*(再|后)[^，。；]*(降|冷|入)/.test(clause)) {
      return { sequence: SEQUENCE.WARM_COOL, coldTack: false, raw: clause };
    }
  }
  for (const clause of clauses) {
    if (/常温包装/.test(clause)) {
      return { sequence: SEQUENCE.ROOM, coldTack: false, raw: clause };
    }
  }
  return { sequence: null, coldTack: null, raw: null };
}

export function extractColdTackNegative(text) {
  return /不支持冷粘/.test(text) || /冷[^，。；]*不能施胶/.test(text);
}

// 失败项：含破裂、不支持、不能的分句原样保留。
export function extractFailures(text) {
  return splitClauses(text).filter(clause => /破裂|不支持|不能/.test(clause));
}

// 试验对象：整套包装 / 组合 / 单层材料。失败分句不参与对象判断
// （「单独内膜经擦拭后破裂」说的是失败项，不是说试验对象是单层）。
// 明确「未做组合封口」的记录直接判为单层材料，不作为组合证据。
export function extractScope(text, batchCount) {
  const comboTested = !/未做组合封口|未做[^。；]*封口|仅[^。；]*放置/.test(text);
  if (!comboTested) return { scope: '单层材料', comboTested };
  const body = splitClauses(text).filter(clause => !/破裂|不支持|不能/.test(clause)).join('。');
  let scope;
  if (/整包|整套|全包/.test(body)) scope = '整套包装';
  else if (/随[^。；]*内层|组合|搭配|一起/.test(body)) scope = '组合';
  else if (/单独|单层|中层/.test(body)) scope = '单层材料';
  else scope = batchCount > 1 ? '组合' : '单层材料';
  return { scope, comboTested };
}

// 覆膜：无需覆膜 / 具名（盖片 D 等）/ 仅提及。
export function extractFilmMention(text) {
  const filmFree = /无需覆膜/.test(text);
  const named = text.match(/盖片\s*[A-Za-z0-9]+/) || text.match(/覆膜\s*[A-Za-z0-9]+/);
  if (named) return { filmFree, name: named[0].replace(/\s+/g, ' ').trim() };
  if (/盖片/.test(text)) return { filmFree, name: '盖片' };
  if (/覆膜/.test(text)) return { filmFree, name: '覆膜' };
  return { filmFree, name: null };
}

export function parseReport(report) {
  const { text } = report;
  const temperature = extractTemperatureC(text);
  const load = extractLoadKg(text);
  const sequence = extractSequence(text);
  const negative = extractColdTackNegative(text);
  const scope = extractScope(text, report.batchIds.length);
  const film = extractFilmMention(text);
  const moistureClause = splitClauses(text).find(clause => /潮气|防潮/.test(clause)) ?? null;
  const featureClauses = splitClauses(text).filter(clause => /折口|折边/.test(clause));
  return {
    id: report.id,
    author: report.author,
    date: report.date,
    batchIds: [...report.batchIds],
    revises: report.revises ?? null,
    text,
    tempC: temperature ? temperature.celsius : null,
    tempRaw: temperature ? temperature.raw : null,
    loadKg: load ? load.kg : null,
    loadRaw: load ? load.raw : null,
    sequence: sequence.sequence,
    sequenceRaw: sequence.raw,
    coldTack: negative ? false : sequence.coldTack,
    scope: scope.scope,
    comboTested: scope.comboTested,
    failures: extractFailures(text),
    filmFree: film.filmFree,
    requiresFilm: null, // 仅由更正补入
    corrections: [],
    inheritsYesterday: /沿用昨日样件/.test(text),
    inheritedFrom: null,
    moisture: moistureClause,
    features: featureClauses,
  };
}

// 「沿用昨日样件」：继承同一作者前一天报告的试样与前处理。
export function linkInheritance(reports, factsById) {
  for (const report of reports) {
    const facts = factsById.get(report.id);
    if (!facts.inheritsYesterday) continue;
    const day = new Date(`${report.date}T00:00:00Z`);
    const prev = new Date(day.getTime() - 86400000).toISOString().slice(0, 10);
    const source = reports.find(row => row.author === report.author && row.date === prev && !row.revises);
    if (!source) continue;
    const inherited = factsById.get(source.id);
    facts.inheritedFrom = source.id;
    facts.sequence ??= inherited.sequence;
    facts.sequenceRaw ??= inherited.sequenceRaw;
    facts.coldTack ??= inherited.coldTack;
    facts.tempC ??= inherited.tempC;
    facts.tempRaw ??= inherited.tempRaw;
  }
}

// 更正：只补条件，不删原记录。提到盖片/覆膜时，从更正报告自己的
// batchIds 里找登记的覆膜批次，补为被修订报告的必要条件。
export function applyRevisions(reports, factsById, batchById) {
  const applied = [];
  for (const report of reports) {
    if (!report.revises) continue;
    const target = factsById.get(report.revises);
    if (!target) throw new Error(`更正 ${report.id} 找不到被修订报告 ${report.revises}`);
    const note = { id: report.id, author: report.author, date: report.date, text: report.text };
    if (/盖片|覆膜/.test(report.text)) {
      const filmBatch = report.batchIds.map(id => batchById.get(id)).find(batch => batch && batch.component === '覆膜');
      const mention = extractFilmMention(report.text);
      target.requiresFilm = {
        batch: filmBatch ? filmBatch.id : null,
        name: mention.name ?? (filmBatch ? filmBatch.product : '覆膜'),
      };
      note.adds = `必要条件：覆膜 ${target.requiresFilm.name}`;
    }
    if (/只补前处理/.test(report.text)) note.kind = '补前处理';
    target.corrections.push(note);
    applied.push({ correction: report.id, revises: report.revises, adds: note.adds ?? null });
  }
  return applied;
}

function formatTemp(celsius) {
  return celsius < 0 ? `−${Math.abs(celsius)}` : `${celsius}`;
}

function buildUsage(cert) {
  const parts = [];
  if (cert.sequenceRaw) parts.push(`操作先后（原话）：「${cert.sequenceRaw}」`);
  if (cert.tempC !== null) parts.push(`试验温度覆盖至 ${formatTemp(cert.tempC)}°C`);
  if (cert.loadKg !== null) parts.push(`载重 ≤ ${cert.loadKg} kg`);
  if (cert.requiresFilm) {
    parts.push(`必须随附覆膜 ${cert.requiresFilm.name}${cert.requiresFilm.batch ? `（${cert.requiresFilm.batch}）` : ''}`);
  } else if (cert.filmFree) {
    parts.push('无需覆膜');
  }
  for (const failure of cert.failures) parts.push(`注意：「${failure}」`);
  if (cert.moisture) parts.push(`防潮：「${cert.moisture}」`);
  for (const feature of cert.features) parts.push(`特点：「${feature}」`);
  const inheritNote = cert.inherited.length ? `（${cert.inherited.join('；')}）` : '';
  const correctionNote = cert.corrections.length ? `，经更正 ${cert.corrections.join('、')}` : '';
  parts.push(`依据 ${cert.sources.join('＋')}${inheritNote}${correctionNote}`);
  return parts.join('；');
}

function makeCert(group, batchById) {
  const batchIds = group[0].batchIds;
  const temps = group.map(facts => facts.tempC).filter(value => value !== null);
  const loads = group.map(facts => facts.loadKg).filter(value => value !== null);
  const requiresFilm = group.map(facts => facts.requiresFilm).find(Boolean) ?? null;
  const requiredBatches = [...batchIds];
  if (requiresFilm?.batch && !requiredBatches.includes(requiresFilm.batch)) {
    requiredBatches.push(requiresFilm.batch);
  }
  const components = [...new Set(requiredBatches.map(id => batchById.get(id)?.component).filter(Boolean))];
  const cert = {
    id: `cert:${[...batchIds].sort().join('+')}`,
    batches: [...batchIds],
    requiresFilm,
    requiredBatches,
    components,
    sequence: group[0].sequence,
    sequenceRaw: group.map(facts => facts.sequenceRaw).find(Boolean) ?? null,
    coldTack: group.every(facts => facts.coldTack === true) ? true
      : group.every(facts => facts.coldTack === false) ? false : null,
    // 合并取交集：温度取各记录中最保守（最暖）的下限，载重取最严（最小）的上限。
    tempC: temps.length ? Math.max(...temps) : null,
    loadKg: loads.length ? Math.min(...loads) : null,
    scope: group.some(facts => facts.scope === '整套包装') ? '整套包装' : '组合',
    failures: [...new Set(group.flatMap(facts => facts.failures))],
    filmFree: group.every(facts => facts.filmFree),
    moisture: group.map(facts => facts.moisture).find(Boolean) ?? null,
    features: [...new Set(group.flatMap(facts => facts.features))],
    sources: group.map(facts => facts.id),
    corrections: [...new Set(group.flatMap(facts => facts.corrections.map(note => note.id)))],
    inherited: group.filter(facts => facts.inheritedFrom).map(facts => `${facts.id} 沿用 ${facts.inheritedFrom} 样件`),
  };
  cert.usage = buildUsage(cert);
  return cert;
}

// 同名不同配方的提示：批次号才是唯一批签，同产品名不能互推。
function recipeNote(batches, batchIds) {
  const notes = [];
  for (const id of batchIds) {
    const batch = batches.find(row => row.id === id);
    if (!batch) continue;
    const others = batches.filter(row => row.product === batch.product && row.recipe !== batch.recipe);
    if (others.length) {
      notes.push(`「${batch.product}」另有配方 ${others.map(row => `${row.recipe}（${row.id}）`).join('、')}，同名不能互推`);
    }
  }
  return [...new Set(notes)];
}

// 把报告解析成事实，再按「同批次组 + 相同前处理」合并为证据组合。
// corrected=false 时得到更正前的证据（用于还原班组当时看到的承诺）。
export function buildCertifications(reports, batches, { corrected = true } = {}) {
  const batchById = new Map(batches.map(batch => [batch.id, batch]));
  const factsById = new Map(reports.map(report => [report.id, parseReport(report)]));
  linkInheritance(reports, factsById);
  if (corrected) applyRevisions(reports, factsById, batchById);

  const groups = new Map();
  for (const report of reports) {
    if (report.revises) continue; // 更正报告不单独成证，只修订目标报告
    const key = [...report.batchIds].sort().join('+');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(factsById.get(report.id));
  }

  const certs = [];
  const rejected = [];
  for (const factsList of groups.values()) {
    if (factsList.some(facts => !facts.comboTested)) {
      rejected.push({
        reports: factsList.map(facts => facts.id),
        batches: factsList[0].batchIds,
        reason: '只做单层放置、未做组合封口，不能作为组合替代依据',
        notes: recipeNote(batches, factsList[0].batchIds),
      });
      continue;
    }
    // 试样与前处理（操作先后）一致才可合并；不一致则各自成证，互不借用。
    const bySequence = new Map();
    for (const facts of factsList) {
      const key = facts.sequence ?? '未注明';
      if (!bySequence.has(key)) bySequence.set(key, []);
      bySequence.get(key).push(facts);
    }
    for (const group of bySequence.values()) {
      certs.push(makeCert(group, batchById));
    }
  }
  return { certs, rejected };
}
