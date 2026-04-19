// EmbeddingUtils.js
const { get_encoding } = require("@dqbd/tiktoken");
const { chunkText } = require("./TextChunker");
const encoding = get_encoding("cl100k_base");

const embeddingMaxToken = parseInt(process.env.WhitelistEmbeddingModelMaxToken, 10) || 8000;
const safeMaxTokens = Math.floor(embeddingMaxToken * 0.85);
const MAX_BATCH_ITEMS = 100;
const DEFAULT_CONCURRENCY = parseInt(process.env.TAG_VECTORIZE_CONCURRENCY, 10) || 5;
const DEFAULT_EMBEDDING_MODEL = 'google/gemini-embedding-001';

function normalizeBaseUrl(url) {
    return (url || '').replace(/\/+$/, '');
}

function getEmbeddingApiConfig(overrides = {}) {
    return {
        apiKey: overrides.apiKey || process.env.EMBEDDING_API_KEY || process.env.EMBEDDING_API_Key || process.env.API_Key,
        apiUrl: normalizeBaseUrl(overrides.apiUrl || process.env.EMBEDDING_API_URL || process.env.API_URL),
        model: overrides.model || process.env.WhitelistEmbeddingModel || DEFAULT_EMBEDDING_MODEL
    };
}

function isContextLengthError(message = "") {
    return /input length exceeds the context length/i.test(message);
}

function averageVectors(vectors) {
    if (!vectors || vectors.length === 0) return null;
    const dimension = vectors[0].length;
    const sum = new Array(dimension).fill(0);

    for (const vector of vectors) {
        if (!vector || vector.length !== dimension) continue;
        for (let i = 0; i < dimension; i++) {
            sum[i] += vector[i];
        }
    }

    return sum.map(value => value / vectors.length);
}

async function _sendBatchOrNull(batchTexts, config, batchNumber) {
    try {
        return await _sendBatch(batchTexts, config, batchNumber);
    } catch (e) {
        console.error(`[Embedding] Batch ${batchNumber} failed permanently after split recovery: ${e.message}`);
        return new Array(batchTexts.length).fill(null);
    }
}

async function _sendBatch(batchTexts, config, batchNumber) {
    const { default: fetch } = await import("node-fetch");
    const retryAttempts = 3;
    const baseDelay = 1000;

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        try {
            const requestUrl = `${config.apiUrl}/v1/embeddings`;
            const requestBody = { model: config.model, input: batchTexts };
            const requestHeaders = {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${config.apiKey}`
            };

            const response = await fetch(requestUrl, {
                method: "POST",
                headers: requestHeaders,
                body: JSON.stringify(requestBody)
            });

            const responseBodyText = await response.text();

            if (!response.ok) {
                if (response.status === 429) {
                    const waitTime = 5000 * attempt;
                    console.warn(`[Embedding] Batch ${batchNumber} rate limited (429). Retrying in ${waitTime / 1000}s...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }
                throw new Error(`API Error ${response.status}: ${responseBodyText.substring(0, 500)}`);
            }

            let data;
            try {
                data = JSON.parse(responseBodyText);
            } catch (parseError) {
                console.error(`[Embedding] JSON parse error for Batch ${batchNumber}:`);
                console.error(`Response (first 500 chars): ${responseBodyText.substring(0, 500)}`);
                throw new Error(`Failed to parse API response as JSON: ${parseError.message}`);
            }

            if (!data) {
                throw new Error("API returned empty/null response");
            }

            if (data.error) {
                const errorMsg = data.error.message || JSON.stringify(data.error);
                const errorCode = data.error.code || response.status;
                console.error(`[Embedding] API error for Batch ${batchNumber}:`);
                console.error(`  Error Code: ${errorCode}`);
                console.error(`  Error Message: ${errorMsg}`);
                console.error(`  Hint: Check if embedding model "${config.model}" is available on your API server`);
                throw new Error(`API Error ${errorCode}: ${errorMsg}`);
            }

            if (!data.data) {
                console.error(`[Embedding] Missing 'data' field in response for Batch ${batchNumber}`);
                console.error(`Response keys: ${Object.keys(data).join(", ")}`);
                console.error(`Response preview: ${JSON.stringify(data).substring(0, 500)}`);
                throw new Error("Invalid API response structure: missing 'data' field");
            }

            if (!Array.isArray(data.data)) {
                console.error(`[Embedding] 'data' field is not an array for Batch ${batchNumber}`);
                console.error(`data type: ${typeof data.data}`);
                console.error(`data value: ${JSON.stringify(data.data).substring(0, 200)}`);
                throw new Error("Invalid API response structure: 'data' is not an array");
            }

            if (data.data.length === 0) {
                console.warn(`[Embedding] Warning: Batch ${batchNumber} returned empty embeddings array`);
            }

            return data.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
        } catch (e) {
            if (isContextLengthError(e.message)) {
                if (batchTexts.length === 1) {
                    const splitTokenLimit = Math.max(128, Math.floor(safeMaxTokens / 2));
                    const splitOverlap = Math.max(16, Math.floor(splitTokenLimit * 0.1));
                    const splitTexts = chunkText(batchTexts[0], splitTokenLimit, splitOverlap);

                    if (!splitTexts || splitTexts.length <= 1) {
                        console.warn(`[Embedding] Batch ${batchNumber} contains a single text that still exceeds the model context length. Marking it as null.`);
                        return [null];
                    }

                    console.warn(`[Embedding] Batch ${batchNumber} contains a single oversize text. Re-splitting it into ${splitTexts.length} chunks.`);
                    const splitVectors = await _sendBatchOrNull(splitTexts, config, `${batchNumber}.split`);
                    const validVectors = splitVectors.filter(Boolean);
                    return [averageVectors(validVectors) || null];
                }

                const mid = Math.ceil(batchTexts.length / 2);
                console.warn(`[Embedding] Batch ${batchNumber} exceeded model context length. Splitting ${batchTexts.length} items into ${mid} and ${batchTexts.length - mid}.`);
                const leftVectors = await _sendBatchOrNull(batchTexts.slice(0, mid), config, `${batchNumber}.1`);
                const rightVectors = await _sendBatchOrNull(batchTexts.slice(mid), config, `${batchNumber}.2`);
                return [...leftVectors, ...rightVectors];
            }

            console.warn(`[Embedding] Batch ${batchNumber}, Attempt ${attempt} failed: ${e.message}`);
            if (attempt === retryAttempts) throw e;
            await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
        }
    }
}

