const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { getEmbeddingsBatch, getEmbeddingApiConfig } = require('../EmbeddingUtils');
const { ChannelMirrorStore } = require('../modules/openclaw/channelMirrorStore');

const DEFAULT_ALLOWLIST = ['UrlFetch', 'VSearch', 'BilibiliFetch'];
const DEFAULT_MEMORY_NOTEBOOK = String(process.env.OPENCLAW_VCP_DEFAULT_NOTEBOOK || 'OpenClaw记忆').trim() || 'OpenClaw记忆';
const DEFAULT_MEMORY_AGENT = String(process.env.OPENCLAW_VCP_DEFAULT_MEMORY_AGENT || 'OpenClaw').trim() || 'OpenClaw';
const DEFAULT_MEMORY_TIMEZONE = String(process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
const DEFAULT_KB_AGENT = String(process.env.OPENCLAW_VCP_DEFAULT_KB_AGENT || 'nova').trim().toLowerCase() || 'nova';
const DEFAULT_KB_MODEL = String(process.env.OPENCLAW_VCP_KB_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';

const TOOL_DEFINITIONS = Object.freeze({
    UrlFetch: {
        toolName: 'UrlFetch',
        displayName: 'VCP URL Fetch',
        description: 'Fetch web pages, snapshots, images, or local files via VCP.',
        riskLevel: 'low',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                url: { type: 'string' },
                mode: { type: 'string', enum: ['text', 'snapshot', 'image'] },
            },
            required: ['url'],
        },
    },
    VSearch: {
        toolName: 'VSearch',
        displayName: 'VCP Semantic Search',
        description: 'Run deep concurrent search across web sources through VCP.',
        riskLevel: 'medium',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                SearchTopic: { type: 'string' },
                Keywords: { type: 'string' },
                SearchMode: { type: 'string', enum: ['grounding', 'grok', 'tavily'] },
                ShowURL: { type: 'boolean' },
            },
            required: ['SearchTopic', 'Keywords'],
        },
    },
    BilibiliFetch: {
        toolName: 'BilibiliFetch',
        displayName: 'VCP Bilibili Fetch',
        description: 'Read-only Bilibili search and fetch helper exposed through VCP.',
        riskLevel: 'low',
        inputSchema: {
            type: 'object',
            additionalProperties: true,
            properties: {
                url: { type: 'string' },
                action: { type: 'string' },
                keyword: { type: 'string' },
                search_type: { type: 'string' },
                page: { type: 'number' },
                danmaku_num: { type: 'number' },
                comment_num: { type: 'number' },
                snapshots: { type: 'string' },
                hd_snapshot: { type: 'boolean' },
            },
        },
    },
});

function normalizeLoopbackIp(rawIp) {
    if (!rawIp) return '';
    if (rawIp === '::1') return '127.0.0.1';
    if (rawIp.startsWith('::ffff:')) return rawIp.slice(7);
    return rawIp;
}

function isLoopbackRequest(req) {
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const candidates = [
        normalizeLoopbackIp(req.ip),
        normalizeLoopbackIp(req.socket?.remoteAddress || ''),
        normalizeLoopbackIp(forwardedFor),
    ].filter(Boolean);

    return candidates.every((value) => value === '127.0.0.1');
}

function getSharedToken() {
    return String(process.env.OPENCLAW_VCP_SHARED_TOKEN || '').trim();
}

function getAllowlist() {
    const raw = String(process.env.OPENCLAW_VCP_TOOL_ALLOWLIST || '').trim();
    if (!raw) {
        return DEFAULT_ALLOWLIST;
    }
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function createValidationError(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
}

function createServerError(message) {
    const error = new Error(message);
    error.status = 500;
    return error;
}

function validateSchemaValue(key, schema, value) {
    if (!schema) return;
    if (value === undefined || value === null) return;

    const schemaType = schema.type;
    if (schemaType === 'string' && typeof value !== 'string') {
        throw createValidationError(`arguments.${key} must be a string`);
    }
    if (schemaType === 'number' && typeof value !== 'number') {
        throw createValidationError(`arguments.${key} must be a number`);
    }
    if (schemaType === 'boolean' && typeof value !== 'boolean') {
        throw createValidationError(`arguments.${key} must be a boolean`);
    }
    if (schemaType === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
        throw createValidationError(`arguments.${key} must be an object`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
        throw createValidationError(`arguments.${key} must be one of: ${schema.enum.join(', ')}`);
    }
}

function validateArguments(definition, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw createValidationError('arguments must be an object');
    }

    const schema = definition.inputSchema || {};
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    for (const requiredKey of required) {
        if (args[requiredKey] === undefined || args[requiredKey] === null || args[requiredKey] === '') {
            throw createValidationError(`arguments.${requiredKey} is required`);
        }
    }

    for (const [key, value] of Object.entries(args)) {
        validateSchemaValue(key, properties[key], value);
    }
}

function summarizeSearchResults(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return '';
    }
    return items
        .slice(0, 5)
        .map((item, index) => `${index + 1}. ${item.sourceFile}: ${String(item.text || '').replace(/\s+/g, ' ').slice(0, 140)}`)
        .join('\n');
}

