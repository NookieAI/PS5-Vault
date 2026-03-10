// Shared custom dropdown utility — replaces native <datalist> on all covered inputs.
// Exposes: window.makeShowAllDropdown(inputEl, optionsSource)
//   - optionsSource: string[] or () => string[]
//   - Shows ALL options on focus; filters by substring as the user types.
//   - Closes on outside mousedown, Escape, Tab, or option selection.
//   - Fires an "input" event after setting value via option click.
//   - Positioned to document.body via getBoundingClientRect(); repositions on resize/scroll.
//   - Removes the input's "list" attribute to prevent native datalist conflicts.
(function () {
  'use strict';

  // Delay before closing on blur so a mousedown on an option fires before the list closes.
  const BLUR_DELAY_MS = 150;

  function makeShowAllDropdown(inputEl, optionsSource) {
    if (!inputEl) return;

    // Strip the native datalist association — the custom dropdown takes over completely.
    inputEl.removeAttribute('list');

    let dropdownEl = null;

    function getOptions() {
      const raw = typeof optionsSource === 'function' ? optionsSource() : (optionsSource || []);
      return Array.isArray(raw) ? raw.filter(Boolean) : [];
    }

    function positionDropdown() {
      if (!dropdownEl) return;
      const rect = inputEl.getBoundingClientRect();
      dropdownEl.style.left  = (rect.left  + window.scrollX) + 'px';
      dropdownEl.style.top   = (rect.bottom + window.scrollY) + 'px';
      dropdownEl.style.width = rect.width + 'px';
    }

    function showDropdown() {
      closeDropdown();
      const allOptions = getOptions();
      const query = inputEl.value.toLowerCase();
      const visible = query
        ? allOptions.filter(o => String(o).toLowerCase().includes(query))
        : allOptions;

      if (visible.length === 0) return;

      dropdownEl = document.createElement('ul');
      dropdownEl.style.cssText = [
        'position:absolute',
        'margin:0',
        'padding:0',
        'list-style:none',
        'background:var(--surface-2,#1a1e24)',
        'border:1px solid rgba(255,255,255,0.1)',
        'border-radius:6px',
        'box-shadow:0 8px 24px rgba(0,0,0,0.5)',
        'color:var(--title,#f1f5f9)',
        'font-size:12.5px',
        'z-index:99999',
        'max-height:200px',
        'overflow-y:auto',
        'min-width:100%',
      ].join(';');

      for (const val of visible) {
        const li = document.createElement('li');
        li.textContent = val;
        li.setAttribute('tabindex', '-1');
        li.style.cssText = [
          'padding:7px 12px',
          'cursor:pointer',
          'border-bottom:1px solid rgba(255,255,255,0.04)',
          'list-style:none',
        ].join(';');
        li.addEventListener('mouseenter', () => {
          li.style.background = 'rgba(59,130,246,0.15)';
          li.style.color = 'var(--accent-2,#60a5fa)';
        });
        li.addEventListener('mouseleave', () => {
          li.style.background = '';
          li.style.color = '';
        });
        li.addEventListener('mousedown', (e) => {
          e.preventDefault(); // keep input focused so blur fires after we set value
          inputEl.value = val;
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          closeDropdown();
          inputEl.focus();
        });
        dropdownEl.appendChild(li);
      }

      document.body.appendChild(dropdownEl);
      positionDropdown();
    }

    function closeDropdown() {
      if (dropdownEl) {
        dropdownEl.remove();
        dropdownEl = null;
      }
    }

    function onOutsideMousedown(e) {
      if (!dropdownEl) return;
      if (!inputEl.contains(e.target) && !dropdownEl.contains(e.target)) {
        closeDropdown();
      }
    }

    function onRepositionEvent() {
      if (dropdownEl) positionDropdown();
    }

    inputEl.addEventListener('focus', () => showDropdown());
    inputEl.addEventListener('input', () => showDropdown());
    inputEl.addEventListener('blur', () => setTimeout(() => closeDropdown(), BLUR_DELAY_MS));
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Tab') { closeDropdown(); return; }
      if (e.key === 'ArrowDown' && dropdownEl) {
        e.preventDefault();
        const first = dropdownEl.querySelector('li');
        if (first) first.focus();
      }
    });

    document.addEventListener('mousedown', onOutsideMousedown);
    window.addEventListener('resize', onRepositionEvent);
    window.addEventListener('scroll', onRepositionEvent, true);
  }

  window.makeShowAllDropdown = makeShowAllDropdown;
})();
