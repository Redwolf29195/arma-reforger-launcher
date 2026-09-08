const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Renderer section missing: ${startMarker}`);
  return source.slice(start, end);
}

function createElement() {
  let value = '';
  const listeners = new Map();
  return {
    selectionStart: 0,
    selectionEnd: 0,
    selectionDirection: 'none',
    get value() { return value; },
    set value(next) {
      const text = String(next);
      // A changed native input value collapses selection to the end. The
      // harness models this observable side effect, not the render algorithm.
      if (text !== value) {
        value = text;
        this.selectionStart = text.length;
        this.selectionEnd = text.length;
        this.selectionDirection = 'none';
      }
    },
    setSelectionRange(start, end, direction = 'none') {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
    },
    setAttribute() {},
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { return !this.validationMessage; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, properties = {}) {
      const event = {
        currentTarget: this, target: this, isComposing: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...properties
      };
      for (const listener of listeners.get(type) || []) listener(event);
      return event;
    }
  };
}

function createHarness() {
  const elements = new Map();
  let nextTimer = 1;
  const timers = new Map();
  const requests = [];
  const context = {
    $: (selector) => {
      if (!elements.has(selector)) elements.set(selector, createElement());
      return elements.get(selector);
    },
    $$: () => [],
    state: {
      serverQuery: '', serverSort: 'players_desc', serverItems: [], serverPage: 1,
      workshopQuery: '', workshopSort: 'subscribers', workshopCategory: '',
      workshopItems: [], workshopPage: 1, workshopCount: 0
    },
    document: { activeElement: null },
    serverSearchTimer: 0,
    serverSearchComposing: false,
    t: (key) => key,
    formatCount: String,
    escapeHtml: String,
    renderServerDetails() {},
    workshopPageCount: () => 1,
    scheduleServerAutoRefresh() {},
    cancelServerAutoRefresh() {},
    loadServers() { requests.push(context.state.serverQuery); },
    loadWorkshop() {},
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('function renderWorkshop()', '\nasync function loadWorkshop('), context);
  vm.runInContext(sourceBetween('function renderServers()', '\nasync function loadServerDetails('), context);
  return {
    context, requests, timers,
    render(name) { vm.runInContext(`${name}()`, context); },
    bindServerSearch() {
      vm.runInContext(sourceBetween("  $('#serverSearchForm').addEventListener('submit'", "  $('#serverSort').addEventListener('change'"), context);
    },
    runTimers() {
      const pending = [...timers.entries()];
      for (const [id, timer] of pending) {
        if (!timers.delete(id)) continue;
        timer.callback();
      }
    }
  };
}

async function assertDraftSurvivesRender({ inputId, render, stateKey, draft, committed, selection }) {
  const harness = createHarness();
  const input = harness.context.$(inputId);
  harness.context.state[stateKey] = committed;
  input.value = draft;
  input.setSelectionRange(...selection);
  harness.context.document.activeElement = input;
  // Model a catalog/details promise settling while the user edits its static
  // search field. The actual production render function is executed below.
  await Promise.resolve().then(() => harness.render(render));
  assert.equal(input.value, draft, 'Background render changed the raw draft');
  assert.deepEqual(
    [input.selectionStart, input.selectionEnd, input.selectionDirection], selection,
    'Background render moved the caret or destroyed selection'
  );
  assert.equal(harness.context.document.activeElement, input);
}

test('Workshop result rendering preserves an unsubmitted draft and caret', async () => {
  await assertDraftSurvivesRender({
    inputId: '#workshopSearch', render: 'renderWorkshop', stateKey: 'workshopQuery',
    draft: 'RHS ', committed: '', selection: [2, 2, 'none']
  });
});

test('server result rendering preserves trailing space in a slow multiword query', async () => {
  await assertDraftSurvivesRender({
    inputId: '#serverSearch', render: 'renderServers', stateKey: 'serverQuery',
    draft: 'ALGZ ', committed: 'ALGZ', selection: [5, 5, 'none']
  });
});

test('server details rendering preserves a Cyrillic draft and backward selection', async () => {
  await assertDraftSurvivesRender({
    inputId: '#serverSearch', render: 'renderServers', stateKey: 'serverQuery',
    draft: '  Сервер ALGZ ', committed: 'Сервер ALGZ', selection: [2, 8, 'backward']
  });
});

test('repeated loading and error renders leave a Workshop draft untouched', async () => {
  const harness = createHarness();
  const input = harness.context.$('#workshopSearch');
  input.value = 'Моды RHS ';
  input.setSelectionRange(5, 8, 'forward');
  for (const state of [
    { workshopLoading: true, workshopError: '' },
    { workshopLoading: false, workshopError: 'Temporary catalog failure' },
    { workshopLoading: false, workshopError: '' }
  ]) {
    Object.assign(harness.context.state, state);
    await Promise.resolve().then(() => harness.render('renderWorkshop'));
    assert.equal(input.value, 'Моды RHS ');
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [5, 8, 'forward']);
  }
});

// These tests execute the real input-event handlers with deterministic timers.
// They exercise the externally visible debounce behavior without network IPC.
test('server search waits until composition finishes before requesting results', () => {
  const harness = createHarness();
  harness.bindServerSearch();
  const input = harness.context.$('#serverSearch');
  input.value = 'old';
  input.dispatch('input');
  input.dispatch('compositionstart');
  input.value = 'Сер';
  input.dispatch('input', { isComposing: true });
  harness.runTimers();
  assert.deepEqual(harness.requests, [], 'A search ran with unfinished composition');
  input.value = 'Сервер ';
  input.dispatch('compositionend');
  // Browsers may emit a final non-composing input after compositionend.
  input.dispatch('input');
  harness.runTimers();
  assert.deepEqual(harness.requests, ['Сервер']);
  assert.equal(input.value, 'Сервер ');
});

test('Enter submits server search once and cancels a pending debounce', () => {
  const harness = createHarness();
  harness.bindServerSearch();
  const input = harness.context.$('#serverSearch');
  input.value = 'ALGZ ';
  input.dispatch('input');
  const event = harness.context.$('#serverSearchForm').dispatch('submit');
  assert.equal(event.defaultPrevented, true);
  harness.runTimers();
  assert.deepEqual(harness.requests, ['ALGZ']);
  assert.equal(input.value, 'ALGZ ');
});

test('server form submission cannot commit an unfinished composition', () => {
  const harness = createHarness();
  harness.bindServerSearch();
  const input = harness.context.$('#serverSearch');
  input.dispatch('compositionstart');
  input.value = 'Сер';
  input.dispatch('input', { isComposing: true });
  harness.context.$('#serverSearchForm').dispatch('submit');
  harness.runTimers();
  assert.deepEqual(harness.requests, []);
});