function normalizeAgentAlias(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => String(item || '').trim())
        .filter(Boolean);
}

function normalizeDateString(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return new Intl.DateTimeFormat('sv-SE', {
            timeZone: DEFAULT_MEMORY_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date());
    }

    if (!/^\d{4}[-/.]\d{2}[-/.]\d{2}$/.test(raw)) {
        throw createValidationError('dateString must be in YYYY-MM-DD format');
    }

    return raw.replace(/[/.]/g, '-');
}

function buildMemoryWritePayload(body = {}) {
    const notebook = String(body.notebook || body.folder || DEFAULT_MEMORY_NOTEBOOK).trim();
    const content = String(body.content || body.text || '').trim();
    const title = String(body.title || '').trim();
    const agentName = String(
        body.agentName
        || body.callerMeta?.agentId
        || body.callerMeta?.channelId
        || DEFAULT_MEMORY_AGENT
    ).trim() || DEFAULT_MEMORY_AGENT;
    const dateString = normalizeDateString(body.dateString);

    if (!notebook) {
        throw createValidationError('notebook is required');
    }
    if (!content) {
        throw createValidationError('content is required');
    }

    const tags = Array.from(new Set([
        'openclaw',
        ...normalizeStringArray(body.tags),
        String(body.callerMeta?.channelId || '').trim(),
        String(body.callerMeta?.agentId || '').trim(),
    ].filter(Boolean)));

    const contentLines = [];
    if (title) {
        contentLines.push(`# ${title}`, '');
    }
    contentLines.push(content);
    if (tags.length > 0) {
        contentLines.push('', `Tag: ${tags.join(', ')}`);
    }

    return {
        notebook,
        title,
        tags,
        diaryPayload: {
            maidName: `[${notebook}]${agentName}`,
            dateString,
            contentText: contentLines.join('\n'),
        },
    };
}

function extractSavedPath(message) {
    const match = String(message || '').match(/Diary saved to (.*)$/i);
    return match?.[1]?.trim() || '';
}

async function callLocalVcpChat({ routePath, body, port, serverKey }) {
    const { default: fetch } = await import('node-fetch');
    const response = await fetch(`http://127.0.0.1:${port}${routePath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serverKey}`,
        },
        body: JSON.stringify(body),
    });

    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = { raw: text };
    }

    if (!response.ok) {
        throw new Error(data?.error || `VCP chat request failed with status ${response.status}`);
    }

    return data;
}

function extractAssistantTextFromChatResponse(payload) {
    const messageContent = payload?.choices?.[0]?.message?.content;
    if (typeof messageContent === 'string') {
        return messageContent;
    }
    if (Array.isArray(messageContent)) {
        return messageContent
            .map((part) => {
                if (!part) return '';
                if (typeof part === 'string') return part;
                if (part.type === 'text') return String(part.text || '');
                return '';
            })
            .join('')
            .trim();
    }
    return '';
}

