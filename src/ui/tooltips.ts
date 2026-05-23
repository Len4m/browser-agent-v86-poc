// @ts-nocheck
(() => {
    'use strict';
  
    const SELECTOR = '[title]:not([data-tip-disabled])';
  
    const tooltip = document.createElement('div');
    tooltip.className = 'ba-tooltip-lite';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
  

    document.body.appendChild(tooltip);
  
    let activeEl = null;
    let showTimer = 0;
    
    function preserveNativeTitle(el) {
      const title = el.getAttribute('title');
      if (!title) return '';
  
      el.dataset.title = title;
      el.removeAttribute('title');
  
      return title;
    }
  
    function restoreNativeTitle(el) {
      if (!el || !el.dataset.title) return;
  
      el.setAttribute('title', el.dataset.title);
      delete el.dataset.title;
    }
  
    function positionTooltip(el) {
      const margin = 8;
      const gap = 8;
  
      tooltip.hidden = false;
  
      const rect = el.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
  
      let left = rect.left + rect.width / 2 - tipRect.width / 2;
      let top = rect.top - tipRect.height - gap;
  
      left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
  
      if (top < margin) {
        top = rect.bottom + gap;
      }
  
      if (top + tipRect.height > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - tipRect.height - margin);
      }
  
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
    }
  
    function show(el) {
      if (!el || activeEl === el) return;
  
      const text = preserveNativeTitle(el);
      if (!text) return;
  
      activeEl = el;
      tooltip.textContent = text;
      tooltip.hidden = false;
  
      clearTimeout(showTimer);
      showTimer = window.setTimeout(() => {
        if (!activeEl) return;
        positionTooltip(activeEl);
        tooltip.classList.add('is-visible');
      }, 180);
    }
  
    function hide() {
      clearTimeout(showTimer);
  
      const previous = activeEl;
      activeEl = null;
  
      tooltip.classList.remove('is-visible');
      tooltip.hidden = true;
      tooltip.textContent = '';
  
      restoreNativeTitle(previous);
    }
  
    document.addEventListener('pointerover', event => {
      const el = event.target.closest(SELECTOR);
      if (!el) return;
  
      show(el);
    });
  
    document.addEventListener('pointerout', event => {
      if (!activeEl) return;
  
      const next = event.relatedTarget;
      if (next && activeEl.contains(next)) return;
  
      hide();
    });
  
    document.addEventListener('focusin', event => {
      const el = event.target.closest(SELECTOR);
      if (!el) return;
  
      show(el);
    });
  
    document.addEventListener('focusout', () => {
      hide();
    });
  
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        hide();
      }
    });
  
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
  })();