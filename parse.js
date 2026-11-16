// parse.js — a fast, dependency-free CommonMark + GFM renderer.
// parse(markdown) returns the HTML that marked 18.1.3 renders with its default
// options (gfm on, breaks off, pedantic off). Written from scratch: a single-pass
// block parser over lines and a delimiter-stack inline parser. No caching across
// cases: every call to parse is independent.

// ---------------------------------------------------------------------------
// Character classes (ASCII fast paths + Unicode fallback, as the spec needs
// Unicode punctuation / whitespace for delimiter flanking rules).
// ---------------------------------------------------------------------------

const ASCII_PUNCT = new Uint8Array(128);
for (const ch of `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`) ASCII_PUNCT[ch.charCodeAt(0)] = 1;

const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

function isPunct(code) {
  return code < 128 ? ASCII_PUNCT[code] === 1 : PUNCT_RE.test(String.fromCodePoint(code));
}
function isSpace(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11
    ? true
    : code > 127 && SPACE_RE.test(String.fromCodePoint(code));
}
function isAlnum(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    ? true
    : code > 127 && ALNUM_RE.test(String.fromCodePoint(code));
}
function isSpaceOrEnd(s, i) {
  return i < 0 || i >= s.length || isSpace(s.charCodeAt(i));
}
function isPunctOrEnd(s, i) {
  return i < 0 || i >= s.length ? false : isPunct(s.charCodeAt(i));
}

// ---------------------------------------------------------------------------
// Escaping and entities.
// Text runs are escaped per token (never across a token boundary): '<', '>',
// '"' and "'" always become entities; '&' becomes '&amp;' unless it starts a
// valid-looking entity reference (&word; or a numeric reference). Numeric
// character references are decoded (invalid ones become U+FFFD, &#38; stays
// '&amp;'), named ones are left alone — exactly what marked's unescape +
// escape pair does.
// ---------------------------------------------------------------------------

const ESC_MAP = { 34: '&quot;', 38: '&amp;', 39: '&#39;', 60: '&lt;', 62: '&gt;' };

function escTextRun(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      // '&': try a numeric reference, else a named-entity lookalike, else &amp;
      if (i + 1 < n && s.charCodeAt(i + 1) === 35) {
        let j = i + 2;
        let hex = false;
        if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
        const ds = j;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (hex ? (d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102)
                  : d >= 48 && d <= 57) j++;
          else break;
        }
        const digits = j - ds;
        if (digits >= 1 && digits <= (hex ? 6 : 7) && j < n && s.charCodeAt(j) === 59) {
          const code = parseInt(s.slice(ds, j), hex ? 16 : 10);
          if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) out += '\uFFFD';
          else if (code === 38) out += '&amp;';
          else if (code === 60) out += '&lt;';
          else if (code === 62) out += '&gt;';
          else if (code === 34) out += '&quot;';
          else if (code === 39) out += '&#39;';
          else out += String.fromCodePoint(code);
          i = j + 1;
          continue;
        }
      } else {
        // &word; lookalike: leave untouched
        let j = i + 1;
        while (j < n) {
          const d = s.charCodeAt(j);
          if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95) j++;
          else break;
        }
        if (j > i + 1 && j < n && s.charCodeAt(j) === 59) {
          out += s.slice(i, j + 1);
          i = j + 1;
          continue;
        }
      }
      out += '&amp;';
      i++;
      continue;
    }
    const rep = ESC_MAP[c];
    if (rep !== undefined) { out += rep; i++; continue; }
    // copy a run of plain characters
    let j = i + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 38 || ESC_MAP[d] !== undefined) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

function escFull(s) {
  // Escape every & < > " ' (used for code spans/blocks and autolink text/href).
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    const rep = ESC_MAP[c];
    if (rep !== undefined) { out += rep; i++; continue; }
    let j = i + 1;
    while (j < n && ESC_MAP[s.charCodeAt(j)] === undefined) j++;
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

function cleanUrl(href) {
  // marked: encodeURI, with %25 turned back into %. null when encodeURI throws.
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

function normLabel(s) {
  // Link labels: collapse all whitespace to single spaces, trim, case-fold
  // (marked's fold: lower, then upper, then lower again). Backslash
  // escapes are NOT resolved here — labels compare raw (a reference
  // [foo\!] does not match a definition [foo!]).
  return s.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

function unescapePunct(s) {
  // Remove a backslash before an ASCII punctuation character.
  if (s.indexOf('\\') === -1) return s;
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

// ---------------------------------------------------------------------------
// Inline parsing.
// A scanner builds a flat node list (text / code / link / image / html / br /
// delimiter markers / bracket markers), then emphasis is resolved per node
// list with the CommonMark delimiter-stack algorithm (with marked's exact
// flanking rules and its rule-of-3), and the list is rendered to HTML.
// ---------------------------------------------------------------------------

const T_TEXT = 0, T_CODE = 1, T_BR = 2, T_HTML = 3, T_LINK = 4, T_IMG = 5;
const T_EM = 6, T_STRONG = 7, T_DEL = 8, T_DELIM = 9, T_BRACKET = 10;

const SCHEME_RE = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/\//y;
const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/y;
const EMAIL_URL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/y;
const ATTR_RE = /[ \t\n]+[a-zA-Z:_][\w.:-]*(?:[ \t\n]*=[ \t\n]*"[^"]*"|[ \t\n]*=[ \t\n]*'[^']*'|[ \t\n]*=[ \t\n]*[^\s"'=<>`]+)?/y;
const TAG_OPEN_RE = /<[a-zA-Z][a-zA-Z0-9-]*/y;
const TAG_CLOSE_RE = /<\/[a-zA-Z][a-zA-Z0-9-]*[ \t\n]*>/y;
const BACKPEDAL_PUNCT = new Uint8Array(128);
for (const ch of `?!.,:;*_'\"~)`) BACKPEDAL_PUNCT[ch.charCodeAt(0)] = 1;

// Find the end of a code span starting at i (s[i] is a backtick). Returns the
// index just past the closing run, and the raw content between, or null.
function scanCodeSpan(s, i, limit = s.length) {
  const n = s.length;
  let m = i;
  while (m < n && s.charCodeAt(m) === 96) m++;
  const run = m - i;
  let j = m;
  while (j < limit) {
    if (s.charCodeAt(j) === 96) {
      let k = j;
      while (k < n && s.charCodeAt(k) === 96) k++;
      if (k - j === run) return { end: k, text: s.slice(m, j) };
      j = k;
    } else j++;
  }
  return null;
}

// Inline HTML tag / comment / PI / declaration / CDATA starting at i.
// Returns the index just past it, or -1.
function scanTag(s, i) {
  const n = s.length;
  if (s.charCodeAt(i) !== 60) return -1; // '<'
  if (i + 3 < n && s[i + 1] === '!' && s[i + 2] === '-' && s[i + 3] === '-') {
    // comment: <!-- ... -->  (or <!--> / <!--->)
    if (s[i + 4] === '>') return i + 5;
    if (s[i + 4] === '-' && s[i + 5] === '>') return i + 6;
    const end = s.indexOf('-->', i + 4);
    return end === -1 ? n : end + 3;
  }
  if (i + 1 < n && s[i + 1] === '?') {
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (i + 8 < n && s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    return end === -1 ? -1 : end + 3;
  }
  if (i + 1 < n && s[i + 1] === '!') {
    // declaration <!A ...> : letter then anything up to '>'
    if (i + 2 < n) {
      const c = s.charCodeAt(i + 2);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
        const end = s.indexOf('>', i + 2);
        return end === -1 ? -1 : end + 1;
      }
    }
    return -1;
  }
  if (i + 1 < n && s[i + 1] === '/') {
    TAG_CLOSE_RE.lastIndex = i;
    const m = TAG_CLOSE_RE.exec(s);
    return m ? i + m[0].length : -1;
  }
  TAG_OPEN_RE.lastIndex = i;
  const m = TAG_OPEN_RE.exec(s);
  if (!m) return -1;
  let j = i + m[0].length;
  // attributes (whitespace between them may include newlines)
  while (j < n) {
    ATTR_RE.lastIndex = j;
    const a = ATTR_RE.exec(s);
    if (!a || a.index !== j) break;
    j += a[0].length;
  }
  while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
  // a self-closing '/' must be immediately followed by '>'
  if (j < n && s.charCodeAt(j) === 47) j++;
  if (j < n && s.charCodeAt(j) === 62) return j + 1; // '>'
  return -1;
}

// Autolink <scheme:...> or <email> starting at i. Returns {href, text, end}.
function scanAutolink(s, i) {
  if (s.charCodeAt(i) !== 60) return null;
  const n = s.length;
  let j = i + 1;
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  if (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      let k = j + 1;
      while (k < n) {
        const d = s.charCodeAt(k);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 43 || d === 46 || d === 45) k++;
        else break;
      }
      if (k - j >= 2 && k - j <= 32 && k < n && s.charCodeAt(k) === 58) {
        // rest: no spaces / control / <>
        let e = k + 1;
        while (e < n) {
          const d = s.charCodeAt(e);
          if (d === 62) {
            const text = s.slice(i + 1, e);
            return { href: text, text, end: e + 1 };
          }
          if (d <= 32 || d === 60) return null;
          e++;
        }
        return null;
      }
    }
  }
  // email
  EMAIL_RE.lastIndex = i + 1;
  const m = EMAIL_RE.exec(s);
  if (m) {
    const e = i + 1 + m[0].length;
    if (e < n && s.charCodeAt(e) === 62) {
      const text = m[0];
      return { href: 'mailto:' + text, text, end: e + 1 };
    }
  }
  return null;
}

// Backpedal: longest prefix of a matched URL that drops trailing punctuation
// (keeping balanced parens) and a trailing &word; entity lookalike.
function backpedal(t) {
  const n = t.length;
  let i = 0;
  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 40) { // '('
      const close = t.indexOf(')', i + 1);
      if (close === -1) break;
      i = close + 1;
    } else if (c === 38) { // '&'
      let j = i + 1;
      while (j < n) {
        const d = t.charCodeAt(j);
        if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122)) j++;
        else break;
      }
      if (j > i + 1 && j < n && t.charCodeAt(j) === 59 && j + 1 === n) break;
      i++;
    } else if (c < 128 && BACKPEDAL_PUNCT[c] === 1) {
      let j = i;
      while (j < n && t.charCodeAt(j) < 128 && BACKPEDAL_PUNCT[t.charCodeAt(j)] === 1) j++;
      if (j === n) break;
      i = j;
    } else {
      let j = i + 1;
      while (j < n) {
        const d = t.charCodeAt(j);
        if (d === 40 || d === 38 || (d < 128 && BACKPEDAL_PUNCT[d] === 1)) break;
        j++;
      }
      i = j;
    }
  }
  return t.slice(0, i);
}

// Is there an emphasis opener of char `ch` before position `pos`
// (scanning back to the start of the line)? A trailing '_' after a bare
// email blocks the autolink — unless that '_' is the closing delimiter
// of an emphasis span, in which case the email still autolinks.
function hasEmphasisOpener(s, pos, ch) {
  let j = pos - 1;
  while (j >= 0 && s.charCodeAt(j) !== 10) {
    if (s.charCodeAt(j) === ch) {
      let k = j;
      while (k > 0 && s.charCodeAt(k - 1) === ch) k--;
      if (delimRun(s, k, ch).open) return true;
      j = k - 1;
    } else j--;
  }
  return false;
}

