// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

/** Successful move edits, in order: [old path, new path]. Used to print `R` lines. */
const moves: Array<[string, string]> = [];

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

// ---------- lines and matching (SPEC sections 3 and 5) ----------

interface Split {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const ends = text.endsWith(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}

function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function matchAt(O: string[], file: string[], pos: number, tier: number): boolean {
  for (let j = 0; j < O.length; j += 1) {
    const a = O[j]!;
    const b = file[pos + j]!;
    if (tier === 0) {
      if (a !== b) return false;
    } else if (tier === 1) {
      if (trimTrail(a) !== trimTrail(b)) return false;
    } else if (trimBoth(a) !== trimBoth(b)) return false;
  }
  return true;
}

function tierOccurrences(O: string[], file: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= file.length; i += 1) {
    if (eofOnly && i + O.length !== file.length) continue;
    if (matchAt(O, file, i, tier)) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), and its occurrences there. */
function findTier(O: string[], file: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = tierOccurrences(O, file, t, from, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of the replacement side: a context line (its index into O) or a fresh line. */
interface NLine {
  text: string;
  ctx: number | null;
}

/** Resolve the replacement lines at a match: context lines are the file's own lines; at tier 2 the other lines are re-indented. */
function resolveN(N: NLine[], O: string[], file: string[], pos: number, tier: number): string[] {
  const F = tier === 2 ? leadOf(file[pos]!) : '';
  const P = tier === 2 ? leadOf(O[0]!) : '';
  return N.map((nl) => {
    if (nl.ctx !== null) return file[pos + nl.ctx]!;
    const t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

function spliceLines(lines: string[], pos: number, k: number, rep: string[]): string[] {
  return [...lines.slice(0, pos), ...rep, ...lines.slice(pos + k)];
}

// ---------- unified diffs (SPEC section 6) ----------

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noNL: boolean;
  /** a `\` line follows the hunk's last `+` line */
  noNLPlus: boolean;
}
interface UniSection {
  oldPath: string;
  newPath: string;
  kind: 'create' | 'delete' | 'move' | 'change';
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` line: text after the four characters, up to the first tab, spaces removed. */
function diffPath(line: string): string {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  return (tab >= 0 ? raw.slice(0, tab) : raw).trim();
}
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (l[0] === ' ') {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: o.length - 1 });
    } else if (l[0] === '-') o.push(l.slice(1));
    else if (l[0] === '+') n.push({ text: l.slice(1), ctx: null });
  }
  let noNL = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') {
      noNL = k + 1 < body.length && body[k + 1]![0] === '\\';
      break;
    }
  }
  let noNLPlus = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]![0] === '+') {
      noNLPlus = k + 1 < body.length && body[k + 1]![0] === '\\';
      break;
    }
  }
  return { hunk: { a: Number(m[1]), o, n, noNL, noNLPlus }, next: j };
}

interface SecBuild {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
  inHeader: boolean;
}
function newSecBuild(gitOld: string | null, gitNew: string | null): SecBuild {
  return {
    gitOld,
    gitNew,
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
    inHeader: true,
  };
}
function finishSection(b: SecBuild): UniSection {
  const oldPath = b.oldPath ?? b.renameFrom ?? b.gitOld ?? '';
  const newPath = b.newPath ?? b.renameTo ?? b.gitNew ?? '';
  let kind: UniSection['kind'];
  if (oldPath === '/dev/null' || b.isCreate) kind = 'create';
  else if (newPath === '/dev/null' || b.isDelete) kind = 'delete';
  else if (oldPath !== newPath) kind = 'move';
  else kind = 'change';
  return { oldPath, newPath, kind, hunks: b.hunks };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: SecBuild | null = null;
  const pushCur = (): void => {
    if (cur !== null) {
      sections.push(finishSection(cur));
      cur = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      pushCur();
      cur = newSecBuild(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSecBuild(null, null);
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i += 1;
        continue;
      }
    }
    if (cur.inHeader) {
      if (line.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        cur.inHeader = false;
        i = h.next;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = stripAB(diffPath(line));
        cur.newPath = stripAB(diffPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = stripAB(diffPath(line));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      pushCur();
      cur = newSecBuild(null, null);
      continue;
    }
    i += 1;
  }
  pushCur();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'create') {
      if (!safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
      if (tree.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
      const plus: string[] = [];
      let noNL = false;
      for (const h of sec.hunks) {
        for (const nl of h.n) if (nl.ctx === null) plus.push(nl.text);
        if (h.n.some((nl) => nl.ctx === null)) noNL = h.noNLPlus;
      }
      tree.now.set(sec.newPath, plus.length === 0 ? '' : `${plus.join('\n')}${noNL ? '' : '\n'}`);
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
      if (tree.get(sec.oldPath) === null) throw new Fail('missing', sec.oldPath);
      tree.now.set(sec.oldPath, null);
      return;
    }
    const path = sec.oldPath;
    if (!safe(path)) throw new Fail('unsafe', path);
    if (sec.kind === 'move' && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (sec.kind === 'move' && tree.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
    const sp = splitFile(curText);
    let lines = sp.lines;
    let ends = sp.ends;
    let d = 0;
    for (const h of sec.hunks) {
      if (h.o.length === 0) {
        const pos = Math.max(0, Math.min(h.a + d, lines.length));
        const rep = h.n.map((nl) => nl.text);
        const atEnd = pos === lines.length;
        lines = spliceLines(lines, pos, 0, rep);
        if (atEnd) ends = !h.noNL;
        d += rep.length;
        continue;
      }
      const found = findTier(h.o, lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = resolveN(h.n, h.o, lines, best, found.tier);
      const atEnd = best + h.o.length === lines.length;
      lines = spliceLines(lines, best, h.o.length, rep);
      if (atEnd) ends = !h.noNL;
      d += h.n.length - h.o.length;
    }
    const out = joinFile(lines, sp.br, ends);
    if (sec.kind === 'move') {
      tree.now.set(path, null);
      tree.now.set(sec.newPath, out);
      moves.push([path, sec.newPath]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j -= 1) {
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
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    const sp = splitFile(curText);
    const found = findTier(oldLines, sp.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rep = resolveN(
      newLines.map((t) => ({ text: t, ctx: null })),
      oldLines,
      sp.lines,
      pos,
      found.tier,
    );
    tree.now.set(path, joinFile(spliceLines(sp.lines, pos, oldLines.length, rep), sp.br, sp.ends));
  };
}

// ---------- V4A patches (SPEC section 8) ----------

interface VChunk {
  anchor: string;
  o: string[];
  n: NLine[];
  eof: boolean;
}

function vAddEdit(path: string, flines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, flines.length === 0 ? '' : `${flines.join('\n')}\n`);
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, raw: { text: string; idx: number }[], headerIdx: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let k = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(13).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const push = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  while (k < raw.length) {
    const r = raw[k]!;
    const l = r.text;
    if (l === '*** End of File') {
      if (cur !== null) {
        cur.eof = true;
        push();
      }
      k += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      push();
      cur = { anchor: l.slice(2).trim(), o: [], n: [], eof: false };
      k += 1;
      continue;
    }
    if (l.startsWith('*** ')) throw new Exit2(`error: parse ${r.idx + 1}`);
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) cur = { anchor: '', o: [], n: [], eof: false };
      if (l === '') {
        cur.o.push('');
        cur.n.push({ text: '', ctx: cur.o.length - 1 });
      } else if (l[0] === ' ') {
        cur.o.push(l.slice(1));
        cur.n.push({ text: l.slice(1), ctx: cur.o.length - 1 });
      } else if (l[0] === '-') cur.o.push(l.slice(1));
      else cur.n.push({ text: l.slice(1), ctx: null });
      k += 1;
      continue;
    }
    throw new Exit2(`error: parse ${r.idx + 1}`);
  }
  push();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerIdx + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const sp = splitFile(curText);
    let lines = sp.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const found = findTier([ch.anchor], lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        const rep = ch.n.map((nl) => nl.text);
        lines = spliceLines(lines, pos, 0, rep);
        cursor = pos + rep.length;
        continue;
      }
      const found = findTier(ch.o, lines, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const rep = resolveN(ch.n, ch.o, lines, pos, found.tier);
      lines = spliceLines(lines, pos, ch.o.length, rep);
      cursor = pos + rep.length;
    }
    const out = joinFile(lines, sp.br, sp.ends);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    const headerIdx = i;
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
    } else throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
    const raw: { text: string; idx: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, idx: i });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const flines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) flines.push(r.text.slice(1));
        else if (r.text === '') flines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push(vAddEdit(path, flines));
    } else if (kind === 'delete') {
      const bad = raw.find((r) => !blank(r.text));
      if (bad !== undefined) throw new Exit2(`error: parse ${bad.idx + 1}`);
      edits.push(vDeleteEdit(path));
    } else {
      edits.push(vUpdateEdit(path, raw, headerIdx, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
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

function run(args: string[]): { code: number; out: string[] } {
  moves.length = 0;
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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  const sortedNow = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of sortedNow) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // Output rows: a successful move prints `R <old> -> <new>` (sorted by <new>) instead of its `D` + `A` pair.
  const consumed = new Set<string>();
  const rowObjs: { key: string; text: string }[] = [];
  for (const [oldP, newP] of moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rowObjs.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of sortedNow) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowObjs.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowObjs.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowObjs.map((r) => r.text);
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
