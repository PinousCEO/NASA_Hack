/**
 * Config path helpers. Paths are dot-separated ("orbit.semiMajorAxisKm").
 * When a segment addresses an array, it matches an element by its `id` field first,
 * then by numeric index ("spacecraft.components.sp1.areaM2").
 */
export type PatchOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "append"; path: string; value: unknown }
  | { op: "remove"; path: string };

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function splitPath(path: string): string[] {
  const parts = path.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error(`Empty path`);
  for (const p of parts) if (FORBIDDEN.has(p)) throw new Error(`Forbidden path segment "${p}"`);
  return parts;
}

function child(container: unknown, key: string): { found: boolean; value?: unknown; index?: number } {
  if (Array.isArray(container)) {
    const byId = container.findIndex((el) => el && typeof el === "object" && (el as { id?: unknown }).id === key);
    if (byId >= 0) return { found: true, value: container[byId], index: byId };
    if (/^\d+$/.test(key) && Number(key) < container.length) {
      return { found: true, value: container[Number(key)], index: Number(key) };
    }
    return { found: false };
  }
  if (container && typeof container === "object" && Object.hasOwn(container, key)) {
    return { found: true, value: (container as Record<string, unknown>)[key] };
  }
  return { found: false };
}

export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of splitPath(path)) {
    const next = child(cur, key);
    if (!next.found) return undefined;
    cur = next.value;
  }
  return cur;
}

export function applyPatch<T>(root: T, patch: PatchOp): T {
  const clone = structuredClone(root);
  const parts = splitPath(patch.path);
  const last = parts.pop()!;
  let cur: unknown = clone;
  for (const key of parts) {
    const next = child(cur, key);
    if (!next.found || next.value === null || typeof next.value !== "object") {
      throw new Error(`Path "${patch.path}" does not exist (missing "${key}")`);
    }
    cur = next.value;
  }
  if (patch.op === "append") {
    const target = child(cur, last);
    if (!target.found || !Array.isArray(target.value)) throw new Error(`Path "${patch.path}" is not an array`);
    target.value.push(structuredClone(patch.value));
    return clone;
  }
  if (Array.isArray(cur)) {
    const target = child(cur, last);
    if (!target.found) throw new Error(`Path "${patch.path}" does not exist`);
    if (patch.op === "remove") cur.splice(target.index!, 1);
    else cur[target.index!] = structuredClone(patch.value);
    return clone;
  }
  if (cur === null || typeof cur !== "object") throw new Error(`Path "${patch.path}" does not exist`);
  const obj = cur as Record<string, unknown>;
  if (patch.op === "remove") {
    if (!Object.hasOwn(obj, last)) throw new Error(`Path "${patch.path}" does not exist`);
    delete obj[last];
  } else {
    obj[last] = structuredClone(patch.value);
  }
  return clone;
}

export function applyPatches<T>(root: T, patches: PatchOp[]): T {
  return patches.reduce((acc, p) => applyPatch(acc, p), root);
}

export interface DiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

/** Leaf-level structural diff. Array elements with an `id` are matched by id, others by index. */
export function diff(before: unknown, after: unknown, base = ""): DiffEntry[] {
  if (Object.is(before, after)) return [];
  const isObj = (v: unknown): v is object => v !== null && typeof v === "object";
  if (!isObj(before) || !isObj(after) || Array.isArray(before) !== Array.isArray(after)) {
    if (before === undefined) return [{ path: base, kind: "added", after }];
    if (after === undefined) return [{ path: base, kind: "removed", before }];
    return [{ path: base, kind: "changed", before, after }];
  }
  const keyed = (v: object): Map<string, unknown> => {
    if (Array.isArray(v)) {
      return new Map(
        v.map((el, i) => [
          el && typeof el === "object" && typeof (el as { id?: unknown }).id === "string"
            ? (el as { id: string }).id
            : String(i),
          el,
        ]),
      );
    }
    return new Map(Object.entries(v));
  };
  const a = keyed(before);
  const b = keyed(after);
  const out: DiffEntry[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    out.push(...diff(a.get(key), b.get(key), base ? `${base}.${key}` : key));
  }
  return out;
}

/** True when a changed path and a dependency prefix overlap (either contains the other). */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}
