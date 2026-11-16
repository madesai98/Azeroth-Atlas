// What the application's window gives the page that a browser tab does not have: its own "Save
// as" window, for "Report a problem" (viewer/js/report.js; and app/loading.html, while the map's
// server is not up). Nothing else of the application is within the page's reach.
//
//   window.azerothAtlas.chooseSave(name)    ask where to save a file: { token, file } or null (you closed it)
//                      .write(token, data)  write it there (only to a place chosen so, and once)
//                      .reveal(token)       show the saved file in its folder
//                      .report(text)        make a report without the map's server (it is not up): { file } or { error } or null
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('azerothAtlas', {
  chooseSave: (name) => ipcRenderer.invoke('atlas:save', String(name ?? '')),
  write: (token, data) => ipcRenderer.invoke('atlas:write', String(token ?? ''), data),
  reveal: (token) => ipcRenderer.invoke('atlas:reveal', String(token ?? '')),
  report: (text) => ipcRenderer.invoke('atlas:report', String(text ?? '')),
});
