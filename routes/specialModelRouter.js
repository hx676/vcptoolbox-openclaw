const express = require('express');
const dotenv = require('dotenv');
const http = require('http');
const https = require('https');

dotenv.config({ path: 'config.env' });

const router = express.Router();

const agentOptions = {
  keepAlive: true,
  keepAliveMsecs: 1000,
  freeSocketTimeout: 8000,
  scheduling: 'lifo',
  maxSockets: 10000
};
const keepAliveHttpAgent = new http.Agent(agentOptions);
const keepAliveHttpsAgent = new https.Agent(agentOptions);

const getFetchAgent = function(parsedURL) {
  return parsedURL.protocol === 'http:' ? keepAliveHttpAgent : keepAliveHttpsAgent;
};

function getDebugMode() {
  return String(process.env.DebugMode || 'False').toLowerCase() === 'true';
}

function getApiUrl() {
  return String(process.env.API_URL || '').replace(/\/+$/, '');
}

function getApiKey() {
  return process.env.API_Key;
}

function getEmbeddingApiUrl() {
  return String(process.env.EMBEDDING_API_URL || process.env.API_URL || '').replace(/\/+$/, '');
}

function getEmbeddingApiKey() {
  return process.env.EMBEDDING_API_KEY || process.env.EMBEDDING_API_Key || getApiKey();
}

function getWhitelistImageModels() {
  return String(process.env.WhitelistImageModel || '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
}

function getWhitelistEmbeddingModels() {
  return String(process.env.WhitelistEmbeddingModel || '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
}

function copyProxyHeaders(sourceHeaders, res, forceSse = false) {
  sourceHeaders.forEach((value, name) => {
    if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  });
  if (forceSse) {
    res.setHeader('Content-Type', 'text/event-stream');
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
    if (!res.getHeader('Connection')) res.setHeader('Connection', 'keep-alive');
  }
}

async function proxyRawResponse(apiResponse, res, preferStream = false) {
  const contentType = String(apiResponse.headers.get('content-type') || '').toLowerCase();
  const shouldStream = preferStream || contentType.includes('text/event-stream');

  res.status(apiResponse.status);
  copyProxyHeaders(apiResponse.headers, res, shouldStream);

  if (shouldStream && apiResponse.body) {
    apiResponse.body.on('error', (error) => {
      console.error('[SpecialRouter] Upstream streaming proxy failed:', error.message);
      if (!res.writableEnded) {
        res.end();
      }
    });
    apiResponse.body.pipe(res);
    return;
  }

  const responseText = await apiResponse.text();
  res.send(responseText);
}

router.use((req, res, next) => {
  if (req.method !== 'POST' || !req.body) {
    return next('router');
  }

  const model = req.body.model;
  if (!model) {
    return next('router');
  }

  const imageWhitelist = getWhitelistImageModels();
  const embeddingWhitelist = getWhitelistEmbeddingModels();

  if (imageWhitelist.includes(model) || embeddingWhitelist.includes(model)) {
    if (getDebugMode()) {
      console.log(`[SpecialRouter] Model "${model}" was claimed by the special model router.`);
    }
    return next();
  }

  return next('router');
});

router.post('/v1/chat/completions', async (req, res) => {
  const model = req.body.model;
  if (!getWhitelistImageModels().includes(model)) {
    return res.status(400).json({ error: 'Model does not match the image-model whitelist.' });
  }

  if (getDebugMode()) {
    console.log(`[SpecialRouter] Proxying image model chat completion for: ${model}`);
  }

  const modifiedBody = {
    ...req.body,
    generationConfig: {
      ...req.body.generationConfig,
      responseModalities: ['TEXT', 'IMAGE'],
      responseMimeType: 'text/plain'
    }
  };

  try {
    const { default: fetch } = await import('node-fetch');
    const apiResponse = await fetch(`${getApiUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getApiKey()}`,
        ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
        'Accept': req.headers['accept'] || 'application/json'
      },
      agent: getFetchAgent,
      body: JSON.stringify(modifiedBody)
    });

    await proxyRawResponse(apiResponse, res, !!req.body.stream);
  } catch (error) {
    console.error(`[SpecialRouter] Error while proxying image model "${model}":`, error.message, error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error during image model proxy', details: error.message });
    }
  }
});

router.post('/v1/embeddings', async (req, res) => {
  const model = req.body.model;
  if (!getWhitelistEmbeddingModels().includes(model)) {
    return res.status(400).json({ error: 'Model does not match the embedding-model whitelist.' });
  }

  if (getDebugMode()) {
    console.log(`[SpecialRouter] Proxying embeddings for: ${model}`);
  }

  try {
    const { default: fetch } = await import('node-fetch');
    const apiResponse = await fetch(`${getEmbeddingApiUrl()}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getEmbeddingApiKey()}`,
        ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
        'Accept': req.headers['accept'] || 'application/json'
      },
      agent: getFetchAgent,
      body: JSON.stringify(req.body)
    });

    await proxyRawResponse(apiResponse, res, false);
  } catch (error) {
    console.error(`[SpecialRouter] Error while proxying embedding model "${model}":`, error.message, error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error during embedding model proxy', details: error.message });
    }
  }
});

module.exports = router;
