// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 ALGZ / ExtaZzZ.
// Origin ID: ALGZ-ARL-e377d956209c489eb308586aa2eecfdd
// Distributed under GNU GPL version 3 only. See the project LICENSE file.

class ALGZ_LauncherWorkshopPageParams : PageParams
{
	protected string m_sALGZModId;

	void ALGZ_LauncherWorkshopPageParams(string modId)
	{
		m_sALGZModId = modId;
		limit = 10;
		offset = 0;
	}

	override void OnPack()
	{
		StoreString("search", m_sALGZModId);
		StoreString("orderBy", "name");
		StoreString("orderDirection", "asc");
	}
}

class ALGZ_LauncherServerJoinBridge
{
	protected const string ALGZ_JOIN_CLI_PARAM = "algzJoinRequest";
	protected const string ALGZ_JOIN_REQUEST_FILE = "$profile:ALGZLauncherServerJoin.txt";
	protected const string ALGZ_JOIN_STATUS_FILE = "$profile:ALGZLauncherServerJoinStatus.txt";
	protected const string ALGZ_HEX_CHARACTERS = "0123456789abcdefABCDEF";
	protected const int ALGZ_JOIN_REQUEST_MAX_BYTES = 128;
	protected const int ALGZ_JOIN_POLL_INTERVAL = 500;
	protected const int ALGZ_JOIN_TOTAL_TIMEOUT = 120000;
	protected const int ALGZ_JOIN_BACKEND_WAIT_LIMIT = 240;
	protected const int ALGZ_JOIN_MENU_WAIT_LIMIT = 120;

	protected static bool s_bALGZInitialized;
	protected static bool s_bALGZJoinMode;
	protected static bool s_bALGZJoinActive;
	protected static bool s_bALGZMainFlowStarted;
	protected static bool s_bALGZBrowserOpening;
	protected static bool s_bALGZBrowserOpened;
	protected static bool s_bALGZServerMenuWaitStarted;
	protected static bool s_bALGZJoinAttempted;
	protected static bool s_bALGZFinished;
	protected static int s_iALGZBackendWaitAttempts;
	protected static int s_iALGZMainMenuWaitAttempts;
	protected static int s_iALGZBrowserWaitAttempts;
	protected static string s_sALGZNonce;
	protected static string s_sALGZServerAddress;

	static bool ALGZ_Initialize()
	{
		if (s_bALGZInitialized)
			return s_bALGZJoinMode;

		s_bALGZInitialized = true;
		string cliNonce;
		if (!System.GetCLIParam(ALGZ_JOIN_CLI_PARAM, cliNonce))
			return false;

		// Merely providing the opt-in parameter selects join mode. Even an invalid
		// request must never fall through into an old Workshop download queue.
		s_bALGZJoinMode = true;
		cliNonce = cliNonce.Trim();
		if (!ALGZ_IsHexNonce(cliNonce))
		{
			ALGZ_ReportError("Invalid launcher join token");
			return true;
		}

		s_sALGZNonce = cliNonce;
		FileHandle request = FileIO.OpenFile(ALGZ_JOIN_REQUEST_FILE, FileMode.READ);
		if (!request)
		{
			ALGZ_ReportError("Launcher join request was not found");
			return true;
		}

		int requestLength = request.GetLength();
		int readResult = -1;
		string line;
		bool hasExtraContent = false;
		if (requestLength > 0 && requestLength <= ALGZ_JOIN_REQUEST_MAX_BYTES)
		{
			readResult = request.ReadLine(line);
			string extraLine;
			while (request.ReadLine(extraLine) >= 0)
			{
				if (!extraLine.Trim().IsEmpty())
					hasExtraContent = true;
			}
		}
		request.Close();

		if (readResult < 0 || requestLength <= 0 || requestLength > ALGZ_JOIN_REQUEST_MAX_BYTES || hasExtraContent)
		{
			ALGZ_ReportError("Launcher join request is invalid");
			return true;
		}

		array<string> parts = {};
		line.Split("|", parts, false);
		if (parts.Count() != 2)
		{
			ALGZ_ReportError("Launcher join request has an invalid format");
			return true;
		}

		string requestNonce = parts[0].Trim();
		string serverAddress = parts[1].Trim();
		if (requestNonce != s_sALGZNonce)
		{
			ALGZ_ReportError("Launcher join token does not match");
			return true;
		}

		if (!ALGZ_IsServerAddress(serverAddress))
		{
			ALGZ_ReportError("Launcher server address is invalid");
			return true;
		}

		// Only the process holding the matching nonce may consume this request.
		// Consumption still happens before any asynchronous menu or backend work.
		if (!FileIO.DeleteFile(ALGZ_JOIN_REQUEST_FILE))
		{
			ALGZ_ReportError("Launcher join request could not be consumed");
			return true;
		}

		s_sALGZServerAddress = serverAddress;
		s_bALGZJoinActive = true;
		ALGZ_WriteStatus("waiting", "Waiting for game services");
		Print("[ALGZ Launcher Join] Accepted one-shot Room join request");
		GetGame().GetCallqueue().CallLater(ALGZ_ExpireJoinRequest, ALGZ_JOIN_TOTAL_TIMEOUT, false);
		GetGame().GetCallqueue().CallLater(ALGZ_WaitForMainMenu, ALGZ_JOIN_POLL_INTERVAL, false);
		return true;
	}

