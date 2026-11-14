/**
 * The expression language controllers are written in.
 *
 * It is deliberately tiny: numbers, named signals (dotted identifiers), arithmetic, comparisons,
 * and / or / not, parentheses and a handful of pure functions. There is no assignment, no loop,
 * no property access and no way to reach anything outside the values it is given — it is parsed
 * into a tree here and walked by `evaluate`, never handed to eval or Function. Both parsing and
 * evaluation are bounded, so a hostile or runaway expression cannot stall the simulation.
 */

export type Expr =
  | { t: "num"; v: number }
  | { t: "ref"; name: string }
  | { t: "un"; op: "-" | "not"; a: Expr }
  | { t: "bin"; op: string; a: Expr; b: Expr }
  | { t: "call"; fn: string; args: Expr[] };

export class ExprError extends Error {}

const MAX_LENGTH = 240;
const MAX_NODES = 80;
const MAX_DEPTH = 12;

const FUNCTIONS: Record<string, { arity: [number, number]; run(args: number[]): number }> = {
  min: { arity: [1, 6], run: (a) => Math.min(...a) },
  max: { arity: [1, 6], run: (a) => Math.max(...a) },
  abs: { arity: [1, 1], run: (a) => Math.abs(a[0]!) },
  clamp: { arity: [3, 3], run: (a) => Math.min(a[2]!, Math.max(a[1]!, a[0]!)) },
  round: { arity: [1, 1], run: (a) => Math.round(a[0]!) },
  floor: { arity: [1, 1], run: (a) => Math.floor(a[0]!) },
  mod: { arity: [2, 2], run: (a) => (a[1] === 0 ? 0 : a[0]! - a[1]! * Math.floor(a[0]! / a[1]!)) },
  if: { arity: [3, 3], run: (a) => (a[0] !== 0 ? a[1]! : a[2]!) },
};
export const EXPR_FUNCTIONS = Object.keys(FUNCTIONS);

type Token = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string };

function tokenize(src: string): Token[] {
  if (src.length > MAX_LENGTH) throw new ExprError(`expression is longer than ${MAX_LENGTH} characters`);
  const out: Token[] = [];
  let i = 0;
  const isDigit = (c: string): boolean => c >= "0" && c <= "9";
  const isStart = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && (isDigit(src[j]!) || src[j] === ".")) j++;
      if ((src[j] === "e" || src[j] === "E") && (isDigit(src[j + 1] ?? "") || ((src[j + 1] === "-" || src[j + 1] === "+") && isDigit(src[j + 2] ?? "")))) {
        j += 2;
        while (j < src.length && isDigit(src[j]!)) j++;
      }
      const v = Number(src.slice(i, j));
      if (!Number.isFinite(v)) throw new ExprError(`"${src.slice(i, j)}" is not a number`);
      out.push({ k: "num", v });
      i = j;
      continue;
    }
    if (isStart(c)) {
      let j = i + 1;
      while (j < src.length && (isStart(src[j]!) || isDigit(src[j]!) || src[j] === ".")) j++;
      out.push({ k: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) { out.push({ k: "op", v: two }); i += 2; continue; }
    if ("+-*/<>(),!".includes(c)) { out.push({ k: "op", v: c }); i++; continue; }
    throw new ExprError(`unexpected character "${c}"`);
  }
  return out;
}

