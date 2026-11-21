// Keeps the page current: when the map's own files change on disk (an update), the server
// says so (server/changes.js) and the page loads itself again - with everything you had set
// and where you were looking kept (see "remembered between visits" in main.js).
//
// A script of its own, loaded before the map: a mistake in the map's code must not stop the
// page from picking up the fix. The page knows which files it was made from by the stamp the
// server wrote into it.
let mine = document.querySelector('meta[name="wfmap-stamp"]')?.content ?? null;
let run = null; // which run of the server was last heard from

function listen() {
  const es = new EventSource('/api/changes');
  es.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (mine === null) mine = d.viewer;
    else if (d.viewer !== mine) { location.reload(); return; }
    // (the server has been started again: whoever keeps something with it sends it once more)
    if (run !== null && d.started !== run) window.dispatchEvent(new CustomEvent('wfmap-server'));
    run = d.started;
  };
  // (the browser tries again by itself while the server is away; where it has given up, start over)
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) { es.close(); setTimeout(listen, 2000); } };
}
listen();