async function getEmbeddingsBatch(texts, config) {
    if (!texts || texts.length === 0) return [];

    const resolvedConfig = getEmbeddingApiConfig(config);
    if (!resolvedConfig.apiKey || !resolvedConfig.apiUrl || !resolvedConfig.model) {
        console.error('[Embedding] Embedding API credentials or model is not configured.');
        return new Array(texts.length).fill(null);
    }

    const batches = [];
    let currentBatchTexts = [];
    let currentBatchIndices = [];
    let currentBatchTokens = 0;
    const oversizeIndices = new Set();

    for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        const textTokens = encoding.encode(text).length;
        if (textTokens > safeMaxTokens) {
            console.warn(`[Embedding] Text at index ${i} exceeds token limit (${textTokens} > ${safeMaxTokens}), skipping.`);
            oversizeIndices.add(i);
            continue;
        }

        const isTokenFull = currentBatchTexts.length > 0 && (currentBatchTokens + textTokens > safeMaxTokens);
        const isItemFull = currentBatchTexts.length >= MAX_BATCH_ITEMS;

        if (isTokenFull || isItemFull) {
            batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
            currentBatchTexts = [text];
            currentBatchIndices = [i];
            currentBatchTokens = textTokens;
        } else {
            currentBatchTexts.push(text);
            currentBatchIndices.push(i);
            currentBatchTokens += textTokens;
        }
    }

    if (currentBatchTexts.length > 0) {
        batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
    }

    if (oversizeIndices.size > 0) {
        console.warn(`[Embedding] ${oversizeIndices.size} texts skipped due to token limit.`);
    }
    console.log(`[Embedding] Prepared ${batches.length} batches from ${texts.length} texts. Executing with concurrency: ${DEFAULT_CONCURRENCY}...`);

    const batchResults = new Array(batches.length);
    let cursor = 0;

    const worker = async () => {
        while (true) {
            const batchIndex = cursor++;
            if (batchIndex >= batches.length) break;

            const batch = batches[batchIndex];
            try {
                batchResults[batchIndex] = {
                    vectors: await _sendBatch(batch.texts, resolvedConfig, batchIndex + 1),
                    originalIndices: batch.originalIndices
                };
            } catch (e) {
                console.error(`[Embedding] Batch ${batchIndex + 1} failed permanently: ${e.message}`);
                batchResults[batchIndex] = {
                    vectors: null,
                    originalIndices: batch.originalIndices,
                    error: e.message
                };
            }
        }
    };

    const workers = [];
    for (let i = 0; i < DEFAULT_CONCURRENCY; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    const finalResults = new Array(texts.length).fill(null);
    let successCount = 0;
    let failCount = 0;

    for (const result of batchResults) {
        if (!result || !result.vectors) {
            if (result) failCount += result.originalIndices.length;
            continue;
        }

        result.originalIndices.forEach((origIdx, vecIdx) => {
            finalResults[origIdx] = result.vectors[vecIdx] || null;
            if (result.vectors[vecIdx]) successCount++;
            else failCount++;
        });
    }

    failCount += oversizeIndices.size;

    if (failCount > 0) {
        console.warn(`[Embedding] Results: ${successCount} succeeded, ${failCount} failed/skipped out of ${texts.length} total.`);
    }

    return finalResults;
}

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

module.exports = { getEmbeddingsBatch, cosineSimilarity, getEmbeddingApiConfig };
