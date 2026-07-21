#!/usr/bin/env python3
"""Crawl dog & cat breed data from all six sources into raw/ JSON.

Robust by design (per project rules: fail loud, never fake):
  - Polite crawl: small per-domain concurrency + jittered sleep.
  - 429/5xx aware: exponential backoff, several attempts, then records an
    explicit error (never a fabricated row).
  - Resumable: per-source output file is re-loaded; already-scraped slugs with
    data are skipped, so re-running only fills gaps.

Output: raw/scrape_<source>_<species>.json  (dict: slug -> record)
Each record: {species, source, name, slug, url, [profileId|group], attrs, content}
`attrs` keys are canonical (see SCHEMA.md); values carry {value, sourceKey[, scale]}.
"""
from __future__ import annotations

import json, re, sys, time, threading, random
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import requests
from bs4 import BeautifulSoup

HERE = Path(__file__).parent
RAW = HERE / "raw"; RAW.mkdir(exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}
SESS = requests.Session(); SESS.headers.update(UA)

def fetch(url, tries=5):
    delay = 4.0
    for i in range(tries):
        try:
            r = SESS.get(url, timeout=35)
            if r.status_code == 429 or 500 <= r.status_code < 600:
                time.sleep(delay + random.random()); delay *= 2; continue
            if r.status_code == 404:
                return None  # genuine missing page
            r.raise_for_status()
            return r.text
        except requests.RequestException:
            time.sleep(delay + random.random()); delay *= 2
    return "__ERROR__"

def S(html): return BeautifulSoup(html, "lxml")

# ----------------------------------------------------------------------------
# Index discovery
# ----------------------------------------------------------------------------
def discover():
    idx = {}
    def links(url, rx):
        html = fetch(url);
        if not html or html == "__ERROR__": sys.exit(f"FATAL: index fetch failed: {url}")
        return re.findall(rx, html)

    wd = {}
    for pid, slug in links("https://wamiz.co.uk/dog/breeds", r"/dog/breeds/(\d+)/([a-z0-9-]+)"):
        wd[slug] = {"slug": slug, "profileId": int(pid),
                    "url": f"https://wamiz.co.uk/dog/breeds/{pid}/{slug}"}
    idx[("wamiz", "dog")] = wd

    wc = {}
    for pid, slug in links("https://wamiz.co.uk/cat/breeds", r"/cat/breeds/(\d+)/([a-z0-9-]+)"):
        wc[slug] = {"slug": slug, "profileId": int(pid),
                    "url": f"https://wamiz.co.uk/cat/breeds/{pid}/{slug}"}
    idx[("wamiz", "cat")] = wc

    rk = {}
    for grp, slug in links("https://www.royalkennelclub.com/search/breeds-a-to-z/",
                           r"/search/breeds-a-to-z/breeds/([a-z-]+)/([a-z0-9-]+)/"):
        rk[slug] = {"slug": slug, "group": grp,
                    "url": f"https://www.royalkennelclub.com/search/breeds-a-to-z/breeds/{grp}/{slug}/"}
    idx[("rkc", "dog")] = rk

    cd = {}
    for slug in links("https://www.chewy.com/education/dog-breeds", r"/education/dog-breeds/([a-z0-9-]+)"):
        cd[slug] = {"slug": slug, "url": f"https://www.chewy.com/education/dog-breeds/{slug}"}
    idx[("chewy", "dog")] = cd

    cc = {}
    for slug in links("https://www.chewy.com/education/cat-breeds", r"/education/cat-breeds/([a-z0-9-]+)"):
        cc[slug] = {"slug": slug, "url": f"https://www.chewy.com/education/cat-breeds/{slug}"}
    idx[("chewy", "cat")] = cc

    tc = {}
    for slug in links("https://tica.org/ticas-breeds/browse-all-breeds/", r"tica\.org/breed/([a-z0-9-]+)/"):
        tc[slug] = {"slug": slug, "url": f"https://tica.org/breed/{slug}/"}
    idx[("tica", "cat")] = tc
    return idx

# ----------------------------------------------------------------------------
# Parsers  (return (attrs, content, name))
# ----------------------------------------------------------------------------
def _wamiz_leaves(cell):
    out, seen = [], set()
    for t in cell.stripped_strings:
        t = t.strip()
        if t and t not in seen and t.lower() != "more information":
            seen.add(t); out.append(t)
    return out

