import { createHash, randomUUID } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function stableId(...parts: Array<string | number | null | undefined>): string {
  const hash = createHash("sha1").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex");
  return hash.slice(0, 16);
}

export function uid(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function hoursBetween(aIso: string, bIso: string): number {
  return Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime()) / 36e5;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
