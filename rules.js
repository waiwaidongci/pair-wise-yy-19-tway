/*
 * 树脂封片准入台 —— 规则层
 * 只放纯领域规则：不碰 DOM，不碰 localStorage，输入 → 判定结果。
 */
(function () {
  "use strict";

  var HOUR_MS = 60 * 60 * 1000;

  var STATUS = {
    CURING: "curing",         // 已登记，固化中（未结束）
    CHECKING: "checking",     // 固化完成，十二小时双检进行中（未结束）
    ADMITTED: "admitted",     // 双检合格，准入观察（终态）
    DENIED: "denied",         // 检查不合格 / 登记被拒后的拒绝终态
    SUPERSEDED: "superseded"  // 曾准入，因树脂/盖玻片/照片变更而失效（只读终态）
  };

  var RULES = {
    maxBubblePct: 5,            // 气泡面积占比上限：5%
    inspectionGapHours: 12,     // 固化后首次检查、两次检查之间均须间隔 12 小时
    inspectionGapMs: 12 * HOUR_MS,
    minCureTemp: 10,            // 固化温度允许区间 ℃
    maxCureTemp: 95,
    STATUS: STATUS
  };

  function isOpen(slip) {
    return slip.status === STATUS.CURING || slip.status === STATUS.CHECKING;
  }

  function sampleSlips(slips, sampleId) {
    return slips
      .filter(function (slip) { return slip.sampleId === sampleId; })
      .sort(function (a, b) { return a.rev - b.rev; });
  }

  // 每样本仅一张未结束封片单：取该样本唯一的未结束单
  function findOpen(slips, sampleId) {
    for (var i = 0; i < slips.length; i += 1) {
      if (slips[i].sampleId === sampleId && isOpen(slips[i])) return slips[i];
    }
    return null;
  }

  function latestSlip(slips, sampleId) {
    var chain = sampleSlips(slips, sampleId);
    return chain.length ? chain[chain.length - 1] : null;
  }

  function formatMs(ms) {
    if (!isFinite(ms)) return "—";
    return new Date(ms).toLocaleString("zh-CN", { hour12: false });
  }

  function err(messages) {
    return messages.map(function (message) { return { message: message }; });
  }

  /*
   * 登记校验：树脂批次、盖玻片编号、固化温度、操作人
   * 任一缺项或树脂批次已过期 → 整单拒绝（不产生任何记录）。
   */
  function validateMounting(input, batch, at) {
    at = at || Date.now();
    var errors = [];
    var trim = function (x) { return (x == null ? "" : String(x)).trim(); };

    var resin = trim(input.resinBatch);
    var cover = trim(input.coverslipNo);
    var operator = trim(input.operator);
    var hasTemp = input.cureTemp !== "" && input.cureTemp != null;
    var temp = hasTemp ? Number(input.cureTemp) : NaN;

    if (!resin) {
      errors.push({ field: "resinBatch", message: "树脂批次缺项" });
    } else if (!batch) {
      errors.push({ field: "resinBatch", message: "树脂批次 " + resin + " 不在台账中" });
    } else if (Date.parse(batch.expiry + "T23:59:59.999") < at) {
      errors.push({ field: "resinBatch", message: "树脂批次 " + batch.code + " 已过有效期（" + batch.expiry + "）" });
    }

    if (!cover) errors.push({ field: "coverslipNo", message: "盖玻片编号缺项" });
    if (!operator) errors.push({ field: "operator", message: "操作人缺项" });

    if (!hasTemp) {
      errors.push({ field: "cureTemp", message: "固化温度缺项" });
    } else if (!isFinite(temp)) {
      errors.push({ field: "cureTemp", message: "固化温度必须是数字" });
    } else if (temp < RULES.minCureTemp || temp > RULES.maxCureTemp) {
      errors.push({ field: "cureTemp", message: "固化温度超出允许范围 " + RULES.minCureTemp + "–" + RULES.maxCureTemp + "℃" });
    }

    return { ok: errors.length === 0, errors: errors };
  }

  // 固化完成登记的门槛
  function cureGate(slip, at, now) {
    now = now || Date.now();
    var errors = [];
    if (slip.status !== STATUS.CURING) errors.push("封片单不在固化中状态");
    if (!isFinite(at)) errors.push("固化完成时间缺项或格式无效");
    if (isFinite(at) && at < slip.createdAt) errors.push("固化完成时间不能早于登记时间");
    if (isFinite(at) && at > now + 60000) errors.push("固化完成时间不能晚于当前时间");
    return { ok: errors.length === 0, errors: err(errors) };
  }

  // 下一次检查的序号与最早可检时间（锚点 + 12h）
  function nextInspection(slip) {
    var done = slip.inspections.length;
    var anchor = done === 0 ? slip.curedAt : slip.inspections[done - 1].at;
    return { index: done + 1, anchor: anchor, earliest: anchor + RULES.inspectionGapMs };
  }

  /*
   * 检查登记门槛：
   * - 由操作人之外的另一人执行；
   * - 距固化完成 / 上一次检查至少 12 小时；
   * - 气泡占比、溢胶、硬度三项判定缺一不可。
   * 门槛不过 → 拒绝登记；指标不合格是合法检查结果，走 evaluateInspection。
   */
  function inspectionGate(slip, input, now) {
    now = now || Date.now();
    var errors = [];

    if (slip.status !== STATUS.CHECKING) errors.push("封片单不在待检查状态");
    if (slip.inspections.length >= 2) errors.push("两次检查均已完成，不能再登记");

    var inspector = (input.inspector == null ? "" : String(input.inspector)).trim();
    if (!inspector) {
      errors.push("检查人缺项");
    } else if (inspector === slip.operator) {
      errors.push("检查必须由操作人（" + slip.operator + "）之外的另一人执行");
    }

    var at = Number(input.at);
    var ni = nextInspection(slip);
    if (!isFinite(at)) {
      errors.push("检查时间缺项或格式无效");
    } else {
      if (at > now + 60000) errors.push("检查时间不能晚于当前时间");
      if (slip.status === STATUS.CHECKING && at < ni.earliest) {
        errors.push("距上一节点不足 12 小时，第 " + ni.index + " 次检查最早可在 " + formatMs(ni.earliest) + " 进行");
      }
    }

    var hasBubble = input.bubblePct !== "" && input.bubblePct != null;
    var bubble = hasBubble ? Number(input.bubblePct) : NaN;
    if (!hasBubble) errors.push("气泡占比缺项");
    else if (!isFinite(bubble) || bubble < 0 || bubble > 100) errors.push("气泡占比必须是 0–100 之间的数字");
    if (typeof input.overflow !== "boolean") errors.push("溢胶判定缺项");
    if (typeof input.hardnessOK !== "boolean") errors.push("硬度判定缺项");

    return { ok: errors.length === 0, errors: err(errors), next: ni };
  }

  /*
   * 指标判定：气泡 ≤5%、无溢胶、硬度达标，三者同时满足才算该次通过。
   * 两次通过 → 准入；任一次不通过 → 整单拒绝准入。
   */
  function evaluateInspection(slip, input) {
    var reasons = [];
    if (Number(input.bubblePct) > RULES.maxBubblePct) {
      reasons.push("气泡占比 " + input.bubblePct + "% 超过上限 " + RULES.maxBubblePct + "%");
    }
    if (input.overflow) reasons.push("存在溢胶");
    if (!input.hardnessOK) reasons.push("硬度未达标");

    var passed = reasons.length === 0;
    var total = slip.inspections.length + 1;
    var status = !passed
      ? STATUS.DENIED
      : (total >= 2 ? STATUS.ADMITTED : STATUS.CHECKING);

    return {
      passed: passed,
      total: total,
      status: status,
      deniedReason: passed ? null : "第 " + total + " 次检查未通过：" + reasons.join("、")
    };
  }

  // 准入失效触发条件：更换树脂或更换盖玻片
  function mountChanged(prev, next) {
    return next.resinBatch !== prev.resinBatch || next.coverslipNo !== prev.coverslipNo;
  }

  window.Rules = {
    RULES: RULES,
    STATUS: STATUS,
    isOpen: isOpen,
    sampleSlips: sampleSlips,
    findOpen: findOpen,
    latestSlip: latestSlip,
    formatMs: formatMs,
    validateMounting: validateMounting,
    cureGate: cureGate,
    nextInspection: nextInspection,
    inspectionGate: inspectionGate,
    evaluateInspection: evaluateInspection,
    mountChanged: mountChanged
  };
})();
