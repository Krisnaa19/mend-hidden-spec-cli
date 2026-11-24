// mend: apply an AI-written patch to a tree of text files.
//
// Implements SPEC.md (version 1): four patch formats (unified diff,
// SEARCH/REPLACE, V4A, JSON edits), three matching tiers, atomic writes.
// Node 22, standard library only. No clocks, no randomness.
//
// Usage: node main.ts [--format=unified|search-replace|v4a|json|auto]
//                     [--check] [--strict] [PATCH]
// PATCH absent or "-" reads the patch from stdin.
//
// Exit codes: 0 applied (or --check clean), 1 some edits failed
// (failed edits change nothing, later edits still run), 2 usage /
// missing patch / unknown format / parse error. When the trial
// environment variable MAKEFUN_ENV_URL is set, main hands over to
// runner.ts instead of running the CLI.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function byteCompare(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function stripTrailingWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// File model (SPEC section 3)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  eol: boolean; // the file ends with a line break
  crlf: boolean; // the file's line break is CRLF
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], eol: false, crlf: false };
  const firstNl = text.indexOf('\n');
  const crlf = firstNl > 0 && text[firstNl - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = parts[parts.length - 1] === '';
  if (eol) parts.pop();
  return { lines: parts, eol, crlf };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  const br = f.crlf ? '\r\n' : '\n';
  return f.lines.join(br) + (f.eol ? br : '');
}

// A patch's lines: split at \n, one trailing \r removed each, no empty piece
// after a final \n.
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ---------------------------------------------------------------------------
// Tree (working directory)
// ---------------------------------------------------------------------------

type Tree = Map<string, string>;

function loadTree(root: string): Tree {
  const out: Tree = new Map();
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      const p = rel === '' ? name : rel + '/' + name;
      if (st.isDirectory()) walk(full, p);
      else if (st.isFile()) out.set(p, readFileSync(full, 'utf8'));
    }
  };
  walk(root, '');
  return out;
}

