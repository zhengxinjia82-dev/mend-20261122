// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. SPEC.md is the contract.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch the reader cannot read: exit 2 with this one line. */
class ParseFault {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: exit 1 with `error: <code> <path>`. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const bad = (n: number): ParseFault => new ParseFault(`error: parse ${n}`);
const fail = (code: string, path: string): EditFault => new EditFault(code, path);
const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A file's lines, its own line break, and whether it ends with one. */
interface SplitText {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function splitText(text: string): SplitText {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBr = text.endsWith(br);
  const parts = text.split(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function joinText(f: SplitText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A line at one matching tier: 0 exact, 1 trailing ws off, 2 both ends off. */
function normAt(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The tree as the edits leave it: overrides in `now` (null = deleted). */
class Tree {
  private readonly seen = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

/** One edit: apply it to the tree (throwing EditFault on failure). */
interface Edit {
  apply(tree: Tree): void;
  move?: [string, string];
}

/** A chunk of old lines O replaced by new lines N. A context line of N
 *  carries `ctx`, its index inside O; the file's own line is written. */
interface NewLine {
  text: string;
  ctx: number | null;
}
interface Chunk {
  oldLines: string[];
  newLines: NewLine[];
}

/** Positions where `old` occurs in `file` at one tier; overlaps allowed. */
function occurrences(file: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > file.length) return out;
  for (let i = 0; i + old.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normAt(file[i + j]!, tier) !== normAt(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0 only when strict) with an occurrence at or after `from`;
 *  `eofOnly` keeps only occurrences ending at the file's last line. */
function firstTier(
  file: string[],
  old: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(file, old, tier).filter(
      (p) => p >= from && (!eofOnly || p + old.length === file.length),
    );
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The lines N writes when O matched at `at`: context lines come from the
 *  file itself; at tier 2 the other lines are re-indented (SPEC section 5). */
function replacementLines(file: string[], at: number, chunk: Chunk, tier: number): string[] {
  if (chunk.oldLines.length === 0) return chunk.newLines.map((n) => n.text);
  const out: string[] = [];
  const fLead = leadingWs(file[at] ?? '');
  const pLead = leadingWs(chunk.oldLines[0] ?? '');
  for (const n of chunk.newLines) {
    if (n.ctx !== null) {
      out.push(file[at + n.ctx]!);
      continue;
    }
    if (tier === 2 && n.text.trim() !== '' && n.text.startsWith(pLead)) {
      out.push(fLead + n.text.slice(pLead.length));
    } else {
      out.push(n.text);
    }
  }
  return out;
}

/* ---- Unified diffs (SPEC section 6) ---- */

interface UniHunk extends Chunk {
  start: number;
  noEol: boolean;
  lastPlusNoEol: boolean;
}

interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  create: boolean;
  remove: boolean;
  hunks: UniHunk[];
}

function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line.trimEnd());
  return m ? [m[1]!, m[2]!] : null;
}

/** A `--- `/`+++ ` path: up to the first tab, spaces trimmed, a/ or b/ off. */
function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function hunkStart(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m ? Number(m[1]) : null;
}

function buildUniHunk(start: number, body: string[]): UniHunk {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  const followed = new Set<number>();
  let prev = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k]!;
    if (bl.startsWith('\\')) {
      if (prev >= 0) followed.add(prev);
      continue;
    }
    prev = k;
    if (bl === '' || bl[0] === ' ') {
      const text = bl === '' ? '' : bl.slice(1);
      newLines.push({ text, ctx: oldLines.length });
      oldLines.push(text);
    } else if (bl[0] === '-') {
      oldLines.push(bl.slice(1));
    } else if (bl[0] === '+') {
      newLines.push({ text: bl.slice(1), ctx: null });
    }
  }
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const bl = body[k]!;
    if (bl.startsWith('\\')) continue;
    if (bl === '' || bl[0] === ' ' || bl[0] === '+') {
      noEol = followed.has(k);
      break;
    }
  }
  let lastPlusNoEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const bl = body[k]!;
    if (bl.startsWith('\\')) continue;
    if (bl[0] === '+') {
      lastPlusNoEol = followed.has(k);
      break;
    }
  }
  return { oldLines, newLines, start, noEol, lastPlusNoEol };
}

/** Apply a section's hunks in order to one file's text. */
function applyHunks(text: string, hunks: UniHunk[], strict: boolean, path: string): string {
  let f = splitText(text);
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length > 0) {
      const found = firstTier(f.lines, h.oldLines, strict, 0, false);
      if (!found) throw fail('no-match', path);
      const target = h.start - 1 + d;
      let best = found.at[0]!;
      for (const at of found.at) {
        if (Math.abs(at - target) < Math.abs(best - target)) best = at;
      }
      const rep = replacementLines(f.lines, best, h, found.tier);
      const touchesEnd = best + h.oldLines.length === f.lines.length;
      const lines = f.lines.slice(0, best).concat(rep, f.lines.slice(best + h.oldLines.length));
      f = { lines, br: f.br, finalBr: touchesEnd ? !h.noEol : f.finalBr };
      d += rep.length - h.oldLines.length;
    } else {
      const pos = Math.max(0, Math.min(h.start + d, f.lines.length));
      const rep = h.newLines.map((n) => n.text);
      const touchesEnd = pos === f.lines.length;
      const lines = f.lines.slice(0, pos).concat(rep, f.lines.slice(pos));
      f = { lines, br: f.br, finalBr: touchesEnd ? !h.noEol : f.finalBr };
      d += rep.length;
    }
  }
  return joinText(f);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const fresh = (): UniSection => ({
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    create: false,
    remove: false,
    hunks: [],
  });
  const hasPair = (s: UniSection): boolean => s.pairOld !== undefined || s.pairNew !== undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const paths = diffGitPaths(line);
      if (!paths) throw bad(i + 1);
      cur = fresh();
      cur.diffOld = paths[0];
      cur.diffNew = paths[1];
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair(cur)) {
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      cur = fresh();
      cur.pairOld = headerPath(line.slice(4));
      cur.pairNew = headerPath(lines[i + 1]!.slice(4));
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw bad(i + 1);
      const start = hunkStart(line);
      if (start === null) throw bad(i + 1);
      inHeader = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildUniHunk(start, body));
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw bad(i + 2);
      if (line.startsWith('rename from ')) {
        if (!hasPair(cur)) cur.renameFrom = line.slice(12).trim();
      } else if (line.startsWith('rename to ')) {
        if (!hasPair(cur)) cur.renameTo = line.slice(10).trim();
      } else if (line.startsWith('new file mode')) {
        cur.create = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.remove = true;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw bad(1);
  return sections.map((sec) => uniEdit(sec, strict));
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const isCreate = sec.pairOld === null || sec.create;
  const isDelete = sec.pairNew === null || sec.remove;
  if (isCreate) {
    const p = newP ?? '';
    return {
      apply(tree: Tree): void {
        if (!isSafePath(p)) throw fail('unsafe', p);
        if (tree.get(p) !== null) throw fail('exists', p);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const n of h.newLines) if (n.ctx === null) plus.push(n.text);
        if (plus.length === 0) {
          tree.set(p, '');
          return;
        }
        const lastHunk = [...sec.hunks].reverse().find((h) => h.newLines.some((n) => n.ctx === null));
        const noEol = lastHunk ? lastHunk.lastPlusNoEol : false;
        tree.set(p, plus.join('\n') + (noEol ? '' : '\n'));
      },
    };
  }
  if (isDelete) {
    const p = oldP ?? '';
    return {
      apply(tree: Tree): void {
        if (!isSafePath(p)) throw fail('unsafe', p);
        if (tree.get(p) === null) throw fail('missing', p);
        tree.set(p, null);
      },
    };
  }
  if (oldP !== newP) {
    const from = oldP ?? '';
    const to = newP ?? '';
    return {
      move: [from, to],
      apply(tree: Tree): void {
        if (!isSafePath(from)) throw fail('unsafe', from);
        if (!isSafePath(to)) throw fail('unsafe', to);
        const cur = tree.get(from);
        if (cur === null) throw fail('missing', from);
        if (tree.get(to) !== null) throw fail('exists', to);
        const out = applyHunks(cur, sec.hunks, strict, from);
        tree.set(to, out);
        tree.set(from, null);
      },
    };
  }
  const p = oldP ?? '';
  return {
    apply(tree: Tree): void {
      if (!isSafePath(p)) throw fail('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw fail('missing', p);
      tree.set(p, applyHunks(cur, sec.hunks, strict, p));
    },
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC section 7) ---- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
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
      const t = lines[j]!;
      if (t.trim() === '' || t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw bad(searchIdx + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw bad(searchIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw bad(searchIdx + 1);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw bad(1);
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const chunk: Chunk = { oldLines, newLines: newLines.map((text) => ({ text, ctx: null })) };
  return {
    apply(tree: Tree): void {
      if (!isSafePath(path)) throw fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw fail('exists', path);
        tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(path);
      if (cur === null) throw fail('missing', path);
      const f = splitText(cur);
      const found = firstTier(f.lines, oldLines, strict, 0, false);
      if (!found) throw fail('no-match', path);
      if (found.at.length > 1) throw fail('ambiguous', path);
      const at = found.at[0]!;
      const rep = replacementLines(f.lines, at, chunk, found.tier);
      const out = f.lines.slice(0, at).concat(rep, f.lines.slice(at + oldLines.length));
      tree.set(path, joinText({ lines: out, br: f.br, finalBr: f.finalBr }));
    },
  };
}

/* ---- V4A patches (SPEC section 8) ---- */

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

interface VChunk extends Chunk {
  anchor: string | null;
  eof: boolean;
}

function buildVChunk(body: string[]): Chunk {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const bl of body) {
    if (bl === '' || bl[0] === ' ') {
      const text = bl === '' ? '' : bl.slice(1);
      newLines.push({ text, ctx: oldLines.length });
      oldLines.push(text);
    } else if (bl[0] === '-') {
      oldLines.push(bl.slice(1));
    } else if (bl[0] === '+') {
      newLines.push({ text: bl.slice(1), ctx: null });
    }
  }
  return { oldLines, newLines };
}

function findAnchorLine(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normAt(lines[i]!, tier) === normAt(anchor, tier)) return i;
    }
  }
  return -1;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw bad(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw bad(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw bad(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'del' | 'upd' | null = null;
    let prefix = '';
    if (line.startsWith(V_ADD)) {
      kind = 'add';
      prefix = V_ADD;
    } else if (line.startsWith(V_DEL)) {
      kind = 'del';
      prefix = V_DEL;
    } else if (line.startsWith(V_UPD)) {
      kind = 'upd';
      prefix = V_UPD;
    } else {
      throw bad(i + 1);
    }
    const path = line.slice(prefix.length).trim();
    let j = i + 1;
    const raw: string[] = [];
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD)) break;
      raw.push(l);
      j++;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') edits.push(v4aAddEdit(path, raw, i));
    else if (kind === 'del') edits.push(v4aDelEdit(path, raw, i));
    else edits.push(v4aUpdEdit(path, raw, i, strict));
    i = j;
  }
  if (edits.length === 0) throw bad(1);
  return edits;
}

