/**
 * tools.config.js — Registre central des catégories et des outils.
 * Ajouter un outil = ajouter une entrée dans `tools` + créer son module dans js/tools/.
 *
 * Contrat d'un module d'outil (js/tools/<id>.js) :
 *   export function mount(container, ctx) { ... }   // monte l'UI dans le workspace
 *   export function unmount() { ... }                // (optionnel) nettoyage : revokeObjectURL, workers, etc.
 */

/** Catégories (filtres du header). `all` = pas de filtre. */
export const categories = [
  { id: 'all',   label: 'Tout',  color: 'var(--cat-default)' },
  { id: 'video', label: 'Vidéo', color: 'var(--cat-video)' },
  { id: 'audio', label: 'Audio', color: 'var(--cat-audio)' },
  { id: 'image', label: 'Image', icon: 'image', color: 'var(--cat-image)' },
  { id: 'utility', label: 'Utilitaire', icon: 'qr-code', color: 'var(--cat-utility)' },
  { id: 'pdf', label: 'PDF & Documents', icon: 'file-text', color: 'var(--cat-pdf, #ef4444)' },
];

/** Outils disponibles. `module` = import dynamique (lazy loading). */
export const tools = [
  {
    id: 'image-converter',
    name: "Convertisseur d'images",
    category: 'image',
    icon: 'image', // nom d'icône Lucide
    description: 'Convertissez facilement vos images (PNG, JPG, WEBP, BMP, ICO) 100 % localement dans votre navigateur.',
    module: () => import('./tools/image-converter.js'),
  },
  {
    id: 'qr-generator',
    name: 'Générateur QR Code', // clé `name` = convention existante
    label: 'Générateur QR Code',
    category: 'utility',
    icon: 'qr-code',
    description: 'Générez et personnalisez vos QR codes (Texte, URL, Wi-Fi, vCard) 100 % localement en haute résolution.',
    module: () => import('./tools/qr-generator.js'),
  },
  {
    id: 'file-compressor',
    name: 'Compresseur universel',
    category: 'utility',
    icon: 'archive',
    description: 'Compressez n\'importe quel fichier (Images, PDF, Textes, Archives) 100 % localement dans votre navigateur.',
    module: () => import('./tools/file-compressor.js'),
  },
  {
    id: 'image-resizer',
    name: "Redimensionneur d'images",
    category: 'image',
    icon: 'scaling',
    description: 'Redimensionnez vos images en pixels ou en pourcentage tout en conservant leur qualité, 100 % localement.',
    module: () => import('./tools/image-resizer.js'),
  },
  {
    id: 'image-cropper',
    name: "Rognage d'images",
    category: 'image',
    icon: 'crop',
    description: 'Rognez vos images facilement selon des ratios prédéfinis (1:1, 16:9, 4:3) ou librement, 100 % localement.',
    module: () => import('./tools/image-cropper.js'),
  },
  {
    id: 'image-redactor',
    name: "Masqueur & Flouteur de zones",
    category: 'image',
    icon: 'shield-alert',
    description: "Masquez ou floutez les données sensibles d'une image (rectangle noir, pixellisation, flou) 100 % localement.",
    module: () => import('./tools/image-redactor.js'),
  },
  {
    id: 'image-to-svg',
    name: "Convertisseur Image vers SVG",
    category: 'image',
    icon: 'shapes',
    description: "Vectorisez vos images matricielles (PNG, JPG, WEBP) en tracés SVG (noir & blanc / contours) 100 % localement.",
    module: () => import('./tools/image-to-svg.js'),
  },
  {
    id: 'favicon-generator',
    name: "Générateur de Favicon",
    category: 'image',
    icon: 'globe',
    description: "Générez vos fichiers favicon.ico multi-tailles et icônes PWA/Apple 100 % localement.",
    module: () => import('./tools/favicon-generator.js'),
  },
  {
    id: 'color-extractor',
    name: "Pipette & Extracteur de couleurs",
    category: 'image',
    icon: 'pipette',
    description: "Prélevez des couleurs à la pipette et extrayez la palette dominante de vos images 100 % localement.",
    module: () => import('./tools/color-extractor.js'),
  },
  {
    id: 'image-watermark',
    name: "Ajout de filigrane (Watermark)",
    category: 'image',
    icon: 'stamp',
    description: "Ajoutez un texte ou un logo en filigrane (opacité, position, motif répétitif) 100 % localement sur vos images.",
    module: () => import('./tools/image-watermark.js'),
  },
  {
    id: 'image-rotator',
    name: "Rotateur & Inverseur d'images",
    category: 'image',
    icon: 'rotate-cw',
    description: "Pivotez vos images (+90°, -90°, angle libre) et inversez-les en miroir horizontal/vertical 100 % localement.",
    module: () => import('./tools/image-rotator.js'),
  },
  {
    id: 'image-ocr',
    name: "Extracteur de texte OCR",
    category: 'image',
    icon: 'scan-text',
    description: "Extrayez et numérisez le texte contenu dans vos images et documents (OCR 100 % local via Tesseract.js).",
    module: () => import('./tools/image-ocr.js'),
  },
  {
    id: 'pdf-merger',
    name: "Fusionneur de PDF",
    category: 'pdf',
    icon: 'files',
    description: "Combinez plusieurs fichiers PDF en un seul document dans l'ordre de votre choix, 100 % localement.",
    module: () => import('./tools/pdf-merger.js'),
  },
  {
    id: 'pdf-splitter',
    name: "Diviseur de PDF",
    category: 'pdf',
    icon: 'scissors',
    description: "Découpez, séparez ou extrayez les pages de vos fichiers PDF 100 % localement avec aperçu visuel.",
    module: () => import('./tools/pdf-splitter.js'),
  },
];
