# Fatbikehulp CRM

Bestellingen van fatbikehulp.nl bekijken, bewerken en klanten mailen.
Live: https://fatbikehulp-crm.vercel.app (Vercel-project `fatbikehulp-crm`, team fixclan-bv).

- Bestellingen worden alleen gelezen uit de opslag van de site (sleutel `orders`). De CRM schrijft daar nooit in.
- Bewerkingen staan apart in dezelfde opslag: hash `crm:orders` (per order), `crm:bevestigd`, `crm:start`.
- Inloggen: wachtwoord in de kluis, item `fatbikehulp-crm`.
- Mail gaat via Forward Email. `MAIL_WACHTWOORD` is het verzamelwachtwoord (catch-all) van fatbikehulp.nl,
  ook in de kluis als `mail_wachtwoord`. Afzender is info@fatbikehulp.nl; antwoorden komen via het verzameladres binnen.
  Optioneel: `MAIL_VAN`, `MAIL_GEBRUIKER`, `MAIL_MELDINGEN`.
- `api/cron.js` loopt elke 5 minuten en stuurt nieuwe betaalde bestellingen één keer een bevestiging.

Testen: `npm test`. Deployen: `vercel deploy --prod`.