// GFM extended autolink starting at i. Returns {href, text, end} or null.
// bracketEnd: index of the ']' that closes the innermost active '['
// bracket (-1 when not inside one) — a ']' at exactly that position
// ends the URL (it closes the bracket); any other ']' is part of the
// URL and backpedal decides (e.g. 'https://x/a)]' keeps the ')]').
function scanUrl(s, i, bracketEnd) {
  const n = s.length;
  // mailto: / xmpp: + email
  if (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) {
    const proto = s.startsWith('mailto:', i) ? 'mailto:' : 'xmpp:';
    EMAIL_URL_RE.lastIndex = i + proto.length;
    const m = EMAIL_URL_RE.exec(s);
    if (m) {
      const after = proto.length + m[0].length;
      // the email must not be followed by a char that could extend it
      // (alphanumeric, '_' or '-'): then it is not an autolink at all —
      // unless the '_' is the closing delimiter of an emphasis span
      const nc = i + after < n ? s.charCodeAt(i + after) : -1;
      const emphCloser = nc === 95 && hasEmphasisOpener(s, i, 95);
      const extendable = nc !== -1 && !emphCloser && ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) ||
        (nc >= 97 && nc <= 122) || nc === 95 || nc === 45);
      if (!extendable) {
        let end = after;
        if (proto === 'xmpp:' && i + end < n && s.charCodeAt(i + end) === 47) {
          let k = i + end + 1;
          while (k < n) {
            const d = s.charCodeAt(k);
            if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 64 || d === 46) k++;
            else break;
          }
          end = k - i;
        }
        const text = s.slice(i, i + end);
        return { href: text, text, end: i + end };
      }
    }
  }
  // www. or scheme://
  let start = -1;
  let prefix = '';
  if (s.startsWith('www.', i)) { start = 4; prefix = 'http://'; }
  else {
    SCHEME_RE.lastIndex = i;
    const m = SCHEME_RE.exec(s);
    if (m) { start = m[0].length; prefix = ''; }
  }
  if (start >= 0) {
    // domain labels then [^\s<]*
    let j = i + start;
    let labels = 0;
    while (j < n) {
      let k = j;
      while (k < n) {
        const d = s.charCodeAt(k);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) k++;
        else break;
      }
      if (k === j) break;
      labels++;
      j = k;
      if (j < n && s.charCodeAt(j) === 46) { j++; continue; }
      break;
    }
    if (labels >= 1) {
      let e = j;
      while (e < n) {
        const d = s.charCodeAt(e);
        // stop at whitespace and '<'; stop at ']' only when it is
        // the ']' that closes the innermost active bracket
        if (d <= 32 || d === 60 || (e === bracketEnd && d === 93)) break;
        e++;
      }
      let text = backpedal(s.slice(i, e));
      if (text.length > 0) {
        return { href: prefix + text, text, end: i + text.length };
      }
    }
  }
  // bare email
  EMAIL_URL_RE.lastIndex = i;
  const m = EMAIL_URL_RE.exec(s);
  if (m) {
    const after = i + m[0].length;
    const nextCh = after < n ? s.charCodeAt(after) : -1;
    const blocked = nextCh !== -1 && ((nextCh >= 48 && nextCh <= 57) ||
        (nextCh >= 65 && nextCh <= 90) || (nextCh >= 97 && nextCh <= 122) ||
        nextCh === 95 || nextCh === 45);
    // a trailing '_' blocks the autolink, unless it is the closing
    // delimiter of an emphasis span opened before the email
    const emphCloser = nextCh === 95 && hasEmphasisOpener(s, i, 95);
    if (!blocked || emphCloser) {
      return { href: 'mailto:' + m[0], text: m[0], end: after };
    }
  }
  return null;
}

// Scan for the ']' that closes a bracket opened at i (s[i] === '[').
// Depth counts nested [ ], skipping backslash escapes and code spans.
// Returns the index of the closing ']' or -1.
function scanBracketEnd(s, i) {
  const n = s.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; } // backslash escape
    if (c === 96) {
      const cs = scanCodeSpan(s, j);
      if (cs) { j = cs.end; continue; }
      j++;
      continue;
    }
    if (c === 91) depth++;
    else if (c === 93) {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

// Can marked's link-label regex consume the backticks in s[i..j)?
// The label's code-span alternative is `+(?!`)[^`]*?`+(?!`) — a run,
// then content with NO backtick, then a run (any length) — so a code
// span whose content holds a backtick truncates the label and the
// link fails; a run of 2+ backticks immediately before ']' is the
// only other consumable form. Returns false when the label cannot
// be matched (no link forms).
function labelBackticksOk(s, i, j) {
  let k = i;
  while (k < j) {
    const c = s.charCodeAt(k);
    if (c === 92) { k += 2; continue; } // backslash escape
    if (c === 96) {
      let r = k;
      while (r < j && s.charCodeAt(r) === 96) r++;
      const len = r - k;
      // next backtick run after this one closes the code span
      let m = r;
      while (m < j && s.charCodeAt(m) !== 96) m++;
      if (m < j) {
        let e = m;
        while (e < j && s.charCodeAt(e) === 96) e++;
        k = e;
      } else {
        // no closer: ok only as ``+(?=]) — 2+ backticks right at ']'
        if (len >= 2 && r === j) return true;
        return false;
      }
    } else {
      k++;
    }
  }
  return true;
}

// After a ']' at position j, try to parse an inline link destination
// "(dest \"title\")". Returns {href, title, end} or null.
function scanInlineDest(s, j) {
  const n = s.length;
  let i = j + 1;
  if (i >= n || s.charCodeAt(i) !== 40) return null; // '('
  i++;
  // skip whitespace (spaces, tabs, newlines)
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  let href = '';
  let title = null;
  if (i < n && s.charCodeAt(i) === 60) {
    // <dest>: no newline, no '<', escapes allowed
    let k = i + 1;
    let ok = false;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === 62) { ok = true; break; }
      if (c === 10 || c === 60) return null;
      k++;
    }
    if (!ok) return null;
    href = s.slice(i + 1, k);
    i = k + 1;
  } else {
    // bare dest: run of non-space, non-control chars, with balanced parens
    let k = i;
    let depth = 0;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === 32 || c === 9 || c === 10 || c === 0) break;
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    if (depth > 0) return null; // unmatched '(' in dest
    href = s.slice(i, k);
    i = k;
  }
  // optional title after whitespace (spaces/tabs/newlines)
  let t = i;
  while (t < n) {
    const c = s.charCodeAt(t);
    if (c === 32 || c === 9 || c === 10) t++;
    else break;
  }
  if (t < n && (s.charCodeAt(t) === 34 || s.charCodeAt(t) === 39 || s.charCodeAt(t) === 40)) {
    const q = s.charCodeAt(t);
    const close = q === 40 ? 41 : q;
    let k = t + 1;
    let ok = false;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === close) { ok = true; break; }
      if (q !== 34 && c === 10) {
        // single-quote / paren titles may span lines but not blank lines
        if (k + 1 < n && s.charCodeAt(k + 1) === 10) return null;
      }
      k++;
    }
    if (!ok) return null;
    title = s.slice(t + 1, k);
    i = k + 1;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10) i++;
      else break;
    }
  }
  if (i < n && s.charCodeAt(i) === 41) {
    return { href: unescapePunct(href), title: title === null ? null : unescapePunct(title), end: i + 1 };
  }
  return null;
}

// A reference label starting at i (s[i] === '['). Returns {label, end} where
// end is just past the ']', or null. The label has no brackets, may span
// lines but not blank lines.
function scanRefLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  let depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 91) return null;
    if (c === 93) {
      if (depth === 0) return { label: s.slice(i + 1, j), end: j + 1 };
      depth--;
    }
    if (c === 10) {
      // newline allowed unless followed by a blank line
      if (j + 1 < n && s.charCodeAt(j + 1) === 10) return null;
    }
    j++;
  }
  return null;
}

// Delimiter run info for '*', '_' (flanking rules) at position i.
function delimRun(s, i, ch) {
  const n = s.length;
  let len = 0;
  while (i + len < n && s.charCodeAt(i + len) === ch) len++;
  const before = i - 1 >= 0 ? s.charCodeAt(i - 1) : -1;
  const after = i + len < n ? s.charCodeAt(i + len) : -1;
  const beforeSpace = before === -1 || isSpace(before);
  const afterSpace = after === -1 || isSpace(after);
  const beforePunct = before !== -1 && isPunct(before);
  const afterPunct = after !== -1 && isPunct(after);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  let open, close;
  if (ch === 42) { // '*'
    open = leftFlanking;
    close = rightFlanking;
  } else { // '_': intraword runs cannot open or close
    open = leftFlanking && (afterPunct || !isAlnum(before));
    close = rightFlanking && (beforePunct || !isAlnum(after));
  }
  return { len, open, close };
}

// ---------------------------------------------------------------------------
// Inline scanner.
// ---------------------------------------------------------------------------

const SPECIAL = new Uint8Array(128);
for (const c of [92, 96, 60, 91, 93, 42, 95, 126, 33, 10]) SPECIAL[c] = 1; // \ ` < [ ] * _ ~ ! \n

function isLocalPartChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 95 || c === 43 || c === 45;
}

// Plain-text rendering of a node list (used for link labels and image alt).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case T_TEXT: out += nd.s; break;
      case T_CODE: out += nd.s; break;
      case T_HTML: out += nd.s; break;
      case T_BR: break;
      case T_LINK:
      case T_IMG: out += nd.children ? plainText(nd.children) : (nd.s || ''); break;
      case T_EM: case T_STRONG: case T_DEL: out += plainText(nd.children); break;
      case T_DELIM: out += String.fromCharCode(nd.ch).repeat(nd.len); break;
      case T_BRACKET: out += nd.img ? '![' : '['; break;
    }
  }
  return out;
}

// Does the node list (recursively) contain an explicit link node?
// Autolinks do not count: inside a link's text they are suppressed to
// literal text and never invalidate the outer link.
function hasLink(nodes) {
  for (const nd of nodes) {
    if (nd.k === T_LINK && !nd.auto) return true;
    if ((nd.k === T_EM || nd.k === T_STRONG || nd.k === T_DEL || nd.k === T_IMG) && nd.children && hasLink(nd.children)) return true;
  }
  return false;
}

// Demote bare-URL autolinks in a node list to plain text (a link's text
// renders a bare URL as literal text; the autolink never forms inside a
// link). Angle-bracket autolinks are NOT demoted: marked keeps them as
// nested links inside the outer link.
function demoteAutolinks(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.k === T_LINK && nd.auto && !nd.angle) {
      nodes[i] = { k: T_TEXT, s: nd.s };
    } else if ((nd.k === T_LINK || nd.k === T_IMG || nd.k === T_EM || nd.k === T_STRONG || nd.k === T_DEL) && nd.children) {
      demoteAutolinks(nd.children);
    }
  }
}

// marked's Be(): a link text containing an HTML tag or autolink that reaches
// past the end of the text invalidates the link. labelStart/labelEnd are
// source offsets of the label (without brackets).
function beCheck(s, labelStart, labelEnd) {
  for (let p = labelStart; p < labelEnd; p++) {
    if (s.charCodeAt(p) === 92) { p++; continue; }
    if (s.charCodeAt(p) === 96) {
      const cs = scanCodeSpan(s, p);
      if (cs) { p = cs.end - 1; continue; }
    }
    if (s.charCodeAt(p) !== 60) continue;
    const tagEnd = scanTag(s, p);
    if (tagEnd !== -1 && tagEnd > labelEnd) return true;
    if (tagEnd !== -1) { p = tagEnd - 1; continue; }
    const al = scanAutolink(s, p);
    if (al && al.end > labelEnd) return true;
    if (al) { p = al.end - 1; continue; }
  }
  return false;
}

