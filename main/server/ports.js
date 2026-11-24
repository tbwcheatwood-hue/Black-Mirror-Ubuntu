'use strict';
/** Port availability checks. */
const net = require('net');

/**
 * Check whether a TCP port is free for binding on a given host.
 * Returns { free, reason } — 'in-use' when something already listens there.
 */
function checkPort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise(resolve => {
    const srv = net.createServer();
    let settled = false;
    const done = r => { if (!settled) { settled = true; resolve(r); } };
    srv.once('error', err => {
      done(err.code === 'EADDRINUSE' || err.code === 'EACCES'
        ? { free: false, reason: err.code === 'EACCES' ? 'no-permission' : 'in-use' }
        : { free: false, reason: err.code });
    });
    srv.once('listening', () => {
      srv.close(() => done({ free: true, reason: null }));
    });
    try {
      srv.listen({ port, host, exclusive: true });
    } catch (e) {
      done({ free: false, reason: e.code });
    }
    setTimeout(() => done({ free: false, reason: 'timeout' }), timeoutMs);
  });
}

/** Find the first free port in a range, preferring `preferred`. */
async function findFreePort(preferred, host = '127.0.0.1', span = 20) {
  for (let p = preferred; p < preferred + span; p++) {
    const st = await checkPort(p, host);
    if (st.free) return p;
  }
  return null;
}

const isPrivileged = port => port < 1024;

module.exports = { checkPort, findFreePort, isPrivileged };
