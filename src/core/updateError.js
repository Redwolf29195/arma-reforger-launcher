function classifyUpdateError(error) {
  const code = String(error?.code || '');
  // System codes are authoritative; neither stack frames nor a filename in an
  // I/O message should turn a disk/network failure into a signature failure.
  if (/^(?:ENOSPC|EACCES|EPERM|EROFS|EDQUOT|EIO)$/.test(code)) return 'storage';
  if (/^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/.test(code)) return 'network';
  const value = `${code} ${error?.message || (typeof error === 'string' ? error : '')}`;
  if (/404|CHANNEL_FILE_NOT_FOUND|Cannot find[^\r\n]*\.yml/i.test(value)) return 'channel';
  if (/sha-?512|checksum|signature|integrity|verification|verify|corrupt/i.test(value)) return 'verification';
  if (/ENOSPC|no space|EACCES|EPERM|permission|access denied/i.test(value)) return 'storage';
  if (/CONNECTION_(?:RESET|CLOSED|REFUSED|ABORTED)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|network unreachable/i.test(value)) return 'network';
  return 'unknown';
}

module.exports = { classifyUpdateError };