function writeTree(root: string, before: Tree, after: Tree): void {
  for (const [p] of before) {
    if (!after.has(p)) rmSync(join(root, ...p.split('/')), { force: true });
  }
  for (const [p, text] of after) {
    if (before.get(p) === text) continue;
    const full = join(root, ...p.split('/'));
    try {
      if (statSync(full).isDirectory()) rmSync(full, { recursive: true, force: true });
    } catch {
      // does not exist; nothing to clear
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Matching (SPEC section 5)
// ---------------------------------------------------------------------------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return stripTrailingWs(line);
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAtTier(fileLines: string[], o: string[], tier: number): number[] {
  const pos: number[] = [];
  if (o.length === 0 || o.length > fileLines.length) return pos;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(fileLines[i + j], tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

interface TierHit {
  tier: number;
  pos: number[];
}

function findTier(fileLines: string[], o: string[], strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAtTier(fileLines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// First occurrence at or after `from`, at the first tier with one; an
// end-of-file occurrence must end at the file's last line.
function findTierFrom(
  fileLines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const all = occurrencesAtTier(fileLines, o, t);
    const kept = all.filter((p) => p >= from && (!eofOnly || p + o.length === fileLines.length));
    if (kept.length > 0) return { tier: t, pos: kept };
  }
  return null;
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const na = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i], t) === na) return i;
    }
  }
  return -1;
}

interface NLine {
  text: string;
  ctx: number | null; // index into O when this is a context line
}

// Build the replacement lines for N at match position `pos` (SPEC section 5).
function buildReplacement(
  fileLines: string[],
  o: string[],
  n: NLine[],
  pos: number,
  tier: number,
): string[] {
  const f = leadingWs(fileLines[pos]);
  const p = leadingWs(o[0]);
  return n.map((nl) => {
    if (nl.ctx !== null) return fileLines[pos + nl.ctx];
    if (tier !== 2) return nl.text;
    const t = nl.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

function countOccurrences(text: string, sub: string): number {
  let count = 0;
  let i = 0;
  for (;;) {
    const idx = text.indexOf(sub, i);
    if (idx === -1) return count;
    count++;
    i = idx + 1;
  }
}

// ---------------------------------------------------------------------------
// Edit application
// ---------------------------------------------------------------------------

interface EditFailure {
  code: string;
  path: string;
}

interface ApplyOutcome {
  fail: EditFailure | null;
  move?: { oldPath: string; newPath: string };
}

const okOutcome: ApplyOutcome = { fail: null };
function failOutcome(code: string, path: string): ApplyOutcome {
  return { fail: { code, path } };
}

// Apply unified hunks to a file's text. Returns the new text, or null when a
// hunk finds no match.
function applyHunks(text: string, hunks: Hunk[], strict: boolean): string | null {
  let f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(f.lines, h.o, strict);
      if (!found) return null;
      const target = h.a - 1 + d;
      let best = found.pos[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(f.lines, h.o, h.n, best, found.tier);
      const endsAtEnd = best + h.o.length === f.lines.length;
      const newLines = [...f.lines.slice(0, best), ...repl, ...f.lines.slice(best + h.o.length)];
      f = { lines: newLines, eol: endsAtEnd ? !h.noEol : f.eol, crlf: f.crlf };
      d += h.n.length - h.o.length;
    } else {
      let ins = h.a + d;
      if (ins < 0) ins = 0;
      if (ins > f.lines.length) ins = f.lines.length;
      const repl = h.n.map((nl) => nl.text);
      const atEnd = ins === f.lines.length;
      const newLines = [...f.lines.slice(0, ins), ...repl, ...f.lines.slice(ins)];
      f = { lines: newLines, eol: atEnd ? (h.n.length > 0 ? !h.noEol : f.eol) : f.eol, crlf: f.crlf };
      d += h.n.length;
    }
  }
  return serializeFile(f);
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  noEol: boolean; // a \ line follows the hunk's last context or + line
  plusNoEol: boolean; // a \ line follows the hunk's last + line
}

interface UnifiedSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

// Path from a `--- <path>` / `+++ <path>` line: text after the four
// characters, up to the first tab, surrounding spaces removed; /dev/null
// means no file; a leading a/ or b/ is removed.
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function buildHunk(a: number, body: string[]): Hunk {
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const c = body[k][0];
    if (c === ' ' || c === '+') lastCtxPlus = k;
    if (c === '+') lastPlus = k;
  }
  const follows = (idx: number): boolean =>
    idx !== -1 && idx + 1 < body.length && body[idx + 1][0] === '\\';
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: null });
    }
    // a \ line is a marker only; it carries no text
  }
  return { a, o, n, noEol: follows(lastCtxPlus), plusNoEol: follows(lastPlus) };
}

// Collect a hunk body starting at lines[start]. Returns the body lines
// (trailing empty lines removed) and the index of the first line after it.
function collectHunkBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: j };
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; line: number };

function parseErr<T>(line: number): ParseResult<T> {
  return { ok: false, line };
}

function parseUnified(lines: string[]): ParseResult<UnifiedSection[]> {
  const sections: UnifiedSection[] = [];
  const fresh = (): UnifiedSection => ({
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFile: false,
    deleted: false,
    hunks: [],
  });
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (cur === null) {
      if (isDiffGitLine(line)) {
        const m = DIFF_GIT_RE.exec(line);
        if (!m) return parseErr(i + 1);
        cur = fresh();
        cur.diffOld = m[1];
        cur.diffNew = m[2];
        inHeader = true;
        i++;
      } else if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
        cur = fresh();
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
        inHeader = true;
        i += 2;
      } else if (line.startsWith('@@')) {
        return parseErr(i + 1);
      } else {
        i++;
      }
      continue;
    }
    if (isDiffGitLine(line)) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) return parseErr(i + 1);
      sections.push(cur);
      cur = fresh();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (inHeader && cur.pairOld === undefined) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
        i += 2;
      } else {
        sections.push(cur);
        cur = fresh();
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
        inHeader = true;
        i += 2;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      if (inHeader) return parseErr(i + 2);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) return parseErr(i + 1);
      const { body, next } = collectHunkBody(lines, i + 1);
      cur.hunks.push(buildHunk(parseInt(m[1], 10), body));
      inHeader = false;
      i = next;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deleted = true;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) return parseErr(1);
  return { ok: true, value: sections };
}

