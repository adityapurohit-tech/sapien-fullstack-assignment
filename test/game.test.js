import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, Bot, makeRoom, startAndPick, sleep, tmpFile } from './helpers.js';

const server = new TestServer();
before(async () => { await server.start(); });
after(async () => { await server.stop(); });

const closeAll = (bots) => bots.forEach((b) => b.close());

test('the secret word is never sent to players who are still guessing', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy']);
  const marks = bots.map((b) => b.mark());
  const { drawer, guessers, word } = await startAndPick(bots, 'xylophone');
  assert.equal(word, 'xylophone');
  // The drawer sees the word; everyone else only sees blanks.
  const dView = drawer.view;
  assert.equal(dView.word, 'xylophone');
  for (const g of guessers) {
    const mine = g.messages.slice(marks[bots.indexOf(g)]);
    assert.ok(mine.length > 0);
    // Choices went only to the drawer: the other two words must not appear in any guesser message either.
    for (const m of mine) {
      const s = JSON.stringify(m).toLowerCase();
      assert.ok(!s.includes('xylophone'), `leaked the word in ${s.slice(0, 120)}`);
      assert.ok(!s.includes('zebra') && !s.includes('quartz'), 'leaked a word choice');
    }
    assert.equal(g.view.hint, '_________');
    assert.equal(g.view.word, undefined);
  }
  closeAll(bots);
});

test('faster correct guesses earn more points, and the server alone awards them', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy'], { rounds: 1, drawTime: 8, words: ['zebra', 'xylophone', 'quartz'] });
  const { guessers, word } = await startAndPick(bots, 0);
  const [fast, slow] = guessers;
  fast.send({ t: 'chat', text: word });
  const r1 = await fast.waitFor((m) => m.t === 'secret');
  await sleep(1800);
  slow.send({ t: 'chat', text: word.toUpperCase() }); // case-insensitive
  const r2 = await slow.waitFor((m) => m.t === 'secret');
  assert.ok(r1.pts > r2.pts, `fast ${r1.pts} should beat slow ${r2.pts}`);
  assert.ok(r1.pts <= 500 && r2.pts >= 100);
  // A client cannot hand itself points or fake server messages.
  const before = fast.score();
  fast.send({ t: 'score', pts: 99999 });
  fast.send({ t: 'secret', word: 'x', pts: 99999 });
  fast.send({ t: 'players', players: [] });
  await sleep(150);
  assert.equal(fast.score(), before);
  closeAll(bots);
});

test('only the drawer can draw, and non-drawers never receive strokes they sent', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy']);
  const { drawer, guessers } = await startAndPick(bots, 0);
  const m = guessers.map((b) => b.mark());
  guessers[0].send({ t: 'ds', id: 'cheat1', tool: 'pen', color: '#ff0000', size: 5, x: 10, y: 10 });
  await sleep(150);
  assert.equal(guessers[1].find((x) => x.t === 'op', m[1]), null);
  assert.equal(drawer.find((x) => x.t === 'op'), null);
  closeAll(bots);
});

test('a near miss shows "close!" only to the person who guessed', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy']);
  const { guessers } = await startAndPick(bots, 'xylophone');
  const [a, b] = guessers;
  const mb = b.mark();
  a.send({ t: 'chat', text: 'xylophon' });
  const close = await a.waitFor((m) => m.t === 'chat' && m.kind === 'close');
  assert.equal(close.text, 'close!');
  await sleep(150);
  assert.equal(b.find((m) => m.kind === 'close', mb), null);
  closeAll(bots);
});

