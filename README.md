# Fatbikehulp CRM

Bestellingen van fatbikehulp.nl en deskna.nl bekijken, bewerken en klanten mailen.
Live: https://fatbikehulp-crm.vercel.app (Vercel-project `fatbikehulp-crm`, team fixclan-bv).

- Indeling: menu links met Overzicht (te verzenden, omzet, grafiek per dag, meest verkocht, per winkel), Bestellingen,
  Verzendingen (DHL-labels) en Klanten; bovenaan zoeken (toets `/`) en de winkelkeuze in het menu. De pagina staat in het
  adres (`#/bestellingen`), een open bestelling erachter (`#/bestellingen/<order>`), dus de terugknop en directe links werken.
  Alles zit in één bestand, `public/index.html`, zonder bouwstap.
- Bestellingen worden alleen gelezen uit de opslag van de site (sleutel `orders`). De CRM schrijft daar nooit in.
- Deskna: de opslag van de Deskna-webshop (`upstash-kv-rose-car-deskna`) is gekoppeld met voorvoegsel `DESKNA`.
  De CRM leest daar de sleutels `order:<id>` met het alleen-lezen-token (`DESKNA_KV_REST_API_READ_ONLY_TOKEN`).
  Deskna-bestellingen van vóór de koppeling (`crm:deskna:start`) staan standaard op "Afgeleverd".
- Mail gaat per winkel vanaf het eigen adres. Voor Deskna is `DESKNA_MAIL_WACHTWOORD` nodig (verzamelwachtwoord
  van deskna.nl in Forward Email); zonder staat mailen voor Deskna uit. De automatische bevestiging voor Deskna
  staat uit tot `DESKNA_AUTO_BEVESTIGING=1` is gezet.
- Archief van het oude CRM (Express + SQLite op de Mac mini M4, liep tot 14 okt 2026): 918 orders van Fatbikehulp,
  Deskna en Fatbiketeile in `data/archief.json`, met oud ordernummer (`#2478`), volgcodes, statusgeschiedenis, oude mails,
  retouren en betaalmeldingen. Maken: `node scripts/archief-maken.js <kopie van crm.sqlite>` (de database staat op de
  T9-backup onder `Mac mini M4/CRM fatbikehulp.nl/db/`). Het bestand bevat klantgegevens: het staat in `.gitignore`,
  gaat wel mee met `vercel deploy` en wordt niet gepubliceerd (alleen `public/` is van buiten bereikbaar).
  Staat een order ook in een webshop (zelfde Stripe-betaling, of bij handmatige orders zelfde klant, bedrag en dag),
  dan telt de webshoporder en komen de gegevens uit het archief erbij. Archieforders krijgen nooit een automatische mail.
  Orders die in het oude CRM nog op nieuw/verwerkt stonden en betaald zijn, staan op Afgeleverd als ze van vóór
  14 sep 2026 zijn; recentere staan in "Te verzenden" om na te lopen.
- Fatbiketeile (fatbiketeile.de) heeft alleen het archief; mails gaan in het Duits vanaf
  "Fatbiketeile.de <info@fatbikehulp.nl>" met het wachtwoord van fatbikehulp.nl. Eigen afzender: `FATBIKETEILE_MAIL_VAN`
  + `FATBIKETEILE_MAIL_WACHTWOORD`.
- Bewerkingen staan apart in dezelfde opslag: hash `crm:orders` (per order), `crm:bevestigd`, `crm:start`.
- Inloggen: wachtwoord in de kluis, item `fatbikehulp-crm`.
- Mail gaat via Forward Email. `MAIL_WACHTWOORD` is het verzamelwachtwoord (catch-all) van fatbikehulp.nl,
  ook in de kluis als `mail_wachtwoord`. Afzender is info@fatbikehulp.nl; antwoorden komen via het verzameladres binnen.
  Optioneel: `MAIL_VAN`, `MAIL_GEBRUIKER`, `MAIL_MELDINGEN`.
- `api/cron.js` loopt elke 5 minuten en stuurt nieuwe betaalde bestellingen één keer een bevestiging.

- DHL-label: in een order kies je het formaat (envelop, brievenbuspakket, pakket tot 5/10/20 kg) en thuisbezorgen of
  DHL ServicePoint. De CRM legt een opdracht klaar (hash `crm:labels`); de bot in `bot/` (draait op de Windows-pc)
  vult het formulier op my.dhlecommerce.nl in tot aan de betaling en meldt de betaallink. Die komt via Seintje als
  pushmelding op de telefoon; tik erop en betaal met iDEAL. De bot betaalt zelf nooit. Na het betalen zet hij de
  volgcode bij de order en mailt DHL het label naar het afzenderadres. Alleen Nederland.
  Aanzetten: `LABEL_BOT_SLEUTEL` (minstens 24 tekens) in Vercel, dezelfde waarde als `sleutel` in
  `bot/instellingen.json` (voorbeeld: `bot/instellingen.voorbeeld.json`, met het afzenderadres per winkel).
  Printen: de knop "Printen op de Zebra" bij een gemaakt label legt een printopdracht klaar; de bot snijdt het label uit
  de pdf, zet het rechtop en print het passend op het label dat in de printer is ingesteld (Zebra ZD220, 100 × 150 mm;
  andere printer: `printer` in `bot/instellingen.json`). Los proberen: `node bot.js --print <bestand.pdf>` in `bot/`.
  Alles wat er met een order gebeurt staat in het logboek (`crm:log:<order>`); labels blijven bewaard als pdf.
  Bot starten: `bot/start.cmd`. Proefronde zonder CRM en zonder betalen: `node bot.js --proef` in `bot/`.

Testen: `npm test`. Deployen: `vercel deploy --prod`.
