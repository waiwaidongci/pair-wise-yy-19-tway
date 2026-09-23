/*
 * 树脂封片准入台 —— 存储层
 * 只负责 localStorage 的读写、旧版（薄片索引台）数据迁移与落盘。
 * 封片单规则不写在这里。
 */
(function (global) {
  "use strict";

  const storageKey = "wxyy-2-thin-section-index";

  function emptyState() {
    return {
      version: 2,
      samples: [],   // 薄片样本（索引台原有数据）
      orders: [],    // 树脂封片单：一张封片单一条，变更重算新增一条只读旧单
      compare: []    // 并排对比（最多两张）
    };
  }

  function migrate(raw) {
    if (!raw || typeof raw !== "object") return emptyState();
    const state = emptyState();
    state.samples = Array.isArray(raw.samples) ? raw.samples : [];
    state.compare = Array.isArray(raw.compare) ? raw.compare.slice(0, 2) : [];
    // 旧版索引台无封片单：以空队列起步，由交互层登记
    state.orders = Array.isArray(raw.orders) ? raw.orders : [];
    state.version = 2;
    return state;
  }

  function load() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch (error) {
      raw = null;
    }
    return migrate(raw);
  }

  function save(state) {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }

  global.MountStore = { storageKey, emptyState, load, save };
})(window);
