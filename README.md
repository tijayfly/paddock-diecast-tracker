# PADDOCK: 1:64 diecast collection tracker

PADDOCK is a desktop app (Electron) for keeping track of a diecast car collection (Hot Wheels, Matchbox, Tomica, Mini GT, AUTOart, Kyosho and others): what you own, what you paid and what it's worth now. It also keeps a wishlist and can export a price-free, view-only web page of your collection to share, with optional one-click publishing to GitHub Pages.

Built from [HANGAR](https://github.com/tijayfly/hangar-gunpla-tracker), the Gunpla version. Unofficial fan-made tool, not affiliated with Mattel, Takara Tomy or any other maker.

## Features
- **Collection:** grid or list view, search, filter by brand, and sort by brand and range, name, make, year, rarity, price paid, value or profit/loss. Totals for models, paid (and average per bought model), current value and P&L.
- **Item pages:** brand, range (Mainline, Premium, Tomica Premium, Limited Vintage…), series, number on the card, make, model, year, colour/variant, scale, rarity (standard, limited, chase, Treasure Hunt, Super Treasure Hunt), where and when you bought it, notes, photo, price paid, current value and P&L.
- **Add a car by name:** type it the way it's on the card, e.g. "Hot Wheels Factory Fresh 5/5 2025 SF90 Stradale Blue", "Tomica 110 Toyota Crown Patrol Car" or "Mini GT 512 Nissan GT-R". PADDOCK works out the brand, range, series, number, year, colour, make and rarity (add STH, TH or Chase), finds photos online, and you check it all before saving.
- **Photos:** find photos for every entry without one in a single pass (weak matches are flagged under **Check photos**), or pick, paste or use your own photo per car.
- **Wishlist:** target prices, and **Got it!** moves a car into the collection.
- **Playsets and accessories** (a Tomica garage, say) can be tracked without counting as a model.
- **View mode:** the eye button in the header previews the shareable page with all prices and editing hidden.
- **View-only export:** writes a static page (no price data, and not where you bought things) to `view-only/`, and can publish it to a GitHub repo.
- Light and dark mode, and a phone-friendly layout for the exported page.

## Download (Windows)
Grab **PADDOCK-1.0.0-portable.exe** from the [latest release](https://github.com/tijayfly/paddock-diecast-tracker/releases/latest). There's nothing to install: put it in its own folder and run it. Windows SmartScreen may warn because the app isn't code-signed; click **More info → Run anyway**.

## Run from source
You need [Node.js](https://nodejs.org) (LTS).

```
npm install
npm start
```

On Windows you can double-click `Start PADDOCK.bat` instead, which installs on first run.

To build a portable Windows .exe: `npm run dist` (output in `dist/`).

## Your data
- Running from source, everything is stored in `paddock-data/` inside this folder: `collection.json` (plus a `.bak` of the previous save) and an `images/` folder. The portable .exe keeps `paddock-data/` next to the .exe instead.
- `paddock-data/` and `view-only/` are git-ignored, so your collection, prices and any tokens never end up in a repo.
- The first launch with no data starts you with a few **example cars** (`data/seed-collection.json`). Delete them from each car's page, or replace the seed file with your own before first launch.

## Current values
Current values are **dummy placeholders** by default (from the price paid or a typical price for the brand and range, with chases and Treasure Hunts worth a multiple), so the app is usable out of the box. There's an eBay UK option in Settings (median asking price of new Buy It Now listings) that needs your own eBay developer keys. It hasn't been confirmed against the live eBay API yet.

### Setting up eBay keys
1. Create a keyset at [developer.ebay.com](https://developer.ebay.com). Use the **Production** keys, not Sandbox: Sandbox is eBay's test marketplace and won't sign in to the live API.
2. Copy the **App ID** (Client ID) and **Cert ID** (Client Secret) from the **same** Production keyset. The Dev ID and user tokens aren't needed.
3. eBay keeps Production keys disabled until **Marketplace Account Deletion** notifications are dealt with. PADDOCK stores no eBay user data, so choose the **exemption** ("not persisting eBay data"). The other option needs a web server endpoint, which a desktop app doesn't have.
4. In PADDOCK: Settings → Values → enter both keys and click **Test eBay keys**. A green ✓ means they work; save, choose eBay UK, and **Refresh all values**.

If a refresh fails, PADDOCK keeps the last value and says why: on the car's page, in the Current value total, and in a message after refreshing. The keys are stored only in your local `paddock-data/collection.json`, never in the view-only page.

## Publishing the view-only page to GitHub
1. Create a repo for the page and turn on GitHub Pages (Settings → Pages → Deploy from branch → main, root).
2. Create a fine-grained personal access token limited to that repo with **Contents: Read and write**.
3. In PADDOCK: Settings → View-only page → enter `owner/repo` and the token, then **Publish now** (or tick "Also publish every time I export").

Only PADDOCK's own files (index.html, data.js, app.js, match.js, styles.css, theme.js, logo.svg, .nojekyll, images/) are changed in that repo. The token is stored only in your local `paddock-data/collection.json`.

## Notes
- Photos are found with a Bing image search in a hidden window and cached locally.
- The Bing lookup depends on the site's current layout and may need updating if they change.

## Licence
MIT. See [LICENSE](LICENSE).