// Resolve emphasis/delimiters inside one node list (recursing into links).
// marked's outermost-first m-counting: a single-delimiter em whose content
// holds a strong that opened after whitespace/punctuation and closed
// intraword (followed by a letter) never forms — the inner strong's closer
// is a group-6 run the rule of 3 defers, so m never reaches 0 at the outer
// closer (e.g. `*browser in so **change**in*` stays literal, while
// `*a **b** c*` and `*a**b**c*` do form).
// deactivate every emphasis delimiter in a node list (used when a failed
// link label must not form emphasis inside it)
function deactivateDelims(nodes) {
  for (const nd of nodes) {
    if (nd.k === T_DELIM) nd.active = false;
    if (nd.children) deactivateDelims(nd.children);
  }
}

// marked suppresses an emphasis when an earlier link in the same inline
// span has a mismatched-backtick label (`` ``X` ``) and a code span follows
// the emphasis: the label's lone backtick pairs with the code span's, so
// the emphasis never forms (e.g. `[a ``b`](u) _x y_ `c`` leaves `_x y_`
// literal, while without the link or without the code span it forms).
function hasCode(nodes) {
  for (const nd of nodes) {
    if (nd.k === T_CODE) return true;
    if (nd.children && hasCode(nd.children)) return true;
  }
  return false;
}

function emSuppressedByLink(nodes, oi, ci) {
  let hasCodeAfter = false;
  for (let k = ci + 1; k < nodes.length; k++) {
    if (nodes[k].k === T_CODE || (nodes[k].children && hasCode(nodes[k].children))) {
      hasCodeAfter = true;
      break;
    }
  }
  if (!hasCodeAfter) return false;
  for (let k = 0; k < oi; k++) {
    if (nodes[k].k !== T_LINK && nodes[k].k !== T_IMG) continue;
    const t = plainText(nodes[k].children || []);
    if (/`{2,}[^`]*`(?![`])/.test(t)) return true;
  }
  return false;
}

// marked's m-counting defers an intraword delimiter run only when the
// rule of 3 applies (y%3 && (y+b)%3==0, y = outer opener length, b =
// inner closer length); the deferred count pulls the closer's leftover
// delimiter inside the element (e.g. `**by command *tool*one***` keeps
// the trailing `*` inside the strong, while `**one***` leaves it outside).
function closerRemainderInside(children, y, ch) {
  for (let i = 0; i < children.length; i++) {
    const nd = children[i];
    if ((nd.k !== T_EM && nd.k !== T_STRONG) || nd.ch !== ch) continue;
    const b = nd.k === T_STRONG ? 2 : 1;
    if (!(y % 3) || (y + b) % 3) continue;
    const inner = nd.children || [];
    const last = inner[inner.length - 1];
    const next = children[i + 1];
    if (last && last.k === T_TEXT && /[A-Za-z0-9]$/.test(last.s) &&
        next && next.k === T_TEXT && /^[A-Za-z0-9]/.test(next.s)) return true;
  }
  return false;
}

