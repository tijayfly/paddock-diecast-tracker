const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paddock', {
  mode: 'full',
  getDB: () => ipcRenderer.invoke('db:get'),
  paths: () => ipcRenderer.invoke('db:paths'),
  saveItem: (item) => ipcRenderer.invoke('item:save', item),
  deleteItem: (id) => ipcRenderer.invoke('item:delete', id),
  removeItem: (id) => ipcRenderer.invoke('item:remove', id),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  autofill: (name, brand) => ipcRenderer.invoke('lookup:name', name, brand),
  imageSearch: (q) => ipcRenderer.invoke('lookup:images', q),
  setImage: (id, img) => ipcRenderer.invoke('image:set', id, img),
  setImageFromFile: (id) => ipcRenderer.invoke('image:file', id),
  cacheImages: () => ipcRenderer.invoke('images:cacheAll'),
  autoPhotos: (list) => ipcRenderer.invoke('images:auto', list),
  refreshPrices: (ids) => ipcRenderer.invoke('prices:refresh', ids),
  exportViewOnly: (opts) => ipcRenderer.invoke('export:view', opts),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  openUrl: (u) => ipcRenderer.invoke('open:url', u),
  on: (ch, fn) => { const h = (_e, d) => fn(d); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); },
});