	protected static void ALGZ_ExpireJoinRequest()
	{
		if (s_bALGZJoinActive && !s_bALGZFinished)
			ALGZ_ReportError("Launcher join request timed out");
	}

	static void ALGZ_OnMainMenuOpened()
	{
		ALGZ_Initialize();
		if (!s_bALGZJoinActive || s_bALGZMainFlowStarted || s_bALGZFinished)
			return;

		s_bALGZMainFlowStarted = true;
		GetGame().GetCallqueue().CallLater(ALGZ_WaitForServicesAndOpenBrowser, ALGZ_JOIN_POLL_INTERVAL, false);
	}

	protected static void ALGZ_WaitForMainMenu()
	{
		if (!s_bALGZJoinActive || s_bALGZFinished || s_bALGZMainFlowStarted || s_bALGZBrowserOpened)
			return;

		s_iALGZMainMenuWaitAttempts++;
		if (s_iALGZMainMenuWaitAttempts >= ALGZ_JOIN_MENU_WAIT_LIMIT)
		{
			ALGZ_ReportError("Main menu did not become ready");
			return;
		}

		GetGame().GetCallqueue().CallLater(ALGZ_WaitForMainMenu, ALGZ_JOIN_POLL_INTERVAL, false);
	}

	protected static void ALGZ_WaitForServicesAndOpenBrowser()
	{
		if (!s_bALGZJoinActive || s_bALGZFinished || s_bALGZBrowserOpening)
			return;

		BackendApi backendApi = GetGame().GetBackendApi();
		MenuManager menuManager = GetGame().GetMenuManager();
		MenuBase mainMenu;
		if (menuManager)
			mainMenu = menuManager.FindMenuByPreset(ChimeraMenuPreset.MainMenu);

		if (backendApi && menuManager && mainMenu && menuManager.GetTopMenu() == mainMenu && !menuManager.IsAnyDialogOpen() &&
			SCR_ServicesStatusHelper.IsBackendReady() && SCR_ServicesStatusHelper.IsAuthenticated())
		{
			s_bALGZBrowserOpening = true;
			ALGZ_WriteStatus("opening-browser", "Opening the multiplayer server browser");
			ServerBrowserMenuUI.TryOpenServerBrowser();
			GetGame().GetCallqueue().CallLater(ALGZ_WaitForServerBrowser, ALGZ_JOIN_POLL_INTERVAL, false);
			return;
		}

		s_iALGZBackendWaitAttempts++;
		if (s_iALGZBackendWaitAttempts >= ALGZ_JOIN_BACKEND_WAIT_LIMIT)
		{
			ALGZ_ReportError("Game services did not become ready");
			return;
		}

		GetGame().GetCallqueue().CallLater(ALGZ_WaitForServicesAndOpenBrowser, ALGZ_JOIN_POLL_INTERVAL, false);
	}

