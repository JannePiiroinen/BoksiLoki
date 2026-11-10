import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";
import { subscriptionRequired } from "@/lib/subscription";
import { checkAndRecordUsage, releaseUsage, recordUsageDetails } from "@/lib/usageLimit";
import { callClaude, parseClaudeJson, usageDetails, AnthropicError } from "@/lib/anthropic";

const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_BASE64_LENGTH = 6 * 1024 * 1024;

export async function POST(request) {
  let usageEventId = null;
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Ei kirjauduttu" }, { status: 401 });
    const gate = subscriptionRequired(user);
    if (gate) return gate;

    const { imageBase64, mediaType } = await request.json();
    if (!imageBase64 || !mediaType) {
      return NextResponse.json({ error: "Kuva puuttuu" }, { status: 400 });
    }
    if (typeof imageBase64 !== "string" || !ALLOWED_MEDIA_TYPES.includes(mediaType)) {
      return NextResponse.json({ error: "Kuvan tulee olla JPEG, PNG tai WebP" }, { status: 400 });
    }
    if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
      return NextResponse.json({ error: "Kuva on liian suuri" }, { status: 413 });
    }

    const usage = await checkAndRecordUsage(user.id, "photo");
    if (!usage.ok) return NextResponse.json({ error: usage.message }, { status: usage.status });
    usageEventId = usage.eventId;

    const prompt = `Olet CrossFit-valmentaja, joka lukee tämän päivän treenin kuvasta salin liitutaulusta tai käsinkirjoitetusta lapusta.

TÄRKEÄÄ:
Lue kuvasta liikkeet, toistot, painot ja aikaraja TARKALLEEN kuten ne on kirjoitettu - älä keksi, arvaa tai täydennä mitään, mitä kuvassa ei lue.
Säilytä liikkeiden nimet ja lyhenteet täsmälleen sellaisina kuin taululla lukee (esim. "T2B" pysyy "T2B", älä laajenna sitä muotoon "toes-to-bar") - käännä vain ympäröivä teksti (otsikot, ohjeet) suomeksi, jos taulu on osittain tai kokonaan englanniksi.
Jos jokin osio (esim. alkulämmittely tai voimaosuus) ei näy kuvassa lainkaan, jätä se JSON:ssa arvoksi null - älä keksi täytettä sen tilalle.
"alkulammittely", "voimaosuus" ja "metcon.liikkeet" ovat JSON-taulukoita (array), yksi rivi/liike per taulukon alkio - ei "•"-merkkejä tai yhteen pötköön tungettuja lauseita. Väliotsikot (esim. "Tangonvalmistelu:") ovat sallittuja omana alkionaan, jos taulu erottelee vaiheita niin.
Lisää kenttä "epavarma": true, jos kuva on osittain epäselvä, huonosti valaistu, käsiala vaikeasti luettavaa tai jokin lukema jouduttiin arvaamaan tulkinnassa - muussa tapauksessa "epavarma": false.

Vastaa VAIN JSON-muodossa, ei muuta tekstiä, ei markdown-koodilohkoja:
{
  "nimi": "lyhyt nimi treenille, tai null jos ei näy kuvassa",
  "alkulammittely": ["rivi 1", "rivi 2", "..."] tai null,
  "voimaosuus": ["rivi 1", "rivi 2", "..."] tai null,
  "metcon": { "muoto": "esim. 21-15-9, tai null", "liikkeet": ["rivi 1", "rivi 2", "..."] tai null, "aikaraja": "esim. 12 min, tai null" },
  "coach_cue": "taululla mahdollisesti oleva vinkki, tai null",
  "epavarma": true tai false
}`;

    const claude = await callClaude({
      model: "claude-sonnet-4-6",
      maxTokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    await recordUsageDetails(usageEventId, usageDetails(claude));

    let wod;
    try {
      wod = parseClaudeJson(claude.text);
    } catch (parseErr) {
      console.error("AI palautti virheellistä JSONia (photo)", claude.text);
      await releaseUsage(usageEventId);
      return NextResponse.json({ error: "AI palautti virheellisen vastauksen, yritä uudelleen." }, { status: 502 });
    }
    return NextResponse.json({ wod });
  } catch (err) {
    await releaseUsage(usageEventId);
    if (err instanceof AnthropicError) {
      console.error("Anthropic-kutsu epäonnistui (photo)", err.status, err.body);
      return NextResponse.json({ error: "AI-palvelu ei juuri nyt vastaa, yritä hetken päästä uudelleen." }, { status: 502 });
    }
    console.error("Kuvan tulkinta epäonnistui", err);
    return NextResponse.json({ error: "Kuvan tulkinta epäonnistui" }, { status: 500 });
  }
}
