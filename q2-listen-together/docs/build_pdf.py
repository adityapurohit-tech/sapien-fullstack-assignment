"""Builds Q2_Design_Doc.pdf from DESIGN.md (the single source of truth).

    python docs/build_pdf.py

Needs the `markdown` package and Chrome or Edge (used headless to print). Figures are left out of the
PDF because they ship as their own files (architecture_diagram.pdf, sequence_pause_5000.pdf).
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

import markdown

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "DESIGN.md")
OUT = os.path.join(HERE, "Q2_Design_Doc.pdf")

BROWSERS = [
    os.environ.get("BROWSER"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]

CSS = """
@page { size: A4; margin: 13mm 14mm 13mm 14mm; }
body { font: 9.6pt/1.38 "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; }
h1 { font-size: 17pt; margin: 0 0 2px; }
h1 + p { color: #555; font-size: 8.6pt; margin-top: 0; }
h2 { font-size: 11.6pt; color: #1f3a8a; margin: 11px 0 4px; break-after: avoid; }
p { margin: 4px 0; }
ul { margin: 3px 0; padding-left: 16px; }
li { margin: 2px 0; }
li > ul { margin: 1px 0; }
code { font: 8.4pt Consolas, monospace; background: #f1f3f6; padding: 0 2px; border-radius: 2px; }
table { border-collapse: collapse; width: 100%; margin: 5px 0 6px; font-size: 8.4pt; line-height: 1.3; }
th { background: #e6ebf5; text-align: left; }
th, td { border: 1px solid #c5ccd8; padding: 3px 5px; vertical-align: top; }
tr { break-inside: avoid; }
em { color: #0b5d3b; font-style: normal; font-weight: 600; }
strong { color: #111; }
"""

FIGURE = re.compile(r"^!\[.*\]\(.*\)\s*$", re.M)
NESTED_ITEM = re.compile(r"^  (- )", re.M)
LIST_AFTER_TEXT = re.compile(r"^((?![-\s|#]).+)\n(- )", re.M)


def main():
    md = open(SRC, encoding="utf8").read()
    md = FIGURE.sub("", md)  # figures ship separately
    # Python-Markdown is stricter than GitHub: nested lists need 4 spaces, and a list needs a blank line before it
    md = NESTED_ITEM.sub(lambda m: "    " + m.group(1), md)
    md = LIST_AFTER_TEXT.sub(lambda m: m.group(1) + "\n\n" + m.group(2), md)
    body = markdown.markdown(md, extensions=["tables", "sane_lists"])
    html = f"<!doctype html><html><head><meta charset='utf-8'><title>Q2 design doc</title><style>{CSS}</style></head><body>{body}</body></html>"
    browser = next((b for b in BROWSERS if b and os.path.exists(b)), None)
    if not browser:
        sys.exit("Chrome or Edge not found; set BROWSER=/path/to/chrome")
    with tempfile.TemporaryDirectory() as tmp:
        page = os.path.join(tmp, "design.html")
        open(page, "w", encoding="utf8").write(html)
        subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--user-data-dir={tmp}",
             f"--print-to-pdf={OUT}", "file:///" + page.replace("\\", "/")],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120,
        )
    print("wrote", OUT)


if __name__ == "__main__":
    main()
