#!/usr/bin/env python3
"""Parses selected public profile pages with Beautiful Soup.

Reads a JSON array of {"url", "html"} from stdin and writes a JSON array of
extracted hints to stdout. It does no networking. The caller decides what each
hint is worth (verified / inferred / unknown) and attaches URL + retrieval date.
"""
import json
import re
import sys
from urllib.parse import urljoin

from bs4 import BeautifulSoup

STATE_CODES = set(
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT "
    "NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split()
)
ZIP_RE = re.compile(r"\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b")

STAGE_PATTERNS = [
    ("postdoc", re.compile(r"\bpost[\s-]?doc(?:toral)?\b", re.I)),
    ("phd-candidate", re.compile(r"\b(?:ph\.?d\.?|doctoral)\s+candidate\b", re.I)),
    ("phd-student", re.compile(r"\b(?:ph\.?d\.?|doctoral|graduate)\s+student\b", re.I)),
    (
        "faculty",
        re.compile(r"\b(?:professor|lecturer|principal investigator)\b", re.I),
    ),
]

PAST_ROLE = re.compile(r"\b(?:former|formerly|previously|was\s+an?|alumn\w*|advis\w*|supervis\w*|mentor\w*|with)\W+(?:\w+\W+){0,2}$", re.I)
SELF_ROLE = re.compile(r"\b(?:I\s+am|I'm|is|am\s+currently|currently)\s+(?:an?\s+)?(?:[\w-]+\s+){0,3}$", re.I)

JOB_WORDS = re.compile(
    r"professor|researcher|scientist|fellow|student|candidate|postdoc|investigator|lecturer",
    re.I,
)
ORG_WORDS = re.compile(
    r"universit|college|institute|hospital|school|center|centre|laborator|medical|academy",
    re.I,
)
GENERIC_SEGMENTS = {
    "home", "people", "faculty", "profile", "staff", "team", "members",
    "lab members", "directory", "about", "our team",
}
AFFILIATION_RE = re.compile(
    r"\b(?:professor|lecturer|researcher|scientist|postdoc\w*|fellow|student|candidate)\b[^.]{0,40}?\b(?:at|of)\s+"
    r"((?:the\s+)?(?:University of [A-Z][\w&'-]+(?: [A-Z][\w&'-]+)*|[A-Z][\w&'-]+(?: [A-Z][\w&'-]+)*"
    r" (?:University|College|Institute|Laboratory)))"
)
SPLIT_TITLE = re.compile(r"\s+(?:[|\u2013\u2014-]|::|\u00bb|\u00b7)\s+")
LEADING_TITLE = re.compile(r"^(?:dr|prof|professor)\.?\s+", re.I)
TRAILING_DEGREE = re.compile(
    r",?\s*(?:ph\.?d\.?|m\.?d\.?|m\.?s\.?c?\.?|m\.?p\.?h\.?|d\.?phil\.?)\b.*$", re.I
)


EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Obfuscated forms people publish on purpose: "name [at] brown [dot] edu".
OBFUSCATED_RE = re.compile(
    r"([A-Za-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\s+at\s+)\s*([A-Za-z0-9-]+(?:\s*(?:\[dot\]|\(dot\)|\s+dot\s+|\.)\s*[A-Za-z0-9-]+)+)",
    re.I,
)
CONTACT_TEXT = re.compile(r"^\s*contact(?: me| us| info(?:rmation)?)?\s*$", re.I)


def cf_decode(hexstr):
    """Cloudflare email protection: the page publishes the address XOR-encoded for browsers to decode."""
    try:
        key = int(hexstr[:2], 16)
        return "".join(chr(int(hexstr[i:i + 2], 16) ^ key) for i in range(2, len(hexstr), 2))
    except ValueError:
        return ""


