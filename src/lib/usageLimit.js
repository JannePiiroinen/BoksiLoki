import { prisma } from "./prisma.js";

// Käyttörajat AI-kutsuille, jotta Anthropic-kulut pysyvät kurissa.
// Kuukausirajat luetaan ympäristömuuttujista, oletukset alla.
const MONTHLY_LIMITS = {
  wod: { env: "LIMIT_WOD_MONTH", fallback: 30 },
  photo: { env: "LIMIT_PHOTO_MONTH", fallback: 20 },
  report: { env: "LIMIT_REPORT_MONTH", fallback: 5 },
};
export const USAGE_KINDS = Object.keys(MONTHLY_LIMITS);

const COOLDOWN_MS = 5000;
const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = "Europe/Helsinki";

function envInt(name, fallback) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function monthlyLimit(kind) {
  const cfg = MONTHLY_LIMITS[kind];
  return envInt(cfg.env, cfg.fallback);
}

function globalDailyLimit() {
  return envInt("LIMIT_GLOBAL_DAY", 300);
}

function zonedParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
}

// Kuluvan kalenterikuukauden alku Suomen aikaa (palvelin ajaa UTC:ssä).
// Kesäaikasiirtymät osuvat aina kuun viimeiseen sunnuntaihin, joten 1. päivän offset on sama koko vuorokauden.
export function startOfMonth(now = new Date()) {
  const { year, month } = zonedParts(now);
  const utcMidnight = Date.UTC(year, month - 1, 1);
  const p = zonedParts(new Date(utcMidnight));
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMidnight;
  return new Date(utcMidnight - offset);
}

// Palauttaa { ok: true, eventId } tai { ok: false, message, status: 429 }.
// Tarkistus ja kirjaus tehdään samassa transaktiossa käyttäjä+kind-kohtaisen lukon alla,
// jotta kaksi samanaikaista pyyntöä eivät molemmat ehdi läpi rajan yli.
export async function checkAndRecordUsage(userId, kind) {
  if (!MONTHLY_LIMITS[kind]) throw new Error(`Tuntematon käyttölaji: ${kind}`);
  const limit = monthlyLimit(kind);
  const globalLimit = globalDailyLimit();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`usage:${userId}:${kind}`}))`;
    const now = new Date();

    const used = await tx.usageEvent.count({
      where: { userId, kind, refunded: false, createdAt: { gte: startOfMonth(now) } },
    });
    if (used >= limit) {
      return {
        ok: false,
        status: 429,
        message: `Kuukausiraja täynnä (${used}/${limit}). Uusi kiintiö alkaa kuun vaihteessa.`,
      };
    }

    const latest = await tx.usageEvent.findFirst({
      where: { userId, kind, refunded: false },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (latest && now - latest.createdAt < COOLDOWN_MS) {
      return { ok: false, status: 429, message: "Odota hetki ennen seuraavaa pyyntöä." };
    }

    const globalUsed = await tx.usageEvent.count({
      where: { refunded: false, createdAt: { gte: new Date(now.getTime() - GLOBAL_WINDOW_MS) } },
    });
    if (globalUsed >= globalLimit) {
      return { ok: false, status: 429, message: "Palvelu on tilapäisesti kovassa käytössä, yritä myöhemmin." };
    }

    const event = await tx.usageEvent.create({ data: { userId, kind }, select: { id: true } });
    return { ok: true, eventId: event.id };
  });
}

// Perutaan kirjattu käyttö, kun Anthropic-kutsu epäonnistui - virhe ei saa kuluttaa kiintiötä.
// Rivi merkitään palautetuksi eikä sitä poisteta, jotta jo maksettu kutsu näkyy kustannusraportissa.
export async function releaseUsage(eventId) {
  if (!eventId) return;
  try {
    await prisma.usageEvent.updateMany({ where: { id: eventId }, data: { refunded: true } });
  } catch {
    // ei kriittistä - pahimmillaan käyttäjältä kuluu yksi kutsu kiintiöstä
  }
}

// Tallentaa onnistuneen (tai maksetun mutta käyttökelvottoman) Anthropic-kutsun tiedot jo luotuun riviin.
// Virhe vain lokitetaan - kustannusseuranta ei saa kaataa käyttäjän pyyntöä.
export async function recordUsageDetails(eventId, { model, inputTokens, outputTokens, costUsd, latencyMs }) {
  if (!eventId) return;
  try {
    await prisma.usageEvent.update({
      where: { id: eventId },
      data: { model, inputTokens, outputTokens, costUsd, latencyMs },
    });
  } catch (err) {
    console.error("Käyttötietojen tallennus epäonnistui", eventId, err);
  }
}

export async function getMonthlyUsage(userId) {
  const groups = await prisma.usageEvent.groupBy({
    by: ["kind"],
    where: { userId, refunded: false, createdAt: { gte: startOfMonth() } },
    _count: { _all: true },
  });
  const counts = Object.fromEntries(groups.map((g) => [g.kind, g._count._all]));
  return Object.fromEntries(USAGE_KINDS.map((k) => [k, { used: counts[k] || 0, limit: monthlyLimit(k) }]));
}