test('players who guessed right cannot reveal the word in chat', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy', 'Di'], { rounds: 1, drawTime: 8, words: ['zebra', 'xylophone', 'quartz'] });
  const { drawer, guessers, word } = await startAndPick(bots, 0);
  const [a, b, c] = guessers;
  a.send({ t: 'chat', text: word });
  await a.waitFor((m) => m.t === 'secret');
  const mb = b.mark(), mc = c.mark(), md = drawer.mark(), ma = a.mark();
  a.send({ t: 'chat', text: `it is ${word}!!` });          // blocked
  a.send({ t: 'chat', text: 'nice drawing' });             // goes to the private channel only
  await sleep(250);
  assert.ok(a.find((m) => m.t === 'notice', ma), 'sender is told off');
  assert.equal(b.find((m) => m.t === 'chat' && /nice drawing|zebra/i.test(m.text || ''), mb), null, 'still-guessing player sees nothing');
  assert.equal(c.find((m) => m.t === 'chat' && /nice drawing/i.test(m.text || ''), mc), null, 'the other guesser sees nothing either');
  assert.ok(drawer.find((m) => m.kind === 'guessed' && m.text === 'nice drawing', md), 'drawer sees the private chat');
  closeAll(bots);
});

test('a player who joins mid-round sees the canvas as it stands', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben']);
  const { drawer } = await startAndPick(bots, 0);
  drawer.send({ t: 'ds', id: 'a1', tool: 'pen', color: '#112233', size: 6, x: 10, y: 20 });
  drawer.send({ t: 'dp', id: 'a1', pts: [30, 40, 50, 60] });
  drawer.send({ t: 'de', id: 'a1' });
  drawer.send({ t: 'fill', x: 400, y: 300, color: '#00ff00' });
  await sleep(200);
  const late = await new Bot(server.url, 'Late').connect();
  late.send({ t: 'join', code: bots[0].code, name: 'Late' });
  const joined = await late.waitFor((m) => m.t === 'joined');
  assert.equal(joined.view.phase, 'drawing');
  const acts = joined.view.canvas.actions;
  assert.equal(acts.length, 2);
  assert.deepEqual(acts[0].pts, [10, 20, 30, 40, 50, 60]);
  assert.equal(acts[1].k, 'f');
  assert.equal(joined.view.canvas.seq, 4);
  closeAll([...bots, late]);
});

test('a refresh within the grace period keeps the score; waiting too long forfeits the seat', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy'], { rounds: 1, drawTime: 20, words: ['zebra', 'xylophone', 'quartz'] });
  const { guessers, word } = await startAndPick(bots, 0);
  const [a, b] = guessers;
  a.send({ t: 'chat', text: word });
  const { pts } = await a.waitFor((m) => m.t === 'secret');
  const token = a.token, id = a.me;
  a.ws.terminate();
  await sleep(300);
  const back = await new Bot(server.url, 'Ann').connect();
  back.send({ t: 'join', code: bots[0].code, name: 'Ann', token });
  const j = await back.waitFor((m) => m.t === 'joined');
  assert.equal(j.you.id, id, 'same seat');
  assert.equal(j.view.players.find((p) => p.id === id).score, pts, 'score kept');
  assert.equal(j.view.word, word, 'a player who already guessed gets the word back');
  // Now drop again and stay away longer than the grace period.
  back.ws.terminate();
  await sleep(1900);
  const roster = await b.waitFor((m) => m.t === 'players' && !m.players.some((p) => p.id === id), { timeout: 1500 });
  assert.ok(roster);
  closeAll(bots);
});

test('if the drawer leaves mid-turn the game moves on instead of getting stuck', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy'], { rounds: 2, drawTime: 30, words: ['zebra', 'xylophone', 'quartz'] });
  const { drawer, guessers } = await startAndPick(bots, 0);
  const m = guessers.map((g) => g.mark());
  drawer.send({ t: 'leave' });
  const next = await guessers[0].waitFor((s) => s.t === 'state' && s.view.phase === 'choosing' && s.view.drawerId !== drawer.me, { since: m[0], timeout: 4000 });
  assert.notEqual(next.view.drawerId, drawer.me);
  closeAll(bots);
});

