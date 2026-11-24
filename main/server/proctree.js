'use strict';
/**
 * Linux process-tree helpers.
 *
 * Black Mirror only signals a PID it already decided it owns. This module
 * never scans the system for "inference-looking" processes to kill. It only
 * walks descendants of one root PID (via /proc) and that PID's process
 * group, then reports which of those PIDs are actually gone.
 */
const fs = require('fs');

function readProcFile(pid, name) {
  try { return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8'); } catch (_) { return null; }
}

function procPpid(pid) {
  const stat = readProcFile(pid, 'stat');
  if (!stat) return null;
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 2).split(' ');
  const ppid = parseInt(fields[1], 10); // field 4 overall, index 1 after comm
  return Number.isInteger(ppid) ? ppid : null;
}

function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Descendants of rootPid, not including root. Bounded so a corrupt /proc
 * cannot loop forever.
 */
function collectDescendants(rootPid, opts = {}) {
  const max = opts.max || 64;
  const readdir = opts.readdirSync || (p => fs.readdirSync(p));
  const ppidOf = opts.ppidOf || procPpid;
  let pids = [];
  try {
    pids = readdir('/proc').filter(n => /^\d+$/.test(n)).map(n => Number(n));
  } catch (_) { return []; }
  const children = new Map();
  for (const pid of pids) {
    const pp = ppidOf(pid);
    if (pp == null) continue;
    if (!children.has(pp)) children.set(pp, []);
    children.get(pp).push(pid);
  }
  const out = [];
  const stack = [Number(rootPid)];
  const seen = new Set(stack);
  while (stack.length && out.length < max) {
    const cur = stack.pop();
    for (const child of children.get(cur) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

/**
 * Signal an owned process and its descendants. Refuses pid <= 1 and self.
 * Returns only after a short confirmation window. `confirmedDead` is false
 * if any targeted PID is still alive — callers must not report success then.
 */
async function killOwnedTree(rootPid, opts = {}) {
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const pid = Number(rootPid);
  const result = {
    rootPid: pid,
    signaled: false,
    descendants: [],
    aliveAfter: [],
    confirmedDead: false,
    refused: null
  };
  if (!Number.isInteger(pid) || pid <= 1) {
    result.refused = 'refusing to signal pid <= 1';
    return result;
  }
  if (pid === process.pid) {
    result.refused = 'refusing to signal the Black Mirror process itself';
    return result;
  }
  const descendants = collectDescendants(pid);
  result.descendants = descendants;
  const targets = [pid, ...descendants];

  // Process-group signal only works when the child was spawned detached
  // (it is the group leader). Harmless ESRCH/EPERM otherwise.
  if (opts.processGroup !== false) {
    try { process.kill(-pid, 'SIGTERM'); } catch (_) { /* not a group leader */ }
  }
  for (const t of targets) {
    try { process.kill(t, 'SIGTERM'); result.signaled = true; } catch (e) {
      if (e.code !== 'ESRCH') { /* still try the rest */ }
    }
  }

  const deadline = Date.now() + (opts.termWaitMs || 2500);
  while (Date.now() < deadline) {
    const alive = targets.filter(isAlive);
    if (!alive.length) break;
    await sleep(80);
  }
  const still = targets.filter(isAlive);
  if (still.length) {
    if (opts.processGroup !== false) {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) { /* ignore */ }
    }
    for (const t of still) {
      try { process.kill(t, 'SIGKILL'); } catch (_) { /* ignore */ }
    }
    const killDeadline = Date.now() + (opts.killWaitMs || 1500);
    while (Date.now() < killDeadline) {
      if (!targets.some(isAlive)) break;
      await sleep(80);
    }
  }
  result.aliveAfter = targets.filter(isAlive);
  result.confirmedDead = result.aliveAfter.length === 0;
  return result;
}

module.exports = { collectDescendants, killOwnedTree, procPpid, isAlive };