def parse_wamiz(html):
    s = S(html); attrs = {}; content = {}
    name = None
    h1 = s.find("h1")
    if h1: name = h1.get_text(strip=True)
    tb = s.select_one(".js-breed-page table")  # lxml does not synthesize <tbody>
    if tb:
        for tr in tb.select("tr"):
            tds = tr.find_all("td", recursive=False) or tr.find_all(["td", "th"])
            if len(tds) < 2: continue
            label = tds[0].get_text(" ", strip=True).split("More information")[0].strip()
            cell = tds[1]; raw = cell.get_text(" ", strip=True)
            L = label.lower()
            if "purchase price" in L: continue
            if "life expectancy" in L:
                m = re.search(r"life expectancy of (.+)", raw, re.I)
                attrs["lifeExpectancy"] = {"value": (m.group(1).strip() if m else raw), "sourceKey": label}
            elif "temperament" in L:
                li = [x.get_text(strip=True) for x in cell.select("li") if x.get_text(strip=True)]
                attrs["temperament"] = {"value": li or [raw], "sourceKey": label}
            elif L == "size":
                attrs["size"] = {"value": raw, "sourceKey": label}
            elif "adult size" in L:
                m = re.search(r"Female\s+(.+?)\s+Male\s+(.+)", raw, re.I)
                attrs["adultHeight"] = {"value": ({"female": m.group(1).strip(), "male": m.group(2).strip()} if m else raw), "sourceKey": label}
            elif "adult weight" in L:
                m = re.search(r"Female\s+(.+?)\s+Male\s+(.+)", raw, re.I)
                attrs["adultWeight"] = {"value": ({"female": m.group(1).strip(), "male": m.group(2).strip()} if m else raw), "sourceKey": label}
            elif "coat colour" in L:
                attrs["coatColour"] = {"value": _wamiz_leaves(cell), "sourceKey": "Coat colour"}
            elif "type of coat" in L:
                attrs["coatType"] = {"value": _wamiz_leaves(cell), "sourceKey": "Type of coat"}
            elif "eye colour" in L:
                attrs["eyeColour"] = {"value": _wamiz_leaves(cell), "sourceKey": "Eye colour"}
    body = (s.select_one(".js-breed-page") or s.body)
    txt = body.get_text("\n", strip=True) if body else ""
    flat = body.get_text(" ", strip=True) if body else ""
    mo = re.search(r"Other name:\s*([^\n]+)", txt)
    if mo and mo.group(1).strip():
        attrs["otherNames"] = {"value": [mo.group(1).strip()], "sourceKey": "Other name"}
    ms = re.search(r"Shedding\s+(Heavy|Light|Average|Moderate|Minimal|High|Low)\b", flat, re.I)
    if ms: attrs["shedding"] = {"value": ms.group(1).strip().title(), "sourceKey": "Shedding"}
    # description = first substantial paragraph
    for p in body.select("p") if body else []:
        t = p.get_text(" ", strip=True)
        if len(t) > 80: content["description"] = t; break
    # common illnesses
    ci = re.search(r"Common illnesses\s*\n+(.+?)(?:\n\n|\nName ideas|\nReproduction|$)", txt, re.S)
    if ci:
        lst = [x.strip() for x in ci.group(1).split("\n") if x.strip() and len(x.strip()) < 80][:15]
        if lst: content["commonIllnesses"] = lst
    return attrs, content, (name or "")

RKC_LABELS = ["Size", "Exercise", "Size of home", "Grooming", "Coat length", "Sheds",
              "Lifespan", "Vulnerable native breed", "Town or country", "Size of garden"]
RKC_MAP = {"Size": "size", "Exercise": "exercise", "Size of home": "sizeOfHome",
           "Grooming": "grooming", "Coat length": "coatType", "Sheds": "shedding",
           "Lifespan": "lifeExpectancy", "Vulnerable native breed": "vulnerableNativeBreed",
           "Town or country": "townOrCountry", "Size of garden": "sizeOfGarden"}

def parse_rkc(html):
    s = S(html); attrs = {}; content = {}
    name = None
    h1 = s.find("h1")
    if h1: name = h1.get_text(" ", strip=True)
    sl = s.select_one(".m-breed-summary")
    if sl:
        toks = [t.strip() for t in sl.get_text("|", strip=True).split("|") if t.strip()]
        for i, tok in enumerate(toks):
            if tok in RKC_LABELS and i + 1 < len(toks):
                val = toks[i + 1]
                if val in RKC_LABELS: continue
                attrs[RKC_MAP[tok]] = {"value": val, "sourceKey": tok}
    ab = s.find(string=re.compile(r"About this breed", re.I))
    if ab:
        p = ab.find_parent()
        nxt = p.find_next("p") if p else None
        if nxt: content["description"] = nxt.get_text(" ", strip=True)
    return attrs, content, (name or "")

