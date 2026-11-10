import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/currentUser";
import { subscriptionRequired } from "@/lib/subscription";
import { checkAndRecordUsage, releaseUsage, recordUsageDetails } from "@/lib/usageLimit";
import { callClaude, parseClaudeJson, usageDetails, AnthropicError } from "@/lib/anthropic";

export async function POST(request) {
  let usageEventId = null;
  try {
    const { focus, bodyPart, duration, level, equipment } = await request.json();
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Ei kirjauduttu" }, { status: 401 });
    const gate = subscriptionRequired(user);
    if (gate) return gate;

    const usage = await checkAndRecordUsage(user.id, "wod");
    if (!usage.ok) return NextResponse.json({ error: usage.message }, { status: usage.status });
    usageEventId = usage.eventId;

    const recentWorkouts = await prisma.workout.findMany({
      where: { userId: user.id },
      orderBy: { date: "desc" },
      take: 5,
    });
    const recent = recentWorkouts.map((w) => `${w.date.toISOString().slice(0, 10)}: ${w.desc}`).join("; ");
    const recentFocuses = recentWorkouts
      .filter((w) => w.focus)
      .map((w) => `${w.date.toISOString().slice(0, 10)}: ${w.focus}`)
      .join(", ");

    const prompt = `Olet kokenut CrossFit-valmentaja. Suunnittele yksi tämän päivän treeni (WOD) suomeksi seuraavilla parametreilla:
- Painopiste: ${focus}
- Kehonosa-painotus: ${bodyPart || "Koko keho"}
- Kesto: noin ${duration} minuuttia
- Taso: ${level}
- Käytettävissä oleva välineistö: ${equipment}
- Viimeaikaiset treenit (vältä liiallista toistoa): ${recent || "ei tietoa"}
- Viimeaikaiset painopisteet (uusin ensin): [${recentFocuses || "ei tietoa"}]

TÄRKEÄÄ liikkeiden nimistä - kaksi eri kategoriaa, älä sekoita niitä:

1. VARSINAISET CROSSFIT-LIIKKEET pysyvät englanniksi sellaisenaan (näitä EI käännetä koskaan): thruster, wall ball, box jump, pull-up, kettlebell swing, clean and jerk, snatch, deadlift, burpee, double-under, pistol squat, mountain climber, muscle-up, toes-to-bar, handstand push-up, push-up, ja muut vastaavat vakiintuneet CrossFit-liikkeiden nimet. Näille EI kirjoiteta selitystä sulkeissa - vain nimi ja toistomäärä/paino, kuten oikealla CrossFit-boksin liitutaululla.

2. YLEISET ALKULÄMMITTELY- JA LIIKKUVUUSTERMIT käännetään AINA suomeksi, koska niitä ei sanota englanniksi suomalaisilla saleilla. Käytä vakiintuneita suomennoksia, esim.: lunge → askelkyykky, hinge / hip hinge → lonkkasarana, kevyt/kehon painon squat (esim. air squat lämmittelyssä) → kyykky, hip circle → lonkkakierto, arm circle → olkapyöritys, high knees → polvennostojuoksu, butt kick → kantapotku, plank → lankku, side lunge → sivuaskelkyykky, calf raise → pohjenousu, glute bridge → lantionnosto / silta, cat-cow → kissa-lehmä-liike. Jos jokin yleistermi ei ole tässä listassa, käännä se järkevällä suomenkielisellä vastineella samalla periaatteella - älä koskaan jätä yleistä alkulämmittely-/liikkuvuustermiä englanniksi. Näille käännetyille termeille ei myöskään kirjoiteta selitystä sulkeissa, ellei kyseessä ole muunneltu/skaalattu versio (ks. kohta alla).

Älä koskaan yhdistä näitä kahta kategoriaa sekakielisiksi keksityiksi yhdyssanoiksi (esim. "pistoolimaa-kyykky" on aina väärin).
LISÄÄ sen sijaan lyhyt (max 5-8 sanan) suomenkielinen selitys sulkeissa aina, kun liike on: (a) tangonvalmistelu- tai olympiannostoliike (esim. puutanko pass-through, muscle snatch, overhead squat puutangolla, positional clean), (b) harvinaisempi gymnastiikka- tai lisäliike, tai (c) muunneltu/skaalattu versio perusliikkeestä.
Kun alkulämmittelyssä tarvitaan kevyt väline tangonvalmisteluun, käytä aina termiä "puutanko" (ei "PVC", "PVC-putki" tai "puukeppi") - saleilla käytetään puutankoja, ei muoviputkia.
Kaikki muu teksti (otsikot, kuvaukset, vinkit) kirjoitetaan suomeksi, mutta pidä ne lyhyinä - älä kirjoita fysioterapiamaisia pitkiä ohjeita.
Kirjoita voimaosuuden lisähuomiot ja coach_cue täysinä, luontevina suomenkielisinä lauseina - älä irrallisina sanafragmentteina (esim. älä kirjoita "pakarat alle polvet", vaan "vie lantio niin syvälle, että pakarat laskeutuvat polvien alapuolelle").
TÄRKEÄÄ rakenteesta: "alkulammittely", "voimaosuus" ja "metcon.liikkeet" ovat JSON-taulukoita (array), EI yhtä pitkää merkkijonoa. Jokainen erillinen liike, sarja tai ohje omana taulukon alkionaan (yksi rivi = yksi asia, ei "•"-merkkejä tai pilkuilla/väliviivoilla yhteen pötköön tungettuja lauseita). Esim. alkulammittely: ["2 kierrosta:", "10 lonkkakierto per suunta", "10 kahvakuula deadlift kevyellä painolla", "8 goblet squat"].
Älä koskaan lisää pelkkää erotinriviä (esim. "---" tai "***") omaksi taulukon alkiokseen alilohkojen väliin - jos alkulämmittelyssä tai voimaosuudessa on selkeästi eri vaiheita (esim. yleinen lämmittely ja tangonvalmistelu), listaa ne silti yhtenä jatkuvana alkioiden sarjana ilman erotinta, tarvittaessa oman lyhyen otsikkorivin avulla (esim. "Tangonvalmistelu:").

TÄRKEÄÄ painopisteen valinnasta: jos käyttäjän tämänkertainen valitsema painopiste (${focus}) on sama kuin edellisen treenin painopiste, ja edellisestä treenistä on alle 48 tuntia, harkitse silti pyydettyä painopistettä kunnioittaen - käyttäjä on itse valinnut sen tietoisesti. Sen sijaan käytä painopistehistoriaa ohjaamaan METCONIN LIIKEVALINTOJA: jos edellinen treeni painotti ylävartaloa raskaasti (esim. penkki, punnerrus, leuanveto), vältä tässä treenissä samojen lihasryhmien raskasta kuormittamista uudelleen, vaikka painopisteeksi olisi valittu jotain muuta - valitse sen sijaan liikkeitä jotka tukevat palautumista niiltä osin.

TÄRKEÄÄ kehonosa-painotuksesta: jos kehonosa-painotus on muu kuin "Koko keho", valitse SEKÄ voimaosuuden että metconin liikkeet niin, että ne pääasiassa kuormittavat kyseistä kehonosaa - esim. "Jalat" → kyykky-/maastaveto-/askelkyykky-tyyppiset liikkeet sekä juoksu/hyppelyliikkeet, "Yläkroppa" → punnerrus-/veto-/olkapääliikkeet (esim. push press, pull-up, thruster, box painonnosto ylävartalolla), "Core" → vatsa-/keskivartalostabiliteetti- ja rotaatioliikkeet (esim. toes-to-bar, GHD sit-up, plank-variaatiot), "Selkä / takaketju" → maastaveto-, hip hinge- ja veto-tyyppiset liikkeet (esim. deadlift, kettlebell swing, pull-up). Alkulämmittely saa silti sisältää yleistä koko kehon aktivointia normaalisti - painotus koskee vain varsinaista harjoitusosaa. Jos kehonosa-painotus on "Koko keho", suunnittele normaalisti tasapainoisesti eri kehonosia yhdistäen.

JSON-rakenne:
{
  "nimi": "lyhyt nimi treenille",
  "alkulammittely": ["rivi 1", "rivi 2", "..."],
  "voimaosuus": ["rivi 1", "rivi 2", "..."] tai null jos ei sovellu,
  "metcon": { "muoto": "esim. 21-15-9", "liikkeet": ["rivi 1", "rivi 2", "..."], "aikaraja": "esim. 12 min tai null" },
  "coach_cue": "yksi lyhyt vinkki suoritukseen"
}`;

    const claude = await callClaude({
      model: "claude-sonnet-4-6",
      maxTokens: 1200,
      messages: [{ role: "user", content: prompt }],
    });
    await recordUsageDetails(usageEventId, usageDetails(claude));

    let wod;
    try {
      wod = parseClaudeJson(claude.text);
    } catch (parseErr) {
      console.error("AI palautti virheellistä JSONia (wod)", claude.text);
      await releaseUsage(usageEventId);
      return NextResponse.json({ error: "AI palautti virheellisen vastauksen, yritä uudelleen." }, { status: 502 });
    }
    return NextResponse.json({ wod });
  } catch (err) {
    await releaseUsage(usageEventId);
    if (err instanceof AnthropicError) {
      console.error("Anthropic-kutsu epäonnistui (wod)", err.status, err.body);
      return NextResponse.json({ error: "AI-palvelu ei juuri nyt vastaa, yritä hetken päästä uudelleen." }, { status: 502 });
    }
    console.error("WOD:n luonti epäonnistui", err);
    return NextResponse.json({ error: "WOD:n luonti epäonnistui" }, { status: 500 });
  }
}
