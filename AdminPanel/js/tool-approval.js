import { apiFetch, escapeHTML, showMessage } from './utils.js';

let approvalPollTimer = null;

function formatTimestamp(timestamp) {
    if (!timestamp) return '-';
    try {
        return new Date(timestamp).toLocaleString();
    } catch {
        return String(timestamp);
    }
}

function renderPendingApprovals(approvals) {
    const list = document.getElementById('tool-approval-pending-list');
    const emptyState = document.getElementById('tool-approval-empty');

    if (!list || !emptyState) return;

    list.innerHTML = '';

    if (!Array.isArray(approvals) || approvals.length === 0) {
        emptyState.style.display = '';
        return;
    }

    emptyState.style.display = 'none';

    approvals.forEach((approval) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.marginBottom = '16px';

        const argsText = escapeHTML(JSON.stringify(approval.args ?? {}, null, 2));
        const maidText = approval.maid ? escapeHTML(approval.maid) : '未指定';

        card.innerHTML = `
            <div class="config-item">
                <strong>${escapeHTML(approval.toolName || 'Unknown Tool')}</strong>
                <p class="aa-hint">请求 ID: ${escapeHTML(approval.requestId || '-')}</p>
                <p class="aa-hint">女仆 / Agent: ${maidText}</p>
                <p class="aa-hint">创建时间: ${escapeHTML(formatTimestamp(approval.createdAt))}</p>
                <p class="aa-hint">超时时间: ${escapeHTML(formatTimestamp(approval.expiresAt))}</p>
            </div>
            <div class="config-item">
                <label>调用参数</label>
                <pre style="white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto;">${argsText}</pre>
            </div>
            <div class="config-footer">
                <button type="button" class="btn-primary" data-approval-action="approve" data-request-id="${escapeHTML(approval.requestId || '')}">批准</button>
                <button type="button" class="btn-secondary" data-approval-action="reject" data-request-id="${escapeHTML(approval.requestId || '')}">拒绝</button>
            </div>
        `;

        list.appendChild(card);
    });
}

async function loadApprovalConfig({
    enabledInput,
    approveAllInput,
    timeoutInput,
    listInput
}) {
    const config = await apiFetch('/admin_api/tool-approval-config');
    enabledInput.checked = !!config.enabled;
    approveAllInput.checked = !!config.approveAll;
    timeoutInput.value = config.timeoutMinutes || 5;
    listInput.value = Array.isArray(config.approvalList) ? config.approvalList.join('\n') : '';
}

async function loadPendingApprovals() {
    const response = await apiFetch('/admin_api/tool-approval-requests', {}, false);
    renderPendingApprovals(response.approvals || []);
}

async function resolveApproval(requestId, approved) {
    await apiFetch('/admin_api/tool-approval-requests/' + encodeURIComponent(requestId), {
        method: 'POST',
        body: JSON.stringify({ approved })
    });
    showMessage(approved ? '工具调用已批准。' : '工具调用已拒绝。', 'success');
    await loadPendingApprovals();
}

export async function initializeToolApprovalManager() {
    const form = document.getElementById('tool-approval-config-form');
    const statusLabel = document.getElementById('tool-approval-status');
    const enabledInput = document.getElementById('tool-approval-enabled');
    const approveAllInput = document.getElementById('tool-approval-approve-all');
    const timeoutInput = document.getElementById('tool-approval-timeout');
    const listInput = document.getElementById('tool-approval-list');
    const pendingContainer = document.getElementById('tool-approval-pending-list');
    const refreshButton = document.getElementById('tool-approval-refresh');

    if (!form || !pendingContainer) return;

    try {
        await loadApprovalConfig({ enabledInput, approveAllInput, timeoutInput, listInput });
        await loadPendingApprovals();
    } catch (error) {
        console.error('[ToolApproval] Failed to initialize:', error);
        showMessage('加载工具审批数据失败: ' + error.message, 'error');
    }

    form.onsubmit = async (e) => {
        e.preventDefault();

        const newConfig = {
            enabled: enabledInput.checked,
            approveAll: approveAllInput.checked,
            timeoutMinutes: parseInt(timeoutInput.value, 10),
            approvalList: listInput.value.split('\n').map(s => s.trim()).filter(Boolean)
        };

        try {
            statusLabel.textContent = '正在保存...';
            await apiFetch('/admin_api/tool-approval-config', {
                method: 'POST',
                body: JSON.stringify({ config: newConfig })
            });
            statusLabel.textContent = '';
            showMessage('审批配置已保存。', 'success');
        } catch (error) {
            console.error('[ToolApproval] Failed to save config:', error);
            statusLabel.textContent = '保存失败';
        }
    };

    pendingContainer.onclick = async (event) => {
        const button = event.target.closest('button[data-approval-action]');
        if (!button) return;

        const requestId = button.dataset.requestId;
        const action = button.dataset.approvalAction;
        if (!requestId || !action) return;

        button.disabled = true;
        try {
            await resolveApproval(requestId, action === 'approve');
        } catch (error) {
            console.error('[ToolApproval] Failed to resolve request:', error);
            showMessage('处理审批请求失败: ' + error.message, 'error');
        } finally {
            button.disabled = false;
        }
    };

    if (refreshButton) {
        refreshButton.onclick = () => {
            loadPendingApprovals().catch(error => {
                console.error('[ToolApproval] Failed to refresh pending approvals:', error);
            });
        };
    }

    if (approvalPollTimer) {
        clearInterval(approvalPollTimer);
    }
    approvalPollTimer = setInterval(() => {
        const section = document.getElementById('tool-approval-manager-section');
        if (section && section.classList.contains('active-section')) {
            loadPendingApprovals().catch(error => {
                console.error('[ToolApproval] Failed to poll pending approvals:', error);
            });
        }
    }, 5000);
}
