// WebSocket wrapper: automatic reconnect with backoff, and clock sync with the server.
export class Net {
  constructor({ onOpen, onClose, onMessage }) {
    this.h = { onOpen, onClose, onMessage };
    this.ws = null;
    this.retry = 0;
    this.offset = 0; // serverTime - localTime, in ms
    this.rtt = null;
    this.stopped = false;
  }
  connect() {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.ping();
      this.h.onOpen();
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') {
        this.rtt = Date.now() - m.ts;
        this.offset = m.now + this.rtt / 2 - Date.now();
        return;
      }
      this.h.onMessage(m);
    };
    ws.onclose = (e) => {
      clearInterval(this.pinger);
      // 4000: this seat was taken over by the same player in another tab. Reconnecting would just
      // take it back and start a tug of war, so stop here.
      if (e.code === 4000) this.stopped = true;
      this.h.onClose(e.code);
      if (this.stopped) return;
      const delay = Math.min(3000, 300 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
    clearInterval(this.pinger);
    this.pinger = setInterval(() => this.ping(), 4000);
  }
  ping() { this.send({ t: 'ping', ts: Date.now() }); }
  get open() { return this.ws && this.ws.readyState === 1; }
  send(o) { if (this.open) this.ws.send(JSON.stringify(o)); }
  now() { return Date.now() + this.offset; }
}
