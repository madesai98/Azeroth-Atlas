// A clock beside the page's frames (a worker): ten ticks a second, whether or not the page is on
// show. A page behind another window is given no frames, and its own timers are held back - a
// worker's are not. main.js takes its steps from here whenever the frames have stopped, so
// that the routes go on being worked out, and sent to the game, with the map out of sight.
setInterval(() => postMessage(0), 100);