test('if the drawer simply drops, the turn ends after a short grace period', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy'], { rounds: 2, drawTime: 30, words: ['zebra', 'xylophone', 'quartz'] });
  const { drawer, guessers } = await startAndPick(bots, 0);
  const m = guessers.map((g) => g.mark());
  drawer.ws.terminate();
  const ended = await guessers[0].waitFor((s) => s.t === 'state' && s.view.phase === 'turn_end', { since: m[0], timeout: 3000 });
  assert.equal(ended.view.lastTurn.reason, 'drawer_left');
  await guessers[0].waitFor((s) => s.t === 'state' && s.view.phase === 'choosing', { since: m[0], timeout: 3000 });
  closeAll(bots);
});

test('the turn ends early once everyone has guessed', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy'], { rounds: 1, drawTime: 60, words: ['zebra', 'xylophone', 'quartz'] });
  const { guessers, word } = await startAndPick(bots, 0);
  const t0 = Date.now();
  for (const g of guessers) g.send({ t: 'chat', text: word });
  const end = await guessers[0].waitFor((s) => s.t === 'state' && s.view.phase === 'turn_end', { timeout: 3000 });
  assert.ok(Date.now() - t0 < 2500);
  assert.equal(end.view.lastTurn.reason, 'all_guessed');
  assert.equal(end.view.lastTurn.word, word);
  closeAll(bots);
});

test('abuse protection: chat flooding, oversized messages and bad strokes are dropped', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy']);
  const { drawer, guessers } = await startAndPick(bots, 0);
  const [spammer, watcher] = guessers;
  const mw = watcher.mark();
  for (let i = 0; i < 40; i++) spammer.send({ t: 'chat', text: 'spam ' + i });
  await sleep(300);
  const received = watcher.filter((m) => m.t === 'chat' && /^spam/.test(m.text || ''), mw).length;
  assert.ok(received <= 6, `rate limit let ${received} of 40 chats through`);
  assert.ok(spammer.find((m) => m.t === 'notice' && /too fast/.test(m.text)), 'spammer is told to slow down');
  // Oversized chat message (over 2 KB) is rejected before it is parsed into the room.
  const mw2 = watcher.mark();
  spammer.send({ t: 'chat', text: 'x'.repeat(5000) });
  await sleep(150);
  assert.equal(watcher.find((m) => m.t === 'chat' && m.text && m.text.startsWith('xxxx'), mw2), null);
  // A drawer cannot send oversized or out-of-range strokes.
  const md = watcher.mark();
  drawer.send({ t: 'ds', id: 's1', tool: 'pen', color: '#000000', size: 5, x: 1, y: 1 });
  await sleep(100);
  drawer.send({ t: 'dp', id: 's1', pts: Array.from({ length: 400 }, (_, i) => i % 800) }); // 200 points in one message
  drawer.send({ t: 'dp', id: 's1', pts: [99999, 5] });                                      // outside the canvas
  drawer.send({ t: 'ds', id: 's2', tool: 'pen', color: 'red', size: 5, x: 1, y: 1 });       // not a hex colour
  drawer.send({ t: 'ds', id: 's3', tool: 'pen', color: '#000000', size: 9999, x: 1, y: 1 });// absurd brush size
  await sleep(250);
  const ops = watcher.filter((m) => m.t === 'op', md);
  assert.equal(ops.length, 1, 'only the one valid stroke start was relayed');
  assert.equal(ops[0].op.o, 'ds');
  closeAll(bots);
});

