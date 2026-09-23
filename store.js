/*
 * 树脂封片准入台 —— 存储层
 * 负责 localStorage 持久化与状态流转；所有判定委托规则层。
 * 列表、队列、履历都从同一份 state 派生，保证三者一致。
 */
(function () {
  "use strict";

  var R = window.Rules;
  var S = R.STATUS;
  var storageKey = "wxyy-2-resin-mounting-admission";

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function seed() {
    var state = {
      samples: [],
      slips: [],
      batches: [],
      seq: 0
    };

    // 兼容旧版“薄片索引台”：保留样本，封片流程从零开始
    try {
      var legacy = JSON.parse(localStorage.getItem("wxyy-2-thin-section-index") || "null");
      if (legacy && Array.isArray(legacy.samples)) {
        state.samples = legacy.samples.map(function (sample) {
          return {
            id: sample.id,
            code: sample.code,
            location: sample.location || "",
            magnification: sample.magnification || "",
            polarization: sample.polarization || "单偏光",
            minerals: sample.minerals || "",
            texture: sample.texture || "",
            comment: sample.comment || "",
            photo: sample.photo || "",
            photoRevisedAt: null,
            createdAt: sample.createdAt || new Date().toISOString()
          };
        });
      }
    } catch (e) { /* 旧数据损坏则忽略 */ }

    // 内置树脂批次台账：一正常、一过期，便于演示“过期整单拒绝”
    state.batches = [
      { id: uuid(), code: "RX-2027-03", vendor: "海光树脂", curedNote: "标准环氧", expiry: "2027-03-31", createdAt: Date.now() },
      { id: uuid(), code: "RX-2025-11", vendor: "海光树脂", curedNote: "旧批环氧", expiry: "2025-11-30", createdAt: Date.now() }
    ];
    return state;
  }

  var state;
  try {
    state = JSON.parse(localStorage.getItem(storageKey) || "null") || seed();
  } catch (e) {
    state = seed();
  }
  if (!Array.isArray(state.samples) || !Array.isArray(state.slips) || !Array.isArray(state.batches)) {
    state = seed();
  }

  function save() {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }

  function findSample(sampleId) {
    return state.samples.find(function (s) { return s.id === sampleId; }) || null;
  }

  function findSampleByCode(code) {
    code = (code || "").trim();
    return state.samples.find(function (s) { return s.code === code; }) || null;
  }

  function findBatch(code) {
    code = (code || "").trim();
    return state.batches.find(function (b) { return b.code === code; }) || null;
  }

  function slipNo(slip) {
    return slip.sampleCode + "-F" + String(slip.rev).padStart(2, "0");
  }

  // ---------- 样本与照片 ----------

  function saveSample(input) {
    var code = (input.code || "").trim();
    if (!code) return { ok: false, errors: [{ message: "样本编号缺项" }] };

    var existing = findSampleByCode(code);
    if (existing) return { ok: false, errors: [{ message: "样本编号 " + code + " 已存在" }] };

    var sample = {
      id: uuid(),
      code: code,
      location: (input.location || "").trim(),
      magnification: (input.magnification || "").trim(),
      polarization: input.polarization || "单偏光",
      minerals: (input.minerals || "").trim(),
      texture: (input.texture || "").trim(),
      comment: (input.comment || "").trim(),
      photo: input.photo || "",
      photoRevisedAt: null,
      createdAt: new Date().toISOString()
    };
    state.samples.unshift(sample);
    save();
    return { ok: true, sample: sample };
  }

  /*
   * 修订照片：
   * - 已有未结束封片单：拒绝（未结束单重复沿用首次，不能改）；
   * - 上一张单已准入：旧单只读失效（superseded），以新照片另开新单；
   * - 其余（无单 / 拒绝终态）：仅更新照片，不产生新单。
   */
  function revisePhoto(sampleId, photo) {
    var sample = findSample(sampleId);
    if (!sample) return { ok: false, errors: [{ message: "样本不存在" }] };
    if (!photo) return { ok: false, errors: [{ message: "请选择新照片" }] };

    var open = R.findOpen(state.slips, sampleId);
    if (open) {
      return {
        ok: false,
        errors: [{ message: "样本存在未结束封片单 " + slipNo(open) + "，重复登记沿用首次信息，不能修订照片" }]
      };
    }

    var now = Date.now();
    var latest = R.latestSlip(state.slips, sampleId);
    sample.photo = photo;
    sample.photoRevisedAt = now;

    if (latest && latest.status === S.ADMITTED) {
      var fresh = supersede(latest, {
        reason: "photo",
        now: now,
        photo: photo,
        note: "样本照片已修订，准入按新照片重算"
      });
      save();
      return { ok: true, sample: sample, newSlip: fresh, superseded: latest };
    }

    save();
    return { ok: true, sample: sample };
  }

  function addBatch(input) {
    var code = (input.code || "").trim();
    var expiry = (input.expiry || "").trim();
    if (!code) return { ok: false, errors: [{ message: "树脂批次号缺项" }] };
    if (!expiry) return { ok: false, errors: [{ message: "有效期缺项" }] };
    if (findBatch(code)) return { ok: false, errors: [{ message: "批次 " + code + " 已在台账中" }] };
    if (isNaN(Date.parse(expiry + "T00:00:00"))) return { ok: false, errors: [{ message: "有效期格式无效" }] };

    var batch = {
      id: uuid(),
      code: code,
      vendor: (input.vendor || "").trim(),
      curedNote: (input.note || "").trim(),
      expiry: expiry,
      createdAt: Date.now()
    };
    state.batches.push(batch);
    save();
    return { ok: true, batch: batch };
  }

  // ---------- 封片单 ----------

  function nextRev(sampleId) {
    var chain = R.sampleSlips(state.slips, sampleId);
    return chain.length ? chain[chain.length - 1].rev + 1 : 1;
  }

  /*
   * 登记封片单：
   * 每样本仅一张未结束单 —— 若存在，重复登记沿用首次（原样返回，不新建）；
   * 缺项或树脂过期 —— 整单拒绝（不产生任何记录）。
   */
  function registerMounting(sampleId, input) {
    var sample = findSample(sampleId);
    if (!sample) return { ok: false, errors: [{ message: "样本不存在" }] };

    var open = R.findOpen(state.slips, sampleId);
    if (open) {
      return { ok: true, reused: true, slip: open, sample: sample };
    }

    var batch = findBatch(input.resinBatch);
    var validation = R.validateMounting(input, batch, Date.now());
    if (!validation.ok) return { ok: false, errors: validation.errors };

    var slip = {
      id: uuid(),
      no: "",
      sampleId: sampleId,
      sampleCode: sample.code,
      rev: nextRev(sampleId),
      reason: "mount",
      reasonNote: "首次登记",
      supersedes: null,
      resinBatch: input.resinBatch.trim(),
      coverslipNo: input.coverslipNo.trim(),
      cureTemp: Number(input.cureTemp),
      operator: input.operator.trim(),
      status: S.CURING,
      photoSnapshot: sample.photo || "",
      curedAt: null,
      inspections: [],
      admittedAt: null,
      deniedReason: null,
      createdAt: Date.now()
    };
    slip.no = slipNo(slip);
    state.slips.push(slip);
    save();
    return { ok: true, slip: slip, sample: sample };
  }

  // 固化完成 → 进入双检队列
  function completeCuring(slipId, atMs) {
    var slip = state.slips.find(function (x) { return x.id === slipId; });
    if (!slip) return { ok: false, errors: [{ message: "封片单不存在" }] };

    var gate = R.cureGate(slip, Number(atMs));
    if (!gate.ok) return { ok: false, errors: gate.errors };

    slip.curedAt = Number(atMs);
    slip.status = S.CHECKING;
    save();
    return { ok: true, slip: slip };
  }

  // 固化后由另一人隔十二小时检查两次
  function addInspection(slipId, input) {
    var slip = state.slips.find(function (x) { return x.id === slipId; });
    if (!slip) return { ok: false, errors: [{ message: "封片单不存在" }] };

    var gate = R.inspectionGate(slip, input);
    if (!gate.ok) return { ok: false, errors: gate.errors };

    var verdict = R.evaluateInspection(slip, input);
    slip.inspections.push({
      index: slip.inspections.length + 1,
      at: Number(input.at),
      inspector: input.inspector.trim(),
      bubblePct: Number(input.bubblePct),
      overflow: Boolean(input.overflow),
      hardnessOK: Boolean(input.hardnessOK),
      passed: verdict.passed,
      recordedAt: Date.now()
    });
    slip.status = verdict.status;
    if (verdict.status === S.ADMITTED) slip.admittedAt = Number(input.at);
    if (verdict.status === S.DENIED) slip.deniedReason = verdict.deniedReason;
    save();
    return { ok: true, slip: slip, verdict: verdict };
  }

  // 旧单只读封存并派生新单（更换树脂 / 盖玻片 / 修订照片共用）
  function supersede(prev, opts) {
    prev.status = S.SUPERSEDED;
    prev.deniedReason = opts.note || "准入因变更失效，按新值重算";

    var fresh = {
      id: uuid(),
      no: "",
      sampleId: prev.sampleId,
      sampleCode: prev.sampleCode,
      rev: prev.rev + 1,
      reason: opts.reason || "mount",
      reasonNote: opts.note || "准入失效后按新值重算",
      supersedes: prev.id,
      resinBatch: opts.mounting ? opts.mounting.resinBatch.trim() : prev.resinBatch,
      coverslipNo: opts.mounting ? opts.mounting.coverslipNo.trim() : prev.coverslipNo,
      cureTemp: opts.mounting ? Number(opts.mounting.cureTemp) : prev.cureTemp,
      operator: opts.mounting ? opts.mounting.operator.trim() : prev.operator,
      status: S.CURING,
      photoSnapshot: opts.photo != null ? opts.photo : prev.photoSnapshot,
      curedAt: null,
      inspections: [],
      admittedAt: null,
      deniedReason: null,
      createdAt: opts.now || Date.now()
    };
    fresh.no = slipNo(fresh);
    state.slips.push(fresh);
    return fresh;
  }

  /*
   * 更换树脂或盖玻片：旧准入单只读失效，按新值重新登记并全流程重算。
   * 固化温度、操作人随新登记重新填报；缺项 / 过期同样整单拒绝。
   */
  function reviseMounting(slipId, input) {
    var prev = state.slips.find(function (x) { return x.id === slipId; });
    if (!prev) return { ok: false, errors: [{ message: "封片单不存在" }] };

    var open = R.findOpen(state.slips, prev.sampleId);
    if (open) {
      return {
        ok: false,
        errors: [{ message: "样本存在未结束封片单 " + slipNo(open) + "，未结束前不能改树脂或盖玻片" }]
      };
    }
    if (prev.status !== S.ADMITTED) {
      return { ok: false, errors: [{ message: "只有已准入的封片单可在更换树脂或盖玻片后重算；请重新登记新单" }] };
    }

    var sample = findSample(prev.sampleId);
    var batch = findBatch(input.resinBatch);
    var validation = R.validateMounting(input, batch, Date.now());
    if (!validation.ok) return { ok: false, errors: validation.errors };

    if (!R.mountChanged(prev, { resinBatch: input.resinBatch.trim(), coverslipNo: input.coverslipNo.trim() })) {
      return { ok: false, errors: [{ message: "树脂批次与盖玻片编号均未变化，无需重算" }] };
    }

    var fresh = supersede(prev, {
      reason: "mount",
      now: Date.now(),
      mounting: input,
      photo: sample ? sample.photo : prev.photoSnapshot,
      note: "更换" + (input.resinBatch.trim() !== prev.resinBatch ? "树脂" : "") +
            (input.coverslipNo.trim() !== prev.coverslipNo ? "、盖玻片" : "") + "，准入按新值重算"
    });
    save();
    return { ok: true, slip: fresh, superseded: prev, sample: sample };
  }

  // ---------- 统一派生：列表 / 队列 / 履历 ----------

  function sampleStatus(sampleId) {
    var latest = R.latestSlip(state.slips, sampleId);
    return latest ? latest.status : null;
  }

  function selectList(filter) {
    filter = filter || {};
    return state.samples.filter(function (sample) {
      var mineral = (filter.mineral || "").trim();
      if (mineral && !(sample.minerals || "").includes(mineral)) return false;
      if (filter.polarization && sample.polarization !== filter.polarization) return false;
      if (filter.admission) {
        var status = sampleStatus(sample.id);
        if (filter.admission === "admitted" && status !== S.ADMITTED) return false;
        if (filter.admission === "unadmitted" && status === S.ADMITTED) return false;
      }
      return true;
    }).map(function (sample) {
      return { sample: sample, status: sampleStatus(sample.id), slips: R.sampleSlips(state.slips, sample.id) };
    });
  }

  // 队列：全部未结束封片单（固化中等固化登记、检查中等两次十二小时检查）
  function selectQueue() {
    return state.slips.filter(R.isOpen).sort(function (a, b) { return a.createdAt - b.createdAt; });
  }

  // 履历：全部封片单（含只读的失效 / 拒绝单），按样本与版本排列
  function selectHistory() {
    return state.slips.slice().sort(function (a, b) {
      if (a.sampleCode !== b.sampleCode) return a.sampleCode < b.sampleCode ? -1 : 1;
      return a.rev - b.rev;
    });
  }

  function slipTimeline(slip) {
    var events = [{ at: slip.createdAt, label: "登记封片单", detail: slip.operator + " 操作" }];
    if (slip.curedAt) events.push({ at: slip.curedAt, label: "固化完成", detail: slip.cureTemp + "℃" });
    slip.inspections.forEach(function (ins) {
      events.push({
        at: ins.at,
        label: "第 " + ins.index + " 次检查",
        detail: ins.inspector + " · 气泡 " + ins.bubblePct + "% · " +
          (ins.overflow ? "有溢胶" : "无溢胶") + " · " +
          (ins.hardnessOK ? "硬度达标" : "硬度不达标") + (ins.passed ? "（通过）" : "（不通过）")
      });
    });
    if (slip.status === S.ADMITTED && slip.admittedAt) {
      events.push({ at: slip.admittedAt, label: "准入观察", detail: "两次检查均合格" });
    }
    if (slip.status === S.DENIED) events.push({ at: slip.inspections.length ? slip.inspections[slip.inspections.length - 1].at : slip.createdAt, label: "拒绝准入", detail: slip.deniedReason || "" });
    if (slip.status === S.SUPERSEDED) events.push({ at: slip.createdAt, label: "准入失效（只读）", detail: slip.deniedReason || slip.reasonNote || "" });
    return events.sort(function (a, b) { return a.at - b.at; });
  }

  window.Store = {
    state: state,
    save: save,
    findSample: findSample,
    findBatch: findBatch,
    slipNo: slipNo,
    saveSample: saveSample,
    revisePhoto: revisePhoto,
    addBatch: addBatch,
    registerMounting: registerMounting,
    completeCuring: completeCuring,
    addInspection: addInspection,
    reviseMounting: reviseMounting,
    selectList: selectList,
    selectQueue: selectQueue,
    selectHistory: selectHistory,
    slipTimeline: slipTimeline
  };
})();
