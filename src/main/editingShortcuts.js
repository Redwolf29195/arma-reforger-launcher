function installEditingShortcuts(webContents) {
  if (!webContents || typeof webContents.on !== 'function') return () => {};

  const handleBeforeInput = (event, input = {}) => {
    if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return;

    const key = String(input.key || '').toLowerCase();
    const shouldUndo = key === 'z' && !input.shift;
    const shouldRedo = (key === 'z' && input.shift) || (key === 'y' && !input.shift);
    if (!shouldUndo && !shouldRedo) return;

    event.preventDefault();
    const command = shouldUndo ? 'undo' : 'redo';
    if (typeof webContents[command] === 'function') webContents[command]();
  };

  webContents.on('before-input-event', handleBeforeInput);
  return () => webContents.removeListener?.('before-input-event', handleBeforeInput);
}

module.exports = { installEditingShortcuts };
