(() => {
  const mounted = new Map();

  function closeAll(except = null) {
    for (const [id, shell] of mounted) {
      if (id === except) continue;
      shell.querySelector('.styled-select-menu').hidden = true;
      shell.querySelector('.styled-select-trigger').setAttribute('aria-expanded', 'false');
    }
  }

  function sync(id) {
    const select = document.getElementById(id);
    const shell = mounted.get(id);
    if (!select || !shell) return;
    const trigger = shell.querySelector('.styled-select-trigger');
    const menu = shell.querySelector('.styled-select-menu');
    const selected = select.selectedOptions[0] || select.options[0];
    trigger.querySelector('span').textContent = selected?.textContent || '';
    menu.replaceChildren(...[...select.options].map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'styled-select-option';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.value === select.value));
      button.dataset.value = option.value;
      button.textContent = option.textContent;
      return button;
    }));
  }

  function mount(id) {
    if (mounted.has(id)) return sync(id);
    const select = document.getElementById(id);
    const shell = document.querySelector(`[data-select-for="${id}"]`);
    if (!select || !shell) return;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'styled-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || shell.parentElement.querySelector(':scope > span')?.textContent || 'Sort');
    trigger.innerHTML = '<span></span><i aria-hidden="true"></i>';
    const menu = document.createElement('div');
    menu.className = 'styled-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    shell.append(trigger, menu);
    mounted.set(id, shell);

    const open = () => {
      closeAll(id);
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };
    trigger.addEventListener('click', () => menu.hidden ? open() : close());
    trigger.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      open();
      const options = [...menu.querySelectorAll('.styled-select-option')];
      const index = event.key === 'ArrowUp' || event.key === 'End' ? options.length - 1 : Math.max(0, options.findIndex((option) => option.dataset.value === select.value));
      options[index]?.focus();
    });
    menu.addEventListener('click', (event) => {
      const option = event.target.closest('.styled-select-option');
      if (!option) return;
      select.value = option.dataset.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      close();
      trigger.focus();
    });
    menu.addEventListener('keydown', (event) => {
      const options = [...menu.querySelectorAll('.styled-select-option')];
      const index = options.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        trigger.focus();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }
    });
    select.addEventListener('change', () => sync(id));
    sync(id);
  }

  document.addEventListener('pointerdown', (event) => {
    if (![...mounted.values()].some((shell) => shell.contains(event.target))) closeAll();
  });
  window.addEventListener('blur', () => closeAll());
  window.launcherStyledSelect = { mount, sync, closeAll };
})();
