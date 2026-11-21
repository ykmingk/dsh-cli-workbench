/**
 * MCP stdio permission-prompt tool for the CLI workbench.
 *
 * Claude Code is started with
 *   --permission-prompt-tool mcp__cliworkbench__approval_prompt
 * so every tool invocation that needs a decision calls this server. The server
 * forwards the request to the Host plugin, blocks until the user answers in the
 * workbench, and returns the decision in the SDK's permission-prompt shape.
 */
import { createInterface } from 'node:readline';

const endpoint = process.env.CLI_WB_ENDPOINT || '';
const token = process.env.CLI_WB_TOKEN || '';
const sessionId = process.env.CLI_WB_SESSION || '';
const PROTOCOL = '2025-06-18';

const write = (message) => {
  try {
    process.stdout.write(JSON.stringify(message) + '\n');
  } catch {
    /* the parent process is gone */
  }
};

const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

const TOOL = {
  name: 'approval_prompt',
  description: 'Ask the CLI workbench user to approve or deny one tool invocation.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'Name of the tool Claude wants to run.' },
      input: { type: 'object', description: 'Exact tool input.' },
      tool_use_id: { type: 'string', description: 'Identifier of the tool call.' },
    },
    required: ['tool_name', 'input'],
  },
};

/* 正在等用户决定的请求：id → { controller, toolUseId }。
   Claude 取消某个工具调用时会发 notifications/cancelled，必须同时撤掉 Host 侧的审批卡，
   否则那张卡会一直挂到 5 分钟超时，期间排在后面的审批也展示不出来。 */
const inFlight = new Map();
const CANCEL_ENDPOINT = endpoint.replace(/\/permission$/, '/permission/cancel');

function notifyCancel(sessionIdValue, toolUseId) {
  if (!CANCEL_ENDPOINT || CANCEL_ENDPOINT === endpoint) return;
  fetch(CANCEL_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cli-wb-token': token },
    body: JSON.stringify({ sessionId: sessionIdValue, toolUseId }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => { /* Host 不在也无所谓：审批会按超时自然作废 */ });
}

async function requestDecision(args, signal) {
  if (!endpoint || !token) {
    return { behavior: 'deny', message: '审批服务未配置，已自动拒绝。' };
  }
  let response;
  try {
    const timeout = AbortSignal.timeout(330000);
    const combined = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeout])
      : timeout;
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cli-wb-token': token },
      body: JSON.stringify({
        sessionId,
        toolName: String(args.tool_name || ''),
        input: args.input && typeof args.input === 'object' ? args.input : {},
        toolUseId: String(args.tool_use_id || ''),
      }),
      signal: combined,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return { behavior: 'deny', message: 'CLI 已取消这次工具调用。' };
    }
    return { behavior: 'deny', message: '审批请求失败：' + (error && error.name === 'TimeoutError' ? '等待超时' : String(error)) };
  }
  if (!response.ok) {
    return { behavior: 'deny', message: '审批服务返回 ' + response.status };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { behavior: 'deny', message: '审批服务返回了无法解析的结果。' };
  }
  if (!payload || typeof payload !== 'object' || (payload.behavior !== 'allow' && payload.behavior !== 'deny')) {
    return { behavior: 'deny', message: '审批结果无效，已自动拒绝。' };
  }
  if (payload.behavior === 'allow') {
    return { behavior: 'allow', updatedInput: payload.updatedInput || args.input || {} };
  }
  return { behavior: 'deny', message: String(payload.message || '用户拒绝了这次工具调用。') };
}

function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'cli-workbench-permission', version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'notifications/cancelled') {
    const requestId = params && (params.requestId ?? params.request_id);
    const entry = requestId !== undefined ? inFlight.get(requestId) : null;
    if (entry) {
      inFlight.delete(requestId);
      try { entry.controller.abort(); } catch { /* already settled */ }
      notifyCancel(sessionId, entry.toolUseId);
    }
    return;
  }
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: [TOOL] });
    return;
  }
  if (method === 'tools/call') {
    const args = (params && params.arguments) || {};
    const controller = new AbortController();
    const toolUseId = String(args.tool_use_id || '');
    if (id !== undefined && id !== null) inFlight.set(id, { controller, toolUseId });
    const settle = () => { if (id !== undefined && id !== null) inFlight.delete(id); };
    requestDecision(args, controller.signal).then(
      (decision) => { settle(); reply(id, { content: [{ type: 'text', text: JSON.stringify(decision) }] }); },
      (error) => {
        settle();
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: String(error) }) }],
          isError: true,
        });
      },
    );
    return;
  }
  if (method === 'server/discover') {
    // Optional pre-initialize hint from newer clients; initialize follows.
    return;
  }
  if (id !== undefined && id !== null) fail(id, -32601, 'method not found: ' + String(method));
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  try {
    handle(message);
  } catch (error) {
    if (message && message.id !== undefined) fail(message.id, -32603, String(error));
  }
});
process.stdin.on('end', () => process.exit(0));
