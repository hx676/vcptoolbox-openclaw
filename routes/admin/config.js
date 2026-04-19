const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager, reloadMainConfig, reloadPluginRuntime } = options;

    router.get('/tool-approval-config', async (req, res) => {
        const configPath = path.join(__dirname, '..', '..', 'toolApprovalConfig.json');
        try {
            const content = await fs.readFile(configPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.json({ enabled: false, timeoutMinutes: 5, approveAll: false, approvalList: [] });
            } else {
                console.error('[AdminPanelRoutes API] Error reading tool approval config:', error);
                res.status(500).json({ error: 'Failed to read tool approval config', details: error.message });
            }
        }
    });

    router.post('/tool-approval-config', async (req, res) => {
        const { config } = req.body;
        if (typeof config !== 'object' || config === null) {
            return res.status(400).json({ error: 'Invalid configuration data. Object expected.' });
        }

        const configPath = path.join(__dirname, '..', '..', 'toolApprovalConfig.json');
        try {
            await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
            if (pluginManager?.toolApprovalManager?.loadConfig) {
                pluginManager.toolApprovalManager.loadConfig();
            }
            res.json({ success: true, message: 'Tool approval config saved successfully.' });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error writing tool approval config:', error);
            res.status(500).json({ error: 'Failed to write tool approval config', details: error.message });
        }
    });

    router.get('/tool-approval-requests', async (req, res) => {
        try {
            const approvals = typeof pluginManager?.getPendingApprovalsSnapshot === 'function'
                ? pluginManager.getPendingApprovalsSnapshot()
                : [];
            res.json({ approvals });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error listing pending tool approvals:', error);
            res.status(500).json({ error: 'Failed to list pending tool approvals', details: error.message });
        }
    });

    router.post('/tool-approval-requests/:requestId', async (req, res) => {
        const { requestId } = req.params;
        const { approved } = req.body || {};

        if (typeof approved !== 'boolean') {
            return res.status(400).json({ error: 'Invalid request body. Expected { approved: boolean }.' });
        }

        try {
            const handled = pluginManager?.handleApprovalResponse?.(requestId, approved);
            if (!handled) {
                return res.status(404).json({ error: 'Approval request not found or already resolved.' });
            }
            res.json({
                success: true,
                message: approved ? 'Approval request approved.' : 'Approval request rejected.'
            });
        } catch (error) {
            console.error('[AdminPanelRoutes API] Error resolving pending tool approval:', error);
            res.status(500).json({ error: 'Failed to resolve tool approval request', details: error.message });
        }
    });

    router.get('/config/main', async (req, res) => {
        try {
            const configPath = path.join(__dirname, '..', '..', 'config.env');
            const content = await fs.readFile(configPath, 'utf-8');
            res.json({ content });
        } catch (error) {
            console.error('Error reading main config for admin panel:', error);
            res.status(500).json({ error: 'Failed to read main config file', details: error.message });
        }
    });

    router.get('/config/main/raw', async (req, res) => {
        try {
            const configPath = path.join(__dirname, '..', '..', 'config.env');
            const content = await fs.readFile(configPath, 'utf-8');
            res.json({ content });
        } catch (error) {
            console.error('Error reading raw main config for admin panel:', error);
            res.status(500).json({ error: 'Failed to read raw main config file', details: error.message });
        }
    });

    router.post('/config/main', async (req, res) => {
        const { content } = req.body;
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid content format. String expected.' });
        }

        try {
            const configPath = path.join(__dirname, '..', '..', 'config.env');
            await fs.writeFile(configPath, content, 'utf-8');

            if (typeof reloadMainConfig === 'function') {
                await reloadMainConfig();
            }
            if (typeof reloadPluginRuntime === 'function') {
                await reloadPluginRuntime('main-config-update');
            } else {
                await pluginManager.loadPlugins();
            }

            res.json({
                message: 'Main config saved. Runtime-facing settings were reloaded where possible; low-level settings such as PORT or vector-store internals still require a full restart.'
            });
        } catch (error) {
            console.error('Error writing main config for admin panel:', error);
            res.status(500).json({ error: 'Failed to write main config file', details: error.message });
        }
    });

    return router;
};
