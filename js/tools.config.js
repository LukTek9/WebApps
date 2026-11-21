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
];
