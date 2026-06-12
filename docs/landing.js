'use strict';
/*
 * Gripharma — landing (melhoria progressiva)
 * - Revelações de entrada ao scroll (IntersectionObserver), sempre auto-contidas.
 * - Se o anime.js estiver disponível, adiciona um "wow" extra no hero
 *   (palavras em cascata, entrada do mockup e tilt 3D com o rato).
 * Sem JS, ou sem anime.js, ou com prefers-reduced-motion → tudo fica visível.
 */
(function () {
  var root = document.documentElement;
  root.classList.add('js');

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) return; // mostra tudo estático

  /* ---- Revelações ao scroll (abaixo da dobra) — auto-contido ---- */
  var selectors = ['.section-head', '.feature', '.step', '.browser', '.phone', '.cta-box'];
  var nodes = [];
  selectors.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) { nodes.push(el); });
  });
  nodes.forEach(function (el) {
    el.classList.add('will-reveal');
    var sibs = el.parentElement ? el.parentElement.children : [];
    var i = Array.prototype.indexOf.call(sibs, el);
    el.style.transitionDelay = Math.min(i, 5) * 70 + 'ms';
  });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
    });
  }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });
  nodes.forEach(function (el) { io.observe(el); });
  setTimeout(function () { nodes.forEach(function (el) { el.classList.add('is-in'); }); }, 3000);

  /* ---- Wow extra com anime.js (carrega depois; espera por ele) ---- */
  whenAnime(function (anime) {
    var hero = document.querySelector('.hero');
    var heroText = document.querySelector('.hero .reveal');
    var mock = document.querySelector('.hero .mock');
    if (!hero) return;

    // Evita dupla animação: tira as classes de CSS-reveal do hero
    if (heroText) heroText.classList.remove('reveal');
    if (mock) mock.classList.remove('reveal', 'd2');

    // Parte o título em palavras animáveis
    var h1 = document.querySelector('.hero h1');
    if (h1) splitWords(h1);

    var tl = anime.timeline({ easing: 'easeOutExpo' });
    if (h1) {
      tl.add({ targets: '.hero h1 .aword', translateY: [28, 0], opacity: [0, 1], duration: 850, delay: anime.stagger(26) });
    }
    tl.add({
      targets: ['.hero p.lead', '.hero-cta', '.hero-note'],
      translateY: [18, 0], opacity: [0, 1], duration: 700, delay: anime.stagger(90),
    }, h1 ? '-=560' : 0);

    if (mock) {
      anime({
        targets: mock, opacity: [0, 1], scale: [0.92, 1], translateY: [26, 0],
        rotate: ['2.5deg', '0.5deg'], duration: 950, easing: 'easeOutExpo',
      });
      enableTilt(anime, hero, mock);
    }
  });

  /* ---------------------------- helpers ---------------------------- */

  function whenAnime(cb) {
    if (window.anime) return cb(window.anime);
    var tries = 0;
    var t = setInterval(function () {
      if (window.anime) { clearInterval(t); cb(window.anime); }
      else if (++tries > 50) { clearInterval(t); } // ~5s: desiste (fallback = CSS reveals)
    }, 100);
  }

  function splitWords(node) {
    Array.prototype.slice.call(node.childNodes).forEach(function (child) {
      if (child.nodeType === 3) {
        var frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach(function (tok) {
          if (!tok) return;
          if (/^\s+$/.test(tok)) { frag.appendChild(document.createTextNode(tok)); return; }
          var s = document.createElement('span');
          s.className = 'aword';
          s.textContent = tok;
          frag.appendChild(s);
        });
        node.replaceChild(frag, child);
      } else if (child.nodeType === 1) {
        splitWords(child); // recursão (ex.: o <span class="hl">) — herda a cor
      }
    });
  }

  // Tilt 3D subtil seguindo o rato (só em dispositivos com rato fino)
  function enableTilt(anime, hero, mock) {
    if (!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches)) return;
    hero.style.perspective = '1200px';
    var raf = null;
    hero.addEventListener('mousemove', function (e) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = null;
        var r = mock.getBoundingClientRect();
        var dx = (e.clientX - (r.left + r.width / 2)) / r.width;
        var dy = (e.clientY - (r.top + r.height / 2)) / r.height;
        anime({ targets: mock, rotateY: dx * 7, rotateX: -dy * 7, duration: 500, easing: 'easeOutQuad' });
      });
    });
    hero.addEventListener('mouseleave', function () {
      anime({ targets: mock, rotateY: 0, rotateX: 0, rotate: '0.5deg', duration: 700, easing: 'easeOutElastic(1, .6)' });
    });
  }
})();