CHEWY_RATING_MAP = {
    "Maintenance Level": "maintenanceLevel", "Friendliness": "friendliness",
    "Exercise Needs": "exercise", "Health Issues": "healthIssuesRating",
    "Grooming Needs": "grooming", "Training Needs": "trainingNeeds", "Trainability": "trainingNeeds",
    "Shedding Level": "shedding", "Playfulness": "playfulness", "Energy Level": "energyLevel",
    "Barking Tendencies": "barkingTendencies", "Vocal Level": "vocalLevel",
    "Good for Apartments and Small Homes": "goodForApartments",
    "Sensitive to Cold Weather": "sensitiveToColdWeather",
    "Sensitive to Warm Weather": "sensitiveToWarmWeather",
    "Good for First-Time Pet Parents": "goodForFirstTimeOwners",
    "Good with Kids": "goodWithKids", "Good with Cats": "goodWithCats",
    "Good with Dogs": "goodWithDogs", "Good with Other Dogs": "goodWithOtherDogs",
    "Good with Other Cats": "goodWithOtherCats", "Likes to be Picked Up": "likesToBePickedUp",
    "Likes to be Pet": "likesToBePet",
}

def parse_chewy(html):
    s = S(html); attrs = {}; content = {}
    h1 = s.find("h1"); name = h1.get_text(" ", strip=True) if h1 else ""
    alllines = [l.strip() for l in s.get_text("\n").split("\n") if l.strip()]
    # Structured facts live in the top summary, BEFORE the "Jump to section" nav.
    try: cut = next(k for k, l in enumerate(alllines) if l.lower().startswith("jump to"))
    except StopIteration: cut = len(alllines)
    lines = alllines[:cut]
    LABELS = {"TEMPERAMENT", "WEIGHT", "HEIGHT", "LIFE EXPECTANCY", "COAT COLOR",
              "MAINTENANCE LEVEL", "FRIENDLINESS"}
    def block_after(label):
        try: i = next(k for k, l in enumerate(lines) if l.upper() == label)
        except StopIteration: return []
        out = []
        for l in lines[i + 1:i + 8]:
            if l.upper() in LABELS or l.lower().startswith("jump to"): break
            out.append(l)
        return out
    t = block_after("TEMPERAMENT")
    if t: attrs["temperament"] = {"value": [x.strip() for x in t[0].split(",") if x.strip()], "sourceKey": "Temperament"}
    le = [l for l in block_after("LIFE EXPECTANCY") if "year" in l.lower()]
    if le: attrs["lifeExpectancy"] = {"value": le[0], "sourceKey": "Life Expectancy"}
    cc = block_after("COAT COLOR")
    if cc: attrs["coatColour"] = {"value": [x.strip() for x in cc[0].split(",") if x.strip()], "sourceKey": "Coat Color"}
    def bysex(block, unit):
        rows = [l for l in block if unit in l.lower()]
        d = {}
        for l in rows:
            m = re.match(r"(Male|Female):\s*(.+)", l, re.I)
            if m: d[m.group(1).lower()] = m.group(2).strip()
        if d: return d
        return rows[0] if rows else None
    w = bysex(block_after("WEIGHT"), "pound")
    if w: attrs["adultWeight"] = {"value": w, "sourceKey": "Weight"}
    h = bysex(block_after("HEIGHT"), "inch")
    if h: attrs["adultHeight"] = {"value": h, "sourceKey": "Height"}
    for a in s.select("[aria-valuenow][aria-label]"):
        m = re.match(r"([^:]+):\s*(\d)", a.get("aria-label") or "")
        if not m: continue
        key = CHEWY_RATING_MAP.get(m.group(1).strip())
        if key and key not in attrs:
            attrs[key] = {"value": int(m.group(2)), "scale": "1-5", "sourceKey": m.group(1).strip()}
    # description (first paragraph under the intro)
    for p in s.select("p"):
        tx = p.get_text(" ", strip=True)
        if len(tx) > 90: content["description"] = tx; break
    return attrs, content, name

TICA_TAXO = {"temperament": "temperament", "size": "size", "activity-level": "exercise",
             "grooming": "grooming", "coat-length": "coatType", "classification": "classification"}

