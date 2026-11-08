// Shared ordering for engine lists (你的 AI, 日常·配额, 用量与账单·方案用量).
// 1. ready (installed + signed in): most recently used first
// 2. signed in but never used: most recently signed in first
// 3. everything else: name A→Z
// Within a group, items missing the timestamp go after those with one, then A→Z.

export interface EngineSortItem {
  name: string;
  ready?: boolean;
  signedIn?: boolean;
  lastUsedAt?: number | null;
  lastSignInAt?: number | null;
}

const byName = (a: string, b: string) => a.localeCompare(b, "zh", { sensitivity: "base" });

function group(item: EngineSortItem): 0 | 1 | 2 {
  if (item.ready && item.lastUsedAt) return 0;
  if (item.ready || item.signedIn) return 1;
  return 2;
}

function stamp(item: EngineSortItem, g: number): number | null {
  if (g === 0) return item.lastUsedAt ?? null;
  if (g === 1) return item.lastSignInAt ?? null;
  return null;
}

export function compareEngines(a: EngineSortItem, b: EngineSortItem): number {
  const ga = group(a), gb = group(b);
  if (ga !== gb) return ga - gb;
  const sa = stamp(a, ga), sb = stamp(b, gb);
  if (sa != null && sb != null && sa !== sb) return sb - sa;
  if (sa != null && sb == null) return -1;
  if (sa == null && sb != null) return 1;
  return byName(a.name, b.name);
}

export function sortEngines<T extends EngineSortItem>(items: readonly T[]): T[] {
  return [...items].sort(compareEngines);
}
