const nativeAnimations = new WeakMap();

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function stopNativeAnimation(element) {
  const active = nativeAnimations.get(element);
  if (!active) return;
  active.cancel();
  nativeAnimations.delete(element);
}

function resetElement(element) {
  stopNativeAnimation(element);
  element.style.removeProperty('transform');
  element.style.removeProperty('opacity');
  element.style.removeProperty('transition');
  element.style.removeProperty('will-change');
}

function animateNatively(elements, from, to, { duration, stagger }) {
  const easing = 'cubic-bezier(0.215, 0.61, 0.355, 1)';

  elements.forEach((element, index) => {
    resetElement(element);
    const delay = index * stagger * 1000;

    if (typeof element.animate === 'function') {
      const animation = element.animate([
        { transform: `translate3d(0, ${from.y}px, 0)`, opacity: from.opacity },
        { transform: `translate3d(0, ${to.y}px, 0)`, opacity: to.opacity },
      ], {
        duration: duration * 1000,
        delay,
        easing,
        fill: 'both',
      });
      nativeAnimations.set(element, animation);
      animation.onfinish = () => {
        if (nativeAnimations.get(element) !== animation) return;
        nativeAnimations.delete(element);
        animation.cancel();
        resetElement(element);
      };
      return;
    }

    const record = { cancel: () => clearTimeout(timer) };
    const timer = window.setTimeout(() => {
      if (nativeAnimations.get(element) !== record) return;
      nativeAnimations.delete(element);
      resetElement(element);
    }, delay + duration * 1000 + 50);
    nativeAnimations.set(element, record);
    element.style.transition = `transform ${duration}s ${easing} ${delay}ms, opacity ${duration}s ${easing} ${delay}ms`;
    element.style.willChange = 'transform, opacity';
    element.style.transform = `translate3d(0, ${from.y}px, 0)`;
    element.style.opacity = String(from.opacity);
    requestAnimationFrame(() => {
      if (nativeAnimations.get(element) !== record) return;
      element.style.transform = `translate3d(0, ${to.y}px, 0)`;
      element.style.opacity = String(to.opacity);
    });
  });
}

function animate(elements, from, to, { duration, stagger = 0 }) {
  if (!elements.length) return;

  if (prefersReducedMotion()) {
    if (window.gsap) {
      window.gsap.killTweensOf(elements);
      window.gsap.set(elements, { clearProps: 'transform,opacity' });
    }
    elements.forEach(resetElement);
    return;
  }

  if (window.gsap) {
    elements.forEach((element) => {
      stopNativeAnimation(element);
      window.gsap.killTweensOf(element);
    });
    window.gsap.fromTo(elements, from, {
      ...to,
      duration,
      stagger,
      ease: 'power3.out',
      overwrite: 'auto',
      clearProps: 'transform,opacity',
    });
    return;
  }

  animateNatively(elements, from, to, { duration, stagger });
}

export function animateHeroAndGrid(container) {
  if (!container) return;
  animate([...container.querySelectorAll('.hero h1, .hero__intro')], { y: 18, opacity: 0 }, { y: 0, opacity: 1 }, {
    duration: 0.48,
    stagger: 0.08,
  });
  animate([...container.querySelectorAll('.tool-card')], { y: 18, opacity: 0 }, { y: 0, opacity: 1 }, {
    duration: 0.42,
    stagger: 0.03,
  });
}

export function animateWorkspaceEnter(workspaceEl) {
  animate(workspaceEl ? [workspaceEl] : [], { y: 16, opacity: 0 }, { y: 0, opacity: 1 }, {
    duration: 0.35,
  });
}

export function animateHomeEnter(homeEl) {
  if (!homeEl) return;
  animate([homeEl], { y: 16, opacity: 0 }, { y: 0, opacity: 1 }, { duration: 0.35 });
  animate([...homeEl.querySelectorAll('.tool-card')], { y: 18, opacity: 0 }, { y: 0, opacity: 1 }, {
    duration: 0.42,
    stagger: 0.03,
  });
}
