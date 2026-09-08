const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

// Only mocked IPC in uiSmoke's isolated Electron profile is used here.
module.exports = async ({ window, outputPath, requests, configure }) => {
  const evaluate = code => window.webContents.executeJavaScript(code);
  const modId = '7B4C0E19A6D34F82';
  const local = { modId, name: 'Card test mod', version: '1.1.10', directoryPath: 'B:/Test/addons/Card', corrupted: false, dependencies: [] };
  const idle = { state: 'idle', completed: 0, total: 0, failed: 0, progress: 0 };
  const waitForAction = `await new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => !state.busy ? resolve() : Date.now() - started > 3000 ? reject(new Error('Action timed out')) : setTimeout(check, 10);
    check();
  }); clearTimeout(modDownloadTimer); modDownloadTimer = 0;`;
  const readButtons = `({
    downloadDisabled:$('#downloadModDetails').disabled,
    downloadText:$('#downloadModDetails span').textContent,
    updateHidden:$('#updateModDetails').hidden,
    updateDisabled:$('#updateModDetails').disabled,
    updateText:$('#updateModDetails span').textContent,
    cardDisabled:$('.workshop-card[data-mod-id="${modId}"] [data-mod-download]').disabled,
    open:$('#modDetailsDialog').open, queue:state.modDownloadStatus.state
  })`;
  configure({}, idle);
  const available = await evaluate(`(async () => {
    window.modActionOriginal = { installedMods:state.installedMods, status:state.modDownloadStatus, language:state.language };
    state.installedMods = []; state.modDownloadStatus = ${JSON.stringify(idle)};
    state.workshopCategory = ''; state.workshopSort = 'subscribers'; state.workshopPage = 1;
    setView('workshop'); await loadWorkshop();
    await openModDetails('${modId}');
    return ${readButtons};
  })()`);
  assert(!available.downloadDisabled && available.updateHidden && !available.cardDisabled && available.open);

  const beforeDownload = requests.length;
  const queued = await evaluate(`(async () => {
    $('#downloadModDetails').click(); $('#downloadModDetails').click();
    ${waitForAction}
    return ${readButtons};
  })()`);
  assert.equal(requests.length - beforeDownload, 1, 'Double click must create one queue');
  assert.deepEqual(requests.at(-1), { type: 'install', modId });
  assert(queued.downloadDisabled && queued.cardDisabled && queued.queue === 'queued');

  configure({ installedMods: [local] }, { state: 'complete', completed: 1, total: 1, failed: 0, progress: 100 });
  const completed = await evaluate(`(async () => {
    await pollModDownloadStatus();
    return ${readButtons};
  })()`);
  assert(completed.downloadDisabled && completed.cardDisabled && !completed.updateHidden && !completed.updateDisabled);
  const beforeDuplicate = requests.length;
  await evaluate(`(async () => { $('#downloadModDetails').click(); await installWorkshopMod({modId:'${modId}'}); })()`);
  assert.equal(requests.length, beforeDuplicate, 'Installed mods must not be downloaded again');

  configure({ installedMods: [local] }, idle);
  const current = await evaluate(`(async () => {
    $('#updateModDetails').click(); ${waitForAction}
    return ${readButtons};
  })()`);
  assert.deepEqual(requests.at(-1), { type: 'update', modIds: [modId] });
  assert(current.downloadDisabled && !current.updateDisabled && current.queue !== 'queued');

  configure({ installedMods: [local], updateResult: {
    queuedCount: 2, updateCount: 1, skippedCount: 0, checkedCount: 1,
    updates: [{ modId, name: local.name, installedVersion: local.version, version: '1.2.0' }]
  } }, idle);
  const updating = await evaluate(`(async () => {
    $('#updateModDetails').click(); ${waitForAction}
    return ${readButtons};
  })()`);
  assert(updating.downloadDisabled && updating.updateDisabled && updating.queue === 'queued');
  assert.deepEqual(requests.at(-1), { type: 'update', modIds: [modId] });

  const beforePaused = requests.length;
  const paused = await evaluate(`(async () => {
    state.modDownloadStatus = {state:'paused', resumeAvailable:true};
    renderLaunchState();
    await updateInstalledMods(['${modId}']);
    state.installedMods = []; renderWorkshop(); renderModDetails();
    await installWorkshopMod({modId:'${modId}'});
    return ${readButtons};
  })()`);
  assert.equal(requests.length, beforePaused, 'Paused queues must not be replaced');
  assert(paused.downloadDisabled && paused.cardDisabled);

  configure({ installError: true }, idle);
  const failed = await evaluate(`(async () => {
    state.modDownloadStatus = ${JSON.stringify(idle)}; renderLaunchState();
    $('#downloadModDetails').click(); ${waitForAction}
    return ${readButtons};
  })()`);
  assert(!failed.downloadDisabled && !failed.cardDisabled && failed.open);

  configure({ installResult: { alreadyInstalled: true, queuedCount: 0 }, installedMods: [local] }, idle);
  const staleScan = await evaluate(`(async () => {
    $('#downloadModDetails').click(); ${waitForAction}
    return ${readButtons};
  })()`);
  assert(staleScan.downloadDisabled && staleScan.cardDisabled && !staleScan.updateDisabled);

  const layouts = [];
  for (const [width, height] of [[1280, 720], [1920, 1080]]) {
    window.setContentSize(width, height);
    for (const installed of [false, true]) {
      await evaluate(`(async () => {
        state.installedMods = ${JSON.stringify(installed ? [local] : [])};
        state.modDownloadStatus = ${JSON.stringify(idle)};
        await changeLanguage('ru'); renderWorkshop(); renderModDetails();
        $$('.toast').forEach(node => node.remove());
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      // Let the hidden Windows compositor resize and finish button transitions.
      await new Promise(resolve => setTimeout(resolve, 200));
      const layout = await evaluate(`(() => {
        const dialog = $('#modDetailsDialog').getBoundingClientRect();
        const actions = $('.mod-details-actions').getBoundingClientRect();
        const buttons = $$('.mod-details-actions button').filter(button => !button.hidden).map(button=>button.getBoundingClientRect());
        return { installed:${installed}, width:innerWidth, height:innerHeight,
          labels:[$('#downloadModDetails span').textContent,$('#updateModDetails span').textContent],
          fits:dialog.right<=innerWidth && dialog.bottom<=innerHeight && buttons.every(button=>button.left>=actions.left && button.right<=actions.right && button.top>=actions.top && button.bottom<=actions.bottom),
          ...${readButtons}
        };
      })()`);
      assert(layout.fits, 'Mod action buttons must fit inside the modal');
      assert.deepEqual(layout.labels, [installed ? 'Установлен' : 'Скачать', 'Обновить']);
      const screenshot = outputPath.replace(/\.png$/i, `.card-${installed ? 'installed' : 'available'}-${width}.png`);
      window.webContents.invalidate();
      await fs.writeFile(screenshot, (await window.capturePage()).toPNG());
      layouts.push({ ...layout, screenshot });
    }
  }
  window.setContentSize(1380, 850);
  await evaluate(`(async () => {
    closeModDetails(); renderWorkshop();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  await new Promise(resolve => setTimeout(resolve, 200));
  const gridFits = await evaluate(`$$('.workshop-card').every(card => {
    const bounds = card.getBoundingClientRect();
    return [...card.querySelectorAll('button')].filter(button=>!button.hidden).every(button=>{
      const rect=button.getBoundingClientRect(); return rect.left>=bounds.left && rect.right<=bounds.right+1;
    });
  })`);
  assert(gridFits, 'Workshop action buttons must fit their cards');
  window.webContents.invalidate();
  await fs.writeFile(outputPath.replace(/\.png$/i,'.workshop-buttons.png'), (await window.capturePage()).toPNG());
  await evaluate(`(async () => {
    closeModDetails();
    state.installedMods = window.modActionOriginal.installedMods;
    state.modDownloadStatus = window.modActionOriginal.status;
    await changeLanguage(window.modActionOriginal.language);
    delete window.modActionOriginal;
    renderAll();
  })()`);
  configure({}, idle);
  const result = { passed:true, available, queued, completed, current, updating, paused, failed, staleScan, layouts, requests };
  await fs.writeFile(path.join(path.dirname(outputPath),'mod-acquisition-verification.json'),JSON.stringify(result,null,2));
  return {passed:true,doubleClickGuard:true,installedDownloadBlocked:true,pausedQueuePreserved:true,updateSingleMod:true,layouts:layouts.length};
};
