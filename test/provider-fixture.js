'use strict';
// E2E provider fixture: serves a `calc_js` module over plain TCP and emits a
// periodic `ticked` event. Run as a child process by test/e2e.js.
const { Provider, tcp } = require('..');

const PORT = Number(process.env.LOGOS_E2E_PORT || 6111);
const p = new Provider('calc_js', tcp('127.0.0.1', PORT));

p.register({
  handlers: {
    add: (a, b) => a + b,
    greet: (name) => ({ message: `hello ${name}` }),
    echoBytes: (obj) => obj, // round-trips a {_bytes} value untouched
  },
  events: ['ticked'],
});
p.saveToken('e2e_app', 'e2e-tok'); // authorize the e2e consumer

console.log('READY');

let n = 0;
const timer = setInterval(() => { p.emit('ticked', ++n); }, 200);

function shutdown() { clearInterval(timer); p.destroy(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