function emBlockedByStrong(children, emCh) {
  for (let i = 0; i < children.length; i++) {
    if (children[i].k !== T_STRONG || children[i].ch !== emCh) continue;
    const prev = children[i - 1], next = children[i + 1];
    if (!prev || prev.k !== T_TEXT || !/[\s!-\/:-@\[-`{-~]$/.test(prev.s)) continue;
    if (!next || next.k !== T_TEXT || !/^[A-Za-z0-9]/.test(next.s)) continue;
    return true;
  }
  return false;
}

function processList(nodes) {
  for (const nd of nodes) {
    if ((nd.k === T_LINK || nd.k === T_IMG) && nd.children) processList(nd.children);
  }
  const delims = [];
  for (const nd of nodes) if (nd.k === T_DELIM) delims.push(nd);
  if (delims.length === 0) return;
  // delimiters still directly in this node list (not nested inside an
  // emphasis element formed earlier); only these can still match
  const avail = new Set(delims);
  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (!closer.active || !closer.close || closer.len === 0 || !avail.has(closer)) continue;
    let searchFrom = di - 1;
    let blockedOnce = false;
    while (closer.len > 0 && closer.active) {
      let opener = null;
      let openerIdx = -1;
      for (let oj = searchFrom; oj >= 0; oj--) {
        const cand = delims[oj];
        if (!cand.active || cand.len === 0 || cand.ch !== closer.ch || !cand.open) continue;
        if (!avail.has(cand)) continue; // nested inside a formed element
        if (closer.ch === 126) {
          if (cand.len !== closer.len) continue; // del needs equal lengths
        } else if ((cand.close || closer.open) && (cand.len + closer.len) % 3 === 0 &&
            !(cand.len % 3 === 0 && closer.len % 3 === 0)) {
          continue; // rule of 3
        }
        // outermost-first: a single closer must not steal one delimiter
        // from a double opener when a later double closer exists for it
        // (e.g. `**public as *so*other* option html**` — the `*` after
        // `other` must stay literal so the `**` pair forms the strong)
        if (closer.len === 1 && cand.len === 2 && closer.ch !== 126) {
          let hasDoubleCloser = false;
          for (let dk = di + 1; dk < delims.length; dk++) {
            const dc = delims[dk];
            if (dc.active && dc.close && dc.ch === closer.ch && dc.len >= 2 && avail.has(dc)) {
              hasDoubleCloser = true;
              break;
            }
          }
          if (hasDoubleCloser) continue;
        }
        opener = cand;
        openerIdx = oj;
        break;
      }
      if (!opener) {
        // no opener left: if an em was blocked for this closer, the closer
        // itself stays literal text and matches nothing else
        if (blockedOnce) { closer.active = false; avail.delete(closer); }
        break;
      }
      const oi = nodes.indexOf(opener);
      const ci = nodes.indexOf(closer);
      if (oi === -1 || ci === -1 || oi >= ci) break;
      const use = closer.ch === 126 ? opener.len
        : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
      const kind = closer.ch === 126 ? T_DEL : (use === 2 ? T_STRONG : T_EM);
      const children = nodes.slice(oi + 1, ci);
      // outermost-first m-counting: a single-delimiter em blocked by an
      // intraword-closed strong inside it must not form with THIS opener;
      // keep searching backward — an earlier double opener may still form
      // the outer strong (e.g. `**a *b **c**d* e**`)
      if (kind === T_EM && emBlockedByStrong(children, closer.ch)) {
        blockedOnce = true;
        searchFrom = openerIdx - 1;
        continue;
      }
      // a mismatched-backtick link label earlier in the span plus a code
      // span after the emphasis suppresses the emphasis entirely
      if ((kind === T_EM || kind === T_STRONG) && emSuppressedByLink(nodes, oi, ci)) {
        closer.active = false; avail.delete(closer);
        break;
      }
      const newNode = { k: kind, children, ch: closer.ch };
      opener.len -= use;
      closer.len -= use;
      const repl = [];
      if (opener.len > 0) repl.push(opener);
      repl.push(newNode);
      if (closer.len > 0) {
        // a deferred intraword run pulls the closer's leftover inside
        if (closerRemainderInside(children, use, closer.ch)) {
          newNode.children.push(closer);
          closer.active = false;
          avail.delete(closer);
        } else {
          repl.push(closer);
        }
      }
      nodes.splice(oi, ci - oi + 1, ...repl);
      // delimiters that just became children of the new element can no
      // longer match at this level
      for (const ch of children) if (ch.k === T_DELIM) avail.delete(ch);
      if (opener.len === 0) { opener.active = false; avail.delete(opener); }
      if (closer.len === 0) { closer.active = false; avail.delete(closer); }
      searchFrom = openerIdx; // the same opener's remainder may match again
    }
  }
}

function renderNodes(nodes, out) {
  for (const nd of nodes) {
    switch (nd.k) {
      case T_TEXT: out.push(nd.raw ? nd.s : escTextRun(nd.s)); break;
      case T_CODE: out.push('<code>', escFull(nd.s), '</code>'); break;
      case T_BR: out.push('<br>'); break;
      case T_HTML: out.push(nd.s); break;
      case T_LINK: {
        if (nd.auto) {
          const cleaned = cleanUrl(nd.href);
          if (cleaned === null) { out.push(escFull(nd.s)); break; }
          out.push('<a href="', escFull(cleaned), '">', escFull(nd.s), '</a>');
        } else {
          const cleaned = cleanUrl(nd.href);
          if (cleaned === null) { renderNodes(nd.children, out); break; }
          out.push('<a href="', escTextRun(cleaned), '"');
          if (nd.title) out.push(' title="', escTextRun(nd.title), '"');
          out.push('>');
          renderNodes(nd.children, out);
          out.push('</a>');
        }
        break;
      }
      case T_IMG: {
        const alt = plainText(nd.children);
        const cleaned = cleanUrl(nd.href);
        if (cleaned === null) { out.push(escTextRun(alt)); break; }
        out.push('<img src="', escTextRun(cleaned), '" alt="', escTextRun(alt), '"');
        if (nd.title) out.push(' title="', escTextRun(nd.title), '"');
        out.push('>');
        break;
      }
      case T_EM: out.push('<em>'); renderNodes(nd.children, out); out.push('</em>'); break;
      case T_STRONG: out.push('<strong>'); renderNodes(nd.children, out); out.push('</strong>'); break;
      case T_DEL: out.push('<del>'); renderNodes(nd.children, out); out.push('</del>'); break;
      case T_DELIM: out.push(String.fromCharCode(nd.ch).repeat(nd.len)); break;
      case T_BRACKET: out.push(nd.img ? '![' : '['); break;
    }
  }
}

// Document-level inLink state (marked keeps it on the shared Lexer
// state): once an inline <a> tag is seen, extended autolinks are
// suppressed for the rest of the document, until a </a> tag. Reset at
// the start of each parse() (after collectDefs, which must not affect it).
let docInLink = false;

function inlineHtml(s, refs) {
  const n = s.length;
  const nodes = [];
  const brackets = []; // {node, pos (source index of '['), img, active}
  let inLink = docInLink;
  let i = 0;
  let tb = '';
  const flush = () => {
    if (tb !== '') { nodes.push({ k: T_TEXT, s: tb, raw: false }); tb = ''; }
  };
  const pushDelim = (ch, len, open, close) => {
    if (!open && !close) { tb += String.fromCharCode(ch).repeat(len); return; }
    flush();
    nodes.push({ k: T_DELIM, ch, len, open, close, active: true });
  };

  // NOTE — scanner check order (load-bearing, not cosmetic): backslash
  // escapes are consumed first, so an escaped `\*` never becomes an emphasis
  // delimiter and `\`` never opens a code span; code spans come next, so a
  // `*` inside backticks stays literal text and never becomes a delimiter
  // either. Only after those two do emphasis / strikethrough delimiters,
  // hard breaks, and URL / email autolink attempts get a look — the same
  // order marked's inline lexer applies, and reordering any of these
  // branches would change the output on inputs that mix the three.
  // The `<` branch (inline tag first, then autolink) sits between the
  // code-span branch and the bracket opener, and the emphasis /
  // strikethrough branch only comes after the `]` closer, so a `*` inside
  // a link label is still scanned as a delimiter before the label closes.
  while (i < n) {
    const c = s.charCodeAt(i);
    // backslash: hard break, escape, or literal
    if (c === 92) {
      const d = i + 1 < n ? s.charCodeAt(i + 1) : -1;
      if (d === 10) {
        // backslash + newline: hard break unless only whitespace follows
        let k = i + 2;
        while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
        if (k < n) {
          flush();
          nodes.push({ k: T_BR });
          i += 2;
          while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
          continue;
        }
        tb += '\\';
        i++;
        continue;
      }
      if (d >= 0 && d < 128 && ASCII_PUNCT[d] === 1) {
        flush();
        nodes.push({ k: T_TEXT, s: s[i + 1], raw: false });
        i += 2;
        continue;
      }
      tb += '\\';
      i++;
      continue;
    }
    // code span
    if (c === 96) {
      // inside a link label, a mismatched backtick pair (`` ``X` ``) right
      // before the label's ']' is literal text, not a code span — marked's
      // label regex consumes it as part of the label and the link then
      // forms with the backticks literal. Genuine code spans have matching
      // run lengths and still form.
      let inBracket = false;
      for (let bi = brackets.length - 1; bi >= 0; bi--) {
        if (brackets[bi].active) { inBracket = true; break; }
      }
      if (inBracket) {
        let openRun = 0;
        while (i + openRun < n && s.charCodeAt(i + openRun) === 96) openRun++;
        let j = i + openRun;
        while (j < n && s.charCodeAt(j) !== 96 && s.charCodeAt(j) !== 93) j++;
        if (j < n && s.charCodeAt(j) === 96) {
          let k = j;
          while (k < n && s.charCodeAt(k) === 96) k++;
          const closeRun = k - j;
          // the closing run need not sit right before ']': text may
          // follow inside the label (`` ``guide` in] ``) — what matters
          // is that a ']' closes the label before any other backtick
          // or '[' appears
          if (closeRun !== openRun) {
            let m = k;
            while (m < n && s.charCodeAt(m) !== 96 && s.charCodeAt(m) !== 91 && s.charCodeAt(m) !== 93) m++;
            if (m < n && s.charCodeAt(m) === 93) {
              tb += s.slice(i, k);
              i = k;
              continue;
            }
          }
        }
      }
      let cs = scanCodeSpan(s, i);
      // inside a link label, a multi-backtick code span that crosses a
      // newline and swallows the label's ']' (its content holds '](' or
      // '][') is bogus: marked matches the link first, so the label's
      // backticks never span out of it. Single-backtick spans (e.g.
      // `[not a `link](/foo`)`) and spans without a newline are genuine
      // and still form. When the bogus span is rejected, skip past the
      // whole label backtick pattern (`` ``url` ``) as literal text, so
      // its closing backtick cannot start a span of its own.
      if (cs && inBracket) {
        let run = 0;
        while (i + run < n && s.charCodeAt(i + run) === 96) run++;
        if (run >= 2 && cs.text.includes('\n') &&
            (cs.text.includes('](') || cs.text.includes(']['))) {
          let j = i + run;
          while (j < n && s.charCodeAt(j) !== 96) j++;
          if (j < n) {
            let k = j;
            while (k < n && s.charCodeAt(k) === 96) k++;
            tb += s.slice(i, k);
            i = k;
            continue;
          }
          cs = null;
        }
      }
      if (cs) {
        let text = cs.text.replace(/\n/g, ' ');
        if (text.length > 0 && text[0] === ' ' && text[text.length - 1] === ' ' && /[^ ]/.test(text)) {
          text = text.slice(1, -1);
        }
        flush();
        nodes.push({ k: T_CODE, s: text });
        i = cs.end;
        continue;
      }
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      tb += s.slice(i, j);
      i = j;
      continue;
    }
    // '<': inline tag, then autolink
    if (c === 60) {
      const tagEnd = scanTag(s, i);
      if (tagEnd !== -1) {
        const tag = s.slice(i, tagEnd);
        flush();
        if (/^<a /i.test(tag)) inLink = true;
        else if (/^<\/a>/i.test(tag)) inLink = false;
        docInLink = inLink;
        nodes.push({ k: T_HTML, s: tag });
        i = tagEnd;
        continue;
      }
      const al = scanAutolink(s, i);
      if (al) {
        flush();
        nodes.push({ k: T_LINK, href: al.href, title: null, auto: true, angle: true, s: al.text, children: null });
        i = al.end;
        continue;
      }
      tb += '<';
      i++;
      continue;
    }
    // '[' or '![': bracket opener
    if (c === 91 || (c === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91)) {
      const img = c === 33;
      const bpos = img ? i + 1 : i;
      flush();
      const bnode = { k: T_BRACKET, img };
      nodes.push(bnode);
      brackets.push({ node: bnode, pos: bpos, img, active: true });
      i = bpos + 1;
      continue;
    }
    // ']': try to close the nearest active bracket
    if (c === 93) {
      // find the top active bracket
      let bi = brackets.length - 1;
      while (bi >= 0 && !brackets[bi].active) bi--;
      if (bi < 0) { tb += ']'; i++; continue; }
      const br = brackets[bi];
      flush();
      const bidx = nodes.indexOf(br.node);
      const children = nodes.slice(bidx + 1);
      // the label for lookup is the raw source text between the brackets
      // (backslashes kept, matching how definitions store theirs)
      const labelStart = br.pos + 1;
      const labelEnd = i;
      const label = s.slice(labelStart, labelEnd);
      let formed = null;
      let end = -1;
      const dest = scanInlineDest(s, i);
      // the label must match marked's label regex: a code span whose
      // content holds a backtick truncates the label, so no link forms
      const labelOk = labelBackticksOk(s, labelStart, labelEnd);
      if (dest && labelOk && !beCheck(s, labelStart, labelEnd)) {
        formed = { href: dest.href, title: dest.title };
        end = dest.end;
      } else {
        // reference link [text][ref] or [text][]
        let ref = null;
        let refEnd = -1;
        let hadRefLabel = false;
        if (i + 1 < n && s.charCodeAt(i + 1) === 91) {
          const rl = scanRefLabel(s, i + 1);
          if (rl) { ref = rl.label === '' ? label : rl.label; refEnd = rl.end; hadRefLabel = true; }
        }
        if (ref !== null && refs) {
          const found = refs.get(normLabel(ref));
          if (found && labelOk && !beCheck(s, labelStart, labelEnd)) {
            formed = { href: found.href, title: found.title };
            end = refEnd;
          }
        }
        // a bracket followed by a ref label can only be a full
        // reference; it never falls back to a shortcut link
        if (!formed && !hadRefLabel && refs) {
          const found = refs.get(normLabel(label));
          if (found && labelOk && !beCheck(s, labelStart, labelEnd)) {
            formed = { href: found.href, title: found.title };
            end = i + 1;
          }
        }
      }
      if (formed) {
        if (!br.img && hasLink(children)) {
          // a link cannot contain a link: fail, deactivate this bracket
          br.active = false;
          tb += ']';
          i++;
          continue;
        }
        // any autolink inside the text is literal text, not a link
        demoteAutolinks(children);
        const linkNode = br.img
          ? { k: T_IMG, href: formed.href, title: formed.title, children }
          : { k: T_LINK, href: formed.href, title: formed.title, auto: false, s: null, children };
        nodes.splice(bidx, nodes.length - bidx, linkNode);
        // deactivate only the bracket that formed the link; outer brackets
        // stay active (a link inside them makes them fail later via hasLink)
        br.active = false;
        i = end;
        continue;
      }
      // no link: deactivate this bracket, ']' is literal text.
      // When the label holds a code span with an inner backtick AND an
      // inline dest follows, marked also leaves the label's emphasis
      // delimiters literal (the failed link swallows them)
      if (!labelOk && dest) deactivateDelims(children);
      br.active = false;
      tb += ']';
      i++;
      continue;
    }
    // emphasis / strikethrough delimiters
    if (c === 42 || c === 95) {
      const { len, open, close } = delimRun(s, i, c);
      pushDelim(c, len, open, close);
      i += len;
      continue;
    }
    if (c === 126) {
      let len = 0;
      while (i + len < n && s.charCodeAt(i + len) === 126) len++;
      if (len <= 2) {
        const before = i - 1 >= 0 ? s.charCodeAt(i - 1) : -1;
        const after = i + len < n ? s.charCodeAt(i + len) : -1;
        const beforeSpace = before === -1 || isSpace(before);
        const afterSpace = after === -1 || isSpace(after);
        const beforePunct = before !== -1 && isPunct(before);
        const afterPunct = after !== -1 && isPunct(after);
        const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
        const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
        // del opens only when followed by a non-space, non-~ char
        const open = leftFlanking && after !== -1 && after !== 126 && !afterSpace;
        const close = rightFlanking;
        pushDelim(126, len, open, close);
      } else {
        tb += s.slice(i, i + len);
      }
      i += len;
      continue;
    }
    // hard break: 2+ spaces + newline (not at end)
    if (c === 32) {
      let j = i;
      while (j < n && s.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && j < n && s.charCodeAt(j) === 10) {
        let k = j + 1;
        while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
        if (k < n) {
          flush();
          nodes.push({ k: T_BR });
          i = j + 1;
          while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
          continue;
        }
      }
      // plain text run (stops at specials / url starts / br); a run
      // of length 0 (e.g. trailing spaces before only whitespace)
      // still consumes one character so the loop always advances
      const tj = scanTextRun(s, i, n, inLink);
      if (tj === i) { tb += s[i]; i++; }
      else { tb += s.slice(i, tj); i = tj; }
      continue;
    }
    // newline inside inline text stays a literal newline
    if (c === 10) { tb += '\n'; i++; continue; }
    // url / email attempt, else text
    if (!inLink) {
      // the ']' that closes the innermost active '[' bracket whose
      // text contains this URL ends the URL; any other ']' is part
      // of it. A bracket whose content already holds a link cannot
      // form a link, so its ']' must not stop the URL.
      let bracketEnd = -1;
      for (let bi = brackets.length - 1; bi >= 0; bi--) {
        if (!brackets[bi].active) continue;
        const be = scanBracketEnd(s, brackets[bi].pos);
        if (be <= i) continue;
        const ni = nodes.indexOf(brackets[bi].node);
        if (ni !== -1 && hasLink(nodes.slice(ni + 1))) continue;
        bracketEnd = be;
        break;
      }
      const url = scanUrl(s, i, bracketEnd);
      if (url) {
        flush();
        nodes.push({ k: T_LINK, href: url.href, title: null, auto: true, s: url.text, children: null });
        i = url.end;
        continue;
      }
    }
    const tj2 = scanTextRun(s, i, n, inLink);
    // a run of length 0 (e.g. a bare '!' not followed by '[') still
    // consumes one character so the loop always advances
    if (tj2 === i) { tb += s[i]; i++; }
    else { tb += s.slice(i, tj2); i = tj2; }
  }
  flush();
  processList(nodes);
  const out = [];
  renderNodes(nodes, out);
  return out.join('');
}

// Scan a plain-text run starting at i. Stops before any token start or
// before a position where scanUrl would match (www./mailto: only when the
// previous char is a boundary — start, whitespace, or one of * _ ~ ( < —
// scheme:// and email autolinks match anywhere). Returns the new index;
// the caller appends s.slice(i, returned). Single forward pass: no
// indexOf over the remainder, so long documents stay linear.
function scanTextRun(s, i, n, inLink) {
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c < 128 && SPECIAL[c] === 1) break;
    if (c === 32) {
      let k = j;
      while (k < n && s.charCodeAt(k) === 32) k++;
      if (k - j >= 2 && k < n && s.charCodeAt(k) === 10) break;
      j = k;
      continue;
    }
    if (!inLink) {
      if (c === 119 && s.startsWith('www.', j)) {
        const prev = j === 0 ? -1 : s.charCodeAt(j - 1);
        if ((prev === -1 || isSpace(prev) || prev === 42 || prev === 95 || prev === 126 || prev === 40 || prev === 60)
            && scanUrl(s, j)) break;
      } else if ((c === 109 && s.startsWith('mailto:', j)) || (c === 120 && s.startsWith('xmpp:', j))) {
        const prev = j === 0 ? -1 : s.charCodeAt(j - 1);
        if ((prev === -1 || isSpace(prev) || prev === 42 || prev === 95 || prev === 126 || prev === 40 || prev === 60)
            && scanUrl(s, j)) break;
      } else if (c === 64) {
        // '@': the email's local part starts at the run of local-part
        // chars just before it (never before the run start)
        let q = j - 1;
        while (q >= i && isLocalPartChar(s.charCodeAt(q))) q--;
        const cand = q + 1;
        if (cand < j && scanUrl(s, cand)) return cand;
      } else if (c === 58 && j + 2 < n && s.charCodeAt(j + 1) === 47 && s.charCodeAt(j + 2) === 47) {
        // '://': scheme name is the run of scheme chars just before it
        let q = j - 1;
        while (q >= i) {
          const d = s.charCodeAt(q);
          if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) ||
              d === 43 || d === 46 || d === 45) q--;
          else break;
        }
        const cand = q + 1;
        if (j - cand >= 2 && j - cand <= 32 && scanUrl(s, cand)) return cand;
      }
    }
    j++;
  }
  return j;
}

