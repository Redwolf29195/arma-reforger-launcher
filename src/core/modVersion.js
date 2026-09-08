function cleanVersion(value) {
  return String(value ?? '').trim();
}

function parseModVersion(value) {
  const source = cleanVersion(value);
  if (!source) return null;

  const match = source.match(/^v?(\d+(?:\.\d+)*)(?:-([0-9a-z.-]+))?(?:\+[0-9a-z.-]+)?$/i);
  if (!match) return null;

  const parts = match[1].split('.').map((part) => BigInt(part));
  while (parts.length > 1 && parts.at(-1) === 0n) parts.pop();
  return {
    parts,
    prerelease: String(match[2] || '').toLowerCase()
  };
}

function compareModVersions(leftValue, rightValue) {
  const left = parseModVersion(leftValue);
  const right = parseModVersion(rightValue);
  if (!left || !right) return null;

  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.parts[index] ?? 0n;
    const rightPart = right.parts[index] ?? 0n;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease, 'en', { numeric: true });
}

function modVersionsEqual(leftValue, rightValue) {
  const left = cleanVersion(leftValue);
  const right = cleanVersion(rightValue);
  if (left.toLowerCase() === right.toLowerCase()) return true;
  return compareModVersions(left, right) === 0;
}

function selectCurrentModVersion(requiredValue, installedValue) {
  const required = cleanVersion(requiredValue);
  const installed = cleanVersion(installedValue);
  if (!installed) return required;
  if (!required || modVersionsEqual(required, installed)) return installed;

  const order = compareModVersions(installed, required);
  return order !== null && order > 0 ? installed : required;
}

module.exports = {
  compareModVersions,
  modVersionsEqual,
  parseModVersion,
  selectCurrentModVersion
};
