const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TOPIC_ID = 'main';

function encodeConversationId(value) {
    return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function decodeConversationId(value) {
    return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function buildSessionId(channel, conversationId) {
    return `${channel}::${encodeConversationId(conversationId)}`;
}

function parseSessionId(sessionId) {
    const [channel, encodedConversationId] = String(sessionId || '').split('::');
    if (!channel || !encodedConversationId) {
        return null;
    }

    return {
        channel,
        conversationId: decodeConversationId(encodedConversationId),
        encodedConversationId,
        sessionId,
    };
}

function normalizeDirection(direction) {
    if (direction === 'inbound' || direction === 'outbound' || direction === 'system') {
        return direction;
    }
    return 'system';
}

function inferRole(direction, message = {}) {
    if (message.role) {
        return message.role;
    }
    if (direction === 'inbound') return 'user';
    if (direction === 'outbound') return 'assistant';
    return 'system';
}

function normalizeAttachments(attachments) {
    if (!Array.isArray(attachments)) {
        return [];
    }
    return attachments.map((attachment, index) => ({
        id: attachment.id || `attachment_${index + 1}`,
        name: attachment.name || attachment.fileName || attachment.title || `attachment_${index + 1}`,
        mimeType: attachment.mimeType || attachment.type || '',
        url: attachment.url || attachment.downloadUrl || attachment.fileUrl || '',
        size: attachment.size || 0,
        metadata: attachment.metadata || {},
    }));
}

function normalizeContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (content === null || content === undefined) {
        return '';
    }
    return JSON.stringify(content, null, 2);
}

function buildDisplayName(channel, conversationId, message = {}, metadata = {}) {
    return (
        metadata.displayName ||
        metadata.chatName ||
        message.senderName ||
        message.senderId ||
        conversationId ||
        `${channel} conversation`
    );
}

class ChannelMirrorStore {
    constructor(options = {}) {
        this.rootPath = options.rootPath;
    }

    getRootPath() {
        return this.rootPath;
    }

    resolveSessionInfo(channel, conversationId) {
        const normalizedChannel = String(channel || '').trim() || 'unknown';
        const normalizedConversationId = String(conversationId || '').trim();
        const encodedConversationId = encodeConversationId(normalizedConversationId);
        const sessionId = buildSessionId(normalizedChannel, normalizedConversationId);
        const sessionDir = path.join(this.rootPath, normalizedChannel, encodedConversationId);
        const topicsDir = path.join(sessionDir, 'topics');
        const topicDir = path.join(topicsDir, DEFAULT_TOPIC_ID);

        return {
            sessionId,
            channel: normalizedChannel,
            conversationId: normalizedConversationId,
            encodedConversationId,
            sessionDir,
            topicsDir,
            topicDir,
            sessionFile: path.join(sessionDir, 'session.json'),
            topicFile: path.join(topicDir, 'topic.json'),
            historyFile: path.join(topicDir, 'history.json'),
        };
    }

    async ensureSessionEnvelope(channel, conversationId, seed = {}) {
        const info = this.resolveSessionInfo(channel, conversationId);
        await fs.ensureDir(info.topicDir);

        const existingSession = await this._readJson(info.sessionFile, null);
        const existingTopic = await this._readJson(info.topicFile, null);
        const existingHistory = await this._readJson(info.historyFile, []);
        const now = new Date().toISOString();

        const sessionPayload = {
            sessionId: info.sessionId,
            channel: info.channel,
            channelLabel: seed.channelLabel || info.channel,
            conversationId: info.conversationId,
            threadId: seed.threadId || existingSession?.threadId || '',
            topicId: DEFAULT_TOPIC_ID,
            displayName: buildDisplayName(info.channel, info.conversationId, seed.message, seed.metadata || existingSession || {}),
            readOnly: true,
            createdAt: existingSession?.createdAt || now,
            updatedAt: now,
            metadata: {
                ...(existingSession?.metadata || {}),
                ...(seed.metadata || {}),
            },
        };

        const topicPayload = {
            id: DEFAULT_TOPIC_ID,
            name: sessionPayload.displayName,
            readOnly: true,
            createdAt: existingTopic?.createdAt || sessionPayload.createdAt,
            updatedAt: now,
        };

        await this._writeJson(info.sessionFile, sessionPayload);
        await this._writeJson(info.topicFile, topicPayload);
        if (!Array.isArray(existingHistory)) {
            await this._writeJson(info.historyFile, []);
        } else if (!(await fs.pathExists(info.historyFile))) {
            await this._writeJson(info.historyFile, existingHistory);
        }

        return {
            info,
            session: sessionPayload,
            topic: topicPayload,
        };
    }

    async appendSessionEvent(payload) {
        const {
            channel,
            conversationId,
            threadId = '',
            direction,
            source,
            message = {},
            toolCalls = [],
            memoryHits = [],
            metadata = {},
        } = payload;

        if (!channel || !conversationId) {
            throw new Error('channel and conversationId are required');
        }

        const { info, session, topic } = await this.ensureSessionEnvelope(channel, conversationId, {
            threadId,
            message,
            metadata,
        });

        const history = await this._readJson(info.historyFile, []);
        const normalizedDirection = normalizeDirection(direction);
        const role = inferRole(normalizedDirection, message);
        const timestamp = message.timestamp || Date.now();
        const messageId = message.messageId || crypto.randomUUID();
        const eventId = `${source || 'openclaw'}:${messageId}`;

        const eventPayload = {
            id: eventId,
            mirrorMessageId: messageId,
            direction: normalizedDirection,
            source: source || 'openclaw',
            role,
            name: message.senderName || message.senderId || (role === 'assistant' ? 'OpenClaw' : 'Feishu User'),
            content: normalizeContent(message.content || message.text || ''),
            attachments: normalizeAttachments(message.attachments),
            toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
            memoryHits: Array.isArray(memoryHits) ? memoryHits : [],
            metadata: {
                ...metadata,
                senderId: message.senderId || '',
                threadId,
            },
            timestamp,
        };

        const existingIndex = history.findIndex((entry) => entry.id === eventPayload.id);
        if (existingIndex >= 0) {
            history[existingIndex] = {
                ...history[existingIndex],
                ...eventPayload,
            };
        } else {
            history.push(eventPayload);
        }

        history.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
        session.updatedAt = new Date().toISOString();
        session.displayName = buildDisplayName(channel, conversationId, message, metadata || session.metadata);
        topic.updatedAt = session.updatedAt;
        topic.name = session.displayName;

        await this._writeJson(info.historyFile, history);
        await this._writeJson(info.sessionFile, session);
        await this._writeJson(info.topicFile, topic);

        return {
            session,
            topic,
            message: eventPayload,
        };
    }

    async listSessions(channel = null) {
        const targetRoot = channel ? path.join(this.rootPath, channel) : this.rootPath;
        if (!(await fs.pathExists(targetRoot))) {
            return [];
        }

        const channels = channel ? [channel] : await fs.readdir(this.rootPath);
        const sessions = [];

        for (const currentChannel of channels) {
            const channelDir = path.join(this.rootPath, currentChannel);
            if (!(await fs.pathExists(channelDir))) continue;
            const entries = await fs.readdir(channelDir);
            for (const encodedConversationId of entries) {
                const sessionFile = path.join(channelDir, encodedConversationId, 'session.json');
                const session = await this._readJson(sessionFile, null);
                if (!session) continue;
                sessions.push(session);
            }
        }

        return sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    }

    async listTopics(sessionId) {
        const parsed = parseSessionId(sessionId);
        if (!parsed) return [];
        const info = this.resolveSessionInfo(parsed.channel, parsed.conversationId);
        const topic = await this._readJson(info.topicFile, null);
        return topic ? [topic] : [];
    }

    async getHistory(sessionId, topicId = DEFAULT_TOPIC_ID) {
        const parsed = parseSessionId(sessionId);
        if (!parsed) return [];
        const info = this.resolveSessionInfo(parsed.channel, parsed.conversationId);
        if (topicId !== DEFAULT_TOPIC_ID) {
            return [];
        }
        return this._readJson(info.historyFile, []);
    }

    async _readJson(filePath, fallbackValue) {
        try {
            if (!(await fs.pathExists(filePath))) {
                return fallbackValue;
            }
            return await fs.readJson(filePath);
        } catch (error) {
            return fallbackValue;
        }
    }

    async _writeJson(filePath, value) {
        await fs.ensureDir(path.dirname(filePath));
        await fs.writeJson(filePath, value, { spaces: 2 });
    }
}

module.exports = {
    ChannelMirrorStore,
    DEFAULT_TOPIC_ID,
    buildSessionId,
    parseSessionId,
};
