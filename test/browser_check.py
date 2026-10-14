"""End-to-end browser check: three separate Chromium browsers play a full game.

It verifies, in real browsers, that:
  - a room is created and joined through its shareable link
  - the drawing (pen, brush size, fill, undo) is pixel-identical on all three canvases
  - a near miss shows "close!" only to the guesser
  - a page refresh rejoins the same seat and restores the canvas
  - the turn ends early when everyone has guessed
  - the game reaches the results screen and the replay plays

Run (server in one terminal, this in another):
    PERSIST=0 npm start
    pip install playwright && playwright install chromium
    BASE_URL=http://localhost:4100 python3 test/browser_check.py
"""
import json, time, sys
from playwright.sync_api import sync_playwright

import os
BASE = os.environ.get("BASE_URL", "http://localhost:4100")
SHOTS = os.environ.get("SHOTS_DIR", "docs")
HASH_JS = """() => { const c=document.getElementById('board'); const d=c.getContext('2d').getImageData(0,0,800,600).data;
  let h=2166136261>>>0; for(let i=0;i<d.length;i+=4){ h^=d[i]; h=Math.imul(h,16777619)>>>0; h^=d[i+1]; h=Math.imul(h,16777619)>>>0; h^=d[i+2]; h=Math.imul(h,16777619)>>>0;} return h; }"""