function v4aAddEdit(path: string, raw: string[], headIdx: number): Edit {
  const fileLines: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k]!;
    if (l === '') fileLines.push('');
    else if (l.startsWith('+')) fileLines.push(l.slice(1));
    else throw bad(headIdx + 2 + k);
  }
  return {
    apply(tree: Tree): void {
      if (!isSafePath(path)) throw fail('unsafe', path);
      if (tree.get(path) !== null) throw fail('exists', path);
      tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    },
  };
}

function v4aDelEdit(path: string, raw: string[], headIdx: number): Edit {
  for (let k = 0; k < raw.length; k++) {
    if (!isBlank(raw[k]!)) throw bad(headIdx + 2 + k);
  }
  return {
    apply(tree: Tree): void {
      if (!isSafePath(path)) throw fail('unsafe', path);
      if (tree.get(path) === null) throw fail('missing', path);
      tree.set(path, null);
    },
  };
}

function v4aUpdEdit(path: string, raw: string[], headIdx: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let k = 0;
  if (raw[0] !== undefined && raw[0].startsWith(V_MOVE)) {
    moveTo = raw[0].slice(V_MOVE.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let started = false;
  let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
  const flush = (): void => {
    if (cur !== null) {
      const built = buildVChunk(cur.body);
      chunks.push({ ...built, anchor: cur.anchor, eof: cur.eof });
      cur = null;
    }
  };
  for (; k < raw.length; k++) {
    const line = raw[k]!;
    const at = headIdx + 2 + k;
    if (line.startsWith('@@')) {
      flush();
      const anchorText = line.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      started = true;
      continue;
    }
    if (line === '*** End of File') {
      if (cur === null) throw bad(at);
      cur.eof = true;
      flush();
      continue;
    }
    if (line.startsWith('***')) throw bad(at);
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (cur === null) {
        if (started) throw bad(at);
        cur = { anchor: null, eof: false, body: [] };
        started = true;
      }
      cur.body.push(line);
      continue;
    }
    throw bad(at);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw bad(headIdx + 1);
  return {
    move: moveTo !== null ? [path, moveTo] : undefined,
    apply(tree: Tree): void {
      if (!isSafePath(path)) throw fail('unsafe', path);
      if (moveTo !== null && !isSafePath(moveTo)) throw fail('unsafe', moveTo);
      const cur = tree.get(path);
      if (cur === null) throw fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw fail('exists', moveTo);
      let f = splitText(cur);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const at = findAnchorLine(f.lines, ch.anchor, cursor, strict);
          if (at < 0) throw fail('no-match', path);
          cursor = at + 1;
        }
        if (ch.oldLines.length === 0) {
          const pos = ch.eof ? f.lines.length : cursor;
          const ins = ch.newLines.map((n) => n.text);
          const lines = f.lines.slice(0, pos).concat(ins, f.lines.slice(pos));
          f = { lines, br: f.br, finalBr: f.finalBr };
          cursor = pos + ins.length;
          continue;
        }
        const found = firstTier(f.lines, ch.oldLines, strict, cursor, ch.eof);
        if (!found) throw fail('no-match', path);
        const at = found.at[0]!;
        const rep = replacementLines(f.lines, at, ch, found.tier);
        const lines = f.lines.slice(0, at).concat(rep, f.lines.slice(at + ch.oldLines.length));
        f = { lines, br: f.br, finalBr: f.finalBr };
        cursor = at + rep.length;
      }
      const out = joinText(f);
      if (moveTo !== null) {
        tree.set(moveTo, out);
        tree.set(path, null);
      } else {
        tree.set(path, out);
      }
    },
  };
}

