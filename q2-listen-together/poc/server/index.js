// Entry point. Two topologies, same code:
//   GATEWAY_PROCESSES=N (default 2): one core process (Room Service nodes, lease store, state store, bus)
//     plus N gateway processes sharing the port, as in the architecture diagram.
//   GATEWAY_PROCESSES=0: everything in one process (used by the tests).

import nodeCluster from 'node:cluster';
import { pathToFileURL } from 'node:url';
import { makeApi } from './api.js';
import { ipcBackend, localBackend, serveIpc } from './backend.js';
import { buildCatalog } from './catalog.js';
import { Cluster } from './cluster.js';
import { defaults } from './config.js';
import { Gateway } from './gateway.js';
import { createEdge, mediaDir } from './http.js';

/** Single process: core and gateways together. */
export async function startServer(overrides = {}) {
  const config = { ...defaults, ...overrides };
  const cluster = new Cluster(config, buildCatalog(mediaDir));
  const gateways = [];
  const registry = {
    list: () => gateways.map((g) => g.info()),
    restart: (id) => {
      const g = gateways.find((x) => x.id === id);
      g?.restart();
      return !!g;
    },
  };
  const api = makeApi(cluster, registry);
  const backend = localBackend(api, cluster.bus);
  for (let i = 0; i < Math.max(1, config.gateways); i++) gateways.push(new Gateway(`gw-${i + 1}`, backend, config));
  const edge = createEdge({ config, api, gateways });
  const port = await edge.listen(config.port);
  const close = async () => {
    await edge.close();
    cluster.stop();
  };
  return { cluster, port, close, config };
}

/** Core process: owns all room state; gateway workers reach it over IPC. */
async function startCore(config) {
  const cluster = new Cluster(config, buildCatalog(mediaDir));
  const infos = new Map();
  const workers = new Map(); // gateway id -> worker
  const registry = {
    list: () => [...infos.values()].sort((a, b) => a.id.localeCompare(b.id)),
    restart: (id) => {
      const w = workers.get(id);
      w?.send({ t: 'restart' });
      return !!w;
    },
  };
  const api = makeApi(cluster, registry);
  nodeCluster.schedulingPolicy = nodeCluster.SCHED_RR; // spread sockets evenly over gateway processes
  const fork = (id) => {
    const w = nodeCluster.fork({ GATEWAY_ID: id });
    workers.set(id, w);
    serveIpc(w, api, cluster.bus, (info) => infos.set(info.id, info));
    w.on('exit', () => {
      infos.delete(id);
      if (!shuttingDown) {
        cluster.log('chaos', `${id} process exited; starting a replacement`);
        setTimeout(() => fork(id), 500);
      }
    });
  };
  let shuttingDown = false;
  for (let i = 0; i < config.gatewayProcesses; i++) fork(`gw-${i + 1}`);
  await new Promise((r) => {
    let online = 0;
    nodeCluster.on('listening', () => ++online === config.gatewayProcesses && r());
  });
  const shutdown = () => {
    shuttingDown = true;
    for (const w of workers.values()) w.kill();
    cluster.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return cluster;
}

/** Gateway process. */
async function startGatewayProcess(config) {
  const backend = ipcBackend();
  process.on('disconnect', () => process.exit(0)); // the core went away: do not linger holding the port
  const gw = new Gateway(process.env.GATEWAY_ID, backend, config);
  backend.on('restart', () => gw.restart());
  const edge = createEdge({ config, api: backend, gateways: [gw] });
  await edge.listen(config.port);
  setInterval(() => {
    const mem = process.memoryUsage();
    backend.send({ t: 'info', info: { ...gw.info(), pid: process.pid, rssMB: Math.round(mem.rss / 1048576), cpu: process.cpuUsage() } });
  }, 1000);
}

if (nodeCluster.isWorker) {
  await startGatewayProcess(defaults);
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = defaults;
  let cluster;
  let port = config.port;
  if (config.gatewayProcesses > 0) cluster = await startCore(config);
  else {
    ({ cluster, port } = await startServer(config));
    process.on('SIGINT', () => process.exit(0));
  }
  const topo = config.gatewayProcesses > 0 ? `${config.gatewayProcesses} gateway processes` : `${config.gateways} in-process gateways`;
  console.log(`\n  Listen Together PoC running at  http://localhost:${port}`);
  console.log(`  ${cluster.nodes.length} room nodes, ${topo}, lease TTL ${config.leaseTtlMs} ms`);
  console.log(`  Metrics: http://localhost:${port}/metrics\n`);
}
