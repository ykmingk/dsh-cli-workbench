/**
 * Codex 适配器：codex exec --json 的启动参数与事件解析。
 * 与 claude.js 一样，第一个参数是工作台实例。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { codexFailureText, humanImpact, contentToText, isAdvisoryMessage } from './format.js';
import { now, text, oneLine, realCwd, run, SANDBOX_MODES, idOf, clipText, json, decodeConsole } from './util.js';

/**
 * Windows 命令行参数：路径几乎一定带空格，一律加引号；引号本身去掉
 * （附件路径由 Host 拼出来，名字已经过滤过引号，这里再兜一层）。
 */
function quoteArg(value) {
    return '"' + String(value).replace(/"/g, '') + '"';
}

export async function startCodex(wb, session, content, seq, attachments = []) {
    const thread = session.codexThreadId;
    const sandbox = SANDBOX_MODES.has(session.sandboxMode) ? session.sandboxMode : 'workspace-write';
    // Codex 0.170 defaults the Windows backend to `disabled`, which makes every
    // sandboxed tier refuse to start commands. The probe decides whether a
    // `-c windows.sandbox="..."` override is needed on this machine.
    let backendOverride = null;
    if (sandbox !== 'bypass') {
      const state = await wb.codexSandbox().catch(() => null);
      backendOverride = state && state.override ? state.override : null;
    }
    if (!session._turnActive || seq !== session._turnSeq) return; // stopped or superseded meanwhile
    const parts = [];
    if (thread) {
      parts.push('codex exec resume ' + thread);
    } else {
      parts.push('codex exec');
    }
    parts.push('--json', '--skip-git-repo-check');
    if (!thread) parts.push('--color never');
    /* 图片走 Codex 自己的附件开关：`codex exec` 与 `exec resume` 都支持
       `-i/--image`。用 `--image=<path>` 的等号写法，避免变参把后面的参数吃掉。 */
    const images = attachments.filter((attachment) => attachment && attachment.kind === 'image' && attachment.path);
    for (const image of images) parts.push('--image=' + quoteArg(image.path));
    // `codex exec` is non-interactive: it has no channel to ask the user, so pin the
    // approval policy. Otherwise a user config with on-request would hang forever.
    parts.push('-c approval_policy="never"');
    if (backendOverride) parts.push('-c windows.sandbox="' + backendOverride + '"');
    if (sandbox === 'bypass') {
      // The UI label is Codex's own「完全访问」= danger-full-access, not the blunter
      // --dangerously-bypass flag: keep the sandbox wrapper, drop its restrictions.
      parts.push(thread ? '-c sandbox_mode="danger-full-access"' : '--sandbox danger-full-access');
    } else if (thread) {
      parts.push('-c sandbox_mode=' + sandbox);
    } else {
      parts.push('--sandbox ' + sandbox);
    }
    if (session.model) parts.push('--model ' + session.model.trim().split(/\s+/)[0]);
    parts.push('-');
    const child = spawn('cmd.exe', ['/d', '/s', '/c', parts.join(' ')], {
      cwd: realCwd(session.cwd),
      windowsHide: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    wb.procs.set(session.id, child);
    session._turnPhase = 'waiting';
    session._codexTurn = { completed: false, started: now() };
    let buffer = '';
    const errChunks = [];
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        try { wb.handleCodex(session, event); } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      errChunks.push(chunk);
      /* 与 claude.js 同样的尾部截断：解码统一放 close 时做，这里只控内存。 */
      let total = 0;
      for (const c of errChunks) total += c.length;
      if (total > 8192) errChunks.splice(0, errChunks.length - 1);
    });
    child.on('error', (error) => {
      wb.procs.delete(session.id);
      wb.failTurn(session, '启动', '无法启动 codex', String(error));
    });
    child.on('close', (code) => {
      if (wb.procs.get(session.id) === child) wb.procs.delete(session.id);
      if (session._turnActive && seq === session._turnSeq) {
        // cmd.exe 的 stderr 是 OEM 代码页（简中 = GBK），按 utf8 解出来是乱码
        const stderr = decodeConsole(Buffer.concat(errChunks));
        if (/(不是内部或外部命令|不是内部或外部的?程式|is not recognized as|无法将.*识别为|command not found)/i.test(stderr)) {
          wb.failTurn(session, '启动', '找不到 codex 命令',
            '系统找不到 codex 命令（PATH 里没有）。可能原因：CLI 只装在了另一个终端的 PATH 里、安装未完成、'
            + '或升级后 PATH 变了。请先在 PowerShell 里执行 codex --version 确认能用，再回到工作台。'
            + (stderr.trim() ? '原始输出：' + stderr.trim().slice(0, 160) : ''));
          return;
        }
        const sandboxHint = /CreateProcessAsUserW|CreateProcessWithLogonW|sandbox backend|blocked by policy/i.test(stderr)
          ? '\n\n提示：这类错误通常来自 Codex 的 Windows 沙箱后端未能启动。工作台会自动探测并追加 '
            + '-c windows.sandbox="unelevated"；如果仍失败，请改用「完全访问」，或在 Codex 配置 / 系统策略里启用沙箱。'
          : '';
        const detail = (stderr.trim() || ('codex 进程退出，退出码 ' + code)) + sandboxHint;
        wb.failTurn(session, '工具执行', '进程异常退出（code ' + code + '）', detail);
      }
    });
    try {
      child.stdin.end(content);
    } catch (error) {
      wb.failTurn(session, '输入', '无法写入 codex 输入', String(error));
    }
  }

export function handleCodex(wb, session, event) {
    const type = event.type;
    if (type === 'thread.started') {
      session.codexThreadId = event.thread_id || session.codexThreadId;
      wb.sessionEvent(session);
      wb.scheduleSave();
      return;
    }
    if (type === 'turn.started') return;
    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      wb.handleCodexItem(session, event.item || {}, type === 'item.completed');
      return;
    }
    if (type === 'turn.completed') {
      const usage = event.usage || {};
      const context = wb.codexRolloutContext(session.codexThreadId);
      session.usage = {
        input: Number(usage.input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
        cacheRead: Number(usage.cached_input_tokens) || 0,
        cacheWrite: Number(usage.cache_write_input_tokens) || 0,
        thinking: Number(usage.reasoning_output_tokens) || 0,
        costUsd: null,
        durationMs: session._codexTurn ? now() - session._codexTurn.started : 0,
        contextWindow: context ? context.contextWindow : 0,
        contextUsed: context ? context.contextUsed : 0,
        model: session.model,
        // Codex exec reports no per-step decode timing, so tokens/second stays
        // absent rather than being derived from wall time that includes tools.
        decodeMs: 0,
        ttftMs: null,
        turns: (Number(session._codexTurns) || 0) + 1,
        steps: Number(session._turnSteps) || 0,
      };
      session._turnActive = false;
      session._turnPhase = null;
      session.status = 'idle';
      session._codexTurns = (Number(session._codexTurns) || 0) + 1;
      wb.sessionEvent(session);
      wb.emit(session, { type: 'turn-end' });
      /* 有排队消息就接着发下一条（Host 判断） */
      wb.onTurnEnd(session);
      // rollout 文件是 CLI 边跑边写的：偶尔比 turn.completed 晚几毫秒落地。
      // 这一次没读到窗口就再补一次读取（读到就补播一次会话快照，不轮询）。
      if (!context && session.codexThreadId) {
        const key = session.codexThreadId;
        const timer = setTimeout(() => {
          if (session.codexThreadId !== key || !session.usage) return;
          if (Number(session.usage.contextWindow) > 0) return;
          const late = wb.codexRolloutContext(key);
          if (!late) return;
          session.usage.contextWindow = late.contextWindow;
          session.usage.contextUsed = late.contextUsed;
          wb.sessionEvent(session);
        }, 1200);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
      return;
    }
    if (type === 'turn.failed') {
      wb.failTurn(session, '工具执行', 'Codex 执行失败', text(event.error && event.error.message || event.message));
      return;
    }
    if (type === 'error') {
      /* 事件流的 error 与 item 的 error 同源：配置忽略警告也会从这里冒出来。
         它不是失败——归进右栏「运行提示」，别在对话里挂一张红色错误卡。 */
      const message = text(event.message);
      if (isAdvisoryMessage(message)) {
        session.advisories = [...(Array.isArray(session.advisories) ? session.advisories : []), { text: clipText(message, 400), at: now() }].slice(-8);
        wb.sessionEvent(session);
        return;
      }
      wb.push(session, { id: idOf('err'), kind: 'error', phase: 'CLI', category: 'Codex 报告错误', detail: message, at: now() });
    }
  }

export function handleCodexItem(wb, session, item, completed) {
    const id = text(item.id) || idOf('codexitem');
    const kind = text(item.type);
    const existing = session.items.find((entry) => entry.id === 'codex-' + id);
    if (kind === 'reasoning') {
      if (!completed || existing) return;
      wb.push(session, { id: 'codex-' + id, kind: 'thinking', text: text(item.text), at: now(), durationMs: 0, streaming: false });
      return;
    }
    if (kind === 'agent_message') {
      if (!completed) return;
      wb.push(session, { id: 'codex-' + id, kind: 'assistant', text: text(item.text), at: now(), streaming: false });
      return;
    }
    if (kind === 'command_execution') {
      if (!existing) {
        wb.push(session, {
          id: 'codex-' + id,
          kind: 'tool',
          toolId: id,
          name: 'Bash',
          input: { command: item.command },
          target: oneLine(item.command, 200),
          category: 'terminal',
          verb: '命令',
          status: item.status === 'completed' ? (item.exit_code === 0 ? 'done' : 'error') : 'running',
          startedAt: now(),
          at: now(),
          output: text(item.aggregated_output),
          isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          audit: true,
          diff: null,
          decision: null,
        });
        session._toolSteps = (Number(session._toolSteps) || 0) + 1;
      }
      if (completed || item.status === 'completed') {
        wb.patch(session, 'codex-' + id, {
          status: item.exit_code === 0 ? 'done' : 'error',
          output: text(item.aggregated_output),
          isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          endedAt: now(),
        });
      } else {
        wb.patch(session, 'codex-' + id, { output: text(item.aggregated_output) });
      }
      return;
    }
    if (kind === 'file_change') {
      if (!completed) return;
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((change) => text(change.path)).filter(Boolean);
      for (const change of changes) {
        const filePath = text(change.path);
        if (!filePath) continue;
        // Codex 的 file_change 只说「这个文件变了」，不给增删行数。
        // 原来按 kind 编了个 +1，删除还会被记成 +1 新增、removed 永远是 0。
        // 这里只如实记录变化种类，不编造行数（界面上只用文件数，不展示 ±N）。
        const kind = text(change.kind) || 'update';
        const existingFile = session.files.find((file) => file.path === filePath);
        if (existingFile) { existingFile.kind = kind; existingFile.at = now(); }
        else session.files.push({ path: filePath, kind, at: now() });
      }
      wb.push(session, {
        id: 'codex-' + id, kind: 'filechange', files: paths, status: item.status === 'completed' ? 'done' : 'running',
        at: now(), completed: true,
      });
      wb.sessionEvent(session);
      return;
    }
    if (kind === 'mcp_tool_call') {
      /* 失败时 Codex 把正文放在 item.error 里，result 是空的。以前只记了
         `isError: Boolean(item.error)`，等于把「为什么失败」丢掉了——界面上那张卡
         展开后只剩「没有更多诊断信息」。现在把 error.message / error 原文一起收。 */
      const failure = codexFailureText(item.error);
      if (!existing) {
        wb.push(session, {
          id: 'codex-' + id, kind: 'tool', toolId: id, name: text(item.tool) || 'MCP',
          input: item.arguments || {}, target: oneLine(item.tool, 120), category: 'wrench', verb: '工具',
          status: item.status === 'completed' ? (failure ? 'error' : 'done') : 'running',
          startedAt: now(), at: now(),
          output: contentToText(item.result),
          errorText: failure,
          isError: Boolean(failure), audit: true, diff: null, decision: null,
        });
      } else if (completed) {
        wb.patch(session, 'codex-' + id, {
          status: failure ? 'error' : 'done',
          output: contentToText(item.result) || (existing ? existing.output : ''),
          errorText: failure || (existing ? existing.errorText : ''),
          isError: Boolean(failure), endedAt: now(),
        });
      }
      return;
    }
    if (kind === 'error') {
      /* CLI 自己关于「实验性功能未启用完」之类的警告，不是这一轮失败了。
         它每轮都会出现，塞进对话里就变成一条红色错误卡，看起来像任务挂了。
         这类提示挪进右栏「运行提示」，会话状态不受影响。 */
      const message = text(item.message);
      if (isAdvisoryMessage(message)) {
        session.advisories = [...(Array.isArray(session.advisories) ? session.advisories : []), { text: clipText(message, 400), at: now() }].slice(-8);
        wb.sessionEvent(session);
        return;
      }
      wb.push(session, { id: idOf('err'), kind: 'error', phase: '工具执行', category: 'Codex 报告错误', detail: message, at: now() });
    }
  }

export function codexRolloutContext(wb, threadId) {
    const id = String(threadId || '').trim();
    if (!id) return null;
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (!home) return null;
    const root = path.join(home, '.codex', 'sessions');
    // Rollout 目录按日期分层：只翻今天和昨天，不做全盘扫描。
    const days = [];
    for (let offset = 0; offset < 2; offset += 1) {
      const day = new Date(Date.now() - offset * 86400000);
      const month = String(day.getMonth() + 1).padStart(2, '0');
      const date = String(day.getDate()).padStart(2, '0');
      days.push(path.join(root, String(day.getFullYear()), month, date));
    }
    for (const dir of days) {
      let names = [];
      try { names = readdirSync(dir); } catch { continue; }
      const hit = names.filter((name) => name.startsWith('rollout-') && name.endsWith('-' + id + '.jsonl'));
      if (!hit.length) continue;
      let body = '';
      try { body = readFileSync(path.join(dir, hit[hit.length - 1]), 'utf8'); } catch { return null; }
      const lines = body.split(/\r?\n/);
      // 从后往前找：最后一个带窗口大小的 token_count 就是当前占用。
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index] || lines[index].indexOf('model_context_window') < 0) continue;
        let entry = null;
        try { entry = JSON.parse(lines[index]); } catch { continue; }
        const payload = entry && entry.payload ? entry.payload : {};
        const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
        const window = Number(info.model_context_window) || Number(payload.model_context_window) || 0;
        if (!window) continue;
        const last = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : null;
        // 上下文占用看最后一次请求的输入侧 token（Codex 的 input_tokens 已含缓存命中部分）。
        const used = last ? (Number(last.input_tokens) || 0) : 0;
        return { contextWindow: window, contextUsed: used };
      }
      return null;
    }
    return null;
  }
