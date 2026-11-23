/**
 * Claude Code 适配器：启动参数与 stream-json 事件解析。
 *
 * 原先是 Workbench 的方法，签名改成 (wb, ...)：第一个参数就是工作台实例，
  * 内部照旧调用 wb.push / wb.patch / wb.emit。index.js 里留了一行委托方法，
 * 调用点完全没变。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { contentToText, isAdvisoryMessage, toolTarget, toolCategory, toolVerb, diffOf, humanImpact } from './format.js';
import { now, text, oneLine, realCwd, killTree, idOf, PERMISSION_MODES, API, json, decodeConsole } from './util.js';

/**
 * 一条用户消息的 content blocks。
 *
 * 图片必须内联成 Anthropic 的 image block（`claude --input-format stream-json`
 * 就是这么收图的），文件不内联——正文里给了落盘路径，CLI 自己用 Read 工具读，
 * 大文件不会一下把上下文撑爆。
 */
export function buildUserContent(content, attachments = []) {
    const blocks = [];
    const body = String(content == null ? '' : content).trim();
    if (body) blocks.push({ type: 'text', text: body });
    for (const attachment of attachments) {
      if (!attachment || attachment.kind !== 'image' || !attachment.path) continue;
      try {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mediaType,
            data: readFileSync(attachment.path).toString('base64'),
          },
        });
      } catch { /* 读不到就当没带：不能因为一个附件把整条消息卡死 */ }
    }
    if (!blocks.length) blocks.push({ type: 'text', text: body || '（附件）' });
    return blocks;
}

