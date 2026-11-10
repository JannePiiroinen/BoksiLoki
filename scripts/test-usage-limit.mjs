// Testaa käyttörajat suoraan tietokantaa vasten ilman Anthropic-kutsuja (ei maksa mitään).
// Luo väliaikaisen testikäyttäjän ja poistaa sen lopuksi (UsageEvent-rivit poistuvat cascadella).
//
// Ajo:  npm run test:usage   (= node --no-warnings --env-file=.env.local scripts/test-usage-limit.mjs)
import { prisma } from "../src/lib/prisma.js";
import { checkAndRecordUsage, releaseUsage, getMonthlyUsage } from "../src/lib/usageLimit.js";

process.env.LIMIT_WOD_MONTH = "2";
const COOLDOWN_WAIT_MS = 5200;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function expect(label, result, ok) {
  const pass = result.ok === ok;
  if (!pass) failures++;
  console.log(`${pass ? "OK  " : "FAIL"} ${label} -> ${result.ok ? "ok" : `${result.status} "${result.message}"`}`);
}

const user = await prisma.user.create({ data: { email: `usage-test-${Date.now()}@example.invalid` } });
try {
  console.log("LIMIT_WOD_MONTH=2, jäähdytys 5 s\n");

  expect("1. kutsu", await checkAndRecordUsage(user.id, "wod"), true);
  expect("2. kutsu heti perään (jäähdytys)", await checkAndRecordUsage(user.id, "wod"), false);
  await wait(COOLDOWN_WAIT_MS);
  expect("2. kutsu 5 s jälkeen", await checkAndRecordUsage(user.id, "wod"), true);
  await wait(COOLDOWN_WAIT_MS);
  expect("3. kutsu (kuukausiraja 2/2)", await checkAndRecordUsage(user.id, "wod"), false);

  const photo = await checkAndRecordUsage(user.id, "photo");
  expect("eri laji (photo) ei ole rajoitettu", photo, true);
  await releaseUsage(photo.eventId);
  const photoUsed = (await getMonthlyUsage(user.id)).photo.used;
  const releasedRow = await prisma.usageEvent.findUnique({ where: { id: photo.eventId } });
  const releaseOk = photoUsed === 0 && releasedRow?.refunded === true;
  if (!releaseOk) failures++;
  console.log(`${releaseOk ? "OK  " : "FAIL"} peruttu kutsu ei kuluta kiintiötä (${photoUsed}) mutta rivi säilyy kustannusraporttia varten`);

  const parallel = await Promise.all([checkAndRecordUsage(user.id, "report"), checkAndRecordUsage(user.id, "report")]);
  const okCount = parallel.filter((r) => r.ok).length;
  if (okCount !== 1) failures++;
  console.log(`${okCount === 1 ? "OK  " : "FAIL"} kaksi samanaikaista report-kutsua -> ${okCount} läpi (odotus 1)`);

  console.log("\n/api/usage palauttaisi:", JSON.stringify(await getMonthlyUsage(user.id)));
} finally {
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
}

console.log(failures ? `\n${failures} testiä epäonnistui` : "\nKaikki testit läpi");
process.exit(failures ? 1 : 0);