function applyUnifiedSection(tree: Tree, s: UnifiedSection, strict: boolean): ApplyOutcome {
  const pick = (
    pair: string | null | undefined,
    rename: string | undefined,
    diff: string | undefined,
  ): string | null | undefined =>
    pair !== undefined ? pair : rename !== undefined ? rename : diff;
  const oldRaw = pick(s.pairOld, s.renameFrom, s.diffOld);
  const newRaw = pick(s.pairNew, s.renameTo, s.diffNew);
  const oldPath = oldRaw === undefined || oldRaw === null ? '' : oldRaw;
  const newPath = newRaw === undefined || newRaw === null ? '' : newRaw;
  const isCreate = oldRaw === null || s.newFile;
  const isDelete = newRaw === null || s.deleted;
  if (isCreate) {
    if (!isSafePath(newPath)) return failOutcome('unsafe', newPath);
    if (tree.has(newPath)) return failOutcome('exists', newPath);
    const plus: string[] = [];
    let lastPlusNoEol = false;
    for (const h of s.hunks) {
      for (const nl of h.n) if (nl.ctx === null) plus.push(nl.text);
    }
    for (let k = s.hunks.length - 1; k >= 0; k--) {
      const h = s.hunks[k];
      if (h.n.some((nl) => nl.ctx === null)) {
        lastPlusNoEol = h.plusNoEol;
        break;
      }
    }
    const text = plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol ? '' : '\n');
    tree.set(newPath, text);
    return okOutcome;
  }
  if (isDelete) {
    if (!isSafePath(oldPath)) return failOutcome('unsafe', oldPath);
    if (!tree.has(oldPath)) return failOutcome('missing', oldPath);
    tree.delete(oldPath);
    return okOutcome;
  }
  const isMove = oldPath !== newPath;
  if (isMove) {
    if (!isSafePath(oldPath)) return failOutcome('unsafe', oldPath);
    if (!isSafePath(newPath)) return failOutcome('unsafe', newPath);
    if (!tree.has(oldPath)) return failOutcome('missing', oldPath);
    if (tree.has(newPath)) return failOutcome('exists', newPath);
    const out = applyHunks(tree.get(oldPath) as string, s.hunks, strict);
    if (out === null) return failOutcome('no-match', oldPath);
    tree.delete(oldPath);
    tree.set(newPath, out);
    return { fail: null, move: { oldPath, newPath } };
  }
  if (!isSafePath(oldPath)) return failOutcome('unsafe', oldPath);
  if (!tree.has(oldPath)) return failOutcome('missing', oldPath);
  const out = applyHunks(tree.get(oldPath) as string, s.hunks, strict);
  if (out === null) return failOutcome('no-match', oldPath);
  tree.set(oldPath, out);
  return okOutcome;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): ParseResult<SRBlock[]> {
  const blocks: SRBlock[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (stripTrailingWs(lines[i]) === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let sep = -1;
      let j = i + 1;
      while (j < lines.length) {
        const t = stripTrailingWs(lines[j]);
        if (t === '<<<<<<< SEARCH') break;
        if (t === '=======') {
          sep = j;
          break;
        }
        j++;
      }
      if (sep === -1) return parseErr(searchIdx + 1);
      let end = -1;
      let k = sep + 1;
      while (k < lines.length) {
        const t = stripTrailingWs(lines[k]);
        if (t === '<<<<<<< SEARCH') break;
        if (t === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
        k++;
      }
      if (end === -1) return parseErr(searchIdx + 1);
      let path: string | null = null;
      for (let m = searchIdx - 1; m > prevReplaceEnd; m--) {
        const t = lines[m].trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) return parseErr(searchIdx + 1);
        path = prevPath;
      }
      blocks.push({
        path,
        oldLines: lines.slice(searchIdx + 1, sep),
        newLines: lines.slice(sep + 1, end),
      });
      prevPath = path;
      prevReplaceEnd = end;
      i = end + 1;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) return parseErr(1);
  return { ok: true, value: blocks };
}

function applySRBlock(tree: Tree, b: SRBlock, strict: boolean): ApplyOutcome {
  const p = b.path;
  if (!isSafePath(p)) return failOutcome('unsafe', p);
  if (b.oldLines.length === 0) {
    if (tree.has(p)) return failOutcome('exists', p);
    tree.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
    return okOutcome;
  }
  if (!tree.has(p)) return failOutcome('missing', p);
  const f = parseFile(tree.get(p) as string);
  const found = findTier(f.lines, b.oldLines, strict);
  if (!found) return failOutcome('no-match', p);
  if (found.pos.length > 1) return failOutcome('ambiguous', p);
  const pos = found.pos[0];
  const n: NLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
  const repl = buildReplacement(f.lines, b.oldLines, n, pos, found.tier);
  const newLines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + b.oldLines.length)];
  tree.set(p, serializeFile({ lines: newLines, eol: f.eol, crlf: f.crlf }));
  return okOutcome;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | undefined;
  addLines: string[];
  chunks: V4AChunk[];
  updateLine: number;
}

