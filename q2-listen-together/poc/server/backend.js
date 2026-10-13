// How a gateway reaches the core. Two implementations of one interface:
//   localBackend - same process, direct calls (used by tests and GATEWAY_PROCESSES=0)
//   ipcBackend   - gateway in its own OS process; RPC and bus deliveries over the cluster IPC channel.
// The IPC channel plays the role of the network + pub/sub bus between gateways and the Room Service.

export function localBackend(api, bus) {
  return {
    ...api,
    subscribe: (t, fn) => bus.subscribe(t, (payload, msg) => fn(payload, msg)),
  };
}

/** Runs inside a gateway worker process. */
export function ipcBackend() {
  let seq = 0;
  const pending = new Map();
  const subs = new Map(); // topic -> Set(fn)
  const handlers = new Map();

  process.on('message', (m) => {
    if (m.t === 'rpc:res') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      else p.resolve(m.result);
    } else if (m.t === 'bus') {
      const fns = subs.get(m.topic);
      if (!fns) return;
      const msg = JSON.parse(m.payload);
      for (const fn of fns) fn(m.payload, msg);
    } else if (handlers.has(m.t)) {
      handlers.get(m.t)(m);
    }
  });

  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      process.send({ t: 'rpc', id, method, args });
    });
  const fire = (method, ...args) => process.send({ t: 'rpc', id: 0, method, args });

  const api = new Proxy(
    {},
    {
      get: (_, method) => {
        if (method === 'subscribe') {
          return (t, fn) => {
            if (!subs.has(t)) {
              subs.set(t, new Set());
              process.send({ t: 'sub', topic: t });
            }
            subs.get(t).add(fn);
            return () => {
              const set = subs.get(t);
              set?.delete(fn);
              if (set && set.size === 0) {
                subs.delete(t);
                process.send({ t: 'unsub', topic: t });
              }
            };
          };
        }
        if (method === 'on') return (type, fn) => handlers.set(type, fn);
        if (method === 'send') return (m) => process.send(m);
        // fire-and-forget calls do not wait for a reply
        if (method === 'telemetry' || method === 'count' || method === 'log') return (...args) => fire(method, ...args);
        if (method === 'then') return undefined;
        return (...args) => call(method, ...args);
      },
    },
  );
  return api;
}

/** Runs in the core process: serves one gateway worker. */
export function serveIpc(worker, api, bus, onInfo) {
  const unsubs = new Map();
  worker.on('message', async (m) => {
    if (m.t === 'rpc') {
      try {
        const result = await api[m.method](...m.args);
        if (m.id) worker.send({ t: 'rpc:res', id: m.id, result });
      } catch (err) {
        if (m.id) worker.send({ t: 'rpc:res', id: m.id, error: { message: err.message, code: err.code } });
      }
    } else if (m.t === 'sub' && !unsubs.has(m.topic)) {
      unsubs.set(m.topic, bus.subscribe(m.topic, (payload) => worker.isConnected() && worker.send({ t: 'bus', topic: m.topic, payload })));
    } else if (m.t === 'unsub') {
      unsubs.get(m.topic)?.();
      unsubs.delete(m.topic);
    } else if (m.t === 'info') {
      onInfo(m.info);
    }
  });
  worker.on('exit', () => {
    for (const u of unsubs.values()) u();
    unsubs.clear();
  });
}
