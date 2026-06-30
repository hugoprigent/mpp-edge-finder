import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const cookieName = "mpp_edge_session";
const maxAgeSeconds = 14 * 24 * 60 * 60;

export function isAuthenticated(headers: Record<string, string | string[] | undefined>): boolean {
  const token = readCookie(headers.cookie, cookieName);
  if (!token) return false;
  const [expiresText, signature] = token.split(".");
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  return safeEqual(signature, sign(expiresText));
}

export function validPin(pin: string | undefined): boolean {
  if (!pin) return false;
  return config.dashboardPinCodes.includes(pin.trim());
}

export function loginCookie(): string {
  const expires = String(Date.now() + maxAgeSeconds * 1000);
  return `${cookieName}=${expires}.${sign(expires)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function logoutCookie(): string {
  return `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function sign(value: string): string {
  return createHmac("sha256", config.dashboardSessionSecret).update(value).digest("base64url");
}

function readCookie(header: string | string[] | undefined, name: string): string | null {
  const value = Array.isArray(header) ? header.join(";") : header;
  if (!value) return null;
  for (const part of value.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function safeEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