def contacts(soup, base_url):
    """Contact details the page itself publishes. Nothing is guessed."""
    emails = []
    for tag in soup.find_all(attrs={"data-cfemail": True}):
        addr = cf_decode(tag["data-cfemail"])
        if EMAIL_RE.fullmatch(addr) and addr not in emails:
            emails.append(addr)
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if "/cdn-cgi/l/email-protection#" in href:
            addr = cf_decode(href.split("#", 1)[1])
            if EMAIL_RE.fullmatch(addr) and addr not in emails:
                emails.append(addr)
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.lower().startswith("mailto:"):
            addr = href[7:].split("?")[0].strip()
            if EMAIL_RE.fullmatch(addr) and addr not in emails:
                emails.append(addr)
    text = soup.get_text(" ")
    for m in EMAIL_RE.finditer(text):
        if m.group(0) not in emails:
            emails.append(m.group(0))
    for m in OBFUSCATED_RE.finditer(text):
        domain = re.sub(r"\s*(?:\[dot\]|\(dot\)|\s+dot\s+|\.)\s*", ".", m.group(2), flags=re.I)
        addr = f"{m.group(1)}@{domain}"
        if EMAIL_RE.fullmatch(addr) and addr not in emails:
            emails.append(addr)
    page = None
    for a in soup.find_all("a", href=True):
        if CONTACT_TEXT.match(squash(a.get_text(" "))):
            u = urljoin(base_url, a["href"].strip())
            if u.startswith("http"):
                page = u
                break
    return {"emails": emails[:5], "contact_page": page}


def squash(text):
    return re.sub(r"\s+", " ", text or "").strip()


NOT_A_NAME = re.compile(
    r"universit|college|institute|hospital|school|center|centre|laborator|department|"
    r"medical|academy|foundation|association|society|news|home|welcome|directory|"
    r"newsletter|faculty|staff|people|events|admissions|library|program|programs|"
    r"initiative|project|consortium|council|committee|office|group|team|network|alliance|"
    r"collaborative|partnership|laboratory|lab\b|labs\b|studies|services|resources|"
    r"curriculum|courses|seminar|colloquium|symposium|conference|workshop|publications|"
    r"opportunities|about|contact|overview|research",
    re.I,
)


def clean_name(raw):
    s = squash(raw)
    s = LEADING_TITLE.sub("", s)
    s = TRAILING_DEGREE.sub("", s).strip(" ,")
    if NOT_A_NAME.search(s):
        return None
    tokens = s.split(" ")
    if not 2 <= len(tokens) <= 4:
        return None
    for t in tokens:
        if not t[0].isupper():
            return None
        if not all(ch.isalpha() or ch in ".'-\u2019" for ch in t):
            return None
    return s


def person_ld(soup):
    found = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
        except (ValueError, TypeError):
            continue
        stack = [data]
        while stack:
            x = stack.pop()
            if isinstance(x, list):
                stack.extend(x)
            elif isinstance(x, dict):
                if "@graph" in x:
                    stack.extend(x["@graph"])
                kind = x.get("@type")
                kinds = kind if isinstance(kind, list) else [kind]
                if "Person" in kinds:
                    found.append(x)
    return found


def org_names(value):
    out = []
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, dict):
        out.append(value.get("name"))
    elif isinstance(value, list):
        for v in value:
            out.extend(org_names(v))
    return [squash(o) for o in out if isinstance(o, str) and squash(o)]


def focus_text(soup, main):
    heading = re.compile(
        r"research (?:interest|focus|summary|overview)|^research$|^about(?: me)?$|^bio(?:graphy)?$",
        re.I,
    )
    for h in main.find_all(["h1", "h2", "h3", "h4", "h5", "h6"]):
        if heading.search(squash(h.get_text(" "))):
            p = h.find_next("p")
            text = squash(p.get_text(" ")) if p else ""
            if len(text) >= 40:
                return text[:400]
    meta = soup.find("meta", attrs={"name": "description"}) or soup.find(
        "meta", attrs={"property": "og:description"}
    )
    if meta and len(squash(meta.get("content"))) >= 40:
        return squash(meta.get("content"))[:400]
    for p in main.find_all("p"):
        text = squash(p.get_text(" "))
        if len(text) >= 80:
            return text[:400]
    return None