def parse_tica(html):
    s = S(html); attrs = {}; content = {}
    h1 = s.find("h1"); name = h1.get_text(" ", strip=True) if h1 else ""
    carrier = s.select_one('[class*="temperament-"]')
    if carrier:
        classes = carrier.get("class", [])
        vals = {}
        for c in classes:
            for pref, key in TICA_TAXO.items():
                m = re.match(re.escape(pref) + r"-([a-z]+)$", c)
                if m and not (pref == "size" and m.group(1) not in ("small", "medium", "large")):
                    vals.setdefault(key, m.group(1))
        for key, v in vals.items():
            val = [v.title()] if key in ("temperament", "coatType") else v.title()
            attrs[key] = {"value": val, "sourceKey": f"body class {[p for p,k in TICA_TAXO.items() if k==key][0]}-*"}
    g = s.find(string=re.compile(r"At a Glance", re.I))
    if g:
        cont = g.find_parent()
        nxt = cont.find_next("p") if cont else None
        if nxt: content["atAGlance"] = nxt.get_text(" ", strip=True)
    return attrs, content, name

PARSERS = {"wamiz": parse_wamiz, "rkc": parse_rkc, "chewy": parse_chewy, "tica": parse_tica}
CONCURRENCY = {"wamiz": 4, "rkc": 6, "chewy": 6, "tica": 6}
SLEEP = {"wamiz": 0.35, "rkc": 0.12, "chewy": 0.12, "tica": 0.12}

BUDGET = float(__import__("os").environ.get("BUDGET", "36"))  # seconds per invocation

def crawl(source, species, items, deadline):
    out_path = RAW / f"scrape_{source}_{species}.json"
    store = json.loads(out_path.read_text()) if out_path.exists() else {}
    todo = [it for sl, it in items.items() if not (store.get(sl, {}).get("ok"))]
    if not todo:
        return store, True
    lock = threading.Lock(); done = [0]; stop = threading.Event()
    def work(it):
        if stop.is_set(): return
        if time.time() > deadline: stop.set(); return
        sl = it["slug"]
        html = fetch(it["url"])
        rec = {"species": species, "source": source, "slug": sl, "url": it["url"]}
        if "profileId" in it: rec["profileId"] = it["profileId"]
        if "group" in it: rec["group"] = it["group"]
        if html is None:
            rec.update(ok=False, status="404")
        elif html == "__ERROR__":
            rec.update(ok=False, status="fetch_error")
        else:
            try:
                attrs, content, name = PARSERS[source](html)
                rec.update(name=name, attrs=attrs, content=content, ok=bool(attrs))
                if not attrs: rec["status"] = "no_attrs"
            except Exception as e:
                rec.update(ok=False, status=f"parse_error: {e}")
        with lock:
            store[sl] = rec; done[0] += 1
            if done[0] % 25 == 0:
                out_path.write_text(json.dumps(store, ensure_ascii=False))
                print(f"  {source}/{species}: {done[0]}/{len(todo)}")
        time.sleep(SLEEP[source] + random.random() * 0.3)
    with ThreadPoolExecutor(max_workers=CONCURRENCY[source]) as ex:
        list(ex.map(work, todo))
    out_path.write_text(json.dumps(store, ensure_ascii=False))
    ok = sum(1 for r in store.values() if r.get("ok"))
    remaining = [it for sl, it in items.items() if not store.get(sl, {}).get("ok")]
    completed = not remaining
    print(f"{'DONE' if completed else 'PARTIAL'} {source}/{species}: {ok}/{len(items)} ok "
          f"({len(remaining)} left) -> {out_path.name}")
    return store, completed

INDEX_CACHE = RAW / "_index.json"

def get_index():
    if INDEX_CACHE.exists():
        raw = json.loads(INDEX_CACHE.read_text())
        return {tuple(k.split("|")): v for k, v in raw.items()}
    print("Discovering indexes...")
    idx = discover()
    INDEX_CACHE.write_text(json.dumps({f"{a}|{b}": v for (a, b), v in idx.items()}, ensure_ascii=False))
    return idx

def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    idx = get_index()
    for (src, sp), items in idx.items():
        print(f"  {src}/{sp}: {len(items)} breeds")
    deadline = time.time() + BUDGET
    all_done = True
    for (src, sp), items in idx.items():
        if only and only not in (src, f"{src}_{sp}"): continue
        if time.time() > deadline:
            all_done = False; print(f"BUDGET hit before {src}/{sp}"); break
        _, completed = crawl(src, sp, items, deadline)
        all_done = all_done and completed
    print("ALL_COMPLETE" if all_done else "MORE_WORK_REMAINS")

if __name__ == "__main__":
    main()