errors = []

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        pages = {}
        def mk(name):
            ctx = b.new_context(viewport={"width": 1280, "height": 800}, bypass_csp=True)
            pg = ctx.new_page()
            pg.on("pageerror", lambda e: errors.append((name, str(e))))
            pg.on("console", lambda m: errors.append((name, m.text)) if m.type == "error" else None)
            pages[name] = (ctx, pg)
            return pg
        A = mk("Alice")
        A.goto(BASE)
        A.fill("#homeName", "Alice")
        A.select_option("#setRounds", "1")
        A.select_option("#setTime", "20")
        A.fill("#setWords", "zebra, xylophone, quartz")
        A.click("#btnCreate")
        A.wait_for_selector("#lbStart", timeout=5000)
        link = A.input_value(".invite input")
        print("invite link:", link)
        for n in ("Bob", "Cy"):
            pg = mk(n)
            pg.goto(link)
            pg.fill("#homeName", n)
            pg.click("#btnJoin")
            pg.wait_for_selector("#room:not([hidden])", timeout=5000)
        A.wait_for_function("document.querySelectorAll('.player').length === 3")
        A.screenshot(path=f"{SHOTS}/shot_lobby.png")
        A.click("#lbStart")
        # find the drawer: the page showing word buttons
        time.sleep(0.8)
        drawer = None
        for n, (c, pg) in pages.items():
            if pg.locator(".wordbtns button").count() == 3:
                drawer = n
        print("drawer:", drawer)
        dpg = pages[drawer][1]
        dpg.screenshot(path=f"{SHOTS}/shot_choose.png")
        dpg.click(".wordbtns button >> nth=0")
        dpg.wait_for_function("window.__scribble.S.view.phase === 'drawing'")
        word = dpg.evaluate("window.__scribble.S.view.word")
        print("word:", word)
        # draw: a red curve, a blue line with a bigger brush, a fill, then an undo and another stroke
        box = dpg.locator("#board").bounding_box()
        def pt(fx, fy): return (box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
        dpg.click(".swatch[data-color='#c1121f']")
        x, y = pt(0.2, 0.3); dpg.mouse.move(x, y); dpg.mouse.down()
        for i in range(1, 30):
            x, y = pt(0.2 + i * 0.012, 0.3 + (0.1 if i % 6 < 3 else -0.1) * 0.5); dpg.mouse.move(x, y)
        dpg.mouse.up()
        dpg.click(".swatch[data-color='#0077b6']"); dpg.click(".size[data-size='12']")
        x, y = pt(0.3, 0.7); dpg.mouse.move(x, y); dpg.mouse.down()
        x, y = pt(0.75, 0.75); dpg.mouse.move(x, y, steps=25); dpg.mouse.up()
        # closed shape then fill it
        dpg.click(".size[data-size='6']"); dpg.click(".swatch[data-color='#000000']")
        x, y = pt(0.55, 0.15); dpg.mouse.move(x, y); dpg.mouse.down()
        for fx, fy in [(0.8, 0.15), (0.8, 0.4), (0.55, 0.4), (0.55, 0.15)]:
            x, y = pt(fx, fy); dpg.mouse.move(x, y, steps=6)
        dpg.mouse.up()
        dpg.click(".tool[data-tool='fill']"); dpg.click(".swatch[data-color='#ffd60a']")
        x, y = pt(0.67, 0.28); dpg.mouse.click(x, y)
        dpg.click(".tool[data-tool='pen']"); dpg.click(".swatch[data-color='#06d6a0']")
        x, y = pt(0.1, 0.9); dpg.mouse.move(x, y); dpg.mouse.down(); x, y = pt(0.3, 0.95); dpg.mouse.move(x, y, steps=8); dpg.mouse.up()
        dpg.click("#btnUndo")     # removes the green stroke
        time.sleep(0.8)
        hashes = {n: pg.evaluate(HASH_JS) for n, (c, pg) in pages.items()}
        print("canvas hashes:", hashes)
        assert len(set(hashes.values())) == 1, "canvases differ between players!"
        print("OK: all three canvases are pixel-identical after pen, brush size, fill and undo")
        dpg.screenshot(path=f"{SHOTS}/shot_drawing.png")
        others = [n for n in pages if n != drawer]
        pages[others[0]][1].screenshot(path=f"{SHOTS}/shot_guesser.png")
        # a guesser makes a near miss then the right guess
        g1 = pages[others[0]][1]; g2 = pages[others[1]][1]
        g1.fill("#chatInput", word[:-1]); g1.press("#chatInput", "Enter")
        g1.wait_for_selector(".msg.close", timeout=3000)
        print("OK: near miss showed 'close!' to the guesser")
        assert g2.locator(".msg.close").count() == 0
        g1.fill("#chatInput", word); g1.press("#chatInput", "Enter")
        g1.wait_for_function("window.__scribble.S.view.word === '%s'" % word)
        # refresh the second guesser mid-round: must rejoin with canvas and be the same player
        before = g2.evaluate("window.__scribble.S.me")
        g2.reload()
        g2.wait_for_function("window.__scribble.S.inRoom === true", timeout=8000)
        after = g2.evaluate("window.__scribble.S.me")
        assert before == after, "refresh should keep the same seat"
        time.sleep(0.5)
        h2 = g2.evaluate(HASH_JS)
        assert h2 == hashes[drawer], "canvas after refresh differs"
        print("OK: a refresh rejoined the same seat and restored the canvas")
        g2.fill("#chatInput", word); g2.press("#chatInput", "Enter")
        g1.wait_for_selector("#overlay .bigword", timeout=6000)
        g1.screenshot(path=f"{SHOTS}/shot_turnend.png")
        print("OK: turn ended early when everyone guessed")
        # the rest of the game: second drawer picks and everyone else guesses
        def find_drawer(timeout=10):
            end = time.time() + timeout
            while time.time() < end:
                for n, (c, pg) in pages.items():
                    if pg.locator(".wordbtns button").count() == 3: return n
                time.sleep(0.3)
            return None
        for t in range(1):
            nd = find_drawer()
            print("next drawer:", nd)
            pg = pages[nd][1]; pg.click(".wordbtns button >> nth=1")
            pg.wait_for_function("window.__scribble.S.view.phase === 'drawing'")
            w = pg.evaluate("window.__scribble.S.view.word")
            box = pg.locator("#board").bounding_box()
            pg.mouse.move(box["x"] + 100, box["y"] + 100); pg.mouse.down(); pg.mouse.move(box["x"] + 300, box["y"] + 250, steps=12); pg.mouse.up()
            for n2 in pages:
                if n2 != nd:
                    q = pages[n2][1]; q.fill("#chatInput", w); q.press("#chatInput", "Enter")
            time.sleep(1.5)
        # third drawer
        nd = find_drawer()
        pg = pages[nd][1]; pg.click(".wordbtns button >> nth=2")
        pg.wait_for_function("window.__scribble.S.view.phase === 'drawing'")
        w = pg.evaluate("window.__scribble.S.view.word")
        box = pg.locator("#board").bounding_box()
        pg.mouse.move(box["x"] + 200, box["y"] + 400); pg.mouse.down(); pg.mouse.move(box["x"] + 500, box["y"] + 300, steps=12); pg.mouse.up()
        for n2 in pages:
            if n2 != nd:
                q = pages[n2][1]; q.fill("#chatInput", w); q.press("#chatInput", "Enter")
        A.wait_for_selector("#overlay .rank", timeout=15000)
        A.screenshot(path=f"{SHOTS}/shot_gameend.png")
        print("OK: game reached the final results screen")
        A.click("text=Watch the replay")
        A.wait_for_selector("#replayModal:not([hidden])", timeout=5000)
        time.sleep(2.0)
        A.screenshot(path=f"{SHOTS}/shot_replay.png")
        label = A.inner_text("#replayLabel")
        print("replay label:", label)
        # a second tab in the same browser joins as a new player instead of taking over the first tab's seat
        A2 = pages["Alice"][0].new_page()
        A2.goto(link)
        assert A2.input_value("#homeName") == "", "a new tab must ask for a name, not reuse another player's"
        A2.fill("#homeName", "Alice")
        A2.click("#btnJoin")
        A2.wait_for_function("window.__scribble.S.inRoom === true", timeout=5000)
        assert A2.evaluate("window.__scribble.S.me") != A.evaluate("window.__scribble.S.me"), "second tab must be a new player"
        time.sleep(0.5)
        assert A.evaluate("window.__scribble.S.inRoom") is True, "first tab must stay in the room"
        print("OK: a second tab in the same browser joined as its own player")
        print("console/page errors:", errors if errors else "none")
        assert not errors, "browser errors"
        b.close()
main()