function parseV4A(lines: string[]): ParseResult<V4ASection[]> {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return parseErr(1);
  for (let i = n - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[first].trim() !== '*** Begin Patch') return parseErr(first + 1);
  if (lines[last].trim() !== '*** End Patch') return parseErr(n + 1);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      return parseErr(i + 1);
    }
    const sectionLine = i + 1;
    i++;
    const raw: { text: string; num: number }[] = [];
    while (i < last) {
      const l = lines[i];
      if (
        l.startsWith('*** Add File: ') ||
        l.startsWith('*** Delete File: ') ||
        l.startsWith('*** Update File: ')
      ) {
        break;
      }
      raw.push({ text: l, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') addLines.push('');
        else if (r.text[0] === '+') addLines.push(r.text.slice(1));
        else return parseErr(r.num);
      }
      sections.push({ kind, path, moveTo: undefined, addLines, chunks: [], updateLine: sectionLine });
    } else if (kind === 'delete') {
      if (raw.length > 0) return parseErr(raw[0].num);
      sections.push({ kind, path, moveTo: undefined, addLines: [], chunks: [], updateLine: sectionLine });
    } else {
      let moveTo: string | undefined;
      let at = 0;
      if (raw.length > 0 && raw[0].text.startsWith('*** Move to: ')) {
        moveTo = raw[0].text.slice(13).trim();
        at = 1;
      }
      const chunks: V4AChunk[] = [];
      let current: V4AChunk | null = null;
      for (let q = at; q < raw.length; q++) {
        const r = raw[q];
        if (r.text.startsWith('@@')) {
          const anchor = r.text.slice(2).trim();
          current = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
          chunks.push(current);
        } else if (r.text === '*** End of File') {
          if (current === null) return parseErr(r.num);
          current.eof = true;
          current = null;
        } else if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
          if (current === null) {
            if (chunks.length !== 0) return parseErr(r.num);
            current = { anchor: null, o: [], n: [], eof: false };
            chunks.push(current);
          }
          if (r.text === '') {
            current.o.push('');
            current.n.push({ text: '', ctx: current.o.length - 1 });
          } else if (r.text[0] === ' ') {
            const t = r.text.slice(1);
            current.o.push(t);
            current.n.push({ text: t, ctx: current.o.length - 1 });
          } else if (r.text[0] === '-') {
            current.o.push(r.text.slice(1));
          } else {
            current.n.push({ text: r.text.slice(1), ctx: null });
          }
        } else {
          return parseErr(r.num);
        }
      }
      if (chunks.length === 0 && moveTo === undefined) return parseErr(sectionLine);
      sections.push({ kind, path, moveTo, addLines: [], chunks, updateLine: sectionLine });
    }
  }
  if (sections.length === 0) return parseErr(1);
  return { ok: true, value: sections };
}

