// Owner 模式标志（page world）。
// 由 inject.js 在 chrome.storage.local.liaisonOwnerMode === true 时按需注入——
// 即只有作者本机会加载本文件。bundle 里的私有功能（灵感面板「线下库」tab 等）
// 以 window.__liaisonOwnerMode === true 为渲染条件；同事的全新安装没有该
// storage key，本文件不加载，私有功能不渲染。
// 开启（作者本机 SW console 执行一次）：chrome.storage.local.set({ liaisonOwnerMode: true })
window.__liaisonOwnerMode = true
