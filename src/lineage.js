/** 原料批次、预处理、分样与合样的谱系关系；分样与合样保持数量守恒。 */

const EPSILON = 1e-9;

/** 从事件流折叠出样品节点投影：种类、数量、余量与父级关系。 */
export function lineageProjection(store) {
  const nodes = new Map();
  for (const event of store.all()) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "LOT_REGISTERED":
        nodes.set(event.aggregate_id, {
          sample_id: event.aggregate_id, kind: "lot", material: p.material,
          unit: p.unit, quantity: p.quantity, remaining: p.quantity, parents: [], process_params: null,
        });
        break;
      case "PRETREATMENT_APPLIED": {
        const source = nodes.get(p.source_id);
        nodes.set(event.aggregate_id, {
          sample_id: event.aggregate_id, kind: "pretreated", material: source?.material ?? null,
          unit: p.unit, quantity: p.output_quantity, remaining: p.output_quantity,
          parents: [{ sample_id: p.source_id, quantity: p.drawn_quantity }], process_params: p.process_params ?? null,
        });
        if (source) source.remaining -= p.drawn_quantity;
        break;
      }
      case "SAMPLE_SPLIT": {
        const parent = nodes.get(event.aggregate_id);
        for (const child of p.children) {
          nodes.set(child.sample_id, {
            sample_id: child.sample_id, kind: "aliquot", material: parent?.material ?? null,
            unit: parent?.unit ?? null, quantity: child.quantity, remaining: child.quantity,
            parents: [{ sample_id: event.aggregate_id, quantity: child.quantity }], process_params: null,
          });
        }
        if (parent) parent.remaining -= p.children.reduce((sum, child) => sum + child.quantity, 0);
        break;
      }
      case "SAMPLE_MERGED": {
        const parents = [];
        let total = 0;
        for (const source of p.sources) {
          const node = nodes.get(source.sample_id);
          if (node) node.remaining -= source.quantity;
          parents.push({ sample_id: source.sample_id, quantity: source.quantity });
          total += source.quantity;
        }
        nodes.set(event.aggregate_id, {
          sample_id: event.aggregate_id, kind: "composite", material: null,
          unit: p.unit, quantity: total, remaining: total, parents, process_params: null,
        });
        break;
      }
      default:
        break;
    }
  }
  return nodes;
}

export function registerLot(store, { lot_id, material, quantity, unit, actor, now }) {
  if (lineageProjection(store).has(lot_id)) throw new Error(`原料批次已存在：${lot_id}`);
  if (!(quantity > 0)) throw new Error("批次数量必须为正数");
  return store.emit({
    event_type: "LOT_REGISTERED", aggregate_type: "ingredient_lot", aggregate_id: lot_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `登记原料批次 ${lot_id}（${material}，${quantity}${unit}）`,
    actor, payload: { material, quantity, unit },
  });
}

export function applyPretreatment(store, { source_id, target_id, drawn_quantity, output_quantity, unit, process_params, actor, now }) {
  const nodes = lineageProjection(store);
  const source = nodes.get(source_id);
  if (!source) throw new Error(`来源样品不存在：${source_id}`);
  if (nodes.has(target_id)) throw new Error(`样品标识已存在：${target_id}`);
  if (!(drawn_quantity > 0)) throw new Error("投料数量必须为正数");
  if (drawn_quantity - source.remaining > EPSILON) throw new Error(`投料量超出 ${source_id} 余量 ${source.remaining}，违反数量守恒`);
  if (!(output_quantity > 0) || output_quantity - drawn_quantity > EPSILON) throw new Error("预处理产出必须为正且不高于投料量");
  return store.emit({
    event_type: "PRETREATMENT_APPLIED", aggregate_type: "sample", aggregate_id: target_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `预处理 ${source_id} → ${target_id}（投料 ${drawn_quantity}，产出 ${output_quantity}）`,
    actor,
    payload: {
      source_id, drawn_quantity, output_quantity,
      unit: unit ?? source.unit, process_params: process_params ?? null,
      loss_quantity: drawn_quantity - output_quantity,
    },
  });
}

export function splitSample(store, { source_id, children, actor, now }) {
  const nodes = lineageProjection(store);
  const parent = nodes.get(source_id);
  if (!parent) throw new Error(`母样不存在：${source_id}`);
  if (!Array.isArray(children) || children.length === 0) throw new Error("分样至少产生一个子样");
  let drawn = 0;
  for (const child of children) {
    if (nodes.has(child.sample_id)) throw new Error(`样品标识已存在：${child.sample_id}`);
    if (!(child.quantity > 0)) throw new Error(`子样 ${child.sample_id} 数量必须为正数`);
    drawn += child.quantity;
  }
  if (drawn - parent.remaining > EPSILON) throw new Error(`分样总量 ${drawn} 超出母样余量 ${parent.remaining}，违反数量守恒`);
  return store.emit({
    event_type: "SAMPLE_SPLIT", aggregate_type: "sample", aggregate_id: source_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `分样 ${source_id} → ${children.map((child) => child.sample_id).join("、")}（共 ${drawn}${parent.unit}）`,
    actor, payload: { children, drawn_total: drawn },
  });
}

export function mergeSamples(store, { source_amounts, target_id, actor, now }) {
  const nodes = lineageProjection(store);
  if (nodes.has(target_id)) throw new Error(`样品标识已存在：${target_id}`);
  if (!Array.isArray(source_amounts) || source_amounts.length === 0) throw new Error("合样至少需要一个来源");
  let unit = null;
  for (const source of source_amounts) {
    const node = nodes.get(source.sample_id);
    if (!node) throw new Error(`来源样品不存在：${source.sample_id}`);
    if (!(source.quantity > 0)) throw new Error("合样取用数量必须为正数");
    if (source.quantity - node.remaining > EPSILON) throw new Error(`合样取用量超出 ${source.sample_id} 余量 ${node.remaining}，违反数量守恒`);
    if (unit === null) unit = node.unit;
    else if (node.unit !== unit) throw new Error("合样来源单位不一致");
  }
  const total = source_amounts.reduce((sum, source) => sum + source.quantity, 0);
  return store.emit({
    event_type: "SAMPLE_MERGED", aggregate_type: "sample", aggregate_id: target_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `合样 ${source_amounts.map((source) => source.sample_id).join("、")} → ${target_id}（共 ${total}${unit}）`,
    actor, payload: { sources: source_amounts, unit, total_quantity: total },
  });
}