// ---------------------------------------------------------------------------
// Block parsing.
// Lines are processed with column-aware tab handling: a tab advances to the
// next multiple of 4 columns for indentation, but tabs inside content are
// preserved verbatim. A line whose leading whitespace is <= 3 columns is
// spaces only (any tab makes the indent >= 4), so slice(ind) is exact there.
// ---------------------------------------------------------------------------

function indentCols(line, base) {
  base = base || 0;
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - ((base + col) % 4);
    else break;
  }
  return col;
}

// Remove n columns of leading whitespace; a tab straddling the boundary
// becomes the spaces that remain of it. `base` is the absolute column at
// which the string starts (tabs widen to the next multiple of 4 in
// absolute columns).
function stripCols(line, n, base) {
  base = base || 0;
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - ((base + col) % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

// Remove n columns from the start of a line, counting every character as
// one column except a tab, which widens to the next multiple of 4 in
// absolute columns. Unlike stripCols this also removes non-whitespace
// (used for list markers).
function stripPrefixCols(line, n, base) {
  base = base || 0;
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 9) {
      const w = 4 - ((base + col) % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + line.slice(i + 1);
    } else { col++; i++; }
  }
  return line.slice(i);
}

// Expand tabs in the leading whitespace of `line` to spaces, where the
// line starts at absolute column `base`. Tabs after the first
// non-whitespace character are preserved verbatim. Used when a line is
// extracted into a container (blockquote / list item): from then on the
// line's columns are counted from its own start.
function expandLeadingTabs(line, base) {
  let i = 0;
  let col = base || 0;
  let out = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else break;
  }
  return out + line.slice(i);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ATX heading on a line already stripped of <= 3 indent. Returns
// {level, text} or null.
function matchAtx(s) {
  let level = 0;
  while (level < s.length && s.charCodeAt(level) === 35) level++;
  if (level === 0 || level > 6) return null;
  if (level < s.length) {
    const c = s.charCodeAt(level);
    if (c !== 32 && c !== 9) return null;
  }
  let text = s.slice(level);
  // closing sequence: spaces + hashes at the end (the space before the
  // hashes is part of the sequence, so check before trimming)
  const m = /[ \t]+#+[ \t]*$/.exec(text);
  if (m) text = text.slice(0, m.index);
  text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level, text };
}

// Fenced code opener on a stripped line. Returns {ch, len, info} or null.
function matchFence(s) {
  const ch = s.charCodeAt(0);
  if (ch !== 96 && ch !== 126) return null;
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === ch) i++;
  if (i < 3) return null;
  const info = s.slice(i);
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  return { ch, len: i, info: info.trim() };
}

// Thematic break on a stripped line.
function isHr(s) {
  if (s.length < 3) return false;
  const ch = s.charCodeAt(0);
  if (ch !== 42 && ch !== 45 && ch !== 95) return false;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

// Setext underline on a stripped line: 1 for '=', 2 for '-', else 0.
// A run of one character, then only spaces/tabs to the end of the line.
function matchSetext(s) {
  if (s.length === 0) return 0;
  const ch = s.charCodeAt(0);
  if (ch !== 61 && ch !== 45) return 0;
  let i = 1;
  while (i < s.length && s.charCodeAt(i) === ch) i++;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return 0;
    i++;
  }
  return ch === 61 ? 1 : 2;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block start on a stripped line. Returns the block type (1-7) and,
// for type 1, the tag name; 0 when the line starts no HTML block.
// Type 7 additionally requires the tag to be alone on the line.
function matchHtmlBlock(s) {
  if (s.charCodeAt(0) !== 60) return { type: 0, name: null }; // '<'
  const lower = s.toLowerCase();
  for (const name of ['script', 'pre', 'style', 'textarea']) {
    if (lower.startsWith('<' + name)) {
      const ai = 1 + name.length;
      const after = ai >= s.length ? -1 : s.charCodeAt(ai);
      if (after === -1 || after === 32 || after === 9 || after === 62) return { type: 1, name };
    }
  }
  if (s.startsWith('<!--')) return { type: 2, name: null };
  if (s.startsWith('<?')) return { type: 3, name: null };
  if (s.startsWith('<!')) {
    const c = s.charCodeAt(2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return { type: 4, name: null };
    if (s.startsWith('<![CDATA[')) return { type: 5, name: null };
    return { type: 0, name: null };
  }
  // open or close tag: parse the tag name
  let j = 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) { closing = true; j++; }
  const nameStart = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (j === nameStart) return { type: 0, name: null };
  const name = s.slice(nameStart, j).toLowerCase();
  const after = j >= s.length ? -1 : s.charCodeAt(j);
  if (BLOCK_TAGS.has(name)) {
    if (after === -1 || after === 32 || after === 9 || after === 62 || after === 47) {
      return { type: 6, name: null };
    }
    return { type: 0, name: null };
  }
  // type 7: any other complete tag, alone on the line
  if (!closing || true) {
    const tagEnd = scanTag(s, 0);
    if (tagEnd !== -1) {
      let k = tagEnd;
      while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
      if (k === s.length) return { type: 7, name: null };
    }
  }
  return { type: 0, name: null };
}

// Fenced code block starting at lines[i] (fence already matched).
// Returns the index of the first line after the block.
function parseFencedCode(lines, i, end, fence, out) {
  // marked's indent compensation (Dt) is CHARACTER-based, not
  // column-based: it removes min(len(content leading whitespace),
  // len(fence leading whitespace)) characters from each content
  // line — so a leading tab is removed whole when the fence has any
  // indent. It applies ONLY to backtick fences (its regex is
  // /^(\s+)(?:```)/); a tilde fence keeps the content indent.
  const fenceLine = lines[i];
  let fenceWsLen = 0;
  if (fence.ch === 96) {
    while (fenceWsLen < fenceLine.length &&
        (fenceLine.charCodeAt(fenceWsLen) === 32 || fenceLine.charCodeAt(fenceWsLen) === 9)) fenceWsLen++;
  }
  const content = [];
  let j = i + 1;
  while (j < end) {
    const line = lines[j];
    const ind = indentCols(line);
    if (ind <= 3) {
      const s = line.slice(ind);
      let k = 0;
      while (k < s.length && s.charCodeAt(k) === fence.ch) k++;
      if (k >= fence.len) {
        let rest = true;
        for (let q = k; q < s.length; q++) {
          const c = s.charCodeAt(q);
          if (c !== 32 && c !== 9) { rest = false; break; }
        }
        if (rest) break;
      }
    }
    // a content line loses min(its leading whitespace, the fence's
    // leading whitespace) characters (backtick fences only)
    let ws = 0;
    while (ws < line.length && (line.charCodeAt(ws) === 32 || line.charCodeAt(ws) === 9)) ws++;
    content.push(line.slice(Math.min(ws, fenceWsLen)));
    j++;
  }
  let lang = '';
  if (fence.info) {
    const sp = fence.info.search(/[ \t]/);
    lang = unescapePunct(sp === -1 ? fence.info : fence.info.slice(0, sp));
  }
  // trailing newline: added unless the last content line is exactly ""
  let text = content.join('\n');
  if (content.length && content[content.length - 1] !== '') text += '\n';
  out.push('<pre><code' + (lang ? ' class="language-' + escTextRun(lang) + '"' : '') + '>' + escFull(text) + '</code></pre>\n');
  return j + 1 <= end ? j + 1 : end;
}

// Indented code block starting at lines[i] (indent >= 4).
// Returns the index of the first line after the block.
function parseIndentedCode(lines, i, end, out) {
  const content = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) {
      // include the blank only if a later indented line follows
      let k = j + 1;
      while (k < end && isBlank(lines[k])) k++;
      if (k < end && indentCols(lines[k]) >= 4) {
        // a blank line inside the block keeps its content after the
        // 4-column strip (a line of 6 spaces becomes "  ")
        while (j < k) { content.push(stripCols(lines[j], 4)); j++; }
        continue;
      }
      break;
    }
    if (indentCols(line) >= 4) { content.push(stripCols(line, 4)); j++; continue; }
    break;
  }
  out.push('<pre><code>' + escFull(content.join('\n') + '\n') + '</code></pre>\n');
  return j;
}

// HTML block starting at lines[i]. html is {type, name} from matchHtmlBlock.
// Returns the index of the first line after the block.
function parseHtmlBlock(lines, i, end, html, eofNL, out) {
  let j = i;
  let text;
  if (html.type === 1) {
    const re = new RegExp('</' + html.name + '[ \\t]*>', 'i');
    while (j < end) {
      const line = lines[j];
      j++;
      if (re.test(line)) break;
    }
    text = lines.slice(i, j).join('\n');
    // trailing newline when the next line is not a truly empty line
    // (a whitespace-only line still counts — only "" suppresses it),
    // or the block runs to EOF in a document ending with a newline
    if (j < end ? lines[j] !== '' : eofNL) text += '\n';
  } else if (html.type === 2 || html.type === 3 || html.type === 4 || html.type === 5) {
    const ender = html.type === 2 ? '-->' : html.type === 3 ? '?>' : html.type === 4 ? '>' : ']]>';
    while (j < end) {
      const line = lines[j];
      j++;
      if (line.indexOf(ender) !== -1) break;
    }
    text = lines.slice(i, j).join('\n');
    if (j < end ? lines[j] !== '' : eofNL) text += '\n';
  } else {
    // types 6-7: run to the blank line or EOF; the block ends at a
    // blank line, so there is never a trailing newline mid-document
    // (only at EOF when the document ends with a newline)
    while (j < end && !isBlank(lines[j])) j++;
    text = lines.slice(i, j).join('\n');
    if (j >= end && eofNL) text += '\n';
  }
  out.push(text);
  return j;
}

// ---------------------------------------------------------------------------
// Link reference definitions.
// A definition may span up to 3 lines: [label]: <dest> "title", with the
// destination and/or the title on following lines. The first definition of
// a label wins. Returns the number of lines consumed, or 0 if lines[i] is
// not a definition.
// ---------------------------------------------------------------------------

