# ESSPortal Rapport

Det här repot innehåller en Node/Express-webbapp för att läsa ESSPortal-matchlänkar, sammanställa data och visa statistik.

## Syfte

- Hämta data direkt från en ESSPortal-matchlänk
- Visa matchinformation i webbläsaren
- Beräkna grundlägande statistik för numeriska fält

## Struktur

- `app.js` – Node/Express-server för webbsidan
- `package.json` – projektberoenden
- `views/` – EJS-mall för gränssnittet
- `src/` – kvarvarande Python-skript för tidigare prototyp

## Kör webbsidan

1. Installera beroenden:

```powershell
npm install
```

2. Starta appen:

```powershell
npm start
```

Om port 5000 redan är upptagen kan du ange en annan port:

```powershell
$env:PORT=5001; npm start
```

3. Öppna webbläsaren:

`http://127.0.0.1:5000`

## Samla alla divisioner

När du anger en matchlänk visar appen matchens divisioner som klickbara knappar.
- Klicka på en division för att se dess faktiska resultat i appen.
- Klicka på `Combined` för att se en sammanställning av alla divisioner i en gemensam vy.

Appen använder en headless browser för att hämta divisionsresultaten direkt från portalen. Om portalen blockerar åtkomst eller om resultaten kräver aktiv reCAPTCHA-verifiering kan appen visa en notis istället för tabellens faktiska rader.

4. Klistra in matchlänken och skicka formuläret.

## Support för URL

Du kan klistra in en matchlänk som:

`https://portal.ipscess.org/portal/match/bfea5009-6381-4e7e-972a-e51adfb0a33c`

## Tidigare Python-prototyp

Det finns fortfarande ett Python-skript i `src/` från den tidigare MVP:n, men huvudappen körs nu i Node.
