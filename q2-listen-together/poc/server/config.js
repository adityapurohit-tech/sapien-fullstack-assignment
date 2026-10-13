const num = (name, def) => (process.env[name] !== undefined ? Number(process.env[name]) : def);

export const defaults = {
  port: num('PORT', 3000),
  roomNodes: num('ROOM_NODES', 3), // Room Service nodes (in-process, each with its own actors)
  gatewayProcesses: num('GATEWAY_PROCESSES', 2), // gateways as separate OS processes sharing the port (0 = single process)
  gateways: num('GATEWAYS', 2), // in single-process mode: in-process gateways, sockets spread round-robin
  leaseTtlMs: num('LEASE_TTL_MS', 5000), // ownership lease, as in the design doc
  leaseRenewMs: num('LEASE_RENEW_MS', 1500),
  supervisorMs: num('SUPERVISOR_MS', 500), // how often orphaned rooms are re-placed
  startLeadMs: num('START_LEAD_MS', 400), // skip/seek/next track start at now + lead
  resumeLeadMs: num('RESUME_LEAD_MS', 250), // resume after pause: audio is buffered, shorter lead
  heartbeatMs: num('HEARTBEAT_MS', 5000), // owner re-publishes the anchor; repairs missed messages
  presenceFlushMs: num('PRESENCE_FLUSH_MS', 1000), // soft state (members, votes) is coalesced
  gatewayReportMs: num('GATEWAY_REPORT_MS', 250), // gateways batch local joins/votes to the owner
  hostGraceMs: num('HOST_GRACE_MS', 30000), // host may drop this long before the role moves
  commandTimeoutMs: num('COMMAND_TIMEOUT_MS', 1000), // one attempt gateway -> owner
  commandDeadlineMs: num('COMMAND_DEADLINE_MS', 8000), // total retry budget for one command
  maxPayloadBytes: num('MAX_PAYLOAD_BYTES', 4096),
  maxQueue: num('MAX_QUEUE', 100),
  joinRatePerSec: num('JOIN_RATE_PER_SEC', 500), // per room, jittered retry beyond this
  cmdRatePerSec: num('CMD_RATE_PER_SEC', 10), // per socket
  admin: process.env.ADMIN !== '0', // chaos endpoints (crash / freeze / restart)
  quiet: process.env.QUIET === '1',
};
