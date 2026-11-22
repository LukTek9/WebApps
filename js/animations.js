import { gsap } from 'gsap';

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function animateGroups(groups) {
  const activeGroups = groups.filter(({ elements }) => elements.length);
  const targets = [...new Set(activeGroups.flatMap(({ elements }) => elements))];
  if (!targets.length) return;

  gsap.killTweensOf(targets);
  gsap.set(targets, { clearProps: 'transform,opacity,visibility' });
  if (prefersReducedMotion()) return;

  const timeline = gsap.timeline();
  activeGroups.forEach(({ elements, y, duration, stagger = 0 }) => {
    timeline.fromTo(elements, {
      y,
      autoAlpha: 0,
    }, {
      y: 0,
      autoAlpha: 1,
      duration,
      stagger,
      ease: 'power3.out',
      overwrite: 'auto',
      clearProps: 'transform,opacity,visibility',
    }, 0);
  });
  return timeline;
}

export function animateHeroAndGrid(container) {
  if (!container) return;
  animateGroups([
    {
      elements: [...container.querySelectorAll('.hero h1, .hero__intro')],
      y: 18,
      duration: 0.48,
      stagger: 0.08,
    },
    {
      elements: [...container.querySelectorAll('.tool-card')],
      y: 18,
      duration: 0.42,
      stagger: 0.03,
    },
  ]);
}

export function animateWorkspaceEnter(workspaceEl) {
  animateGroups([{
    elements: workspaceEl ? [workspaceEl] : [],
    y: 16,
    duration: 0.35,
  }]);
}

export function animateToolContent(container) {
  const root = container?.firstElementChild;
  if (!root) return;
  const children = [...root.children];
  const targets = children.length > 1 ? children : [...(children[0]?.children ?? [])];
  animateGroups([{
    elements: targets.filter((element) => !element.hidden),
    y: 12,
    duration: 0.36,
    stagger: 0.045,
  }]);
}

export function animateHomeEnter(homeEl) {
  if (!homeEl) return;
  animateGroups([
    {
      elements: [homeEl],
      y: 16,
      duration: 0.35,
    },
    {
      elements: [...homeEl.querySelectorAll('.tool-card')],
      y: 18,
      duration: 0.42,
      stagger: 0.03,
    },
  ]);
}