export function ensureClaude(wb, session) {
    const existing = wb.procs.get(session.id);
    if (existing && existing.exitCode == null) return existing;
    const token = randomBytes(16).toString('hex');
    session._mcpToken = token;
    const configPath = path.join(wb.mcpDir, session.id + '.mcp.json');
    const origin = wb.ctx.webServer.getOrigin();
    const config = {
      mcpServers: {
        cliworkbench: {
          command: process.execPath,
          args: [wb.mcpScript],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            CLI_WB_ENDPOINT: origin + API + '/permission',
            CLI_WB_TOKEN: token,
            CLI_WB_SESSION: session.id,
          },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const mode = PERMISSION_MODES.has(session.permissionMode) ? session.permissionMode : 'manual';
    const parts = [
      'claude -p',
      '--input-format stream-json',
      '--output-format stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode ' + mode,
      '--permission-prompts host',
      '--mcp-config ' + configPath,
      '--permission-prompt-tool mcp__cliworkbench__approval_prompt',
    ];
    if (session.claudeSessionId) parts.push('--resume ' + session.claudeSessionId);
    if (session.model) parts.push('--model ' + session.model.trim().split(/\s+/)[0]);
    const child = spawn('cmd.exe', ['/d', '/s', '/c', parts.join(' ')], {
      cwd: realCwd(session.cwd),
      windowsHide: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    wb.procs.set(session.id, child);
    // 进程已拉起，接下来是 CLI 读上下文、请求模型——这段通常比 spawn 本身更久。
    session._turnPhase = 'waiting';
    session._sawText = false;
    session._sawThinking = false;
    session._openText = null;
    session._openThink = null;
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        try { wb.handleClaude(session, event); } catch { /* one malformed event must not kill the turn */ }
      }
    });
    const errChunks = [];
    child.stderr.on('data', (chunk) => {
      errChunks.push(chunk);
      /* 只留尾部（解码统一放到 close 时做，避免每个数据块都全量解码）：
         长会话的 stderr 可能很大，但不能无限增长。 */
      let total = 0;
      for (const c of errChunks) total += c.length;
      if (total > 8192) errChunks.splice(0, errChunks.length - 1);
    });
    child.on('error', (error) => {
      wb.procs.delete(session.id);
      wb.failTurn(session, '启动', '无法启动 claude', String(error));
    });
    // 进程在「写入瞬间」退出时，往 stdin 写会先同步抛错、再异步发出 EPIPE/EOF。
    // 异步那半没有监听就是 uncaughtException —— Host 跑在 DSH 宿主进程里，等于整个
    // 应用崩溃。兜住它，让它走正常的回合失败路径。
    child.stdin.on('error', (error) => {
      if (wb.procs.get(session.id) === child) wb.procs.delete(session.id);
      if (session._turnActive) {
        wb.failTurn(session, '工具执行', 'CLI 进程已退出，消息未送达', String(error));
      }
    });
    child.on('close', (code) => {
      if (wb.procs.get(session.id) === child) wb.procs.delete(session.id);
      if (session._turnActive) {
        // cmd.exe 的 stderr 是 OEM 代码页（简中 = GBK），按 utf8 解出来是乱码
        let stderr = decodeConsole(Buffer.concat(errChunks));
        // 「命令不存在」是新手机器最高频的启动失败：把特征行翻译成人话 + 指路
        if (/(不是内部或外部命令|不是内部或外部的?程式|is not recognized as|无法将.*识别为|command not found)/i.test(stderr)) {
          stderr = '系统找不到 claude 命令（PATH 里没有）。可能原因：CLI 只装在了另一个终端的 PATH 里、'
            + '安装未完成、或升级后 PATH 变了。请先在 PowerShell 里执行 claude --version 确认能用，再回到工作台。'
            + (stderr.trim() ? '原始输出：' + stderr.trim().slice(0, 160) : '');
          wb.failTurn(session, '启动', '找不到 claude 命令', stderr);
          return;
        }
        const detail = stderr.trim() || ('claude 进程退出，退出码 ' + code);
        wb.failTurn(session, '工具执行', '进程异常退出（code ' + code + '）', detail);
      }
    });
    return child;
  }

export function handleClaude(wb, session, event) {
    const type = event.type;
    if (type === 'system') {
      if (event.subtype === 'init') {
        session.claudeSessionId = event.session_id || session.claudeSessionId;
        if (event.model && !session.model) session.model = event.model;
        wb.sessionEvent(session);
        wb.scheduleSave();
      } else if (event.subtype === 'thinking_tokens') {
        // 这个计数据历史遗留，两端都没有人读；留着一个每事件广播的活字段只会误导。
      } else if (event.subtype === 'error') {
        wb.push(session, {
          id: idOf('err'), kind: 'error', phase: 'CLI', category: 'CLI 报告错误',
          detail: text(event.error || event.message), at: now(),
        });
      }
      return;
    }
    if (type === 'stream_event') {
      wb.handleStreamEvent(session, event.event || {});
      return;
    }
    if (type === 'assistant') {
      const message = event.message || {};
      if (message.model) session.model = message.model;
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          const openId = session._textIds && session._textIds.shift();
          if (openId) {
            wb.patch(session, openId, { text: block.text, streaming: false });
          } else {
            wb.push(session, {
              id: idOf('asst'), kind: 'assistant', text: block.text, at: now(), streaming: false,
            });
          }
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          const duration = Number(event.thinking_duration_ms) || 0;
          const openId = session._thinkIds && session._thinkIds.shift();
          if (openId) {
            wb.patch(session, openId, { text: block.thinking, streaming: false, durationMs: duration });
          } else {
            wb.push(session, {
              id: idOf('think'), kind: 'thinking', text: block.thinking, durationMs: duration,
              at: now(), streaming: false,
            });
          }
        } else if (block.type === 'tool_use') {
          const item = {
            id: idOf('tool'),
            kind: 'tool',
            toolId: block.id,
            name: block.name || 'Tool',
            input: block.input && typeof block.input === 'object' ? block.input : {},
            target: toolTarget(block.name, block.input),
            category: toolCategory(block.name),
            verb: toolVerb(block.name),
            status: 'running',
            startedAt: now(),
            at: now(),
            diff: diffOf(block.name, block.input),
            output: '',
            isError: false,
          };
          wb.push(session, item);
          session._toolSteps = (Number(session._toolSteps) || 0) + 1;
          if (item.diff && item.diff.path) wb.noteFile(session, item.diff);
        }
      }
      return;
    }
    if (type === 'user') {
      const content = event.message && event.message.content;
      const metas = Array.isArray(event.tool_result_meta) ? event.tool_result_meta : [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || block.type !== 'tool_result') continue;
          const target = [...session.items].reverse().find((item) => item.kind === 'tool' && item.toolId === block.tool_use_id);
          if (!target) continue;
          const meta = metas.find((entry) => entry && entry.id === block.tool_use_id) || metas[0] || null;
          const decision = meta && meta.permission_decision ? meta.permission_decision : null;
          wb.patch(session, target.id, {
            status: block.is_error ? 'error' : 'done',
            isError: Boolean(block.is_error),
            output: contentToText(block.content),
            endedAt: now(),
            decision: decision ? { decision: decision.decision, source: decision.source, reason: decision.reason_type || '' } : null,
          });
        }
      }
      return;
    }
    if (type === 'result') {
      const usage = event.usage || {};
      const modelUsage = event.modelUsage || {};
      const modelKey = Object.keys(modelUsage)[0] || session.model;
      const contextWindow = modelKey && modelUsage[modelKey] ? Number(modelUsage[modelKey].contextWindow) || 0 : 0;
      const turn = session._turnTiming || null;
      session.usage = {
        input: Number(usage.input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
        cacheRead: Number(usage.cache_read_input_tokens) || 0,
        thinking: Number(usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
        durationMs: Number(event.duration_ms) || 0,
        contextWindow,
        contextUsed: (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0),
        model: modelKey || session.model,
        // Real decode wall time and first-token latency, measured from the stream
        // itself: tokens/second is only shown when this exists, never guessed.
        decodeMs: turn ? Math.round(turn.decodeMs) : 0,
        ttftMs: turn && turn.ttftMs != null ? Math.round(turn.ttftMs) : null,
        // 本轮序号 = 已完成的轮数 + 1（原来的写法在自增之前取值，第二轮起永远少 1）
        turns: (Number(session._turns) || 0) + 1,
        steps: Number(session._turnSteps) || 0,
      };
      session._turnActive = false;
      session._turnPhase = null;
      session.status = 'idle';
      session._turns = (Number(session._turns) || 0) + 1;
      wb.cancelApprovals(session, '本轮已结束，未处理的审批已取消。');
      wb.patchOpenStreaming(session);
      wb.sessionEvent(session);
      wb.scheduleReap(session);
      wb.emit(session, { type: 'turn-end' });
      return;
    }
    if (type === 'control_request') {
      return;
    }
  }

export function handleStreamEvent(wb, session, streamEvent) {
    const type = streamEvent.type;
    // Decode timing: accumulate only the spans where the model is actually
    // emitting (thinking + text blocks), so tokens/second excludes tool waits.
    if (!session._turnTiming) session._turnTiming = { decodeMs: 0, ttftMs: null, blockStart: null };
    const timing = session._turnTiming;
    if (type === 'message_start') {
      session._sawText = false;
      session._sawThinking = false;
      session._openText = null;
      session._openThink = null;
      session._textIds = [];
      session._thinkIds = [];
      // No TTFT: the CLI buffers message_start and the first content block into the
      // same tick, so any figure derived from them would be a fake 0ms.
      return;
    }
    if (type === 'content_block_start') {
      const block = streamEvent.content_block || {};
      timing.blockStart = Date.now();
      if (block.type === 'text') {
        session._sawText = true;
        const item = {
          id: idOf('asst'), kind: 'assistant', text: '', at: now(), streaming: true,
        };
        session._openText = item.id;
        session._textIds.push(item.id);
        wb.push(session, item);
      } else if (block.type === 'thinking') {
        session._sawThinking = true;
        const item = {
          id: idOf('think'), kind: 'thinking', text: '', at: now(), streaming: true, durationMs: 0,
        };
        session._openThink = item.id;
        session._thinkIds.push(item.id);
        wb.push(session, item);
      }
      return;
    }
    if (type === 'content_block_delta') {
      const delta = streamEvent.delta || {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (!session._openText) {
          const item = { id: idOf('asst'), kind: 'assistant', text: '', at: now(), streaming: true };
          session._openText = item.id;
          wb.push(session, item);
        }
        const item = session.items.find((entry) => entry.id === session._openText);
        if (item) { item.text += delta.text; wb.touch(session); }
        wb.queueDelta(session, session._openText, delta.text);
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        if (!session._openThink) {
          const item = { id: idOf('think'), kind: 'thinking', text: '', at: now(), streaming: true, durationMs: 0 };
          session._openThink = item.id;
          wb.push(session, item);
        }
        const item = session.items.find((entry) => entry.id === session._openThink);
        if (item) { item.text += delta.thinking; wb.touch(session); }
        wb.queueDelta(session, session._openThink, delta.thinking);
      }
      return;
    }
    if (type === 'content_block_stop') {
      if (timing.blockStart != null) {
        timing.decodeMs += Math.max(0, Date.now() - timing.blockStart);
        timing.blockStart = null;
      }
      if (session._openText) {
        wb.patch(session, session._openText, { streaming: false });
        session._openText = null;
      }
      if (session._openThink) {
        const item = session.items.find((entry) => entry.id === session._openThink);
        const duration = item ? now() - (item.at || now()) : 0;
        wb.patch(session, session._openThink, { streaming: false, durationMs: duration });
        session._openThink = null;
      }
    }
  }

export function patchOpenStreaming(wb, session) {
    if (session._openText) wb.patch(session, session._openText, { streaming: false });
    if (session._openThink) wb.patch(session, session._openThink, { streaming: false });
    session._openText = null;
    session._openThink = null;
  }
