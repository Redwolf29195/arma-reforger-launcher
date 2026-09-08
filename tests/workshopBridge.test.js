const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const bridgePath = path.join(
  __dirname,
  '..',
  'support',
  'ALGZLauncherWorkshopBridge',
  'Scripts',
  'Game',
  'ALGZLauncherWorkshopBridge.c'
);

test('starts individual Workshop downloads through the item wrapper', async () => {
  const source = await fs.readFile(bridgePath, 'utf8');

  assert.match(source, /m_ALGZCurrentItem\.SetSubscribed\(true\)/);
  assert.match(source, /m_ALGZCurrentItem\.DownloadLatestVersion\(\)/);
  assert.doesNotMatch(source, /m_ALGZCurrentRawItem\.Subscribe\(/);
  assert.doesNotMatch(source, /m_ALGZCurrentItem\.Download\(latest\)/);
});

test('retries the launcher queue until the game profile is ready', async () => {
  const source = await fs.readFile(bridgePath, 'utf8');

  assert.match(source, /ALGZ_QUEUE_WAIT_LIMIT = 240/);
  assert.match(source, /if \(!queue\)[\s\S]*?CallLater\(ALGZ_StartBridge, 250, false\)/);
  assert.match(source, /Launcher Workshop queue was not found/);
});

test('downloads a requested server revision when the queue includes a version', async () => {
  const source = await fs.readFile(bridgePath, 'utf8');

  assert.match(source, /line\.Split\("\|", parts, false\)/);
  assert.match(source, /FindRevision\(m_sALGZCurrentVersion\)/);
  assert.match(source, /m_ALGZCurrentItem\.Download\(targetRevision\)/);
  assert.match(source, /m_ALGZCurrentItem\.DownloadLatestVersion\(\)/);
  assert.match(source, /!m_ALGZCurrentItem\.GetCorrupted\(\)/);
});

test('retries a stalled Workshop download and eventually reports a failure', async () => {
  const source = await fs.readFile(bridgePath, 'utf8');

  assert.match(source, /ALGZ_DOWNLOAD_STALL_LIMIT = 60/);
  assert.match(source, /ALGZ_DOWNLOAD_RETRY_LIMIT = 3/);
  assert.match(source, /m_ALGZCurrentAction\.ForceFail\(\)/);
  assert.match(source, /m_ALGZCurrentAction\.RetryDownload\(\)/);
  assert.match(source, /Workshop download stalled after automatic retries/);
});

test('source contract gates native server join behind a matching one-shot CLI nonce', async () => {
  const source = await fs.readFile(bridgePath, 'utf8');

  assert.match(source, /System\.GetCLIParam\(ALGZ_JOIN_CLI_PARAM, cliNonce\)/);
  assert.match(source, /ALGZ_JOIN_CLI_PARAM = "algzJoinRequest"/);
  assert.match(source, /ALGZ_JOIN_REQUEST_FILE = "\$profile:ALGZLauncherServerJoin\.txt"/);
  assert.match(source, /ALGZ_JOIN_STATUS_FILE = "\$profile:ALGZLauncherServerJoinStatus\.txt"/);
  assert.match(source, /value\.Length\(\) != 32/);
  assert.match(source, /requestNonce != s_sALGZNonce/);
  assert.match(source, /ALGZ_IsServerAddress\(serverAddress\)/);
});

test('source contract consumes the server request before starting asynchronous UI work', async () => {
  const source = await fs.readFile(bridgePath, 'utf8');
  const initializeStart = source.indexOf('static bool ALGZ_Initialize()');
  const mainMenuStart = source.indexOf('modded class MainMenuUI');
  const initialize = source.slice(initializeStart, mainMenuStart);

  assert.ok(initializeStart >= 0);
  assert.ok(initialize.indexOf('FileIO.DeleteFile(ALGZ_JOIN_REQUEST_FILE)') >= 0);
  assert.ok(initialize.indexOf('requestNonce != s_sALGZNonce') < initialize.indexOf('FileIO.DeleteFile(ALGZ_JOIN_REQUEST_FILE)'));
  assert.ok(initialize.indexOf('ALGZ_IsServerAddress(serverAddress)') < initialize.indexOf('FileIO.DeleteFile(ALGZ_JOIN_REQUEST_FILE)'));
  assert.ok(initialize.indexOf('FileIO.DeleteFile(ALGZ_JOIN_REQUEST_FILE)') < initialize.indexOf('s_bALGZJoinActive = true'));
  assert.match(initialize, /while \(request\.ReadLine\(extraLine\) >= 0\)[\s\S]*?!extraLine\.Trim\(\)\.IsEmpty\(\)/);
  assert.match(source, /if \(ALGZ_LauncherServerJoinBridge\.ALGZ_Initialize\(\)\)\s+return;\s+\n\s*GetGame\(\)\.GetCallqueue\(\)\.CallLater\(ALGZ_StartBridge/);
});

test('source contract enters the native Room workflow exactly once and keeps its dialogs', async () => {
  const source = await fs.readFile(bridgePath, 'utf8');

  assert.match(source, /modded class MainMenuUI/);
  assert.match(source, /ServerBrowserMenuUI\.TryOpenServerBrowser\(\)/);
  assert.match(source, /modded class ServerBrowserMenuUI/);
  assert.match(source, /ALGZ_TakeJoinAddress\(serverAddress\)[\s\S]*?JoinActions_DirectJoin\(serverAddress, EDirectJoinFormats\.IP_PORT, true\)[\s\S]*?ALGZ_MarkJoining\(\)/);
  assert.match(source, /s_bALGZJoinAttempted = true/);
  assert.match(source, /m_Lobby && m_CallbackSearchTarget && m_Dialogs/);
  assert.doesNotMatch(source, /RequestConnectViaRoom\(/);
  assert.doesNotMatch(source, /(?:^|["'])-client(?:\s|["'])/m);
  assert.doesNotMatch(source, /RequestClose\(/);
});

test('source contract bounds service and menu waits and reports only handoff states', async () => {
  const source = await fs.readFile(bridgePath, 'utf8');

  assert.match(source, /ALGZ_JOIN_BACKEND_WAIT_LIMIT = 240/);
  assert.match(source, /ALGZ_JOIN_MENU_WAIT_LIMIT = 120/);
  assert.match(source, /ALGZ_JOIN_TOTAL_TIMEOUT = 120000/);
  assert.match(source, /CallLater\(ALGZ_ExpireJoinRequest, ALGZ_JOIN_TOTAL_TIMEOUT, false\)/);
  assert.match(source, /CallLater\(ALGZ_WaitForMainMenu, ALGZ_JOIN_POLL_INTERVAL, false\)/);
  assert.match(source, /menuManager\.GetTopMenu\(\) == mainMenu/);
  assert.match(source, /!menuManager\.IsAnyDialogOpen\(\)/);
  assert.match(source, /menuManager\.GetTopMenu\(\) == serverBrowserMenu/);
  assert.match(source, /ALGZ_ShouldReportServerBrowserClosed\(\)[\s\S]*?ALGZ_ReportError\("Multiplayer server browser was closed"\)/);
  assert.match(source, /ALGZ_WriteStatus\("waiting",/);
  assert.match(source, /ALGZ_WriteStatus\("opening-browser",/);
  assert.match(source, /ALGZ_WriteStatus\("joining", "Join request handed to the game"\)/);
  assert.match(source, /ALGZ_WriteStatus\("error", message\)/);
  assert.doesNotMatch(source, /ALGZ_WriteStatus\("(?:joined|connected|success)"/);
});
