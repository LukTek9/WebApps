import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

let categoryScrollEntries = [];

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function getCategoryColor(section) {
  const color = getComputedStyle(section).getPropertyValue('--category-color').trim();
  const probe = document.createElement('span');
  probe.style.color = color;
  probe.style.position = 'fixed';
  probe.style.visibility = 'hidden';
  document.body.append(probe);
  const resolvedColor = getComputedStyle(probe).color;
  probe.remove();
  const srgb = resolvedColor.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/);
  if (!srgb) return resolvedColor;
  const [red, green, blue] = srgb.slice(1, 4).map((channel) => Math.round(Number(channel) * 255));
  return `rgba(${red},${green},${blue},${srgb[4] ?? 1})`;
}

function resetCategoryScrollBg(background) {
  if (!background) return;
  gsap.killTweensOf(background);
  background.classList.remove('is-active');
  delete background.dataset.activeCategory;
  if (prefersReducedMotion()) {
    gsap.set(background, { '--scroll-bg-color': 'transparent' });
    return;
  }
  gsap.to(background, {
    '--scroll-bg-color': 'transparent',
    duration: 0.45,
    ease: 'power2.out',
    overwrite: true,
  });
}

export function initCategoryScrollBg(container) {
  categoryScrollEntries.forEach(({ trigger }) => trigger.kill());
  categoryScrollEntries = [];

  const background = document.getElementById('scroll-bg');
  if (!background) {
    ScrollTrigger.refresh();
    return;
  }
  gsap.killTweensOf(background);
  background.classList.remove('is-active');
  delete background.dataset.activeCategory;
  gsap.set(background, { '--scroll-bg-color': 'transparent' });

  const sections = [...(container?.querySelectorAll('.category-section[data-category]') ?? [])];
  sections.forEach((section, index) => {
    const category = section.dataset.category;
    const color = getCategoryColor(section);
    const activate = () => {
      gsap.killTweensOf(background);
      background.classList.add('is-active');
      background.dataset.activeCategory = category;
      if (prefersReducedMotion()) {
        gsap.set(background, { '--scroll-bg-color': color });
        return;
      }
      gsap.to(background, {
        '--scroll-bg-color': color,
        duration: 0.75,
        ease: 'power2.out',
        overwrite: true,
      });
    };

    const trigger = ScrollTrigger.create({
      trigger: section,
      start: 'top 68%',
      onEnter: activate,
      onEnterBack: activate,
      onLeaveBack: index === 0 ? () => resetCategoryScrollBg(background) : undefined,
    });
    categoryScrollEntries.push({ trigger, activate });
  });
  ScrollTrigger.refresh();

  let currentEntry = null;
  categoryScrollEntries.forEach((entry) => {
    if (entry.trigger.start <= window.scrollY) currentEntry = entry;
  });
  if (currentEntry) currentEntry.activate();
}

export function initMobileHeaderAutoHide(headerEl) {
  if (!headerEl) return;

  const media = gsap.matchMedia();
  media.add('(max-width: 640px)', () => {
    let isHidden = false;
    const show = () => {
      if (!isHidden) return;
      isHidden = false;
      gsap.to(headerEl, {
        yPercent: 0,
        duration: prefersReducedMotion() ? 0 : 0.28,
        ease: 'power2.out',
        overwrite: true,
      });
    };
    const hide = () => {
      if (isHidden) return;
      isHidden = true;
      gsap.to(headerEl, {
        yPercent: -110,
        duration: prefersReducedMotion() ? 0 : 0.28,
        ease: 'power2.out',
        overwrite: true,
      });
    };

    const trigger = ScrollTrigger.create({
      start: 0,
      end: 'max',
      onUpdate: (self) => {
        if (self.direction < 0 || self.scroll() <= 80) show();
        else if (self.scroll() > 120) hide();
      },
      onLeaveBack: show,
    });

    if (window.scrollY > 120) hide();

    return () => {
      trigger.kill();
      gsap.killTweensOf(headerEl);
      gsap.set(headerEl, { clearProps: 'transform' });
    };
  });

  return () => media.revert();
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
