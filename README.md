# WebApp Tools

WebApp Tools est une boîte à outils web en français regroupant **110 outils** dans une interface responsive. Chaque outil s'ouvre dans un espace de travail dédié sans quitter la page.

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

### Texte & Rédaction (14)

- Compteur de mots et caractères
- Comparateur de texte
- Convertisseur de casse
- Suppresseur de doublons
- Nettoyeur de texte
- Générateur de Lorem Ipsum
- Convertisseur Markdown vers HTML
- Convertisseur HTML vers Markdown
- Inverseur de texte
- Trieur de listes
- Générateur de slug
- Convertisseur d'encodage texte
- Numéroteur de lignes
- Analyseur de fréquence des mots

### Développement & Web (12)

- Formateur JSON
- Convertisseur JSON vers CSV/XML
- Convertisseur CSV vers JSON
- Encodeur et décodeur Base64
- Encodeur URL et HTML
- Testeur d'expressions régulières
- Minificateur CSS et JavaScript
- Générateur de meta tags SEO
- Générateur .gitignore et .env
- Formateur SQL, HTML et XML
- Convertisseur de timestamps
- Vérificateur HTML

### Sécurité & Crypto (11)

- Générateur de mots de passe
- Générateur de hash
- Testeur de force de mot de passe
- Générateur UUID/GUID
- Chiffreur et déchiffreur AES
- Décodeur JWT
- Convertisseur ASCII, hexadécimal et binaire
- Générateur de clés RSA/ECDSA
- Calculateur de checksum
- Générateur de codes TOTP
- Générateur aléatoire sécurisé

### Utilitaires & Productivité (11, avec le générateur QR)

- Lecteur et scanneur QR
- Générateur de codes-barres
- Chronomètre et minuteur
- Calculateur de différence de dates
- Horloges mondiales
- Bloc-notes local
- Tableau Kanban
- Inspecteur système
- Test de vitesse de frappe
- Minuteur Pomodoro
- Générateur QR Code (outil existant)

### Couleur & Design (10)

- Convertisseur de couleurs
- Générateur de dégradés CSS
- Générateur d'ombres CSS
- Vérificateur de contraste WCAG
- Générateur de motifs CSS
- Générateur de border-radius
- Simulateur de daltonisme
- Générateur de palettes
- Convertisseur SVG vers PNG/WebP
- Optimiseur SVG

### Données & Fichiers (5, avec le compresseur existant)

- Déduplicateur de listes et fichiers
- Visualiseur et analyseur CSV
- Lecteur de métadonnées EXIF
- Découpeur de fichiers
- Compresseur d'images et minificateur JSON (outil existant)

### Calculs & Conversions (7)

- Convertisseur d'unités
- Calculateur de pourcentages
- Règle de trois
- Calculateur de prêt
- Calculateur IMC
- Calculateur d'âge
- Convertisseur de bases numériques

## Confidentialité et connexion

Les fichiers ouverts dans les outils ne sont pas envoyés à un serveur par l'application. Certaines bibliothèques sont chargées depuis des CDN à la demande :

- Lucide pour les icônes
- GSAP pour les animations
- PDF.js, pdf-lib et Tesseract.js selon l'outil
- FFmpeg.wasm pour les traitements vidéo
- jsQR comme solution de repli du lecteur QR

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
js/tools.config.js      Registre des catégories et des 110 outils
js/tools/               Modules indépendants et runtime partagé des outils
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