test('a full game produces a stroke-by-stroke replay of every drawing', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben'], { rounds: 1, drawTime: 20, words: ['zebra', 'xylophone', 'quartz'] });
  const [host] = bots;
  host.send({ t: 'start' });
  // Play two turns: whoever is drawing picks, draws a stroke, and the other player guesses.
  for (let turn = 0; turn < 2; turn++) {
    const drawerBot = await Promise.race(bots.map((b) => b.waitFor((m) => m.t === 'state' && m.view.phase === 'choosing' && m.view.choices && m.view.drawerId === b.me && m.view.round === 1, { timeout: 6000, since: b.messages.length > 0 ? Math.max(0, b.messages.length - 1) : 0 }).then(() => b)));
    const word = drawerBot.view.choices[0];
    drawerBot.send({ t: 'pick', index: 0 });
    await sleep(120);
    drawerBot.send({ t: 'ds', id: 't' + turn, tool: 'pen', color: '#000000', size: 4, x: 5, y: 5 });
    drawerBot.send({ t: 'dp', id: 't' + turn, pts: [10, 10, 20, 20] });
    drawerBot.send({ t: 'de', id: 't' + turn });
    await sleep(100);
    const guesser = bots.find((b) => b !== drawerBot);
    guesser.send({ t: 'chat', text: word });
    await guesser.waitFor((m) => m.t === 'state' && m.view.phase === 'turn_end' && m.view.word === word, { timeout: 4000, since: guesser.messages.length - 1 > 0 ? 0 : 0 });
    await sleep(400);
  }
  const end = await host.waitFor((m) => m.t === 'state' && m.view.phase === 'game_end', { timeout: 6000 });
  assert.equal(end.view.ranking.length, 2);
  assert.equal(end.view.hasReplay, true);
  host.send({ t: 'get_replay' });
  const replay = await host.waitFor((m) => m.t === 'replay');
  assert.equal(replay.turns.length, 2);
  for (const t of replay.turns) {
    assert.ok(t.word && t.drawerName);
    assert.ok(t.log.some((e) => e.o === 'ds') && t.log.some((e) => e.o === 'dp'));
  }
  closeAll(bots);
});

test('the host settings (rounds, draw time, word list) are applied and validated', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben'], { rounds: 99, drawTime: 1, words: ['alpha', 'beta', 'gamma', 'bad<script>', 'x'] });
  const v = bots[0].view;
  assert.equal(v.rounds, 10, 'rounds are clamped to 10');
  assert.equal(v.drawTime, 2, 'draw time is clamped to the minimum');
  // Angle brackets are stripped, so "bad<script>" survives only as the harmless word "badscript"; too-short words are dropped.
  assert.deepEqual(v.words, ['alpha', 'beta', 'gamma', 'badscript']);
  assert.ok(!v.words.some((w) => /[<>]/.test(w)));
  // Only the host may change settings, and only in the lobby.
  bots[1].send({ t: 'settings', rounds: 2 });
  await sleep(150);
  assert.equal(bots[0].view.rounds, 10);
  bots[0].send({ t: 'settings', rounds: 4, drawTime: 45, words: 'cat, dog, fish' });
  const upd = await bots[1].waitFor((m) => m.t === 'state' && m.view.rounds === 4);
  assert.equal(upd.view.drawTime, 45);
  closeAll(bots);
});

test('the turn also ends early when the last player still guessing leaves', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy', 'Dee'], { rounds: 1, drawTime: 60, words: ['zebra', 'xylophone', 'quartz'] });
  const { guessers, word } = await startAndPick(bots, 0);
  const [a, b, c] = guessers;
  a.send({ t: 'chat', text: word });
  b.send({ t: 'chat', text: word });
  await b.waitFor((m) => m.t === 'secret');
  const m = a.mark();
  c.send({ t: 'leave' });
  const end = await a.waitFor((s) => s.t === 'state' && s.view.phase === 'turn_end', { since: m, timeout: 2000 });
  assert.equal(end.view.lastTurn.reason, 'all_guessed');
  closeAll(bots);
});

test('a guesser who refreshes does not cut the turn short for everyone', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy'], { rounds: 1, drawTime: 60, words: ['zebra', 'xylophone', 'quartz'] });
  const { guessers, word } = await startAndPick(bots, 0);
  const [a, b] = guessers;
  a.send({ t: 'chat', text: word });
  await a.waitFor((m) => m.t === 'secret');
  const m = a.mark();
  b.ws.terminate(); // b drops while still guessing, as a page refresh does
  await sleep(800);
  assert.equal(a.find((s) => s.t === 'state' && s.view.phase === 'turn_end', m), null, 'the turn must keep going');
  closeAll(bots);
});

