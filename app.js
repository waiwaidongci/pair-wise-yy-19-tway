/*
 * 树脂封片准入台 —— 交互层
 * DOM 渲染与事件；规则找 rules.js，数据找 store.js。
 */
(function () {
  "use strict";

  var R = window.Rules;
  var S = R.STATUS;
  var Store = window.Store;

  var form = document.querySelector("#sampleForm");
  var photoInput = document.querySelector("#photoInput");
  var sampleGrid = document.querySelector("#sampleGrid");
  var mineralFilter = document.querySelector("#mineralFilter");
  var polarFilter = document.querySelector("#polarFilter");
  var admissionFilter = document.querySelector("#admissionFilter");
  var queueCuring = document.querySelector("#queueCuring");
  var queueChecking = document.querySelector("#queueChecking");
  var historyList = document.querySelector("#historyList");
  var actionPane = document.querySelector("#actionPane");
  var batchList = document.querySelector("#batchList");
  var batchForm = document.querySelector("#batchForm");
  var banner = document.querySelector("#banner");
  var queueCount = document.querySelector("#queueCount");

  var STATUS_LABEL = {
    curing: "固化中",
    checking: "待检查",
    admitted: "已准入",
    denied: "已拒绝",
    superseded: "已失效"
  };

  var pendingPhoto = "";
  var bannerTimer = null;

  // ---------- 工具 ----------

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function localInputValue(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function findSlip(id) {
    return Store.state.slips.find(function (slip) { return slip.id === id; }) || null;
  }

  function showBanner(type, text) {
    banner.hidden = false;
    banner.className = "banner banner-" + type;
    banner.textContent = text;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { banner.hidden = true; }, 9000);
  }

  function errorText(result) {
    return (result.errors || []).map(function (e) { return e.message; }).join("；");
  }

  function batchOptions(selected) {
    var today = new Date().toISOString().slice(0, 10);
    return Store.state.batches.map(function (batch) {
      var expired = batch.expiry < today;
      return '<option value="' + esc(batch.code) + '"' +
        (batch.code === selected ? " selected" : "") +
        (expired ? " disabled" : "") + ">" +
        esc(batch.code) + "（有效期 " + esc(batch.expiry) + (expired ? "，已过期" : "") + "）</option>";
    }).join("");
  }

  // ---------- 渲染 ----------

  function renderBatches() {
    var today = new Date().toISOString().slice(0, 10);
    batchList.innerHTML = Store.state.batches.length
      ? Store.state.batches.map(function (batch) {
          var expired = batch.expiry < today;
          return '<div class="batch-item' + (expired ? " is-expired" : "") + '">' +
            "<strong>" + esc(batch.code) + "</strong>" +
            (expired ? '<span class="badge badge-denied">已过期</span>' : '<span class="badge badge-admitted">可用</span>') +
            "<small>" + esc(batch.vendor || "未记录厂商") + " · 有效期至 " + esc(batch.expiry) + "</small></div>";
        }).join("")
      : "<p class=\"muted-note\">暂无树脂批次。</p>";
  }

  function renderList() {
    var rows = Store.selectList({
      mineral: mineralFilter.value,
      polarization: polarFilter.value,
      admission: admissionFilter.value
    });

    sampleGrid.innerHTML = rows.length ? rows.map(function (row) {
      var sample = row.sample;
      var latest = row.slips.length ? row.slips[row.slips.length - 1] : null;
      var badge = row.status
        ? '<span class="badge badge-' + esc(row.status) + '">' + STATUS_LABEL[row.status] + "</span>"
        : '<span class="badge badge-none">未封片</span>';

      var actions = ['<label class="mini-btn">修订照片<input type="file" accept="image/*" hidden data-photo="' + sample.id + '"></label>'];
      if (R.isOpen(latest)) {
        actions.push('<span class="muted-note">未结束单 ' + esc(Store.slipNo(latest)) + " · 重复登记沿用首次</span>");
      } else if (latest && latest.status === S.ADMITTED) {
        actions.push('<button type="button" class="mini-btn" data-action="revise-mount" data-slip="' + latest.id + '">换树脂/盖玻片重算</button>');
      } else {
        actions.push('<button type="button" class="mini-btn" data-action="mount" data-sample="' + sample.id + '">' +
          (latest && latest.status === S.DENIED ? "重新登记封片" : "登记封片") + "</button>");
      }

      return '<article class="sample-card">' +
        (sample.photo ? '<img src="' + sample.photo + '" alt="' + esc(sample.code) + '显微照片">' : '<div class="photo-placeholder"></div>') +
        '<div class="sample-body"><div class="card-head"><h3>' + esc(sample.code) + "</h3>" + badge + "</div>" +
        "<p>" + esc(sample.location || "未记录地点") + " · " + esc(sample.magnification || "未记录倍数") + " · " + esc(sample.polarization) + "</p>" +
        "<p>矿物：" + esc(sample.minerals || "未记录") + "</p>" +
        "<p>结构：" + esc(sample.texture || "未记录") + "</p>" +
        "<p>" + esc(sample.comment || "未填写批注") + "</p>" +
        (latest ? '<p class="slip-ref">封片单：' + esc(Store.slipNo(latest)) + "</p>" : "") +
        '<div class="card-actions">' + actions.join("") + "</div></div></article>";
    }).join("") : "<p>还没有样本，先从左侧录入一张薄片照片。</p>";
  }

  function slipCard(slip, action) {
    var ni = R.nextInspection(slip);
    var inspectRows = slip.inspections.map(function (ins) {
      return "<li>第 " + ins.index + " 次 · " + esc(ins.inspector) + " · " +
        R.formatMs(ins.at) + "<br>气泡 " + ins.bubblePct + "% · " +
        (ins.overflow ? "有溢胶" : "无溢胶") + " · " +
        (ins.hardnessOK ? "硬度达标" : "硬度不达标") + "</li>";
    }).join("");

    return '<article class="queue-card">' +
      '<div class="card-head"><h3>' + esc(slip.no) + "</h3><span class=\"badge badge-" + slip.status + '">' + STATUS_LABEL[slip.status] + "</span></div>" +
      "<p>样本 " + esc(slip.sampleCode) + " · 树脂 " + esc(slip.resinBatch) + " · 盖玻片 " + esc(slip.coverslipNo) + "</p>" +
      "<p>固化温度 " + slip.cureTemp + "℃ · 操作人 " + esc(slip.operator) + "</p>" +
      "<p>登记于 " + R.formatMs(slip.createdAt) + "</p>" +
      (slip.status === S.CHECKING
        ? "<p>固化完成 " + R.formatMs(slip.curedAt) + "<br>第 " + ni.index + " 次检查最早 " + R.formatMs(ni.earliest) +
          "（须为操作人之外的另一人）</p>"
        : "") +
      (inspectRows ? '<ul class="inspect-list">' + inspectRows + "</ul>" : "") +
      '<div class="card-actions"><button type="button" class="mini-btn" data-action="' + action +
      '" data-slip="' + slip.id + '">' +
      (slip.status === S.CURING ? "登记固化完成" : "登记第 " + ni.index + " 次检查") +
      "</button></div></article>";
  }

  function renderQueue() {
    var queue = Store.selectQueue();
    queueCount.textContent = queue.length;
    var curing = queue.filter(function (slip) { return slip.status === S.CURING; });
    var checking = queue.filter(function (slip) { return slip.status === S.CHECKING; });
    queueCuring.innerHTML = curing.length ? curing.map(function (slip) { return slipCard(slip, "cure"); }).join("")
      : '<p class="muted-note">无固化中的封片单。</p>';
    queueChecking.innerHTML = checking.length ? checking.map(function (slip) { return slipCard(slip, "inspect"); }).join("")
      : '<p class="muted-note">无待检查封片单。</p>';
  }

  function renderHistory() {
    var slips = Store.selectHistory();
    historyList.innerHTML = slips.length ? slips.map(function (slip) {
      var readonly = slip.status === S.DENIED || slip.status === S.SUPERSEDED;
      var timeline = Store.slipTimeline(slip).map(function (ev) {
        return "<li><time>" + R.formatMs(ev.at) + "</time><strong>" + esc(ev.label) + "</strong>" +
          (ev.detail ? "<span>" + esc(ev.detail) + "</span>" : "") + "</li>";
      }).join("");

      return '<article class="history-card' + (readonly ? " is-readonly" : "") + '">' +
        '<div class="card-head"><h3>' + esc(slip.no) + " · 样本 " + esc(slip.sampleCode) + "</h3>" +
        '<span class="badge badge-' + slip.status + '">' + STATUS_LABEL[slip.status] + (readonly ? " · 只读" : "") + "</span></div>" +
        "<p>树脂 " + esc(slip.resinBatch) + " · 盖玻片 " + esc(slip.coverslipNo) + " · 固化 " + slip.cureTemp +
        "℃ · 操作人 " + esc(slip.operator) + "</p>" +
        (slip.rev > 1 ? '<p class="slip-ref">第 ' + slip.rev + ' 版 · ' + esc(slip.reasonNote) + "</p>" : "") +
        '<ul class="timeline">' + timeline + "</ul>" +
        (slip.status === S.ADMITTED
          ? '<button type="button" class="mini-btn" data-action="revise-mount" data-slip="' + slip.id + '">更换树脂/盖玻片重算</button>'
          : "") +
        "</article>";
    }).join("") : '<p class="muted-note">还没有封片单。</p>';
  }

  function renderDefaultPane() {
    actionPane.innerHTML = '<div class="pane-rules"><p class="muted-note">在列表或队列中点选作业，规则如下：</p>' +
      "<ul><li>每样本仅一张<strong>未结束</strong>封片单；重复登记沿用首次信息。</li>" +
      "<li>登记须填齐树脂批次、盖玻片编号、固化温度、操作人；缺项或树脂批次过期，<strong>整单拒绝</strong>。</li>" +
      "<li>固化完成后，由操作人之外的<strong>另一人</strong>隔 12 小时检查两次；气泡不超过 5%、无溢胶且硬度达标，方准入观察。</li>" +
      "<li>更换树脂、盖玻片或修订照片，准入立即失效，旧记录只读，按新值重新全流程计算。</li></ul></div>";
  }

  function renderAll() {
    renderBatches();
    renderList();
    renderQueue();
    renderHistory();
  }

  // ---------- 作业台面板 ----------

  function openMountPanel(sampleId, slip) {
    var sample = Store.findSample(sampleId);
    if (!sample) return;
    var values = slip || { resinBatch: "", coverslipNo: "", cureTemp: "", operator: "" };
    actionPane.innerHTML = '<form class="action-form" data-panel="mount" data-sample="' + sampleId + '">' +
      "<h3>登记封片单 · " + esc(sample.code) + "</h3>" +
      "<p class=\"muted-note\">缺项或树脂过期将整单拒绝；该样本已有未结束单时沿用首次。</p>" +
      '<label>树脂批次<select name="resinBatch" required><option value="">选择批次…</option>' + batchOptions(values.resinBatch) + "</select></label>" +
      '<label>盖玻片编号<input name="coverslipNo" required placeholder="CG-2041" value="' + esc(values.coverslipNo) + '"></label>' +
      '<label>固化温度（℃，10–95）<input name="cureTemp" type="number" min="10" max="95" step="0.1" required value="' + esc(values.cureTemp) + '"></label>' +
      '<label>操作人<input name="operator" required placeholder="封片操作人姓名" value="' + esc(values.operator) + '"></label>' +
      '<button type="submit">提交登记</button></form>';
  }

  function openCurePanel(slip) {
    actionPane.innerHTML = '<form class="action-form" data-panel="cure" data-slip="' + slip.id + '">' +
      "<h3>登记固化完成 · " + esc(slip.no) + "</h3>" +
      '<label>固化完成时间<input name="at" type="datetime-local" required value="' + localInputValue(Date.now()) + '"></label>' +
      "<p class=\"muted-note\">从此刻起 12 小时后，方可由操作人之外的另一人进行首次检查。</p>" +
      '<button type="submit">进入双检队列</button></form>';
  }

  function openInspectPanel(slip) {
    var ni = R.nextInspection(slip);
    actionPane.innerHTML = '<form class="action-form" data-panel="inspect" data-slip="' + slip.id + '">' +
      "<h3>第 " + ni.index + " 次检查 · " + esc(slip.no) + "</h3>" +
      "<p class=\"muted-note\">操作人：" + esc(slip.operator) + "；本次检查须由另一人执行。<br>" +
      "最早可检时间：" + R.formatMs(ni.earliest) + "（间隔满 12 小时）</p>" +
      '<label>检查时间<input name="at" type="datetime-local" required value="' + localInputValue(Date.now()) + '"></label>' +
      '<label>检查人<input name="inspector" required placeholder="不得与操作人为同一人"></label>' +
      '<label>气泡面积占比（%，≤ 5 合格）<input name="bubblePct" type="number" min="0" max="100" step="0.1" required></label>' +
      '<label class="check-row"><input type="checkbox" name="overflow">有溢胶（勾选即不合格）</label>' +
      '<label class="check-row"><input type="checkbox" name="hardnessOK" checked>硬度达标</label>' +
      '<button type="submit">提交第 ' + ni.index + " 次检查</button></form>";
  }

  function openReviseMountPanel(slip) {
    actionPane.innerHTML = '<form class="action-form" data-panel="revise-mount" data-slip="' + slip.id + '">' +
      "<h3>更换树脂 / 盖玻片重算 · " + esc(slip.no) + "</h3>" +
      "<p class=\"muted-note\">当前准入单将转为只读失效，按新值另开新单，重新固化与双检。</p>" +
      '<label>树脂批次<select name="resinBatch" required><option value="">选择批次…</option>' + batchOptions(slip.resinBatch) + "</select></label>" +
      '<label>盖玻片编号<input name="coverslipNo" required value="' + esc(slip.coverslipNo) + '"></label>' +
      '<label>固化温度（℃，10–95）<input name="cureTemp" type="number" min="10" max="95" step="0.1" required value="' + esc(slip.cureTemp) + '"></label>' +
      '<label>操作人<input name="operator" required value="' + esc(slip.operator) + '"></label>' +
      '<button type="submit">旧单只读，按新值重算</button></form>';
  }

  function openStageForOpenSlip(slip) {
    if (slip.status === S.CURING) openCurePanel(slip);
    else openInspectPanel(slip);
  }

  // ---------- 表单提交 ----------

  function readFile(file) {
    return new Promise(function (resolve) {
      if (!file) return resolve("");
      var reader = new FileReader();
      reader.addEventListener("load", function () { resolve(reader.result); });
      reader.readAsDataURL(file);
    });
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    var data = new FormData(form);
    if (!pendingPhoto && photoInput.files[0]) pendingPhoto = await readFile(photoInput.files[0]);

    var result = Store.saveSample({
      photo: pendingPhoto,
      code: data.get("code"),
      location: data.get("location"),
      magnification: data.get("magnification"),
      polarization: data.get("polarization"),
      minerals: data.get("minerals"),
      texture: data.get("texture"),
      comment: data.get("comment")
    });

    if (!result.ok) {
      showBanner("error", "样本登记被拒：" + errorText(result));
      return;
    }
    pendingPhoto = "";
    photoInput.value = "";
    form.reset();
    renderAll();
    showBanner("ok", "样本 " + result.sample.code + " 已保存，可在列表中登记封片单。");
  });

  photoInput.addEventListener("change", async function () {
    pendingPhoto = await readFile(photoInput.files[0]);
  });

  batchForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var data = new FormData(batchForm);
    var result = Store.addBatch({
      code: data.get("code"),
      expiry: data.get("expiry"),
      vendor: data.get("vendor"),
      note: ""
    });
    if (!result.ok) {
      showBanner("error", "批次登记被拒：" + errorText(result));
      return;
    }
    batchForm.reset();
    renderAll();
    showBanner("ok", "树脂批次 " + result.batch.code + " 已入台账。");
  });

  actionPane.addEventListener("submit", function (event) {
    event.preventDefault();
    var panelForm = event.target;
    var kind = panelForm.dataset.panel;
    var data = new FormData(panelForm);

    if (kind === "mount") {
      var result = Store.registerMounting(panelForm.dataset.sample, {
        resinBatch: data.get("resinBatch"),
        coverslipNo: data.get("coverslipNo"),
        cureTemp: data.get("cureTemp"),
        operator: data.get("operator")
      });
      if (!result.ok) return showBanner("error", "封片登记被拒，整单未受理：" + errorText(result));
      renderAll();
      if (result.reused) {
        showBanner("info", "该样本已有未结束封片单 " + Store.slipNo(result.slip) + "，重复登记沿用首次信息。");
        openStageForOpenSlip(result.slip);
      } else {
        showBanner("ok", "封片单 " + Store.slipNo(result.slip) + " 登记成功，进入固化。");
        openCurePanel(result.slip);
      }
      return;
    }

    if (kind === "cure") {
      var at = new Date(data.get("at")).getTime();
      var cure = Store.completeCuring(panelForm.dataset.slip, at);
      if (!cure.ok) return showBanner("error", "固化完成登记被拒：" + errorText(cure));
      renderAll();
      var ni = R.nextInspection(cure.slip);
      showBanner("ok", "封片单 " + Store.slipNo(cure.slip) + " 已进入双检队列；首次检查最早 " + R.formatMs(ni.earliest) + "。");
      openInspectPanel(cure.slip);
      return;
    }

    if (kind === "inspect") {
      var insp = Store.addInspection(panelForm.dataset.slip, {
        at: new Date(data.get("at")).getTime(),
        inspector: data.get("inspector"),
        bubblePct: data.get("bubblePct"),
        overflow: data.get("overflow") === "on",
        hardnessOK: data.get("hardnessOK") === "on"
      });
      if (!insp.ok) return showBanner("error", "检查登记被拒：" + errorText(insp));
      renderAll();
      if (insp.verdict.status === S.ADMITTED) {
        showBanner("ok", "两次检查均合格（气泡 ≤5%、无溢胶、硬度达标），" + Store.slipNo(insp.slip) + " 准入观察。");
        renderDefaultPane();
      } else if (insp.verdict.status === S.DENIED) {
        showBanner("error", "检查不合格，封片单拒绝准入：" + (insp.slip.deniedReason || ""));
        renderDefaultPane();
      } else {
        showBanner("info", "第 1 次检查通过；第 2 次最早 " + R.formatMs(R.nextInspection(insp.slip).earliest) + "，仍须由另一人隔 12 小时执行。");
        openInspectPanel(insp.slip);
      }
      return;
    }

    if (kind === "revise-mount") {
      var rev = Store.reviseMounting(panelForm.dataset.slip, {
        resinBatch: data.get("resinBatch"),
        coverslipNo: data.get("coverslipNo"),
        cureTemp: data.get("cureTemp"),
        operator: data.get("operator")
      });
      if (!rev.ok) return showBanner("error", "重算被拒：" + errorText(rev));
      renderAll();
      showBanner("ok", "旧单 " + Store.slipNo(rev.superseded) + " 已只读失效；新单 " + Store.slipNo(rev.slip) + " 按新值重算，进入固化。");
      openCurePanel(rev.slip);
    }
  });

  // ---------- 列表 / 队列 / 履历的按钮与照片修订 ----------

  document.querySelector(".board").addEventListener("click", function (event) {
    var btn = event.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.dataset.action;
    if (action === "mount") {
      openMountPanel(btn.dataset.sample, null);
    } else if (action === "cure") {
      var curing = findSlip(btn.dataset.slip);
      if (curing) openCurePanel(curing);
    } else if (action === "inspect") {
      var checking = findSlip(btn.dataset.slip);
      if (checking) openInspectPanel(checking);
    } else if (action === "revise-mount") {
      var slip = findSlip(btn.dataset.slip);
      if (slip) openReviseMountPanel(slip);
    }
  });

  sampleGrid.addEventListener("change", async function (event) {
    var sampleId = event.target.dataset && event.target.dataset.photo;
    if (!sampleId || !event.target.files[0]) return;
    var photo = await readFile(event.target.files[0]);
    var result = Store.revisePhoto(sampleId, photo);
    if (!result.ok) {
      showBanner("error", "照片修订被拒：" + errorText(result));
    } else if (result.newSlip) {
      showBanner("ok", "照片已修订；原准入单 " + Store.slipNo(result.superseded) + " 只读失效，新单 " + Store.slipNo(result.newSlip) + " 按新照片重算。");
    } else {
      showBanner("ok", "照片已更新。");
    }
    renderAll();
    renderDefaultPane();
  });

  // ---------- 标签页 / 筛选 / 导出 ----------

  document.querySelector(".tabs").addEventListener("click", function (event) {
    var tab = event.target.closest("[data-tab]");
    if (!tab) return;
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
    ["list", "queue", "history"].forEach(function (name) {
      document.querySelector("#pane-" + name).hidden = name !== tab.dataset.tab;
    });
  });

  [mineralFilter, polarFilter, admissionFilter].forEach(function (field) {
    field.addEventListener("input", renderList);
    field.addEventListener("change", renderList);
  });

  document.querySelector("#exportBtn").addEventListener("click", function () {
    var checklist = Store.state.samples
      .filter(function (sample) {
        var latest = R.latestSlip(Store.state.slips, sample.id);
        return latest && latest.status === S.ADMITTED;
      })
      .map(function (sample) {
        var slip = R.latestSlip(Store.state.slips, sample.id);
        return {
          样本编号: sample.code,
          采样地点: sample.location,
          放大倍数: sample.magnification,
          偏光类型: sample.polarization,
          主要矿物: sample.minerals,
          封片单号: Store.slipNo(slip),
          树脂批次: slip.resinBatch,
          盖玻片编号: slip.coverslipNo,
          固化温度: slip.cureTemp + "℃",
          封片操作人: slip.operator,
          检查记录: slip.inspections.map(function (ins) {
            return "第" + ins.index + "次 " + R.formatMs(ins.at) + " " + ins.inspector +
              " 气泡" + ins.bubblePct + "% " + (ins.overflow ? "有溢胶" : "无溢胶") + " " +
              (ins.hardnessOK ? "硬度达标" : "硬度不达标");
          }).join("；"),
          准入时间: R.formatMs(slip.admittedAt)
        };
      });
    var blob = new Blob([JSON.stringify(checklist, null, 2)], { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "admitted-slides-checklist.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  renderAll();
  renderDefaultPane();
})();
