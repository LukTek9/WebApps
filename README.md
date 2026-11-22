# WebApp Tools

WebApp Tools est une boîte à outils web en français, organisée comme une grille
de cartes avec un espace de travail dédié à chaque outil.

## Fonctionnalités

- **100 % client** : HTML, CSS et JavaScript sans backend ni base de données.
- **Traitement local** : les fichiers sont traités dans le navigateur avec les
  API File, Canvas, Web Audio, Web Workers et les Web APIs du navigateur.
- **Chargement paresseux** : chaque outil est enregistré dans
  `js/tools.config.js` et chargé uniquement lorsqu'il est ouvert.
- **Bibliothèques à la demande** : les dépendances lourdes (PDF.js, pdf-lib,
  Tesseract.js, FFmpeg.wasm, etc.) sont récupérées depuis des CDN lorsqu'elles
  sont nécessaires.
- **Profils responsive et thème centralisé** : les styles sont regroupés dans
  `css/theme.css`, avec variables CSS partagées.

## Outils disponibles

### Image (10)

- Convertisseur d'images
- Redimensionneur d'images
- Rognage d'images
- Masqueur et flouteur de zones
- Convertisseur image vers SVG
- Générateur de favicon
- Pipette et extracteur de couleurs
- Ajout de filigrane
- Rotateur et inverseur d'images
- Extracteur de texte OCR

### PDF & Documents (10)

- Fusionneur de PDF
- Diviseur de PDF
- Rotateur et réorganisateur de PDF
- Compresseur de PDF
- Conversion PDF vers images
- Conversion images vers PDF
- Numérotation des pages
- Rotation des pages
- Protection par mot de passe
- Suppression du mot de passe

### Audio (10)

- Découpeur audio
- Enregistreur vocal
- Convertisseur audio
- Fusionneur audio
- Générateur de bruits et fréquences
- Égaliseur et amplificateur
- Éditeur de métadonnées ID3
- Inverseur audio
- Métronome numérique
- Visualiseur de spectre audio

### Vidéo (1)

- Convertisseur vidéo local via FFmpeg.wasm

### Utilitaires (2)

- Générateur de QR code
- Compresseur d'images et minificateur JSON

## Confidentialité et fonctionnement hors ligne

Les fichiers ouverts dans un outil ne sont pas envoyés à un serveur par
l'application. Toutefois, certaines fonctionnalités utilisent une connexion
pour charger Lucide, leurs bibliothèques CDN ou les ressources WebAssembly
requises. Elles peuvent donc être indisponibles hors ligne ou dans un
environnement bloquant les CDN.

Le lancement via `file://` n'est pas recommandé : les modules ES et certains
workers peuvent être bloqués par les règles du navigateur. Servez le dossier
avec un serveur HTTP local.

## Démarrage

Depuis la racine du dépôt :

```powershell
py -m http.server 8000
```

Puis ouvrir <http://localhost:8000/>.

Autres options possibles :

```powershell
python -m http.server 8000
```

```powershell
npx serve .
```

Un outil peut aussi être ouvert directement via son identifiant avec une URL du
type `http://localhost:8000/#pdf-merger`.

## Structure du projet

```text
index.html              Page principale et workspace
css/theme.css           Variables, thème et mise en page
js/app.js               Grille, filtres, navigation et chargement des modules
js/tools.config.js      Registre des catégories et outils
js/tools/               Modules indépendants des outils
liste outils.txt        Liste d'idées ou d'outils envisagés
update_and_push.ps1     Script de mise à jour d'état et de synchronisation Git
```

## Ajouter un outil

1. Créer `js/tools/<id>.js`.
2. Exporter `mount(container, ctx)` et, si nécessaire, `unmount()`.
3. Ajouter une entrée dans `tools` de `js/tools.config.js`, avec son nom,
   catégorie, icône Lucide, description et une fonction d'import dynamique.
4. Réutiliser les variables et composants visuels de `css/theme.css`.

Chaque module est chargé uniquement à l'ouverture de sa carte. Le nettoyage des
workers, objets Blob ou écouteurs doit être effectué dans `unmount()` lorsqu'il
est nécessaire.

## Limites importantes

- Le compresseur PDF rasterise les pages en JPEG : le texte devient une partie
  de l'image et n'est plus sélectionnable ou recherchable.
- Le compresseur d'images conserve JPEG, PNG ou WebP ; le JSON est minifié
  directement.
- Les formats et qualités disponibles dépendent du navigateur et des codecs
  locaux.
- FFmpeg.wasm et certaines bibliothèques nécessitent des ressources réseau et
  suffisamment de mémoire pour traiter les fichiers volumineux.
