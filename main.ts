// main.ts is mend, the CLI SPEC.md specifies: it applies an edit an AI model
// wrote (a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON tool
// calls) to a tree of text files, all or nothing. It implements every section
// of SPEC.md: the command line, output and exit codes, safe paths, format
// detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits, and the all-or-nothing write. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** How one line compares at a tier (SPEC section 5): 0 exact, 1 trailing
 * spaces and tabs removed, 2 leading and trailing spaces and tabs removed. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at which O occurs in lines at the tier, from `from` on. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from` on), with its
 * occurrences; null when O occurs at no tier. With `strict` only tier 0. */
function findTier(lines: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line at
 * O index `ctx`) or an added line (`ctx` null). */
interface NLine {
  text: string;
  ctx: number | null;
}

/** The lines N becomes when it replaces O at `at` in `lines` (SPEC section 5):
 * context lines are the file's own matched lines; at tier 2 every other
 * non-empty, non-whitespace-only line starting with P (the leading spaces and
 * tabs of O's first line) has that P replaced by F (those of the file's first
 * matched line); at tiers 0 and 1 added lines are written as they are. */
function buildNew(lines: string[], O: string[], N: NLine[], at: number, tier: number): string[] {
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = /^[ \t]*/.exec(lines[at]!)![0];
    P = /^[ \t]*/.exec(O[0]!)![0];
  }
  return N.map((n) => {
    if (n.ctx !== null) return lines[at + n.ctx]!;
    if (tier === 2) {
      const t = n.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) return F + t.slice(P.length);
    }
    return n.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Unified diffs (SPEC section 6) ---- */

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

/** O (context and `-` lines) and N (context and `+` lines) of one hunk or chunk body. */
function hunkON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const oi = O.length;
      O.push(b.text);
      N.push({ text: b.text, ctx: oi });
    } else if (b.kind === 'old') O.push(b.text);
    else if (b.kind === 'new') N.push({ text: b.text, ctx: null });
  }
  return { O, N };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function lastCtxPlusBackslash(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'bs';
}

/** The hunks of one section applied in order to a file's text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let cur = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkON(h.body);
    if (O.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > cur.length) at = cur.length;
      const ins = N.map((n) => n.text);
      const atEnd = at === cur.length;
      cur = [...cur.slice(0, at), ...ins, ...cur.slice(at)];
      if (atEnd) final = !lastCtxPlusBackslash(h.body);
      d += N.length;
    } else {
      const found = findTier(cur, O, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const o of found.occ) {
        const dist = Math.abs(o - target);
        if (dist < bestDist) {
          best = o;
          bestDist = dist;
        }
      }
      const atEnd = best + O.length === cur.length;
      const rep = buildNew(cur, O, N, best, found.tier);
      cur = [...cur.slice(0, best), ...rep, ...cur.slice(best + O.length)];
      if (atEnd) final = !lastCtxPlusBackslash(h.body);
      d += N.length - O.length;
    }
  }
  return joinFile(cur, f.br, final);
}

function unifiedSectionEdit(s: Section, strict: boolean, moves: [string, string][]): Edit {
  const isCreate = s.oldPath === null || s.newFile;
  const isDelete = s.newPath === null || s.delFile;
  if (isCreate && s.newPath !== null) {
    const p = s.newPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      for (const h of s.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') out.push(b.text);
        }
      }
      let final = true;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        if (h.body.some((b) => b.kind === 'new')) {
          final = !lastCtxPlusBackslash(h.body);
          break;
        }
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (final ? '\n' : ''));
    };
  }
  if (isDelete && s.oldPath !== null) {
    const p = s.oldPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (s.oldPath !== null && s.newPath !== null && s.oldPath !== s.newPath) {
    const oldP = s.oldPath;
    const newP = s.newPath;
    moves.push([oldP, newP]);
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const result = applyHunks(before, s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, result);
    };
  }
  if (s.oldPath !== null) {
    const p = s.oldPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, s.hunks, strict, p));
    };
  }
  return () => {};
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const parseErr = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const headerPath = (rest: string): string => {
    let p = rest.split('\t')[0]!.trim();
    if (p.startsWith('a/')) p = p.slice(2);
    else if (p.startsWith('b/')) p = p.slice(2);
    return p;
  };
  const nullIfDevNull = (p: string): string | null => (p === '/dev/null' ? null : p);
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l);
      if (m === null) parseErr(i + 1);
      cur = { oldPath: m[1]!, newPath: m[2]!, newFile: false, delFile: false, hasPair: false, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = nullIfDevNull(headerPath(l.slice(4)));
        const newP = nullIfDevNull(headerPath(next.slice(4)));
        if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
          cur.oldPath = oldP;
          cur.newPath = newP;
          cur.hasPair = true;
        } else {
          cur = { oldPath: oldP, newPath: newP, newFile: false, delFile: false, hasPair: true, hunks: [] };
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) parseErr(i + 2);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = hunkRe.exec(l);
      if (m === null || cur === null) parseErr(i + 1);
      const a = Number(m[1]);
      i++;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') body.push({ kind: 'ctx', text: '' });
        else if (b.startsWith(' ')) body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b.startsWith('-')) body.push({ kind: 'old', text: b.slice(1) });
        else if (b.startsWith('+')) body.push({ kind: 'new', text: b.slice(1) });
        else if (b.startsWith('\\')) body.push({ kind: 'bs', text: b.slice(1) });
        else break;
        i++;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ') && !cur.hasPair) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && !cur.hasPair) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict, moves));
}

/* ---- SEARCH/REPLACE blocks (SPEC section 7) ---- */

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  if (oldLines.length === 0) {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    };
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildNew(f.lines, oldLines, N, at, found.tier);
    const out = [...f.lines.slice(0, at), ...rep, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile(out, f.br, f.final));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srBlockEdit(path, lines.slice(searchIdx + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

/* ---- V4A patches (SPEC section 8) ---- */

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aAddEdit(path: string, raw: { text: string; num: number }[]): Edit {
  const fileLines: string[] = [];
  for (const r of raw) {
    if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
    else if (r.text === '') fileLines.push('');
    else if (blank(r.text)) {
      /* a whitespace-only line carries no file line */
    } else throw new Exit2(`error: parse ${r.num}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDelEdit(path: string, raw: { text: string; num: number }[]): Edit {
  for (const r of raw) {
    if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, headNum: number, raw: { text: string; num: number }[], strict: boolean, moves: [string, string][]): Edit {
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let seenChunk = false;
  let seenMove = false;
  const startChunk = (): VChunk => {
    const c: VChunk = { anchor: null, body: [], eof: false };
    chunks.push(c);
    seenChunk = true;
    return c;
  };
  for (const r of raw) {
    const l = r.text;
    if (!seenChunk && !seenMove && l.startsWith('*** Move to: ')) {
      moveTo = l.slice('*** Move to: '.length).trim();
      seenMove = true;
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${r.num}`);
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      chunks.push(cur);
      seenChunk = true;
      continue;
    }
    if (l === '') {
      if (cur === null) cur = startChunk();
      cur.body.push({ kind: 'ctx', text: '' });
      continue;
    }
    if (blank(l)) {
      cur = null;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) cur = startChunk();
      if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1) });
      else if (l.startsWith('-')) cur.body.push({ kind: 'old', text: l.slice(1) });
      else cur.body.push({ kind: 'new', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${r.num}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNum}`);
  if (moveTo !== null) moves.push([path, moveTo]);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let curLines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(curLines, [ch.anchor], cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { O, N } = hunkON(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? curLines.length : cursor;
        const ins = N.map((n) => n.text);
        curLines = [...curLines.slice(0, at), ...ins, ...curLines.slice(at)];
        cursor = at + ins.length;
      } else {
        const found = findTier(curLines, O, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        let at = -1;
        for (const o of found.occ) {
          if (ch.eof && o + O.length !== curLines.length) continue;
          at = o;
          break;
        }
        if (at < 0) throw new Fail('no-match', path);
        const rep = buildNew(curLines, O, N, at, found.tier);
        curLines = [...curLines.slice(0, at), ...rep, ...curLines.slice(at + O.length)];
        cursor = at + rep.length;
      }
    }
    const result = joinFile(curLines, f.br, f.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
    } else {
      tree.now.set(path, result);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const kindOf = (l: string): 'add' | 'del' | 'upd' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'del';
    if (l.startsWith('*** Update File: ')) return 'upd';
    return null;
  };
  const pathOf = (l: string, kind: 'add' | 'del' | 'upd'): string => {
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    return l.slice(prefix.length).trim();
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = kindOf(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = pathOf(l, kind);
    const headNum = i + 1;
    const raw: { text: string; num: number }[] = [];
    let j = i + 1;
    while (j < last) {
      const m = lines[j]!;
      if (kindOf(m) !== null) break;
      raw.push({ text: m, num: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') edits.push(v4aAddEdit(path, raw));
    else if (kind === 'del') edits.push(v4aDelEdit(path, raw));
    else edits.push(v4aUpdateEdit(path, headNum, raw, strict, moves));
    i = j;
  }
  return edits;
}

function parsePatch(kind: string, text: string, lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return unifiedEdits(lines, strict, moves);
  if (kind === 'search-replace') return srEdits(lines, strict);
  return v4aEdits(lines, strict, moves);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    edits = parsePatch(kind, text, lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rowMap = new Map<string, { key: string; line: string }>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowMap.set(p, { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const seenMoves = new Set<string>();
  for (const [oldP, newP] of moves) {
    const k = `${oldP}\0${newP}`;
    if (seenMoves.has(k)) continue;
    seenMoves.add(k);
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      if (rowMap.has(oldP) && rowMap.has(newP)) {
        rowMap.delete(oldP);
        rowMap.delete(newP);
        rowMap.set(newP, { key: newP, line: `R ${oldP} -> ${newP}` });
      }
    }
  }
  const rows = [...rowMap.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key))).map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
