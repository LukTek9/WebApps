# WebApp Tools

WebApp Tools est une boîte à outils web en français regroupant **42 outils** dans une interface responsive. Chaque outil s'ouvre dans un espace de travail dédié sans quitter la page.

## Fonctionnalités

- **Traitement local** : les fichiers restent sur l'appareil et sont traités dans le navigateur.
- **Chargement paresseux** : les modules des outils sont chargés uniquement à leur ouverture.
- **Recherche et filtres** : recherche en temps réel avec filtres par catégorie.
- **Thème centralisé** : couleurs, espacements et mises en page sont définis dans `css/theme.css`.
- **Routage par URL** : un outil peut être ouvert directement avec une ancre, par exemple `#pdf-merger`.
- **Sans backend ni base de données** : le projet est composé uniquement de HTML, CSS et JavaScript.

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
- PDF vers images
- Images vers PDF
- Numéroteur de pages PDF
- Rotation de pages PDF
- Protecteur de PDF
- Suppresseur de mot de passe PDF

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

### Vidéo (10)

- Convertisseur vidéo local
- Recadreur vidéo
- Découpeur vidéo
- Compresseur de vidéo
- Extracteur audio depuis une vidéo
- Vidéo vers GIF
- Capture d'images depuis une vidéo
- Fusionneur de vidéos
- Contrôle de vitesse et inversion vidéo
- Enregistreur d'écran et webcam

### Utilitaires (2)

- Générateur de QR code
- Compresseur d'images et minificateur JSON

## Confidentialité et connexion

Les fichiers ouverts dans les outils ne sont pas envoyés à un serveur par l'application. Certaines bibliothèques sont chargées depuis des CDN à la demande :

- Lucide pour les icônes
- GSAP pour les animations
- PDF.js, pdf-lib et Tesseract.js selon l'outil
- FFmpeg.wasm pour les traitements vidéo

Une connexion réseau peut donc être nécessaire lors du premier chargement de ces dépendances. Les ressources disponibles hors ligne dépendent du navigateur et de son cache.

## Démarrage

Le lancement via `file://` n'est pas recommandé : les modules ES et certains workers peuvent être bloqués par les règles du navigateur.

Depuis la racine du dépôt, lancez un serveur HTTP :

```powershell
py -m http.server 8000
```

Puis ouvrez <http://localhost:8000/>.

Autres options :

```powershell
python -m http.server 8000
```

```powershell
npx serve .
```

Pour ouvrir un outil directement :

```text
http://localhost:8000/#pdf-merger
http://localhost:8000/#image-converter
http://localhost:8000/#audio-visualizer
```

## Structure du projet

```text
index.html              Page principale et workspace
css/theme.css           Variables, thème et mise en page
js/app.js               Recherche, filtres, navigation et lazy loading
js/animations.js        Animations GSAP
js/tools.config.js      Registre des catégories et des 42 outils
js/tools/               Modules indépendants des outils
update_and_push.ps1     Mise à jour de l'état du projet et synchronisation Git
UPDATE_AND_PUSH.bat     Lanceur Windows du script PowerShell
Project_State.txt       Inventaire généré de l'architecture du projet
liste_outils.txt        Liste d'outils envisagés
```

## Ajouter un outil

1. Créer `js/tools/<id>.js`.
2. Exporter `mount(container, ctx)` et, si nécessaire, `unmount()` pour nettoyer les workers, objets Blob ou écouteurs.
3. Ajouter une entrée dans `js/tools.config.js` avec son identifiant, nom, catégorie, icône Lucide, description et fonction d'import dynamique.
4. Réutiliser les variables et composants visuels de `css/theme.css`.

## Limites connues

- Le compresseur PDF utilise une rasterisation JPEG : le texte des pages compressées n'est plus sélectionnable ou recherchable.
- Les outils PDF protégés nécessitent le mot de passe pour retirer une restriction connue.
- Les formats disponibles, leurs qualités d'encodage et les codecs dépendent du navigateur.
- Certains traitements FFmpeg.wasm nécessitent une quantité importante de mémoire pour les fichiers volumineux.
- Le support hors ligne complet dépend des ressources déjà mises en cache par le navigateur.
