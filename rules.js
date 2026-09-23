/*
 * 树脂封片准入台 —— 领域规则（纯函数，不接触 DOM / localStorage）
 * 列表、队列、履历全部从同一份 state.orders 派生，保证三者一致。
 */
(function (global) {
  "use strict";

  const HOUR_MS = 3600 * 1000;
  const BUBBLE_LIMIT_PERCENT = 5;          // 气泡面积占比上限 5%
  const INSPECTION_GAP_MS = 12 * HOUR_MS;  // 两次检查间隔 12 小时

  const ORDER_STATUS = {
    OPEN: "open",         // 封片单未结束
    ADMITTED: "admitted", // 两次检查合格，准入观察
    FAILED: "failed"      // 检查不合格，封片单结束
  };

  const SAMPLE_STATUS_LABEL = {
    none: "未封片",
    open: "封片中",
    admitted: "已准入",
    failed: "不合格"
  };

  const STAGE_LABEL = {
    curing: "待固化",
    first: "待初检",
    second: "待复检"
  };

  class RuleError extends Error {
    constructor(errors) {
      super(errors.join("；"));
      this.errors = errors;
    }
  }

  function uid() {
    return crypto.randomUUID();
  }

  function ordersOf(state, sampleId) {
    return state.orders.filter((order) => order.sampleId === sampleId);
  }

  function latestOrder(state, sampleId) {
    return ordersOf(state, sampleId).sort((a, b) => b.seq - a.seq)[0] || null;
  }

  function orderStatus(order) {
    if (!order) return null;
    if (order.inspections.some((item) => !item.pass)) return ORDER_STATUS.FAILED;
    if (order.inspections.length >= 2 && order.inspections.every((item) => item.pass)) {
      return ORDER_STATUS.ADMITTED;
    }
    return ORDER_STATUS.OPEN;
  }

  function isOpen(order) {
    return !!order && orderStatus(order) === ORDER_STATUS.OPEN;
  }

  // 旧封片单一旦被新单（变更重算）引用即失效，旧单本身字段永不改写
  function isSuperseded(order, state) {
    return state.orders.some((item) => item.revisionOf === order.id);
  }

  function sampleStatus(state, sampleId) {
    const latest = latestOrder(state, sampleId);
    if (!latest) return { code: "none", label: SAMPLE_STATUS_LABEL.none, order: null };
    const code = orderStatus(latest);
    return { code, label: SAMPLE_STATUS_LABEL[code], order: latest };
  }

  // 列表/对比统一取当前封片单快照照片，无单时取样本登记照片
  function effectivePhoto(state, sample) {
    const latest = latestOrder(state, sample.id);
    return (latest && latest.photo) || sample.photo || "";
  }

  function validateMount(input, now) {
    const errors = [];
    const data = {
      resinBatch: (input.resinBatch || "").trim(),
      resinExpiry: (input.resinExpiry || "").trim(),
      coverslipNo: (input.coverslipNo || "").trim(),
      cureTemp: input.cureTemp === "" || input.cureTemp == null ? NaN : Number(input.cureTemp),
      operator: (input.operator || "").trim()
    };

    if (!data.resinBatch) errors.push("缺少树脂批次");
    if (!data.resinExpiry) errors.push("缺少树脂批次有效期");
    if (!data.coverslipNo) errors.push("缺少盖玻片编号");
    if (!Number.isFinite(data.cureTemp) || data.cureTemp <= 0) errors.push("固化温度缺失或不合法");
    if (!data.operator) errors.push("缺少操作人");

    if (data.resinExpiry) {
      const expiryEnd = new Date(`${data.resinExpiry}T23:59:59`);
      if (Number.isNaN(expiryEnd.getTime())) {
        errors.push("树脂批次有效期格式不合法");
      } else if (expiryEnd.getTime() < now.getTime()) {
        errors.push(`树脂批次 ${data.resinBatch || ""} 已过期（有效期至 ${data.resinExpiry}）`);
      }
    }

    return { errors, data };
  }

  function buildOrder(state, sample, data, now, extra) {
    const previous = latestOrder(state, sample.id);
    return Object.assign({
      id: uid(),
      sampleId: sample.id,
      seq: previous ? previous.seq + 1 : 1,
      resinBatch: data.resinBatch,
      resinExpiry: data.resinExpiry,
      coverslipNo: data.coverslipNo,
      cureTemp: data.cureTemp,
      operator: data.operator,
      photo: sample.photo || "",
      createdAt: now.toISOString(),
      curedAt: null,
      inspections: [],
      revisionOf: null
    }, extra || {});
  }

  /*
   * 登记封片单：
   * - 每样本仅允许一张未结束封片单；重复登记直接沿用首次那张
   * - 缺项或树脂批次过期：整单拒绝，不写入任何记录
   * - 已准入样本不能再开普通单，须走变更登记
   */
  function registerMount(state, sampleId, input, now) {
    now = now || new Date();
    const sample = state.samples.find((item) => item.id === sampleId);
    if (!sample) throw new RuleError(["样本不存在"]);

    const latest = latestOrder(state, sampleId);
    if (latest && isOpen(latest)) {
      return { order: latest, reused: true };
    }
    if (latest && orderStatus(latest) === ORDER_STATUS.ADMITTED) {
      throw new RuleError(["该样本已准入；更换树脂、盖玻片或修订照片须使用变更登记"]);
    }

    const { errors, data } = validateMount(input, now);
    if (errors.length) throw new RuleError(errors);

    return { order: buildOrder(state, sample, data, now), reused: false };
  }

  /*
   * 变更登记：仅对已准入样本开放。
   * 更换树脂、盖玻片或修订照片 -> 旧准入立即失效，按新值重算（走完整流程），
   * 旧单通过 revisionOf 链标记为只读，不修改旧单任何字段。
   */
  function reviseMount(state, sampleId, input, photo, now) {
    now = now || new Date();
    const sample = state.samples.find((item) => item.id === sampleId);
    if (!sample) throw new RuleError(["样本不存在"]);

    const latest = latestOrder(state, sampleId);
    if (!latest || orderStatus(latest) !== ORDER_STATUS.ADMITTED) {
      throw new RuleError(["仅已准入样本可变更登记；变更会使旧准入失效并按新值重算"]);
    }

    const { errors, data } = validateMount(input, now);
    if (errors.length) throw new RuleError(errors);

    const nextPhoto = photo == null ? latest.photo : photo;
    const changed =
      data.resinBatch !== latest.resinBatch ||
      data.coverslipNo !== latest.coverslipNo ||
      nextPhoto !== latest.photo;
    if (!changed) {
      throw new RuleError(["树脂批次、盖玻片编号与照片均未变化，无需重算"]);
    }

    const order = buildOrder(state, sample, data, now, {
      photo: nextPhoto,
      revisionOf: latest.id
    });
    return { order };
  }

  function markCured(order, now) {
    now = now || new Date();
    if (!isOpen(order)) throw new RuleError(["封片单已结束，不能再标记固化"]);
    if (order.curedAt) throw new RuleError(["该封片单已完成固化"]);
    return Object.assign({}, order, { curedAt: now.toISOString() });
  }

  // 队列阶段（仅对未结束封片单有意义）
  function stage(order, now) {
    if (!isOpen(order)) return null;
    if (!order.curedAt) return { key: "curing", label: STAGE_LABEL.curing };
    if (order.inspections.length === 0) return { key: "first", label: STAGE_LABEL.first };
    const firstAt = new Date(order.inspections[0].at).getTime();
    const earliestNext = firstAt + INSPECTION_GAP_MS;
    return {
      key: "second",
      label: STAGE_LABEL.second,
      earliestNext: new Date(earliestNext),
      ready: now.getTime() >= earliestNext
    };
  }

  /*
   * 固化后由操作人之外的另一人检查两次，间隔至少 12 小时；
   * 每次均须：气泡 ≤ 5%、无溢胶、硬度达标。任一次不达标即封片单不合格结束。
   */
  function addInspection(order, input, now) {
    now = now || new Date();
    const errors = [];
    if (!isOpen(order)) errors.push("封片单已结束，不能再录入检查");
    if (isOpen(order) && !order.curedAt) errors.push("尚未标记固化完成，固化后才能检查");

    const inspector = (input.inspector || "").trim();
    if (!inspector) errors.push("缺少检查人");
    if (inspector && inspector === order.operator) {
      errors.push("检查人必须是操作人之外的另一人");
    }

    let at = input.at ? new Date(input.at) : new Date(now);
    if (Number.isNaN(at.getTime())) {
      errors.push("检查时间不合法");
      at = new Date(now);
    }
    if (order.curedAt && at.getTime() < new Date(order.curedAt).getTime()) {
      errors.push("检查时间不得早于固化完成时间");
    }
    if (order.inspections.length >= 2) errors.push("两次检查已完成");
    if (order.inspections.length === 1) {
      const firstAt = new Date(order.inspections[0].at).getTime();
      const gapHours = (at.getTime() - firstAt) / HOUR_MS;
      if (gapHours < 12) {
        errors.push(`两次检查须间隔至少 12 小时，当前仅 ${gapHours.toFixed(1)} 小时`);
      }
    }

    const bubblePercent = input.bubblePercent === "" || input.bubblePercent == null
      ? NaN
      : Number(input.bubblePercent);
    if (!Number.isFinite(bubblePercent) || bubblePercent < 0 || bubblePercent > 100) {
      errors.push("气泡占比缺失或不合法（0–100）");
    }
    const overflow = Boolean(input.overflow);
    const hardnessOk = Boolean(input.hardnessOk);

    if (errors.length) throw new RuleError(errors);

    const pass = bubblePercent <= BUBBLE_LIMIT_PERCENT && !overflow && hardnessOk;
    const inspection = {
      id: uid(),
      at: at.toISOString(),
      inspector,
      bubblePercent,
      overflow,
      hardnessOk,
      pass
    };
    const inspections = order.inspections.concat([inspection]);
    return {
      inspection,
      inspections,
      pass,
      status: orderStatus(Object.assign({}, order, { inspections }))
    };
  }

  function failReason(inspection) {
    const reasons = [];
    if (inspection.bubblePercent > BUBBLE_LIMIT_PERCENT) {
      reasons.push(`气泡 ${inspection.bubblePercent}% 超过 ${BUBBLE_LIMIT_PERCENT}%`);
    }
    if (inspection.overflow) reasons.push("存在溢胶");
    if (!inspection.hardnessOk) reasons.push("硬度不达标");
    return reasons.join("、") || "检查不合格";
  }

  // 队列：按阶段分组，全部由 state.orders 实时派生
  function queue(state, now) {
    now = now || new Date();
    const groups = [
      { key: "curing", label: STAGE_LABEL.curing, orders: [] },
      { key: "first", label: STAGE_LABEL.first, orders: [] },
      { key: "second", label: STAGE_LABEL.second, orders: [] }
    ];
    state.orders.forEach((order) => {
      const info = stage(order, now);
      if (!info) return;
      groups.find((group) => group.key === info.key).orders.push(order);
    });
    groups.forEach((group) => group.orders.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    return groups;
  }

  // 履历：全部封片单（含旧单），新到旧，只读呈现
  function history(state) {
    return state.orders
      .map((order) => ({
        order,
        sample: state.samples.find((item) => item.id === order.sampleId) || null,
        status: orderStatus(order),
        superseded: isSuperseded(order, state)
      }))
      .sort((a, b) => b.order.createdAt.localeCompare(a.order.createdAt));
  }

  global.MountRules = {
    BUBBLE_LIMIT_PERCENT,
    INSPECTION_GAP_MS,
    ORDER_STATUS,
    STAGE_LABEL,
    SAMPLE_STATUS_LABEL,
    RuleError,
    latestOrder,
    ordersOf,
    orderStatus,
    isOpen,
    isSuperseded,
    sampleStatus,
    effectivePhoto,
    registerMount,
    reviseMount,
    markCured,
    stage,
    addInspection,
    failReason,
    queue,
    history
  };
})(window);