function applyV4ASection(tree: Tree, s: V4ASection, strict: boolean): ApplyOutcome {
  const p = s.path;
  if (!isSafePath(p)) return failOutcome('unsafe', p);
  if (s.kind === 'add') {
    if (tree.has(p)) return failOutcome('exists', p);
    tree.set(p, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    return okOutcome;
  }
  if (s.kind === 'delete') {
    if (!tree.has(p)) return failOutcome('missing', p);
    tree.delete(p);
    return okOutcome;
  }
  if (s.moveTo !== undefined && !isSafePath(s.moveTo)) return failOutcome('unsafe', s.moveTo);
  if (!tree.has(p)) return failOutcome('missing', p);
  if (s.moveTo !== undefined && tree.has(s.moveTo)) return failOutcome('exists', s.moveTo);
  let f = parseFile(tree.get(p) as string);
  let cursor = 0;
  for (const chunk of s.chunks) {
    if (chunk.anchor !== null) {
      const idx = findAnchor(f.lines, chunk.anchor, cursor, strict);
      if (idx === -1) return failOutcome('no-match', p);
      cursor = idx + 1;
    }
    if (chunk.o.length > 0) {
      const found = findTierFrom(f.lines, chunk.o, cursor, strict, chunk.eof);
      if (!found) return failOutcome('no-match', p);
      const pos = found.pos[0];
      const repl = buildReplacement(f.lines, chunk.o, chunk.n, pos, found.tier);
      f = {
        lines: [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + chunk.o.length)],
        eol: f.eol,
        crlf: f.crlf,
      };
      cursor = pos + repl.length;
    } else {
      const ins = chunk.eof ? f.lines.length : cursor;
      const repl = chunk.n.map((nl) => nl.text);
      f = {
        lines: [...f.lines.slice(0, ins), ...repl, ...f.lines.slice(ins)],
        eol: f.eol,
        crlf: f.crlf,
      };
      cursor = ins + repl.length;
    }
  }
  const text = serializeFile(f);
  if (s.moveTo !== undefined) {
    tree.delete(p);
    tree.set(s.moveTo, text);
    return { fail: null, move: { oldPath: p, newPath: s.moveTo } };
  }
  tree.set(p, text);
  return okOutcome;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

type JsonEdit =
  | { kind: 'create'; path: string; fileText: string }
  | { kind: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'insert'; path: string; insertLine: number; newStr: string };

function validateJsonEdit(el: unknown): JsonEdit | null {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) return null;
  const o = el as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr: (o.new_str as string) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function lineNumberOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

function parseJson(patchText: string, patchLines: string[]): ParseResult<JsonEdit[]> {
  const firstNonWs = patchText.search(/\S/);
  if (firstNonWs === -1) return parseErr(1);
  if (patchText[firstNonWs] === '[') {
    const startLine = lineNumberOf(patchText, firstNonWs);
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      return parseErr(startLine);
    }
    if (!Array.isArray(arr)) return parseErr(startLine);
    if (arr.length === 0) return parseErr(1);
    const edits: JsonEdit[] = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (!e) return parseErr(startLine);
      edits.push(e);
    }
    return { ok: true, value: edits };
  }
  const edits: JsonEdit[] = [];
  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i];
    if (line.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return parseErr(i + 1);
    }
    const e = validateJsonEdit(obj);
    if (!e) return parseErr(i + 1);
    edits.push(e);
  }
  if (edits.length === 0) return parseErr(1);
  return { ok: true, value: edits };
}

