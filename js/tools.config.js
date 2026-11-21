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
];

/** Outils disponibles. `module` = import dynamique (lazy loading). */
export const tools = [
  {
    id: 'youtube-converter',
    name: 'Convertisseur YouTube',
    category: 'video',
    icon: 'video', // nom d'icône Lucide
    description: 'Convertissez et téléchargez des vidéos YouTube en MP4, MP3 et autres formats jusqu\'en 8K.',
    module: () => import('./tools/youtube-converter.js'),
  },
];
