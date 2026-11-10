// Kuluvan kuukauden (Suomen aikaa) AI-kutsujen tokenit, kustannukset ja latenssi per laji.
// Mukana myös palautetut (epäonnistuneet) kutsut, koska ne on voitu jo laskuttaa.
//
// Ajo:  npm run cost:report   (= node --no-warnings --env-file=.env.local scripts/cost-report.mjs)
import { prisma } from "../src/lib/prisma.js";
import { startOfMonth } from "../src/lib/usageLimit.js";

const since = startOfMonth();
const where = { createdAt: { gte: since } };

const [groups, refundedGroups] = await Promise.all([
  prisma.usageEvent.groupBy({
    by: ["kind"],
    where,
    _count: { _all: true, inputTokens: true, costUsd: true },
    _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    _avg: { costUsd: true, latencyMs: true },
    orderBy: { kind: "asc" },
  }),
  prisma.usageEvent.groupBy({ by: ["kind"], where: { ...where, refunded: true }, _count: { _all: true } }),
]);
await prisma.$disconnect();

const refunded = Object.fromEntries(refundedGroups.map((g) => [g.kind, g._count._all]));
const usd = (v, digits = 4) => (v === null || v === undefined ? "–" : `$${Number(v).toFixed(digits)}`);
const int = (v) => (v === null || v === undefined ? "–" : Number(v).toLocaleString("fi-FI"));

const rows = groups.map((g) => ({
  laji: g.kind,
  kutsut: g._count._all,
  palautettu: refunded[g.kind] || 0,
  "tokenit mitattu": g._count.inputTokens,
  "input-tokenit": int(g._sum.inputTokens),
  "output-tokenit": int(g._sum.outputTokens),
  "kulut yht.": usd(g._sum.costUsd),
  "ka. / kutsu": usd(g._avg.costUsd, 5),
  "ka. latenssi": g._avg.latencyMs === null ? "–" : `${Math.round(g._avg.latencyMs)} ms`,
}));

const totalCost = groups.reduce((sum, g) => sum + Number(g._sum.costUsd ?? 0), 0);
const totalCalls = groups.reduce((sum, g) => sum + g._count._all, 0);
const totalPriced = groups.reduce((sum, g) => sum + g._count.costUsd, 0);

console.log(`AI-käyttö ${since.toLocaleDateString("fi-FI", { timeZone: "Europe/Helsinki" })} alkaen\n`);
if (rows.length === 0) {
  console.log("Ei kutsuja tässä kuussa.");
} else {
  console.table(rows);
  console.log(`\nYhteensä ${totalCalls} kutsua, kulut ${usd(totalCost)} (${totalPriced} kutsulla hinta laskettu).`);
}
if (totalPriced < totalCalls) {
  console.log(
    "Huom: osalta kutsuista puuttuu tokenit tai hinta - ne on kirjattu ennen kustannusseurantaa, kutsu epäonnistui " +
      "ennen vastausta, tai PRICE_INPUT_PER_MTOK / PRICE_OUTPUT_PER_MTOK puuttui ympäristöstä."
  );
}