function applyJsonEdit(tree: Tree, e: JsonEdit): ApplyOutcome {
  const p = e.path;
  if (!isSafePath(p)) return failOutcome('unsafe', p);
  if (e.kind === 'create') {
    if (tree.has(p)) return failOutcome('exists', p);
    tree.set(p, e.fileText);
    return okOutcome;
  }
  if (e.kind === 'str_replace') {
    if (!tree.has(p)) return failOutcome('missing', p);
    const text = tree.get(p) as string;
    const f = parseFile(text);
    if (f.crlf) {
      const normText = text.split('\r\n').join('\n');
      const normOld = e.oldStr.split('\r\n').join('\n');
      const normNew = e.newStr.split('\r\n').join('\n');
      const count = countOccurrences(normText, normOld);
      if (count === 0) return failOutcome('no-match', p);
      if (count > 1) return failOutcome('ambiguous', p);
      const idx = normText.indexOf(normOld);
      const res = normText.slice(0, idx) + normNew + normText.slice(idx + normOld.length);
      tree.set(p, res.split('\n').join('\r\n'));
    } else {
      const count = countOccurrences(text, e.oldStr);
      if (count === 0) return failOutcome('no-match', p);
      if (count > 1) return failOutcome('ambiguous', p);
      const idx = text.indexOf(e.oldStr);
      tree.set(p, text.slice(0, idx) + e.newStr + text.slice(idx + e.oldStr.length));
    }
    return okOutcome;
  }
  if (!tree.has(p)) return failOutcome('missing', p);
  const f = parseFile(tree.get(p) as string);
  if (e.insertLine < 0 || e.insertLine > f.lines.length) return failOutcome('no-match', p);
  const insLines = splitPatchLines(e.newStr);
  const newLines = [...f.lines.slice(0, e.insertLine), ...insLines, ...f.lines.slice(e.insertLine)];
  tree.set(p, serializeFile({ lines: newLines, eol: f.eol, crlf: f.crlf }));
  return okOutcome;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return null;
  const first = lines[firstIdx];
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const firstNonWs = first.search(/\S/);
  if (firstNonWs !== -1 && (first[firstNonWs] === '[' || first[firstNonWs] === '{')) return 'json';
  for (const l of lines) {
    if (stripTrailingWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edit dispatch, order and atomicity (SPEC section 10)
// ---------------------------------------------------------------------------

type EditSpec =
  | { kind: 'unified'; section: UnifiedSection }
  | { kind: 'sr'; block: SRBlock }
  | { kind: 'v4a'; section: V4ASection }
  | { kind: 'json'; edit: JsonEdit };

function applyEdit(tree: Tree, spec: EditSpec, strict: boolean): ApplyOutcome {
  switch (spec.kind) {
    case 'unified':
      return applyUnifiedSection(tree, spec.section, strict);
    case 'sr':
      return applySRBlock(tree, spec.block, strict);
    case 'v4a':
      return applyV4ASection(tree, spec.section, strict);
    case 'json':
      return applyJsonEdit(tree, spec.edit);
  }
}

function changeLines(
  before: Tree,
  after: Tree,
  moves: { oldPath: string; newPath: string }[],
): string[] {
  const deleted = new Set<string>();
  const added = new Set<string>();
  const modified = new Set<string>();
  for (const [p, text] of before) {
    if (!after.has(p)) deleted.add(p);
    else if (after.get(p) !== text) modified.add(p);
  }
  for (const [p] of after) {
    if (!before.has(p)) added.add(p);
  }
  const entries: { key: string; line: string }[] = [];
  for (const m of moves) {
    if (deleted.has(m.oldPath) && added.has(m.newPath)) {
      deleted.delete(m.oldPath);
      added.delete(m.newPath);
      entries.push({ key: m.newPath, line: `R ${m.oldPath} -> ${m.newPath}` });
    }
  }
  for (const p of deleted) entries.push({ key: p, line: `D ${p}` });
  for (const p of added) entries.push({ key: p, line: `A ${p}` });
  for (const p of modified) entries.push({ key: p, line: `M ${p}` });
  entries.sort((a, b) => byteCompare(a.key, b.key));
  return entries.map((e) => e.line);
}

// ---------------------------------------------------------------------------
// Invocation (SPEC sections 1 and 2)
// ---------------------------------------------------------------------------

const FORMAT_NAMES = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | undefined;
}

function parseCliArgs(argv: string[]): CliArgs | null {
  let format: string | undefined;
  let check = false;
  let strict = false;
  let patch: string | undefined;
  let noMoreOptions = false;
  for (const arg of argv) {
    if (!noMoreOptions && arg === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (check) return null;
        check = true;
      } else if (arg === '--strict') {
        if (strict) return null;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (format !== undefined) return null;
        const value = arg.slice('--format='.length);
        if (!FORMAT_NAMES.includes(value)) return null;
        format = value;
      } else {
        return null;
      }
      continue;
    }
    if (patch !== undefined) return null;
    patch = arg;
  }
  return { format: format ?? 'auto', check, strict, patch };
}

function runCli(): number {
  const args = parseCliArgs(process.argv.slice(2));
  if (args === null) {
    process.stdout.write('error: usage\n');
    return 2;
  }
  let patchText: string;
  if (args.patch === undefined || args.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(args.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }
  const patchLines = splitPatchLines(patchText);
  let format = args.format;
  if (format === 'auto') {
    const detected = detectFormat(patchLines);
    if (detected === null) {
      process.stdout.write('error: format\n');
      return 2;
    }
    format = detected;
  }
  const specs: EditSpec[] = [];
  if (format === 'unified') {
    const r = parseUnified(patchLines);
    if (!r.ok) {
      process.stdout.write(`error: parse ${r.line}\n`);
      return 2;
    }
    for (const s of r.value) specs.push({ kind: 'unified', section: s });
  } else if (format === 'search-replace') {
    const r = parseSearchReplace(patchLines);
    if (!r.ok) {
      process.stdout.write(`error: parse ${r.line}\n`);
      return 2;
    }
    for (const b of r.value) specs.push({ kind: 'sr', block: b });
  } else if (format === 'v4a') {
    const r = parseV4A(patchLines);
    if (!r.ok) {
      process.stdout.write(`error: parse ${r.line}\n`);
      return 2;
    }
    for (const s of r.value) specs.push({ kind: 'v4a', section: s });
  } else {
    const r = parseJson(patchText, patchLines);
    if (!r.ok) {
      process.stdout.write(`error: parse ${r.line}\n`);
      return 2;
    }
    for (const e of r.value) specs.push({ kind: 'json', edit: e });
  }
  const initial = loadTree(process.cwd());
  let tree: Tree = new Map(initial);
  const failures: EditFailure[] = [];
  const moves: { oldPath: string; newPath: string }[] = [];
  for (const spec of specs) {
    const snapshot: Tree = new Map(tree);
    const outcome = applyEdit(snapshot, spec, args.strict);
    if (outcome.fail !== null) {
      failures.push(outcome.fail);
    } else {
      tree = snapshot;
      if (outcome.move !== undefined) moves.push(outcome.move);
    }
  }
  if (failures.length > 0) {
    const out: string[] = [];
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${specs.length} edits`);
    process.stdout.write(out.join('\n') + '\n');
    return 1;
  }
  if (!args.check) writeTree(process.cwd(), initial, tree);
  const lines = changeLines(initial, tree, moves);
  lines.push(lines.length === 1 ? 'ok: 1 file' : `ok: ${lines.length} files`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

// Hand over to the trial runner when the trial environment is set; otherwise
// run the CLI.
if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  process.exitCode = runCli();
}