def collect_links(main, base_url):
    """One entry per person on a directory page.

    Each entry keeps the text around the name (the research area listed there)
    and every other link in the same entry, such as a personal website.
    """
    anchors = []
    for a in main.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        url = urljoin(base_url, href).split("#")[0]
        if not url.startswith("http") or url == base_url:
            continue
        raw = squash(a.get_text(" "))
        flipped = re.match(r"^([^,]+),\s*([^,]+)$", raw)  # "Last, First"
        name = clean_name(f"{flipped.group(2)} {flipped.group(1)}" if flipped else raw)
        anchors.append((a, url, name))
    named = {id(a): name for a, _, name in anchors if name}

    out = {}
    for a, url, name in anchors:
        if not name:
            continue
        if name in out:
            if url not in out[name]["others"] and url != out[name]["url"]:
                out[name]["others"].append(url)
            continue
        entry = a
        for _ in range(4):  # widen to the smallest block that holds only this person
            parent = entry.parent
            if parent is None or parent.name in ("body", "main", "html", "[document]"):
                break
            names = {named[id(t)] for t in parent.find_all("a", href=True) if id(t) in named}
            if len(names) > 1:
                break
            entry = parent
        others = []
        for t in entry.find_all("a", href=True) if entry is not a else []:
            u = urljoin(base_url, t["href"].strip()).split("#")[0]
            if u.startswith("http") and u != url and u != base_url and u not in others:
                others.append(u)
        context = squash(entry.get_text(" "))[:300]
        out[name] = {"name": name, "url": url, "context": context, "others": others[:2]}
    return list(out.values())