/* ---- JSON edits (SPEC section 9) ---- */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return {
      apply(tree: Tree): void {
        if (!isSafePath(p)) throw fail('unsafe', p);
        if (tree.get(p) !== null) throw fail('exists', p);
        tree.set(p, text);
      },
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      apply(tree: Tree): void {
        if (!isSafePath(p)) throw fail('unsafe', p);
        const cur = tree.get(p);
        if (cur === null) throw fail('missing', p);
        const nl = cur.indexOf('\n');
        const crlf = nl > 0 && cur[nl - 1] === '\r';
        const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = flat(cur);
        const old = flat(oldStr);
        let count = 0;
        for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
        if (count === 0) throw fail('no-match', p);
        if (count > 1) throw fail('ambiguous', p);
        const at = t.indexOf(old);
        const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
        tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return {
      apply(tree: Tree): void {
        if (!isSafePath(p)) throw fail('unsafe', p);
        const cur = tree.get(p);
        if (cur === null) throw fail('missing', p);
        const f = splitText(cur);
        if (lineNo < 0 || lineNo > f.lines.length) throw fail('no-match', p);
        const lines = f.lines.slice();
        lines.splice(lineNo, 0, ...add);
        tree.set(p, joinText({ lines, br: f.br, finalBr: f.finalBr }));
      },
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw bad(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw bad(first + 1);
    }
    if (!Array.isArray(v)) throw bad(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw bad(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw bad(i + 1);
    edits.push(e);
  });
  return edits;
}

/* ---- Format detection (SPEC section 4) ---- */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ---- Invocation, output and atomic write (SPEC sections 1, 2, 10) ---- */

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice(9);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw bad(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.apply(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const moves: [string, string][] = [];
  for (const e of edits) if (e.move !== undefined) moves.push(e.move);
  const rows: { key: string; line: string }[] = [];
  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      pairedOld.add(oldP);
      pairedNew.add(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && !pairedNew.has(p)) rows.push({ key: p, line: `A ${p}` });
    else if (now === null && !pairedOld.has(p)) rows.push({ key: p, line: `D ${p}` });
    else if (was !== null && now !== null) rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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
  const out = rows.map((r) => r.line);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
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
