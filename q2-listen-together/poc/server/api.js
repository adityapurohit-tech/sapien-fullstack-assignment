// Everything the edge (HTTP routes and gateways) may ask of the core. In single-process mode these
// are direct calls; in multi-process mode gateway processes reach them over IPC (see backend.js).

import { searchCatalog } from './catalog.js';
import { publicView } from './roomLogic.js';
import { leaseKey } from './roomService.js';

export function makeApi(cluster, gatewayRegistry) {
  return {
    // --- used by gateways
    auth: async (token) => cluster.sessions.get(String(token || '')) || null,
    snapshot: async (roomId) => {
      const st = await cluster.store.get(String(roomId || ''));
      return st ? JSON.stringify({ t: 'state', kind: 'snapshot', state: publicView(st), publishedAt: Date.now() }) : null;
    },
    routeCommand: (roomId, cmd) => cluster.routeCommand(roomId, cmd),
    reportPresence: (roomId, gatewayId, members, votes) => cluster.reportPresence(roomId, gatewayId, members, votes),
    telemetry: async (roomId, userId, name, t) => cluster.metrics.telemetry(roomId, userId, name, t),
    count: async (name) => cluster.metrics.count(name),
    log: async (type, msg, data) => cluster.log(type, msg, data),

    // --- used by HTTP routes
    catalog: async () => cluster.catalog,
    search: async (q) => searchCatalog(cluster.catalog, q).slice(0, 10),
    createSession: async (name) => cluster.createSession(name),
    createRoom: async (name, roomName, token) => {
      let t = String(token || '');
      if (!cluster.sessions.has(t)) t = cluster.createSession(name).token;
      const host = cluster.sessions.get(t);
      const roomId = await cluster.createRoom(roomName, host);
      return { roomId, token: t, userId: host.userId, name: host.name };
    },
    roomInfo: async (roomId) => {
      const st = cluster.store.peek(String(roomId));
      return st ? { roomId: st.roomId, roomName: st.roomName } : null;
    },
    ops: async (roomId) => cluster.ops(roomId, gatewayRegistry.list()),
    metrics: async () => {
      const mem = process.memoryUsage();
      const { events, ...ops } = cluster.ops(null, gatewayRegistry.list());
      return {
        sync: cluster.metrics.snapshot(),
        rooms: cluster.store.keys().length,
        leases: cluster.store.keys().filter((id) => cluster.leases.peek(leaseKey(id))).length,
        ...ops,
        process: { rssMB: Math.round(mem.rss / 1048576), heapUsedMB: Math.round(mem.heapUsed / 1048576), cpu: process.cpuUsage(), uptimeS: Math.round(process.uptime()) },
      };
    },
    adminNode: async (id, act, ms) => {
      const node = cluster.nodes.find((n) => n.id === id);
      if (!node) return { error: 'No such node' };
      if (act === 'crash') node.crash();
      if (act === 'freeze') node.freeze(Math.min(30000, Number(ms) || 8000));
      if (act === 'revive') node.revive();
      return { ok: true, status: node.status };
    },
    adminGateway: async (id) => (gatewayRegistry.restart(id) ? { ok: true } : { error: 'No such gateway' }),
  };
}
