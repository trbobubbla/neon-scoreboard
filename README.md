# ESSPortal Rapport

Det här repot innehåller verktyg för att sammanställa och aggregera ESSPortal-matcher, statistik och kombinerade resultat.

## Syfte

- Läs in matchfiler (CSV eller JSON)
- Sammanställ matcher till ett gemensamt resultat
- Beräkna statistik per kategori
- Exportera kombinerade resultat till JSON/CSV

## Struktur

- `src/` – skript för sammanställning och analys
- `requirements.txt` – beroenden för projektet
- `.gitignore` – filer som ska ignoreras av Git

## Exempel

```powershell
python src/summarize_matches.py --input data/match1.csv data/match2.json --output results/combined.json
```

## Installation

```powershell
python -m pip install -r requirements.txt
```