def parse(url, html):
    soup = BeautifulSoup(html, "html.parser")
    contact = contacts(soup, url)  # read before nav/header are stripped
    people = person_ld(soup)
    ld = people[0] if people else {}

    meta_site = soup.find("meta", attrs={"property": "og:site_name"})
    meta_title = soup.find("meta", attrs={"property": "og:title"})
    title_tag = squash(soup.title.get_text(" ")) if soup.title else ""
    og_title = squash(meta_title.get("content")) if meta_title else ""

    # The page's own h1 often sits inside <header>; read it before stripping chrome.
    first_h1 = soup.find("h1")
    page_h1 = squash(first_h1.get_text(" ")) if first_h1 else ""
    for tag in soup(["script", "style", "noscript", "svg", "nav", "header"]):
        tag.decompose()
    main = soup.find("main") or soup.body or soup
    body_text = squash(main.get_text(" "))
    h1 = main.find("h1")
    h1_text = squash(h1.get_text(" ")) if h1 else ""
    if not clean_name(h1_text) and clean_name(page_h1):
        h1_text = page_h1

    # Name: structured data first, then the page heading, then the title.
    name, name_source = None, None
    for source, raw in (
        ("json-ld", ld.get("name")),
        ("h1", h1_text),
        ("og:title", SPLIT_TITLE.split(og_title)[0] if og_title else ""),
        ("title", SPLIT_TITLE.split(title_tag)[0] if title_tag else ""),
    ):
        cleaned = clean_name(raw) if raw else None
        if cleaned:
            name, name_source = cleaned, source
            break

    # Organizations. Structured data is trusted. Title segments must look like
    # an organization, so "PhD Student" or "Lab Members" are not captured.
    structured = []
    structured.extend(org_names(ld.get("worksFor")))
    structured.extend(org_names(ld.get("affiliation")))
    if meta_site and squash(meta_site.get("content")):
        structured.append(squash(meta_site.get("content")))
    from_title = []
    for source_text in (og_title, title_tag):
        from_title.extend(squash(p) for p in SPLIT_TITLE.split(source_text)[1:])
    from_title = [o for o in from_title if ORG_WORDS.search(o)]

    seen, clean_orgs = set(), []
    for o in structured + from_title:
        low = o.lower()
        if not o or o == name or low in GENERIC_SEGMENTS:
            continue
        if JOB_WORDS.search(o) and not ORG_WORDS.search(o):
            continue
        if low not in seen:
            seen.add(low)
            clean_orgs.append(o)
    clean_orgs.sort(key=lambda o: 0 if ORG_WORDS.search(o) else 1)  # stable
    # Personal sites rarely carry structured affiliation. Fall back to the opening
    # text: "assistant professor at Brown University".
    if not clean_orgs:
        m = AFFILIATION_RE.search(body_text[:800])
        if m and ORG_WORDS.search(m.group(1)):
            clean_orgs.append(squash(m.group(1)))

    # Stage is read from the page header, tiered by where the words appear.
    # Body prose is weak evidence: it may describe an advisor or collaborator.
    job = ld.get("jobTitle")
    job_text = " ".join(job) if isinstance(job, list) else (job or "")
    tiers = [
        ("jobTitle", job_text),
        ("h1", h1_text),
        ("title", f"{title_tag} {og_title}"),
        ("body", body_text[:1500]),
    ]
    header = " ".join(text for _, text in tiers)
    # One hit per tier: the earliest role phrase is the person's own ("PhD student,
    # advised by Professor X"). Mentions of former roles are skipped, and body
    # prose only counts as a self-statement ("I am a fourth-year PhD student").
    # A role directly after the person's own name is their title line
    # ("Jane Doe, Assistant Professor of ..."; "Jane Doe PhD Student").
    def names_self(before):
        return bool(name) and re.search(re.escape(name) + r"[\s,|\u2013\u2014-]*(?:(?:assistant|associate|full|adjunct|visiting|research|teaching|clinical|senior)\s+)?$", before, re.I)

    stage_hits = []
    for where, text in tiers:
        found = []
        for kind, pattern in STAGE_PATTERNS:
            for m in pattern.finditer(text):
                before = text[max(0, m.start() - 80) : m.start()]
                if PAST_ROLE.search(before):
                    continue
                if where == "body" and not SELF_ROLE.search(before) and not names_self(before):
                    continue
                found.append((m.start(), kind, m.group(0)))
                break
        if found:
            _, kind, t = min(found)
            stage_hits.append({"kind": kind, "text": t, "where": where})

    states = []
    address = ld.get("address")
    if isinstance(address, dict):
        region = squash(address.get("addressRegion", "")).upper()
        if region in STATE_CODES:
            states.append(region)
    for m in ZIP_RE.finditer(soup.get_text(" ")):
        code = m.group(1)
        if code in STATE_CODES and code not in states:
            states.append(code)

    # The role phrase that was read as the person's own stage makes a better
    # headline than a bare name or a section heading like "About".
    own_role = next((h["text"] for h in stage_hits), "")
    weak_h1 = not h1_text or h1_text == name or not clean_name(h1_text)
    headline = squash(job_text) or (f"{own_role[:1].upper()}{own_role[1:]}" if own_role and weak_h1 else "") or h1_text or title_tag
    header_only = " ".join([job_text, h1_text, title_tag, og_title])
    header_stage = any(h["where"] != "body" for h in stage_hits)
    # A heading or structured name plus a role word near the top of the page is
    # enough: many faculty pages keep the title in a subheading, not the <title>.
    # A page whose title names the person and which states their own role also counts.
    top_role = name_source in ("json-ld", "h1") and bool(JOB_WORDS.search(body_text[:400]))
    is_person = bool(name) and bool(
        ld or header_stage or JOB_WORDS.search(header_only) or top_role or stage_hits
    )
    links = [] if is_person else collect_links(main, url)
    kind = "person" if is_person else ("directory" if len(links) >= 4 else "other")

    return {
        "url": url,
        "kind": kind,
        "name": name,
        "name_source": name_source,
        "orgs": clean_orgs[:4],
        "headline": headline[:200],
        "stage_hits": stage_hits,
        "states": states[:4],
        "focus": focus_text(soup, main),
        "links": links[:80] if kind == "directory" else [],
        "emails": contact["emails"] if kind == "person" else [],
        "contact_page": contact["contact_page"] if kind == "person" else None,
    }


def main():
    pages = json.load(sys.stdin)
    out = []
    for page in pages:
        try:
            out.append(parse(page["url"], page["html"]))
        except Exception as exc:  # one bad page must not sink the batch
            out.append({"url": page.get("url"), "kind": "error", "error": str(exc)[:200]})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