function buildKbAskBody(input = {}) {
    const agentAlias = normalizeAgentAlias(input.agentAlias || input.agent || DEFAULT_KB_AGENT);
    const question = String(input.question || input.query || '').trim();
    const contextText = String(input.contextText || input.context || '').trim();
    const model = String(input.model || DEFAULT_KB_MODEL).trim() || DEFAULT_KB_MODEL;
    const systemHint = String(input.systemHint || '').trim();
    const showVcp = input.showVcp === true;

    if (!agentAlias) {
        throw createValidationError('agentAlias is required');
    }
    if (!question) {
        throw createValidationError('question is required');
    }

    const systemBlocks = [
        `{{${agentAlias}}}`,
        '你当前正作为 VCP 内部知识库智能体，通过 OpenClaw 集成接口被调用。',
        '优先使用你自己的知识库、记忆能力和 VCP 工具来回答。',
        '如果依据不足，请直接说明，而不是猜测。',
    ];
    if (systemHint) {
        systemBlocks.push(systemHint);
    }

    const userBlocks = [];
    if (contextText) {
        userBlocks.push(`[补充上下文]\n${contextText}`);
    }
    userBlocks.push(`[用户问题]\n${question}`);

    return {
        routePath: showVcp ? '/v1/chatvcp/completions' : '/v1/chat/completions',
        requestBody: {
            model,
            stream: false,
            requestId: crypto.randomUUID(),
            messages: [
                {
                    role: 'system',
                    content: systemBlocks.join('\n\n'),
                },
                {
                    role: 'user',
                    content: userBlocks.join('\n\n'),
                },
            ],
        },
        meta: {
            agentAlias,
            model,
            showVcp,
        },
    };
}

function extractArtifactsFromResult(value) {
    const artifacts = [];
    if (!value || typeof value !== 'object') {
        return artifacts;
    }

    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        for (const [key, nestedValue] of Object.entries(node)) {
            if (typeof nestedValue === 'string' && /^https?:\/\//i.test(nestedValue)) {
                artifacts.push({ kind: 'url', key, value: nestedValue });
            } else if (Array.isArray(nestedValue)) {
                nestedValue.forEach(visit);
            } else if (typeof nestedValue === 'object') {
                visit(nestedValue);
            }
        }
    };

    visit(value);
    return artifacts.slice(0, 20);
}

function normalizePluginResult(result) {
    if (result && typeof result === 'object') {
        if (result.plugin_error || result.plugin_execution_error) {
            return {
                ok: false,
                result: null,
                error: result.plugin_error || result.plugin_execution_error,
                artifacts: [],
            };
        }
        return {
            ok: true,
            result,
            error: '',
            artifacts: extractArtifactsFromResult(result),
        };
    }

    return {
        ok: true,
        result: result === undefined ? null : result,
        error: '',
        artifacts: [],
    };
}

function getMirrorRoot(projectRoot) {
    return process.env.CHANNEL_MIRROR_ROOT_PATH || path.join(projectRoot, 'ChannelMirrorData');
}

