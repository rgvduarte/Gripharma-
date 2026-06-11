'use strict';
/*
 * Gripharma — landing (melhoria progressiva)
 * Revelações de entrada ao scroll, com física suave. Sem JS, tudo fica visível.
 * Respeita prefers-reduced-motion.
 */
(function () {
  var root = document.documentElement;
  root.classList.add('js');

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) return; // mostra tudo estático

  // Elementos a revelar ao entrar no ecrã
  var selectors = ['.section-head', '.feature', '.step', '.browser', '.phone', '.cta-box'];
  var nodes = [];
  selectors.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) { nodes.push(el); });
  });

  nodes.forEach(function (el) {
    el.classList.add('will-reveal');
    // pequeno stagger por posição entre irmãos do mesmo tipo
    var sibs = el.parentElement ? el.parentElement.children : [];
    var i = Array.prototype.indexOf.call(sibs, el);
    el.style.transitionDelay = Math.min(i, 5) * 70 + 'ms';
  });

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });

  nodes.forEach(function (el) { io.observe(el); });

  // Segurança: se algo não disparar, garante visibilidade após 3s
  setTimeout(function () {
    nodes.forEach(function (el) { el.classList.add('is-in'); });
  }, 3000);
})();