	protected static void ALGZ_WaitForServerBrowser()
	{
		if (!s_bALGZJoinActive || s_bALGZFinished || s_bALGZBrowserOpened)
			return;

		s_iALGZBrowserWaitAttempts++;
		if (s_iALGZBrowserWaitAttempts >= ALGZ_JOIN_MENU_WAIT_LIMIT)
		{
			ALGZ_ReportError("Multiplayer server browser did not open");
			return;
		}

		GetGame().GetCallqueue().CallLater(ALGZ_WaitForServerBrowser, ALGZ_JOIN_POLL_INTERVAL, false);
	}

	static bool ALGZ_OnServerBrowserOpened()
	{
		if (!s_bALGZJoinActive || s_bALGZFinished || s_bALGZJoinAttempted)
			return false;

		s_bALGZBrowserOpening = true;
		s_bALGZBrowserOpened = true;
		ALGZ_WriteStatus("opening-browser", "Multiplayer server browser is ready");
		if (s_bALGZServerMenuWaitStarted)
			return false;

		s_bALGZServerMenuWaitStarted = true;
		return true;
	}

	static bool ALGZ_IsJoinPending()
	{
		return s_bALGZJoinActive && !s_bALGZFinished && !s_bALGZJoinAttempted;
	}

	static bool ALGZ_ShouldReportServerBrowserClosed()
	{
		return s_bALGZJoinActive && s_bALGZServerMenuWaitStarted && !s_bALGZFinished && !s_bALGZJoinAttempted;
	}

	static bool ALGZ_TakeJoinAddress(out string serverAddress)
	{
		serverAddress = string.Empty;
		if (!ALGZ_IsJoinPending())
			return false;

		s_bALGZJoinAttempted = true;
		serverAddress = s_sALGZServerAddress;
		return true;
	}

	static void ALGZ_MarkJoining()
	{
		if (!s_bALGZJoinAttempted || s_bALGZFinished)
			return;

		s_bALGZJoinActive = false;
		s_bALGZFinished = true;
		ALGZ_WriteStatus("joining", "Join request handed to the game");
		Print("[ALGZ Launcher Join] Request handed to the native Room join flow");
	}

	static void ALGZ_ReportError(string message)
	{
		if (s_bALGZFinished)
			return;

		s_bALGZJoinActive = false;
		s_bALGZFinished = true;
		ALGZ_WriteStatus("error", message);
		Print(string.Format("[ALGZ Launcher Join] %1", message), LogLevel.ERROR);
	}

	protected static void ALGZ_WriteStatus(string state, string message)
	{
		FileHandle status = FileIO.OpenFile(ALGZ_JOIN_STATUS_FILE, FileMode.WRITE);
		if (!status)
			return;

		message.Replace("|", " ");
		message.Replace("\r", " ");
		message.Replace("\n", " ");
		status.WriteLine(string.Format("%1|%2|%3", s_sALGZNonce, state, message));
		status.Close();
	}

	protected static bool ALGZ_IsHexNonce(string value)
	{
		if (value.Length() != 32)
			return false;

		for (int i = 0; i < value.Length(); i++)
		{
			if (!ALGZ_HEX_CHARACTERS.Contains(value.Get(i)))
				return false;
		}

		return true;
	}

	protected static bool ALGZ_IsDecimal(string value)
	{
		if (value.IsEmpty())
			return false;

		for (int i = 0; i < value.Length(); i++)
		{
			string character = value.Get(i);
			int asciiValue = character.ToAscii();
			if (asciiValue < 48 || asciiValue > 57)
				return false;
		}

		return true;
	}

