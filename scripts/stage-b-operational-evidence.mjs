const PROVIDER_OPERATIONS = [
  "candleSnapshot",
  "perpCategories",
  "metaAndAssetCtxs",
];

/** Validate one sanitized Stage B operational-evidence manifest. */
export function validateStageBOperationalEvidence(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isSessionKeyList(value.sessionKeys) ||
    !isProviderEvidence(value.provider) ||
    !isNotificationEvidence(value.notifications) ||
    !isWorkerEvidence(value.worker)
  ) {
    throw new Error("operational evidence does not match the stage B v1 contract");
  }
  return value;
}

function isProviderEvidence(value) {
  return isRecord(value) &&
    isNonNegativeInteger(value.requestCount) &&
    isNonNegativeNumber(value.estimatedPeakWeight60s) &&
    isNonNegativeInteger(value.budgetViolationCount) &&
    isNonNegativeInteger(value.maximumConsecutiveScheduled429s) &&
    isRecord(value.rateLimit429ByOperation) &&
    PROVIDER_OPERATIONS.every((operation) =>
      isNonNegativeInteger(value.rateLimit429ByOperation[operation])
    );
}

function isNotificationEvidence(value) {
  return isRecord(value) && isNonNegativeInteger(value.duplicateCount);
}

function isWorkerEvidence(value) {
  return isRecord(value) &&
    isNonNegativeNumber(value.scanLatencyMsP50) &&
    isNonNegativeNumber(value.scanLatencyMsP95) &&
    value.scanLatencyMsP50 <= value.scanLatencyMsP95 &&
    isNonNegativeInteger(value.kvReadCount) &&
    isNonNegativeInteger(value.kvWriteCount) &&
    isNonNegativeInteger(value.durableObjectRequestCount) &&
    isOptionalNonNegativeNumber(value.cpuTimeMsTotal) &&
    isOptionalNonNegativeNumber(value.estimatedMonthlyCostUsd);
}

function isSessionKeyList(value) {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(isIsoDateKey) &&
    new Set(value).size === value.length;
}

function isIsoDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function isOptionalNonNegativeNumber(value) {
  return value === null || isNonNegativeNumber(value);
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