/** Parse an expression. Throws ExprError with a plain-language reason when it is not valid. */
export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;
  let nodes = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isOp = (v: string): boolean => { const t = peek(); return t?.k === "op" && t.v === v; };
  const isWord = (v: string): boolean => { const t = peek(); return t?.k === "id" && t.v === v; };
  const node = <T extends Expr>(e: T): T => { if (++nodes > MAX_NODES) throw new ExprError("expression is too complex"); return e; };
  const guard = (depth: number): void => { if (depth > MAX_DEPTH) throw new ExprError("expression is nested too deeply"); };

  const or = (d: number): Expr => {
    guard(d);
    let a = and(d);
    while (isWord("or") || isOp("||")) { pos++; a = node({ t: "bin", op: "or", a, b: and(d) }); }
    return a;
  };
  const and = (d: number): Expr => {
    let a = not(d);
    while (isWord("and") || isOp("&&")) { pos++; a = node({ t: "bin", op: "and", a, b: not(d) }); }
    return a;
  };
  const not = (d: number): Expr => {
    guard(d);
    if (isWord("not") || isOp("!")) { pos++; return node({ t: "un", op: "not", a: not(d + 1) }); }
    return cmp(d);
  };
  const cmp = (d: number): Expr => {
    const a = sum(d);
    const t = peek();
    if (t?.k === "op" && ["<", ">", "<=", ">=", "==", "!="].includes(t.v)) { pos++; return node({ t: "bin", op: t.v, a, b: sum(d) }); }
    return a;
  };
  const sum = (d: number): Expr => {
    let a = product(d);
    while (isOp("+") || isOp("-")) { const op = (tokens[pos++] as { v: string }).v; a = node({ t: "bin", op, a, b: product(d) }); }
    return a;
  };
  const product = (d: number): Expr => {
    let a = unary(d);
    while (isOp("*") || isOp("/")) { const op = (tokens[pos++] as { v: string }).v; a = node({ t: "bin", op, a, b: unary(d) }); }
    return a;
  };
  const unary = (d: number): Expr => {
    guard(d);
    if (isOp("-")) { pos++; return node({ t: "un", op: "-", a: unary(d + 1) }); }
    return atom(d);
  };
  const atom = (d: number): Expr => {
    const t = tokens[pos++];
    if (!t) throw new ExprError("expression ends too early");
    if (t.k === "num") return node({ t: "num", v: t.v });
    if (t.k === "id") {
      if (t.v === "true") return node({ t: "num", v: 1 });
      if (t.v === "false") return node({ t: "num", v: 0 });
      if (isOp("(")) {
        const fn = FUNCTIONS[t.v];
        if (!fn) throw new ExprError(`"${t.v}" is not a function (available: ${EXPR_FUNCTIONS.join(", ")})`);
        pos++;
        const args: Expr[] = [];
        if (!isOp(")")) {
          args.push(or(d + 1));
          while (isOp(",")) { pos++; args.push(or(d + 1)); }
        }
        if (!isOp(")")) throw new ExprError(`missing ")" after the arguments of ${t.v}`);
        pos++;
        if (args.length < fn.arity[0] || args.length > fn.arity[1]) throw new ExprError(`${t.v} takes ${fn.arity[0] === fn.arity[1] ? fn.arity[0] : `${fn.arity[0]} to ${fn.arity[1]}`} argument(s)`);
        return node({ t: "call", fn: t.v, args });
      }
      if (["and", "or", "not"].includes(t.v)) throw new ExprError(`"${t.v}" is in the wrong place`);
      return node({ t: "ref", name: t.v });
    }
    if (t.v === "(") {
      const e = or(d + 1);
      if (!isOp(")")) throw new ExprError('missing ")"');
      pos++;
      return e;
    }
    throw new ExprError(`unexpected "${t.v}"`);
  };

  const e = or(0);
  if (pos < tokens.length) throw new ExprError(`unexpected "${(tokens[pos] as { v: string | number }).v}"`);
  return e;
}

/** Every signal name an expression reads. */
export function refsOf(e: Expr, out = new Set<string>()): Set<string> {
  if (e.t === "ref") out.add(e.name);
  else if (e.t === "un") refsOf(e.a, out);
  else if (e.t === "bin") { refsOf(e.a, out); refsOf(e.b, out); }
  else if (e.t === "call") for (const a of e.args) refsOf(a, out);
  return out;
}

/** Evaluate against a set of numbers. Unknown signals are an error; results are always finite. */
export function evaluate(e: Expr, env: (name: string) => number | undefined): number {
  const go = (x: Expr): number => {
    switch (x.t) {
      case "num": return x.v;
      case "ref": {
        const v = env(x.name);
        if (v === undefined) throw new ExprError(`unknown signal "${x.name}"`);
        return v;
      }
      case "un": return x.op === "-" ? -go(x.a) : go(x.a) === 0 ? 1 : 0;
      case "call": return FUNCTIONS[x.fn]!.run(x.args.map(go));
      case "bin": {
        if (x.op === "and") return go(x.a) !== 0 && go(x.b) !== 0 ? 1 : 0;
        if (x.op === "or") return go(x.a) !== 0 || go(x.b) !== 0 ? 1 : 0;
        const a = go(x.a);
        const b = go(x.b);
        switch (x.op) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return b === 0 ? 0 : a / b;
          case "<": return a < b ? 1 : 0;
          case ">": return a > b ? 1 : 0;
          case "<=": return a <= b ? 1 : 0;
          case ">=": return a >= b ? 1 : 0;
          case "==": return a === b ? 1 : 0;
          default: return a !== b ? 1 : 0;
        }
      }
    }
  };
  const v = go(e);
  return Number.isFinite(v) ? v : 0;
}