test('if the host drops in the lobby, another player becomes host and can start', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben', 'Cy']);
  const [host, b] = bots;
  const m = b.mark();
  host.ws.terminate();
  const st = await b.waitFor((s) => s.t === 'state' && s.view.hostId === b.me, { since: m, timeout: 2000 });
  assert.equal(st.view.phase, 'lobby');
  b.send({ t: 'start' });
  await b.waitFor((s) => s.t === 'state' && s.view.phase === 'choosing', { since: m, timeout: 2000 });
  closeAll(bots);
});

test('a drawer whose operation is refused gets the server canvas back, so it never drifts', async () => {
  const bots = await makeRoom(server, ['Ann', 'Ben']);
  const { drawer } = await startAndPick(bots, 0);
  drawer.send({ t: 'ds', id: 'k1', tool: 'pen', color: '#000000', size: 5, x: 10, y: 10 });
  drawer.send({ t: 'de', id: 'k1' });
  const m = drawer.mark();
  // Flood far past the drawing rate limit, as a stuck key or a modified client would.
  for (let i = 0; i < 400; i++) drawer.send({ t: 'undo' });
  const snap = await drawer.waitFor((x) => x.t === 'canvas', { since: m, timeout: 2000 });
  assert.ok(Array.isArray(snap.actions));
  closeAll(bots);
});

test('room links resolve and a missing room returns a clear error', async () => {
  const bots = await makeRoom(server, ['Ann']);
  const ok = await fetch(`${server.http}/api/rooms/${bots[0].code}`);
  assert.equal(ok.status, 200);
  const html = await fetch(`${server.http}/r/${bots[0].code}`);
  assert.equal(html.status, 200);
  const missing = new Bot(server.url, 'X'); await missing.connect();
  missing.send({ t: 'join', code: 'ZZZZZZ', name: 'X' });
  const err = await missing.waitFor((m) => m.t === 'error');
  assert.equal(err.code, 'no_room');
  closeAll([...bots, missing]);
});

test('a server restart keeps rooms, scores and the canvas; clients rejoin with their token', async () => {
  const file = tmpFile('state.json');
  const s2 = new TestServer({ PERSIST: '1', DATA_FILE: file, GRACE_MS: '10000', DRAWER_GRACE_MS: '10000' });
  await s2.start();
  const bots = await makeRoom(s2, ['Ann', 'Ben', 'Cy'], { rounds: 1, drawTime: 60, words: ['zebra', 'xylophone', 'quartz'] });
  const { drawer, guessers, word } = await startAndPick(bots, 0);
  drawer.send({ t: 'ds', id: 'r1', tool: 'pen', color: '#abcdef', size: 8, x: 100, y: 100 });
  drawer.send({ t: 'dp', id: 'r1', pts: [120, 120, 140, 130] });
  drawer.send({ t: 'de', id: 'r1' });
  guessers[0].send({ t: 'chat', text: word });
  const { pts } = await guessers[0].waitFor((m) => m.t === 'secret');
  const tokens = bots.map((b) => ({ name: b.name, token: b.token, id: b.me }));
  const code = bots[0].code;
  await sleep(300);
  await s2.stop('SIGTERM'); // graceful: writes a final snapshot
  await sleep(300);
  await s2.start();         // same port, same data file
  const rejoined = [];
  for (const t of tokens) {
    const b = await new Bot(s2.url, t.name).connect();
    b.send({ t: 'join', code, name: t.name, token: t.token });
    const j = await b.waitFor((m) => m.t === 'joined');
    assert.equal(j.you.id, t.id, 'same seat after restart');
    rejoined.push(j);
  }
  const jd = rejoined.find((j) => j.you.id === drawer.me);
  assert.equal(jd.view.phase, 'drawing');
  assert.equal(jd.view.word, word);
  assert.deepEqual(jd.view.canvas.actions[0].pts, [100, 100, 120, 120, 140, 130], 'canvas restored');
  const gj = rejoined.find((j) => j.you.id === guessers[0].me);
  assert.equal(gj.view.players.find((p) => p.id === guessers[0].me).score, pts, 'score restored');
  assert.ok(jd.view.endsAt > Date.now(), 'the turn clock resumed');
  await s2.stop();
});
