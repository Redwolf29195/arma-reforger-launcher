const {
  assessServerAvailability,
  prepareLiveServerConnection,
  prepareServerConnection,
  serverCapacity
} = require('./serverConnection');

// Serialize the check -> launch transition and invalidate cancelled requests.
// A catalog warning is overridable; a changed server identity is not.
function createServerConnectionController(dependencies) {
  let generation = 0;
  let pending = Promise.resolve();
  const cancelledResult = () => ({ launched: false, reason: 'cancelled' });

  async function run(payload, ticket) {
    const isCancelled = () => ticket !== generation;
    if (isCancelled()) return cancelledResult();
    let connection = prepareServerConnection(payload);
    let catalogVerified = false;
    if (connection.knownServer) {
      let details;
      try {
        details = await dependencies.fetchDetails(connection.server.id, { refresh: true, requireLive: true });
      } catch (error) {
        if (isCancelled()) return cancelledResult();
        if (error.code === 'SERVER_CATALOG_ID_MISMATCH') throw error;
        dependencies.log?.(`Server catalog could not be refreshed: ${error.message}`);
        if (payload.allowUnverified !== true) {
          return unavailable(connection, 'catalog-unavailable');
        }
      }
      if (isCancelled()) return cancelledResult();
      if (details) {
        connection = prepareLiveServerConnection(connection, {
          ...details,
          mods: dependencies.assessMods(details.mods)
        });
        catalogVerified = true;
        const availability = assessServerAvailability(connection.server);
        if (!availability.available && payload.allowUnverified !== true) {
          return unavailable(connection, availability.reason);
        }
        if (serverCapacity(connection.server).full && payload.allowUnverified !== true) {
          return { ...unavailable(connection, ''), reason: 'server-full' };
        }
      }
    }

    const game = await dependencies.resolveGame();
    if (isCancelled()) return cancelledResult();
    await dependencies.ensureGameClosed();
    if (isCancelled()) return cancelledResult();
    const startedAt = Date.now();
    const launch = await dependencies.launch(game, connection, isCancelled);
    if (launch.cancelled) return cancelledResult();
    if (isCancelled()) {
      try { await dependencies.cancelLaunch?.(launch); } catch (error) {
        dependencies.log?.(`Cancelled launch cleanup failed: ${error.message}`);
      }
      return cancelledResult();
    }
    // The executable starting is not evidence that the server accepted a player.
    try {
      dependencies.monitor?.(connection.server, startedAt, launch);
    } catch (error) {
      dependencies.log?.(`Game launch monitoring could not start: ${error.message}`);
    }
    let presetResult = null;
    let presetSaveFailed = false;
    if (connection.knownServer && payload.savePreset === true && connection.mods.length > 0) {
      try {
        presetResult = await dependencies.savePreset({
          serverId: connection.server.id,
          serverName: connection.server.name,
          presetName: payload.presetName,
          mods: connection.mods
        });
      } catch (error) {
        presetSaveFailed = true;
        dependencies.log?.(`Server preset could not be saved after game launch: ${error?.message || error}`);
      }
    }
    // The launch has already been accepted. Saving a preset, or cancellation
    // during that save, cannot turn it into a failed launch that invites retry.
    return {
      launched: true,
      launchMethod: launch.method,
      connectionMode: launch.connectionMode || 'direct',
      connectionAttempted: launch.connectionAttempted !== false,
      arguments: launch.arguments,
      server: connection.server,
      mods: connection.mods,
      selectedCount: connection.mods.length,
      missingCount: connection.missingCount,
      mismatchCount: connection.mismatchCount,
      catalogVerified,
      workshopProfileSynced: false,
      preset: presetResult?.preset || null,
      presets: presetResult?.presets || null,
      presetCreated: presetResult?.created === true,
      presetSaveFailed
    };
  }

  function unavailable(connection, availability) {
    return {
      launched: false,
      reason: 'server-unavailable',
      availability,
      retryAfterMs: 5_000,
      server: connection.server,
      mods: connection.mods,
      selectedCount: connection.mods.length
    };
  }

  return {
    connect(payload = {}) {
      const ticket = ++generation;
      const result = pending.then(() => run(payload, ticket));
      pending = result.catch(() => {});
      return result;
    },
    cancel() {
      generation += 1;
      return { cancelled: true };
    }
  };
}

module.exports = { createServerConnectionController };
