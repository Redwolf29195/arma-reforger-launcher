(() => {
  const api = window.modLogsApi;
  const { t, setLanguage, locale } = window.launcherI18n;
  const $ = (selector) => document.querySelector(selector);
  const filters = ['all', 'added', 'enabled', 'disabled', 'installed', 'deleted', 'errors'];
  let logs = [];
  let presets = [];
  let search = '';
  let filter = 'all';
  let loading = true;
  let loadGeneration = 0;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function category(action) {
    if (['preset-add', 'preset-update', 'import'].includes(action)) return 'added';
    if (['enable', 'auto-enable'].includes(action)) return 'enabled';
    if (['disable', 'auto-disable'].includes(action)) return 'disabled';
    if (action === 'install') return 'installed';
    if (['delete', 'preset-remove'].includes(action)) return 'deleted';
    return 'errors';
  }

  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale(), {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function render() {
    $('#modLogsEyebrow').textContent = t('modLogs.eyebrow');
    $('#modLogsTitle').textContent = t('modLogs.title');
    $('#closeModLogsTop').title = t('common.close');
    $('#modLogsSearch').placeholder = t('modLogs.search');
    for (const key of ['time', 'action', 'mod', 'preset', 'details', 'manage']) {
      $(`#modLogHead${key[0].toUpperCase()}${key.slice(1)}`).textContent = t(`modLogs.head.${key}`);
    }
    $('#clearModLogs span').textContent = t('modLogs.delete');
    $('#closeModLogs span').textContent = t('common.close');
    $('#modLogsFilter').replaceChildren(...filters.map((key) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = t(`modLogs.filter.${key}`);
      return option;
    }));
    $('#modLogsFilter').value = filter;
    window.launcherStyledSelect.sync('modLogsFilter');

    const normalizedSearch = search.toLocaleLowerCase(locale());
    const visible = logs.filter((entry) => {
      if (filter !== 'all' && category(entry.action) !== filter) return false;
      return !normalizedSearch || [entry.name, entry.modId, entry.version, entry.presetName, entry.details]
        .some((value) => String(value || '').toLocaleLowerCase(locale()).includes(normalizedSearch));
    });
    if (loading || visible.length === 0) {
      $('#modLogsList').innerHTML = `<div class="mod-logs-empty">${escapeHtml(t(loading ? 'modLogs.loading' : 'modLogs.empty'))}</div>`;
    } else {
      $('#modLogsList').innerHTML = visible.map((entry) => {
        const kind = category(entry.action);
        const details = entry.details || t(`modLogs.source.${entry.source}`);
        const preset = presets.find((item) => item.id === entry.presetId);
        const canRemove = Boolean(preset?.mods?.some((mod) => mod.modId === entry.modId));
        const removeTitle = t(canRemove ? 'modLogs.removeFromPreset' : 'modLogs.removeUnavailable');
        return `<div class="mod-log-row" data-log-id="${escapeHtml(entry.id)}">
          <span class="mod-log-time">${escapeHtml(formatTime(entry.timestamp))}</span>
          <span class="mod-log-action ${kind}">${escapeHtml(t(`modLogs.action.${entry.action}`))}</span>
          <span class="mod-log-mod"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.modId)}${entry.version ? ` · ${escapeHtml(entry.version)}` : ''}</small></span>
          <span class="mod-log-preset">${escapeHtml(entry.presetName || '—')}</span>
          <span class="mod-log-details" title="${escapeHtml(details)}">${escapeHtml(details)}</span>
          <button class="icon-button bordered mod-log-remove" type="button" data-log-remove="${escapeHtml(entry.id)}" title="${escapeHtml(removeTitle)}" aria-label="${escapeHtml(removeTitle)}" ${canRemove ? '' : 'disabled'}><img src="assets/icons/minus.svg" alt=""></button>
        </div>`;
      }).join('');
    }
    $('#modLogsSummary').textContent = t('modLogs.summary', { shown: visible.length, total: logs.length });
    $('#clearModLogs').disabled = loading || logs.length === 0;
  }

  async function loadState() {
    const generation = ++loadGeneration;
    try {
      const snapshot = await api.state();
      if (generation !== loadGeneration) return;
      setLanguage(snapshot.language);
      logs = Array.isArray(snapshot.logs) ? snapshot.logs : [];
      presets = Array.isArray(snapshot.presets) ? snapshot.presets : [];
    } catch (error) {
      if (generation === loadGeneration) $('#modLogsSummary').textContent = String(error?.message || error);
    } finally {
      if (generation === loadGeneration) { loading = false; render(); }
    }
  }

  window.launcherStyledSelect.mount('modLogsFilter');
  $('#modLogsSearch').addEventListener('input', (event) => { search = event.target.value; render(); });
  $('#modLogsFilter').addEventListener('change', (event) => { filter = event.target.value; render(); });
  $('#modLogsList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-log-remove]');
    if (!button || button.disabled) return;
    if (!await api.requestRemove(button.dataset.logRemove)) window.alert(t('modLogs.removeUnavailable'));
  });
  $('#clearModLogs').addEventListener('click', async () => {
    if (!window.confirm(t('modLogs.deleteConfirm'))) return;
    try { await api.clear(); await loadState(); }
    catch (error) { window.alert(String(error?.message || error)); }
  });
  $('#closeModLogsTop').addEventListener('click', api.close);
  $('#closeModLogs').addEventListener('click', api.close);
  api.onChanged(loadState);
  window.addEventListener('focus', loadState);
  render();
  loadState();
})();
