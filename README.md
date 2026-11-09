# Fatbikehulp CRM

Bestellingen van fatbikehulp.nl bekijken, bewerken en klanten mailen.
Live: https://fatbikehulp-crm.vercel.app (Vercel-project `fatbikehulp-crm`, team fixclan-bv).

- Bestellingen worden alleen gelezen uit de opslag van de site (sleutel `orders`). De CRM schrijft daar nooit in.
- Bewerkingen staan apart in dezelfde opslag: hash `crm:orders` (per order), `crm:bevestigd`, `crm:start`.
- Inloggen: wachtwoord in de kluis, item `fatbikehulp-crm`.
- Mail gaat via Forward Email. Zet `MAIL_WACHTWOORD` (wachtwoord van de alias info@fatbikehulp.nl) en eventueel
  `MAIL_VAN` en `MAIL_MELDINGEN` op Vercel en deploy opnieuw. Zonder wachtwoord staat mailen uit.
- `api/cron.js` loopt elke 5 minuten en stuurt nieuwe betaalde bestellingen één keer een bevestiging.

Testen: `npm test`. Deployen: `vercel deploy --prod`.
