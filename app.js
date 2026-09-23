/*
 * 树脂封片准入台 —— 交互层
 * 规则来自 MountRules，存储来自 MountStore；本文件只负责 DOM、表单与渲染。
 * 列表 / 队列 / 履历每次都从同一份 state 重新派生。
 */
(function () {
  "use strict";

  const R = window.MountRules;
  const Store = window.MountStore;
  const state = Store.load();

  const sampleForm = document.querySelector("#sampleForm");
  const photoInput = document.querySelector("#photoInput");
  const mountForm = document.querySelector("#mountForm");
  const mountError = document.querySelector("#mountError");
  const mountHint = document.querySelector("#mountHint");
  const sampleSelect = mountForm.querySelector("[name=sampleId]");
  const revisePhotoInput = mountForm.querySelector("[name=photo]");

  const sampleGrid = document.querySelector("#sampleGrid");
  const queuePane = document.querySelector("#queuePane");
  const historyPane = document.querySelector("#historyPane");
  const comparePane = document.querySelector("#comparePane");
  const mineralFilter = document.querySelector("#mineralFilter");
  const polarFilter = document.querySelector("#polarFilter");
  const statusFilter = document.querySelector("#statusFilter");
  const toast = document.querySelector("#toast");

  let pendingPhoto = "";        // 新样本登记照片
  let pendingRevisionPhoto = null; // 变更登记照片：null=未选择
  let toastTimer = null;

  function save() {
    Store.save(state);
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result));
      reader.readAsDataURL(file);
    });
  }

  function fmt(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function toLocalInput(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function showToast(message, type) {
    toast.textContent = message;
    toast.className = `toast show ${type || ""}`;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
      toast.className = "toast";
    }, 3200);
  }

  function showMountError(errors) {
    mountError.textContent = `整单拒绝：${errors.join("；")}`;
    mountError.hidden = false;
  }

  function clearMountError() {
    mountError.hidden = true;
    mountError.textContent = "";
  }

  function replaceOrder(order) {
    const index = state.orders.findIndex((item) => item.id === order.id);
    if (index >= 0) state.orders[index] = order;
  }

  function mountFormData(form) {
    const data = new FormData(form);
    return {
      resinBatch: data.get("resinBatch"),
      resinExpiry: data.get("resinExpiry"),
      coverslipNo: data.get("coverslipNo"),
      cureTemp: data.get("cureTemp"),
      operator: data.get("operator")
    };
  }

  function resetMountFields() {
    ["resinBatch", "resinExpiry", "coverslipNo", "cureTemp", "operator"].forEach((name) => {
      mountForm.querySelector(`[name=${name}]`).value = "";
    });
    revisePhotoInput.value = "";
    pendingRevisionPhoto = null;
    clearMountError();
  }

  function fillMountFromOrder(order) {
    sampleSelect.value = order.sampleId;
    mountForm.querySelector("[name=resinBatch]").value = order.resinBatch;
    mountForm.querySelector("[name=resinExpiry]").value = order.resinExpiry;
    mountForm.querySelector("[name=coverslipNo]").value = order.coverslipNo;
    mountForm.querySelector("[name=cureTemp]").value = order.cureTemp;
    mountForm.querySelector("[name=operator]").value = order.operator;
    revisePhotoInput.value = "";
    pendingRevisionPhoto = null;
    clearMountError();
    updateMountHint();
    mountForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ---------- 左侧表单 ---------- */

  photoInput.addEventListener("change", async () => {
    pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
    if (pendingPhoto == null) pendingPhoto = "";
  });

  revisePhotoInput.addEventListener("change", async () => {
    pendingRevisionPhoto = await readFileAsDataUrl(revisePhotoInput.files[0]);
  });

  sampleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(sampleForm);
    if (!pendingPhoto && photoInput.files[0]) {
      pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
    }
    const sample = {
      id: crypto.randomUUID(),
      photo: pendingPhoto,
      code: data.get("code").trim(),
      location: data.get("location").trim(),
      magnification: data.get("magnification").trim(),
      polarization: data.get("polarization"),
      minerals: data.get("minerals").trim(),
      texture: data.get("texture").trim(),
      comment: data.get("comment").trim(),
      createdAt: new Date().toISOString()
    };
    state.samples.unshift(sample);
    pendingPhoto = "";
    photoInput.value = "";
    sampleForm.reset();
    save();
    renderAll();
    sampleSelect.value = sample.id;
    updateMountHint();
    showToast("样本已保存，可在下方登记封片单");
  });

  function updateMountHint() {
    const id = sampleSelect.value;
    if (!id) {
      mountHint.textContent = "每样本仅允许一张未结束封片单；缺项或批次过期整单拒绝。";
      return;
    }
    const info = R.sampleStatus(state, id);
    if (info.code === "none") {
      mountHint.textContent = "该样本尚未封片：填写树脂批次、盖玻片编号、固化温度和操作人后登记。";
    } else if (info.code === "open") {
      const order = info.order;
      const count = order.inspections.length;
      mountHint.textContent = `该样本已有未结束封片单（第 ${order.seq} 单，${order.resinBatch}），重复登记沿用首次。`;
    } else if (info.code === "admitted") {
      mountHint.textContent = "已准入观察。更换树脂、盖玻片或修订照片请走变更登记：旧准入失效并按新值重算，旧记录只读。";
    } else {
      mountHint.textContent = "上一封片单检查不合格已结束；可修正参数后重新登记。";
    }
  }

  sampleSelect.addEventListener("change", () => {
    clearMountError();
    pendingRevisionPhoto = null;
    revisePhotoInput.value = "";
    updateMountHint();
  });

  mountForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const sampleId = sampleSelect.value;
    if (!sampleId) {
      showMountError(["请先选择样本"]);
      return;
    }
    const mode = (event.submitter && event.submitter.value) || "register";
    const input = mountFormData(mountForm);

    try {
      if (mode === "revise") {
        const { order } = R.reviseMount(state, sampleId, input, pendingRevisionPhoto, new Date());
        state.orders.push(order);
        const sample = state.samples.find((item) => item.id === sampleId);
        if (sample) sample.photo = order.photo; // 修订照片作为当前生效照片
        showToast(`第 ${order.seq} 单已建立，旧准入失效，按新值重新进入封片流程`, "warn");
      } else {
        const { order, reused } = R.registerMount(state, sampleId, input, new Date());
        if (reused) {
          showToast(`该样本已有未结束封片单，沿用首次登记的第 ${order.seq} 单（${order.resinBatch}）`);
        } else {
          state.orders.push(order);
          showToast(`第 ${order.seq} 张封片单已登记，等待固化`);
        }
      }
      save();
      resetMountFields();
      renderAll();
      sampleSelect.value = sampleId;
      updateMountHint();
      switchTab("queue");
    } catch (error) {
      if (error instanceof R.RuleError) {
        showMountError(error.errors);
      } else {
        throw error;
      }
    }
  });

  /* ---------- 列表 ---------- */

  function filteredSamples() {
    const mineral = mineralFilter.value.trim();
    const polarization = polarFilter.value;
    const status = statusFilter.value;
    return state.samples.filter((sample) => {
      const mineralMatch = !mineral || sample.minerals.includes(mineral);
      const polarMatch = !polarization || sample.polarization === polarization;
      const statusMatch = !status || R.sampleStatus(state, sample.id).code === status;
      return mineralMatch && polarMatch && statusMatch;
    });
  }

  function badgeClass(code) {
    return `badge badge-${code}`;
  }

  function orderSummary(order) {
    const cured = order.curedAt ? `固化于 ${fmt(order.curedAt)}` : "待固化";
    return `第${order.seq}单 · ${esc(order.resinBatch)} · 盖玻片 ${esc(order.coverslipNo)} · ${esc(String(order.cureTemp))}℃ · ${esc(order.operator)} · ${cured} · 检查 ${order.inspections.length}/2`;
  }

  function cardActions(sample, info) {
    const admitted = info.code === R.ORDER_STATUS.ADMITTED;
    const compare = `
      <label class="compare-check"><input type="checkbox" data-compare="${sample.id}"
        ${state.compare.includes(sample.id) ? "checked" : ""}
        ${admitted ? "" : "disabled"}>对比</label>`;

    let context = "";
    if (info.code === "none") {
      context = `<button type="button" class="ghost" data-mount="${sample.id}">登记封片</button>`;
    } else if (info.code === "open") {
      context = `<button type="button" class="ghost" data-goto-queue="${sample.id}">查看队列</button>`;
    } else if (info.code === "admitted") {
      context = `<button type="button" class="ghost" data-revise="${sample.id}">变更登记</button>`;
    } else {
      context = `<button type="button" class="ghost" data-mount="${sample.id}">重新登记</button>`;
    }

    return `
      <div class="card-actions">
        ${compare}
        <span class="action-group">
          ${context}
          <button type="button" class="ghost danger" data-delete="${sample.id}">删除</button>
        </span>
      </div>`;
  }

  function renderList() {
    const rows = filteredSamples();
    sampleGrid.innerHTML = rows.length ? rows.map((sample) => {
      const info = R.sampleStatus(state, sample.id);
      const photo = R.effectivePhoto(state, sample);
      return `
      <article class="sample-card">
        ${photo ? `<img src="${photo}" alt="${esc(sample.code)}显微照片">` : '<div class="photo-placeholder"></div>'}
        <div class="sample-body">
          <div class="card-head">
            <h3>${esc(sample.code)}</h3>
            <span class="${badgeClass(info.code)}">${esc(info.label)}</span>
          </div>
          <p>${esc(sample.location || "未记录地点")} · ${esc(sample.magnification || "未记录倍数")} · ${esc(sample.polarization)}</p>
          <p>矿物：${esc(sample.minerals || "未记录")}</p>
          <p>结构：${esc(sample.texture || "未记录")}</p>
          <p>${esc(sample.comment || "未填写批注")}</p>
          ${info.order ? `<p class="order-line">${orderSummary(info.order)}</p>` : ""}
          ${cardActions(sample, info)}
        </div>
      </article>`;
    }).join("") : "<p class=\"empty\">没有符合条件的样本。</p>";
  }

  /* ---------- 队列 ---------- */

  function inspectForm(order, stageInfo) {
    const index = order.inspections.length;
    const round = index + 1;
    let minAttr = "";
    let note = `固化后由操作人（${esc(order.operator)}）之外的另一人检查；气泡≤${R.BUBBLE_LIMIT_PERCENT}%、无溢胶、硬度达标。`;
    if (index === 1) {
      const min = new Date(new Date(order.inspections[0].at).getTime() + R.INSPECTION_GAP_MS);
      minAttr = ` min="${toLocalInput(min.toISOString())}"`;
      note += ` 第二次须距首次满 12 小时，最早 ${fmt(min.toISOString())}。`;
    }
    return `
      <form class="inspect-form" data-order-id="${order.id}">
        <p class="form-hint">${note}</p>
        <div class="pair">
          <label>检查人<input name="inspector" required placeholder="不得为封片操作人"></label>
          <label>检查时间<input name="at" type="datetime-local" step="60"${minAttr} placeholder="留空=当前"></label>
        </div>
        <div class="pair">
          <label>气泡面积占比(%)<input name="bubblePercent" type="number" min="0" max="100" step="0.1" required></label>
          <span class="checkline">
            <label class="inline"><input type="checkbox" name="hardnessOk"> 硬度达标</label>
            <label class="inline"><input type="checkbox" name="overflow"> 存在溢胶</label>
          </span>
        </div>
        <button type="submit">提交第 ${round} 次检查</button>
      </form>`;
  }

  function renderQueue() {
    const groups = R.queue(state, new Date());
    queuePane.innerHTML = groups.map((group) => `
      <section class="queue-group">
        <h2>${group.label}<span class="queue-count">${group.orders.length}</span></h2>
        ${group.orders.length ? group.orders.map((order) => {
          const sample = state.samples.find((item) => item.id === order.sampleId);
          const stageInfo = R.stage(order, new Date());
          return `
          <article class="queue-card" data-order-card="${order.id}">
            <div class="queue-head">
              <strong>${esc(sample ? sample.code : "样本已删除")}</strong>
              <span class="muted">第 ${order.seq} 单 · ${esc(order.resinBatch)} · 盖玻片 ${esc(order.coverslipNo)} · ${esc(String(order.cureTemp))}℃</span>
            </div>
            <p class="muted">登记 ${fmt(order.createdAt)} · 操作人 ${esc(order.operator)}
              ${order.revisionOf ? " · <em>变更重算单</em>" : ""}</p>
            ${group.key === "curing"
              ? `<button type="button" data-cure="${order.id}">标记固化完成</button>`
              : inspectForm(order, stageInfo)}
          </article>`;
        }).join("") : '<p class="empty">该阶段暂无封片单。</p>'}
      </section>`).join("");
  }

  /* ---------- 履历（只读） ---------- */

  function renderHistory() {
    const rows = R.history(state);
    historyPane.innerHTML = rows.length ? rows.map(({ order, sample, status, superseded }) => {
      const label = R.SAMPLE_STATUS_LABEL[status];
      const replacement = state.orders.find((item) => item.revisionOf === order.id);
      const inspections = order.inspections.length ? order.inspections.map((item, index) => `
        <li class="${item.pass ? "pass" : "fail"}">
          第 ${index + 1} 次 · ${fmt(item.at)} · ${esc(item.inspector)} ·
          气泡 ${esc(String(item.bubblePercent))}% · ${item.hardnessOk ? "硬度达标" : "硬度不足"} · ${item.overflow ? "有溢胶" : "无溢胶"}
          ${item.pass ? "（合格）" : `（${esc(R.failReason(item))}）`}
        </li>`).join("") : "<li>尚无检查记录</li>";
      return `
      <article class="history-card ${superseded ? "readonly" : ""}">
        <div class="queue-head">
          <strong>${esc(sample ? sample.code : "样本已删除")} · 第 ${order.seq} 单</strong>
          <span>
            <span class="${badgeClass(status)}">${esc(label)}</span>
            ${superseded ? '<span class="badge badge-superseded">已失效·只读</span>' : ""}
          </span>
        </div>
        <p class="muted">
          树脂批次 ${esc(order.resinBatch)}（有效期至 ${esc(order.resinExpiry)}） · 盖玻片 ${esc(order.coverslipNo)} ·
          固化温度 ${esc(String(order.cureTemp))}℃ · 操作人 ${esc(order.operator)}
        </p>
        <p class="muted">登记 ${fmt(order.createdAt)} · 固化 ${fmt(order.curedAt)}
          ${replacement ? ` · 因变更重算，由第 ${replacement.seq} 单取代` : ""}
        </p>
        <ul class="inspection-list">${inspections}</ul>
        ${order.photo ? `<img class="history-photo" src="${order.photo}" alt="封片时照片快照">` : ""}
      </article>`;
    }).join("") : '<p class="empty">还没有封片单，先在左侧登记。</p>';
  }

  /* ---------- 对比 ---------- */

  function renderCompare() {
    // 仅已准入样本可对比：清掉历史遗留的无效选择
    const valid = state.compare.filter((id) => {
      const sample = state.samples.find((item) => item.id === id);
      return sample && R.sampleStatus(state, id).code === R.ORDER_STATUS.ADMITTED;
    });
    if (valid.length !== state.compare.length) {
      state.compare = valid;
      save();
    }

    const compareSamples = valid
      .map((id) => state.samples.find((sample) => sample.id === id))
      .filter(Boolean)
      .slice(0, 2);

    comparePane.innerHTML = compareSamples.length ? compareSamples.map((sample) => `
      <article class="compare-item">
        ${R.effectivePhoto(state, sample) ? `<img src="${R.effectivePhoto(state, sample)}" alt="${esc(sample.code)}对比图">` : ""}
        <h3>${esc(sample.code)}</h3>
        <p>${esc(sample.polarization)} · ${esc(sample.minerals || "未记录矿物")}</p>
        <p>${esc(sample.texture || "未记录结构")}</p>
      </article>
    `).join("") : "<p>仅已准入观察的样本可勾选，最多两张并排对比。</p>";
  }

  /* ---------- 表单下拉与视图切换 ---------- */

  function renderMountSelect() {
    const current = sampleSelect.value;
    sampleSelect.innerHTML = state.samples.length
      ? `<option value="">请选择样本</option>` + state.samples.map((sample) => {
        const info = R.sampleStatus(state, sample.id);
        return `<option value="${sample.id}">${esc(sample.code)}（${esc(info.label)}）</option>`;
      }).join("")
      : '<option value="">请先录入样本</option>';
    if (current && state.samples.some((sample) => sample.id === current)) {
      sampleSelect.value = current;
    }
    updateMountHint();
  }

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === name);
    });
    document.querySelector("#listView").hidden = name !== "list";
    document.querySelector("#queueView").hidden = name !== "queue";
    document.querySelector("#historyView").hidden = name !== "history";
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  function flashQueueOrder(orderId) {
    switchTab("queue");
    renderQueue();
    const card = queuePane.querySelector(`[data-order-card="${orderId}"]`);
    if (card) {
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1800);
    }
  }

  /* ---------- 事件委托 ---------- */

  sampleGrid.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const { delete: deleteId, gotoQueue, revise, mount } = button.dataset;

    if (deleteId) {
      state.samples = state.samples.filter((sample) => sample.id !== deleteId);
      state.orders = state.orders.filter((order) => order.sampleId !== deleteId);
      state.compare = state.compare.filter((id) => id !== deleteId);
      save();
      renderAll();
      showToast("样本及其封片记录已删除");
      return;
    }
    if (gotoQueue) {
      flashQueueOrder(R.latestOrder(state, gotoQueue).id);
      return;
    }
    if (revise) {
      const order = R.latestOrder(state, revise);
      if (order) fillMountFromOrder(order);
      return;
    }
    if (mount) {
      sampleSelect.value = mount;
      const order = R.latestOrder(state, mount);
      if (order && R.orderStatus(order) === R.ORDER_STATUS.FAILED) {
        fillMountFromOrder(order); // 重新登记时沿用上一次参数，便于修正
      } else {
        clearMountError();
        updateMountHint();
      }
      mountForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  sampleGrid.addEventListener("change", (event) => {
    const id = event.target.dataset.compare;
    if (!id) return;
    if (R.sampleStatus(state, id).code !== R.ORDER_STATUS.ADMITTED) {
      event.target.checked = false;
      return;
    }
    if (event.target.checked) {
      state.compare = [id, ...state.compare.filter((item) => item !== id)].slice(0, 2);
    } else {
      state.compare = state.compare.filter((item) => item !== id);
    }
    save();
    renderCompare();
  });

  queuePane.addEventListener("click", (event) => {
    const cureId = event.target.closest("button[data-cure]")?.dataset.cure;
    if (!cureId) return;
    const order = state.orders.find((item) => item.id === cureId);
    try {
      replaceOrder(R.markCured(order, new Date()));
      save();
      renderQueue();
      showToast("已标记固化完成，可安排第一次检查");
    } catch (error) {
      if (error instanceof R.RuleError) showToast(error.errors.join("；"), "error");
      else throw error;
    }
  });

  queuePane.addEventListener("submit", (event) => {
    const form = event.target.closest(".inspect-form");
    if (!form) return;
    event.preventDefault();
    const orderId = form.dataset.orderId;
    const order = state.orders.find((item) => item.id === orderId);
    const data = new FormData(form);
    const input = {
      inspector: data.get("inspector"),
      at: data.get("at"),
      bubblePercent: data.get("bubblePercent"),
      hardnessOk: data.has("hardnessOk"),
      overflow: data.has("overflow")
    };
    try {
      const result = R.addInspection(order, input, new Date());
      replaceOrder(Object.assign({}, order, { inspections: result.inspections }));
      save();
      renderAll();
      if (result.status === R.ORDER_STATUS.ADMITTED) {
        showToast("两次检查均合格，封片单结束：准入观察", "ok");
      } else if (result.status === R.ORDER_STATUS.FAILED) {
        showToast(`检查不合格，封片单结束：${R.failReason(result.inspection)}`, "error");
      } else {
        showToast("第一次检查合格，满 12 小时后由另一人复检");
      }
    } catch (error) {
      if (error instanceof R.RuleError) showToast(error.errors.join("；"), "error");
      else throw error;
    }
  });

  [mineralFilter, polarFilter, statusFilter].forEach((field) => {
    field.addEventListener("input", renderList);
  });

  document.querySelector("#exportBtn").addEventListener("click", () => {
    const checklist = state.samples.map((sample) => {
      const info = R.sampleStatus(state, sample.id);
      const order = info.order;
      return {
        样本编号: sample.code,
        采样地点: sample.location,
        放大倍数: sample.magnification,
        偏光类型: sample.polarization,
        主要矿物: sample.minerals,
        颗粒结构: sample.texture,
        老师批注: sample.comment,
        准入状态: info.label,
        树脂批次: order ? order.resinBatch : "",
        批次有效期: order ? order.resinExpiry : "",
        盖玻片编号: order ? order.coverslipNo : "",
        固化温度: order ? order.cureTemp : "",
        封片操作人: order ? order.operator : "",
        固化时间: order && order.curedAt ? order.curedAt : "",
        检查次数: order ? order.inspections.length : 0
      };
    });
    const blob = new Blob([JSON.stringify(checklist, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "resin-mount-checklist.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  function renderAll() {
    renderMountSelect();
    renderList();
    renderQueue();
    renderHistory();
    renderCompare();
  }

  renderAll();
})();
