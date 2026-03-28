"use strict";

function tSafe(s, max = 92) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "—";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function tShortProgram(p) {
  const s = String(p || "—").trim();
  return s.length > 44 ? s.slice(0, 41) + "…" : s;
}

function tFmtMin(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 60) return `${Math.round(n)}m`;
  const h = Math.floor(n / 60);
  const r = n % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function tFmtDateShort(dt) {
  if (!dt) return "—";
  try {
    const d = new Date(dt);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
  } catch (_) {
    return "—";
  }
}

function tFmtTimeShort(dt) {
  if (!dt) return "—";
  try {
    const d = new Date(dt);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
  } catch (_) {
    return "—";
  }
}

function tFmtDateTimeShort(dt) {
  if (!dt) return "—";
  try {
    const d = new Date(dt);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (_) {
    return "—";
  }
}

function parseIsoOrNull(v) {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

function fmtWhen(iso) {
  const d = parseIsoOrNull(iso);
  if (!d) return "—";
  return d.toLocaleString();
}

module.exports = {
  fmtWhen,
  parseIsoOrNull,
  tFmtDateShort,
  tFmtDateTimeShort,
  tFmtMin,
  tFmtTimeShort,
  tSafe,
  tShortProgram,
};
