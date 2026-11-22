# WebApp Tools Suite

Boîte à outils web inspirée d'iLovePDF : grille de cartes par catégorie, espace de travail dédié par outil.

## Architecture
- 100 % client : HTML/CSS/JS ES modules, aucun backend, aucune base de données.
- Fichiers traités localement dans le navigateur (File API, Canvas, Blob, Web Workers) : aucun envoi de fichier.
- Bibliothèques externes (Lucide, pdf.js, pdf-lib, Tesseract.js, etc.) chargées à la demande via CDN, avec sources de secours quand prévu. Hors-ligne : ces outils peuvent ne pas fonctionner.
- Modulaire : chaque outil = un module `js/tools/<id>.js` (`mount(container, ctx)` / `unmount()`), enregistré dans `js/tools.config.js` (chargement paresseux).
- Thème centralisé : variables CSS dans `css/theme.css` (`:root`).

## Catégories d'outils
- **Image** : convertisseur, redimensionneur, rognage, masqueur/flouteur, image → SVG, favicon, pipette/palette, filigrane, rotation/miroir, OCR.
- **PDF & Documents** : fusion, division, rotation/réorganisation, compression, PDF → images, images → PDF, numérotation, protection par mot de passe, suppression de mot de passe.
- **Audio** : découpeur, enregistreur vocal, convertisseur, fusionneur.
- **Utilitaire** : générateur de QR code, optimiseur d'images (JPEG/PNG/WebP) et minificateur JSON.

## Limites à connaître
- Compresseur de PDF : les pages sont rasterisées en JPEG → texte non sélectionnable ni recherchable.
- Optimiseur d'images/JSON : formats JPEG, PNG, WebP et JSON uniquement.

## Ajouter un outil
1. Créer `js/tools/<id>.js` exportant `mount` (et `unmount` si nettoyage nécessaire).
2. Ajouter une entrée dans `tools` de `js/tools.config.js`.
3. Ajouter ses styles dans `css/theme.css` en réutilisant les tokens.

## Lancement
Servir le dossier en HTTP statique (modules ES), par exemple `python -m http.server`, puis ouvrir `index.html`.