function tryParseDef(lines, i, end, refs) {
  const line = lines[i];
  const ind = indentCols(line);
  if (ind > 3) return 0;
  if (line.charCodeAt(ind) !== 91) return 0; // '['
  // label (may span lines; the newlines collapse to spaces when matching)
  let labelRaw = '';
  let labelEndLi = -1;
  let labelEndPos = -1;
  {
    let li = i;
    let p = ind + 1;
    let ok = false;
    while (li < end) {
      const s = lines[li];
      while (p < s.length) {
        const c = s.charCodeAt(p);
        if (c === 92) { // backslash escape (may escape the newline)
          if (p + 1 < s.length) { labelRaw += s[p] + s[p + 1]; p += 2; }
          else { labelRaw += '\\\n'; p++; }
          continue;
        }
        if (c === 91) return 0; // '[' inside a label
        if (c === 93) { labelEndLi = li; labelEndPos = p + 1; ok = true; break; }
        labelRaw += s[p];
        p++;
      }
      if (ok) break;
      // end of line: the label may continue on the next line
      if (li + 1 >= end) return 0;
      if (isBlank(lines[li + 1])) return 0;
      if (!labelRaw.endsWith('\\\n')) labelRaw += '\n';
      li++;
      p = 0;
    }
    if (!ok) return 0;
  }
  if (labelRaw.length === 0 || labelRaw.length > 999) return 0;
  // a label must contain at least one non-whitespace character
  if (normLabel(labelRaw) === '') return 0;
  // the ':' must follow the ']' on the same line
  const endLine = lines[labelEndLi];
  if (labelEndPos >= endLine.length || endLine.charCodeAt(labelEndPos) !== 58) return 0; // ':'
  // absolute (line, offset) position from here on
  let li = labelEndLi;
  let pos = labelEndPos + 1;
  const skipWsLine = () => {
    const s = lines[li];
    while (pos < s.length && (s.charCodeAt(pos) === 32 || s.charCodeAt(pos) === 9)) pos++;
  };
  skipWsLine();
  if (pos >= lines[li].length) {
    // destination on the next line (any indent)
    if (li + 1 >= end) return 0;
    const nl = lines[li + 1];
    if (isBlank(nl)) return 0;
    li++;
    pos = 0;
    skipWsLine();
    if (pos >= lines[li].length) return 0;
  }
  // destination (single line)
  const s = lines[li];
  let href;
  if (s.charCodeAt(pos) === 60) { // '<'
    let k = pos + 1;
    let ok = false;
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === 62) { ok = true; break; }
      if (c === 60 || c === 10) return 0;
      k++;
    }
    if (!ok) return 0;
    href = s.slice(pos + 1, k);
    pos = k + 1;
  } else {
    let k = pos;
    let depth = 0;
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    if (depth > 0 || k === pos) return 0;
    href = s.slice(pos, k);
    pos = k;
  }
  href = unescapePunct(href);
  // optional title, on the same line or the next (it may span lines)
  let title = null;
  const savePos = pos;
  skipWsLine();
  const hadWs = pos > savePos;
  if (pos < lines[li].length) {
    // a title on the same line must be preceded by whitespace
    if (!hadWs) return 0;
    const t = parseTitleAcross(lines, li, pos, end);
    if (!t) return 0;
    title = t.title;
    const tail = lines[t.endLi].slice(t.endPos);
    if (!/^[ \t]*$/.test(tail)) return 0;
    li = t.endLi;
  } else {
    // title on the next line (any indent); optional
    if (li + 1 < end) {
      const nl = lines[li + 1];
      if (!isBlank(nl)) {
        let p = 0;
        while (p < nl.length && (nl.charCodeAt(p) === 32 || nl.charCodeAt(p) === 9)) p++;
        if (p < nl.length) {
          const t = parseTitleAcross(lines, li + 1, p, end);
          if (t) {
            const tail = lines[t.endLi].slice(t.endPos);
            if (/^[ \t]*$/.test(tail)) { title = t.title; li = t.endLi; }
          }
        }
      }
    }
  }
  const key = normLabel(labelRaw);
  if (!refs.has(key)) refs.set(key, { href, title });
  return li - i + 1;
}

// Title starting at lines[li][pos]: "..." or '...' or (...). A title may
// span lines (newlines are kept in the title text). Returns
// {title, endLi, endPos} or null. endPos is the offset just past the
// closing quote in lines[endLi].
function parseTitleAcross(lines, li, pos, end) {
  const first = lines[li];
  const q = first.charCodeAt(pos);
  if (q !== 34 && q !== 39 && q !== 40) return null;
  const close = q === 40 ? 41 : q;
  let title = '';
  let cur = li;
  let line = first;
  let k = pos + 1;
  while (true) {
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (c === 92) {
        if (k + 1 < line.length) { title += line[k] + line[k + 1]; k += 2; }
        else { title += line[k]; k++; } // backslash at EOL: escapes the newline
        continue;
      }
      if (c === close) return { title: unescapePunct(title), endLi: cur, endPos: k + 1 };
      if (q === 40 && c === 40) return null; // unescaped '(' inside a (...) title
      title += line[k];
      k++;
    }
    if (cur + 1 >= end) return null;
    const nl = lines[cur + 1];
    if (isBlank(nl)) return null;
    title += '\n';
    cur++;
    line = nl;
    k = 0;
  }
}

// Consume consecutive definitions starting at lines[i].
function tryDefs(lines, i, end, refs) {
  let used = 0;
  while (i + used < end) {
    const d = tryParseDef(lines, i + used, end, refs);
    if (d === 0) break;
    used += d;
  }
  return used;
}

// ---------------------------------------------------------------------------
// Tables (GFM). The delimiter row must be valid and contain at least one
// pipe; the header row's cells set the column count.
// ---------------------------------------------------------------------------

// Split a delimiter row into alignments, or null if it is not one.
function splitDelim(d) {
  let s = d.replace(/^[ \t]+|[ \t]+$/g, '');
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.length && s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
  if (s.length === 0) return null;
  const parts = s.split('|');
  const out = [];
  for (const p of parts) {
    const c = p.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!/^:?-+:?$/.test(c)) return null;
    out.push(c.charCodeAt(0) === 58 ? (c.charCodeAt(c.length - 1) === 58 ? 'center' : 'left')
      : c.charCodeAt(c.length - 1) === 58 ? 'right' : null);
  }
  return out;
}

// Split a table row into cells on unescaped pipes, dropping one empty
// cell for a leading pipe and one for a trailing pipe.
function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < line.length) { cur += line[i] + line[i + 1]; i++; continue; }
    if (c === 124) { cells.push(cur); cur = ''; continue; }
    cur += line[i];
  }
  cells.push(cur);
  if (cells.length > 1 && cells[0].replace(/^[ \t]+|[ \t]+$/g, '') === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].replace(/^[ \t]+|[ \t]+$/g, '') === '') cells.pop();
  return cells;
}