	protected static bool ALGZ_IsServerAddress(string value)
	{
		if (value.IsEmpty() || value.Length() > 21)
			return false;

		array<string> hostAndPort = {};
		value.Split(":", hostAndPort, false);
		if (hostAndPort.Count() != 2)
			return false;

		string host = hostAndPort[0];
		string portText = hostAndPort[1];
		if (!ALGZ_IsDecimal(portText) || portText.Length() > 5)
			return false;

		int port = portText.ToInt();
		if (port < 1 || port > 65535)
			return false;

		array<string> octets = {};
		host.Split(".", octets, false);
		if (octets.Count() != 4)
			return false;

		foreach (string octetText : octets)
		{
			if (!ALGZ_IsDecimal(octetText) || octetText.Length() > 3)
				return false;

			int octet = octetText.ToInt();
			if (octet < 0 || octet > 255)
				return false;
		}

		return true;
	}
}

modded class SCR_AddonManager
{
	protected const string ALGZ_QUEUE_FILE = "$profile:ALGZLauncherWorkshopQueue.txt";
	protected const string ALGZ_STATUS_FILE = "$profile:ALGZLauncherWorkshopStatus.txt";
	protected const int ALGZ_QUEUE_WAIT_LIMIT = 240;
	protected const int ALGZ_WORKSHOP_WAIT_LIMIT = 120;
	protected const int ALGZ_REVISION_WAIT_LIMIT = 120;
	protected const int ALGZ_DOWNLOAD_STALL_LIMIT = 60;
	protected const int ALGZ_DOWNLOAD_RETRY_LIMIT = 3;

	protected bool m_bALGZBridgeStarted;
	protected int m_iALGZQueueWaitAttempts;
	protected int m_iALGZWorkshopWaitAttempts;
	protected int m_iALGZRevisionWaitAttempts;
	protected int m_iALGZCurrentIndex;
	protected int m_iALGZCompleted;
	protected int m_iALGZFailed;
	protected int m_iALGZDownloadStallAttempts;
	protected int m_iALGZDownloadRetryAttempts;
	protected int m_iALGZLastDownloadProgress = -1;
	protected int m_iALGZLastProcessingProgress = -1;
	protected string m_sALGZCurrentId;
	protected string m_sALGZCurrentVersion;
	protected ref array<string> m_aALGZRequestedIds = {};
	protected ref array<string> m_aALGZRequestedVersions = {};
	protected WorkshopApi m_ALGZWorkshopApi;
	protected WorkshopItem m_ALGZCurrentRawItem;
	protected ref SCR_WorkshopItem m_ALGZCurrentItem;
	protected ref SCR_WorkshopItemActionDownload m_ALGZCurrentAction;
	protected ref ALGZ_LauncherWorkshopPageParams m_ALGZPageParams;
	protected ref BackendCallback m_ALGZPageCallback;

	override void EOnInit(IEntity owner)
	{
		super.EOnInit(owner);
		if (ALGZ_LauncherServerJoinBridge.ALGZ_Initialize())
			return;

		GetGame().GetCallqueue().CallLater(ALGZ_StartBridge, 250, false);
	}

	protected void ALGZ_StartBridge()
	{
		if (m_bALGZBridgeStarted)
			return;

		FileHandle queue = FileIO.OpenFile(ALGZ_QUEUE_FILE, FileMode.READ);
		if (!queue)
		{
			m_iALGZQueueWaitAttempts++;
			if (m_iALGZQueueWaitAttempts >= ALGZ_QUEUE_WAIT_LIMIT)
			{
				ALGZ_WriteStatus("error", 0, "", 0, "Launcher Workshop queue was not found");
				return;
			}

			GetGame().GetCallqueue().CallLater(ALGZ_StartBridge, 250, false);
			return;
		}

		string line;
		while (queue.ReadLine(line) > -1)
		{
			array<string> parts = {};
			line.Split("|", parts, false);
			if (parts.IsEmpty())
				continue;

			string modId = parts[0].Trim();
			string version;
			if (parts.Count() > 1)
				version = parts[1].Trim();
			modId.ToUpper();
			if (modId.Length() == 16 && m_aALGZRequestedIds.Find(modId) == -1)
			{
				m_aALGZRequestedIds.Insert(modId);
				m_aALGZRequestedVersions.Insert(version);
			}
		}
		queue.Close();

		if (m_aALGZRequestedIds.IsEmpty())
		{
			ALGZ_WriteStatus("error", 0, "", 0, "Launcher Workshop queue is empty");
			return;
		}

		m_bALGZBridgeStarted = true;
		ALGZ_WriteStatus("waiting", 0, "", 0, "Waiting for Workshop");
		Print(string.Format("[ALGZ Launcher Workshop] Queue contains %1 addons", m_aALGZRequestedIds.Count()));
		ALGZ_WaitForWorkshop();
	}

	protected void ALGZ_WaitForWorkshop()
	{
		m_iALGZWorkshopWaitAttempts++;
		BackendApi backendApi = GetGame().GetBackendApi();
		if (backendApi)
			m_ALGZWorkshopApi = backendApi.GetWorkshop();

		if (m_ALGZWorkshopApi && SCR_ServicesStatusHelper.IsAuthenticated() && (GetAddonsChecked() || m_iALGZWorkshopWaitAttempts >= 20))
		{
			if (!GetUgcPrivilege())
			{
				ALGZ_WriteStatus("error", 0, "", 0, "Workshop access is disabled");
				return;
			}

			ALGZ_StartNextItem();
			return;
		}

		if (m_iALGZWorkshopWaitAttempts >= ALGZ_WORKSHOP_WAIT_LIMIT)
		{
			ALGZ_WriteStatus("error", 0, "", 0, "Workshop connection timed out");
			return;
		}

		GetGame().GetCallqueue().CallLater(ALGZ_WaitForWorkshop, 500, false);
	}

	protected void ALGZ_StartNextItem()
	{
		m_ALGZCurrentRawItem = null;
		m_ALGZCurrentItem = null;
		m_ALGZCurrentAction = null;
		m_ALGZPageParams = null;
		m_iALGZRevisionWaitAttempts = 0;
		m_iALGZDownloadStallAttempts = 0;
		m_iALGZDownloadRetryAttempts = 0;
		m_iALGZLastDownloadProgress = -1;
		m_iALGZLastProcessingProgress = -1;

		if (m_iALGZCurrentIndex >= m_aALGZRequestedIds.Count())
		{
			string finalState = "complete";
			if (m_iALGZFailed > 0)
				finalState = "partial";

			ALGZ_WriteStatus(finalState, m_iALGZCompleted, "", 100, "Workshop queue finished");
			FileIO.DeleteFile(ALGZ_QUEUE_FILE);
			Print(string.Format("[ALGZ Launcher Workshop] Finished: %1 complete, %2 failed", m_iALGZCompleted, m_iALGZFailed));
			return;
		}

		m_sALGZCurrentId = m_aALGZRequestedIds[m_iALGZCurrentIndex];
		m_sALGZCurrentVersion = m_aALGZRequestedVersions[m_iALGZCurrentIndex];
		m_iALGZCurrentIndex++;
		ALGZ_WriteStatus("preparing", m_iALGZCompleted, m_sALGZCurrentId, 0, "Finding addon");

		m_ALGZCurrentRawItem = m_ALGZWorkshopApi.FindItem(m_sALGZCurrentId);
		if (m_ALGZCurrentRawItem)
		{
			ALGZ_PrepareCurrentItem();
			return;
		}

		m_ALGZWorkshopApi.SetPageSize(10);
		m_ALGZPageParams = new ALGZ_LauncherWorkshopPageParams(m_sALGZCurrentId);
		m_ALGZPageCallback = new BackendCallback();
		m_ALGZPageCallback.SetOnSuccess(ALGZ_OnCataloguePage);
		m_ALGZPageCallback.SetOnError(ALGZ_OnCatalogueError);
		m_ALGZWorkshopApi.RequestPage(m_ALGZPageCallback, m_ALGZPageParams, true);
	}

	protected void ALGZ_OnCataloguePage()
	{
		array<WorkshopItem> items = {};
		m_ALGZWorkshopApi.GetPageItems(items);
		foreach (WorkshopItem item : items)
		{
			if (!item)
				continue;

			string itemId = item.Id();
			itemId.ToUpper();
			if (itemId == m_sALGZCurrentId)
			{
				m_ALGZCurrentRawItem = item;
				break;
			}
		}

		if (!m_ALGZCurrentRawItem)
		{
			ALGZ_FailCurrent("Addon was not found in Workshop");
			return;
		}

		ALGZ_PrepareCurrentItem();
	}

	protected void ALGZ_PrepareCurrentItem()
	{
		if (!m_ALGZCurrentRawItem)
		{
			ALGZ_FailCurrent("Workshop item is unavailable");
			return;
		}

		m_ALGZCurrentItem = Register(m_ALGZCurrentRawItem);
		if (!m_ALGZCurrentItem)
		{
			ALGZ_FailCurrent("Addon could not be registered");
			return;
		}

		if (m_ALGZCurrentItem.GetRestricted())
		{
			ALGZ_FailCurrent("Addon is restricted");
			return;
		}

		if (m_sALGZCurrentVersion.IsEmpty())
		{
			ALGZ_StartCurrentDownload();
			return;
		}

		m_ALGZCurrentItem.LoadDetails();
		ALGZ_WaitForTargetRevision();
	}

	protected void ALGZ_WaitForTargetRevision()
	{
		if (!m_ALGZCurrentItem)
		{
			ALGZ_FailCurrent("Addon details are unavailable");
			return;
		}

		if (m_ALGZCurrentItem.GetRequestFailed())
		{
			ALGZ_FailCurrent("Could not load addon revisions");
			return;
		}

		if (!m_ALGZCurrentItem.GetRevisionsLoaded())
		{
			m_iALGZRevisionWaitAttempts++;
			if (m_iALGZRevisionWaitAttempts >= ALGZ_REVISION_WAIT_LIMIT)
			{
				ALGZ_FailCurrent("Addon revision lookup timed out");
				return;
			}

			GetGame().GetCallqueue().CallLater(ALGZ_WaitForTargetRevision, 500, false);
			return;
		}

		Revision targetRevision = m_ALGZCurrentItem.FindRevision(m_sALGZCurrentVersion);
		if (!targetRevision)
		{
			ALGZ_FailCurrent(string.Format("Requested version %1 is unavailable", m_sALGZCurrentVersion));
			return;
		}

		ALGZ_StartCurrentDownload(targetRevision);
	}

	protected void ALGZ_StartCurrentDownload(Revision targetRevision = null)
	{
		if (!m_ALGZCurrentItem || !m_ALGZCurrentRawItem)
		{
			ALGZ_FailCurrent("Addon details are unavailable");
			return;
		}

		Revision latest = targetRevision;
		if (!latest)
			latest = m_ALGZCurrentRawItem.GetLatestRevision();
		Revision active = m_ALGZCurrentRawItem.GetActiveRevision();
		if (latest && active && Revision.AreEqual(active, latest) && latest.IsDownloaded() && !m_ALGZCurrentItem.GetCorrupted())
		{
			m_ALGZCurrentItem.SetEnabled(true);
			m_iALGZCompleted++;
			ALGZ_StartNextItem();
			return;
		}

		if (!m_ALGZCurrentItem.GetSubscribed())
			m_ALGZCurrentItem.SetSubscribed(true);

		if (targetRevision)
			m_ALGZCurrentAction = m_ALGZCurrentItem.Download(targetRevision);
		else
			m_ALGZCurrentAction = m_ALGZCurrentItem.DownloadLatestVersion();
		if (!m_ALGZCurrentAction || !m_ALGZCurrentAction.Activate())
		{
			ALGZ_FailCurrent("Workshop download could not be started");
			return;
		}

		ALGZ_WriteStatus("downloading", m_iALGZCompleted, m_sALGZCurrentId, 0, m_ALGZCurrentItem.GetName());
		Print(string.Format("[ALGZ Launcher Workshop] Downloading %1 (%2)", m_ALGZCurrentItem.GetName(), m_sALGZCurrentId));
		GetGame().GetCallqueue().CallLater(ALGZ_PollCurrentDownload, 500, false);
	}

	protected void ALGZ_PollCurrentDownload()
	{
		if (!m_ALGZCurrentAction || !m_ALGZCurrentItem)
		{
			ALGZ_FailCurrent("Workshop download action was lost");
			return;
		}

		if (m_ALGZCurrentAction.IsCompleted())
		{
			m_ALGZCurrentItem.SetEnabled(true);
			m_iALGZCompleted++;
			ALGZ_StartNextItem();
			return;
		}

		if (m_ALGZCurrentAction.IsFailed() || m_ALGZCurrentAction.IsCanceled())
		{
			ALGZ_FailCurrent("Workshop download failed");
			return;
		}

		int percentage = Math.Round(m_ALGZCurrentAction.GetProgress() * 100);
		int processingPercentage = 0;
		if (m_ALGZCurrentAction.IsProcessing())
			processingPercentage = Math.Round(m_ALGZCurrentAction.GetProcessingProgress() * 100);

		if (percentage != m_iALGZLastDownloadProgress || processingPercentage != m_iALGZLastProcessingProgress)
		{
			m_iALGZLastDownloadProgress = percentage;
			m_iALGZLastProcessingProgress = processingPercentage;
			m_iALGZDownloadStallAttempts = 0;
		}
		else
		{
			m_iALGZDownloadStallAttempts++;
		}

		if (m_iALGZDownloadStallAttempts >= ALGZ_DOWNLOAD_STALL_LIMIT)
		{
			if (m_iALGZDownloadRetryAttempts >= ALGZ_DOWNLOAD_RETRY_LIMIT)
			{
				ALGZ_FailCurrent("Workshop download stalled after automatic retries");
				return;
			}

			m_iALGZDownloadRetryAttempts++;
			m_iALGZDownloadStallAttempts = 0;
			m_iALGZLastDownloadProgress = -1;
			m_iALGZLastProcessingProgress = -1;
			m_ALGZCurrentAction.ForceFail();
			SCR_WorkshopItemActionDownload retryAction = m_ALGZCurrentAction.RetryDownload();
			if (!retryAction || (!retryAction.IsActive() && !retryAction.Activate()))
			{
				ALGZ_FailCurrent("Workshop download retry could not be started");
				return;
			}

			m_ALGZCurrentAction = retryAction;
			ALGZ_WriteStatus(
				"downloading",
				m_iALGZCompleted,
				m_sALGZCurrentId,
				percentage,
				string.Format("Retrying download (%1/%2)", m_iALGZDownloadRetryAttempts, ALGZ_DOWNLOAD_RETRY_LIMIT)
			);
			Print(string.Format(
				"[ALGZ Launcher Workshop] Retrying stalled download %1 (%2/%3)",
				m_sALGZCurrentId,
				m_iALGZDownloadRetryAttempts,
				ALGZ_DOWNLOAD_RETRY_LIMIT
			));
			GetGame().GetCallqueue().CallLater(ALGZ_PollCurrentDownload, 1000, false);
			return;
		}

		ALGZ_WriteStatus("downloading", m_iALGZCompleted, m_sALGZCurrentId, percentage, m_ALGZCurrentItem.GetName());
		GetGame().GetCallqueue().CallLater(ALGZ_PollCurrentDownload, 500, false);
	}

	protected void ALGZ_OnCatalogueError()
	{
		ALGZ_FailCurrent("Could not query Workshop");
	}

	protected void ALGZ_FailCurrent(string message)
	{
		m_iALGZFailed++;
		ALGZ_WriteStatus("failed", m_iALGZCompleted, m_sALGZCurrentId, 0, message);
		Print(string.Format("[ALGZ Launcher Workshop] %1: %2", m_sALGZCurrentId, message), LogLevel.ERROR);
		GetGame().GetCallqueue().CallLater(ALGZ_StartNextItem, 100, false);
	}

	protected void ALGZ_WriteStatus(string state, int completed, string modId, int progress, string message)
	{
		FileHandle status = FileIO.OpenFile(ALGZ_STATUS_FILE, FileMode.WRITE);
		if (!status)
			return;

		message.Replace("|", " ");
		status.WriteLine(string.Format("%1|%2|%3|%4|%5|%6|%7", state, completed, m_aALGZRequestedIds.Count(), m_iALGZFailed, modId, progress, message));
		status.Close();
	}
}

