const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reforgerLauncher', {
  bootstrap: () => ipcRenderer.invoke('launcher:bootstrap'),
  scanMods: () => ipcRenderer.invoke('mods:scan'),
  updateInstalledMods: (payload) => ipcRenderer.invoke('mods:update', payload),
  getModDetails: (modId) => ipcRenderer.invoke('mods:details', modId),
  translateModDescription: (modId) => ipcRenderer.invoke('mods:translate-description', modId),
  searchWorkshop: (payload) => ipcRenderer.invoke('workshop:search', payload),
  copyScenarioId: (scenarioId) => ipcRenderer.invoke('clipboard:copy-scenario', scenarioId),
  copyModJson: (mod) => ipcRenderer.invoke('clipboard:copy-mod', mod),
  installWorkshopMod: (mod) => ipcRenderer.invoke('workshop:install', mod),
  listServers: (payload) => ipcRenderer.invoke('servers:list', payload),
  getServerDetails: (serverId, options = {}) => ipcRenderer.invoke('servers:details', serverId, {
    refresh: options.refresh === true
  }),
  copyServerMods: (mods) => ipcRenderer.invoke('servers:copy-mods', mods),
  downloadServerPack: (serverId) => ipcRenderer.invoke('servers:download', serverId),
  downloadServerMod: (serverId, modId) => ipcRenderer.invoke('servers:download-mod', serverId, modId),
  connectServer: (payload) => ipcRenderer.invoke('servers:connect', payload),
  cancelServerConnect: () => ipcRenderer.invoke('servers:cancel-connect'),
  onServerConnectionFailure: (callback) => {
    const listener = (_event, failure) => callback(failure);
    ipcRenderer.on('servers:connection-failure', listener);
    return () => ipcRenderer.removeListener('servers:connection-failure', listener);
  },
  deleteMod: (modId) => ipcRenderer.invoke('mods:delete', modId),
  listModLogs: () => ipcRenderer.invoke('mod-logs:list'),
  recordModLog: (entry) => ipcRenderer.invoke('mod-logs:add', entry),
  recordModLogs: (entries) => ipcRenderer.invoke('mod-logs:add-many', entries),
  clearModLogs: () => ipcRenderer.invoke('mod-logs:clear'),
  saveWorkspace: (workspace) => ipcRenderer.invoke('workspace:save', workspace),
  importPreset: () => ipcRenderer.invoke('presets:import'),
  importPresetText: (payload) => ipcRenderer.invoke('presets:import-text', payload),
  savePreset: (preset) => ipcRenderer.invoke('presets:save', preset),
  addModToPreset: (payload) => ipcRenderer.invoke('presets:add-mod', payload),
  removeModFromPreset: (payload) => ipcRenderer.invoke('presets:remove-mod', payload),
  exportPreset: (preset) => ipcRenderer.invoke('presets:export', preset),
  sharePresetFile: (preset) => ipcRenderer.invoke('presets:share-file', preset),
  copyPreset: (preset) => ipcRenderer.invoke('presets:copy', preset),
  choosePresetTransferDirectory: () => ipcRenderer.invoke('presets:choose-transfer-directory'),
  transferPresetMods: (payload) => ipcRenderer.invoke('presets:transfer-mods', payload),
  readPresetClipboard: () => ipcRenderer.invoke('clipboard:read-preset'),
  deletePreset: (id) => ipcRenderer.invoke('presets:delete', id),
  listPresets: () => ipcRenderer.invoke('presets:list'),
  chooseGameExecutable: () => ipcRenderer.invoke('settings:choose-game'),
  chooseDirectory: (kind) => ipcRenderer.invoke('settings:choose-directory', kind),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  factoryReset: () => ipcRenderer.invoke('system:factory-reset'),
  launch: (payload) => ipcRenderer.invoke('game:launch', payload),
  downloadMissingMods: (payload) => ipcRenderer.invoke('game:download-missing', payload),
  getModDownloadStatus: () => ipcRenderer.invoke('game:download-status'),
  resumeModDownload: () => ipcRenderer.invoke('game:resume-download'),
  openWorkshop: (modId) => ipcRenderer.invoke('system:open-workshop', modId),
  openOfficialReleases: () => ipcRenderer.invoke('system:open-official-releases'),
  getLicenseText: () => ipcRenderer.invoke('launcher:license'),
  openUserData: () => ipcRenderer.invoke('system:open-user-data'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  repair: () => ipcRenderer.invoke('system:repair'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  }
});
