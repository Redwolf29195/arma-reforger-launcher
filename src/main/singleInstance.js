function acquireLauncherInstance({ app, getMainWindow = () => null, factoryResetStartup } = {}) {
  // Only the validated internal reset worker may run beside the launcher.
  if (factoryResetStartup?.active === true) return true;

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (window.isDestroyed()) return;
    if (!window.isVisible()) window.show();
    if (!window.isDestroyed()) window.focus();
  });
  return true;
}

module.exports = { acquireLauncherInstance };
