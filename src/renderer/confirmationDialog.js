(function attachConfirmationController(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LauncherConfirmation = factory().createConfirmationController(root.document);
}(typeof window === 'object' ? window : globalThis, function confirmationModule() {
  function createConfirmationController(document) {
    let elements = null;
    let pending = null;

    function settle(confirmed) {
      const request = pending;
      if (!request) return;
      pending = null;
      if (elements.dialog.open) elements.dialog.close(confirmed ? 'confirm' : 'cancel');
      // HTML dialog restores focus itself. Do not refocus an old field behind
      // another modal, including an update dialog opened while this one closes.
      request.resolve(confirmed);
    }

    function createElement(tag, id, className) {
      const element = document.createElement(tag);
      if (id) element.id = id;
      if (className) element.className = className;
      return element;
    }

    function ensureElements() {
      if (elements) return elements;
      const dialog = createElement('dialog', 'confirmationDialog', 'confirmation-dialog');
      dialog.setAttribute('aria-labelledby', 'confirmationDialogTitle');
      dialog.setAttribute('aria-describedby', 'confirmationDialogMessage');
      const header = createElement('div', '', 'dialog-header');
      const title = createElement('h2', 'confirmationDialogTitle');
      const close = createElement('button', 'confirmationDialogClose', 'icon-button');
      close.type = 'button';
      const icon = createElement('img');
      icon.src = 'assets/icons/x.svg';
      icon.alt = '';
      close.append(icon);
      header.append(title, close);
      const message = createElement('p', 'confirmationDialogMessage', 'delete-mod-warning');
      const actions = createElement('div', '', 'dialog-actions');
      const cancel = createElement('button', 'confirmationDialogCancel', 'button quiet');
      cancel.type = 'button';
      cancel.autofocus = true;
      const confirm = createElement('button', 'confirmationDialogConfirm', 'button danger');
      confirm.type = 'button';
      actions.append(cancel, confirm);
      dialog.append(header, message, actions);
      elements = { dialog, title, message, close, cancel, confirm };
      close.addEventListener('click', () => settle(false));
      cancel.addEventListener('click', () => settle(false));
      confirm.addEventListener('click', () => {
        if (dialog.open) settle(true);
      });
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        settle(false);
      });
      dialog.addEventListener('close', () => {
        // close events are queued: one from the previous request can arrive
        // after a new confirmation opens. It must not cancel the new request.
        if (!dialog.open) settle(false);
      });
      document.body.append(dialog);
      return elements;
    }

    function confirm(options = {}) {
      // A second destructive action must not replace the first question or its
      // resolver. Its caller receives cancellation without changing the dialog.
      if (pending) return Promise.resolve(false);
      const ui = ensureElements();
      if (ui.dialog.open) return Promise.resolve(false);
      ui.title.textContent = String(options.title || 'Confirm action');
      ui.message.textContent = String(options.message || '');
      ui.confirm.textContent = String(options.confirmLabel || 'Confirm');
      ui.cancel.textContent = String(options.cancelLabel || 'Cancel');
      ui.close.title = ui.cancel.textContent;
      ui.close.setAttribute('aria-label', ui.cancel.textContent);
      return new Promise((resolve) => {
        pending = { resolve };
        try {
          ui.dialog.showModal();
          ui.cancel.focus();
        } catch {
          settle(false);
        }
      });
    }

    return Object.freeze({ confirm });
  }

  return { createConfirmationController };
}));
