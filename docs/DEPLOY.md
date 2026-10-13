# Nasazení na GitHub Pages s doménou gemini-tester.jan-kuchar.cz

Aplikace je čistě statická (Vite + React), build se nasazuje přes GitHub Actions
(`.github/workflows/deploy.yml`) při každém pushi do `main`. Celý build je jediný
`index.html`, který workflow zašifruje **StatiCryptem** – bez hesla se k aplikaci nikdo
nedostane (stejně jako u search-log-analyzer). Soubor `public/CNAME` obsahuje doménu.

## 1. Secrets v repozitáři

Repozitář → **Settings → Secrets and variables → Actions → New repository secret**:

| Název                 | Hodnota                                                    |
|-----------------------|------------------------------------------------------------|
| `STATICRYPT_PASSWORD` | heslo pro přihlášení do aplikace                           |
| `STATICRYPT_SALT`     | 32 hex znaků, např. výstup `openssl rand -hex 16`          |

Salt drž stabilní – při jeho změně přestane fungovat „Zapamatovat na 30 dní“.

## 2. DNS ve WEDOS (doména jan-kuchar.cz)

WEDOS → **Domény** → `jan-kuchar.cz` → **DNS záznamy** → Přidat záznam:

| Název (subdoména) | TTL  | Typ   | Data                     |
|-------------------|------|-------|--------------------------|
| `gemini-tester`   | 3600 | CNAME | `jenikkuchar.github.io.` |

Na stejném názvu nesmí být jiný záznam (A, AAAA, TXT…). Změny DNS potvrdit.
Kontrola: `dig gemini-tester.jan-kuchar.cz +short`.

## 3. GitHub Pages

1. Mergni větev do `main`.
2. **Settings → Pages → Source: GitHub Actions**.
3. Ověř, že workflow „Deploy to GitHub Pages“ doběhl zeleně.
4. **Settings → Pages → Custom domain**: `gemini-tester.jan-kuchar.cz` → Save.
5. Po vydání certifikátu zaškrtni **Enforce HTTPS**.

Free GitHub účet umí Pages jen u **veřejného** repozitáře. Zdrojový kód je pak veřejný,
ale nasazená aplikace je zašifrovaná a žádné tajemství neobsahuje.

## Gemini API klíč

Klíč se **nikdy nedává do buildu**. Uživatel ho zadá v aplikaci; volání jdou přímo
z prohlížeče na `generativelanguage.googleapis.com`. Volitelně se uloží do `localStorage`
(„Zapamatovat v tomto prohlížeči“). Doporučení: v Google AI Studio / Cloud Console
klíč omez na **Generative Language API** a nastav kvótu.