function trimCell(s) {
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

// Try a table starting at lines[i]. Returns lines consumed, or 0.
function tryTable(lines, i, end, refs, out) {
  if (i + 1 >= end) return 0;
  const header = lines[i];
  const delimLine = lines[i + 1];
  if (indentCols(header) > 3 || indentCols(delimLine) > 3) return 0;
  const d = delimLine.slice(indentCols(delimLine));
  if (d.indexOf('|') === -1) return 0;
  const aligns = splitDelim(d);
  if (!aligns) return 0;
  const headerCells = splitRow(header.slice(indentCols(header)));
  // the delimiter row must have exactly as many cells as the header
  if (aligns.length !== headerCells.length) return 0;
  let j = i + 2;
  const rows = [];
  while (j < end) {
    const line = lines[j];
    // a body row ends at a line of only spaces (marked's table regex
    // excludes ` *\n`); a tab-only line is NOT blank here — it is a
    // row of empty cells
    if (/^ *$/.test(line)) break;
    // an indented code line ends the table (marked's `code` in the
    // table regex: (?: {4}| {0,3}\t) followed by a non-newline char)
    let p = 0;
    while (p < line.length && line.charCodeAt(p) === 32 && p < 4) p++;
    const isCode = p === 4
      ? line.length > 4
      : (p < line.length && line.charCodeAt(p) === 9 && line.length > p + 1);
    if (isCode) break;
    const ind = indentCols(line);
    if (ind < 4) {
      const c = line.slice(ind);
      if (matchAtx(c) || matchFence(c) || isHr(c) || c.charCodeAt(0) === 62) break;
      if (matchListMarkerAt(line)) break;
      const hb = matchHtmlBlock(c);
      if (hb.type > 0 && hb.type < 7) break;
    }
    rows.push(line);
    j++;
  }
  out.push('<table>\n<thead>\n<tr>\n');
  for (let k = 0; k < headerCells.length; k++) {
    const al = aligns[k];
    out.push('<th' + (al ? ' align="' + al + '"' : '') + '>' + inlineHtml(trimCell(headerCells[k]).replace(/\\\|/g, '|'), refs) + '</th>\n');
  }
  out.push('</tr>\n</thead>\n');
  if (rows.length) {
    out.push('<tbody>');
    for (const row of rows) {
      const cells = splitRow(row);
      out.push('<tr>\n');
      for (let k = 0; k < headerCells.length; k++) {
        const cell = k < cells.length ? cells[k] : '';
        const al = aligns[k];
        out.push('<td' + (al ? ' align="' + al + '"' : '') + '>' + inlineHtml(trimCell(cell).replace(/\\\|/g, '|'), refs) + '</td>\n');
      }
      out.push('</tr>\n');
    }
    out.push('</tbody>');
  }
  out.push('</table>\n');
  return j - i;
}

// ---------------------------------------------------------------------------
// Paragraphs, blockquotes, lists.
// ---------------------------------------------------------------------------

// Does this line start a block that can interrupt a paragraph? (Line is
// already known to have indent < 4.)
function startsInterruptBlock(c) {
  if (matchAtx(c) || matchFence(c) || isHr(c)) return true;
  if (c.charCodeAt(0) === 62) return true;
  if (matchListMarkerAt(c)) return true;
  const hb = matchHtmlBlock(c);
  return hb.type > 0 && hb.type < 7;
}

// Would lexing this line as the start of a block leave a paragraph open
// at its end? Used to decide whether a lazy continuation line may follow
// inside a container (blockquote / list item).
function firstLineOpensParagraph(line) {
  if (isBlank(line)) return false;
  const ind = indentCols(line);
  if (ind >= 4) return false;
  const c = line.slice(ind);
  if (matchSetext(c)) return false;
  if (matchAtx(c) || matchFence(c) || isHr(c)) return false;
  if (c.charCodeAt(0) === 62) {
    const rest = c.length > 1 ? stripCols(c.slice(1), 1, ind + 1) : '';
    return firstLineOpensParagraph(rest);
  }
  const hb = matchHtmlBlock(c);
  if (hb.type > 0 && hb.type < 7) return false;
  const lm = matchListMarkerAt(line);
  if (lm) {
    if (lm.firstContent === '') return false;
    return firstLineOpensParagraph(lm.firstContent);
  }
  return true;
}

// May this line be a lazy continuation of an open paragraph inside a
// container? (Setext underlines and table delimiter rows qualify.)
// Is `s` a closing fence for a fence of char `ch` and length `len`?
// (indent <= 3, a run of `ch` of length >= len, nothing but spaces after)
function isClosingFence(s, ch, len) {
  const ind = indentCols(s);
  if (ind > 3) return false;
  const f = matchFence(s.slice(ind));
  return !!(f && f.ch === ch && f.len >= len && f.info === '');
}

// While inside a fenced code block, a line is a paragraph opener only
// when it is not a fence line and not code content. `st` is [ch, len]
// (0,0) when not in a fence; returns whether the line opens a paragraph
// and updates the state in place.
function trackFenceLine(s, st) {
  if (st[0]) {
    if (isClosingFence(s, st[0], st[1])) { st[0] = 0; st[1] = 0; }
    return false;
  }
  const ind = indentCols(s);
  if (ind <= 3) {
    const f = matchFence(s.slice(ind));
    if (f) { st[0] = f.ch; st[1] = f.len; return false; }
  }
  return firstLineOpensParagraph(s);
}

function isLazyCandidate(line) {
  if (isBlank(line)) return false;
  const ind = indentCols(line);
  if (ind >= 4) return true;
  const c = line.slice(ind);
  if (matchAtx(c) || matchFence(c) || isHr(c)) return false;
  if (c.charCodeAt(0) === 62) return false;
  if (matchListMarkerAt(line)) return false;
  const hb = matchHtmlBlock(c);
  if (hb.type > 0 && hb.type < 7) return false;
  return true;
}

// List marker at the start of a line. Returns null, or
// {ordered, delim, num, contentIndent, firstContent} with contentIndent in
// absolute columns from the line start.
function matchListMarkerAt(line) {
  const ind = indentCols(line);
  if (ind > 3) return null;
  const s = line.slice(ind);
  const c0 = s.charCodeAt(0);
  let markerWidth, ordered, delim, num = 0;
  if (c0 === 42 || c0 === 43 || c0 === 45) {
    markerWidth = 1; ordered = false; delim = String.fromCharCode(c0);
  } else if (c0 >= 48 && c0 <= 57) {
    let d = 0;
    while (d < s.length && s.charCodeAt(d) >= 48 && s.charCodeAt(d) <= 57) d++;
    if (d === 0 || d > 9) return null;
    const dc = s.charCodeAt(d);
    if (dc !== 46 && dc !== 41) return null;
    num = parseInt(s.slice(0, d), 10);
    markerWidth = d + 1; ordered = true; delim = String.fromCharCode(dc);
  } else return null;
  if (markerWidth >= s.length) {
    return { ordered, delim, num, contentIndent: ind + markerWidth + 1, firstContent: '' };
  }
  const c1 = s.charCodeAt(markerWidth);
  if (c1 !== 32 && c1 !== 9) return null;
  let col = ind + markerWidth;
  let p = markerWidth;
  while (p < s.length) {
    const c = s.charCodeAt(p);
    if (c === 32) { col++; p++; }
    else if (c === 9) { col += 4 - (col % 4); p++; }
    else break;
  }
  const spaces = col - (ind + markerWidth);
  if (p >= s.length) {
    return { ordered, delim, num, contentIndent: ind + markerWidth + 1, firstContent: '' };
  }
  if (spaces >= 5) {
    const ci = ind + markerWidth + 1;
    return { ordered, delim, num, contentIndent: ci, firstContent: expandLeadingTabs(stripPrefixCols(line, ci), ci) };
  }
  return { ordered, delim, num, contentIndent: col, firstContent: expandLeadingTabs(stripPrefixCols(line, col), col) };
}

// Paragraph starting at lines[i]. Returns the index after the paragraph
// (and after a setext underline, if any).
// Extent of a paragraph starting at lines[i]. Returns {end, setextLevel}
// where end is the index of the setext underline (if any) or of the first
// line after the paragraph. Used by parseParagraph and by the looseness
// pre-scan (hasDirectBlank).
function paragraphEnd(lines, i, end, inContainer, opts) {
  const start = i;
  let j = i;
  let setextLevel = 0;
  while (j < end) {
    const line = lines[j];
    // a blank line ends the paragraph — except that inside a container,
    // a single trailing whitespace-only line (non-empty) is paragraph
    // text (e.g. "> foo\n>  " gives "foo\n ")
    if (isBlank(line) && !(inContainer && line !== '' && j === end - 1)) break;
    if (j > start) {
      const ind = indentCols(line);
      if (ind < 4) {
        const c = line.slice(ind);
        const se = matchSetext(c);
        // a lazy setext line flagged by the container is paragraph text,
        // not a heading underline
        if (se && !(opts && opts.flags && opts.flags.has(j))) { setextLevel = se; break; }
        if (matchAtx(c) || matchFence(c) || isHr(c) || c.charCodeAt(0) === 62) break;
        const lm = matchListMarkerAt(line);
        // an empty list item cannot interrupt a paragraph; an ordered
        // list interrupts only when it starts at 1 — unless the paragraph
        // sits directly inside a list item (marked re-lexes item content
        // with inList set, so any ordered list interrupts there)
        if (lm && lm.firstContent !== '' && (!lm.ordered || lm.num === 1 || (opts && opts.inItem))) break;
        const hb = matchHtmlBlock(c);
        if (hb.type > 0 && hb.type < 7) break;
      }
    }
    j++;
  }
  return { end: j, setextLevel };
}

// True when a blank line separates two top-level blocks in these lines
// (the content of one list item). Blank lines inside a nested list or
// blockquote do not count.
function hasDirectBlank(lines, opts) {
  const end = lines.length;
  const dummy = [];
  const refs = new Map();
  let i = 0;
  let seenBlock = false;
  let pendingBlank = false;
  while (i < end) {
    if (isBlank(lines[i])) { pendingBlank = true; i++; continue; }
    if (seenBlock && pendingBlank) return true;
    const defUsed = tryDefs(lines, i, end, refs);
    if (defUsed > 0) { i += defUsed; continue; }
    const line = lines[i];
    const ind = indentCols(line);
    const content = ind <= 3 ? line.slice(ind) : line;
    if (ind >= 4) { i = parseIndentedCode(lines, i, end, dummy); }
    else if (matchAtx(content)) { i++; }
    else if (matchFence(content)) { i = parseFencedCode(lines, i, end, matchFence(content), dummy); }
    else if (isHr(content)) { i++; }
    else if (content.charCodeAt(0) === 62) { i = gatherBlockquote(lines, i, end, false).next; }
    else if (matchListMarkerAt(line)) { i = gatherList(lines, i, end, false).next; }
    else if (matchHtmlBlock(content).type > 0) { i = parseHtmlBlock(lines, i, end, matchHtmlBlock(content), false, dummy); }
    else {
      const tbl = tryTable(lines, i, end, refs, dummy);
      if (tbl > 0) { i += tbl; }
      else {
        const pe = paragraphEnd(lines, i, end, true, opts);
        i = pe.setextLevel ? pe.end + 1 : pe.end;
      }
    }
    seenBlock = true;
    // a nested list/blockquote may swallow trailing blank lines; when
    // another block follows, those blanks separate two top-level blocks
    pendingBlank = i < end && isBlank(lines[i - 1]);
  }
  return false;
}

function parseParagraph(lines, i, end, refs, out, tight, inContainer, prefix, opts) {
  const start = i;
  const pe = paragraphEnd(lines, i, end, inContainer, opts);
  const j = pe.end;
  const setextLevel = pe.setextLevel;
  // Raw text: lines joined with newlines. Inside a LIST ITEM, a
  // continuation line indented by 4+ columns loses exactly 4 columns
  // (the item's content dedent leaves it as an indented code offset);
  // inside a BLOCKQUOTE the indent is kept verbatim.
  let raw;
  if (inContainer) {
    const parts = [lines[start]];
    for (let k = start + 1; k < j; k++) {
      const line = lines[k];
      // a flagged line (lazy setext) keeps its text verbatim, including
      // the "    " prepended by the blockquote setext replacement
      if (opts && opts.flags && opts.flags.has(k)) parts.push(line);
      else if (opts && opts.strip4 && opts.strip4.has(k) && indentCols(line) >= 4) parts.push(stripCols(line, 4));
      else if (opts && opts.inItem && indentCols(line) >= 4) parts.push(stripCols(line, 4));
      else parts.push(line);
    }
    raw = parts.join('\n');
  } else {
    raw = lines.slice(start, j).join('\n');
  }
  if (setextLevel) {
    // a setext heading's text is trimmed at both ends (middle lines keep
    // their whitespace, including hard-break spaces)
    const trimmed = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (out) out.push('<h' + setextLevel + '>' + inlineHtml(trimmed, refs) + '</h' + setextLevel + '>\n');
    return j + 1;
  }
  if (out) {
    if (tight) {
      if (prefix) out.push(prefix);
      out.push(inlineHtml(raw, refs));
    } else {
      out.push('<p>');
      if (prefix) out.push(prefix);
      out.push(inlineHtml(raw, refs));
      out.push('</p>\n');
    }
  }
  return j;
}

// Blockquote starting at lines[i]. Returns the first line after it.
function parseBlockquote(lines, i, end, refs, out, eofNL) {
  const g = gatherBlockquote(lines, i, end, eofNL);
  out.push('<blockquote>\n');
  // container content is re-lexed as a standalone string, so an HTML
  // block at its end never gets a trailing newline (eofNL false); a
  // blockquote also resets inItem (a non-1 ordered list does not
  // interrupt a paragraph inside a quote, even inside a list item)
  const bqOpts = g.flags.size || g.strip4.size
    ? { flags: g.flags, strip4: g.strip4, inItem: false }
    : { inItem: false };
  parseBlocks(g.sub, 0, g.sub.length, refs, out, false, false, true, bqOpts);
  out.push('</blockquote>\n');
  return g.next;
}

// Gather a blockquote's content lines starting at lines[i].
// Returns {sub, next, subEofNL}.
function gatherBlockquote(lines, i, end, eofNL) {
  const sub = [];
  // flags: sub-line indices that are lazy setext underlines ('===' after
  // a lazy line) — paragraph text, never a heading, and never strip-4'd
  const flags = new Set();
  // strip4: sub-line indices of lazy continuation lines that lose
  // exactly 4 columns when rendered as paragraph text
  const strip4 = new Set();
  let j = i;
  let prevOpen = false;
  let prevWasLazy = false;
  let lastParent = i;
  // fenced code state: while a fence is open, a lazy line is not a
  // continuation (the fence's content lines must carry '>')
  const fence = [0, 0];
  while (j < end) {
    const line = lines[j];
    const ind = indentCols(line);
    if (ind <= 3 && line.charCodeAt(ind) === 62) {
      const c = line.slice(ind + 1);
      const rest = c.length ? expandLeadingTabs(stripCols(c, 1, ind + 1), ind + 2) : '';
      sub.push(rest);
      prevOpen = trackFenceLine(rest, fence);
      prevWasLazy = false;
      lastParent = j;
      j++;
      continue;
    }
    if (prevOpen && !fence[0] && isLazyCandidate(line)) {
      let lazy = expandLeadingTabs(line, 0);
      const lzInd = indentCols(lazy);
      const isSetext = lzInd < 4 && matchSetext(lazy.slice(lzInd)) === 1;
      if (isSetext) {
        // lazy '===' line: when it follows another lazy line, marked's
        // blockquote setext replacement prepends "    " (so it stays
        // paragraph text); either way it must not become a heading
        if (prevWasLazy) lazy = '    ' + stripCols(lazy, 3);
        flags.add(sub.length);
      } else if (lzInd >= 4) {
        // a lazy continuation line loses exactly 4 columns (the
        // blockquote's implicit indent); a '>'-prefixed line keeps
        // its indent verbatim. Recorded, not stripped here: the
        // line must still read as paragraph text to paragraphEnd.
        strip4.add(sub.length);
      }
      sub.push(lazy);
      // the lazy line is paragraph text, so the paragraph stays open
      // (a setext line closes it)
      prevOpen = !isSetext;
      prevWasLazy = true;
      lastParent = j;
      j++;
      continue;
    }
    break;
  }
  return { sub, next: j, subEofNL: (lastParent < end - 1) || eofNL, flags, strip4 };
}

// Gather one list item starting at lines[j] (marker m already matched).
// Returns {lines, hasBlank, trailingBlank, next, eofNL}.
function gatherItem(lines, j, end, m, ordered, delim, eofNL) {
  const itemLines = [m.firstContent];
  const flags = new Set();
  let hasBlank = false;
  let blankRun = false;
  // fenced code state: while a fence is open, a lazy line is not a
  // continuation (the fence's content lines are indented here)
  const fence = [0, 0];
  // whether the open fence already has a content line: a line less
  // indented than the item's content indent ends the fence when it
  // is the FIRST content line, but is code content once the fence
  // has content
  let fenceHasContent = false;
  let prevOpen = m.firstContent !== '' && trackFenceLine(m.firstContent, fence);
  let k = j + 1;
  let lastParent = j;
  while (k < end) {
    const line = lines[k];
    if (isBlank(line)) {
      if (fence[0]) {
        // a blank line inside a fenced code block is code content,
        // not a block separator: it does not make the list loose
        itemLines.push('');
        fenceHasContent = true;
        prevOpen = false;
        lastParent = k;
        k++;
        continue;
      }
      // an empty item ends at the first blank line (its content is
      // done), but the list itself may continue after the blank line
      if (m.firstContent === '') { blankRun = true; break; }
      itemLines.push('');
      blankRun = true;
      prevOpen = false;
      lastParent = k;
      k++;
      continue;
    }
    const ind = indentCols(line);
    // inside a fenced code block, a line is code content even when
    // not indented to the item's content indent — except when it is
    // the FIRST content line, which ends the fence instead; it is
    // stripped of the content indent when it has that much, and
    // kept as-is otherwise
    if (fence[0]) {
      if (ind < m.contentIndent && !fenceHasContent) break;
      const stripped = ind >= m.contentIndent
        ? expandLeadingTabs(stripCols(line, m.contentIndent), m.contentIndent)
        : line;
      itemLines.push(stripped);
      fenceHasContent = true;
      prevOpen = trackFenceLine(stripped, fence);
      lastParent = k;
      k++;
      continue;
    }
    if (ind >= m.contentIndent) {
      if (blankRun) hasBlank = true;
      blankRun = false;
      const stripped = expandLeadingTabs(stripCols(line, m.contentIndent), m.contentIndent);
      itemLines.push(stripped);
      const wasFence = fence[0];
      prevOpen = trackFenceLine(stripped, fence);
      // a fence just opened: it has no content yet
      if (!wasFence && fence[0]) fenceHasContent = false;
      lastParent = k;
      k++;
      continue;
    }
    const m2 = matchListMarkerAt(line);
    // a thematic-break line ends the list instead of starting an item
    if (ind <= 3 && isHr(line.slice(ind))) break;
    if (m2 && m2.ordered === ordered && m2.delim === delim) break;
    if (prevOpen && !fence[0] && isLazyCandidate(line)) {
      if (blankRun) hasBlank = true;
      blankRun = false;
      const lazy = expandLeadingTabs(line, 0);
      // a lazy '===' line is paragraph text inside the item, never a
      // setext heading (lists do no setext replacement, unlike quotes)
      const lzInd = indentCols(lazy);
      const isSetext = lzInd < 4 && matchSetext(lazy.slice(lzInd)) === 1;
      if (isSetext) flags.add(itemLines.length);
      itemLines.push(lazy);
      // the lazy line is paragraph text, so the paragraph stays open
      // (firstLineOpensParagraph would say false for indented lines,
      // but a continuation is not an opener); a setext line closes it
      prevOpen = !isSetext;
      lastParent = k;
      k++;
      continue;
    }
    break;
  }
  while (itemLines.length && itemLines[itemLines.length - 1] === '') itemLines.pop();
  return {
    lines: itemLines,
    hasBlank,
    trailingBlank: blankRun,
    next: k,
    eofNL: (lastParent < end - 1) || eofNL,
    flags,
  };
}

// Render one list item's blocks into out.
function renderItem(item, refs, out, loose) {
  const lines = item.lines;
  if (lines.length === 0) return;
  let prefix = null;
  let forcePara = false;
  const first = lines[0];
  const tm = /^\[( |x|X)\] /.exec(first);
  if (tm && first.length > 4) {
    // task list: the checkbox is prepended, and the rest of the first
    // line is paragraph text even if it looks like a block start
    const checked = tm[1] === 'x' || tm[1] === 'X';
    prefix = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox">';
    lines[0] = first.slice(3);
    forcePara = true;
  }
  // the item's content is lexed with inItem set: any ordered list
  // interrupts a paragraph directly inside the item
  const itemOpts = { inItem: true };
  if (forcePara) { itemOpts.forcePara = true; itemOpts.prefix = prefix; }
  if (item.flags && item.flags.size) itemOpts.flags = item.flags;
  parseBlocks(lines, 0, lines.length, refs, out, !loose, false, true, itemOpts);
}

// List starting at lines[i]. Returns the first line after it.
function parseList(lines, i, end, refs, out, eofNL) {
  const g = gatherList(lines, i, end, eofNL);
  let loose = false;
  for (let k = 0; k < g.items.length; k++) {
    const item = g.items[k];
    // loose only when a blank line separates two blocks directly in
    // this item (not inside a nested list/blockquote), or when a blank
    // line separates this item from the next one
    if (hasDirectBlank(item.lines, item.flags && item.flags.size ? { flags: item.flags, inItem: true } : { inItem: true })) loose = true;
    if (k < g.items.length - 1 && item.trailingBlank) loose = true;
  }
  const tag = g.ordered ? 'ol' : 'ul';
  const startAttr = g.ordered && g.startNum !== 1 ? ' start="' + g.startNum + '"' : '';
  out.push('<' + tag + startAttr + '>\n');
  for (const item of g.items) {
    out.push('<li>');
    renderItem(item, refs, out, loose);
    out.push('</li>\n');
  }
  out.push('</' + tag + '>\n');
  return g.next;
}

// Gather a list's items starting at lines[i].
// Returns {items, next, ordered, delim, startNum}.
function gatherList(lines, i, end, eofNL) {
  const first = matchListMarkerAt(lines[i]);
  const ordered = first.ordered;
  const delim = first.delim;
  const startNum = first.num;
  const items = [];
  let j = i;
  while (j < end) {
    // blank lines may separate items (an empty item stops at the first
    // blank line, so the next item can follow after blanks)
    while (j < end && isBlank(lines[j])) j++;
    if (j >= end) break;
    const m = matchListMarkerAt(lines[j]);
    if (!m || m.ordered !== ordered || m.delim !== delim) break;
    // a thematic-break line ends the list instead of starting an item
    if (indentCols(lines[j]) <= 3 && isHr(lines[j].slice(indentCols(lines[j])))) break;
    const item = gatherItem(lines, j, end, m, ordered, delim, eofNL);
    items.push(item);
    j = item.next;
  }
  return { items, next: j, ordered, delim, startNum };
}

// ---------------------------------------------------------------------------
// Main block loop.
// ---------------------------------------------------------------------------

// First pass over a line range: collect every link reference definition
// into refs, in document order, so that references resolve forward as
// well as backward. Mirrors parseBlocks structurally (definitions are
// only recognized at block starts, never inside code or mid-paragraph).
function collectDefs(lines, start, end, refs, eofNL, inContainer, inItem) {
  const dummy = [];
  let i = start;
  while (i < end) {
    if (isBlank(lines[i])) { i++; continue; }
    const defUsed = tryDefs(lines, i, end, refs);
    if (defUsed > 0) { i += defUsed; continue; }
    const line = lines[i];
    const ind = indentCols(line);
    const content = ind <= 3 ? line.slice(ind) : line;
    if (ind >= 4) { i = parseIndentedCode(lines, i, end, dummy); continue; }
    if (matchAtx(content)) { i++; continue; }
    const fence = matchFence(content);
    if (fence) { i = parseFencedCode(lines, i, end, fence, dummy); continue; }
    if (isHr(content)) { i++; continue; }
    if (content.charCodeAt(0) === 62) {
      const g = gatherBlockquote(lines, i, end, eofNL);
      collectDefs(g.sub, 0, g.sub.length, refs, g.subEofNL, true, false);
      i = g.next;
      continue;
    }
    if (matchListMarkerAt(line)) {
      const g = gatherList(lines, i, end, eofNL);
      for (const item of g.items) {
        collectDefs(item.lines, 0, item.lines.length, refs, item.eofNL, true, true);
      }
      i = g.next;
      continue;
    }
    const hb = matchHtmlBlock(content);
    if (hb.type > 0) { i = parseHtmlBlock(lines, i, end, hb, eofNL, dummy); continue; }
    const tbl = tryTable(lines, i, end, refs, dummy);
    if (tbl > 0) { i += tbl; continue; }
    i = parseParagraph(lines, i, end, refs, null, false, inContainer, null, inItem ? { inItem: true } : null);
  }
}

function parseBlocks(lines, start, end, refs, out, tight, eofNL, inContainer, opts) {
  let i = start;
  let firstBlock = true;
  let prefix = opts && opts.prefix ? opts.prefix : null;
  const forcePara = !!(opts && opts.forcePara);
  while (i < end) {
    if (isBlank(lines[i])) { i++; continue; }
    const pfx = firstBlock ? prefix : null;
    firstBlock = false;
    prefix = null;
    if (forcePara && pfx !== null) {
      // task list item: the first line is paragraph text, whatever it is
      i = parseParagraph(lines, i, end, refs, out, tight, inContainer, pfx, opts);
      continue;
    }
    const defUsed = tryDefs(lines, i, end, refs);
    if (defUsed > 0) { i += defUsed; continue; }
    const line = lines[i];
    const ind = indentCols(line);
    const content = ind <= 3 ? line.slice(ind) : line;
    if (ind >= 4) { i = parseIndentedCode(lines, i, end, out); continue; }
    const atx = matchAtx(content);
    if (atx) {
      out.push('<h' + atx.level + '>' + inlineHtml(atx.text, refs) + '</h' + atx.level + '>\n');
      i++;
      continue;
    }
    const fence = matchFence(content);
    if (fence) { i = parseFencedCode(lines, i, end, fence, out); continue; }
    if (isHr(content)) { out.push('<hr>\n'); i++; continue; }
    if (content.charCodeAt(0) === 62) { i = parseBlockquote(lines, i, end, refs, out, eofNL); continue; }
    if (matchListMarkerAt(line)) { i = parseList(lines, i, end, refs, out, eofNL); continue; }
    const hb = matchHtmlBlock(content);
    if (hb.type > 0) { i = parseHtmlBlock(lines, i, end, hb, eofNL, out); continue; }
    const tbl = tryTable(lines, i, end, refs, out);
    if (tbl > 0) { i += tbl; continue; }
    i = parseParagraph(lines, i, end, refs, out, tight, inContainer, pfx, opts);
  }
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const eofNL = src.endsWith('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const out = [];
  collectDefs(lines, 0, lines.length, refs, eofNL, false, false);
  docInLink = false;
  parseBlocks(lines, 0, lines.length, refs, out, false, eofNL, false, null);
  return out.join('');
}
