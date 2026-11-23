# WebApp Tools

WebApp Tools est une boîte à outils web en français regroupant **122 outils** dans une interface responsive. Chaque outil s'ouvre dans un espace de travail dédié sans quitter la page.

## Fonctionnalités

- **Traitement local** : les fichiers restent sur l'appareil et sont traités dans le navigateur.
- **Chargement paresseux** : les modules des outils sont chargés uniquement à leur ouverture.
- **Recherche et filtres** : recherche en temps réel avec filtres par catégorie.
- **Accueil dynamique** : l'arrière-plan évolue subtilement avec la catégorie visible au défilement.
- **Thème centralisé** : couleurs, espacements et mises en page sont définis dans `css/theme.css`.
- **Routage par URL** : un outil peut être ouvert directement avec une ancre, par exemple `#pdf-merger`.
- **Sans backend ni base de données** : le projet est composé uniquement de HTML, CSS et JavaScript.

## Outils disponibles

### Audio (10)

- Découpeur Audio
- Enregistreur Vocal
- Convertisseur Audio
- Fusionneur Audio
- Générateur de bruits & fréquences
- Égaliseur & Amplificateur
- Éditeur de métadonnées ID3
- Inverseur Audio (Reverse)
- Métronome numérique
- Visualiseur de spectre audio

### Vidéo (10)

- Convertisseur Vidéo local
- Recadreur Vidéo
- Découpeur Vidéo
- Compresseur de Vidéo
- Extracteur Audio
- Vidéo vers GIF
- Capture d
- Fusionneur de Vidéos
- Vitesse & Inversion Vidéo
- Enregistreur Écran & Webcam

### Images (12)

- Convertisseur d
- Suppresseur d
- Redimensionneur d
- Rognage d
- Masqueur & Flouteur de zones
- Convertisseur Image vers SVG
- Générateur de Favicon
- Pipette & Extracteur de couleurs
- Ajout de filigrane (Watermark)
- Rotateur & Inverseur d
- Extracteur de texte OCR
- Nettoyeur de métadonnées EXIF

### PDF (11)

- Fusionneur de PDF
- Diviseur de PDF
- Rotateur & Réorganisateur de PDF
- Compresseur de PDF
- PDF vers Images
- Images vers PDF
- Numéroteur de pages PDF
- Rotation de pages PDF
- Protecteur de PDF
- Suppresseur de mots de passe PDF
- Signataire de PDF

### Texte (14)

- Compteur de mots & caractères
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
- Convertisseur d’encodage texte
- Numéroteur de lignes
- Analyseur de fréquence des mots

### Développement (13)

- Formateur JSON
- JSON vers CSV / XML
- Convertisseur CSV vers JSON
- Convertisseur YAML / JSON / TOML
- Encodeur / Décodeur Base64
- Encodeur URL / HTML
- Testeur d’expressions régulières
- Minificateur CSS / JavaScript
- Générateur de meta tags SEO
- Générateur .gitignore / .env
- Formateur SQL / HTML / XML
- Convertisseur de timestamps
- Vérificateur HTML

### Sécurité (10)

- Générateur de mots de passe
- Générateur de hash
- Testeur de mot de passe
- Générateur UUID / GUID
- Chiffreur / Déchiffreur AES
- Décodeur JWT
- Convertisseur ASCII / Hex / Binaire
- Générateur de clés RSA / ECDSA
- Checksum de fichier
- Générateur de codes TOTP

### Utilitaires (11)

- Générateur QR Code
- Lecteur / Scanneur QR
- Générateur de code-barres
- Chronomètre & Minuteur
- Calculateur de dates
- Horloges mondiales
- Bloc-notes local
- Tableau Kanban
- Inspecteur système
- Test de vitesse de frappe
- Minuteur Pomodoro

### Couleurs & Design (10)

- Convertisseur de couleurs
- Générateur de dégradés CSS
- Générateur d’ombres CSS
- Vérificateur de contraste WCAG
- Générateur de motifs CSS
- Générateur de border-radius
- Simulateur de daltonisme
- Générateur de palettes
- Convertisseur SVG vers PNG / WebP
- Optimiseur SVG

### Données (11)

- Compresseur d
- Créateur & Extracteur ZIP
- Déduplicateur de listes
- Visualiseur et analyseur CSV
- Lecteur de métadonnées EXIF
- Découpeur de fichiers
- Fusionneur de fichiers
- Extracteur d’URL
- Extracteur d’e-mails
- HTML (tableau) vers CSV
- Éditeur de diagrammes Mermaid

### Calculateurs (10)

- Convertisseur d’unités
- Convertisseur d’unités de données
- Calculateur de pourcentages
- Calculateur de prêt
- Calculateur de TVA
- Convertisseur de bases
- Calculateur IMC & calories
- Générateur aléatoire sécurisé
- Calculateur de temps de téléchargement
- Calculateur de ratio d’aspect


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
js/tools.config.js      Registre des catégories et des 122 outils
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
