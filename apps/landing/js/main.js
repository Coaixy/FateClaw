/**
 * 初始化导航交互：移动端菜单、锚点关闭，以及滚动后的导航背景。
 * @returns {void}
 */
function initNavigation() {
  const navbar = document.getElementById('navbar');
  const navLinks = document.getElementById('navLinks');
  const menuToggle = document.querySelector('.menu-toggle');
  if (!navbar || !navLinks || !menuToggle) return;

  /**
   * 统一切换移动端菜单状态，避免按钮状态和菜单显示不同步。
   * @param {boolean} isOpen 菜单是否展开。
   * @returns {void}
   */
  function setMenuOpen(isOpen) {
    navLinks.classList.toggle('open', isOpen);
    menuToggle.setAttribute('aria-expanded', String(isOpen));
  }

  menuToggle.addEventListener('click', () => {
    setMenuOpen(!navLinks.classList.contains('open'));
  });

  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => setMenuOpen(false));
  });

  if (!('IntersectionObserver' in window)) {
    navbar.classList.add('scrolled');
    return;
  }

  const sentinel = document.createElement('div');
  sentinel.className = 'nav-sentinel';
  sentinel.setAttribute('aria-hidden', 'true');
  document.body.prepend(sentinel);

  const navObserver = new IntersectionObserver(([entry]) => {
    navbar.classList.toggle('scrolled', !entry.isIntersecting);
  });
  navObserver.observe(sentinel);
}

/**
 * 绑定语言按钮，让 HTML 不再依赖内联 onclick。
 * @returns {void}
 */
function initLanguageSwitcher() {
  document.querySelectorAll('.lang-btn[data-lang]').forEach(button => {
    button.addEventListener('click', () => {
      window.FateClawI18n?.switchLang(button.dataset.lang);
    });
  });
}

/**
 * 初始化进入视口后的渐入动画；旧环境回退为直接显示。
 * @returns {void}
 */
function initReveal() {
  const revealItems = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    revealItems.forEach(el => el.classList.add('visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  revealItems.forEach(el => observer.observe(el));
}

document.addEventListener('DOMContentLoaded', () => {
  window.FateClawI18n?.init();
  initLanguageSwitcher();
  initNavigation();
  initReveal();
});
