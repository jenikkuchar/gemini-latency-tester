# Gemini Tester

Nástroj pro měření odezvy Gemini API – běží na **gemini-tester.jan-kuchar.cz**,
vizuál dle [grafického manuálu JK](https://www.jan-kuchar.cz/brand/manual.html),
přístup chráněný heslem (StatiCrypt).

## Funkce

- výběr modelu (seznam načtený z API podle klíče, nebo vlastní ID)
- **System instruction** a **Kontext** (zpráva pro model), volitelně `generationConfig` jako JSON
- nastavitelný **počet volání** (výchozí 10) a **pauza** mezi nimi (výchozí 100 ms)
- režim *Celá odpověď* nebo *Streaming* s měřením TTFT (čas do prvního bloku)
- statistiky: min, max, průměr, medián, P90/P95/P99, směrodatná odchylka, chybovost,
  tokeny (vstup/výstup/myšlení), rychlost tok/s; graf latence a histogram
- historie běhů v prohlížeči a jejich porovnání
- **export**: CSV volání (vybraný běh / všechny), CSV souhrn běhů, kompletní JSON

## Vývoj

```bash
npm install
npm run dev      # http://localhost:3000
npm run lint     # typová kontrola
npm run build    # dist/index.html (jeden soubor)
```

Nasazení viz [docs/DEPLOY.md](docs/DEPLOY.md).
