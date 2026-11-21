// What the application's window gives the page that a browser tab does not have: its own "Save
// as" window, for "Report a problem" (viewer/js/report.js; and app/loading.html, while the map's
// server is not up) - and the overlays, the map drawn over the game (app/overlay.cjs;
// viewer/js/overlay.js). Nothing else of the application is within the page's reach.
//
//   window.azerothAtlas.chooseSave(name)    ask where to save a file: { token, file } or null (you closed it)
//                      .write(token, data)  write it there (only to a place chosen so, and once)
//                      .reveal(token)       show the saved file in its folder
//                      .report(text)        make a report without the map's server (it is not up): { file } or { error } or null
//
//   window.azerothAtlas.overlay
//     .get()            how things stand: { settings, game: { w, h, from, status, minimized }, over, keys, least, role }
//     .set(patch)       change what is set ({ side | map | mini: { ...only what changes } }): the same, as it then stands
//     .toggle(id)       bring an overlay up, or put it away
//     .dock()           put the sidebar and the map away: the page is back in its window
//     .on(fn)           fn(how things stand) whenever any of it changes
//     .game(info)       tell the application where the game's window is: { status, window: { x, y, w, h } } as the map's server has it
//     .rects(list)      (the page, over the game) what of it can be clicked just now: [{ x, y, w, h }] in the window
//     .hold(on)         a drag is under way: the mouse stays with the overlay until it is over
//     .through(on)      (the minimap) clicks go through it just now
//     .typing(on)       you are typing into the overlay: it takes the keyboard, and gives it back
//     .state()          (for the tests) how the windows stand
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('azerothAtlas', {
  chooseSave: (name) => ipcRenderer.invoke('atlas:save', String(name ?? '')),
  write: (token, data) => ipcRenderer.invoke('atlas:write', String(token ?? ''), data),
  reveal: (token) => ipcRenderer.invoke('atlas:reveal', String(token ?? '')),
  report: (text) => ipcRenderer.invoke('atlas:report', String(text ?? '')),
  overlay: {
    get: () => ipcRenderer.invoke('atlas:overlay:get'),
    set: (patch) => ipcRenderer.invoke('atlas:overlay:set', patch),
    toggle: (id) => ipcRenderer.invoke('atlas:overlay:toggle', String(id ?? '')),
    dock: () => ipcRenderer.invoke('atlas:overlay:dock'),
    on: (fn) => { ipcRenderer.on('atlas:overlay:changed', (e, told) => { try { fn(told); } catch { /* the page's own affair */ } }); },
    game: (info) => ipcRenderer.send('atlas:overlay:game', info),
    rects: (list) => ipcRenderer.send('atlas:overlay:rects', list),
    hold: (on) => ipcRenderer.send('atlas:overlay:hold', on === true),
    through: (on) => ipcRenderer.send('atlas:overlay:through', on === true),
    typing: (on) => ipcRenderer.send('atlas:overlay:typing', on === true),
    state: () => ipcRenderer.invoke('atlas:overlay:state'),
  },
});
