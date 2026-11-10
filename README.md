# BoksiLoki — Vaihe 1

AI-WOD-generaattori, treenilogi ja kehitysraportit CrossFit-urheilijoille.
Tämä on ensimmäinen oikea (ei-artifact) versio: Next.js + Prisma + Postgres.

## 1. Paikallinen kehitys (VS Code)

### Esivaatimukset
- Node.js 18+ asennettuna
- Ilmainen Postgres-tietokanta: [neon.tech](https://neon.tech) tai [supabase.com](https://supabase.com) — molemmat
  antavat ilmaisen `DATABASE_URL`-yhteysosoitteen sekunneissa, ei tarvitse asentaa Postgresia koneelle
- Anthropic API -avain: [console.anthropic.com](https://console.anthropic.com)

### Asennus
```bash
npm install
cp .env.example .env
# täytä .env: DATABASE_URL ja ANTHROPIC_API_KEY
npx prisma db push   # luo taulut tietokantaan schema.prisma:n mukaan
npm run dev
```

Avaa [http://localhost:3000](http://localhost:3000) — tämä on se "reaaliaikainen testiympäristö":
Next.js päivittää sivun automaattisesti aina kun tallennat tiedoston VS Codessa (hot reload).

### Tietokannan sisällön tarkastelu
```bash
npx prisma studio
```
Avaa selaimeen visuaalisen näkymän tietokannan riveihin — hyödyllinen debuggaukseen.

## 2. Jaettava live-esikatselu

Kun haluat jakaa linkin jonka voi avata kuka tahansa (ei vain omalla koneellasi ajettuna):

1. Luo GitHub-repo ja pushaa tämä projekti sinne
2. Mene [vercel.com](https://vercel.com), kirjaudu GitHub-tunnuksilla, "Import Project" ja valitse repo
3. Lisää samat ympäristömuuttujat (`DATABASE_URL`, `ANTHROPIC_API_KEY`) Vercelin Settings → Environment Variables -kohtaan
4. Deploy — saat julkisen `https://boksiloki-xxxx.vercel.app`-osoitteen

Tämän jälkeen **jokainen git push päivittää live-version automaattisesti** muutaman sekunnin viiveellä —
tämä on käytännössä "reaaliaikainen" jaettava ympäristö ilman että sinun tarvitsee pyörittää omaa palvelinta.
Vercelin ilmainen taso riittää pilottivaiheeseen mainiosti.

## 3. Rakenne

```
src/app/page.js           - koko käyttöliittymä (yksi sivu, kolme välilehteä)
src/app/api/wod/          - AI-WOD-generaattori (kutsuu Anthropic APIa palvelimella)
src/app/api/workouts/     - treenilogi (GET/POST/DELETE)
src/app/api/prs/          - ennätykset
src/app/api/report/       - AI-kehitysraportti
src/app/api/usage/        - kuluvan kuukauden AI-käyttö ja rajat (GET)
src/lib/usageLimit.js     - AI-kutsujen käyttörajat ja käytön kirjaus
src/lib/anthropic.js      - keskitetty Anthropic-kutsu (tokenit, kustannus, latenssi)
prisma/schema.prisma      - tietokantamalli
```

## 4. AI-käyttörajat

Jokainen Anthropic-kutsu (WOD, kuvan tulkinta, raportti) kirjataan `UsageEvent`-tauluun, ja kutsu estetään
HTTP 429:llä, jos jokin raja ylittyy. Epäonnistunut AI-kutsu ei kuluta kiintiötä: rivi merkitään
`refunded`-tilaan, mutta se säilyy kustannusraportissa, koska kutsu on voitu jo laskuttaa.

| Muuttuja | Oletus | Merkitys |
|---|---|---|
| `LIMIT_WOD_MONTH` | 30 | WOD-generointeja / käyttäjä / kalenterikuukausi |
| `LIMIT_PHOTO_MONTH` | 20 | Taulukuvan tulkintoja / käyttäjä / kalenterikuukausi |
| `LIMIT_REPORT_MONTH` | 5 | Kehitysraportteja / käyttäjä / kalenterikuukausi |
| `LIMIT_GLOBAL_DAY` | 300 | Kaikki AI-kutsut yhteensä kaikilta käyttäjiltä / 24 h (hätäjarru) |

Lisäksi kiinteästi: sama käyttäjä + sama toiminto enintään kerran / 5 s, ja kuva enintään ~6 MB
(JPEG/PNG/WebP). Kuukausi vaihtuu Suomen aikaa. Muuttujia ei tarvitse asettaa, jos oletukset kelpaavat.

### Rajojen testaus

Nopea testi suoraan tietokantaa vasten (ei Anthropic-kutsuja, ei maksa mitään; luo ja poistaa testikäyttäjän):
```bash
npm run test:usage
```

Päästä päähän -testi oikeaa API:a vasten (kaksi ensimmäistä kutsua kuluttavat Anthropic-krediittejä,
ja testikäyttäjällä pitää olla aktiivinen tilaus):
```bash
LIMIT_WOD_MONTH=2 npm run dev
# toisessa terminaalissa:
for i in 1 2 3; do
  curl -s -X POST localhost:3000/api/wod -H 'Content-Type: application/json' \
    -d '{"focus":"Sekoitus","duration":20,"level":"Scaled","equipment":"Ei välineitä"}' \
    -o /dev/null -w "kutsu $i: HTTP %{http_code}\n"
  sleep 6
done
curl -s localhost:3000/api/usage
```
Kolmannen kutsun pitäisi palauttaa 429. Huom: jos kuluvalla kuulla on jo aiempia WOD-kutsuja, raja tulee
vastaan aiemmin. Testirivit voi poistaa Prisma Studiosta (`UsageEvent`-taulu).

### Kustannusseuranta

Jokaisesta kutsusta tallennetaan malli, input- ja output-tokenit, kustannus (USD) ja latenssi.
Kustannus lasketaan muuttujista `PRICE_INPUT_PER_MTOK` ja `PRICE_OUTPUT_PER_MTOK` (USD / miljoona tokenia,
tarkista Anthropicin hinnastosta). Kuluvan kuukauden yhteenveto per toiminto:
```bash
npm run cost:report
```

## 5. Puuttuu vielä (seuraavat vaiheet)

- **Kirjautuminen** — kaikki data menee yhdelle kovakoodatulle testikäyttäjälle
  (`src/lib/currentUser.js`). NextAuth-toteutus poistettiin demo/myyntivaiheen ajaksi
  (ks. git-historia, commit 06dc76e) — asennetaan takaisin kun kirjautuminen otetaan käyttöön.
- **Salikohtaisuus** — Gym-malli ja jäsenyydet, kun laajennetaan useammalle salille
- **Maksut/tilaus** — Stripe, kun tuote on myyntikunnossa
