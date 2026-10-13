"""Proof of concept: can a room of 5,000 listeners stay within ~200 ms using anchors + clock sync?

Model (all assumptions are stated, this is a simulation and NOT a measurement):
  * Each listener has a round-trip time drawn from a log-normal distribution (median 80 ms, p95 ~ 270 ms).
  * The uplink share of the round trip is uneven: uniform 35%..65% (asymmetric routes, mobile networks).
  * The client estimates the server clock by NTP-style pings: 8 samples, keep the one with the smallest RTT.
    Each sample has extra queuing jitter (exponential, mean 8% of the RTT, applied to each direction).
  * Output latency (Bluetooth etc.) is compensated by the client; we model a residual error of +/- 15 ms.
  * "Sync error" = |when this listener plays a position - when the ideal listener plays it|.
"""
import numpy as np
rng = np.random.default_rng(7)
N = 5000
rtt = rng.lognormal(mean=np.log(0.080), sigma=0.72, size=N)           # seconds
asym = rng.uniform(0.35, 0.65, size=N)                                 # uplink share of RTT
def estimate_error(i):
    best = None
    for _ in range(8):
        up = rtt[i] * asym[i] + rng.exponential(0.08 * rtt[i] * asym[i])
        dn = rtt[i] * (1 - asym[i]) + rng.exponential(0.08 * rtt[i] * (1 - asym[i]))
        sample_rtt = up + dn
        err = (up - dn) / 2          # offset estimate = true offset + (up - dn)/2
        if best is None or sample_rtt < best[0]: best = (sample_rtt, err)
    return best[1]
clock_err = np.array([estimate_error(i) for i in range(N)])
residual_out = rng.normal(0, 0.015, size=N)
err = np.abs(clock_err + residual_out) * 1000   # ms
def pct(a, p): return float(np.percentile(a, p))
print("Listeners:", N)
print("RTT ms         p50 %.0f  p95 %.0f  p99 %.0f" % (pct(rtt*1000,50), pct(rtt*1000,95), pct(rtt*1000,99)))
print("Sync error ms  p50 %.0f  p95 %.0f  p99 %.0f  max %.0f" % (pct(err,50), pct(err,95), pct(err,99), err.max()))
print("Within 100 ms: %.1f%%   within 200 ms: %.1f%%   within 500 ms: %.1f%%" % tuple(100*np.mean(err < t) for t in (100, 200, 500)))
# Without clock sync at all (devices differ by up to +/- 2 s, plus one-way delay): error is dominated by the clock difference
naive = np.abs(rng.uniform(-2, 2, size=N)) * 1000
print("No clock sync (device clocks +/-2 s): p50 %.0f ms  p95 %.0f ms" % (pct(naive,50), pct(naive,95)))
# Naive 'apply on arrival' pause/seek without an anchor: error = spread of one-way delays
one_way = rtt * (1 - asym) + rng.exponential(0.04, size=N)
spread = np.abs(one_way - np.median(one_way)) * 1000
print("Apply-on-arrival (no anchor), spread vs median listener: p50 %.0f ms  p95 %.0f ms  p99 %.0f ms" % (pct(spread,50), pct(spread,95), pct(spread,99)))
# Drift: crystals differ by up to ~50 ppm; without correction the error after a 4-minute track
drift = np.abs(rng.normal(0, 25e-6, size=N)) * 240 * 1000
print("Uncorrected audio-clock drift after a 4 min track: p50 %.0f ms  p95 %.0f ms  max %.0f ms" % (pct(drift,50), pct(drift,95), drift.max()))