function buildRouter(options = {}) {
    const router = express.Router();
    const { pluginManager, knowledgeBaseManager, projectRoot, agentManager } = options;
    const mirrorStore = new ChannelMirrorStore({ rootPath: getMirrorRoot(projectRoot) });

    router.use((req, res, next) => {
        const sharedToken = getSharedToken();
        if (!sharedToken) {
            return res.status(503).json({ error: 'OPENCLAW_VCP_SHARED_TOKEN is not configured.' });
        }

        if (!isLoopbackRequest(req)) {
            return res.status(403).json({ error: 'OpenClaw integration is restricted to loopback requests.' });
        }

        const authHeader = String(req.headers.authorization || '');
        if (authHeader !== `Bearer ${sharedToken}`) {
            return res.status(401).json({ error: 'Invalid OpenClaw integration token.' });
        }

        return next();
    });

    router.get('/tools/catalog', (req, res) => {
        const catalog = getAllowlist()
            .map((toolName) => TOOL_DEFINITIONS[toolName])
            .filter(Boolean);

        return res.json({
            ok: true,
            tools: catalog,
        });
    });

    router.post('/tools/execute', async (req, res) => {
        const traceId = crypto.randomUUID();
        try {
            const { toolName, arguments: args = {} } = req.body || {};
            if (!toolName || !TOOL_DEFINITIONS[toolName]) {
                throw createValidationError(`toolName "${toolName}" is not in the OpenClaw allowlist`);
            }
            if (!getAllowlist().includes(toolName)) {
                throw createValidationError(`toolName "${toolName}" is currently disabled by allowlist`);
            }

            const definition = TOOL_DEFINITIONS[toolName];
            validateArguments(definition, args);

            const result = await pluginManager.processToolCall(definition.toolName, { ...args }, '127.0.0.1');
            const normalized = normalizePluginResult(result);
            return res.json({
                ok: normalized.ok,
                result: normalized.result,
                error: normalized.error,
                artifacts: normalized.artifacts,
                traceId,
            });
        } catch (error) {
            return res.status(error.status || 500).json({
                ok: false,
                result: null,
                error: error.message || String(error),
                artifacts: [],
                traceId,
            });
        }
    });

    router.post('/memory/search', async (req, res) => {
        const traceId = crypto.randomUUID();
        try {
            const { query, topK = 5, scope = 'all' } = req.body || {};
            if (!query || typeof query !== 'string') {
                throw createValidationError('query is required');
            }
            if (!knowledgeBaseManager?.db) {
                throw new Error('KnowledgeBaseManager is not available.');
            }

            const [queryVector] = await getEmbeddingsBatch([query], getEmbeddingApiConfig(knowledgeBaseManager.config));
            if (!queryVector) {
                throw new Error('Failed to embed the search query.');
            }

            const normalizedTopK = Math.max(1, Math.min(20, Number(topK) || 5));
            const results = (typeof scope === 'string' && scope !== 'all')
                ? await knowledgeBaseManager.search(scope, queryVector, normalizedTopK)
                : await knowledgeBaseManager.search(queryVector, normalizedTopK);

            const items = (results || []).map((item, index) => ({
                id: `${item.fullPath || item.sourceFile || 'chunk'}:${index + 1}`,
                sourceFile: item.sourceFile || '',
                fullPath: item.fullPath || '',
                score: Number(item.score || 0),
                text: item.text || '',
                matchedTags: item.matchedTags || [],
                coreTagsMatched: item.coreTagsMatched || [],
            }));

            return res.json({
                ok: true,
                items,
                summary: summarizeSearchResults(items),
                debug: {
                    scope,
                    topK: normalizedTopK,
                    resultCount: items.length,
                },
                traceId,
            });
        } catch (error) {
            return res.status(error.status || 500).json({
                ok: false,
                items: [],
                summary: '',
                debug: {},
                error: error.message || String(error),
                traceId,
            });
        }
    });

    router.post('/memory/write', async (req, res) => {
        const traceId = crypto.randomUUID();
        try {
            if (!pluginManager) {
                throw createServerError('PluginManager is not available.');
            }

            const { notebook, title, tags, diaryPayload } = buildMemoryWritePayload(req.body || {});
            const pluginResult = await pluginManager.executePlugin('DailyNoteWrite', JSON.stringify(diaryPayload), '127.0.0.1');

            if (!pluginResult || pluginResult.status !== 'success') {
                throw createServerError(pluginResult?.message || 'DailyNoteWrite failed.');
            }

            return res.json({
                ok: true,
                notebook,
                title,
                tags,
                savedPath: extractSavedPath(pluginResult.message),
                result: pluginResult,
                traceId,
            });
        } catch (error) {
            return res.status(error.status || 500).json({
                ok: false,
                notebook: String(req.body?.notebook || '').trim(),
                savedPath: '',
                result: null,
                error: error.message || String(error),
                traceId,
            });
        }
    });

    router.post('/kb/ask', async (req, res) => {
        const traceId = crypto.randomUUID();
        try {
            const { routePath, requestBody, meta } = buildKbAskBody(req.body || {});
            if (!agentManager?.isAgent(meta.agentAlias)) {
                throw createValidationError(`agentAlias "${meta.agentAlias}" was not found in VCP agent_map.json`);
            }

            const serverKey = String(process.env.Key || '').trim();
            if (!serverKey) {
                throw createServerError('VCP server key is not configured.');
            }

            const port = Number(process.env.PORT || 6005);
            const chatResponse = await callLocalVcpChat({
                routePath,
                body: requestBody,
                port,
                serverKey,
            });

            return res.json({
                ok: true,
                agentAlias: meta.agentAlias,
                model: meta.model,
                text: extractAssistantTextFromChatResponse(chatResponse),
                result: chatResponse,
                traceId,
            });
        } catch (error) {
            return res.status(error.status || 500).json({
                ok: false,
                agentAlias: normalizeAgentAlias(req.body?.agentAlias || req.body?.agent || DEFAULT_KB_AGENT),
                text: '',
                result: null,
                error: error.message || String(error),
                traceId,
            });
        }
    });

    router.post('/mirror/session-event', async (req, res) => {
        const traceId = crypto.randomUUID();
        try {
            const payload = req.body || {};
            if (!payload.channel || !payload.conversationId || !payload.message) {
                throw createValidationError('channel, conversationId, and message are required');
            }

            const stored = await mirrorStore.appendSessionEvent(payload);
            return res.json({
                ok: true,
                stored,
                traceId,
            });
        } catch (error) {
            return res.status(error.status || 500).json({
                ok: false,
                error: error.message || String(error),
                traceId,
            });
        }
    });

    return router;
}

module.exports = buildRouter;