modded class MainMenuUI
{
	protected override void OnMenuOpened()
	{
		super.OnMenuOpened();
		ALGZ_LauncherServerJoinBridge.ALGZ_OnMainMenuOpened();
	}
}

modded class ServerBrowserMenuUI
{
	protected int m_iALGZNativeJoinWaitAttempts;

	override void OnMenuOpened()
	{
		super.OnMenuOpened();
		if (!ALGZ_LauncherServerJoinBridge.ALGZ_OnServerBrowserOpened())
			return;

		GetGame().GetCallqueue().CallLater(ALGZ_WaitForNativeJoin, 250, false);
	}

	override void OnMenuClose()
	{
		bool reportPendingJoin = ALGZ_LauncherServerJoinBridge.ALGZ_ShouldReportServerBrowserClosed();
		super.OnMenuClose();
		if (reportPendingJoin)
			ALGZ_LauncherServerJoinBridge.ALGZ_ReportError("Multiplayer server browser was closed");
	}

	protected void ALGZ_WaitForNativeJoin()
	{
		if (!ALGZ_LauncherServerJoinBridge.ALGZ_IsJoinPending())
			return;

		MenuManager menuManager = GetGame().GetMenuManager();
		MenuBase serverBrowserMenu;
		if (menuManager)
			serverBrowserMenu = menuManager.FindMenuByPreset(ChimeraMenuPreset.ServerBrowserMenu);

		if (m_Lobby && m_CallbackSearchTarget && m_Dialogs && menuManager && serverBrowserMenu &&
			menuManager.GetTopMenu() == serverBrowserMenu && !menuManager.IsAnyDialogOpen() &&
			SCR_ServicesStatusHelper.IsBackendReady() && SCR_ServicesStatusHelper.IsAuthenticated())
		{
			string serverAddress;
			if (!ALGZ_LauncherServerJoinBridge.ALGZ_TakeJoinAddress(serverAddress))
				return;

			// Enter through the same Room search, version/auth, Workshop, queue and
			// dialog pipeline used by the in-game IP Connect action.
			JoinActions_DirectJoin(serverAddress, EDirectJoinFormats.IP_PORT, true);
			ALGZ_LauncherServerJoinBridge.ALGZ_MarkJoining();
			return;
		}

		m_iALGZNativeJoinWaitAttempts++;
		if (m_iALGZNativeJoinWaitAttempts >= 120)
		{
			ALGZ_LauncherServerJoinBridge.ALGZ_ReportError("Native server join did not become ready");
			return;
		}

		GetGame().GetCallqueue().CallLater(ALGZ_WaitForNativeJoin, 500, false);
	}
}
