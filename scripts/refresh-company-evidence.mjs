import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "https://alpha.custard.top/api/company-evidence-refresh";
const DEFAULT_TOTAL_LIMIT = 50;
const DEFAULT_BATCH_LIMIT = 5;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RETRIES = 2;

export function parseRefreshConfig(env = process.env) {
  const totalLimit = clampPositiveInteger(env.COMPANY_EVIDENCE_LIMIT, DEFAULT_TOTAL_LIMIT, 200);
  const requestedBatchLimit = clampPositiveInteger(env.COMPANY_EVIDENCE_BATCH_SIZE, DEFAULT_BATCH_LIMIT, 50);
  return {
    endpoint: env.COMPANY_EVIDENCE_REFRESH_URL || DEFAULT_ENDPOINT,
    token: env.COMPANY_EVIDENCE_REFRESH_TOKEN,
    userId: env.COMPANY_EVIDENCE_USER_ID || undefined,
    watchlistId: env.COMPANY_EVIDENCE_WATCHLIST_ID || undefined,
    totalLimit,
    batchLimit: Math.min(requestedBatchLimit, totalLimit),
    timeoutMs: clampPositiveInteger(env.COMPANY_EVIDENCE_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 120_000),
    maxRetries: clampPositiveInteger(env.COMPANY_EVIDENCE_MAX_RETRIES, DEFAULT_MAX_RETRIES, 5),
  };
}

export async function refreshCompanyEvidence({ env = process.env, fetchImpl = fetch, logger = console } = {}) {
  const config = parseRefreshConfig(env);
  if (!config.token) {
    throw new Error("COMPANY_EVIDENCE_REFRESH_TOKEN is required.");
  }

  const totals = {
    count: 0,
    refreshedCount: 0,
    failedCount: 0,
    requestFailedCount: 0,
    refreshed: [],
    failed: [],
    batches: [],
  };

  if (config.watchlistId) {
    const result = await requestWithRetries(config, fetchImpl, { limit: 1, offset: 0 }, logger);
    mergeRefreshResult(totals, result, { limit: 1, offset: 0 });
    logger.log(JSON.stringify(totals, null, 2));
    return totals;
  }

  for (let offset = 0; offset < config.totalLimit;) {
    const limit = Math.min(config.batchLimit, config.totalLimit - offset);
    try {
      const result = await requestWithRetries(config, fetchImpl, { limit, offset }, logger);
      mergeRefreshResult(totals, result, { limit, offset });
      const processed = normalizeCount(result.count);
      if (processed < limit) break;
      offset += limit;
    } catch (error) {
      if (!isRetryableError(error)) throw error;
      if (limit <= 1) {
        totals.requestFailedCount += 1;
        totals.failed.push({ watchlistId: `offset:${offset}`, ticker: "unknown", error: error instanceof Error ? error.message : String(error) });
        offset += 1;
        continue;
      }
      logger.warn(`Batch offset=${offset} limit=${limit} failed; splitting into single-company requests. ${error instanceof Error ? error.message : String(error)}`);
      for (let index = 0; index < limit; index += 1) {
        const singleOffset = offset + index;
        try {
          const result = await requestWithRetries(config, fetchImpl, { limit: 1, offset: singleOffset }, logger);
          mergeRefreshResult(totals, result, { limit: 1, offset: singleOffset });
          if (normalizeCount(result.count) < 1) {
            offset = singleOffset + 1;
            logger.log(JSON.stringify(totals, null, 2));
            return totals;
          }
        } catch (singleError) {
          if (!isRetryableError(singleError)) throw singleError;
          totals.requestFailedCount += 1;
          totals.failed.push({
            watchlistId: `offset:${singleOffset}`,
            ticker: "unknown",
            error: singleError instanceof Error ? singleError.message : String(singleError),
          });
        }
      }
      offset += limit;
    }
  }

  logger.log(JSON.stringify(totals, null, 2));
  return totals;
}

async function requestWithRetries(config, fetchImpl, batch, logger) {
  let lastError;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      return await requestRefreshBatch(config, fetchImpl, batch);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === config.maxRetries) break;
      const waitMs = 1_000 * 2 ** attempt;
      logger.warn(`Company evidence refresh batch offset=${batch.offset} limit=${batch.limit} failed (${error.message}); retrying in ${waitMs}ms.`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function requestRefreshBatch(config, fetchImpl, batch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${config.timeoutMs}ms`)), config.timeoutMs);
  try {
    const body = {
      userId: config.userId,
      watchlistId: config.watchlistId,
      limit: batch.limit,
      offset: batch.offset,
    };
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new RefreshHttpError(response.status, `Company evidence refresh failed: ${response.status} ${text.slice(0, 1000)}`);
    }
    return text.trim() ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function mergeRefreshResult(totals, result, batch) {
  totals.count += normalizeCount(result.count);
  totals.refreshedCount += normalizeCount(result.refreshedCount);
  totals.failedCount += normalizeCount(result.failedCount);
  totals.refreshed.push(...(Array.isArray(result.refreshed) ? result.refreshed : []));
  totals.failed.push(...(Array.isArray(result.failed) ? result.failed : []));
  totals.batches.push({ ...batch, count: normalizeCount(result.count), refreshedCount: normalizeCount(result.refreshedCount), failedCount: normalizeCount(result.failedCount) });
}

function normalizeCount(value) {
  return Number.isFinite(value) && value > 0 ? Number(value) : 0;
}

function clampPositiveInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(parsed)), max);
}

function isRetryableError(error) {
  if (error instanceof RefreshHttpError) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RefreshHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await refreshCompanyEvidence();
}
