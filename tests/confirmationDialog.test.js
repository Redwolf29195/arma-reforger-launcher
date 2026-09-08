const assert = require('node:assert/strict');
const test = require('node:test');
const { createConfirmationController } = require('../src/renderer/confirmationDialog');

// Model the relevant browser contract, especially asynchronously delivered
// dialog close events. Real renderer keyboard entry is covered by the UI smoke.
function createDocument() {
  const nodes = [];
  const tasks = [];
  const document = {
    activeElement: null,
    createElement(tag) {
      const node = new EventTarget();
      Object.assign(node, {
        tagName: tag.toUpperCase(), open: false, children: [], attributes: {},
        append(...children) { this.children.push(...children); },
        setAttribute(key, value) { this.attributes[key] = value; },
        focus() { document.activeElement = this; },
        click() { this.dispatchEvent(new Event('click')); },
        showModal() {
          if (this.failOpening) throw new Error('showModal failed');
          this.open = true;
        },
        close(value) {
          if (!this.open) return;
          this.returnValue = value;
          this.open = false;
          tasks.push(() => this.dispatchEvent(new Event('close')));
        }
      });
      nodes.push(node);
      return node;
    },
    get(id) { return nodes.find((node) => node.id === id); },
    flushCloseEvents() { while (tasks.length) tasks.shift()(); }
  };
  document.body = document.createElement('body');
  return document;
}

function fixture() {
  const document = createDocument();
  return { document, controller: createConfirmationController(document) };
}

test('confirmation is lazy, renders literal user text, and initially focuses Cancel', async () => {
  const { document, controller } = fixture();
  assert.equal(document.body.children.length, 0);
  const message = '<img src=x onerror=alert(1)> Delete this preset?';
  const answer = controller.confirm({ title: 'Удаление', message, confirmLabel: 'Удалить', cancelLabel: 'Отмена' });
  assert.equal(document.body.children.length, 1);
  assert.equal(document.get('confirmationDialogMessage').textContent, message);
  assert.equal(document.get('confirmationDialogMessage').children.length, 0);
  assert.equal(document.get('confirmationDialogTitle').textContent, 'Удаление');
  assert.equal(document.get('confirmationDialogConfirm').textContent, 'Удалить');
  assert.equal(document.activeElement, document.get('confirmationDialogCancel'));
  document.activeElement.click();
  assert.equal(await answer, false);
});

test('only the explicit Confirm action approves; repeated clicks settle once', async () => {
  const { document, controller } = fixture();
  let settlements = 0;
  const answer = controller.confirm({ message: 'Delete?' }).then((result) => { settlements += 1; return result; });
  document.get('confirmationDialogConfirm').click();
  document.get('confirmationDialogConfirm').click();
  document.get('confirmationDialogCancel').click();
  document.flushCloseEvents();
  assert.equal(await answer, true);
  assert.equal(settlements, 1);
  assert.equal(document.get('confirmationDialog').open, false);
});

test('Escape, Cancel, top close, and programmatic close all decline', async () => {
  const { document, controller } = fixture();
  for (const action of ['escape', 'cancel', 'top', 'mandatory-update', 'confirm-string']) {
    const answer = controller.confirm({ message: action });
    const dialog = document.get('confirmationDialog');
    if (action === 'escape') {
      const event = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    } else if (action === 'cancel') document.get('confirmationDialogCancel').click();
    else if (action === 'top') document.get('confirmationDialogClose').click();
    else dialog.close(action === 'confirm-string' ? 'confirm' : action);
    document.flushCloseEvents();
    assert.equal(await answer, false, action);
    assert.equal(dialog.open, false);
  }
});

test('overlapping requests are rejected without replacing the active action', async () => {
  const { document, controller } = fixture();
  const first = controller.confirm({ message: 'Delete Alpha?' });
  assert.equal(await controller.confirm({ message: 'Delete Bravo?' }), false);
  assert.equal(document.get('confirmationDialogMessage').textContent, 'Delete Alpha?');
  document.get('confirmationDialogConfirm').click();
  assert.equal(await first, true);
});

test('a queued old close event cannot cancel a newly opened confirmation', async () => {
  const { document, controller } = fixture();
  const first = controller.confirm({ message: 'First' });
  document.get('confirmationDialogCancel').click();
  assert.equal(await first, false);
  const second = controller.confirm({ message: 'Second' });
  let settled = false;
  second.then(() => { settled = true; });
  document.flushCloseEvents();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(document.get('confirmationDialog').open, true);
  document.get('confirmationDialogConfirm').click();
  assert.equal(await second, true);
});

test('dismissal wins over a late confirm click and keeps another modal focused', async () => {
  const { document, controller } = fixture();
  const answer = controller.confirm({ message: 'Pending action' });
  document.get('confirmationDialog').close('mandatory-update');
  const updateButton = document.createElement('button');
  updateButton.focus();
  document.get('confirmationDialogConfirm').click();
  document.flushCloseEvents();
  assert.equal(await answer, false);
  assert.equal(document.activeElement, updateButton);
});

test('failed dialog opening cancels safely and permits a later request', async () => {
  const { document, controller } = fixture();
  const initial = controller.confirm();
  document.get('confirmationDialogCancel').click();
  await initial;
  const dialog = document.get('confirmationDialog');
  dialog.failOpening = true;
  assert.equal(await controller.confirm({ message: 'Cannot open' }), false);
  dialog.failOpening = false;
  const retry = controller.confirm({ message: 'Retry' });
  document.flushCloseEvents();
  document.get('confirmationDialogConfirm').click();
  assert.equal(await retry, true);
});
