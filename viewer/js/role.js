// Which copy of the page this is.
//
// There is one map: the page in the application's window (or a browser tab). It works out the
// routes, sends the game its route, notes where NPCs stand. The application can show a second
// copy over the game - the minimap (app/overlay.cjs: /?overlay=mini) - and that one is a light
// copy: it draws, and does nothing else. It sends the server nothing, keeps no line open to it
// (a browser gives one address six lines in all, and the map needs the most of them for its
// own data), and is told what the map hears - where you are, that the page's files have
// changed - by the map itself, over a channel between the two (`talk`).
export const MINI = new URLSearchParams(location.search).get('overlay') === 'mini';

/** Between the copies of the page in this application: { t: 'player', state } | { t: 'hello' } | { t: 'reload' } | { t: 'pin', pin }. */
export const talk = (() => { try { return new BroadcastChannel('wfmap'); } catch { return null; } })();
/** Say something to the other copies. */
export const say = (message) => { try { talk?.postMessage(message); } catch { /* nobody to hear it */ } };
