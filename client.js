window.__ModuleLoader__.load({
  id: 'dsh-cli-workbench',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const API = '/cli-workbench/api';
    /* 输入框附件：与 Host 的附件白名单/上限保持一致，先在客户端拦一道，
       免得把一个 300MB 的文件读进内存再被服务端拒绝。 */
    const ATTACH_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const ATTACH_MAX_IMAGES = 10;
    const ATTACH_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const ATTACH_MAX_FILE_BYTES = 20 * 1024 * 1024;
    /* 与服务端同一套合计上限：条目按「图片 + 文件」一起数，体积只算真正上传的
       字节（路径引用不复制，不占额度）。先在添加/发送时拦住，别等 40MB 请求体
       上限把人挡回来。 */
    const ATTACH_MAX_ITEMS = 10;
    const ATTACH_MAX_TOTAL_BYTES = 24 * 1024 * 1024;
    /* 引用：一段引用最多 2000 字（超了截断并提示），插入草稿时用【】包起来，
   跟正文一起可编辑、可删除——不再在输入框上方堆 chip。 */
    const QUOTE_MAX_CHARS = 2000;
    const QUOTE_OPEN = '【';
    const QUOTE_CLOSE = '】';

    /**
     * 把一段引用按「【原文】」内联插进草稿，返回新草稿与插入后的光标位置。
     *
     * 纯函数，方便测试：quote 里的换行/连续空白压成一个空格（内联引用跨行不好读），
     * 光标两侧需要时补一个空格，避免和前后文粘在一起。
     */
    const insertQuoteText = (draft, quoteText, caret) => {
      const body = String(draft == null ? '' : draft);
      const flat = String(quoteText == null ? '' : quoteText).replace(/\s+/g, ' ').trim();
      if (!flat) return { text: body, caret: Math.max(0, Number(caret) || 0) };
      const marker = QUOTE_OPEN + flat + QUOTE_CLOSE;
      const limit = body.length;
      const at = Math.min(Math.max(0, Number.isFinite(Number(caret)) ? Number(caret) : limit), limit);
      const before = body.slice(0, at);
      const after = body.slice(at);
      const lead = before && !/\s$/.test(before) ? ' ' : '';
      const tail = after && !/^\s/.test(after) ? ' ' : '';
      return { text: before + lead + marker + tail + after, caret: before.length + lead.length + marker.length };
    };

    /**
     * 草稿 → 片段列表。输入框是 contenteditable：`【原文】` 会画成一枚内联引用块
     * （`“` + 单行截断的原文），其余是普通文字。
     */
    const parseDraft = (value) => {
      const source = String(value == null ? '' : value);
      const segments = [];
      const pattern = /【([^】]*)】/g;
      let cursor = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > cursor) segments.push({ type: 'text', text: source.slice(cursor, match.index) });
        segments.push({ type: 'quote', text: match[1] });
        cursor = match.index + match[0].length;
      }
      if (cursor < source.length) segments.push({ type: 'text', text: source.slice(cursor) });
      return segments;
    };

    /**
     * 编辑器 DOM → 草稿文本：引用块还原成 `【原文】`，`<br>` 还原成换行，
     * 浏览器自己塞进来的 `<div>` 块之间补换行。纯函数，测试里喂假节点也能跑。
     */
    const serializeEditor = (node) => {
      if (!node) return '';
      let out = '';
      const walk = (current) => {
        if (!current) return;
        if (current.nodeType === 3) { out += current.textContent || ''; return; }
        if (current.nodeType !== 1) return;
        const tag = String(current.tagName || '').toLowerCase();
        if (tag === 'br') { out += '\n'; return; }
        const quote = current.getAttribute ? current.getAttribute('data-quote') : null;
        if (quote != null) { out += QUOTE_OPEN + quote + QUOTE_CLOSE; return; }
        /* 浏览器自己塞进来的块（Enter 换行时常见）：块之间补一个换行 */
        if ((tag === 'div' || tag === 'p') && out && !/\n$/.test(out)) out += '\n';
        const children = current.childNodes ? Array.from(current.childNodes) : [];
        for (const child of children) walk(child);
      };
      const roots = node.childNodes ? Array.from(node.childNodes) : [];
      for (const child of roots) walk(child);
      return out;
    };

    /** 造一枚内联引用块（只在浏览器里有 document 时用到）。 */
    const createQuoteChip = (text) => {
      const chip = document.createElement('span');
      chip.className = 'cw-editor-quote';
      chip.setAttribute('contenteditable', 'false');
      chip.setAttribute('data-quote', text);
      chip.title = text;
      const mark = document.createElement('span');
      mark.className = 'cw-editor-quote-mark';
      mark.textContent = '\u201c';
      const body = document.createElement('span');
      body.className = 'cw-editor-quote-text';
      body.textContent = text;
      chip.appendChild(mark);
      chip.appendChild(body);
      return chip;
    };
    /**
     * 选区 → 浮动「引用」按钮的位置。
     *
     * 关键：**不要用包围盒中心**。多行选区的包围盒是「所有行并起来的大方块」，
     * 它的中心常常落在某一行右侧的空白里，按钮看起来就离文字很远（而且忽远忽近，
     * 因为每段选中文字的宽度分布不同）。
     *
     * 改成用 `getClientRects()` 的逐行矩形：
     *   - 纵向贴**第一行**的上沿（多行选区也是压在选区顶上，不遮住已选中的行）；
     *   - 横向贴**第一行的右沿**（那一行文字在哪结束，按钮就贴在哪）；
     *   - 上方放不下（选区接近视口顶）就翻到选区下面；
     *   - 最后夹进对话区，别飘到右栏上。
     *
     * 为什么不用「最右一行的右沿」：选区里有很长的一行时，按钮会被推到那片空白
     * 的正上方，离第一行文字很远——实测距离 30px，而贴第一行只有 6px。
     *
     * @param rects 选区的逐行矩形（getClientRects 的结果）
     * @param box 对话滚动区的矩形（可空：拿不到就按视口算）
     * @param viewportWidth 视口宽度（box 为空时的右边界）
     */
    const quoteButtonBox = (rects, box, viewportWidth) => {
      const list = (rects || []).filter((rect) => rect && (rect.width > 1 || rect.height > 1));
      if (!list.length) return null;
      const width = 68;
      const height = 28;
      const gap = 6;
      const first = list[0];
      const top = Math.min(...list.map((rect) => rect.top));
      const bottom = Math.max(...list.map((rect) => rect.bottom));
      const anchorRight = Number.isFinite(first.right) ? first.right : Math.max(...list.map((rect) => rect.right));
      const boundLeft = box && Number.isFinite(box.left) ? box.left : 0;
      const boundRight = box && Number.isFinite(box.right) ? box.right : (Number(viewportWidth) || 0);
      const boundTop = box && Number.isFinite(box.top) ? box.top : 0;
      const minX = boundLeft + 8;
      const maxX = Math.max(minX, boundRight - width - 8);
      /* 横向：贴第一行文字的右沿（那一行结束的地方），再夹进对话区。 */
      const x = Math.round(Math.min(Math.max(minX, anchorRight - width), maxX));
      /* 纵向：优先压在选区上方；上方不够就翻到下方。 */
      const above = top - gap - height;
      const fitsAbove = above >= boundTop + 4;
      return {
        x,
        y: Math.round(fitsAbove ? above : bottom + gap),
        placement: fitsAbove ? 'above' : 'below',
      };
    };

    const PROVIDERS = [
      { id: 'claude', label: 'Claude Code', short: 'CLAUDE' },
      { id: 'codex', label: 'Codex', short: 'CODEX' },
    ];
    const CLAUDE_MODES = [
      { id: 'plan', label: '计划', hint: '先给方案，不改文件' },
      { id: 'manual', label: '默认', hint: '每个动作都问' },
      { id: 'acceptEdits', label: '接受编辑', hint: '改文件不问，其它仍问' },
      { id: 'auto', label: '自动', hint: 'CLI 分类器判断，基本不问' },
      { id: 'bypassPermissions', label: '跳过', hint: '零询问，全部直接执行' },
    ];
    const CODEX_MODES = [
      { id: 'read-only', label: '只读', hint: '可读、可跑只读命令；写入被拒' },
      { id: 'workspace-write', label: '工作区写入', hint: '沙箱内读写工作区，系统其它位置被拒' },
      { id: 'bypass', label: '完全访问', hint: '跳过沙箱，命令与写文件都直接执行' },
    ];
        let layoutApi = null;
  /* DSH 的系统目录选择器。装了 native 后端时它会弹资源管理器；
     在部分装配（browse 后端）下没有 pick 能力，会抛错——那时回落到内建目录列表。 */
  let workspaceApi = null;
    /* 面板切走再切回来时组件会整个重挂载；上一次拿到的 /status 先顶上，
       免得会话列表已经回来了、状态灯还在「启动中」。 */
    const CACHE = { boot: null };

    const api = async (path, options) => {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...options,
      });
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) throw new Error((payload && (payload.error || payload.message)) || ('HTTP ' + response.status));
      return payload;
    };

    const basename = (p) => {
      if (!p) return '';
      const parts = String(p).split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] || p;
    };
    const fmtPath = (p) => {
      const value = String(p || '');
      if (value.length <= 34) return value;
      const sep = value.indexOf('\\') >= 0 ? '\\' : '/';
      const parts = value.split(sep).filter(Boolean);
      if (parts.length <= 2) return value;
      const head = value.charAt(0) === sep ? sep + parts[0] : parts[0];
      return head + sep + '…' + sep + parts[parts.length - 1];
    };
    const timeAgo = (ts) => {
      const diff = Date.now() - Number(ts || 0);
      if (!Number.isFinite(diff) || diff < 0) return '';
      if (diff < 60 * 1000) return '刚刚';
      if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
      if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
      if (diff < 48 * 60 * 60 * 1000) return '昨天';
      const date = new Date(Number(ts));
      return (date.getMonth() + 1) + '-' + date.getDate();
    };
    const fmtBytes = (n) => {
      const value = Number(n);
      if (!Number.isFinite(value)) return '—';
      if (value > 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
      if (value > 1024) return Math.round(value / 1024) + ' KB';
      return value + ' B';
    };
    /* 与 DSH 的 token-format 同规则：517 / 12.2K / 517K / 1.2M */
    const fmtTokens = (n) => {
      if (n == null || n === '') return '—';
      const value = Number(n);
      if (!Number.isFinite(value) || value < 0) return '—';
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10));
      if (value < 1000) return String(value);
      if (value < 1000000) return scaled(value / 1000) + 'K';
      return scaled(value / 1000000) + 'M';
    };
    const fmtExact = (n) => {
      const value = Number(n);
      if (!Number.isFinite(value)) return '—';
      return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    };
    /* 缓存命中率：没有 prompt 侧输入时返回 null（不编造 0%） */
    const cacheHitPercent = (usage) => {
      if (!usage) return null;
      const promptTokens = (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0);
      if (promptTokens <= 0) return null;
      const hit = Number(usage.cacheRead) || 0;
      if (hit >= promptTokens) return '100';
      const percent = hit / promptTokens * 100;
      // 部分命中绝不四舍五入成 100%
      if (percent >= 99.5) {
        let decimals = 1;
        while (Number(percent.toFixed(decimals)) >= 100 && decimals < 4) decimals += 1;
        return percent.toFixed(decimals);
      }
      return percent >= 10 ? String(Math.round(percent)) : percent.toFixed(1);
    };
    /* tokens/秒：只在 CLI 真的上报了解码耗时才算，不用墙钟时间含工具等待 */
    const tokensPerSecond = (usage) => {
      if (!usage) return null;
      const decodeMs = Number(usage.decodeMs) || 0;
      const output = Number(usage.output) || 0;
      if (decodeMs <= 0 || output <= 0) return null;
      const tps = output / (decodeMs / 1000);
      if (!Number.isFinite(tps) || tps <= 0) return null;
      return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
    };
    const fmtDuration = (ms) => {
      const value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return '';
      if (value < 1000) return Math.max(1, Math.round(value)) + 'ms';
      if (value < 60000) return (value / 1000).toFixed(1) + 's';
      return Math.floor(value / 60000) + 'm' + Math.round((value % 60000) / 1000) + 's';
    };
    const pretty = (value) => {
      try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { return String(value); }
    };
    const clip = (value, max = 120) => {
      const flat = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
      return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
    };
    /** 两个路径是否指同一个文件（大小写、分隔符都不同源的写法也算），跨盘符直接判否 */
    const pathEq = (left, right) => {
      const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const a = norm(left);
      const b = norm(right);
      return Boolean(a) && Boolean(b) && a === b;
    };
    const commandOf = (tool) => {
      if (!tool || !tool.input) return '';
      if (typeof tool.input.command === 'string') return tool.input.command;
      if (typeof tool.input.file_path === 'string') return tool.input.file_path;
      return pretty(tool.input);
    };
    const statusOf = (session) => {
      if (!session) return { key: 'idle', label: '等待输入' };
      if (session.status === 'running') {
        // 冷启动要好几秒，左栏这一格直接说清在等什么，别一律「运行中」
        if (session.turnPhase === 'spawn') return { key: 'running', label: '启动中' };
        if (session.turnPhase === 'waiting') return { key: 'running', label: '等响应' };
        return { key: 'running', label: '运行中' };
      }
      if (session.status === 'waiting') return { key: 'pending', label: '等待审批' };
      if (session.status === 'error') return { key: 'fail', label: '失败' };
      if (session.status === 'interrupted') return { key: 'fail', label: '已中断' };
      if (session.pending) return { key: 'pending', label: '等待审批' };
      if (session.itemCount > 0) return { key: 'done', label: '已完成' };
      return { key: 'idle', label: '等待输入' };
    };
    const providerMeta = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
    /* 本机是否真的能跑某个档位：由 Host 探测 `codex doctor` 的 sandbox backend 决定。
       backend 为 disabled 时，Host 会自动追加 `windows.sandbox` 覆盖；覆盖也失败时
       只读与工作区写入都无法真正执行命令。 */
    let codexSandboxState = null;
    const sandboxDeadReason = () => (codexSandboxState && codexSandboxState.detail)
      || '沙箱不可用，此档位无法执行命令。';
    const unusableMode = (provider, id) => {
      if (provider !== 'codex' || !codexSandboxState) return false;
      if (id === 'workspace-write') return codexSandboxState.workspaceWriteUsable === false;
      if (id === 'read-only') return codexSandboxState.readOnlyUsable === false;
      return false;
    };
    const sandboxHint = (mode) => {
      if (mode.id === 'workspace-write' && codexSandboxState && codexSandboxState.override) {
        return mode.hint + ' · 自动使用 ' + codexSandboxState.override;
      }
      return mode.hint;
    };
    const permissionLabel = (session) => {
      if (!session) return '';
      if (session.provider === 'codex') {
        const mode = CODEX_MODES.find((m) => m.id === session.sandboxMode) || CODEX_MODES[1];
        const note = unusableMode('codex', session.sandboxMode)
          ? ' · 本机无效'
          : (session.sandboxMode === 'workspace-write' && codexSandboxState && codexSandboxState.override
            ? ' · ' + codexSandboxState.override : '');
        return '沙箱：' + mode.label + note;
      }
      const mode = CLAUDE_MODES.find((m) => m.id === session.permissionMode) || CLAUDE_MODES[1];
      return '权限：' + mode.label;
    };
    const modeOptions = (session) => (session && session.provider === 'codex' ? CODEX_MODES : CLAUDE_MODES);
    const decisionLabel = (item) => {
      const decision = item && item.decision;
      if (!decision) return '';
      if (decision.decision === 'reject') return item.isError ? '已拒绝并跳过' : '已拒绝';
      if (decision.source === 'user_temporary') return '已允许 · 本次';
      if (decision.source === 'user_permanent') return '已允许 · 本会话';
      if (decision.source === 'config') return '已允许 · 配置规则';
      return '已允许';
    };
    const useTrap = (ref) => {
      useEffect(() => {
        const element = ref.current;
        if (!element) return undefined;
        const onKey = (event) => {
          if (event.key !== 'Tab') return;
          const focusable = element.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])');
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        element.addEventListener('keydown', onKey);
        return () => element.removeEventListener('keydown', onKey);
      }, [ref]);
    };

    const ICONS = {
      grid: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
      plus: '<path d="M8 3v10M3 8h10"/>',
      search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
      folder: '<path d="M2 4.5h4l1.5 2H14v7H2z"/>',
      folderOpen: '<path d="M2 12.5V4.5h4l1.5 2H13v2"/><path d="M2 12.5l1.8-4.5H15l-1.8 4.5z"/>',
      chev: '<path d="M6 3l5 5-5 5"/>',
      chevDown: '<path d="M3 6l5 5 5-5"/>',
      file: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
      wrench: '<path d="M10.5 3.5a3 3 0 00-4 4L3 11l2 2 3.5-3.5a3 3 0 004-4L11 7l-2-.5z"/>',
      terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 2-2 2M9 11h3"/>',
      check: '<path d="M3 8.5l3 3 7-7"/>',
      x: '<path d="M4 4l8 8M12 4l-8 8"/>',
      alert: '<path d="M8 2l6 11H2z"/><path d="M8 6v3M8 11h.01"/>',
      refresh: '<path d="M13 7a5 5 0 00-9-2L3 6M3 3v3h3M3 9a5 5 0 009 2l1-1M13 13v-3h-3"/>',
      brain: '<path d="M8 4a2 2 0 00-3.5-1.3A2 2 0 003 7a2 2 0 001 3.7A2 2 0 008 12M8 4a2 2 0 013.5-1.3A2 2 0 0113 7a2 2 0 00-1 3.7A2 2 0 018 12M8 4v8"/>',
      send: '<path d="M8 13V3"/><path d="M3.5 7.5L8 3l4.5 4.5"/>',
      stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
      at: '<circle cx="8" cy="8" r="2.5"/><path d="M10.5 8v1.5a2 2 0 004 0V8a6.5 6.5 0 10-2.5 5"/>',
      slash: '<path d="M10 3L6 13"/>',
      shield: '<path d="M8 2l5 2v4c0 3-2.5 5-5 6-2.5-1-5-3-5-6V4z"/>',
      clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
      /* token 用量用数据库图标（跟 DSH 一致），不用钱的符号——钱和 token 不是一回事 */
      coin: '<ellipse cx="8" cy="4.2" rx="5" ry="2.1"/><path d="M3 4.2v7.6c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1V4.2"/><path d="M3 8c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1"/>',
      /* 上下文占用：一个环形进度，颜色随占用率变（低=常态、高=警告），不只是一个「37%」 */
      gauge: '<path d="M3 12a6 6 0 1110 0"/><path d="M8 9l3-3"/>',
      ring: '<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4A5.6 5.6 0 0 1 8 13.6"/>',
      layers: '<path d="M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3"/>',
      panel: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M10 2.5v11"/>',
      task: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5 8l2 2 4-4"/>',
      image: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.8" cy="6" r="1.3"/><path d="M2.5 12l3.2-3.2 2.3 2.3 2-2 3.5 3.4"/>',
      /* 加号：DSH composer 的附件按钮用的就是这个 14px 描边十字 */
      plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
      globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
      back: '<path d="M9.5 3.5L5 8l4.5 4.5"/>',
      forward: '<path d="M6.5 3.5L11 8l-4.5 4.5"/>',
      save: '<path d="M8 2.5v7M5 7l3 3 3-3M3 12.5v1.5h10v-1.5"/>',
      external: '<path d="M9 3h4v4M13 3L7.5 8.5"/><path d="M12 9.5v3.5H3V4h3.5"/>',
      locate: '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>',
      tree: '<path d="M3 3v9M3 6h4M3 10h4M7 4.5h6M7 8.5h6"/>',
      settings: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><path d="M6 2.8v3.4M10.5 6.3v3.4M5 9.8v3.4"/>',
      archive: '<rect x="2" y="3" width="12" height="3" rx=".8"/><path d="M3 6v7h10V6M6.5 9h3"/>',
      restore: '<path d="M3 6a5.5 5.5 0 019.3-2L14 5.5M14 2v3.5h-3.5"/><path d="M13 10a5.5 5.5 0 01-9.3 2L2 10.5M2 14v-3.5h3.5"/>',
      trash: '<path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.5 7v4M9.5 7v4"/>',
      more: '<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>',
      pin: '<path d="M9.5 2l4.5 4.5-2 .5-2.5 2.5L8 13 6 8l-3-1 3-2.5 1.5-2.5z"/>',
      edit: '<path d="M11 3l2 2-7 7-2.5.5L4 10zM3 14h10"/>',
      copy: '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3h8"/>',
      /* 引用：两个描边引号，和 DSH 选区浮动按钮的语气一致 */
      quote: '<path d="M6.2 4.4H4.6A1.6 1.6 0 0 0 3 6v2.2a1.6 1.6 0 0 0 1.6 1.6h1.1v.7c0 .8-.5 1.4-1.3 1.7"/><path d="M12.7 4.4H11a1.6 1.6 0 0 0-1.6 1.6v2.2A1.6 1.6 0 0 0 11 9.8h1.1v.7c0 .8-.5 1.4-1.3 1.7"/>',
      sidebar: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>',
      sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/>',
      /* 技能：四角星 + 小星，和 DSH 的「插件」星形同一家族 */
      sparkles: '<path d="M6.2 2.2l1.1 2.9 2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9L2.2 6.2l2.9-1.1z"/><path d="M11.6 8.6l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z"/>',
      plan: '<path d="M4 3.5h8M4 8h8M4 12.5h5"/><path d="M2.2 3.5h.6M2.2 8h.6M2.2 12.5h.6"/>',
      /* 技能：锤子（截图里「技能」那一行是工具锤头，不是星星） */
      skill: '<path d="M6.1 4.6 8.4 2.3l5.3 5.3-2.3 2.3z"/><path d="M8.4 8.3l-5.9 5.9a1.35 1.35 0 0 0 1.9 1.9l5.9-5.9"/>',
      /* 计划：记事本 / 剪贴板（截图右下角那个「计划」就是这样） */
      clipboard: '<rect x="3.3" y="3" width="9.4" height="11" rx="1.8"/><path d="M6 3.2V2.3h4v.9"/><path d="M5.7 7h4.6M5.7 9.6h4.6M5.7 12.2h2.9"/>',
    };

    function Icon({ name, size = 16, className = '' }) {
      /* 尺寸必须真的落到 CSS 上：只用 width/height 属性会被 .cw-ic{width:16px}
         这类规则盖掉（属性和 CSS 打架时 CSS 赢），图标就永远是 16px。 */
      return h('svg', {
        className: 'cw-ic ' + className,
        width: size,
        height: size,
        style: { width: size + 'px', height: size + 'px' },
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.6',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: ICONS[name] || ICONS.grid },
      });
    }

    /**
     * 停止键的图形：实心圆角方块（跟 DSH 的停止图标同形——`.primary` 里就是
     * `<rect x=3 y=3 width=10 height=10 rx=3 fill="currentColor">`）。
     * Icon 画的是描边图标，这个必须实心，所以单独一个组件。
     */
    function StopGlyph({ size = 16 }) {
      return h('svg', {
        className: 'cw-ic',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        style: { width: size + 'px', height: size + 'px' },
        'aria-hidden': 'true',
      }, h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 3, fill: 'currentColor' }));
    }

    const CSS = String.raw`
.cw-root{
  /* —— 字体：直接使用 DSH 自己的字体栈与字号阶梯（11/12/13/14/16） —— */
  --cw-font: var(--dsw-font-family, "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif);
  --cw-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, "JetBrains Mono", Consolas, monospace);
  --cw-fs-micro: 11px;
  --cw-fs-xs: 12px;
  --cw-fs-sm: 13px;
  --cw-fs-base: 14px;
  --cw-fs-md: 14px;
  --cw-fs-lg: 16px;
  --cw-fw-normal: 400;
  --cw-fw-medium: 500;
  --cw-fw-bold: 600;
  --cw-lh-micro: 14px;
  --cw-lh-xs: 18px;
  --cw-lh-sm: 20px;
  --cw-lh-base: 22px;
  --cw-lh-lg: 24px;
  --cw-lh-tight: 1.4286;
  --cw-lh-body: 1.7143;
  /* —— 圆角/阴影：直接取 DSH token（8 / 12 / 16 / 20 / 28） —— */
  --cw-radius-sm: var(--dsw-radius-sm, 8px);
  --cw-radius-md: var(--dsw-radius-md, 12px);
  --cw-radius-lg: var(--dsw-radius-lg, 16px);
  --cw-radius-panel: var(--dsw-radius-panel, 28px);
  --cw-radius-pill: 999px;
  /* —— 颜色：全部走 DSH 语义 token，浅/深色自动跟随宿主 —— */
  --cw-bg: var(--dsw-alias-bg-layer-1);
  --cw-sub: var(--dsw-alias-bg-base);
  --cw-sidebar: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base));
  --cw-nav-active: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-active));
  --cw-module: var(--dsw-alias-bg-module-platform);
  --cw-input-bg: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1));
  --cw-bubble: var(--dsw-specific-bubble, var(--dsw-alias-bg-layer-2));
  --cw-code-bg: var(--dsw-alias-markdown-code-block);
  --cw-inline-code: var(--dsw-alias-markdown-inline-code);
  --cw-text: var(--dsw-alias-label-primary);
  --cw-muted: var(--dsw-alias-label-secondary);
  --cw-subtle: var(--dsw-alias-label-tertiary);
  --cw-placeholder: var(--dsw-alias-label-dimmed);
  --cw-border: var(--dsw-alias-border-l1);
  --cw-border-2: var(--dsw-alias-border-l2);
  --cw-border-3: var(--dsw-alias-border-l3);
  --cw-border-4: var(--dsw-alias-border-l4);
  --cw-hover: var(--dsw-alias-interactive-bg-hover);
  --cw-active: var(--dsw-alias-interactive-bg-active);
  --cw-fill: var(--dsw-alias-button-ghost-active-fill);
  --cw-menu-bg: var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));
  --cw-menu-blur: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  /* DSH 的 elevation token 在主题里运行时注入；带上同值 fallback，主题缺失也不会变成无阴影 */
  --cw-elev-soft: var(--dsw-elevation-soft, 0 0 0 .5px var(--dsw-alias-border-l3), 0 4px 16px 0 #00000008, 0 0 24px 0 #00000008);
  --cw-elev-panel: var(--dsw-elevation-panel, 0 0 0 .5px var(--dsw-alias-border-l3), 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005);
  --cw-elev-prominent: var(--dsw-elevation-prominent, 0 0 0 .5px var(--dsw-alias-border-l3), 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d);
  /* —— 语义色：与 DSH 同一套状态色，不再灰度化 —— */
  --cw-success: var(--dsw-alias-state-success-primary);
  --cw-warning: var(--dsw-alias-state-warn-primary);
  --cw-danger: var(--dsw-alias-state-error-primary);
  --cw-running: var(--dsw-alias-state-business-primary);
  /* Codex 用 DSH 的 violet 语义色（着色 / 完成态那一支），和 Claude 的蓝拉开色相；深色主题自动换 violet-400 */
  --cw-codex: var(--dsw-alias-state-done-primary);
  --cw-success-bg: color-mix(in srgb, var(--cw-success) 10%, transparent);
  --cw-warning-bg: color-mix(in srgb, var(--cw-warning) 10%, transparent);
  --cw-danger-bg: color-mix(in srgb, var(--cw-danger) 10%, transparent);
  --cw-running-bg: color-mix(in srgb, var(--cw-running) 10%, transparent);
  --cw-dot-running: var(--dsw-alias-state-business-primary);
  --cw-dot-pending: var(--dsw-alias-state-warn-primary);
  --cw-dot-done: var(--dsw-alias-state-success-primary);
  --cw-dot-fail: var(--dsw-alias-state-error-primary);
  --cw-dot-idle: var(--dsw-alias-state-idle-primary);
  --cw-accent: var(--dsw-alias-brand-primary);
  --cw-accent-hover: var(--dsw-alias-button-primary-hover);
  --cw-accent-soft: var(--dsw-alias-button-ghost-active-fill);
  --cw-accent-text: var(--dsw-alias-label-primary);
  --cw-on-accent: var(--dsw-alias-label-primary-foreground);
  /* 选中态：DSH 自己给强调型导航项用的浅蓝底 + 品牌蓝字（深色主题自动换成深灰底） */
  --cw-select-bg: var(--dsw-specific-sidebar-nav-item-active-accent, var(--dsw-alias-interactive-bg-active));
  --cw-select-ink: var(--dsw-alias-state-business-primary);
  --cw-send: var(--dsw-alias-button-info-fill);
  --cw-send-hover: var(--dsw-alias-button-info-hover);
  --cw-on-send: var(--dsw-alias-label-on-color);

  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--cw-bg);
  color: var(--cw-text);
  font-family: var(--cw-font);
  font-size: var(--cw-fs-base);
  line-height: var(--cw-lh-base);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
.cw-root *,.cw-root *::before,.cw-root *::after{ box-sizing: border-box; }
.cw-root :where(button){ font: inherit; color: inherit; background: none; border: none; padding: 0; cursor: pointer; }
.cw-root :where(button:disabled){ cursor: not-allowed; opacity: .45; }
.cw-root :where(input,textarea,select){ font: inherit; color: var(--cw-text); }
.cw-root ::placeholder{ color: var(--cw-placeholder); }
.cw-root :focus{ outline: none; }
.cw-root button:focus-visible,.cw-root [role="button"]:focus-visible{
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--cw-running));
  outline-offset: 2px;
}
.cw-ic{ flex: none; }

/* ============ 顶栏 ============ */
.cw-top{
  height: 44px; flex: none; display: flex; align-items: center;
  padding: 0 14px; gap: 12px;
  border-bottom: .5px solid var(--cw-border-2); background: var(--cw-bg);
}
.cw-brand{
  display: inline-flex; align-items: center; gap: 8px;
  font-size: var(--cw-fs-base); font-weight: var(--cw-fw-bold); letter-spacing: 0; white-space: nowrap;
}
.cw-logo{
  width: 20px; height: 20px; border-radius: 6px; background: var(--cw-accent);
  color: var(--cw-on-accent); display: inline-flex; align-items: center; justify-content: center;
}
.cw-logo .cw-ic{ width: 13px; height: 13px; stroke-width: 2; }
.cw-sep{ width: 1px; height: 18px; background: var(--cw-border-2); flex: none; }
.cw-providers{
  display: inline-flex; align-items: center; gap: 2px; padding: 2px;
  border-radius: 10px; background: var(--cw-module);
}
.cw-prov{
  position: relative; display: inline-flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 9px; border: 0; border-radius: 8px;
  color: var(--cw-muted); font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); white-space: nowrap;
}
.cw-prov:hover{ color: var(--cw-text); background: var(--cw-hover); }
.cw-prov.is-active{
  background: var(--cw-select-bg); color: var(--cw-select-ink); font-weight: var(--cw-fw-bold);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-select-ink) 28%, transparent);
}
.cw-prov.is-active:hover{ background: color-mix(in srgb, var(--cw-select-ink) 10%, var(--cw-select-bg)); }
/* 选中哪个助手，高亮就用哪个助手的色相：Claude = 品牌蓝，Codex = 紫。
   这样顶部的选中色和左栏会话标签是同一套语言，不会「标签紫、高亮蓝」。 */
.cw-prov.is-claude.is-active{
  --cw-accent-ink: var(--cw-running);
  background: color-mix(in srgb, var(--cw-accent-ink) 13%, transparent);
  color: var(--cw-accent-ink);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-accent-ink) 42%, transparent);
}
.cw-prov.is-codex.is-active{
  --cw-accent-ink: var(--cw-codex);
  background: color-mix(in srgb, var(--cw-accent-ink) 13%, transparent);
  color: var(--cw-accent-ink);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-accent-ink) 42%, transparent);
}
.cw-prov.is-active:hover{ background: color-mix(in srgb, var(--cw-accent-ink) 20%, transparent); }
.cw-prov .cw-ic{ width: 13px; height: 13px; }
.cw-prov.is-active .cw-ic{ color: inherit; }
.cw-badge{
  position: absolute; top: -5px; right: 0; min-width: 15px; height: 15px; padding: 0 3px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--cw-danger); color: var(--cw-on-send); border-radius: var(--cw-radius-pill);
  font-size: 9px; font-weight: var(--cw-fw-bold); line-height: 1; border: 1px solid var(--cw-bg);
}
.cw-prov.has-alert{ padding-right: 16px; }
.cw-top-right{ margin-left: auto; display: flex; align-items: center; gap: 8px; min-width: 0; }
.cw-path{
  display: inline-flex; align-items: center; gap: 6px; max-width: 290px; min-width: 0;
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle);
}
.cw-path span{
  font-family: var(--cw-mono); color: var(--cw-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cw-path:hover span{ color: var(--cw-text); }
.cw-ready{
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle);
}
.cw-ready .cw-dot{ width: 7px; height: 7px; border-radius: 50%; background: var(--cw-dot-done); flex: none; }
.cw-ready[data-state="starting"] .cw-dot{ background: var(--cw-dot-pending); animation: cw-pulse 1s infinite; }
.cw-ready[data-state="offline"] .cw-dot{ background: var(--cw-dot-fail); }
.cw-iconbtn{
  width: 28px; height: 28px; border-radius: var(--cw-radius-sm); border: 0;
  display: inline-flex; align-items: center; justify-content: center;
  position: relative; color: var(--cw-subtle);
}
.cw-iconbtn:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-iconbtn.is-on{
  background: var(--cw-fill); color: var(--cw-text);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border);
}
.cw-update-dot{
  position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--cw-danger); border: 1.5px solid var(--cw-bg); pointer-events: none;
}

/* 跨会话提醒条 */
.cw-notice{
  flex: none; display: flex; align-items: center; gap: 8px; margin: 0 14px 8px; padding: 8px 12px;
  border-radius: var(--cw-radius-md);
  background: var(--cw-warning-bg); color: var(--cw-text);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-warning) 45%, transparent);
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs);
}
.cw-notice .cw-ic{ width: 14px; height: 14px; color: var(--cw-warning); }
.cw-notice .cw-nt-text{ flex: 1; min-width: 0; }
.cw-notice .cw-nt-text b{ font-weight: var(--cw-fw-bold); }
.cw-notice button{
  height: 24px; padding: 0 9px; border-radius: var(--cw-radius-sm); font-size: var(--cw-fs-xs); font-weight: var(--cw-fw-medium);
  background: var(--cw-bg); color: var(--cw-text); border: 0; box-shadow: inset 0 0 0 .5px var(--cw-border-2);
}
.cw-notice button:hover{ background: var(--cw-hover); }
.cw-notice .cw-close{ width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; opacity: .7; }
.cw-notice .cw-close:hover{ opacity: 1; }

/* ============ 工作区 ============ */
.cw-main{ flex: 1; display: flex; min-height: 0; min-width: 0; position: relative; }

/* —— 左栏 —— */
.cw-rail{
  width: 250px; flex: none; display: flex; flex-direction: column; min-height: 0;
  background: var(--cw-sidebar); border-right: .5px solid var(--cw-border-2);
}
.cw-rail-head{ padding: 12px 12px 8px; }
.cw-rail-title-row{ display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.cw-rail-title{ font-size: var(--cw-fs-base); font-weight: var(--cw-fw-bold); line-height: var(--cw-lh-base); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 标题右侧唯一的动作：带字的小按钮，别做成一枚猜不出用途的图标 */
.cw-rail-add{
  flex: none; height: 24px; padding: 0 7px 0 5px; display: inline-flex; align-items: center; gap: 4px;
  border: 0; border-radius: var(--cw-radius-sm); background: transparent; color: var(--cw-subtle);
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); white-space: nowrap;
}
.cw-rail-add:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-rail-add .cw-ic{ width: 12px; height: 12px; }
.cw-search{
  height: 32px; display: flex; align-items: center; gap: 6px; padding: 0 9px;
  border: .5px solid var(--cw-border-4); border-radius: var(--cw-radius-sm); background: var(--cw-bg);
  color: var(--cw-subtle);
}
.cw-search:focus-within{ border-color: var(--cw-running); }
.cw-search input{ flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-size: var(--cw-fs-sm); }
.cw-search .cw-clear{ width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; }
.cw-search .cw-clear:hover{ background: var(--cw-hover); }
.cw-new{
  width: 100%; height: 34px; margin-top: 8px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border-radius: var(--cw-radius-md); border: 0;
  background: var(--cw-accent); color: var(--cw-on-accent);
  font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-sm);
}
.cw-new:hover{ background: var(--cw-accent-hover); }
.cw-list{ flex: 1; overflow-y: auto; padding: 4px 8px 12px; }
.cw-group{
  display: flex; align-items: center; gap: 5px; padding: 8px 6px;
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle);
  cursor: pointer; user-select: none; border-radius: var(--cw-radius-sm);
}
.cw-group:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-group .cw-caret{ transition: transform .15s; }
.cw-group.is-collapsed .cw-caret{ transform: rotate(-90deg); }
.cw-group.is-collapsed .cw-gcount{ opacity: .7; }
.cw-group .cw-gname{ flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-group .cw-gcount{
  font-size: var(--cw-fs-micro); line-height: 15px; color: var(--cw-muted); background: var(--cw-module);
  border-radius: var(--cw-radius-pill); padding: 0 6px; min-width: 16px; text-align: center;
}
/* DSH 的工作区行操作：与 DSH .rowActions 一致 —— opacity 0 / 不可点，行悬停或
   键盘聚焦时淡入；位置一直占着，悬停时右侧不跳。 */
.cw-group-actions{ display: inline-flex; align-items: center; gap: 6px; flex: none; opacity: 0; pointer-events: none; transition: opacity .1s var(--ds-ease-in-out, ease); }
.cw-group:hover .cw-group-actions,.cw-group:focus-within .cw-group-actions{ opacity: 1; pointer-events: auto; }
.cw-ga{
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--cw-radius-sm); color: var(--cw-subtle);
}
.cw-ga .cw-ic{ width: 13px; height: 13px; }
.cw-ga:hover{ color: var(--cw-text); background: var(--cw-active); }
.cw-ga.danger:hover{ color: var(--cw-danger); }
.cw-more{
  display: block; width: calc(100% - 12px); margin: 2px 6px 4px; padding: 5px 8px;
  border-radius: var(--cw-radius-sm); text-align: left; font-size: var(--cw-fs-xs); color: var(--cw-subtle);
}
.cw-more:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-sess{
  position: relative; display: block; width: 100%;
  border-radius: 10px; margin-bottom: 2px;
}
.cw-sess-open{ display: block; width: 100%; text-align: left; padding: 8px 9px; border-radius: 10px; }
.cw-sess:hover{ background: var(--cw-hover); }
.cw-sess.is-active{ background: var(--cw-nav-active); }
.cw-sess.is-pinned{ box-shadow: inset 2px 0 0 var(--cw-running); }
.cw-sess-top{ display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.cw-sess-title{
  flex: 1; min-width: 0; padding-right: 18px;
  font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-sm);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cw-sess.is-active .cw-sess-title{ font-weight: var(--cw-fw-bold); color: var(--cw-text); }
.cw-sess-meta{
  display: flex; align-items: center; gap: 8px; white-space: nowrap;
  font-size: var(--cw-fs-xs); color: var(--cw-subtle); line-height: var(--cw-lh-xs);
}
.cw-tag{
  display: inline-flex; align-items: center; gap: 3px;
  font-size: var(--cw-fs-micro); line-height: 1; padding: 3px 5px 3px 6px; border-radius: 6px;
  font-weight: var(--cw-fw-medium); letter-spacing: 0; flex: none;
}
.cw-tag .cw-ic{ width: 10px; height: 10px; }
/* 两个助手各用一个语义色，靠色相区分而不是靠深浅：Claude = 品牌蓝，
   Codex = 紫。色相不同、明度相当，在灰度里也还能靠图标分辨。 */
.cw-tag.claude{ background: color-mix(in srgb, var(--cw-running) 12%, transparent); color: var(--cw-running); }
.cw-tag.codex{ background: color-mix(in srgb, var(--cw-codex) 12%, transparent); color: var(--cw-codex); }
.cw-st{ display: inline-flex; align-items: center; gap: 4px; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); }
.cw-st .cw-sdot{ width: 6px; height: 6px; border-radius: 50%; flex: none; }
.cw-st.running{ color: var(--cw-dot-running); } .cw-st.running .cw-sdot{ background: var(--cw-dot-running); animation: cw-pulse 1.5s infinite; }
.cw-st.pending{ color: var(--cw-dot-pending); } .cw-st.pending .cw-sdot{ background: var(--cw-dot-pending); }
.cw-st.done{ color: var(--cw-dot-done); } .cw-st.done .cw-sdot{ background: var(--cw-dot-done); }
.cw-st.fail{ color: var(--cw-dot-fail); } .cw-st.fail .cw-sdot{ background: var(--cw-dot-fail); }
.cw-st.idle{ color: var(--cw-subtle); } .cw-st.idle .cw-sdot{ background: var(--cw-dot-idle); }
.cw-sess-more{
  position: absolute; right: 6px; top: 7px; width: 22px; height: 22px; border-radius: 6px;
  display: none; align-items: center; justify-content: center; color: var(--cw-subtle); z-index: 2;
}
.cw-sess:hover .cw-sess-more,.cw-sess.is-active .cw-sess-more{ display: inline-flex; }
.cw-sess-more:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-sess-check{ position: absolute; left: 8px; top: 11px; width: 14px; height: 14px; accent-color: var(--cw-running); cursor: pointer; z-index: 2; }
.cw-rail.batch .cw-sess-open{ padding-left: 29px; }
/* 批量模式：点整行就是打钩，勾中的行整行染色，不用再瞄那个 14px 小方框 */
.cw-rail.batch .cw-sess{ cursor: pointer; }
.cw-rail.batch .cw-sess.is-checked{ background: var(--cw-fill); box-shadow: inset 0 0 0 .5px var(--dsw-alias-button-ghost-active-border); }
.cw-rail.batch .cw-sess.is-checked .cw-sess-title{ color: var(--cw-text); }
.cw-gicon{ flex: none; color: var(--cw-subtle); }
.cw-rail-foot{
  padding: 10px 12px; border-top: .5px solid var(--cw-border);
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle); display: flex; align-items: center; gap: 6px;
}
.cw-batch{ display: flex; align-items: center; gap: 6px; padding: 8px; border-top: .5px solid var(--cw-border); background: var(--cw-bg); }
.cw-batch .cw-bcount{ flex: 1; font-size: var(--cw-fs-xs); color: var(--cw-subtle); white-space: nowrap; }
.cw-batch button{ height: 26px; padding: 0 9px; border: 0; border-radius: var(--cw-radius-sm); box-shadow: inset 0 0 0 .5px var(--cw-border-2); font-size: var(--cw-fs-xs); white-space: nowrap; }
.cw-batch button:hover{ background: var(--cw-hover); }
.cw-batch button.danger{ color: var(--cw-danger); }
.cw-empty-search{ font-size: var(--cw-fs-xs); color: var(--cw-subtle); text-align: center; padding: 22px 8px; line-height: var(--cw-lh-xs); }

/* —— 中栏：对话 —— */
.cw-conv{ flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--cw-bg); }
/* 滚动区只负责滚动；轮次条与「最新」按钮挂在它外面的 .cw-viewport 上，
   所以不会跟着内容滚走（这两者也不参与 flex 布局）。 */
.cw-viewport > .cw-turns,
.cw-viewport > .cw-tolatest{ flex: none; }
.cw-conv-head{
  position: relative; height: 48px; flex: none; border-bottom: .5px solid var(--cw-border);
  display: flex; align-items: center; padding: 0 18px; gap: 10px;
}
.cw-conv-title{
  min-width: 0; max-width: 52%; font-size: var(--cw-fs-base); font-weight: var(--cw-fw-bold); line-height: var(--cw-lh-base);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cw-mode{
  margin-left: auto; display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 8px;
  max-width: min(340px, 48vw); min-width: 0;
  border: 0; border-radius: var(--cw-radius-sm);
  font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); color: var(--cw-muted); white-space: nowrap;
}
.cw-mode > span{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-mode:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-mode.is-open{ background: var(--cw-fill); color: var(--cw-text); }
.cw-mode .cw-ic{ width: 13px; height: 13px; }
.cw-await{
  display: flex; align-items: center; gap: 8px; padding: 8px 18px;
  border-bottom: .5px solid var(--cw-border); background: var(--cw-warning-bg);
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs);
}
.cw-await .cw-ic{ width: 13px; height: 13px; color: var(--cw-warning); }
.cw-await button{
  margin-left: auto; height: 24px; padding: 0 9px; border: 0; border-radius: var(--cw-radius-sm);
  box-shadow: inset 0 0 0 .5px var(--cw-border-2); font-size: var(--cw-fs-xs); white-space: nowrap;
}
.cw-await button:hover{ background: var(--cw-hover); }
/* 定位层：占满中栏剩余高度，内部才是真正滚动的 .cw-scroll。
   「回到最新」和轮次条都挂在这一层，所以永远钉在右下角，不会被内容带着走。 */
.cw-viewport{ position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* SSE 断线提示：出现即代表界面数据可能滞后，重连成功自动消失 */
.cw-offline{
  display: flex; align-items: center; gap: 8px; flex: none;
  padding: 6px 14px; font-size: var(--cw-fs-xs); color: var(--cw-subtle);
  background: var(--cw-hover); box-shadow: inset 0 -0.5px 0 var(--cw-border);
}
/* 行内链接（助手输出里的 markdown 链接） */
.inline-link{ color: var(--cw-running); text-decoration: none; border-bottom: .5px solid currentColor; }
.inline-link:hover{ opacity: .8; }
/* 错误边界的降级面板：整块面板渲染失败时顶上来，至少给出原因和一条出路 */
.cw-fatal{
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  height: 100%; padding: 32px; text-align: center; color: var(--cw-text);
}
.cw-fatal-title{ font-size: var(--cw-fs-lg, var(--cw-fs-base)); font-weight: var(--cw-fw-medium); }
.cw-fatal-note{ max-width: 520px; font-size: var(--cw-fs-xs); line-height: 1.7; color: var(--cw-subtle); word-break: break-word; }
.cw-scroll{ flex: 1; min-height: 0; overflow-y: auto; padding: 22px 26px 10px; }

/* —— 轮次条：会话右侧的短横刻度，悬停看那条消息，点一下跳过去 ——
   与 DSH 的 TurnNavigator 同一套语言：绝对定位贴着滚动区右缘，不占布局宽度。 */
.cw-turns{
  position: absolute; right: 0; top: 0; bottom: 0; width: 26px; z-index: 6;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  pointer-events: none;
}
.cw-turns-marks{
  display: flex; flex-direction: column; gap: 5px; align-items: flex-end;
  width: 100%; max-height: 62%; padding: 8px 6px 8px 0; overflow: hidden;
  mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
  pointer-events: auto;
}
.cw-turns-mark{
  width: 18px; height: 3px; padding: 0; border: 0; border-radius: 2px; flex: 0 0 auto;
  align-self: flex-end; background: var(--cw-border-3); cursor: pointer;
  transform-origin: right center; transform: scaleX(.62);
  transition: transform 140ms ease, background-color 140ms ease;
  position: relative;
}
.cw-turns-mark:hover,
.cw-turns-mark.is-hover{ transform: scaleX(.95); background: var(--cw-subtle); }
.cw-turns-mark.is-active{ transform: scaleX(1); background: var(--cw-accent-ink, var(--cw-running)); }
/* 预览卡挂在刻度自己身上（right: 100%），这样它贴着滚动区右缘展开，
   不会被 26px 宽的容器裁掉。 */
.cw-turns-preview{
  position: absolute; right: 100%; margin-right: 10px; top: 50%; transform: translateY(-50%);
  width: 272px; max-height: 132px; overflow: hidden; text-align: left;
  display: flex; flex-direction: column; gap: 4px; padding: 10px 12px;
  border-radius: var(--cw-radius-lg); background: var(--cw-menu-bg);
  backdrop-filter: var(--cw-menu-blur); box-shadow: var(--cw-elev-panel);
  pointer-events: none; z-index: 9;
}
.cw-turns-head{ display: flex; align-items: center; gap: 6px; font-size: var(--cw-fs-micro); color: var(--cw-subtle); }
.cw-turns-text{
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-sm); color: var(--cw-text);
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  word-break: break-word;
}
.cw-turns-tip{ font-size: var(--cw-fs-micro); color: var(--cw-subtle); }

/* —— 回到最新：右下角悬浮按钮（参考 DSH 的回到底部）——
   只有一个箭头：位置本身就说明了它是「回到底部」，不再挂「最新」两个字。 */
.cw-tolatest{
  position: absolute; right: 16px; bottom: 14px; z-index: 7;
  display: grid; place-items: center; width: 30px; height: 30px; padding: 0;
  border-radius: var(--cw-radius-pill);
  color: var(--cw-text); background: var(--cw-menu-bg); backdrop-filter: var(--cw-menu-blur);
  box-shadow: var(--cw-elev-prominent); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
}
/* 悬停不能退成 8% 的 --cw-hover：这颗浮在正文上，退成半透明就等于「消失」 */
.cw-tolatest:hover{ background: var(--dsw-alias-button-floating-hover, var(--cw-menu-bg)); }
.cw-tolatest .cw-ic{ width: 15px; height: 15px; }
.cw-page{ max-width: 860px; margin: 0 auto; }

/* —— 运行状态行：贴在对话末尾（DSH 就是把「正在做什么」放在正文最后一行），
   不是输入框上方的一条状态条——那里是 DSH 放任务清单的位置。 —— */
.cw-runningline{
  display: flex; align-items: center; gap: 8px;
  margin: 4px 0 14px; padding: 0 2px;
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle);
}
.cw-runningline .cw-ic{ width: 13px; height: 13px; color: var(--cw-running); flex: none; }
.cw-runningline .cw-spin{ width: 13px; height: 13px; flex: none; }
.cw-runningline-text{ flex: none; font-weight: var(--cw-fw-medium); color: var(--cw-text); }
.cw-runningline-note{
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--cw-mono); font-size: var(--cw-fs-micro);
}
.cw-runningline-time{ flex: none; font-variant-numeric: tabular-nums; }

/* 消息 */
.cw-msg{ margin-bottom: 18px; max-width: 860px; }
.cw-msg-user{ margin-left: auto; text-align: right; }
.cw-msg-label{
  display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle);
}
.cw-msg-user .cw-msg-label{ justify-content: flex-end; }
/* 已发出消息的「复制 / 修改」：平时藏着，悬停这条消息（或键盘聚焦）才出现。
   放在时间戳左边而不是气泡里，正文选中复制时不会误点。 */
.cw-msg-acts{ display: inline-flex; align-items: center; gap: 2px; margin-right: 2px; opacity: 0; transition: opacity .12s; }
.cw-msg:hover .cw-msg-acts, .cw-msg-acts:focus-within{ opacity: 1; }
.cw-msg-acts button{
  width: 20px; height: 20px; border: 0; border-radius: 4px; background: transparent;
  display: inline-flex; align-items: center; justify-content: center; color: var(--cw-subtle);
}
.cw-msg-acts button:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-msg-acts .cw-ic{ width: 12px; height: 12px; }
.cw-bubble-user{
  display: inline-block; text-align: left;
  padding: 10px 16px;
  background: var(--cw-bubble); color: var(--cw-text);
  border-radius: var(--dsw-radius-xl, 20px);
  max-width: 660px;
  font-size: var(--cw-fs-base); line-height: var(--cw-lh-base);
  white-space: pre-wrap; word-break: break-word;
}
/* 引用的原文：进消息后以引用块呈现（左侧竖线 + 弱化色），其余仍是纯文本。
   只认行首的「> 」——不给用户气泡上完整 Markdown，免得用户写的 * 变成斜体。
   注意：这段 CSS 在 String.raw 模板里，注释里不能写反引号或美元花括号，否则模板会被提前截断。 */
.cw-quote-block{
  margin: 0 0 8px; padding: 1px 0 1px 10px;
  border-left: 2px solid var(--cw-border-4, var(--cw-border-2));
  color: var(--cw-muted);
}
.cw-quote-block:last-child{ margin-bottom: 0; }
.cw-quote-line{ white-space: pre-wrap; }
.cw-plain-block{ white-space: pre-wrap; }
/* 选区浮动按钮：定位用视口坐标（getBoundingClientRect），所以是 fixed。 */
.cw-quotebtn{
  position: fixed; z-index: 96; height: 28px; padding: 0 9px 0 7px;
  display: inline-flex; align-items: center; gap: 4px;
  border: .5px solid var(--cw-border-2); border-radius: var(--cw-radius-sm);
  /* 必须是不透明底：按钮浮在正文上，--cw-hover 那种半透明 token 会让后面的
     文字透出来（鼠标移上去像「变透明」）。DSH 那颗也是实心白底。 */
  background: var(--dsw-alias-bg-layer-1, var(--cw-bg)); color: var(--cw-text);
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); white-space: nowrap;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .18);
}
/* 悬停/按下都用 -solid 版（不透明）：普通 -hover / -active 是 8%~10% 透明度的
   叠加色，浮在正文上时会让文字透出来。 */
.cw-quotebtn:hover, .cw-quotebtn:active{ background: var(--dsw-alias-interactive-bg-hover-solid, var(--cw-sub)); }
.cw-quotebtn .cw-ic{ width: 12px; height: 12px; color: var(--cw-subtle); }
/* 内联引用：草稿里就是【原文】这串文字（跟正文一起可编辑），所以样式只出现在
   发出去的气泡里——浅底 + 左侧竖线 + 弱化色，和输入框里看到的形状对得上。 */
.cw-quote-inline{
  color: var(--cw-muted);
  background: var(--cw-hover);
  border-left: 2px solid var(--cw-border-4, var(--cw-border-2));
  border-radius: 3px;
  padding: 0 4px 0 5px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
/* 用户消息里的附件：图片直接给缩略图（Host 的 /attachment 端点回放），
   文件给一枚小胶囊。都靠右，和气泡同一列。 */
.cw-msg-atts{ display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; margin-bottom: 6px; }
.cw-msg-att-img{
  width: 120px; height: 120px; object-fit: cover; border-radius: var(--cw-radius-md);
  border: .5px solid var(--cw-border-2); background: var(--cw-hover);
}
.cw-msg-att-file{
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border-radius: var(--cw-radius-pill); background: var(--cw-hover);
  color: var(--cw-muted); font-size: var(--cw-fs-xs);
}
.cw-msg-att-file .cw-ic{ width: 14px; height: 14px; color: var(--cw-subtle); }
.cw-assist{
  font-size: var(--cw-fs-base); line-height: var(--cw-lh-body);
  color: var(--cw-text); word-break: break-word;
}
.cw-assist p{ margin: 0 0 8px; }
.cw-assist p:last-child{ margin-bottom: 0; }
/* 标题 / 列表 / 引用 / 分隔线：md 文档在右栏能像文档一样读，而不是一堆 # 和 - */
.cw-md-h{ margin: 14px 0 8px; font-weight: var(--cw-fw-bold); line-height: 1.4; color: var(--cw-text); }
.cw-md-h:first-child{ margin-top: 0; }
.cw-md-h1{ font-size: 19px; }
.cw-md-h2{ font-size: 16px; }
.cw-md-h3{ font-size: 14px; }
.cw-md-h4{ font-size: var(--cw-fs-base); color: var(--cw-muted); }
.cw-md-list{ margin: 6px 0 10px; padding-left: 20px; }
.cw-md-list li{ margin: 3px 0; line-height: var(--cw-lh-body); }
.cw-md-quote{
  margin: 8px 0; padding: 2px 0 2px 10px; border-left: 2px solid var(--cw-border-3);
  color: var(--cw-muted); font-size: var(--cw-fs-sm); line-height: 1.7;
}
.cw-md-hr{ margin: 14px 0; border: 0; border-top: .5px solid var(--cw-border-2); }
.cw-md-p{ margin: 0 0 8px; }
.cw-md-p:last-child{ margin-bottom: 0; }
.cw-assist pre{
  margin: 8px 0; padding: 10px 12px; border: 0;
  border-radius: var(--cw-radius-sm); background: var(--cw-code-bg);
  overflow-x: auto; font-family: var(--cw-mono); font-size: var(--cw-fs-xs); line-height: 1.6;
}
.cw-assist code.inline,.cw-inline-code{
  font-family: var(--cw-mono); font-size: var(--cw-fs-xs);
  background: var(--cw-inline-code); border: 0; border-radius: 4px; padding: 1px 5px;
}
.cw-cursor{ display: inline-block; width: 2px; height: 14px; background: var(--cw-running); vertical-align: -2px; margin-left: 2px; animation: cw-blink 1s steps(2,start) infinite; }

/* 轻量思考行 */
.cw-thinkline{
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle); margin: 0 0 10px;
}
.cw-thinkline:hover{ color: var(--cw-muted); }
.cw-thinkline .cw-ic{ width: 13px; height: 13px; }
.cw-think-note{
  font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); color: var(--cw-subtle);
  margin: 0 0 12px; padding: 8px 12px; border-left: 0; border-radius: var(--cw-radius-sm);
  background: var(--cw-sub); white-space: pre-wrap;
}

/* 过程折叠卡 */
.cw-proc{
  max-width: 760px; margin: 4px 0 14px;
  border-radius: var(--cw-radius-md); background: var(--cw-bg);
  box-shadow: var(--cw-elev-soft); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
  overflow: hidden;
}
.cw-proc-head{
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 10px 12px; font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm);
}
.cw-proc-head:hover{ background: var(--cw-hover); }
.cw-proc-badge{ width: 20px; height: 20px; flex: none; border-radius: 6px; background: var(--cw-module); display: flex; align-items: center; justify-content: center; }
.cw-proc-badge .cw-ic{ width: 12px; height: 12px; }
.cw-proc-summary{ font-weight: var(--cw-fw-medium); }
.cw-proc-count{ font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle); }
.cw-proc-chev{ margin-left: auto; color: var(--cw-subtle); transition: transform .18s; }
.cw-proc.is-open .cw-proc-chev{ transform: rotate(90deg); }
.cw-proc-body{ border-top: .5px solid var(--cw-border); padding: 4px 10px 8px; }
.cw-step{ display: flex; align-items: center; gap: 8px; padding: 8px 4px; border-bottom: .5px solid var(--cw-border); font-size: var(--cw-fs-sm); }
.cw-step:last-of-type{ border-bottom: none; }
.cw-step-ic{ width: 20px; height: 20px; flex: none; border-radius: 6px; background: var(--cw-module); display: flex; align-items: center; justify-content: center; color: var(--cw-subtle); }
.cw-step-ic .cw-ic{ width: 12px; height: 12px; }
.cw-step-name{ font-weight: var(--cw-fw-medium); flex: none; }
.cw-step-target{
  color: var(--cw-subtle); font-family: var(--cw-mono); font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 330px;
}
.cw-step-status{
  margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle); white-space: nowrap;
}
.cw-step-status.done{ color: var(--cw-success); }
.cw-step-status.error{ color: var(--cw-danger); }
.cw-step-status.run{ color: var(--cw-running); }
.cw-spin{ width: 12px; height: 12px; border: 1.5px solid var(--cw-running); border-top-color: transparent; border-radius: 50%; animation: cw-spin .8s linear infinite; }
/* 等待阶段的呼吸圆点：比转圈安静，且不暗示进度（这几秒的时长本来就不可预测） */
.cw-pulse{
  width: 8px; height: 8px; flex: none; border-radius: 50%;
  background: var(--cw-running); animation: cw-pulse 1.25s ease-in-out infinite;
}
@keyframes cw-pulse{
  0%, 100%{ opacity: .28; transform: scale(.82); }
  50%{ opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce){
  .cw-pulse{ animation: none; opacity: .85; }
}
/* 「更早的 N 条未显示」提示条 */
.cw-omitted{
  display: flex; align-items: flex-start; gap: 6px; margin: 0 0 14px;
  padding: 7px 10px; border-radius: var(--cw-radius-sm);
  background: var(--cw-bg); box-shadow: inset 0 0 0 .5px var(--cw-border);
  font-size: var(--cw-fs-micro); line-height: 1.55; color: var(--cw-subtle);
}
.cw-omitted svg{ flex: none; margin-top: 1px; }
.cw-step-status .cw-spin{ width: 11px; height: 11px; }

/* diff 摘要 */
.cw-diffmini{ margin: 2px 0 8px 28px; border-radius: var(--cw-radius-sm); overflow: hidden; background: var(--cw-bg); box-shadow: inset 0 0 0 .5px var(--cw-border); }
.cw-diffmini-head{ display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 9px; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); }
.cw-diffmini-head:hover{ background: var(--cw-hover); }
.cw-diffmini-head .cw-path{ color: var(--cw-subtle); font-family: var(--cw-mono); font-size: var(--cw-fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-diffmini-head .cw-stat{ margin-left: auto; color: var(--cw-subtle); font-variant-numeric: tabular-nums; }
.cw-diff{ font-family: var(--cw-mono); font-size: var(--cw-fs-xs); line-height: 1.6; overflow-x: auto; border-top: .5px solid var(--cw-border); }
.cw-dline{ display: flex; white-space: pre; }
.cw-dline .g{ width: 22px; flex: none; text-align: center; user-select: none; color: var(--cw-subtle); }
.cw-dline .t{ padding-right: 8px; }
.cw-dline.add{ background: color-mix(in srgb, var(--cw-success) 8%, transparent); }
.cw-dline.del{ background: color-mix(in srgb, var(--cw-danger) 8%, transparent); color: var(--cw-muted); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--cw-danger) 35%, transparent); }

/* 审批卡 */
.cw-approval{
  max-width: 760px; border-radius: var(--cw-radius-lg);
  background: var(--cw-bg); overflow: hidden; margin: 8px 0 16px;
  box-shadow: var(--cw-elev-panel); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
  animation: cw-in .25s ease-out;
}
.cw-ap-head{ display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: var(--cw-warning-bg); border-bottom: .5px solid var(--cw-border); }
.cw-ap-head .cw-ic{ color: var(--cw-warning); }
.cw-ap-title{ font-size: var(--cw-fs-base); font-weight: var(--cw-fw-bold); line-height: var(--cw-lh-base); }
.cw-ap-time{ margin-left: auto; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-warning); font-variant-numeric: tabular-nums; }
.cw-ap-body{ padding: 14px; }
.cw-ap-row{ display: flex; gap: 10px; margin-bottom: 10px; font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); }
.cw-ap-key{ width: 64px; flex: none; color: var(--cw-subtle); }
.cw-ap-val{ flex: 1; min-width: 0; }
.cw-cmd{
  font-family: var(--cw-mono); font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm);
  background: var(--cw-sub); border: 0; border-radius: var(--cw-radius-sm);
  padding: 9px 11px; color: var(--cw-text); word-break: break-all; white-space: pre-wrap;
  max-height: 200px; overflow: auto;
}
.cw-impact{
  background: var(--cw-danger-bg); color: var(--cw-danger);
  border-radius: var(--cw-radius-sm); padding: 8px 11px; font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm);
}
.cw-ap-reason{
  width: 100%; margin-top: 10px; height: 34px; padding: 0 11px;
  border: .5px solid var(--cw-border-4); border-radius: var(--cw-radius-sm);
  background: var(--cw-bg); font-size: var(--cw-fs-sm);
}
.cw-ap-reason:focus{ border-color: var(--cw-running); }
.cw-ap-actions{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.cw-btn{
  height: 32px; padding: 0 12px; display: inline-flex; align-items: center; gap: 6px;
  border: 0; border-radius: var(--cw-radius-sm);
  white-space: nowrap;
  background: transparent; color: var(--cw-text); font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm);
  box-shadow: inset 0 0 0 .5px var(--cw-border-3);
}
.cw-btn:hover{ background: var(--cw-hover); }
.cw-btn:active{ background: var(--cw-active); }
.cw-btn.primary{ background: var(--cw-accent); color: var(--cw-on-accent); box-shadow: none; }
.cw-btn.primary:hover{ background: var(--cw-accent-hover); }
.cw-btn.danger{ color: var(--cw-danger); box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-danger) 50%, transparent); }
.cw-btn.sm{ height: 26px; padding: 0 9px; font-size: var(--cw-fs-xs); flex: none; }
.cw-ap-resolved{
  margin-top: 12px; padding: 9px 12px; border-radius: var(--cw-radius-sm);
  font-size: var(--cw-fs-sm); background: var(--cw-sub);
}

/* Codex 审计条目 */
.cw-audit{
  max-width: 760px; margin: 10px 0 14px;
  border-radius: var(--cw-radius-md); background: var(--cw-bg);
  box-shadow: var(--cw-elev-soft); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
  overflow: hidden;
}
.cw-audit-head{ display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 9px 12px; font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); }
.cw-audit-head:hover{ background: var(--cw-hover); }
.cw-audit-ic{
  width: 22px; height: 22px; flex: none; border-radius: 6px;
  background: var(--cw-success-bg); color: var(--cw-success);
  display: flex; align-items: center; justify-content: center;
}
.cw-audit-ic.error{ background: var(--cw-danger-bg); color: var(--cw-danger); }
.cw-audit-title{ font-weight: var(--cw-fw-medium); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-audit-code{ margin-left: auto; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-success); white-space: nowrap; }
.cw-audit-chev{ color: var(--cw-subtle); flex: none; }
/* 失败正文：始终可见，一眼能看到「为什么失败」，不用展开 */
.cw-audit-error{
  margin: 0 12px 10px; padding: 8px 10px; border-radius: var(--cw-radius-sm);
  background: var(--cw-danger-bg); color: var(--cw-danger);
  font-family: var(--cw-mono); font-size: var(--cw-fs-xs); line-height: 1.6;
  white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: auto;
}
.cw-audit.is-failed .cw-audit-code{ color: var(--cw-danger); }
.cw-audit-body{
  border-top: .5px solid var(--cw-border); padding: 10px 12px; background: var(--cw-sub);
  font-family: var(--cw-mono); font-size: var(--cw-fs-xs); color: var(--cw-muted);
  line-height: 1.6; white-space: pre-wrap; max-height: 260px; overflow: auto;
}
.cw-decision{ font-size: var(--cw-fs-xs); color: var(--cw-subtle); }
.cw-filechange-list{ border-top: .5px solid var(--cw-border); padding: 10px 12px; font-size: var(--cw-fs-xs); background: var(--cw-sub); }
.cw-filechange-list div{ padding: 2px 0; font-family: var(--cw-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 错误卡 */
.cw-err{ max-width: 760px; margin: 8px 0 16px; border-radius: var(--cw-radius-lg); overflow: hidden; box-shadow: var(--cw-elev-panel); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2); }
.cw-err-head{ display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: var(--cw-danger-bg); color: var(--cw-danger); font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-bold); line-height: var(--cw-lh-sm); }
.cw-err-head .cw-ic{ color: var(--cw-danger); }
.cw-err-body{ padding: 14px; }
.cw-err-diag{ display: grid; grid-template-columns: 80px 1fr; gap: 6px 10px; font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); margin-bottom: 14px; }
.cw-err-diag .k{ color: var(--cw-subtle); }
.cw-err-note{
  font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); color: var(--cw-muted);
  background: var(--cw-sub); border-radius: var(--cw-radius-sm); padding: 9px 11px; margin-bottom: 14px;
}
.cw-notice-line{ text-align: center; font-size: var(--cw-fs-xs); color: var(--cw-subtle); margin: 10px 0; }

/* 空态 */
.cw-empty{ max-width: 620px; margin: 60px auto 0; text-align: center; }
.cw-empty-mark{
  width: 52px; height: 52px; border-radius: var(--cw-radius-lg); background: var(--cw-module);
  color: var(--cw-text); display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;
}
.cw-empty-mark .cw-ic{ width: 26px; height: 26px; }
.cw-empty h2{ font-size: var(--cw-fs-lg); font-weight: var(--cw-fw-bold); line-height: var(--cw-lh-lg); margin: 0 0 6px; }
.cw-empty p{ font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); color: var(--cw-muted); margin: 0 0 24px; }
.cw-tasks{ display: grid; grid-template-columns: 1fr 1fr; gap: 10px; text-align: left; }
.cw-task{
  display: flex; gap: 10px; align-items: flex-start; padding: 13px;
  border-radius: var(--cw-radius-md); background: var(--cw-bg);
  box-shadow: var(--cw-elev-soft); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
}
.cw-task:hover{ background: var(--cw-hover); }
.cw-task .cw-ic{ margin-top: 2px; color: var(--cw-running); }
.cw-task b{ display: block; margin-bottom: 2px; font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); }
.cw-task span{ display: block; font-size: var(--cw-fs-xs); color: var(--cw-muted); line-height: var(--cw-lh-xs); }

/* ============ 输入区 ============ */
/* 输入卡是 Dock 的主角，贴底居中；工具条放在卡内左下、发送键在右下，
   输入正文在上面独占一行——不再把「文件 / 命令 / 模型」三个长胶囊顶到左上角。 */
.cw-dock{
  position: relative; flex: none; border-top: .5px solid var(--cw-border);
  padding: 10px 18px 12px; background: var(--cw-bg);
}
/* —— 运行状态状态条：已移除。DSH 把「正在做什么」放在对话正文末尾，
   输入框上方那条位置留给任务清单（conversation.input.dock）。 —— */
/* 输入卡与统计行同一列，宽度跟着中栏自适应（跟 DSH 的 composer-card-max-width 同一算法：
   中栏宽度的 64% + 32px，钳在 712–952px 之间）。右栏拉宽/收起时输入框自动变宽变窄，
   不再是一个写死的 720px。 */
.cw-dock > .cw-inputbox,
.cw-dock > .cw-stats,
.cw-dock > .cw-todo{
  width: min(100%, clamp(712px, calc(64% + 32px), 952px));
  margin-left: auto; margin-right: auto;
}
.cw-inputbox{
  position: relative; /* 选择浮层的宽度锚点：跟 DSH 一样，菜单和输入卡同宽 */
  border: 0; border-radius: var(--cw-radius-panel); background: var(--cw-input-bg);
  box-shadow: var(--cw-elev-soft); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
  padding: 4px 8px 7px; display: flex; flex-direction: column; gap: 2px;
}
/* 输入区：contenteditable 的正文层。尺寸口径与原来的 textarea 一致，
   换实现只是为了让内联引用块能嵌在文字流里。 */
.cw-editor{
  display: block; width: 100%; height: auto; min-height: 76px; max-height: 336px; flex: none;
  overflow-y: auto; border: 0; outline: none; background: transparent;
  padding: 6px 10px 2px;
  font-size: var(--cw-fs-base); line-height: var(--cw-lh-lg); caret-color: var(--cw-running);
  color: var(--cw-text);
  white-space: pre-wrap; word-break: break-word;
}
.cw-editor:empty::before{ content: attr(data-placeholder); color: var(--cw-placeholder); pointer-events: none; }
/* 内联引用块：照 DSH 的样子——“ + 引文用链接蓝，没有底色/边框，后面直接接
   用户自己的文字（正常正文色）。太长就单行省略号截断。
   注意：这段 CSS 在 String.raw 模板里，注释里不能出现反引号或美元花括号。 */
.cw-editor-quote{
  display: inline-flex; align-items: baseline; gap: 3px; max-width: min(78%, 520px);
  margin-right: 3px; color: var(--dsw-alias-link, var(--cw-running));
}
.cw-editor-quote-mark{ flex: none; color: inherit; line-height: 1; }
.cw-editor-quote-text{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 底部行至少 34px（发送键高度），且不被 flex 压缩——否则圆角卡会把它裁掉一截。 */
.cw-input-foot{ flex: none; display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 0 0 2px; }
/* 发送 / 停止键靠 margin-left:auto 贴右（工具条是普通 flex 子项，不会自己撑满） */
.cw-input-tools{ display: flex; align-items: center; gap: 4px; min-width: 0; flex-wrap: wrap; }
/* 工具按钮：图标按钮给到 34px，两个相邻的图标之间留 4px——
   原来 28px + 2px 间距，@ 和 / 挤在一起很难点中。 */
.cw-tool{
  width: 34px; height: 28px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--cw-radius-sm); color: var(--cw-subtle);
}
.cw-tool:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-tool[disabled]{ color: var(--cw-placeholder); }
/* 附件按钮：跟 DSH composer 的加号同一个样子——28px 圆、selector 底、primary 字形。
   点开系统文件选择器；图片也可以直接粘贴或拖进输入卡。 */
.cw-add{
  width: 28px; height: 28px; flex: none; display: inline-grid; place-items: center; padding: 0;
  border-radius: 999px; background: var(--dsw-specific-selector, var(--cw-hover));
  color: var(--dsw-alias-label-primary, var(--cw-text));
}
.cw-add:hover:not([disabled]){ background: var(--dsw-alias-interactive-bg-hover-solid, var(--cw-hover)); }
.cw-add[disabled]{ opacity: .5; }
.cw-add .cw-ic{ width: 14px; height: 14px; }
/* 草稿里的附件：贴在输入框上方。图片 64px 方块（DSH 的缩略图尺寸），
   文件是一枚带名字和大小的小卡片；右上角 × 移除。 */
.cw-attachrail{ display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 10px 2px; }
.cw-attach-img{ position: relative; width: 64px; height: 64px; flex: none; }
.cw-attach-img img{
  display: block; width: 100%; height: 100%; object-fit: cover;
  border: .5px solid var(--cw-border-2); border-radius: var(--cw-radius-md);
  background: var(--cw-hover);
}
.cw-attach-x{
  position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; padding: 0;
  display: grid; place-items: center; border-radius: 999px;
  background: var(--dsw-alias-button-contrast-fill, rgba(0, 0, 0, .62));
  color: var(--dsw-alias-label-primary-inverted, #fff);
  box-shadow: 0 1px 3px rgba(0, 0, 0, .28);
}
.cw-attach-x .cw-ic{ width: 10px; height: 10px; }
.cw-attach-file{
  position: relative; display: inline-flex; align-items: center; gap: 8px; height: 44px; flex: none;
  padding: 0 30px 0 10px; border-radius: var(--cw-radius-md);
  background: var(--cw-hover); color: var(--cw-text); font-size: var(--cw-fs-xs);
}
.cw-attach-file .cw-ic{ width: 16px; height: 16px; flex: none; color: var(--cw-subtle); }
.cw-attach-name{ max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-attach-size{ color: var(--cw-subtle); font-variant-numeric: tabular-nums; }
.cw-attach-file .cw-attach-x{ top: 50%; right: 6px; margin-top: -9px; }
/* 拖文件进来：整张输入卡描一圈虚线（DSH 是全屏遮罩，这里输入卡本身就是目标） */
.cw-inputbox.is-drag{ outline: 1.5px dashed var(--cw-accent-ink, var(--cw-running)); outline-offset: -6px; }
/* 带文字的胶囊按钮（技能 / 计划）：图标 + 文字，32px 高，跟 DS H 菜单那一排一致。
   图标 18px、细描边、与文字垂直居中。 */
.cw-pillbtn{
  display: inline-flex; align-items: center; gap: 7px; height: 32px; flex: none;
  padding: 0 12px 0 10px; border-radius: var(--cw-radius-pill);
  color: var(--cw-muted); font-size: var(--cw-fs-sm); line-height: 1; white-space: nowrap;
}
.cw-pillbtn .cw-ic{ width: 18px; height: 18px; flex: none; color: var(--cw-subtle); }
.cw-pillbtn:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-pillbtn:hover .cw-ic{ color: var(--cw-text); }
.cw-pillbtn[disabled]{ color: var(--cw-placeholder); }
.cw-pillbtn[disabled] .cw-ic{ color: var(--cw-placeholder); }
.cw-pillbtn.is-on,
.cw-pillbtn.is-open{
  color: var(--cw-accent-ink, var(--cw-running));
  background: color-mix(in srgb, var(--cw-accent-ink, var(--cw-running)) 13%, transparent);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-accent-ink, var(--cw-running)) 40%, transparent);
}
.cw-pillbtn.is-on .cw-ic,
.cw-pillbtn.is-open .cw-ic{ color: inherit; }
/* 计划模式打开时的强调色相跟随当前助手（Claude 蓝 / Codex 紫） */
.cw-tool.is-plan{
  color: var(--cw-accent-ink, var(--cw-running));
  background: color-mix(in srgb, var(--cw-accent-ink, var(--cw-running)) 13%, transparent);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-accent-ink, var(--cw-running)) 40%, transparent);
}
.cw-planchip{
  display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; flex: none;
  border-radius: var(--cw-radius-pill); font-size: var(--cw-fs-micro); line-height: 1;
  color: var(--cw-accent-ink, var(--cw-running));
  background: color-mix(in srgb, var(--cw-accent-ink, var(--cw-running)) 13%, transparent);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-accent-ink, var(--cw-running)) 40%, transparent);
}
.cw-planchip:hover{ background: color-mix(in srgb, var(--cw-accent-ink, var(--cw-running)) 22%, transparent); }
.cw-tool-sep{ width: 1px; height: 14px; margin: 0 4px; background: var(--cw-border-2); flex: none; }
/* 模型选择器：只放当前模型名，不再写成「模型：默认」那么长 */
.cw-picker{
  display: inline-flex; align-items: center; gap: 5px; height: 28px; max-width: 220px;
  padding: 0 6px; border-radius: var(--cw-radius-sm);
  color: var(--cw-muted); font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); white-space: nowrap;
}
.cw-picker:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-picker.is-open{ background: var(--cw-fill); color: var(--cw-text); }
.cw-picker .cw-ic{ flex: none; color: var(--cw-subtle); }
.cw-picker-label{ min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* 已引用的文件：一个小标签，跟在模型按钮后面 */
.cw-ref{
  display: inline-flex; align-items: center; gap: 4px; height: 22px; max-width: 180px; margin-left: 4px;
  padding: 0 4px 0 6px; border-radius: var(--cw-radius-pill);
  background: var(--cw-module); color: var(--cw-muted);
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); white-space: nowrap;
}
.cw-ref-name{ min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--cw-mono); font-size: var(--cw-fs-micro); }
/* 技能卡片：跟 DSH 一样只显示技能名（外加锤子图标），不摊开说明文字 */
.cw-ref-skill{
  background: var(--cw-module);
  color: var(--cw-text);
  border-radius: var(--cw-radius-sm);
  padding: 0 2px 0 6px;
  gap: 5px;
}
.cw-ref-skill .cw-ic{ color: var(--cw-accent-ink, var(--cw-running)); }
.cw-ref-skill .cw-ref-name{ font-family: var(--cw-font); font-size: var(--cw-fs-xs); max-width: 140px; }
.cw-ref .x{ display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; color: var(--cw-subtle); }
.cw-ref .x:hover{ background: var(--cw-hover); color: var(--cw-text); }
/* 小描边按钮（设置里的「重新检测」「撤销」等） */
.cw-chip{
  height: 24px; padding: 0 8px; display: inline-flex; align-items: center; gap: 4px;
  border: 0; border-radius: var(--cw-radius-sm);
  background: transparent; color: var(--cw-muted); font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); white-space: nowrap;
}
.cw-chip:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-chip.sm{ height: 24px; padding: 0 8px; font-size: var(--cw-fs-xs); text-shadow: none; box-shadow: inset 0 0 0 .5px var(--cw-border-2); }
/* 模型菜单要放下「别名 + 网关里的完整模型名」，比其他浮层宽。
   注意用**双类选择器**：.cw-pop 定义在本文件更靠后的位置，单类选择器的
   min/max-width 会被它整段盖掉（.cw-picker-pop 也出于同样原因用双类）。 */
.cw-pop.cw-model-pop{
  min-width: 533px; max-width: min(740px, calc(100vw - 24px));
  /* Codex 的模型目录可能有几十个型号，超过一屏就滚动，不把浮层拉成整屏高 */
  max-height: 360px; overflow-y: auto;
}
/* 只有一个「默认」时（没有模型目录）不需要那么宽 */
.cw-pop.cw-model-pop.is-narrow{ min-width: 268px; max-width: min(420px, calc(100vw - 24px)); }
/* 右侧模型名发虚的两条主因：字号比左侧标签小一档（11→现在 13），
   颜色又是三级灰（--cw-subtle），灰底 + 灰字 + 小字叠在一起就糊。
   这里字号与左侧标签同档、颜色提到正文级，行高定死 18px 避免半像素居中。 */
.cw-pop.cw-model-pop .cw-pop-item .tail{
  max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-size: var(--cw-fs-sm); line-height: 18px; font-weight: 400; color: var(--cw-text);
  letter-spacing: 0; font-variant-numeric: tabular-nums;
}
.cw-pop-sep{ height: .5px; margin: 4px 8px; background: var(--cw-border-2); }
.cw-pop-note{ padding: 2px 12px 6px; font-size: var(--cw-fs-micro); line-height: 1.6; color: var(--cw-subtle); }
/* 锚点容器：浮层的参照物就是被点的那个按钮本身（不是整条 dock）。
   display: inline-flex 保证它不撑开工具条，position: relative 让 .cw-pop 贴着它展开。 */
.cw-anchor{ position: relative; display: inline-flex; flex: none; }
/* 选择浮层（@ 文件 / / 命令 / 技能）：跟 DSH 的 trigger menu 一样跟输入卡同宽，
   贴在输入卡上沿——不再是一个写死 340px 的小框（窄框正是文件名被截断的原因）。
   .cw-pop 自带的 min/max-width 用双类选择器盖掉。 */
.cw-pop.cw-picker-pop{
  position: absolute; left: 0; right: 0; bottom: calc(100% + 6px);
  min-width: 0; max-width: none;
  max-height: 360px; overflow-y: auto;
}
/* 列表行：名字一列（最多 40%）、说明一列（右对齐、单行省略），跟 DSH MenuView 同一套列宽 */
.cw-picker-name{
  flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cw-picker-pop .cw-pop-item{ align-items: center; }
.cw-picker-pop .cw-pop-item .tail{
  flex: 1; min-width: 0; max-width: none; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  text-align: right; line-height: var(--cw-lh-xs);
}
/* 文件行的说明是所在目录：从尾部（离文件最近的目录）开始显示，长路径也不会只剩根目录 */
.cw-picker-pop .cw-pop-item .tail.is-path{ direction: rtl; unicode-bidi: plaintext; }
.cw-pop-item.is-current{ color: var(--cw-text); }
.cw-hint{ font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle); }

/* —— 输入框底部的统计 pill（跟 DSH 一样单独一行、居中、彼此拉开） —— */
.cw-stats{
  display: flex; align-items: center; justify-content: center; gap: 14px;
  margin: 10px auto 2px; padding: 0;
  min-height: 26px; flex-wrap: wrap; row-gap: 6px;
}
.cw-pillwrap{ position: relative; display: inline-flex; min-width: 0; }
.cw-pill{
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 26px;
  padding: 0 11px; border: 0; border-radius: var(--cw-radius-pill);
  background: transparent; color: var(--cw-subtle);
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); font-variant-numeric: tabular-nums; white-space: nowrap;
}
.cw-pill .cw-ic{ width: 13px; height: 13px; opacity: .75; }
/* 上下文进度环：浅底圈 + 同色进度弧；14px 尺寸下把描边加粗才看得清。
   超过 80% 转警示色，不用读数字也知道快满了。 */
.cw-ring{ overflow: visible; width: 14px; height: 14px; flex: none; opacity: 1; color: var(--cw-running); }
.cw-ring .cw-ring-track{ stroke: var(--cw-border-3); stroke-width: 2.4; }
.cw-ring .cw-ring-arc{ stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; transition: stroke-dashoffset 240ms ease; }
.cw-ring.is-high{ color: var(--cw-danger); }
.cw-pill .cw-pill-label{ min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.cw-pill .cw-pill-sep{ color: var(--cw-border-3); margin: 0 4px; }
button.cw-pill{ cursor: pointer; }
button.cw-pill:hover{ background: var(--cw-hover); color: var(--cw-text); }
/* 中栏偏窄时（右栏展开、窗口不宽）把统计行再收紧一点，保证三个读数始终一行排开 */
.cw-root[data-narrow="1"] .cw-stats{ gap: 8px; }
.cw-root[data-narrow="1"] .cw-pill{ height: 24px; padding: 0 7px; font-size: var(--cw-fs-micro); gap: 4px; }
.cw-root[data-narrow="1"] .cw-pill .cw-ic{ width: 12px; height: 12px; }
button.cw-pill[aria-expanded="true"]{
  background: var(--cw-fill); color: var(--cw-text);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border);
}
.cw-statpanel{
  position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 70;
  width: 300px; max-width: calc(100vw - 24px); padding: 12px;
  border: 0; border-radius: var(--cw-radius-lg);
  background: var(--cw-menu-bg); backdrop-filter: var(--cw-menu-blur);
  box-shadow: var(--cw-elev-prominent); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-muted);
  animation: cw-in .15s var(--ds-ease-in-out, ease-out);
}
.cw-statpanel-title{
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  color: var(--cw-text); font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-sm);
}
.cw-statpanel-title span{ display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.cw-statpanel-title span:last-child{ color: var(--cw-subtle); font-size: var(--cw-fs-xs); font-weight: var(--cw-fw-normal); line-height: var(--cw-lh-xs); font-variant-numeric: tabular-nums; }
.cw-statpanel-title .cw-ic{ width: 14px; height: 14px; color: var(--cw-subtle); }
.cw-statpanel-rule{ margin: 8px 0 10px; border-top: .5px solid var(--cw-border-2); }
.cw-statpanel dl{
  display: grid; grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px; margin: 0;
}
.cw-statpanel dt{ margin: 0; min-width: 0; color: var(--cw-subtle); }
.cw-statpanel dd{ margin: 0; min-width: 0; text-align: right; color: var(--cw-text); font-variant-numeric: tabular-nums; }
.cw-statpanel-note{ margin-top: 10px; color: var(--cw-subtle); font-size: var(--cw-fs-micro); line-height: 1.6; }
.cw-send{
  margin-left: auto; width: 34px; height: 34px; flex: none; padding: 0; display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--cw-radius-pill); background: var(--cw-send); color: var(--cw-on-send);
  font-size: 0; line-height: 0;
}
.cw-send .cw-ic{ width: 16px; height: 16px; }
.cw-send:hover{ background: var(--cw-send-hover); }
/* 停止键跟 DSH 一模一样：蓝色圆底 + 白色圆角方块（DSH 的 .primary 用的是
   button-info-fill 底 + label-on-color 的实心 rect）。以前是整颗白色，认不出来。 */
.cw-send.stop{ background: var(--cw-send); color: var(--cw-on-send); }
.cw-send.stop:hover{ background: var(--cw-send-hover); }
.cw-send:disabled{ opacity: .4; }

/* —— 任务清单：从正文末尾搬到输入卡上方（就是 DSH 的 conversation.input.dock）。
   DSH 在上面放 TodoPanel，正好把「正在执行的工具」那条状态条的位置让出来。 —— */
.cw-dock > .cw-todo{ margin: 0 auto 8px; max-width: none; }
.cw-dock > .cw-todo .cw-todo-head{ padding: 6px 12px; font-size: var(--cw-fs-xs); }
.cw-dock > .cw-todo .cw-todo-list{ max-height: 132px; }

/* —— 右栏：检查器 —— */
/* —— 右栏：文档式标签条（跟 DSH 的右栏一样，标签宽度随内容走） —— */
.cw-insp{
  width: 272px; flex: none; display: flex; flex-direction: column; min-height: 0; position: relative;
  background: var(--cw-sidebar); border-left: .5px solid var(--cw-border-2);
}
.cw-chipbar{
  flex: none; display: flex; align-items: center; gap: 4px;
  padding: 6px 8px; border-bottom: .5px solid var(--cw-border);
  overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
}
.cw-chipbar::-webkit-scrollbar{ display: none; }
.cw-chip-tab{
  display: inline-flex; align-items: center; gap: 6px; flex: none; max-width: 190px;
  height: 28px; padding: 0 9px; border-radius: var(--cw-radius-sm);
  font-size: var(--cw-fs-xs); color: var(--cw-subtle); white-space: nowrap;
}
.cw-chip-tab .cw-ic{ width: 13px; height: 13px; flex: none; }
.cw-chip-tab:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-chip-tab.is-active{ background: var(--cw-fill); color: var(--cw-text); font-weight: var(--cw-fw-medium); }
.cw-chip-label{ min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.cw-chip-x{
  display: inline-flex; align-items: center; justify-content: center;
  width: 15px; height: 15px; margin-right: -3px; border-radius: 3px; color: var(--cw-subtle);
}
.cw-chip-x:hover{ background: var(--cw-border-2); color: var(--cw-text); }
.cw-chipbar-fill{ flex: 1; min-width: 4px; }
.cw-chipbar-tool{
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; flex: none; border-radius: var(--cw-radius-sm); color: var(--cw-subtle);
}
.cw-chipbar-tool:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-chipbar-tool.is-on{ background: var(--cw-fill); color: var(--cw-text); }
/* 运行状态页签上方的标题行（它不在文档页签里，单独给一个小标题） */
.cw-runhead{
  flex: none; display: flex; align-items: center; gap: 7px;
  padding: 10px 14px 0; font-size: var(--cw-fs-sm); color: var(--cw-text);
}
.cw-runhead .cw-ic{ width: 13px; height: 13px; color: var(--cw-subtle); }
.cw-runhead-title{ font-weight: var(--cw-fw-medium); }
/* 拖宽把手：贴着右栏左缘的一条细热区，悬停才亮起 */
.cw-insp-grip{
  position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; z-index: 5;
  cursor: col-resize; background: transparent; transition: background-color 120ms ease;
}
.cw-insp-grip:hover,
.cw-insp-grip:active{ background: color-mix(in srgb, var(--cw-accent-ink, var(--cw-running)) 55%, transparent); }
.cw-tabs{ display: flex; flex: none; border-bottom: .5px solid var(--cw-border); padding: 0 8px; gap: 2px; }
.cw-tab{
  flex: 1; height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; padding: 0 2px; border-radius: 10px; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs);
  color: var(--cw-subtle); white-space: nowrap;
}
.cw-tab .cw-ic{ width: 15px; height: 15px; }
.cw-tab:hover{ color: var(--cw-text); }
.cw-tab.is-active{ color: var(--cw-text); background: var(--cw-fill); font-weight: var(--cw-fw-medium); }
.cw-insp-body{ flex: 1; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; }
/* 预览标签里文档要能撑满剩余高度并自己滚动，其余标签照旧从上往下排 */
.cw-insp-body > .cw-pv-wrap{ flex: 1; min-height: 0; }
.cw-sec{ margin-bottom: 18px; }
.cw-sec-title{
  display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
  font-size: var(--cw-fs-micro); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-micro);
  color: var(--cw-subtle); letter-spacing: .3px;
}
.cw-card{
  background: var(--cw-bg); border-radius: var(--cw-radius-md); padding: 12px;
  box-shadow: inset 0 0 0 .5px var(--cw-border-2);
}
.cw-now{ display: flex; align-items: center; gap: 8px; }
.cw-now .cw-spin{ width: 13px; height: 13px; }
.cw-now b{ display: block; font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-sm); }
.cw-now p{ margin: 2px 0 0; font-size: var(--cw-fs-xs); color: var(--cw-subtle); line-height: var(--cw-lh-xs); word-break: break-all; }
.cw-kv{ display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); border-bottom: .5px solid var(--cw-border); }
.cw-kv:last-child{ border-bottom: none; }
.cw-kv .k{ color: var(--cw-subtle); }
.cw-kv .v{ font-family: var(--cw-mono); font-variant-numeric: tabular-nums; }
.cw-bar{ height: 4px; border-radius: var(--cw-radius-pill); background: var(--cw-module); overflow: hidden; margin: 8px 0 5px; }
.cw-bar > i{ display: block; height: 100%; border-radius: var(--cw-radius-pill); background: var(--cw-running); }
.cw-bar-label{ display: flex; justify-content: space-between; gap: 6px; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle); }
.cw-mem{ display: flex; align-items: center; gap: 6px; padding: 5px 0; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); }
.cw-mem .cw-ic{ width: 13px; height: 13px; }
.cw-mem.ok{ color: var(--cw-success); }
.cw-mem.no{ color: var(--cw-subtle); }
.cw-mem-note{ margin-top: 8px; font-size: var(--cw-fs-xs); line-height: 1.6; color: var(--cw-subtle); }

/* —— 任务清单卡片：跟着 CLI 输出的 todo 走，与 DSH 的 progress 条同一语气 —— */
.cw-todo{
  max-width: 760px; margin: 4px 0 16px; border-radius: var(--cw-radius-lg);
  background: var(--cw-menu-bg); backdrop-filter: var(--cw-menu-blur);
  box-shadow: var(--cw-elev-panel); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  overflow: hidden;
}
.cw-todo-head{
  width: 100%; display: flex; align-items: center; gap: 9px; padding: 8px 12px;
  font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); text-align: left;
}
.cw-todo-head:hover{ background: var(--cw-hover); }
.cw-todo-head .cw-ic{ width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary); }
.cw-todo-title{ font-weight: var(--cw-fw-medium); color: var(--cw-text); flex: none; }
.cw-todo-progress{
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--cw-fs-xs); color: var(--cw-subtle); font-variant-numeric: tabular-nums;
}
.cw-todo-chev{ color: var(--cw-subtle); flex: none; }
.cw-todo-list{
  list-style: none; margin: 0; padding: 0 12px 10px; display: flex; flex-direction: column; gap: 7px;
  max-height: 180px; overflow-y: auto;
}
.cw-todo-item{ display: flex; align-items: flex-start; gap: 9px; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-sm); color: var(--cw-text); }
.cw-todo-dot{
  flex: none; width: 14px; height: 14px; margin-top: 2px; border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--cw-border-3);
}
.cw-todo-item[data-status="completed"] .cw-todo-dot{ background: var(--cw-success); box-shadow: none; }
.cw-todo-item[data-status="in_progress"] .cw-todo-dot{ background: var(--cw-accent-ink, var(--cw-running)); box-shadow: none; }
.cw-todo-item[data-status="completed"] .cw-todo-text{ color: var(--cw-subtle); text-decoration: line-through; }
.cw-todo-text{ min-width: 0; word-break: break-word; }
.cw-taskrow{ display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle); }
.cw-taskrow .cw-path{ flex: 1; min-width: 0; color: var(--cw-text); font-family: var(--cw-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-allow-row{ display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); }
.cw-allow-row .cw-path{ flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--cw-mono); }

/* 预览面板 */
.cw-pv{ border-radius: var(--cw-radius-md); overflow: hidden; background: var(--cw-bg); box-shadow: inset 0 0 0 .5px var(--cw-border-2); }
/* 文档预览：铺满右栏主体、内部滚动，不再挤在 132px 的小框里 */
.cw-pv-wrap{ display: flex; flex-direction: column; gap: 10px; }
.cw-pv.is-doc{ display: flex; flex-direction: column; flex: 1; min-height: 0; }
.cw-pv.is-doc > .cw-pv-meta{ order: -1; border-bottom: .5px solid var(--cw-border); }
.cw-pv-doc{ flex: 1; min-height: 0; overflow: auto; padding: 4px 14px 16px; }
.cw-pv-doc.cw-source{ padding: 12px 14px; }
/* 代码文件：等宽 + 行号栏的观感（不做词法高亮，只把行号和红绿无关的行距做干净） */
.cw-pv-code{
  margin: 0; padding: 12px 14px; font-family: var(--cw-mono); font-size: var(--cw-fs-xs);
  line-height: 1.7; white-space: pre; tab-size: 2; overflow: auto;
}
/* HTML 预览：沙箱 iframe 撑满预览区，白底保证和真实浏览器一致 */
.cw-pv-html{ display: flex; flex-direction: column; padding: 0; }
.cw-pv-frame{ flex: 1; min-height: 320px; width: 100%; border: 0; background: #fff; }
.cw-pv-note{
  flex: none; padding: 6px 12px; font-size: var(--cw-fs-micro); color: var(--cw-subtle);
  border-top: .5px solid var(--cw-border); background: var(--cw-sub); line-height: 1.5;
}
.cw-pv.canvas{ height: 132px; }
.cw-pv-canvas{ height: 132px; background: var(--cw-sub); display: flex; align-items: center; justify-content: center; border-bottom: .5px solid var(--cw-border); overflow: hidden; }
.cw-pv-canvas img{ max-width: 100%; max-height: 132px; object-fit: contain; display: block; }
.cw-pv-meta{ padding: 10px 12px 12px; }
/* 标题一行 + 右侧三个小图标按钮：动作栏不再占掉三行高度 */
.cw-pv-head{ display: flex; align-items: center; gap: 8px; }
.cw-pv-name{ flex: 1; min-width: 0; font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-pv-spec{ margin-top: 3px; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle); font-family: var(--cw-mono); word-break: break-all; }
.cw-pv-actions{ display: flex; align-items: center; gap: 2px; flex: none; }
.cw-pv-actions button{
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: 0; border-radius: var(--cw-radius-sm);
  color: var(--cw-subtle); background: transparent;
}
.cw-pv-actions button:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-pv-actions .cw-ic{ width: 15px; height: 15px; }
/* 「页面」标签里的文字按钮：三个并排的普通小按钮 */
.cw-pv-actions-text{ display: grid; grid-template-columns: repeat(3,1fr); gap: 6px; margin-top: 10px; }
.cw-pv-actions-text button{
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  height: 54px; border: 0; border-radius: var(--cw-radius-sm);
  font-size: var(--cw-fs-xs); color: var(--cw-muted); background: var(--cw-module);
}
.cw-pv-actions-text button:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-pv-actions-text .cw-ic{ width: 15px; height: 15px; }
.cw-source{
  margin: 0; padding: 10px 12px; font-family: var(--cw-mono); font-size: var(--cw-fs-xs);
  line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto; color: var(--cw-muted);
}

/* 文件面板 */
.cw-filehead{ display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); color: var(--cw-subtle); }
.cw-filehead .new-count{ margin-left: auto; background: var(--cw-module); color: var(--cw-text); border-radius: var(--cw-radius-pill); padding: 1px 7px; font-size: var(--cw-fs-micro); font-weight: var(--cw-fw-medium); }
.cw-tree-row{ display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: var(--cw-radius-sm); font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); color: var(--cw-subtle); }
.cw-tree-row .cw-ic{ width: 13px; height: 13px; }
.cw-tree-row.dir{ color: var(--cw-text); font-weight: var(--cw-fw-medium); }
.cw-tree-row.file{ cursor: pointer; }
.cw-tree-row.file:hover{ background: var(--cw-hover); color: var(--cw-text); }
.cw-tree-row.is-hi{ background: var(--cw-fill); color: var(--cw-text); }
.cw-tree-row .name{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cw-tree-row .new-tag{ margin-left: auto; font-size: var(--cw-fs-micro); font-weight: var(--cw-fw-medium); color: var(--cw-text); border: .5px solid var(--cw-border-3); border-radius: 4px; padding: 0 4px; }
.cw-filetip{ margin-top: 10px; font-size: var(--cw-fs-xs); color: var(--cw-subtle); line-height: 1.6; }

/* 页面面板 */
.cw-urlbar{
  display: flex; align-items: center; gap: 5px; height: 28px; padding: 0 8px;
  border: .5px solid var(--cw-border-2); border-radius: var(--cw-radius-sm);
  font-family: var(--cw-mono); font-size: var(--cw-fs-xs); color: var(--cw-subtle);
  white-space: nowrap; overflow: hidden;
}
.cw-urlbar span{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cw-urlbar .cw-ic{ width: 11px; height: 11px; }
.cw-page-note{ margin-top: 10px; font-size: var(--cw-fs-xs); color: var(--cw-subtle); line-height: 1.6; }

/* ============ 浮层：与 DSH 菜单同材质 ============ */
.cw-pop{
  position: absolute; z-index: 60; min-width: 240px; max-width: min(420px, calc(100vw - 24px));
  padding: 4px; border: 0; border-radius: var(--cw-radius-lg);
  background: var(--cw-menu-bg); backdrop-filter: var(--cw-menu-blur);
  box-shadow: var(--cw-elev-prominent); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
}
.cw-pop-title{ padding: 6px 8px; font-size: var(--cw-fs-micro); line-height: 15px; color: var(--cw-subtle); }
.cw-mode-pop{ width: 360px; }
.cw-pop-item{
  width: 100%; display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 8px;
  border-radius: var(--cw-radius-md); font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); text-align: left;
}
.cw-pop-item:hover{ background: var(--cw-hover); }
.cw-pop-item.is-dead{ opacity: .5; }
.cw-pop-item.is-dead:hover{ background: transparent; }
.cw-pop-item.is-dead .tail{ color: var(--cw-danger); }
.cw-pop-item .cw-ic{ width: 14px; height: 14px; color: var(--dsw-alias-menu-icon); }
.cw-pop-item .tail{ margin-left: auto; font-size: var(--cw-fs-micro); line-height: 15px; color: var(--cw-subtle); max-width: 200px; white-space: normal; text-align: right; }
.cw-pop-item .tail:empty{ display: none; }
.cw-menu{
  position: fixed; z-index: 90; min-width: 180px; padding: 4px; display: flex; flex-direction: column;
  border: 0; border-radius: var(--cw-radius-lg);
  background: var(--cw-menu-bg); backdrop-filter: var(--cw-menu-blur);
  box-shadow: var(--cw-elev-prominent); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
}
.cw-menu button{
  display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 8px;
  border-radius: var(--cw-radius-md); font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm);
  white-space: nowrap; text-align: left;
}
.cw-menu button:hover{ background: var(--cw-hover); }
.cw-menu button .cw-ic{ width: 14px; height: 14px; color: var(--dsw-alias-menu-icon); }
.cw-menu button.danger{ color: var(--cw-danger); }
.cw-menu .cw-menu-sep{ height: .5px; background: var(--cw-border-2); margin: 4px 8px; }

/* ============ 插件自己的确认框 / 重命名框 ============ */
.cw-confirm{
  width: 360px; max-width: 100%; border-radius: var(--cw-radius-lg); overflow: hidden;
  box-shadow: var(--cw-elev-panel); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
  animation: cw-in .15s var(--ds-ease-in-out, ease-out);
}
.cw-confirm-body{ padding: 18px 18px 4px; }
.cw-confirm-title{ font-size: var(--cw-fs-base); font-weight: var(--cw-fw-bold); line-height: var(--cw-lh-base); color: var(--cw-text); }
.cw-confirm-text{ margin-top: 6px; font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm); color: var(--cw-muted); }
.cw-confirm-error{ margin-top: 10px; padding: 8px 10px; border-radius: var(--cw-radius-sm); background: var(--cw-danger-bg); color: var(--cw-danger); font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); }
.cw-confirm-actions{ display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 14px 18px 16px; }
.cw-confirm-btn{
  height: 32px; padding: 0 14px; border-radius: var(--cw-radius-sm);
  background: transparent; color: var(--cw-text); font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-sm);
}
.cw-confirm-btn:hover{ background: var(--cw-hover); }
.cw-confirm-btn.primary{ background: var(--cw-accent); color: var(--cw-on-accent); }
.cw-confirm-btn.primary:hover{ background: var(--cw-accent-hover); }
.cw-confirm-btn.primary.danger{ background: var(--cw-danger); color: var(--cw-on-send); }
.cw-confirm-btn.primary.danger:hover{ background: color-mix(in srgb, var(--cw-danger) 86%, #000); }
.cw-confirm-btn:disabled{ opacity: .55; }
/* 工作区右键菜单：和会话右键菜单同一材质，靠 z-index 盖过左栏 */
.cw-groupmenu{ width: 192px; z-index: 92; }


/* ============ 对话框 / 设置面板 ============ */
.cw-mask{ position: absolute; inset: 0; z-index: 80; background: var(--dsw-alias-bg-mask-1); display: flex; align-items: center; justify-content: center; padding: 20px; }
.cw-dialog{
  width: 560px; max-width: 100%; max-height: 82%; display: flex; flex-direction: column; overflow: hidden;
  background: var(--cw-bg); border: 0; border-radius: var(--dsw-radius-xl, 20px);
  box-shadow: var(--cw-elev-panel); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
}
.cw-dialog.narrow{ width: 450px; }

/* —— 自定义规则（CLAUDE.md / AGENTS.md）编辑器 —— */
.cw-rules-dialog{ width: 720px; max-height: 84%; }
.cw-rules-note{
  padding: 10px 18px 0; font-size: var(--cw-fs-xs); line-height: 1.7; color: var(--cw-subtle);
}
.cw-rules{ display: flex; flex-direction: column; gap: 10px; padding: 12px 18px 16px; min-height: 0; flex: 1; }
.cw-rules-tabs{ display: flex; flex-wrap: wrap; gap: 6px; }
.cw-rules-tab{
  display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border-radius: var(--cw-radius-sm); font-size: var(--cw-fs-xs); color: var(--cw-text);
  box-shadow: inset 0 0 0 .5px var(--cw-border-2); background: var(--cw-bg);
}
.cw-rules-tab:hover{ background: var(--cw-hover); }
.cw-rules-tab.is-active{
  background: color-mix(in srgb, var(--cw-accent-ink, var(--cw-running)) 12%, transparent);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-accent-ink, var(--cw-running)) 45%, transparent);
  color: var(--cw-accent-ink, var(--cw-running)); font-weight: var(--cw-fw-medium);
}
.cw-rules-tab .cw-ic{ width: 12px; height: 12px; color: inherit; }
.cw-rules-tab-name{ font-family: var(--cw-mono); }
.cw-rules-dot{ width: 5px; height: 5px; border-radius: 50%; background: var(--cw-success); }
.cw-rules-new{ font-size: var(--cw-fs-micro); color: var(--cw-subtle); }
.cw-rules-body{ display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }
.cw-rules-path{
  display: flex; align-items: center; gap: 6px; font-size: var(--cw-fs-xs); color: var(--cw-subtle);
  font-family: var(--cw-mono); overflow: hidden; white-space: nowrap;
}
.cw-rules-path span:first-of-type{ overflow: hidden; text-overflow: ellipsis; }
.cw-rules-meta{ flex: none; font-family: var(--cw-sans, inherit); color: var(--cw-subtle); }
.cw-rules-editor{
  flex: 1; min-height: 240px; resize: vertical; padding: 12px 14px;
  border: 0; border-radius: var(--cw-radius-md); background: var(--cw-sub); color: var(--cw-text);
  box-shadow: inset 0 0 0 .5px var(--cw-border-2);
  font-family: var(--cw-mono); font-size: 13px; line-height: 1.7; tab-size: 2;
}
.cw-rules-editor:focus-visible{ outline: 1px solid var(--cw-accent-ink, var(--cw-running)); outline-offset: -1px; }
.cw-rules-error{ font-size: var(--cw-fs-xs); color: var(--cw-danger); }
.cw-rules-actions{ display: flex; align-items: center; gap: 8px; }
.cw-rules-hint{ margin-left: auto; font-size: var(--cw-fs-micro); color: var(--cw-subtle); }
.cw-dlg-head{ display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: .5px solid var(--cw-border); }
.cw-dlg-head .cw-ic{ width: 16px; height: 16px; color: var(--cw-subtle); }
.cw-dlg-head b{ flex: 1; font-size: var(--cw-fs-base); font-weight: var(--cw-fw-bold); line-height: var(--cw-lh-base); }
.cw-dlg-body{ padding: 18px; overflow-y: auto; }
.cw-dlg-foot{ display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: .5px solid var(--cw-border); background: var(--cw-sub); }
.cw-dlg-foot button{ height: 30px; padding: 0 12px; border: 0; border-radius: var(--cw-radius-sm); font-size: var(--cw-fs-sm); background: var(--cw-bg); color: var(--cw-text); box-shadow: inset 0 0 0 .5px var(--cw-border-3); }
.cw-dlg-foot button:hover{ background: var(--cw-hover); }
.cw-dlg-foot button.primary{ background: var(--cw-accent); color: var(--cw-on-accent); box-shadow: none; }
.cw-dlg-foot button.primary:hover{ background: var(--cw-accent-hover); }
.cw-dlg-foot button.danger{ color: var(--cw-danger); box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-danger) 50%, transparent); }
.cw-dlg-foot button.danger:hover{ background: var(--cw-danger-bg); }
/* 目录选择器：列表可滚动，行是整行按钮，键盘也能走 */
.cw-dirlist{ margin-top: 10px; max-height: 300px; overflow: auto; display: flex; flex-direction: column; gap: 1px;
  border: .5px solid var(--cw-border); border-radius: var(--cw-radius-sm); background: var(--cw-bg); padding: 4px; }
.cw-diritem{ display: flex; align-items: center; gap: 8px; height: 28px; flex: none; padding: 0 8px; border: 0; border-radius: var(--cw-radius-sm);
  background: transparent; color: var(--cw-text); font-size: var(--cw-fs-sm); text-align: left; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cw-diritem:hover{ background: var(--cw-hover); }
.cw-diritem svg{ flex: none; color: var(--cw-subtle); }
/* 删除工作区对话框：只移除工作台里的登记，不动磁盘目录与会话 */
.cw-ws-del-name{ display: flex; align-items: center; gap: 6px; font-size: var(--cw-fs-base); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-base); margin-bottom: 6px; }
.cw-ws-del-name .cw-ic{ width: 15px; height: 15px; color: var(--cw-subtle); }
.cw-ws-del-error{
  margin-top: 10px; padding: 8px 10px; border-radius: var(--cw-radius-sm);
  background: var(--cw-danger-bg); color: var(--cw-danger);
  font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs);
}
.cw-field{ margin-bottom: 16px; }
.cw-field:last-child{ margin-bottom: 0; }
.cw-label{ display: block; margin-bottom: 6px; font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-sm); color: var(--cw-text); }
.cw-hintline{ margin-top: 6px; font-size: var(--cw-fs-xs); color: var(--cw-subtle); line-height: 1.6; }
/* 新建会话里的「助手」：只读展示，跟随顶部选中项，不再提供二选一 */
.cw-assistant{
  display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 12px;
  border-radius: var(--cw-radius-md); background: var(--cw-sub);
  box-shadow: inset 0 0 0 .5px var(--cw-border-2);
  font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm);
}
.cw-assistant .cw-ic{ color: var(--cw-muted); }
.cw-assistant b{ font-weight: var(--cw-fw-medium); }
.cw-assistant span{ margin-left: auto; font-size: var(--cw-fs-xs); color: var(--cw-subtle); }
.cw-assistant.claude{ box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--cw-running) 42%, transparent); }
.cw-inputrow{ display: flex; gap: 8px; }
.cw-textinput{
  flex: 1; min-width: 0; height: 36px; padding: 0 12px;
  border: .5px solid var(--cw-border-4); border-radius: var(--cw-radius-md);
  background: var(--cw-input-bg); font-family: var(--cw-mono); font-size: var(--cw-fs-sm);
}
.cw-textinput:focus{ outline: none; border-color: var(--cw-running); }
.cw-textinput.plain{ font-family: var(--cw-font); }
.cw-select{
  width: 100%; height: 34px; padding: 0 12px;
  border: .5px solid var(--cw-border-4); border-radius: var(--cw-radius-md);
  background: var(--cw-input-bg); color: var(--cw-text); font-size: var(--cw-fs-sm);
}
.cw-select:focus{ outline: none; border-color: var(--cw-running); }
.cw-default-group{ margin-bottom: 18px; }
.cw-set-title{ display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-sm); color: var(--cw-text); }
.cw-default-row{ display: grid; grid-template-columns: 88px 1fr; gap: 10px; align-items: center; margin-bottom: 9px; }
.cw-default-key{ font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); }
.cw-default-note{ margin-top: 8px; font-size: var(--cw-fs-xs); color: var(--cw-subtle); line-height: 1.7; }

/* 设置：归档 */
.cw-arch-search{
  height: 32px; margin-top: 10px; display: flex; align-items: center; gap: 7px; padding: 0 10px;
  border: .5px solid var(--cw-border-4); border-radius: var(--cw-radius-sm); background: var(--cw-input-bg);
  color: var(--cw-subtle);
}
.cw-arch-search:focus-within{ border-color: var(--cw-running); }
.cw-arch-search input{ flex: 1; width: 100%; min-width: 0; border: none; outline: none; background: transparent; font-size: var(--cw-fs-sm); }
/* 已归档：按助手分组、默认收起，搜索时也保持各组的收起状态 */
.cw-set-title-note{ margin-left: auto; font-size: var(--cw-fs-micro); line-height: var(--cw-lh-micro); font-weight: var(--cw-fw-normal); color: var(--cw-subtle); }
.cw-arch-groups{ margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.cw-arch-group{ border-radius: var(--cw-radius-md); box-shadow: inset 0 0 0 .5px var(--cw-border-2); overflow: hidden; }
.cw-arch-grouphead{
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 38px; padding: 6px 12px;
  text-align: left; font-size: var(--cw-fs-sm); line-height: var(--cw-lh-sm);
}
.cw-arch-grouphead:hover{ background: var(--cw-hover); }
.cw-arch-group.is-open .cw-arch-grouphead{ background: var(--cw-sub); }
.cw-arch-grouphead .cw-caret{ color: var(--cw-subtle); transition: transform .15s; }
.cw-arch-group:not(.is-open) .cw-arch-grouphead .cw-caret{ transform: rotate(-90deg); }
.cw-arch-groupname{ font-weight: var(--cw-fw-medium); }
.cw-arch-gcount{
  margin-left: auto; min-width: 18px; padding: 0 6px; text-align: center;
  font-size: var(--cw-fs-micro); line-height: 15px; color: var(--cw-muted);
  background: var(--cw-module); border-radius: var(--cw-radius-pill);
}
.cw-arch-body{ border-top: .5px solid var(--cw-border); padding: 2px 0 6px; }
.cw-arch-day{ padding-bottom: 2px; }
.cw-arch-dayhead{
  padding: 8px 12px 4px; font-size: var(--cw-fs-micro); line-height: var(--cw-lh-micro);
  color: var(--cw-subtle); letter-spacing: .02em;
}
.cw-arch-row{ display: flex; align-items: center; gap: 10px; padding: 7px 12px 7px 22px; font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs); }
.cw-arch-row:hover{ background: var(--cw-hover); }
.cw-arch-row .t{ flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-arch-row .k{ max-width: 130px; overflow: hidden; text-overflow: ellipsis; color: var(--cw-subtle); white-space: nowrap; }
.cw-arch-row button{ height: 24px; padding: 0 9px; border: 0; border-radius: var(--cw-radius-sm); box-shadow: inset 0 0 0 .5px var(--cw-border-2); font-size: var(--cw-fs-xs); white-space: nowrap; }
.cw-arch-row button:hover{ background: var(--cw-hover); }
.cw-set-note{
  margin-top: 12px; padding: 10px 12px; border: .5px dashed var(--cw-border-3);
  border-radius: var(--cw-radius-md); font-size: var(--cw-fs-xs); color: var(--cw-subtle); line-height: 1.7;
}
.cw-empty-note{ text-align: center; padding: 24px 0; font-size: var(--cw-fs-sm); color: var(--cw-subtle); }
/* 路径要能选中复制（排查「数据目录不对」时第一件事就是把它贴出来） */
.cw-set-path{
  margin-top: 8px; padding: 8px 10px; font-family: var(--cw-mono, ui-monospace, Consolas, monospace);
  font-size: var(--cw-fs-micro); line-height: 1.6; color: var(--cw-text-2, var(--cw-text));
  word-break: break-all; user-select: text; border-style: solid;
}
.cw-arch-actions{ display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.cw-arch-actions-note{ flex: 1; font-size: var(--cw-fs-xs); }
.cw-arch-actions button{ height: 28px; padding: 0 12px; border: 0; border-radius: var(--cw-radius-sm); font-size: var(--cw-fs-xs); box-shadow: inset 0 0 0 .5px var(--cw-border-2); }
.cw-arch-actions button:hover{ background: var(--cw-hover); }

/* 设置：升级 */
.cw-upd-sec{ margin-top: 22px; padding-top: 18px; border-top: .5px solid var(--cw-border); }
.cw-upd{
  display: flex; align-items: center; gap: 12px; padding: 12px 14px; margin-top: 10px;
  border-radius: var(--cw-radius-md); background: var(--cw-sub); box-shadow: inset 0 0 0 .5px var(--cw-border);
}
.cw-upd-logo{
  width: 34px; height: 34px; flex: none; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  background: var(--cw-module); color: var(--cw-text);
}
.cw-upd-logo .cw-ic{ width: 18px; height: 18px; }
.cw-upd-meta{ flex: 1; min-width: 0; }
.cw-upd-name{ display: flex; align-items: center; gap: 7px; font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); line-height: var(--cw-lh-sm); }
.cw-upd-ver{ display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; font-size: var(--cw-fs-xs); color: var(--cw-subtle); line-height: var(--cw-lh-xs); }
.cw-upd-ver .cur{ font-variant-numeric: tabular-nums; }
.cw-upd-compat{ margin-top: 2px; font-size: var(--cw-fs-micro); line-height: var(--cw-lh-micro); color: var(--cw-subtle); }
.cw-upd-compat.bad{ color: var(--cw-danger); }
.cw-upd-badge{ padding: 1px 7px; border-radius: var(--cw-radius-pill); background: var(--cw-danger); color: var(--cw-on-send); font-size: var(--cw-fs-micro); font-weight: var(--cw-fw-medium); white-space: nowrap; }
.cw-upd-badge.latest{ background: var(--cw-module); color: var(--cw-muted); }
.cw-upd-btn{
  height: 30px; padding: 0 14px; flex: none; border: 0; border-radius: var(--cw-radius-sm);
  background: var(--cw-accent); color: var(--cw-on-accent); font-size: var(--cw-fs-sm); font-weight: var(--cw-fw-medium); white-space: nowrap;
}
.cw-upd-btn:hover{ background: var(--cw-accent-hover); }
/* 「去下载」是链接不是按钮：去掉下划线，保持同样的按钮外观 */
a.cw-upd-btn{ display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }/* 升级命令：等宽字体、可横向滚动，配一个「复制」按钮 */
.cw-upd-cmd{ display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.cw-upd-cmd code{
  flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap;
  padding: 5px 8px; border-radius: var(--cw-radius-sm); background: var(--cw-code-bg);
  color: var(--cw-text); font-family: var(--cw-mono); font-size: var(--cw-fs-micro); line-height: 1.5;
}
.cw-upd-cmd button{ flex: none; }

/* 设置：footer 只留一个「完成」 */
.cw-set-foot{ display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: .5px solid var(--cw-border); background: var(--cw-sub); }
.cw-set-foot button{ height: 30px; padding: 0 12px; border: 0; border-radius: var(--cw-radius-sm); background: var(--cw-bg); color: var(--cw-text); font-size: var(--cw-fs-sm); box-shadow: inset 0 0 0 .5px var(--cw-border-3); }
.cw-set-foot button:hover{ background: var(--cw-hover); }

/* toast / 遮罩 / 响应式 */
.cw-toast{
  position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 120;
  display: flex; align-items: center; gap: 10px; max-width: 80%; padding: 8px 12px;
  border-radius: var(--cw-radius-md); background: var(--cw-menu-bg); backdrop-filter: var(--cw-menu-blur);
  color: var(--cw-text); font-size: var(--cw-fs-xs); line-height: var(--cw-lh-xs);
  box-shadow: var(--cw-elev-prominent); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
}
.cw-toast button{ padding: 1px 8px; border: 0; border-radius: 6px; box-shadow: inset 0 0 0 .5px var(--cw-border-3); font-size: var(--cw-fs-xs); color: inherit; }
.cw-backdrop{ position: absolute; inset: 0; z-index: 25; background: var(--dsw-alias-bg-mask-2); }
.cw-railbtn{ display: none; }

.cw-root[data-narrow="1"] .cw-insp{
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 30; width: 272px;
  box-shadow: var(--cw-elev-panel); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2); display: none; overflow-y: auto;
}
.cw-root[data-narrow="1"].cw-insp-open .cw-insp{ display: flex; }
.cw-root[data-compact="1"] .cw-rail{
  position: absolute; top: 0; left: 0; bottom: 0; z-index: 35; width: 272px;
  box-shadow: var(--cw-elev-panel); --dsw-elevation-stroke-color: var(--dsw-alias-border-l2); display: none;
}
.cw-root[data-compact="1"].cw-rail-open .cw-rail{ display: flex; }
.cw-root[data-compact="1"] .cw-railbtn{ display: inline-flex; }
.cw-root[data-compact="1"] .cw-project{ display: none; }
@media (max-width: 1180px){ .cw-tasks{ grid-template-columns: 1fr; } }

/* ============================ 缩放 / 窄窗口自适应 ============================
   Windows 把缩放调到 125% / 150% 时，窗口里可用的 CSS 宽度只剩物理宽度的
   80% / 67%（1920 → 1536 / 1280）。原来所有尺寸都是固定 px，行一窄就靠挤：
   药丸按钮里的字被顶出去、发送键被挤出可视区、工具条换行后压住输入框。
   下面按可用宽度分档收敛，保证「窄了只是更紧凑」，而不是互相顶撞。 */

/* 1) 输入卡底部这一行允许换行，并且换行后行高自己撑开（不然第二行会压住输入框） */
.cw-input-foot{ flex-wrap: wrap; row-gap: 6px; align-content: center; }
.cw-input-tools{ flex: 0 1 auto; }

/* 2) 药丸按钮（模型 / 计划 / 技能）：名字再长也不许把整行撑破 */
.cw-pillbtn, .cw-picker{ flex: 0 1 auto; min-width: 0; max-width: 42vw; }
.cw-pillbtn{ overflow: hidden; text-overflow: ellipsis; }

@media (max-width: 1180px){
  /* 栏宽跟着窗口走，别死占 250px */
  .cw-rail{ width: clamp(196px, 19vw, 250px); }
  .cw-dock{ padding: 8px 12px 10px; }
}

@media (max-width: 1040px){
  /* 右栏（检查器）也收敛一点，中间对话区优先 */
  .cw-insp{ width: 244px; }
  /* 再窄一档：药丸只留图标，省出约 90px 给输入框 */
  .cw-pillbtn .cw-pill-text{ display: none; }
  .cw-pillbtn{ padding: 0 8px; }
  .cw-picker{ max-width: 30vw; }
  .cw-editor{ min-height: 64px; }
}

/* 3) 高度不够时（1366×768 这类笔记本在 125% 下只剩约 614px 高），
      少留白、少露行，保证输入卡和最后一条消息同时看得见 */
@media (max-height: 720px){
  .cw-dock{ padding: 8px 12px 8px; }
  .cw-rail-head{ padding: 8px 10px 6px; }
  .cw-rail-title-row{ margin-bottom: 6px; }
  .cw-editor{ min-height: 56px; }
}
@keyframes cw-pulse{ 0%,100%{opacity:1} 50%{opacity:.3} }
@keyframes cw-spin{ to{ transform: rotate(360deg) } }
@keyframes cw-blink{ to{ opacity: 0 } }
@keyframes cw-in{ from{opacity:0; transform:translateY(4px)} to{opacity:1; transform:none} }
`;

    /* ------------------------------------------------------------- helpers */

    function inlineNodes(text) {
      const nodes = [];
      const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
      let last = 0;
      let match;
      let key = 0;
      while ((match = pattern.exec(text))) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('`')) {
          nodes.push(h('code', { key: 'c' + key++, className: 'inline' }, token.slice(1, -1)));
        } else if (token.startsWith('[')) {
          /* 链接：原来的 else 分支会把 `[文字](网址)` 当成加粗，slice(2,-2) 之后
             显示成「字](网」这样的乱码。只在 http(s) 下渲染成可点链接。 */
          const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(token);
          if (!link) {
            nodes.push(token);
          } else {
            const label = link[1] || link[2];
            const href = link[2].trim();
            nodes.push(/^https?:\/\//i.test(href)
              ? h('a', { key: 'a' + key++, className: 'inline-link', href, target: '_blank', rel: 'noreferrer noopener' }, label)
              : h('span', { key: 'a' + key++ }, label + ' (' + href + ')'));
          }
        } else {
          nodes.push(h('strong', { key: 'b' + key++ }, token.slice(2, -2)));
        }
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    /**
     * Markdown 渲染。对话气泡和右栏的 .md 预览共用这一份。
     * 支持：围栏代码块、标题（# ~ ####）、无序/有序列表、引用、分隔线、表格不处理；
     * 行内支持 `代码`、**粗体**、*斜体*、[文字](链接)。
     * 之前只认代码块，标题/列表/引用全按原文吐出，所以 md 文件在右栏里读起来像源码。
     */
    function Markdown({ text }) {
      const value = String(text || '');
      const blocks = value.split('```');
      const nodes = [];
      let key = 0;
      blocks.forEach((part, index) => {
        if (index % 2 === 1) {
          const firstBreak = part.indexOf('\n');
          const body = firstBreak >= 0 ? part.slice(firstBreak + 1) : part;
          nodes.push(h('pre', { key: 'pre' + key++ }, body.replace(/\n$/, '')));
          return;
        }
        const lines = part.split('\n');
        let list = null;
        const flushList = () => {
          if (!list) return;
          const tag = list.ordered ? 'ol' : 'ul';
          nodes.push(h(tag, { key: 'l' + key++, className: 'cw-md-list' },
            list.items.map((item, itemIndex) => h('li', { key: itemIndex }, inlineNodes(item)))));
          list = null;
        };
        for (const raw of lines) {
          const line = raw.replace(/\s+$/, '');
          if (!line.trim()) { flushList(); continue; }
          const heading = line.match(/^(#{1,4})\s+(.*)$/);
          if (heading) {
            flushList();
            nodes.push(h('div', { key: 'h' + key++, className: 'cw-md-h' + heading[1].length }, inlineNodes(heading[2])));
            continue;
          }
          if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushList(); nodes.push(h('hr', { key: 'hr' + key++, className: 'cw-md-hr' })); continue; }
          const quote = line.match(/^>\s?(.*)$/);
          if (quote) {
            flushList();
            nodes.push(h('blockquote', { key: 'q' + key++, className: 'cw-md-quote' }, inlineNodes(quote[1])));
            continue;
          }
          const bullet = line.match(/^\s*[-*]\s+(.*)$/);
          const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
          if (bullet || ordered) {
            const order = Boolean(ordered);
            if (!list || list.ordered !== order) { flushList(); list = { ordered: order, items: [] }; }
            list.items.push((bullet || ordered)[1]);
            continue;
          }
          flushList();
          nodes.push(h('p', { key: 'p' + key++, className: 'cw-md-p', style: { whiteSpace: 'pre-wrap' } }, inlineNodes(line)));
        }
        flushList();
      });
      return h('div', { className: 'cw-assist' }, nodes);
    }

    function ProviderTag({ provider }) {
      const meta = providerMeta(provider);
      return h('span', { className: 'cw-tag ' + provider },
        h(Icon, { name: provider === 'codex' ? 'terminal' : 'brain' }),
        meta.short);
    }

    function StatusBadge({ session }) {
      const status = statusOf(session);
      return h('span', { className: 'cw-st ' + status.key }, h('i', { className: 'cw-sdot' }), status.label);
    }

    /* 归档会话按「哪一天归档的」分词：只认日界，不跨天滚动。 */
    function archiveDay(ts) {
      const value = Number(ts);
      if (!Number.isFinite(value) || value <= 0) return { key: 'unknown', label: '更早' };
      const date = new Date(value);
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const days = Math.round((todayStart - start) / 86400000);
      if (days <= 0) return { key: 'd0', label: '今天' };
      if (days === 1) return { key: 'd1', label: '昨天' };
      if (days < 7) return { key: 'd7', label: '最近 7 天' };
      if (days < 30) return { key: 'd30', label: '最近 30 天' };
      return { key: 'old', label: '更早' };
    }

    /**
     * 设置里的「已归档」：按助手（Claude Code / Codex）分组，每组默认收起，
     * 标题行给出数量，点一下展开某天的归档。搜索时保持各组的展开状态不变。
     */
    function ArchivedList({ sessions, query, onRestore }) {
      const [open, setOpen] = useState({});
      const q = query.trim().toLowerCase();
      const matched = q
        ? sessions.filter((session) => (session.title + ' ' + session.provider + ' ' + session.cwd + ' ' + (session.archivedKind || '')).toLowerCase().includes(q))
        : sessions;
      if (sessions.length === 0) return h('div', { className: 'cw-empty-note' }, '暂无归档会话');
      if (matched.length === 0) return h('div', { className: 'cw-empty-note' }, '未找到匹配的归档会话');
      return h('div', { className: 'cw-arch-groups' },
        PROVIDERS.filter((provider) => sessions.some((session) => session.provider === provider.id)).map((provider) => {
          const own = matched.filter((session) => session.provider === provider.id);
          const total = sessions.filter((session) => session.provider === provider.id).length;
          const key = provider.id;
          const isOpen = Boolean(open[key]);
          const days = [];
          for (const session of own) {
            const day = archiveDay(session.archivedAt || session.updatedAt);
            let bucket = days.find((entry) => entry.key === day.key);
            if (!bucket) { bucket = { key: day.key, label: day.label, sessions: [] }; days.push(bucket); }
            bucket.sessions.push(session);
          }
          /* 同一天里最近归档的排前面；组顺序固定为 今天 → 昨天 → … → 更早。 */
          const order = { d0: 0, d1: 1, d7: 2, d30: 3, old: 4, unknown: 5 };
          days.sort((a, b) => (order[a.key] || 9) - (order[b.key] || 9));
          for (const bucket of days) bucket.sessions.sort((a, b) => (Number(b.archivedAt || b.updatedAt) || 0) - (Number(a.archivedAt || a.updatedAt) || 0));
          return h('div', { key, className: 'cw-arch-group' + (isOpen ? ' is-open' : '') },
            h('button', {
              type: 'button',
              className: 'cw-arch-grouphead',
              onClick: () => setOpen((current) => ({ ...current, [key]: !current[key] })),
              'aria-expanded': isOpen,
            },
            h(Icon, { name: 'chevDown', size: 12, className: 'cw-caret' }),
            h(Icon, { name: provider.id === 'claude' ? 'brain' : 'terminal', size: 14 }),
            h('span', { className: 'cw-arch-groupname' }, provider.label),
            h('span', { className: 'cw-arch-gcount' }, q ? own.length + ' / ' + total : total),
            ),
            isOpen
              ? h('div', { className: 'cw-arch-body' }, days.map((bucket) => h('div', { key: bucket.key, className: 'cw-arch-day' },
                h('div', { className: 'cw-arch-dayhead' }, bucket.label),
                bucket.sessions.map((session) => h('div', { key: session.id, className: 'cw-arch-row' },
                  h('span', { className: 't', title: session.title }, session.title),
                  h('span', { className: 'k', title: session.cwd }, basename(session.cwd) || ''),
                  h('button', { onClick: () => onRestore(session.id) }, '取消归档'),
                )),
              )))
              : null,
          );
        }),
      );
    }

    function ThinkLine({ item, tick }) {
      const [open, setOpen] = useState(false);
      const bodyId = useMemo(() => 'cw-think-' + Math.random().toString(36).slice(2, 8), []);
      const live = item.streaming;
      const seconds = item.durationMs || (live && item.at ? Date.now() - item.at : 0);
      return h('div', null,
        h('button', {
          className: 'cw-thinkline',
          onClick: () => setOpen(!open),
          'aria-expanded': open,
          'aria-controls': bodyId,
        },
          h(Icon, { name: 'brain' }),
          h('span', null, live ? '正在思考…' : '查看思考过程'),
          item.durationMs ? h('span', null, '· 用时 ' + fmtDuration(item.durationMs)) : null,
          h(Icon, { name: 'chev', size: 11 }),
        ),
        open ? h('div', { className: 'cw-think-note', id: bodyId }, item.text || '（暂无内容）') : null,
      );
    }

    function DiffBlock({ diff }) {
      const [open, setOpen] = useState(false);
      const bodyId = useMemo(() => 'cw-diff-' + Math.random().toString(36).slice(2, 8), []);
      if (!diff) return null;
      return h('div', { className: 'cw-diffmini' },
        h('button', {
          className: 'cw-diffmini-head',
          onClick: () => setOpen(!open),
          'aria-expanded': open,
          'aria-controls': bodyId,
        },
          h(Icon, { name: 'file', size: 13 }),
          h('span', { className: 'cw-path' }, basename(diff.path) || '改动'),
          h('span', { className: 'cw-stat' }, '+' + diff.added + ' −' + diff.removed),
          h(Icon, { name: 'chev', size: 11 }),
        ),
        open ? h('div', { className: 'cw-diff', id: bodyId },
          (diff.lines || []).map((line, index) => h('div', { key: index, className: 'cw-dline ' + line.t },
            h('span', { className: 'g' }, line.t === 'add' ? '+' : '−'),
            h('span', { className: 't' }, line.line),
          )),
        ) : null,
      );
    }

    function ProcCard({ tools, tick }) {
      const [open, setOpen] = useState(false);
      const bodyId = useMemo(() => 'cw-proc-' + Math.random().toString(36).slice(2, 8), []);
      const done = tools.filter((tool) => tool.status === 'done').length;
      const running = tools.filter((tool) => tool.status === 'running').length;
      const failed = tools.filter((tool) => tool.status === 'error').length;
      const verbs = [];
      for (const tool of tools) if (!verbs.includes(tool.verb)) verbs.push(tool.verb);
      const summary = (done ? '已完成 ' + done + ' 步' : '') +
        (running ? (done ? '，' : '') + running + ' 步进行中' : '') +
        (failed ? (done || running ? '，' : '') + failed + ' 步失败' : '') +
        ' · ' + verbs.join(' → ');
      return h('div', { className: 'cw-proc' + (open ? ' is-open' : '') },
        h('button', {
          className: 'cw-proc-head',
          onClick: () => setOpen(!open),
          'aria-expanded': open,
          'aria-controls': bodyId,
        },
          h('span', { className: 'cw-proc-badge' }, h(Icon, { name: running ? 'refresh' : 'check', size: 12 })),
          h('span', { className: 'cw-proc-summary' }, summary),
          h('span', { className: 'cw-proc-chev' }, h(Icon, { name: 'chev', size: 14 })),
        ),
        open ? h('div', { className: 'cw-proc-body', id: bodyId }, tools.map((tool) => {
          const elapsed = tool.status === 'running'
            ? Date.now() - (tool.startedAt || Date.now())
            : (tool.endedAt || Date.now()) - (tool.startedAt || Date.now());
          const cls = tool.status === 'done' ? 'done' : tool.status === 'error' ? 'error' : 'run';
          const label = decisionLabel(tool);
          return h('div', { key: tool.id },
            h('div', { className: 'cw-step' },
              h('span', { className: 'cw-step-ic' }, h(Icon, { name: tool.category || 'wrench', size: 12 })),
              h('span', { className: 'cw-step-name' }, tool.verb || tool.name),
              h('span', { className: 'cw-step-target' }, tool.target || ''),
              h('span', { className: 'cw-step-status ' + cls },
                tool.status === 'running' ? h('span', { className: 'cw-spin' }) : h(Icon, { name: tool.status === 'error' ? 'x' : 'check', size: 11 }),
                elapsed > 0 ? fmtDuration(elapsed) : '',
              ),
            ),
            label ? h('div', { className: 'cw-decision', style: { marginLeft: '28px', marginTop: '-2px', marginBottom: '4px' } }, label) : null,
            tool.diff ? h(DiffBlock, { diff: tool.diff }) : null,
          );
        })) : null,
      );
    }

    function AuditCard({ item }) {
      const failed = item.status === 'error' || item.isError;
      /* 失败时把 CLI 给的错误正文直接摊开，不用点——上次「并行检索报错」就是
         正文被折叠在「诊断摘要」里，看起来像没有原因。 */
      const [open, setOpen] = useState(false);
      const bodyId = useMemo(() => 'cw-audit-' + Math.random().toString(36).slice(2, 8), []);
      const code = item.exitCode == null ? (failed ? '失败' : '已执行') : ('已执行 · 退出码 ' + item.exitCode);
      const label = decisionLabel(item);
      const errorText = String(item.errorText || '').trim();
      const compact = item.input && item.input.command ? '命令: ' + item.input.command + '\n\n' : '';
      const detail = [
        errorText ? '错误:\n' + errorText : '',
        item.output ? '输出:\n' + item.output : (errorText ? '' : '（暂无输出）'),
        '退出码: ' + (item.exitCode == null ? '—' : item.exitCode),
        label ? '权限记录: ' + label : '',
      ].filter(Boolean).join('\n\n');
      return h('div', { className: 'cw-audit' + (failed ? ' is-failed' : '') },
        h('button', {
          className: 'cw-audit-head',
          onClick: () => setOpen(!open),
          'aria-expanded': open,
          'aria-controls': bodyId,
          /* 原来是展开后一行正文「Codex 无逐工具审批通道…」，长任务里反复刷屏。
             同样的信息放进 title：需要时 hover 就有，不占正文。 */
          title: failed
            ? '这一步执行失败；错误正文已展开'
            : '执行后的审计记录，不可审批',
        },
          h('span', { className: 'cw-audit-ic' + (failed ? ' error' : '') }, h(Icon, { name: failed ? 'x' : 'check', size: 13 })),
          h('span', { className: 'cw-audit-title' }, item.name + ' · ' + (item.target || '')),
          h('span', { className: 'cw-audit-code' }, failed ? code + ' · ' + (label || '执行失败') : code),
          h(Icon, { name: 'chev', size: 12, className: 'cw-audit-chev' }),
        ),
        errorText ? h('div', { className: 'cw-audit-error' }, errorText) : null,
        open ? h('div', { className: 'cw-audit-body', id: bodyId }, compact + detail) : null,
      );
    }

    function FileChangeCard({ item }) {
      const [open, setOpen] = useState(false);
      const bodyId = useMemo(() => 'cw-fc-' + Math.random().toString(36).slice(2, 8), []);
      const files = item.files || [];
      return h('div', { className: 'cw-audit' },
        h('button', {
          className: 'cw-audit-head',
          onClick: () => setOpen(!open),
          'aria-expanded': open,
          'aria-controls': bodyId,
        },
          h('span', { className: 'cw-audit-ic' }, h(Icon, { name: 'file', size: 13 })),
          h('span', { className: 'cw-audit-title' }, '文件改动 · ' + files.map((file) => basename(file)).join('、')),
          h('span', { className: 'cw-audit-code' }, '已执行 · ' + files.length + ' 个文件'),
          h(Icon, { name: 'chev', size: 12 }),
        ),
        open ? h('div', { className: 'cw-filechange-list', id: bodyId },
          files.length ? files.map((file) => h('div', { key: file, title: file }, file)) : h('div', null, '没有记录的改动'),
        ) : null,
      );
    }

    function ApprovalCard({ session, pending, tick, onDecide, result }) {
      const [reason, setReason] = useState('');
      const remaining = Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000));
      const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
      const seconds = String(remaining % 60).padStart(2, '0');
      const input = pending.input || {};
      const shown = typeof input.command === 'string' ? input.command : pretty(input);
      return h('div', { className: 'cw-approval' },
        h('div', { className: 'cw-ap-head' },
          h(Icon, { name: 'shield', size: 15 }),
          h('span', { className: 'cw-ap-title' }, '需要你的批准：' + pending.toolName),
          h('span', { className: 'cw-ap-time' }, remaining > 0 ? minutes + ':' + seconds + ' 后自动拒绝' : '已超时'),
        ),
        h('div', { className: 'cw-ap-body' },
          h('div', { className: 'cw-ap-row' },
            h('span', { className: 'cw-ap-key' }, '工具'),
            h('span', { className: 'cw-ap-val' }, pending.toolName),
          ),
          h('div', { className: 'cw-ap-row' },
            h('span', { className: 'cw-ap-key' }, '内容'),
            h('span', { className: 'cw-ap-val' }, h('div', { className: 'cw-cmd' }, shown)),
          ),
          h('div', { className: 'cw-ap-row' },
            h('span', { className: 'cw-ap-key' }, '影响'),
            h('span', { className: 'cw-ap-val' }, h('div', { className: 'cw-impact' }, pending.impact || '这次调用会在本机执行。')),
          ),
          result ? h('div', { className: 'cw-ap-resolved' }, result) : h(React.Fragment, null,
            h('input', {
              className: 'cw-ap-reason',
              placeholder: '拒绝理由（可选，会回传给模型）',
              value: reason,
              onChange: (event) => setReason(event.target.value),
              'aria-label': '拒绝理由',
            }),
            h('div', { className: 'cw-ap-actions' },
              h('button', { className: 'cw-btn primary', onClick: () => onDecide('allow', '') }, h(Icon, { name: 'check', size: 14 }), '允许本次'),
              h('button', { className: 'cw-btn', onClick: () => onDecide('always', '') }, h(Icon, { name: 'shield', size: 14 }), '本会话都允许'),
              h('button', { className: 'cw-btn danger', onClick: () => onDecide('deny', reason) }, h(Icon, { name: 'x', size: 14 }), '拒绝'),
            ),
          ),
        ),
      );
    }

    function ErrorCard({ item, onRetry }) {
      const [open, setOpen] = useState(false);
      // 标题按阶段区分：CLI 起不来和跑到一半断连是两回事，原来一律写「连接中断」，
      // 阶段明明写着「启动」，反而把排查方向带偏。
      const title = item.phase === '启动' ? 'CLI 启动失败' : 'CLI 连接中断，本轮已停止';
      return h('div', { className: 'cw-err' },
        h('div', { className: 'cw-err-head' }, h(Icon, { name: 'alert', size: 15 }), title),
        h('div', { className: 'cw-err-body' },
          h('div', { className: 'cw-err-diag' },
            h('span', { className: 'k' }, '阶段'), h('span', null, item.phase || '未知'),
            h('span', { className: 'k' }, '类别'), h('span', null, item.category || '未知'),
          ),
          h('div', { className: 'cw-err-note' }, '已保留的内容和文件改动不会回滚，可直接重试。'),
          h('div', { className: 'cw-ap-actions' },
            h('button', { className: 'cw-btn primary', onClick: onRetry },
              h(Icon, { name: 'refresh', size: 14 }), '重新连接并重试上一条'),
            h('button', { className: 'cw-btn', onClick: () => setOpen(!open), 'aria-expanded': open },
              h(Icon, { name: 'file', size: 14 }), open ? '收起诊断摘要' : '查看诊断摘要'),
          ),
          open ? h('div', { className: 'cw-cmd', style: { marginTop: '10px' } }, item.detail || '（没有更多诊断信息）') : null,
        ),
      );
    }

    function EmptyState({ provider, onPick }) {
      const meta = providerMeta(provider);
      const tasks = provider === 'codex'
        ? [
          ['优化订单导出性能', '把一次性拼接改成流式写入，别把内存打满'],
          ['排查类型错误', '跑一次构建，定位失败的模块并修好'],
          ['补一份项目说明', '读现有代码，生成 AGENTS.md 初稿'],
        ]
        : [
          ['修复登录 token 过期判断', '定位 session.ts 的逻辑错误并补测试'],
          ['给支付模块补单元测试', '覆盖签名校验与边界情况'],
          ['排查构建报错', '跑一次 build，定位失败原因'],
        ];
      return h('div', { className: 'cw-empty' },
        h('div', { className: 'cw-empty-mark' }, h(Icon, { name: 'grid', size: 25 })),
        h('h2', null, '选一个任务开始'),
        h('p', null, '当前绑定本机的 ' + meta.label + '。描述任务即可开始。'),
        h('div', { className: 'cw-tasks' }, tasks.map(([title, desc], index) => h('button', {
          key: index, className: 'cw-task', onClick: () => onPick(desc),
        }, h(Icon, { name: index === 0 ? 'file' : index === 1 ? 'wrench' : 'search', size: 15 }),
        h('div', null, h('b', null, title), h('span', null, desc))))),
      );
    }

    function FilesPanel({ tree, loading, onOpen, highlight }) {
      if (loading && !tree) return h('div', { className: 'cw-empty-note' }, '正在读取文件…');
      if (!tree) return h('div', { className: 'cw-empty-note' }, '还没有工作目录');
      return h('div', null,
        h('div', { className: 'cw-filehead' },
          h(Icon, { name: 'folder', size: 13 }),
          h('span', null, tree.rootName),
          h('span', { className: 'new-count' }, (Number(tree.newCount) || 0) + ' 个新文件'),
        ),
        h('div', null, (tree.entries || []).map((entry) => h('div', {
          key: entry.path,
          className: 'cw-tree-row ' + entry.type + (highlight === entry.path ? ' is-hi' : ''),
          style: { paddingLeft: (5 + entry.depth * 14) + 'px' },
          onClick: entry.type === 'file' ? () => onOpen(entry.path) : undefined,
          title: entry.path,
        },
        h(Icon, { name: entry.type === 'dir' ? 'folder' : entry.isNew ? 'file' : 'file', size: 13 }),
        h('span', { className: 'name' }, entry.name + (entry.type === 'dir' ? '/' : '')),
        entry.isNew ? h('span', { className: 'new-tag' }, '新') : null,
        ))),
        h('div', { className: 'cw-filetip' }, '标「新」的是本会话改过的文件。'),
      );
    }

    function PreviewPanel({ preview, onSave, onOpen, onLocate }) {
      if (!preview) {
        return h('div', { className: 'cw-empty-note' }, '点「文件」里的文件即可预览。');
      }
      if (preview.error && !preview.dataUrl && !preview.text) {
        return h('div', { className: 'cw-empty-note' }, preview.error);
      }
      const kind = String(preview.kind || 'file');
      const isImage = Boolean(preview.dataUrl);
      const isMarkdown = kind === 'markdown';
      const isHtml = kind === 'html';
      const isText = !isImage && !isMarkdown && !isHtml;
      const lineCount = String(preview.text || '').split('\n').length;
      return h('div', { className: 'cw-pv-wrap' },
        /* 文档类（md / html / 文本）铺满右栏并自己滚动；图片仍用固定高度的缩略框 */
        h('div', { className: 'cw-pv' + (isImage ? '' : ' is-doc') },
          isImage ? h('div', { className: 'cw-pv-canvas' }, h('img', { src: preview.dataUrl, alt: preview.name })) : null,
          h('div', { className: 'cw-pv-meta' },
            /* 标题与三个动作并排一行（动作缩成小图标按钮），不再占掉三行高度 */
            h('div', { className: 'cw-pv-head' },
              h('div', { className: 'cw-pv-name', title: preview.path || preview.name }, preview.name),
              h('div', { className: 'cw-pv-actions' },
                h('button', { type: 'button', title: '另存到本地', 'aria-label': '另存', onClick: onSave }, h(Icon, { name: 'save' })),
                h('button', { type: 'button', title: isHtml ? '在系统浏览器打开' : '用系统默认程序打开', 'aria-label': isHtml ? '浏览器打开' : '外部打开', onClick: onOpen }, h(Icon, { name: 'external' })),
                h('button', { type: 'button', title: '在文件树中定位', 'aria-label': '定位文件', onClick: onLocate }, h(Icon, { name: 'locate' })),
              ),
            ),
            h('div', { className: 'cw-pv-spec' },
              (preview.width ? preview.width + ' × ' + preview.height + ' px · ' : '') + fmtBytes(preview.size) + ' · '
              + (preview.lang || kind).toUpperCase() + (isImage ? '' : ' · ' + lineCount + ' 行')),
          ),
          /* Markdown 按正文渲染——之前把上百行源码塞进 132px 的框里，等于「看不了」 */
          isMarkdown ? h('div', { className: 'cw-pv-doc' }, h(Markdown, { text: String(preview.text || '') })) : null,
          /* HTML：网页里不能内嵌浏览器内核，但可以用沙箱 iframe 按页面渲染。
             用 sandbox="allow-scripts" 且不给 allow-same-origin：脚本能跑，但碰不到 DSH 的页面。 */
          isHtml ? h('div', { className: 'cw-pv-doc cw-pv-html' },
            h('iframe', {
              className: 'cw-pv-frame',
              title: preview.name,
              sandbox: 'allow-scripts allow-popups allow-forms allow-modals',
              srcDoc: String(preview.text || ''),
            }),
            h('div', { className: 'cw-pv-note' }, '沙箱渲染：脚本可运行，读不到 DSH 数据。'),
          ) : null,
          isText ? h('div', { className: 'cw-pv-doc' },
            h('pre', { className: 'cw-source cw-pv-code', 'data-lang': preview.lang || '' }, String(preview.text || '')),
          ) : null,
        ),
      );
    }

    /**
     * 输入框底部的用量读数组，结构照 DSH 的 composer.dock 统计 pill：
     * 一行紧凑读数，点开是小面板，不是右栏的一堆表。
     */
    function StatPill({ stat, icon, label, text, detail, title, titleValue, note, ring }) {
      const [open, setOpen] = useState(false);
      // Horizontal offset from the pill's own left edge. The panel hangs directly
      // above the pill (like the other composer popovers) and is only nudged left
      // when a 300px panel would cross the input card's right edge.
      const [shift, setShift] = useState(0);
      const wrapRef = useRef(null);
      const toggle = (event) => {
        if (open) { setOpen(false); return; }
        const dock = event.currentTarget.closest ? event.currentTarget.closest('.cw-dock') : null;
        if (dock) {
          const pill = event.currentTarget.getBoundingClientRect();
          const box = dock.getBoundingClientRect();
          const width = Math.min(300, Math.max(200, box.width - 24));
          const min = box.left + 12;
          const max = box.right - 12 - width;
          const target = Math.max(min, Math.min(pill.left, Math.max(min, max)));
          setShift(Math.round(target - pill.left));
        }
        setOpen(true);
      };
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
        const onScroll = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        document.addEventListener('scroll', onScroll, true);
        return () => {
          document.removeEventListener('pointerdown', onDown);
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('scroll', onScroll, true);
        };
      }, [open]);
      const hasDetail = Array.isArray(detail) && detail.length > 0;
      const content = h(React.Fragment, null,
        /* 上下文用一圈进度环代替普通图标：一眼看出还剩多少 */
        typeof ring === 'number'
          ? (() => {
            const pct = Math.max(0, Math.min(100, Math.round(ring)));
            const circumference = 2 * Math.PI * 5.6;
            return h('svg', {
              className: 'cw-ic cw-ring' + (pct >= 80 ? ' is-high' : ''),
              width: 14, height: 14, viewBox: '0 0 16 16',
              style: { width: '14px', height: '14px' },
              fill: 'none', stroke: 'currentColor', 'aria-hidden': 'true',
            },
              h('circle', { cx: 8, cy: 8, r: 5.6, className: 'cw-ring-track' }),
              h('circle', {
                cx: 8, cy: 8, r: 5.6, className: 'cw-ring-arc',
                strokeDasharray: circumference,
                strokeDashoffset: circumference * (1 - pct / 100),
                transform: 'rotate(-90 8 8)',
              }),
            );
          })()
          : h(Icon, { name: icon }),
        h('span', { className: 'cw-pill-label' }, label));
      return h('span', { className: 'cw-pillwrap', ref: wrapRef, 'data-composer-stat': stat },
        hasDetail
          ? h('button', {
            type: 'button',
            className: 'cw-pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': text,
            title: text,
            onClick: toggle,
          }, content)
          : h('span', { className: 'cw-pill', title: text, 'aria-label': text }, content),
        open && hasDetail ? h('div', { className: 'cw-statpanel', role: 'dialog', 'aria-label': title, style: { left: shift + 'px' } },
          h('div', { className: 'cw-statpanel-title' },
            h('span', null, h(Icon, { name: icon }), title),
            titleValue ? h('span', null, titleValue) : null,
          ),
          h('div', { className: 'cw-statpanel-rule', 'aria-hidden': 'true' }),
          h('dl', null, detail.map(([key, value]) => h(React.Fragment, { key }, h('dt', null, key), h('dd', null, value)))),
          note ? h('div', { className: 'cw-statpanel-note' }, note) : null,
        ) : null,
      );
    }

    function StatsRow({ session, items }) {
      const usage = session && session.usage;
      if (!session) return null;
      const live = session.status === 'running' || session.status === 'waiting';
      const output = Number(usage && usage.output) || 0;
      const promptTokens = usage
        ? (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0)
        : 0;
      const total = promptTokens + output;
      const speed = tokensPerSecond(usage);
      const cacheHit = cacheHitPercent(usage);
      const contextPct = usage && Number(usage.contextWindow) > 0
        ? Math.min(100, Math.round((Number(usage.contextUsed) || 0) / usage.contextWindow * 100))
        : null;
      const turns = (usage && Number(usage.turns)) || 0;
      const steps = (usage && Number(usage.steps)) || 0;
      const counting = items.filter((item) => item.kind === 'tool').length;

      // 1) 活动：轮/步 + 速度（速度没有真实解码耗时就不显示）
      const counts = live && !turns ? '本轮进行中' : (turns ? turns + ' 轮 · ' + (steps || counting) + ' 步' : null);
      const activityLabel = speed ? (counts ? counts + ' · ' + speed + ' tok/s' : speed + ' tok/s') : counts;
      const activityDetail = usage ? [
        ['轮/步', (turns || '—') + ' / ' + (steps || counting || '—')],
        ['本轮耗时', fmtDuration(usage.durationMs) || '—'],
        ['解码耗时', usage.decodeMs ? fmtDuration(usage.decodeMs) : '未上报'],
        ['速度', speed ? speed + ' tok/s' : '未上报'],
      ] : null;

      // 2) 用量：总 token + 缓存命中
      const usageLabel = total > 0
        ? fmtTokens(total) + (cacheHit !== null ? ' · 缓存 ' + cacheHit + '%' : '')
        : null;
      const usageDetail = usage ? [
        cacheHit !== null ? ['缓存命中', cacheHit + '%'] : null,
        ['输入', fmtExact(usage.input)],
        ['缓存读取', fmtExact(usage.cacheRead)],
        usage.cacheWrite ? ['缓存写入', fmtExact(usage.cacheWrite)] : null,
        ['输出', fmtExact(usage.output)],
        ['思考', fmtExact(usage.thinking)],
        ['本轮花费', usage.costUsd != null ? '$' + Number(usage.costUsd).toFixed(4) : '未上报'],
        ['模型', usage.model || session.model || '默认'],
      ].filter(Boolean) : null;

      // 3) 上下文占用
      //    有窗口大小时给「百分比 + 进度环」（跟 DSH 的 ContextMeter 一样是块表）；
      //    窗口大小是 CLI 侧才有的数字：Claude 在 result 事件里给，
      //    Codex 要从它自己的 rollout 记录里读。两边都没读到时就只报已用 token，
      //    绝不按模型名猜一个窗口出来凑百分比。
      const contextWindow = usage && Number(usage.contextWindow) > 0 ? Number(usage.contextWindow) : 0;
      const contextUsed = usage && Number(usage.contextUsed) > 0 ? Number(usage.contextUsed) : 0;
      const contextLabel = contextPct !== null
        ? '上下文 ' + contextPct + '%'
        : (contextUsed > 0 ? '上下文 ' + fmtTokens(contextUsed) : null);
      const contextDetail = contextPct !== null ? [
        ['已用', contextPct + '%'],
        ['已用 token', fmtExact(contextUsed)],
        ['窗口', fmtExact(contextWindow)],
        ['剩余', (100 - contextPct) + '%'],
      ] : (contextUsed > 0 ? [
        ['已用 token', fmtExact(contextUsed)],
        ['窗口', 'CLI 未上报'],
      ] : null);

      if (!activityLabel && !usageLabel && !contextLabel) return null;
      return h('div', { className: 'cw-stats', 'aria-label': '用量统计' },
        activityLabel ? h(StatPill, {
          stat: 'activity', icon: 'gauge', label: activityLabel,
          text: '运行统计：' + activityLabel, detail: activityDetail,
          title: '运行统计', titleValue: counts || '',
        }) : null,
        usageLabel ? h(StatPill, {
          stat: 'usage', icon: 'coin', label: usageLabel,
          text: 'token 用量：' + usageLabel, detail: usageDetail,
          title: 'token 用量', titleValue: fmtExact(total) + ' tokens',
        }) : null,
        contextLabel ? h(StatPill, {
          /* 上下文：有窗口大小时是进度环 + 百分比（跟 DSH 一样是块「表」），
             没有窗口大小时退回一个环形图标 + 已用 token。 */
          stat: 'context', icon: 'ring', label: contextLabel, ring: contextPct,
          text: '上下文占用：' + contextLabel, detail: contextDetail,
          title: '上下文占用', titleValue: contextPct !== null ? contextPct + '%' : fmtExact(contextUsed) + ' tokens',
        }) : null,
      );
    }

    /** 当前在干什么：右栏「运行状态」和输入框上方的状态条共用这一份判断。 */
    function activityOf(session, items) {
      const runningTool = [...items].reverse().find((item) => item.kind === 'tool' && item.status === 'running');
      const pending = session && session.pending;
      const usage = session && session.usage;
      const toolCount = items.filter((item) => item.kind === 'tool').length;
      if (!session) return { icon: 'gauge', spin: false, title: '未选择会话', note: '先在左侧新建或选择一个会话' };
      if (session.status === 'waiting' && pending) {
        return {
          icon: 'clock',
          spin: false,
          title: '等待审批 · ' + pending.toolName,
          note: pending.input && pending.input.command ? clip(pending.input.command, 120) : (pending.impact || '等待你确认这次工具调用'),
        };
      }
      if (runningTool) return { icon: 'refresh', spin: true, title: runningTool.verb + ' · ' + runningTool.name, note: runningTool.target || '' };
      /* 拉起进程 / 等首字这两个阶段，原先会落到最后的「空闲 · 没有正在执行的工具」——
         实测冷启动到首个事件约 5 秒，那几秒里界面说着「空闲」是错的。这里如实分段：
         阶段由 Host 的 turnPhase 给，不是猜的进度。 */
      if (session.status === 'running' && (session.turnPhase === 'spawn' || session.turnPhase === 'waiting')) {
        const label = providerMeta(session.provider).label;
        if (session.turnPhase === 'spawn') {
          return { icon: 'terminal', spin: true, pulse: true, title: '启动 ' + label + ' 进程…', note: '首次启动通常要几秒' };
        }
        return { icon: 'clock', spin: true, pulse: true, title: '已连接，等待首个字…', note: 'CLI 正在读取上下文并向模型发起请求' };
      }
      if (session.status === 'error') return { icon: 'alert', spin: false, title: '已停止 · ' + ((session.error && session.error.category) || '连接中断'), note: '内容与文件改动已保留，可在对话里重试' };
      if (toolCount) return { icon: 'check', spin: false, title: '已完成本轮', note: '本轮 ' + toolCount + ' 次工具调用' + (usage && usage.durationMs ? ' · 用时 ' + fmtDuration(usage.durationMs) : '') };
      return { icon: 'check', spin: false, title: '空闲', note: '没有正在执行的工具' };
    }

    /**
     * 运行状态行：贴在对话正文的最后一行（DSH 就是这么做的——它的
     * `RunningStatus` 挂在当前轮内容之后，写「深度思考中 / 已工作 1 分 20 秒」）。
     * 输入框上方那条位置在 DSH 里是任务清单停靠区，所以状态条搬到这里，
     * 不跟任务清单抢地方，也不会点一下就把右栏开关一次。
     */
    function RunningLine({ session, items, tick }) {
      if (!session || (session.status !== 'running' && session.status !== 'waiting')) return null;
      const now = activityOf(session, items);
      const lastUser = [...items].reverse().find((item) => item.kind === 'user' && item.at);
      const elapsed = lastUser && lastUser.at ? Math.max(0, Math.round((tick - lastUser.at) / 1000)) : 0;
      return h('div', { className: 'cw-runningline', role: 'status' },
        /* pulse：等待类阶段用呼吸圆点，比转圈更「安静」，也和真实阶段的文案配套 */
        now.pulse ? h('span', { className: 'cw-pulse', 'aria-hidden': 'true' })
          : now.spin ? h('span', { className: 'cw-spin' }) : h(Icon, { name: now.icon, size: 13 }),
        h('span', { className: 'cw-runningline-text' }, now.title),
        now.note ? h('span', { className: 'cw-runningline-note' }, clip(now.note, 90)) : null,
        elapsed ? h('span', { className: 'cw-runningline-time' }, fmtDuration(elapsed * 1000)) : null,
      );
    }

    function RunPanel({ session, items, tick, tree, onRefresh, onRevokeTool, onEditRules }) {
      const pending = session && session.pending;
      const usage = session && session.usage;
      const toolCount = items.filter((item) => item.kind === 'tool').length;
      const terminals = items.filter((item) => item.kind === 'tool' && item.category === 'terminal' && item.status === 'running');
      const now = activityOf(session, items);
      const allowed = (session && session.allowedTools) || [];
      /* 指令文件按助手区分：Claude 读 CLAUDE.md，Codex 读 AGENTS.md。
         两级都有：用户级（家目录，对所有项目生效）和项目级（当前目录）。 */
      const ruleLabel = (session && session.provider === 'codex') ? 'AGENTS.md' : 'CLAUDE.md';
      const ruleRows = (tree && Array.isArray(tree.rules) ? tree.rules : [])
        .filter((entry) => !session || entry.provider === (session.provider || 'claude'));
      /* CLI 的提醒类输出（比如 Codex 的实验性开关警告）曾经被当成一轮失败推进对话，
         现在收到这里：右栏一条安静的小卡，不占正文、不改变会话状态。 */
      const advisories = (session && Array.isArray(session.advisories)) ? session.advisories.slice(-3) : [];
      return h('div', null,
        advisories.length ? h('div', { className: 'cw-sec' },
          h('div', { className: 'cw-sec-title' }, h(Icon, { name: 'alert', size: 13 }), '运行提示 ', h('span', null, advisories.length)),
          h('div', { className: 'cw-card' },
            advisories.map((entry, index) => h('div', { key: index, className: 'cw-taskrow', title: entry.text },
              h(Icon, { name: 'alert', size: 12 }),
              h('span', { className: 'cw-path', style: { fontFamily: 'inherit' } }, clip(entry.text, 90),
                h('span', { style: { display: 'block', color: 'var(--cw-subtle)', fontSize: 'var(--cw-fs-micro)' } }, timeAgo(entry.at) || '')),
            )),
          ),
        ) : null,
        h('div', { className: 'cw-sec' },
          h('div', { className: 'cw-sec-title' }, h(Icon, { name: 'gauge', size: 13 }), '当前活动'),
          h('div', { className: 'cw-card' },
            h('div', { className: 'cw-now' },
              now.spin ? h('span', { className: 'cw-spin' }) : h(Icon, { name: now.icon, size: 14 }),
              h('div', { style: { minWidth: 0 } },
                h('b', null, now.title),
                h('p', null, now.note),
              ),
            ),
          ),
        ),
        h('div', { className: 'cw-sec' },
          h('div', { className: 'cw-sec-title' }, h(Icon, { name: 'shield', size: 13 }), '本会话已放行'),
          h('div', { className: 'cw-card' },
            allowed.length
              ? allowed.map((name) => h('div', { key: name, className: 'cw-allow-row' },
                h(Icon, { name: 'check', size: 12 }),
                h('span', { className: 'cw-path', title: name }, name),
                h('button', { className: 'cw-chip sm', onClick: () => onRevokeTool(name) }, '撤销'),
              ))
              : h('div', { className: 'cw-taskrow' }, '审批时选「本会话都允许」的工具会出现在这里。'),
          ),
        ),
        h('div', { className: 'cw-sec' },
          h('div', { className: 'cw-sec-title' }, h(Icon, { name: 'terminal', size: 13 }), '后台任务 ', h('span', null, terminals.length)),
          h('div', { className: 'cw-card' },
            terminals.length
              ? terminals.map((tool) => h('div', { key: tool.id, className: 'cw-taskrow' },
                h('span', { className: 'cw-spin' }),
                h('span', { className: 'cw-path' }, tool.target || tool.name),
              ))
              : h('div', { className: 'cw-taskrow' }, '没有运行中的 shell'),
          ),
        ),
        h('div', { className: 'cw-sec' },
          h('div', { className: 'cw-sec-title' }, h(Icon, { name: 'file', size: 13 }), '指令文件'),
          h('div', { className: 'cw-card' },
            /* 两级都列出来：只显示项目级的时候，家目录里明明有 CLAUDE.md，
               这一栏还是写「未找到」，很容易看成「CLI 没读到任何指令」。 */
            ruleRows.length
              ? ruleRows.map((entry) => h('div', {
                key: entry.id,
                className: 'cw-mem ' + (entry.exists ? 'ok' : 'no'),
                title: entry.file,
              },
                h(Icon, { name: entry.exists ? 'check' : 'file', size: 13 }),
                (entry.scope === 'user' ? '用户级 ' : '项目级 ') + entry.label
                  + (entry.exists ? ' 已加载' : ' 未找到')))
              : h('div', { className: 'cw-mem no' },
                h(Icon, { name: 'file', size: 13 }), ruleLabel + ' 未找到'),
            h('div', { className: 'cw-mem-note' }, '用户级对所有项目生效，项目级只对当前目录生效。'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } },
              h('button', { className: 'cw-btn sm', onClick: onEditRules },
                h(Icon, { name: 'edit', size: 12 }), '编辑自定义规则'),
              h('button', { className: 'cw-btn sm', onClick: onRefresh },
                h(Icon, { name: 'refresh', size: 12 }), '刷新'),
            ),
          ),
        ),
      );
    }

    function PagePanel({ preview, onOpen, onCopy, onLocate }) {
      const isHtml = preview && preview.kind === 'html';
      const url = preview ? 'file:///' + String(preview.path).replace(/\\/g, '/') : '';
      return h('div', null,
        h('div', { className: 'cw-urlbar', title: url || '未选择文件' },
          h(Icon, { name: 'file', size: 11 }),
          h('span', null, url || '在「文件」里选择一个 HTML 文件'),
        ),
        h('div', { className: 'cw-sec', style: { marginTop: '10px' } },
          h('div', { className: 'cw-card' },
            isHtml
              ? h('pre', { className: 'cw-source' }, String(preview.text || '').slice(0, 3000))
              : h('div', { className: 'cw-page-note' }, '仅源码预览，看渲染结果请用系统浏览器。'),
          ),
        ),
        isHtml ? h('div', { className: 'cw-pv-actions-text' },
          h('button', { onClick: onOpen }, h(Icon, { name: 'external' }), '系统浏览器打开'),
          h('button', { onClick: onCopy }, h(Icon, { name: 'copy' }), '复制文件地址'),
          h('button', { onClick: onLocate }, h(Icon, { name: 'locate' }), '在文件里定位'),
        ) : null,
        h('div', { className: 'cw-page-note' }, '本地页面预览（仅源码）。'),
      );
    }

    /**
     * 自定义规则 / 系统提示词编辑入口。
     *
     * 先回答一个常见误解：CLAUDE.md 与 AGENTS.md 就是这件事的官方机制——
     * Claude 每次都读 CLAUDE.md，Codex 每次都读 AGENTS.md（工作区一份、用户级一份）。
     * 所以这里不发明新格式，只做四个文件的读写。内容原样存盘，不做「自动改写」：
     * 用户的语气和要求不该被插件二次加工。
     */
    function RulesDialog({ cwd, provider, initialTab, onClose, onToast }) {
      const dialogRef = useRef(null);
      useTrap(dialogRef);
      const [files, setFiles] = useState([]);
      const [loading, setLoading] = useState(true);
      const [tab, setTab] = useState(initialTab || '');
      const [draft, setDraft] = useState('');
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');

      const load = useCallback(async () => {
        try {
          // 只列当前助手自己的指令文件：Claude → CLAUDE.md，Codex → AGENTS.md
          const result = await api('/rules?cwd=' + encodeURIComponent(cwd || '') + '&provider=' + encodeURIComponent(provider || ''));
          const list = result.files || [];
          setFiles(list);
          setTab((current) => {
            const pick = list.find((entry) => entry.id === current) || list.find((entry) => entry.id === 'ws-claude')
              || list.find((entry) => entry.id === 'ws-agents') || list[0];
            setDraft(pick ? (pick.preview || '') : '');
            setDirty(false);
            return pick ? pick.id : '';
          });
        } catch (err) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      }, [cwd]);

      useEffect(() => { load(); }, [load]);

      const current = files.find((entry) => entry.id === tab) || null;

      const select = (entry) => {
        setTab(entry.id);
        setDraft(entry.preview || '');
        setDirty(false);
        setError('');
      };

      const save = async () => {
        if (!current) return;
        setSaving(true);
        setError('');
        try {
          const result = await api('/rules', { method: 'POST', body: JSON.stringify({ id: current.id, cwd, provider, content: draft }) });
          if (!result.ok) { setError(result.error || '保存失败'); return; }
          setFiles(result.files || files);
          setDirty(false);
          if (onToast) onToast('已写入 ' + current.label);
        } catch (err) {
          setError(err.message);
        } finally {
          setSaving(false);
        }
      };

      const template = current && current.provider === 'claude'
        ? ['## 语言', '', '- 始终用简体中文回答，思维链也用简体中文。', '- 代码、命令、路径、日志保持原样。', '', '## 我的要求', '', '- '].join('\n')
        : ['## 语言', '', '- 始终用简体中文回答，推理过程也用简体中文。', '- 代码、命令、路径、日志保持原样。', '', '## 我的要求', '', '- '].join('\n');

      return h('div', { className: 'cw-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'cw-dialog cw-rules-dialog', ref: dialogRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': '自定义规则' },
          h('div', { className: 'cw-dlg-head' },
            h(Icon, { name: 'file', size: 16 }),
            h('b', null, '自定义规则（系统提示词）'),
            h('button', { className: 'cw-iconbtn', onClick: onClose, 'aria-label': '关闭' }, h(Icon, { name: 'x' })),
          ),
          h('div', { className: 'cw-rules-note' }, 'CLI 每次会话都会读取这里的文件。'),
          loading
            ? h('div', { className: 'cw-empty-note' }, '正在读取…')
            : h('div', { className: 'cw-rules' },
              h('div', { className: 'cw-rules-tabs', role: 'tablist', 'aria-label': '指令文件' },
                files.map((entry) => h('button', {
                  key: entry.id,
                  className: 'cw-rules-tab' + (entry.id === tab ? ' is-active' : ''),
                  role: 'tab',
                  'aria-selected': entry.id === tab,
                  title: entry.file,
                  onClick: () => select(entry),
                },
                  h(Icon, { name: entry.provider === 'codex' ? 'terminal' : 'brain', size: 12 }),
                  h('span', { className: 'cw-rules-tab-name' }, entry.label),
                  entry.exists ? h('span', { className: 'cw-rules-dot' }) : h('span', { className: 'cw-rules-new' }, '新建'),
                )),
              ),
              current ? h('div', { className: 'cw-rules-body' },
                h('div', { className: 'cw-rules-path', title: current.file },
                  h(Icon, { name: 'folder', size: 11 }),
                  h('span', null, current.file),
                  current.exists ? h('span', { className: 'cw-rules-meta' }, fmtBytes(current.size)) : null,
                ),
                h('textarea', {
                  className: 'cw-rules-editor',
                  value: draft,
                  spellCheck: false,
                  placeholder: '这里写你的要求，例如「所有回答用简体中文，思维链也用中文」',
                  onChange: (event) => { setDraft(event.target.value); setDirty(true); },
                  'aria-label': '指令内容',
                }),
                error ? h('div', { className: 'cw-rules-error' }, error) : null,
                h('div', { className: 'cw-rules-actions' },
                  h('button', { className: 'cw-btn primary', disabled: saving || !dirty, onClick: save },
                    h(Icon, { name: 'save', size: 13 }), saving ? '写入中…' : (dirty ? '保存到文件' : '已保存')),
                  h('button', { className: 'cw-btn', onClick: () => { setDraft(template); setDirty(true); } }, '插入中文模板'),
                  draft === (current.preview || '') ? null : h('button', { className: 'cw-btn', onClick: () => { setDraft(current.preview || ''); setDirty(false); } }, '撤销修改'),
                  h('span', { className: 'cw-rules-hint' }, '原样写入，不转格式'),
                ),
              ) : null,
            ),
        ),
      );
    }

    /**
     * 会话右侧的「轮次条」：一根竖着的短横刻度，每个刻度代表你发过的一条消息。
     * 悬停显示那条消息（原样截断，不重写），点一下滚到它。
     * 行为参考 DSH 的 TurnNavigator：刻度固定在滚动区右缘、绝对定位、不占布局宽度。
     */
    function TurnRail({ items, scrollRef, provider }) {
      const [hover, setHover] = useState(null);
      const [activeId, setActiveId] = useState('');
      const users = useMemo(() => items.filter((item) => item.kind === 'user'), [items]);
      const frameRef = useRef(null);
      // 用「消息 id → DOM 节点」定位，而不是给每个节点加 ref（那样渲染循环更乱）
      const findNode = (id) => {
        const root = scrollRef && scrollRef.current;
        if (!root || !id) return null;
        return root.querySelector('[data-msg="' + id.replace(/["\\]/g, '') + '"]');
      };
      // 滚到某条消息：贴到滚动区顶部往下 12px，长消息也不会只看到尾巴
      const jumpTo = (id) => {
        const root = scrollRef && scrollRef.current;
        const node = findNode(id);
        if (!root || !node) return;
        const top = node.offsetTop - 12;
        root.scrollTo ? root.scrollTo({ top, behavior: 'smooth' }) : (root.scrollTop = top);
      };
      // 高亮「当前正在看的那一条」：滚动时找最后一个已经滚过顶部的用户消息
      useEffect(() => {
        const root = scrollRef && scrollRef.current;
        if (!root || !users.length) return undefined;
        let raf = 0;
        const onScroll = () => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            const line = root.scrollTop + 120;
            let current = users[0].id;
            for (const item of users) {
              const node = findNode(item.id);
              if (node && node.offsetTop <= line) current = item.id;
            }
            if (root.scrollHeight - root.scrollTop - root.clientHeight < 40) current = users[users.length - 1].id;
            setActiveId((previous) => (previous === current ? previous : current));
          });
        };
        onScroll();
        root.addEventListener('scroll', onScroll, { passive: true });
        return () => {
          root.removeEventListener('scroll', onScroll);
          if (raf) cancelAnimationFrame(raf);
        };
      }, [users, scrollRef]);
      if (users.length < 2) return null;
      const meta = providerMeta(provider);
      return h('div', { className: 'cw-turns', ref: frameRef, onMouseLeave: () => setHover(null) },
        h('div', { className: 'cw-turns-marks' },
          users.map((item, index) => {
            const active = item.id === activeId;
            return h('button', {
              key: item.id || index,
              type: 'button',
              className: 'cw-turns-mark' + (active ? ' is-active' : '') + (hover === item.id ? ' is-hover' : ''),
              'aria-label': '第 ' + (index + 1) + ' 条消息',
              onMouseEnter: () => setHover(item.id),
              onFocus: () => setHover(item.id),
              onClick: () => jumpTo(item.id),
            });
          }),
        ),
        hover ? (() => {
          const index = users.findIndex((item) => item.id === hover);
          const item = users[index];
          if (!item) return null;
          return h('div', { className: 'cw-turns-preview', role: 'tooltip' },
            h('div', { className: 'cw-turns-head' },
              h(Icon, { name: provider === 'codex' ? 'terminal' : 'brain', size: 12 }),
              '第 ' + (index + 1) + ' / ' + users.length + ' 条 · 你'),
            h('div', { className: 'cw-turns-text' }, clip(item.text || '(空消息)', 220)),
            h('div', { className: 'cw-turns-tip' }, timeAgo(item.at) || ''),
          );
        })() : null,
      );
    }

    /**
     * 任务清单：只从 CLI 自己的输出里读。Claude 的 TodoWrite 工具调用，
     * 以及 Codex 输出里的「- [ ] / - [x]」清单，都显示成 DSH 那样的可折叠进度卡。
     * 读不到就不画——不凭猜测补一条任务列表。
     */
    function todosOf(items) {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (!item) continue;
        if (item.kind === 'tool' && /TodoWrite/i.test(item.name || '') && item.input && Array.isArray(item.input.todos)) {
          const todos = item.input.todos.map((entry) => ({
            content: String(entry && entry.content || '').slice(0, 300),
            status: entry && entry.status === 'completed' ? 'completed' : entry && entry.status === 'in_progress' ? 'in_progress' : 'pending',
          })).filter((entry) => entry.content);
          if (todos.length) return todos;
        }
        if (item.kind === 'assistant' && item.text) {
          const picked = [];
          for (const line of String(item.text).split('\n')) {
            const match = line.match(/^\s*[-*]\s+\[([ xX~])\]\s+(.+)$/);
            if (match) {
              picked.push({
                content: match[2].trim().slice(0, 300),
                status: match[1] === 'x' || match[1] === 'X' ? 'completed' : match[1] === '~' ? 'in_progress' : 'pending',
              });
            }
          }
          if (picked.length >= 2) return picked;
        }
      }
      return null;
    }

    /** 进度卡：收起时一行「已完成 x · 进行中 y · 待办 z」，展开看完整清单。 */
    function TodoCard({ todos }) {
      const [open, setOpen] = useState(false);
      const done = todos.filter((todo) => todo.status === 'completed').length;
      const active = todos.filter((todo) => todo.status === 'in_progress').length;
      const pendingCount = todos.length - done - active;
      const parts = [];
      if (done) parts.push('已完成 ' + done);
      if (active) parts.push('进行中 ' + active);
      if (pendingCount) parts.push('待办 ' + pendingCount);
      return h('div', { className: 'cw-todo' },
        h('button', { type: 'button', className: 'cw-todo-head', 'aria-expanded': open, onClick: () => setOpen(!open) },
          h(Icon, { name: 'task', size: 14 }),
          h('span', { className: 'cw-todo-title' }, '任务清单'),
          h('span', { className: 'cw-todo-progress' }, parts.join(' · ')),
          h(Icon, { name: open ? 'chevDown' : 'chev', size: 12, className: 'cw-todo-chev' }),
        ),
        open ? h('ul', { className: 'cw-todo-list' },
          todos.map((todo, index) => h('li', { key: index, className: 'cw-todo-item', 'data-status': todo.status },
            h('span', { className: 'cw-todo-dot', 'aria-label': todo.status === 'completed' ? '已完成' : todo.status === 'in_progress' ? '进行中' : '待办' }),
            h('span', { className: 'cw-todo-text' }, todo.content),
          )),
        ) : null,
      );
    }

    function Inspector({ session, items, tick, tab, setTab, tree, treeLoading, preview, highlight, onOpenFile, onRefreshTree, onSave, onOpen, onLocate, onRevokeTool, onCopyPage, onEditRules, onClose }) {
      /* 右栏不再用四个等宽大按钮（拉宽之后每个都变成一大块，很难看）。
         照 DSH 右栏的做法：一条文档式标签条——「文件」一个固定页签，打开的文件
         按名字各占一个页签，像浏览器标签一样贴在一起，宽度跟内容走。 */
      const docs = [];
      if (preview) {
        const kindIcon = preview.kind === 'image' ? 'image' : preview.kind === 'html' ? 'globe' : 'file';
        docs.push({ id: 'preview', label: preview.name, icon: kindIcon, closable: true });
      }
      if (preview && preview.kind === 'html') docs.push({ id: 'page', label: '页面', icon: 'globe' });
      const move = (event) => {
        const list = ['files', ...docs.map((doc) => doc.id)];
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const index = list.indexOf(tab);
        const next = event.key === 'ArrowRight' ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
        setTab(list[next]);
      };
      const chip = (id, label, icon, closable) => h('button', {
        key: id,
        id: 'cw-tab-' + id,
        className: 'cw-chip-tab' + (tab === id ? ' is-active' : ''),
        onClick: () => setTab(id),
        onAuxClick: closable ? (event) => { if (event.button === 1) onOpenFile(null); } : undefined,
        role: 'tab',
        'aria-selected': tab === id,
        'aria-controls': 'cw-panel-' + id,
        tabIndex: tab === id ? 0 : -1,
        title: label,
      },
        h(Icon, { name: icon, size: 13 }),
        h('span', { className: 'cw-chip-label' }, label),
        closable ? h('span', {
          className: 'cw-chip-x',
          role: 'button',
          'aria-label': '关闭预览',
          onClick: (event) => { event.stopPropagation(); onOpenFile(null); },
        }, h(Icon, { name: 'x', size: 10 })) : null,
      );
      return h(React.Fragment, null,
        h('div', { className: 'cw-chipbar', role: 'tablist', 'aria-label': '右栏', onKeyDown: move },
          chip('files', '文件', 'tree', false),
          docs.map((doc) => chip(doc.id, doc.label, doc.icon, doc.closable)),
          h('span', { className: 'cw-chipbar-fill' }),
          tab === 'run' ? null : h('button', {
            className: 'cw-chipbar-tool' + (tab === 'run' ? ' is-on' : ''),
            title: '运行状态',
            'aria-label': '运行状态',
            onClick: () => setTab('run'),
          }, h(Icon, { name: 'gauge', size: 14 })),
          onClose ? h('button', {
            className: 'cw-chipbar-tool',
            title: '收起右栏',
            'aria-label': '收起右栏',
            onClick: onClose,
          }, h(Icon, { name: 'x', size: 13 })) : null,
        ),
        tab === 'run' ? h('div', { className: 'cw-runhead' },
          h(Icon, { name: 'gauge', size: 13 }),
          h('span', { className: 'cw-runhead-title' }, '运行状态'),
          h('button', { className: 'cw-btn sm', onClick: () => setTab('files') }, '看文件'),
        ) : null,
        h('div', {
          className: 'cw-insp-body',
          id: 'cw-panel-' + tab,
          role: 'tabpanel',
          'aria-labelledby': 'cw-tab-' + tab,
        },
          tab === 'run' ? h(RunPanel, { session, items, tick, tree, onRefresh: onRefreshTree, onRevokeTool, onEditRules }) : null,
          /* 预览标签还在、但文件已经被关掉：给一句提示而不是空白 */
          tab === 'preview' && preview ? h(PreviewPanel, { preview, onSave, onOpen, onLocate }) : null,
          tab === 'preview' && !preview ? h('div', { className: 'cw-empty-note' }, '在「文件」里点一个文件开始预览。') : null,
          tab === 'files' ? h(FilesPanel, { tree, loading: treeLoading, onOpen: onOpenFile, highlight }) : null,
          tab === 'page' ? h(PagePanel, { preview, onOpen, onCopy: copyPageUrl, onLocate }) : null,
        ),
      );
    }

    function SettingsDialog({ sessions, updates, boot, upgrading, defaultSettings, onCopy, onClose, onRestore, onRestoreAll, onUpgrade, onRefreshUpdates, onSaveDefaults }) {
      const [query, setQuery] = useState('');
      const dialogRef = useRef(null);
      useTrap(dialogRef);
      const [claudeMode, setClaudeMode] = useState((defaultSettings && defaultSettings.claudeMode) || 'manual');
      const [codexMode, setCodexMode] = useState((defaultSettings && defaultSettings.codexMode) || 'workspace-write');
      const [sandboxBackend, setSandboxBackend] = useState((defaultSettings && defaultSettings.codexSandboxBackend) || 'auto');
      /* 插件自身的版本号：本地目录安装时 DSH 不会提示更新，这里自己查一次。
         只在打开设置时查；Host 侧缓存 1 小时，不做轮询。 */
      const [selfVersion, setSelfVersion] = useState(null);
      /* 自动升级的进行状态：null / {phase:'running'} / {phase:'done', ok, error} */
      const [selfUpgrade, setSelfUpgrade] = useState(null);
      const [selfBusy, setSelfBusy] = useState(false);
      /* CLI 记录占用：打开设置时查一次（Host 侧扫目录并缓存 5 分钟）。 */
      const [disk, setDisk] = useState(null);
      const [diskFailed, setDiskFailed] = useState(false);
      useEffect(() => {
        let alive = true;
        api('/disk')
          .then((value) => { if (alive) setDisk(value); })
          .catch(() => { if (alive) setDiskFailed(true); });
        return () => { alive = false; };
      }, []);
      const checkSelf = useCallback(async (force) => {
        setSelfBusy(true);
        try {
          setSelfVersion(await api('/version' + (force ? '?force=1' : '')));
        } catch (error) {
          setSelfVersion({ current: '', latest: '', hasUpdate: false, error: error.message });
        } finally {
          setSelfBusy(false);
        }
      }, []);
      useEffect(() => { checkSelf(false); }, [checkSelf]);
      const sandboxState = boot && boot.providers && boot.providers.codex ? boot.providers.codex.sandbox : null;
      // 归档时间：老数据没有 archivedAt，用 updatedAt 兜底；排序也按它，别让「今天
      // 刚归档」的会话因为半个月没动过而被分到「更早」。
      const archived = sessions.filter((session) => session.archived)
        .sort((a, b) => (Number(b.archivedAt || b.updatedAt) || 0) - (Number(a.archivedAt || a.updatedAt) || 0));
      const entries = updates && updates.entries ? updates.entries : null;
      const hasUpdate = (id) => {
        if (!entries || !entries[id] || !entries[id].latest) return false;
        const current = boot && boot.providers && boot.providers[id] ? boot.providers[id].version : '';
        return Boolean(current) && entries[id].latest !== current;
      };
      return h('div', { className: 'cw-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'cw-dialog', ref: dialogRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': '设置' },
          h('div', { className: 'cw-dlg-head' },
            h(Icon, { name: 'settings', size: 16 }),
            h('b', null, '设置'),
            h('button', { className: 'cw-iconbtn', onClick: onClose, 'aria-label': '关闭' }, h(Icon, { name: 'x' })),
          ),
          h('div', { className: 'cw-dlg-body' },
            h('div', { className: 'cw-default-group' },
              h('div', { className: 'cw-sec-title' }, h(Icon, { name: 'shield', size: 13 }), '新建会话默认权限'),
              h('div', { className: 'cw-default-row' },
                h('span', { className: 'cw-default-key' }, 'Claude Code'),
                h('select', {
                  className: 'cw-select',
                  value: claudeMode,
                  onChange: (event) => setClaudeMode(event.target.value),
                  'aria-label': 'Claude Code 默认权限档位',
                }, CLAUDE_MODES.map((mode) => h('option', { key: mode.id, value: mode.id }, mode.label + ' · ' + mode.hint))),
              ),
              h('div', { className: 'cw-default-row' },
                h('span', { className: 'cw-default-key' }, 'Codex'),
                h('select', {
                  className: 'cw-select',
                  value: codexMode,
                  onChange: (event) => setCodexMode(event.target.value),
                  'aria-label': 'Codex 默认沙箱档位',
                }, CODEX_MODES.map((mode) => {
                const dead = unusableMode('codex', mode.id);
                return h('option', { key: mode.id, value: mode.id, disabled: dead },
                  mode.label + ' · ' + (dead ? '本机不可用（沙箱后端未启用）' : sandboxHint(mode)));
              })),
              ),
              h('div', { className: 'cw-default-row' },
                h('span', { className: 'cw-default-key' }, 'Codex 沙箱后端'),
                h('select', {
                  className: 'cw-select',
                  value: sandboxBackend,
                  onChange: (event) => setSandboxBackend(event.target.value),
                  'aria-label': 'Codex 沙箱后端',
                },
                  h('option', { value: 'auto' }, '自动 · 后端不可用时改用 unelevated（推荐）'),
                  h('option', { value: 'unelevated' }, 'unelevated · 受限令牌，无需管理员'),
                  h('option', { value: 'elevated' }, 'elevated · 最强隔离，首次运行要管理员授权'),
                ),
              ),
              h('div', { className: 'cw-default-note' }, '只影响新建的会话。'),
              h('div', { className: 'cw-default-note' }, sandboxState
                ? ('当前 Codex 沙箱后端：' + sandboxState.backend
                  + (sandboxState.override ? '（运行时自动追加 windows.sandbox="' + sandboxState.override + '"）' : '')
                  + (sandboxState.detail ? '。' + sandboxState.detail : ''))
                : '正在检测 Codex 沙箱后端…'),
              unusableMode('codex', codexMode)
                ? h('div', { className: 'cw-default-note', style: { color: 'var(--cw-danger)' } },
                  '沙箱不可用：只读/工作区写入无法执行命令。改用「完全访问」或启用 Windows 沙箱。')
                : null,
              h('button', { className: 'cw-btn primary', onClick: () => onSaveDefaults({ claudeMode, codexMode, codexSandboxBackend: sandboxBackend }) }, '保存默认'),
            ),
            h('div', { className: 'cw-set-title' },
              h(Icon, { name: 'archive', size: 14 }),
              '会话管理 · 已归档（' + archived.length + '）',
              archived.length
                ? h('span', { className: 'cw-set-title-note' }, '按助手分组，默认收起')
                : null,
            ),
            archived.length ? h('div', { className: 'cw-arch-search' },
              h(Icon, { name: 'search', size: 13 }),
              h('input', {
                value: query,
                onChange: (event) => setQuery(event.target.value),
                placeholder: '搜索归档会话…',
                'aria-label': '搜索归档会话',
              }),
              query ? h('button', { className: 'cw-chip', style: { height: '20px', padding: '0 5px' }, onClick: () => setQuery('') }, h(Icon, { name: 'x', size: 11 })) : null,
            ) : null,
            h(ArchivedList, { sessions: archived, query, onRestore }),
            archived.length ? h('div', { className: 'cw-arch-actions' },
              h('button', { style: { marginLeft: 'auto' }, onClick: onRestoreAll }, '全部取消归档'),
            ) : null,
            h('div', { className: 'cw-upd-sec' },
              h('div', { className: 'cw-set-title' },
                h(Icon, { name: 'refresh', size: 14 }),
                'CLI 版本与升级',
                h('button', { className: 'cw-chip sm', style: { marginLeft: 'auto' }, onClick: onRefreshUpdates }, '重新检测'),
              ),
              /* 插件自己：本地目录安装时 DSH 插件页不会给更新提示，这里如实显示。 */
              h('div', { className: 'cw-upd' },
                h('span', { className: 'cw-upd-logo' }, h(Icon, { name: 'grid', size: 17 })),
                h('div', { className: 'cw-upd-meta' },
                  h('div', { className: 'cw-upd-name' }, 'CLI 工作台',
                    h('span', { className: 'cw-upd-badge' + (selfVersion && selfVersion.hasUpdate ? '' : ' latest') },
                      !selfVersion ? '检查中…'
                        : selfVersion.hasUpdate ? '有新版本'
                          : selfVersion.latest ? '已是最新' : '无法检查')),
                  h('div', { className: 'cw-upd-ver' },
                    h('span', null, '当前 v' + ((selfVersion && selfVersion.current) || '?')),
                    selfVersion && selfVersion.hasUpdate ? h('span', null, '→ v' + selfVersion.latest) : null,
                    selfVersion && !selfVersion.latest && selfVersion.error
                      ? h('span', { title: selfVersion.error }, '读不到最新版本号')
                      : null,
                  ),
                  h('div', { className: 'cw-upd-compat' },
                    selfUpgrade && selfUpgrade.phase === 'done'
                      ? (selfUpgrade.ok
                        ? '已升级到 v' + (selfVersion && selfVersion.latest ? selfVersion.latest : '') + '。请重启 DSH 让新版本生效。'
                        : '升级失败：' + selfUpgrade.error)
                      : selfUpgrade && selfUpgrade.phase === 'running'
                        ? '正在下载并安装，请稍候（通常几秒）…'
                        : selfVersion && selfVersion.hasUpdate
                          ? (() => {
                            /* 更新手法取决于当初怎么装的——说错了用户会白折腾：
                               包安装（仓库地址 / tgz）能自动替换；目录安装只能覆盖文件。 */
                            if (selfVersion.install === 'package') {
                              return '这个安装方式支持直接升级，点右边的按钮即可。';
                            }
                            if (selfVersion.command) {
                              return '当前是目录安装，无法自动替换。可在终端执行下面这条命令升级。';
                            }
                            return '下载新版压缩包，解压覆盖到这个插件目录，然后刷新页面即可。';
                          })()
                          : '版本号来自项目仓库的 package.json，只在打开这个页面时查询一次。'),
                  /* 目录安装没有可复跑的命令，才把这行命令亮出来让人手动执行 */
                  selfVersion && selfVersion.hasUpdate && selfVersion.command && selfVersion.install !== 'package'
                    ? h('div', { className: 'cw-upd-cmd' },
                      h('code', null, selfVersion.command),
                      h('button', {
                        className: 'cw-btn sm',
                        onClick: () => onCopy(selfVersion.command, '命令已复制，粘贴到 PowerShell 里执行'),
                      }, '复制'),
                    )
                    : null,
                ),
                selfVersion && selfVersion.hasUpdate
                  ? (selfVersion.install === 'package'
                    ? h('button', {
                      className: 'cw-upd-btn',
                      disabled: selfUpgrade && selfUpgrade.phase === 'running',
                      onClick: async () => {
                        setSelfUpgrade({ phase: 'running' });
                        try {
                          const result = await api('/self-upgrade', { method: 'POST' });
                          setSelfUpgrade({ phase: 'done', ok: Boolean(result.ok), error: result.error || result.output || '' });
                          if (result.ok) await checkSelf(true);
                        } catch (error) {
                          setSelfUpgrade({ phase: 'done', ok: false, error: error.message });
                        }
                      },
                    }, selfUpgrade && selfUpgrade.phase === 'running' ? '升级中…' : '立即升级')
                    : h('a', {
                      className: 'cw-upd-btn',
                      /* 目录安装没法自动替换，只能给下载入口；指向国内可访问的 gitcode */
                      href: 'https://gitcode.com/yk1900/dsh-cli-workbench/releases',
                      target: '_blank',
                      rel: 'noreferrer',
                    }, '去下载'))
                  : h('button', { className: 'cw-upd-btn', disabled: selfBusy, onClick: () => checkSelf(true) },
                    selfBusy ? '检查中…' : '重新检查'),
              ),
              entries
                ? PROVIDERS.map((provider) => {
                  const info = boot && boot.providers ? boot.providers[provider.id] : null;
                  const entry = entries[provider.id] || {};
                  const latest = entry.latest || '';
                  const installed = Boolean(info && info.installed);
                  /* 三种「拿不到最新版」要分开写，别一律说成「检测失败」：
                     没装 CLI、没装 npm、npm 查询出错。整块显示失败会让人以为
                     插件连 CLI 都没认出来——实际版本号就在旁边写着。 */
                  const noNpm = entry.npm === false;
                  const failed = !noNpm && (Boolean(entry.error) || !latest);
                  const update = hasUpdate(provider.id);
                  const badge = !installed ? '未安装'
                    : noNpm ? '无法检查更新'
                      : failed ? '查询失败'
                        : update ? '有新版本' : '已是最新';
                  return h('div', { key: provider.id, className: 'cw-upd' },
                    h('span', { className: 'cw-upd-logo' }, h(Icon, { name: provider.id === 'claude' ? 'brain' : 'terminal', size: 17 })),
                    h('div', { className: 'cw-upd-meta' },
                      h('div', { className: 'cw-upd-name' }, provider.label,
                        h('span', { className: 'cw-upd-badge' + (update ? '' : ' latest') }, badge)),
                      h('div', { className: 'cw-upd-ver' },
                        h('span', null, '当前 ' + (info && info.version ? 'v' + info.version : '未安装')),
                        update ? h('span', null, '→ v' + latest) : null,
                        noNpm
                          ? h('span', { title: entry.error || '' }, '本机没有 npm，可用 CLI 自带命令升级')
                          : failed ? h('span', { title: entry.error || '' }, '未取到最新版本号') : null,
                      ),
                      info && info.compat
                        ? h('div', { className: 'cw-upd-compat' + (info.compat.ok ? '' : ' bad') },
                          info.compat.ok
                            ? '兼容性：已核对 ' + info.compat.checked + ' 项必需参数'
                            : '兼容性：缺少 ' + (info.compat.missing.length
                              ? info.compat.missing.map((item) => item.flag).join('、')
                              : '--help 读取失败'),
                          info.compat.degraded && info.compat.degraded.length
                            ? h('span', null, ' · 降级：' + info.compat.degraded.map((item) => item.flag).join('、') + ' 不可用（归档/删除会退化为软操作）')
                            : null)
                        : null,
                    ),
                    !installed
                      ? h('button', { className: 'cw-upd-btn', onClick: onRefreshUpdates }, '重新检测')
                      : noNpm || update
                        ? h('button', { className: 'cw-upd-btn', disabled: upgrading === provider.id, onClick: () => onUpgrade(provider.id) },
                          upgrading === provider.id ? '升级中…' : (noNpm ? '用 CLI 升级' : '升级'))
                        : h('button', { className: 'cw-upd-btn', disabled: true }, '已最新'),
                  );
                })
                : h('div', { className: 'cw-empty-note' }, updates && updates.error ? ('无法检测更新：' + updates.error) : '正在检测最新版本…'),
              h('div', { className: 'cw-set-note' }, '升级会安装最新稳定版，重启后生效。没装 npm 的机器改用 CLI 自带的 update 命令，不需要装 Node.js。'),
            ),
            h('div', { className: 'cw-upd-sec' },
              h('div', { className: 'cw-set-title' },
                h(Icon, { name: 'folder', size: 14 }),
                '数据存放位置',
                boot && boot.dataDirSource
                  ? h('span', { className: 'cw-set-title-note' },
                    boot.dataDirSource === 'profile' ? 'profile 目录' : '~/.dsh 回退目录')
                  : null,
              ),
              boot && boot.dataDir
                ? h('div', { className: 'cw-set-note cw-set-path' }, boot.dataDir)
                : null,
              /* CLI 自己的转录不在插件数据目录里，但同样占 C 盘，顺手给一行读数。
                 删除会话会连它们一起删（Claude 另有 30 天自动清理）。 */
              h('div', { className: 'cw-set-note' },
                disk && disk.claude && disk.codex
                  ? 'CLI 记录占用：Claude ' + fmtBytes(disk.claude.bytes) + '（' + disk.claude.files + ' 个）· Codex '
                    + fmtBytes(disk.codex.bytes) + '（' + disk.codex.files + ' 个）'
                    + (disk.attachments && disk.attachments.files ? ' · 附件 ' + fmtBytes(disk.attachments.bytes) : '')
                  : diskFailed ? 'CLI 记录占用：暂时读不到' : 'CLI 记录占用：统计中…'),
              h('div', { className: 'cw-set-note' }, '删除会话会一起清掉对应记录；Claude 默认只保留 30 天。'),
              boot && boot.storage && boot.storage.saveError
                ? h('div', { className: 'cw-set-note', style: { color: 'var(--cw-danger, #d9534f)' } },
                  '最近一次写盘失败：' + boot.storage.saveError + '（改动可能没有保存到磁盘）')
                : null,
            ),
          ),
          h('div', { className: 'cw-set-foot' },
            h('button', { onClick: onClose }, '完成'),
          ),
        ),
      );
    }

    /**
     * 插件自己的确认框。原生 window.confirm 在 Electron 里是浅灰 Win32 样式，
     * 和工作台圆角 / 发丝线 / 主按钮完全割裂，所以删除这类不可撤销的操作都走这里：
     * 遮罩 + 320px 对话框，行悬停用灰底，主按钮是 DSH 的发送色，危险操作染红。
     */
    function ConfirmDialog({ title, body, okLabel, cancelLabel = '取消', danger, busy, error, onCancel, onConfirm }) {
      const dialogRef = useRef(null);
      useTrap(dialogRef);
      return h('div', {
        className: 'cw-mask',
        onClick: (event) => { if (event.target === event.currentTarget && !busy) onCancel(); },
      },
      h('div', {
        className: 'cw-dialog cw-confirm',
        ref: dialogRef,
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-label': title,
      },
      h('div', { className: 'cw-confirm-body' },
        h('div', { className: 'cw-confirm-title' }, title),
        body ? h('div', { className: 'cw-confirm-text' }, body) : null,
        error ? h('div', { className: 'cw-confirm-error' }, error) : null,
      ),
      h('div', { className: 'cw-confirm-actions' },
        h('button', { className: 'cw-confirm-btn', onClick: onCancel, disabled: busy }, cancelLabel),
        h('button', {
          className: 'cw-confirm-btn primary' + (danger ? ' danger' : ''),
          onClick: onConfirm,
          disabled: busy,
          autoFocus: true,
        }, busy ? '处理中…' : okLabel),
      ),
      ),
      );
    }

    /** 插件自己的单行输入框（重命名会话 / 工作区、自定义模型），替代原生 prompt。 */
    function RenameDialog({ title, label, value, placeholder, hint, busy, error, onChange, onCancel, onConfirm }) {
      const dialogRef = useRef(null);
      const inputRef = useRef(null);
      useTrap(dialogRef);
      useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
      return h('div', {
        className: 'cw-mask',
        onClick: (event) => { if (event.target === event.currentTarget && !busy) onCancel(); },
      },
      h('div', { className: 'cw-dialog cw-confirm', ref: dialogRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { className: 'cw-confirm-body' },
          h('div', { className: 'cw-confirm-title' }, title),
          h('div', { className: 'cw-label', style: { marginTop: '12px' } }, label),
          h('input', {
            ref: inputRef,
            className: 'cw-textinput plain',
            value,
            placeholder: placeholder || '',
            onChange: (event) => onChange(event.target.value),
            onKeyDown: (event) => {
              if (event.nativeEvent && event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') onConfirm();
            },
            spellCheck: false,
            'aria-label': label,
          }),
          hint ? h('div', { className: 'cw-hintline' }, hint) : null,
          error ? h('div', { className: 'cw-confirm-error' }, error) : null,
        ),
        h('div', { className: 'cw-confirm-actions' },
          h('button', { className: 'cw-confirm-btn', onClick: onCancel, disabled: busy }, '取消'),
          h('button', { className: 'cw-confirm-btn primary', onClick: onConfirm, disabled: busy }, busy ? '保存中…' : '保存'),
        ),
      ),
      );
    }

    /**
     * DSH 的「删除工作区」确认框：只从工作台列表移除这个目录，工作区里的会话
     * 会落到「未分组」，磁盘上的文件与 CLI 会话记录都不动。
     */
    function WorkspaceDeleteDialog({ target, busy, error, onClose, onConfirm }) {
      const dialogRef = useRef(null);
      useTrap(dialogRef);
      const label = target.title || target.cwd;
      const who = providerMeta(target.provider).label;
      const other = providerMeta(target.provider === 'codex' ? 'claude' : 'codex').label;
      /* 另一侧还有会话时，Host 只会把这一侧记进 hiddenFor：全局登记留着，
         另一侧的会话继续按工作区分组。文案必须说清楚"删的是这一侧"。 */
      const hideOnly = Boolean(target.others);
      return h('div', {
        className: 'cw-mask',
        onClick: (event) => { if (event.target === event.currentTarget && !busy) onClose(); },
      },
      h('div', { className: 'cw-dialog narrow', ref: dialogRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': '删除工作区' },
        h('div', { className: 'cw-dlg-head' },
          h(Icon, { name: 'alert', size: 16 }),
          h('b', null, hideOnly ? '从这一侧移除工作区' : '删除工作区'),
          h('button', { className: 'cw-iconbtn', onClick: onClose, disabled: busy, 'aria-label': '关闭' }, h(Icon, { name: 'x' })),
        ),
        h('div', { className: 'cw-dlg-body' },
          h('div', { className: 'cw-ws-del-name' }, h(Icon, { name: 'folder', size: 15 }), label),
          h('div', { className: 'cw-hintline' }, hideOnly
            ? '只从 ' + who + ' 侧移除；本侧会话落到「未分组」，' + other + ' 侧仍按工作区分组（'
              + target.others + ' 个会话不受影响）。'
            : '只从列表移除；文件夹与会话保留，会话落到「未分组」。'),
          h('div', { className: 'cw-hintline', title: target.cwd }, target.cwd),
          busy ? h('div', { className: 'cw-set-note', role: 'status' }, '正在移除工作区…') : null,
          error ? h('div', { className: 'cw-ws-del-error', role: 'alert' }, error) : null,
        ),
        h('div', { className: 'cw-dlg-foot' },
          h('button', { onClick: onClose, disabled: busy }, '取消'),
          h('button', { className: 'danger', onClick: onConfirm, disabled: busy }, hideOnly ? '从 ' + who + ' 侧移除' : '删除工作区'),
        ),
      ),
      );
    }

    /**
     * 插件自己的目录选择器。
     *
     * 原来「浏览」依赖 DSH 的 ctx.uiWorkspace.pickDirectory()，而 DSH 的目录选择器
     * 会按运行环境装配成 native 或 browse 两种后端：browse 后端只有目录列表、
     * 没有「弹系统对话框」的能力，pick() 直接报 unavailable——外在表现就是
     * 点「浏览」毫无反应。这里不再依赖它，改为问 Host 要目录列表自己画。
     */
    function DirPicker({ initial, onPick, onClose }) {
      const [path, setPath] = useState(initial || '');
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const dialogRef = useRef(null);
      useTrap(dialogRef);

      const load = async (target) => {
        setBusy(true);
        setError('');
        try {
          const result = await api('/dirs' + (target ? '?path=' + encodeURIComponent(target) : ''));
          setData(result);
          if (result.path) setPath(result.path);
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

      useEffect(() => { load(initial || ''); }, []);

      const rows = data && Array.isArray(data.entries) ? data.entries : [];
      const roots = data && Array.isArray(data.roots) ? data.roots : [];
      return h('div', { className: 'cw-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'cw-dialog', ref: dialogRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择工作目录' },
          h('div', { className: 'cw-dlg-head' },
            h(Icon, { name: 'folder', size: 16 }),
            h('b', null, '选择工作目录'),
            h('button', { className: 'cw-iconbtn', onClick: onClose, 'aria-label': '关闭' }, h(Icon, { name: 'x' })),
          ),
          h('div', { className: 'cw-dlg-body' },
            h('div', { className: 'cw-inputrow' },
              h('input', {
                className: 'cw-textinput',
                value: path,
                spellCheck: false,
                placeholder: '输入完整路径后回车',
                onChange: (event) => setPath(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  load(path.trim());
                },
                'aria-label': '目录路径',
              }),
              h('button', { className: 'cw-btn', onClick: () => load(path.trim()) }, '前往'),
              data && data.parent ? h('button', { className: 'cw-btn', onClick: () => load(data.parent) }, '上级') : null,
            ),
            error ? h('div', { className: 'cw-rules-error' }, error) : null,
            h('div', { className: 'cw-dirlist' },
              busy ? h('div', { className: 'cw-empty-note' }, '读取中…') : null,
              !busy && roots.length
                ? roots.map((root) => h('button', {
                  key: root,
                  className: 'cw-diritem',
                  onClick: () => load(root),
                }, h(Icon, { name: 'folder', size: 13 }), root))
                : null,
              !busy && rows.map((dir) => h('button', {
                key: dir.path,
                className: 'cw-diritem',
                onClick: () => load(dir.path),
              }, h(Icon, { name: 'folder', size: 13 }), dir.name)),
              !busy && !rows.length && !roots.length ? h('div', { className: 'cw-empty-note' }, '这里没有子文件夹') : null,
              !busy && data && data.truncated ? h('div', { className: 'cw-empty-note' }, '只显示前 500 个文件夹，可用上面的路径直接输入') : null,
            ),
          ),
          h('div', { className: 'cw-dlg-foot' },
            h('button', { className: 'cw-btn', onClick: onClose }, '取消'),
            h('button', {
              className: 'cw-btn primary',
              disabled: busy || !data || !data.path,
              onClick: () => onPick(data.path),
            }, '用这个目录'),
          ),
        ),
      );
    }

    /**
     * 新建会话。助手**不由这里选**：它跟随顶部高亮的助手（选中哪个就建哪个），
     * 否则就会出现「在 Codex 工作区点新建、结果建出 Claude 会话」这种分裂。
     * 这里只确认目录和继承来的权限档位。
     */
    function NewSessionDialog({ boot, initial, defaults, onClose, onCreate }) {
      const provider = initial.provider || 'claude';
      const meta = providerMeta(provider);
      const [cwd, setCwd] = useState(initial.cwd || (boot ? boot.defaultCwd : ''));
      const [picking, setPicking] = useState(false);
      const [busy, setBusy] = useState(false);
      const inputRef = useRef(null);
      const dialogRef = useRef(null);
      useTrap(dialogRef);
      useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
      const browse = async () => {
        /* 先请 DSH 弹系统的目录选择器（资源管理器那个框）。它是 native 后端时最快、
           也最符合习惯；只有在没有这个能力（browse 后端会抛错）时才回落到内建列表。 */
        setBusy(true);
        try {
          if (workspaceApi && typeof workspaceApi.pickDirectory === 'function') {
            const picked = await workspaceApi.pickDirectory();
            setBusy(false);
            if (picked) setCwd(picked);
            return;   // 用户取消也到此为止，不再弹第二个选择器
          }
        } catch { /* 没有 native 选择器，走下面的内建列表 */ }
        setBusy(false);
        setPicking(true);
      };
      const create = async () => {
        if (busy) return;
        setBusy(true);
        try { await onCreate(provider, cwd.trim()); } finally { setBusy(false); }
      };
      return h('div', { className: 'cw-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'cw-dialog narrow', ref: dialogRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': '新建会话' },
          h('div', { className: 'cw-dlg-head' },
            h(Icon, { name: 'plus', size: 16 }),
            h('b', null, '新建 ' + meta.label + ' 会话'),
            h('button', { className: 'cw-iconbtn', onClick: onClose, 'aria-label': '关闭' }, h(Icon, { name: 'x' })),
          ),
          h('div', { className: 'cw-dlg-body' },
            h('div', { className: 'cw-field' },
              h('span', { className: 'cw-label' }, '助手'),
              h('div', { className: 'cw-assistant' + ' ' + provider },
                h(Icon, { name: provider === 'claude' ? 'brain' : 'terminal', size: 15 }),
                h('b', null, meta.label),
                h('span', null, '跟随顶部选中的助手'),
              ),
              h('div', { className: 'cw-hintline' }, '要换成 ' + providerMeta(provider === 'codex' ? 'claude' : 'codex').label + '，先关掉这个框，在顶部切换助手再点新建。'),
            ),
            h('div', { className: 'cw-field' },
              h('span', { className: 'cw-label' }, '工作目录'),
              h('div', { className: 'cw-inputrow' },
                h('input', {
                  ref: inputRef,
                  className: 'cw-textinput',
                  value: cwd,
                  onChange: (event) => setCwd(event.target.value),
                  spellCheck: false,
                  'aria-label': '工作目录',
                }),
                h('button', { className: 'cw-btn', onClick: browse }, h(Icon, { name: 'folder', size: 14 }), '浏览…'),
              ),
              h('div', { className: 'cw-hintline' }, '这个目录会成为左栏的一个工作区。'),
            ),
            h('div', { className: 'cw-field' },
              h('span', { className: 'cw-label' }, '权限（继承默认）'),
              h('div', { className: 'cw-default-note' },
                provider === 'codex'
                  ? '沙箱：' + ((CODEX_MODES.find((mode) => mode.id === (defaults && defaults.codexMode)) || CODEX_MODES[1]).label) +
                    '（可在设置里改默认，创建后也能在标题栏切换）'
                  : '权限：' + ((CLAUDE_MODES.find((mode) => mode.id === (defaults && defaults.claudeMode)) || CLAUDE_MODES[1]).label) +
                    '（可在设置里改默认，创建后也能在标题栏切换）'),
            ),
          ),
          h('div', { className: 'cw-dlg-foot' },
            h('button', { className: 'cw-btn', onClick: onClose }, '取消'),
            h('button', { className: 'cw-btn primary', disabled: busy || !cwd.trim(), onClick: create },
              h(Icon, { name: 'plus', size: 14 }), busy ? '创建中…' : '创建 ' + meta.label + ' 会话'),
          ),
        ),
        picking ? h(DirPicker, {
          initial: cwd,
          onClose: () => setPicking(false),
          onPick: (picked) => { setCwd(picked); setPicking(false); },
        }) : null,
      );
    }

    function ContextMenu({ menu, onClose, onAction }) {
      if (!menu) return null;
      return h('div', {
        className: 'cw-menu',
        style: { left: Math.min(menu.x, window.innerWidth - 180) + 'px', top: Math.min(menu.y, window.innerHeight - 260) + 'px' },
        onClick: (event) => event.stopPropagation(),
      },
        h('button', { onClick: () => onAction('pin') }, h(Icon, { name: 'pin' }), menu.session.pinned ? '取消置顶' : '置顶'),
        h('button', { onClick: () => onAction('rename') }, h(Icon, { name: 'edit' }), '重命名'),
        h('button', { onClick: () => onAction('openfolder') }, h(Icon, { name: 'folder' }), '打开文件夹'),
        h('button', { onClick: () => onAction('copyid') }, h(Icon, { name: 'copy' }), '复制 Session ID'),
        h('div', { className: 'cw-menu-sep' }),
        h('button', { onClick: () => onAction('batch') }, h(Icon, { name: 'task' }), '批量操作'),
        h('button', { onClick: () => onAction('archive') }, h(Icon, { name: 'archive' }), '归档'),
        h('button', { className: 'danger', onClick: () => onAction('delete') }, h(Icon, { name: 'trash' }), '删除'),
      );
    }

    /**
     * 左栏。顶部选中的助手（topProvider）是这个工作台的作用域：这里只列该助手的
     * 会话，也只列「装着该助手会话」的工作区。同一个目录可以被两个助手登记，所以
     * 每行的 `+` 和 🗑 都带上行所在的工作区目录，由外层按目录删。
     */
    function Rail({ sessions, workspaces, registryReady, currentId, provider, query, setQuery, fold, toggleFold, expandGroup, batch, selected, toggleSelect, selectAll, onNew, onNewIn, onAddWorkspace, onOpen, onMenu, onGroupMenu, onToggleSelect, onArchiveSelected, onDeleteSelected, onExitBatch }) {
      const meta = providerMeta(provider);
      const scoped = sessions.filter((session) => (session.provider || 'claude') === provider);
      const otherCount = sessions.filter((session) => !session.archived && (session.provider || 'claude') !== provider).length;
      const base = scoped.filter((session) => !session.archived);
      const q = query.trim().toLowerCase();
      const filtered = q
        ? base.filter((session) => (session.title + ' ' + session.provider + ' ' + session.cwd + ' ' + statusOf(session).label).toLowerCase().includes(q))
        : base;
      const scopedCwds = new Set(base.map((session) => String(session.cwd || '').toLowerCase()).filter(Boolean));
      // 工作区是分组的单位（跟 DSH 一样）：登记过的工作区即使还没有会话也占一行，
      // 被删掉的工作区里留下的会话落到「未分组」。hiddenFor 是「这一侧移除了，
      // 但另一个助手还在用」：登记仍然全局存在，只是不在当前助手这里显示。
      const visibleWorkspaces = (Array.isArray(workspaces) ? workspaces : [])
        .filter((entry) => !(Array.isArray(entry.hiddenFor) && entry.hiddenFor.includes(provider)));
      const registry = new Map(visibleWorkspaces.map((entry) => [String(entry.cwd || '').toLowerCase(), entry]));
      const groups = [];
      const groupOf = (key, cwd, title, workspace) => {
        const found = groups.find((entry) => entry.key.toLowerCase() === key.toLowerCase());
        if (found) return found;
        const group = { key, cwd, title, workspace, sessions: [] };
        groups.push(group);
        return group;
      };
      if (registry.size) {
        for (const entry of visibleWorkspaces) {
          const cwd = String(entry.cwd || '').toLowerCase();
          // 空工作区只属于「有该助手会话的目录」，或还没登记过任何会话的目录；
          // 另一个助手专用的目录不会出现在这里（否则点开会是个空壳）。
          const foreign = scopedCwds.size > 0 && !scopedCwds.has(cwd)
            && sessions.some((session) => String(session.cwd || '').toLowerCase() === cwd && (session.provider || 'claude') !== provider);
          if (foreign) continue;
          groupOf(String(entry.cwd), entry.cwd, entry.title || basename(entry.cwd), true);
        }
      }
      const loose = [];
      for (const session of filtered) {
        const key = String(session.cwd || '');
        const entry = registry.get(key.toLowerCase());
        if (entry) groupOf(String(entry.cwd), entry.cwd, entry.title || basename(entry.cwd), true).sessions.push(session);
        // 工作区清单可信时，没登记的会话一律进「未分组」。原来的兜底是「registry 为空
        // 就按会话目录自动分组」——用户把工作区删光后，每个目录都会重新长出一行假的
        // 「工作区」：长得一模一样，但 workspace=false，所以右键没有任何反应。
        else if (registryReady || registry.size) loose.push(session);
        else groupOf(key || '(无目录)', session.cwd || '(无目录)', basename(session.cwd) || session.cwd || '(无目录)', false).sessions.push(session);
      }
      let ungrouped = null;
      if (loose.length) {
        ungrouped = { key: '未分组', cwd: '', title: '未分组', workspace: false, sessions: loose };
      }
      const lastActivity = (group) => group.sessions.reduce((max, session) => Math.max(max, Number(session.updatedAt) || 0), 0);
      const ordered = groups
        .filter((group) => !q || group.sessions.length > 0)
        .sort((a, b) => lastActivity(b) - lastActivity(a) || a.title.localeCompare(b.title, 'zh-Hans-CN'));
      if (ungrouped) ordered.push(ungrouped);
      const limit = 4;
      const visible = [];
      for (const group of ordered) {
        const state = fold[group.key];
        if (state === 'collapsed') { visible.push({ type: 'group', group, visibleSessions: [], hidden: group.sessions.length }); continue; }
        const shown = state === 'open' ? group.sessions : group.sessions.slice(0, limit);
        visible.push({ type: 'group', group, visibleSessions: shown, hidden: group.sessions.length - shown.length });
      }
      const allVisible = filtered;
      // 「全选」只应勾选**界面上真的看得见**的那些：折叠组里和被 limit 截断的
      // 会话虽然属于当前过滤结果，但用户看不到，一起勾上再批量删就是误删。
      const shownIds = new Set();
      for (const entry of visible) for (const session of entry.visibleSessions) shownIds.add(session.id);
      const selectable = allVisible.filter((session) => shownIds.has(session.id));
      return h('aside', { className: 'cw-rail' + (batch ? ' batch' : ''), 'data-provider': provider },
        h('div', { className: 'cw-rail-head' },
          h('div', { className: 'cw-rail-title-row' },
            h('span', { className: 'cw-rail-title' }, (provider === 'codex' ? 'Codex' : 'Claude') + ' 会话'),
            /* 只有一个入口，就别让它当一枚无字图标：加文字说清是「添加工作区」。
               搜索框一直露在外面，原来那枚「聚焦搜索」图标是纯重复，已去掉。 */
            h('button', {
              className: 'cw-rail-add',
              title: '把目录添加为工作区（在里面建过会话的目录会自动出现）',
              'aria-label': '把目录添加为工作区',
              onClick: onAddWorkspace,
            }, h(Icon, { name: 'folder', size: 12 }), '添加工作区'),
          ),
          h('label', { className: 'cw-search' },
            h(Icon, { name: 'search', size: 14 }),
            h('input', {
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: '搜索会话或路径',
              'aria-label': '搜索会话',
            }),
            query ? h('button', { className: 'cw-clear', onClick: () => setQuery(''), 'aria-label': '清除搜索' }, h(Icon, { name: 'x', size: 12 })) : null,
          ),
          h('button', {
            className: 'cw-new',
            onClick: onNew,
            title: '在 ' + meta.label + ' 下新建会话',
          }, h(Icon, { name: 'plus', size: 14 }), '新建 ' + meta.label + ' 会话'),
        ),
        h('div', { className: 'cw-list' },
          visible.length === 0
            ? h('div', { className: 'cw-empty-search' }, q
              ? ('未找到「' + query.trim() + '」相关的会话')
              : ('还没有 ' + meta.label + ' 会话，点上面新建一个'))
            : null,
          visible.map((entry) => h(React.Fragment, { key: entry.group.key },
            h('div', {
              className: 'cw-group' + (fold[entry.group.key] === 'collapsed' ? ' is-collapsed' : '') + (entry.group.workspace ? ' is-workspace' : ''),
              onClick: () => toggleFold(entry.group.key),
              onContextMenu: entry.group.workspace
                ? (event) => { event.preventDefault(); onGroupMenu(entry.group, event.clientX, event.clientY); }
                : undefined,
              title: entry.group.workspace
                ? entry.group.cwd + '（右键：管理这个工作区）'
                : (fold[entry.group.key] === 'collapsed' ? '已收起，点击展开' : '点击收起'),
            },
            h(Icon, { name: 'chevDown', size: 11, className: 'cw-caret' }),
            h(Icon, {
              name: entry.group.workspace ? (fold[entry.group.key] === 'collapsed' ? 'folder' : 'folderOpen') : 'folder',
              size: 12,
              className: 'cw-gicon',
            }),
            h('span', { className: 'cw-gname' }, entry.group.title),
            entry.group.sessions.length ? h('span', { className: 'cw-gcount' }, entry.group.sessions.length) : null,
            entry.group.workspace ? h('span', { className: 'cw-group-actions' },
              h('button', {
                type: 'button',
                className: 'cw-ga',
                title: '在「' + entry.group.title + '」中新建会话',
                'aria-label': '在「' + entry.group.title + '」中新建会话',
                onClick: (event) => { event.stopPropagation(); onNewIn(entry.group.cwd); },
              }, h(Icon, { name: 'plus', size: 13 })),
              h('button', {
                type: 'button',
                className: 'cw-ga',
                title: '更多操作（重命名 / 打开文件夹 / 移除）',
                'aria-label': '工作区「' + entry.group.title + '」的更多操作',
                onClick: (event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  onGroupMenu(entry.group, rect.left, rect.bottom + 2);
                },
              }, h(Icon, { name: 'more', size: 13 })),
            ) : null,
            ),
            entry.visibleSessions.map((session) => h('div', {
              key: session.id,
              className: 'cw-sess' + (session.id === currentId ? ' is-active' : '')
                + (session.pinned ? ' is-pinned' : '')
                + (batch && selected.has(session.id) ? ' is-checked' : ''),
              role: batch ? 'checkbox' : undefined,
              'aria-checked': batch ? selected.has(session.id) : undefined,
              onContextMenu: (event) => { event.preventDefault(); onMenu(session, event.clientX, event.clientY); },
            },
            batch ? h('input', {
              type: 'checkbox',
              className: 'cw-sess-check',
              checked: selected.has(session.id),
              onChange: () => toggleSelect(session.id),
              'aria-label': '选择会话 ' + session.title,
            }) : null,
            h('button', {
              className: 'cw-sess-open',
              // 批量模式下点整行就是打钩/取消，不必再瞄准那个小方框
              onClick: (event) => {
                const extend = Boolean(event.ctrlKey || event.metaKey || event.shiftKey);
                if (batch) onToggleSelect(session.id, false);
                else onOpen(session.id, extend);
              },
              'aria-current': !batch && session.id === currentId ? 'true' : undefined,
            },
            h('span', { className: 'cw-sess-top' },
              h(ProviderTag, { provider: session.provider }),
              h('span', { className: 'cw-sess-title' }, session.title),
            ),
            h('span', { className: 'cw-sess-meta' },
              h(StatusBadge, { session }),
              h('span', null, (session.files && session.files.length ? '改 ' + session.files.length + ' 文件' : '')),
              h('span', null, timeAgo(session.updatedAt)),
            ),
            ),
            h('button', {
              className: 'cw-sess-more',
              onClick: (event) => { event.stopPropagation(); onMenu(session, event.clientX, event.clientY); },
              title: '更多操作',
              'aria-label': '更多操作：' + session.title,
            }, h(Icon, { name: 'more', size: 14 })),
            )),
            entry.hidden > 0 ? h('button', {
              key: 'more-' + entry.group.key,
              className: 'cw-more',
              // 「展开剩余」只负责展开：从默认/折叠档直接跳到全部展开。
              // 不能复用 toggleFold——它从默认态会走去 collapsed，正好把整组收起。
              onClick: () => expandGroup(entry.group.key),
            }, '展开剩余 ' + entry.hidden + ' 个会话') : null,
          )),
        ),
        batch ? h('div', { className: 'cw-batch' },
          h('span', { className: 'cw-bcount' }, '已选 ' + selected.size + ' 项'),
          h('button', { onClick: () => selectAll(selectable) }, '全选'),
          h('button', { onClick: onArchiveSelected }, '归档'),
          h('button', { className: 'danger', onClick: onDeleteSelected }, '删除'),
          h('button', { onClick: onExitBatch }, '退出'),
        ) : null,
        otherCount ? h('div', { className: 'cw-rail-foot', title: providerMeta(provider === 'codex' ? 'claude' : 'codex').label + ' 还有 ' + otherCount + ' 个会话，切到顶部另一个助手查看' },
          h(Icon, { name: 'shield', size: 13 }),
          '另有 ' + otherCount + ' 个 ' + providerMeta(provider === 'codex' ? 'claude' : 'codex').label + ' 会话，切到顶部查看',
        ) : null,
      );
    }

    /** 布局服务可选（ctx.layout），取不到就让「切回来自动重开面板」静默跳过。 */

    /**
     * 挂载/重新挂载时告诉 Host「我回来了」，取消它排期的回收。
     * 面板切走 → 宿主 ~1s 后回收插件（会杀 CLI）→ 再切回来时挂载先于回收，
     * 结果是插件先被回收再重载、任务被打断。挂载信号让 Host 把回收延后。
     */
    function useMountPing() {
      useEffect(() => {
        api('/unmount-cancel', { method: 'POST' }).catch(() => {});
      }, []);
    }

    function App() {
      /* 重新挂载立刻告诉 Host「别回收」，否则回到这里时会话列表要等重载才回来 */
      useMountPing();
      const [boot, setBoot] = useState(null);
      const [models, setModels] = useState(null);
      const [sessions, setSessions] = useState([]);
      const [currentId, setCurrentId] = useState(null);
      /* 顶部选中的助手决定整个工作台的范围：左栏、新建会话、空态、文件树都跟着它走。 */
      const [topProvider, setTopProvider] = useState('claude');
      const [detail, setDetail] = useState(null);
      /* 'live' = SSE 通着；'retrying' = 断了并在退避重连。界面要如实说，
         否则断线期间看起来和正常一样，用户在等一个永远不会来的回复。 */
      const [streamState, setStreamState] = useState('live');
      const [tick, setTick] = useState(0);
      const [query, setQuery] = useState('');
      /* 计划模式开关：不是 CLI 的 flag，而是发消息时给正文前面加一段计划指令。
         关掉以后立刻恢复普通对话（见 send）。 */
      const [planMode, setPlanMode] = useState(false);
      const [fold, setFold] = useState({});
      const [batch, setBatch] = useState(false);
      const [selected, setSelected] = useState(() => new Set());
      const [showNew, setShowNew] = useState(false);
      const [newInitial, setNewInitial] = useState({ provider: 'claude', cwd: '' });
      const [pendingPrompt, setPendingPrompt] = useState('');
      const [showSettings, setShowSettings] = useState(false);
      /* 切到别的面板时 DSH 会卸载本面板。这里记下当时的 URL，切回来时如果 DSH
         已经回到了某个会话（面板不再选中），就把面板重新打开——否则会看到
         「明明在会话列表里，工作台却被换成了聊天界面」。 */
      const readHref = () => {
        try { return typeof window !== 'undefined' && window.location ? String(window.location.href) : ''; } catch { return ''; }
      };
      const panelUrlRef = useRef(readHref());
      const panelInfo = layoutApi;
      useEffect(() => {
        const url = readHref();
        const wasHere = panelUrlRef.current !== '' && url.split('#')[0] === panelUrlRef.current.split('#')[0];
        panelUrlRef.current = url;
        if (!wasHere || !panelInfo) return;
        if (panelInfo.activePanelId === null) {
          try { panelInfo.selectPanel('cli-workbench'); } catch { /* layout owns it */ }
        }
      }, []);
      const [updates, setUpdates] = useState(null);
      const [defaults, setDefaults] = useState({ claudeMode: 'manual', codexMode: 'workspace-write' });
      const [upgrading, setUpgrading] = useState('');
      // 工作区登记表（Host 持久化）；新状态放在这里，保持前面状态的声明顺序稳定。
      const [workspaces, setWorkspaces] = useState([]);
      /* 工作区清单是否可信（服务端成功返回过）。不可信时左栏才退回「按会话目录分组」，
         这是给旧版 Host 的兜底；可信时没登记的会话一律进「未分组」。 */
      const [registryReady, setRegistryReady] = useState(false);
      // 统一入口：拿到服务端的工作区列表就整份替换，并标记清单可信。
      const applyWorkspaces = (list) => {
        if (!Array.isArray(list)) return;
        setWorkspaces(list);
        setRegistryReady(true);
      };
      const [wsDelete, setWsDelete] = useState(null);
      const [wsDeleting, setWsDeleting] = useState(false);
      const [wsDeleteError, setWsDeleteError] = useState('');
      /* 插件自己的确认框 / 重命名框 / 工作区右键菜单（替代原生 confirm / prompt） */
      const [confirmBox, setConfirmBox] = useState(null);
      const [renameBox, setRenameBox] = useState(null);
      const [groupMenu, setGroupMenu] = useState(null);
      const [wsRename, setWsRename] = useState(null);
      // 添加工作区用的目录选择器（插件自建，不依赖 DSH 的 pickDirectory）
      const [wsPickerOpen, setWsPickerOpen] = useState(false);
      const inspPref = useRef(undefined);
      if (inspPref.current === undefined) {
        let stored = '';
        try { stored = window.localStorage ? (window.localStorage.getItem('cw.inspOpen') || '') : ''; } catch { stored = ''; }
        inspPref.current = stored;
      }
      const firstMeasure = useRef(true);
      const [inspOpen, setInspOpen] = useState(inspPref.current === '' ? true : inspPref.current === '1');
      /* 右栏宽度可拖：默认 272，像 DSH 的右侧区域一样记住用户的手动宽度 */
      const inspWidthPref = useRef(undefined);
      if (inspWidthPref.current === undefined) {
        let stored = 0;
        try { stored = Number(window.localStorage ? window.localStorage.getItem('cw.inspWidth') : 0) || 0; } catch { stored = 0; }
        inspWidthPref.current = stored;
      }
      const [inspWidth, setInspWidth] = useState(inspWidthPref.current >= 240 ? inspWidthPref.current : 272);
      const inspDrag = useRef(null);
      /* 拖拽时挂在 window 上的 pointermove/pointerup 需要在卸载时摘掉：
         否则中途切走面板，onMove 会一直挂在 window 上，继续对已卸载的组件 setState。 */
      const dragCleanupRef = useRef(null);
      useEffect(() => () => {
        if (dragCleanupRef.current) dragCleanupRef.current();
      }, []);
      /* 「自定义规则」编辑器：CLAUDE.md / AGENTS.md 的读写入口 */
      const [rulesOpen, setRulesOpen] = useState(false);
      /* 右栏默认落在「文件」（跟 DSH 一样先看文件树）；「运行状态」在标签条右端的
         一个小图标按钮里，点一下切过去，不再抢默认视野。 */
      const [inspTab, setInspTab] = useState('files');
      const [tree, setTree] = useState(null);
      const [treeLoading, setTreeLoading] = useState(false);
      const [preview, setPreview] = useState(null);
      const [highlight, setHighlight] = useState('');
      const [ctxMenu, setCtxMenu] = useState(null);
      const [toast, setToast] = useState(null);
      const [noticeClosed, setNoticeClosed] = useState(false);
      /* 草稿按会话分开存：原来是一个全局字符串，切换到别的会话（或新建会话）
         会把上一个会话没发出去的内容带过去。 */
      const [drafts, setDrafts] = useState({});
      const draftKey = currentId || '__new__';
      const draft = drafts[draftKey] || '';
      // 保留 setDraft(value | fn) 的原用法，只是落到当前会话自己的槽位。
      const setDraft = (updater) => setDrafts((current) => {
        const previous = current[draftKey] || '';
        const next = typeof updater === 'function' ? updater(previous) : updater;
        if (next === previous) return current;
        return { ...current, [draftKey]: next };
      });
      /* 指定槽位写草稿：首条消息失败时要把内容落到「刚建出来的那个会话」上，
         而 setDraft 用的 draftKey 还是建会话之前的（新建态），写进去用户看不见。 */
      const setDraftFor = (key, value) => setDrafts((current) => ({ ...current, [key]: value }));
      const [fileRef, setFileRef] = useState('');
      /* 已引用的技能：输入框里只留 `/名字` 短令牌，卡片显示名字，正文由 Host 补 */
      const [skillRefs, setSkillRefs] = useState([]);
      /* 附件（粘贴的图片、选中的文件）跟草稿一样按会话分开存：
         切到别的会话不该把上一个会话的图带过去。 */
      const [attachMap, setAttachMap] = useState({});
      const attachments = attachMap[draftKey] || [];
      const setAttachments = (updater) => setAttachMap((current) => {
        const previous = current[draftKey] || [];
        const next = typeof updater === 'function' ? updater(previous) : updater;
        if (next === previous) return current;
        return { ...current, [draftKey]: next };
      });
      const [picker, setPicker] = useState(null);
      const [menu, setMenu] = useState(null);
      const [width, setWidth] = useState(1200);
      const [railOpen, setRailOpen] = useState(false);
      const [approvalResult, setApprovalResult] = useState(null);
      const rootRef = useRef(null);
      const scrollRef = useRef(null);
      const fileInputRef = useRef(null);
      /* 输入框换成 contenteditable 之后，正文由编辑器的 DOM 负责：这个 ref 既是
         「把草稿画进去」的目标，也是插入引用块、放光标的地方。 */
      const editorRef = useRef(null);
      /* 编辑器里最后一次的光标/选区：点「引用」时焦点已经在消息那边了，
         要靠它把引用插回原来打字的位置。 */
      const editorCaretRef = useRef(null);
      const [dragging, setDragging] = useState(false);
      const modelMenuRef = useRef(null);

      /* 模型浮层相对模型按钮居中：按钮很小、浮层很宽（533px 起），
         纯 CSS 的 left:50% + translateX(-50%) 会把左边顶出屏幕，
         所以量一次实际宽度再算：先按按钮中线居中，再夹进视口左右各 12px。
         用 layoutEffect 是为了在绘制前就摆好，不出现「先弹在左边再跳过去」。 */
      React.useLayoutEffect(() => {
        if (menu !== 'model') return;
        const element = modelMenuRef.current;
        const anchor = element && element.parentElement;
        if (!element || !anchor) return;
        const box = element.getBoundingClientRect();
        const base = anchor.getBoundingClientRect();
        const viewport = typeof window !== 'undefined' ? window.innerWidth : 0;
        // left 是相对锚点的偏移，所以最后要减掉锚点自身的左边距
        let left = (base.width - box.width) / 2;
        const min = 12 - base.left;
        const max = viewport - box.width - 12 - base.left;
        if (left > max) left = max;
        if (left < min) left = min;
        element.style.left = Math.round(left) + 'px';
      }, [menu]);

      /* 草稿跟着会话走，输入框高度也得跟着重算：
         否则切到短草稿会留着上一个会话的行数（空草稿还会撑着一大块）。 */
      useEffect(() => {
        const element = editorRef.current;
        if (!element) return;
        element.style.height = 'auto';
        element.style.height = Math.min(336, element.scrollHeight) + 'px';
      }, [draft, currentId]);

      const showToast = useCallback((text, action) => {
        setToast({ text, action, at: Date.now() });
      }, []);

      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(null), toast.action ? 5000 : 3000);
        return () => clearTimeout(timer);
      }, [toast]);

      const clockOn = Boolean(detail && detail.session
        && (detail.session.status === 'running' || detail.session.status === 'waiting' || detail.session.pending));
      useEffect(() => {
        if (!clockOn) return undefined;
        const timer = setInterval(() => setTick((value) => value + 1), 1000);
        return () => clearInterval(timer);
      }, [clockOn]);

      useEffect(() => {
        const element = rootRef.current;
        if (!element || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver((entries) => {
          const next = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 1200;
          setWidth(next);
          if (firstMeasure.current) {
            firstMeasure.current = false;
            if (inspPref.current === '') {
              const open = next >= 1180;
              setInspOpen(open);
              try { window.localStorage && window.localStorage.setItem('cw.inspOpen', open ? '1' : '0'); } catch { /* ignore */ }
            }
          }
        });
        observer.observe(element);
        return () => observer.disconnect();
      }, []);

      const toggleInspector = useCallback(() => {
        setInspOpen((current) => {
          const next = !current;
          inspPref.current = next ? '1' : '0';
          try { window.localStorage && window.localStorage.setItem('cw.inspOpen', next ? '1' : '0'); } catch { /* ignore */ }
          return next;
        });
      }, []);

      const refreshSessions = useCallback(async () => {
        try {
          const result = await api('/sessions');
          setSessions(result.sessions || []);
          return result.sessions || [];
        } catch { return []; }
      }, []);

      const loadTree = useCallback(async (sessionId) => {
        if (!sessionId) { setTree(null); return; }
        setTreeLoading(true);
        try {
          const result = await api('/fs/tree?session=' + encodeURIComponent(sessionId) + '&depth=2');
          setTree(result);
        } catch (error) {
          setTree(null);
        } finally {
          setTreeLoading(false);
        }
      }, []);

      const refreshUpdates = useCallback(async (force) => {
        try {
          const result = await api('/updates' + (force ? '?force=1' : ''));
          setUpdates(result);
        } catch (error) {
          setUpdates({ error: error.message });
        }
      }, []);

      /**
       * 首次加载拆成两段：会话/工作区/设置这类本地读写先到（毫秒级），
       * `/status` 要跑 claude/codex --version + --help 探测，慢；
       * 以前并在一起等，整个左栏都空着，状态灯一直「启动中」。
       * 现在会话列表先出来，状态灯等探测回来再点亮。
       */
      useEffect(() => {
        let alive = true;
        const warm = CACHE.boot;
        if (warm) {
          // 重新挂载：上次打开时的状态立刻用上，不闪「启动中」
          setBoot(warm);
          codexSandboxState = (warm.providers && warm.providers.codex && warm.providers.codex.sandbox) || null;
        }
        (async () => {
          try {
            const [list, modelInfo, defaults, spacesRaw] = await Promise.all([
              api('/sessions'), api('/models'), api('/settings'),
              // 旧版 Host 没有工作区注册表：那种情况下才退回「按会话目录分组」。
              api('/workspaces').then((value) => ({ ok: true, workspaces: value.workspaces || [] })).catch(() => ({ ok: false, workspaces: [] })),
            ]);
            const spaces = spacesRaw;
            if (!alive) return;
            setModels(modelInfo);
            setDefaults(defaults);
            if (spaces.ok) applyWorkspaces(spaces.workspaces);
            else setWorkspaces((warm && warm.workspaces) || []);
            setSessions(list.sessions || []);
            // 打开工作台时默认落在最近动过的那个助手上，左边选题材、右边看内容都对得上。
            const active = (list.sessions || []).filter((session) => !session.archived)
              .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
            const lead = active[0] || null;
            const provider = lead ? (lead.provider || 'claude') : 'claude';
            if (lead) setTopProvider(provider);
            const first = (list.sessions || []).find((session) => !session.archived && (session.provider || 'claude') === provider);
            if (first) setCurrentId(first.id);
            setNewInitial({ provider, cwd: first ? first.cwd : (warm ? warm.defaultCwd : '') });
          } catch (error) {
            if (alive) showToast('加载失败：' + error.message);
          }
        })();
        (async () => {
          try {
            const status = await api('/status');
            if (!alive) return;
            setBoot(status);
            CACHE.boot = status;
            codexSandboxState = (status && status.providers && status.providers.codex && status.providers.codex.sandbox) || null;
            const mismatched = PROVIDERS.filter((provider) => {
              const info = status.providers && status.providers[provider.id];
              return info && info.installed && info.compat && !info.compat.ok;
            });
            if (mismatched.length) {
              showToast('CLI 版本可能不兼容：' + mismatched.map((provider) => provider.label).join('、')
                + '，详见「设置 → CLI 版本与升级」');
            }
            setNewInitial((current) => (current.provider !== 'claude' || current.cwd !== ''
              ? current
              : { ...current, cwd: status.defaultCwd }));
          } catch (error) {
            /* 状态探测失败不挡住会话列表；状态灯保持「未连接」 */
          }
        })();
        refreshUpdates(false);
        return () => { alive = false; };
      }, [refreshUpdates, showToast]);

      useEffect(() => {
        const timer = setInterval(() => {
          refreshSessions();
        }, 3000);
        return () => clearInterval(timer);
      }, [refreshSessions]);

      useEffect(() => {
        setNoticeClosed(false);
      }, [currentId]);

      useEffect(() => {
        if (!currentId) { setDetail(null); return undefined; }
        let aborted = false;
        let controller = new AbortController();
        let attempt = 0;
        let retryTimer = null;
        api('/sessions/' + encodeURIComponent(currentId)).then((result) => {
          if (!aborted) setDetail({ session: result.session, items: result.items || [] });
        }).catch(() => {});
        const connect = async () => {
          while (!aborted) {
          try {
            controller = new AbortController();
            const response = await fetch(API + '/sessions/' + encodeURIComponent(currentId) + '/stream', {
              signal: controller.signal,
              headers: { accept: 'text/event-stream' },
            });
            if (!response.ok || !response.body) throw new Error('stream unavailable');
            attempt = 0;
            setStreamState('live');
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (!aborted) {
              const { value, done } = await reader.read();
              // 干净关闭（代理超时、Host 优雅断开）与异常一样要重连：
              // 原来直接 break 会让界面静默冻结在旧状态，用户完全无感知。
              if (done) throw new Error('stream closed');
              buffer += decoder.decode(value, { stream: true });
              let index;
              while ((index = buffer.indexOf('\n\n')) >= 0) {
                const chunk = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                for (const line of chunk.split('\n')) {
                  if (!line.startsWith('data: ')) continue;
                  let event;
                  try { event = JSON.parse(line.slice(6)); } catch { continue; }
                  if (event.type === 'snapshot') {
                    setDetail({ session: event.session, items: event.items || [] });
                    setSessions((list) => mergeSession(list, event.session));
                  } else if (event.type === 'session') {
                    setDetail((current) => current ? { ...current, session: event.session } : current);
                    setSessions((list) => mergeSession(list, event.session));
                  } else if (event.type === 'approval') {
                    setDetail((current) => current ? { ...current, session: { ...current.session, pending: event.pending } } : current);
                    // 只更新这条会话的 pending 字段。原来是展开 currentSessionRef 再覆盖 id，
                    // 切换会话的瞬间会把上一个会话的 title/provider 写到新会话头上。
                    setSessions((list) => list.map((item) => (item.id === currentId
                      ? { ...item, pending: event.pending, pendingCount: typeof event.pendingCount === 'number' ? event.pendingCount : (event.pending ? 1 : 0) }
                      : item)));
                    if (!event.pending) setApprovalResult(null);
                  } else if (event.type === 'item') {
                    setDetail((current) => {
                      if (!current) return current;
                      const items = current.items.filter((item) => item.id !== event.item.id);
                      return { ...current, items: [...items, event.item] };
                    });
                  } else if (event.type === 'delta') {
                    setDetail((current) => {
                      if (!current) return current;
                      return {
                        ...current,
                        items: current.items.map((item) => item.id === event.id ? { ...item, text: (item.text || '') + event.text } : item),
                      };
                    });
                  } else if (event.type === 'item-patch') {
                    setDetail((current) => {
                      if (!current) return current;
                      return {
                        ...current,
                        items: current.items.map((item) => item.id === event.id ? { ...item, ...event.patch } : item),
                      };
                    });
                  } else if (event.type === 'turn-end') {
                    refreshSessions();
                    loadTree(currentId);
                  }
                }
              }
            }
          } catch (error) {
            if (aborted) return;
            setStreamState('retrying');
            // 断线立刻补一次全量，别让界面停在旧状态；随后指数退避重连。
            try {
              const result = await api('/sessions/' + encodeURIComponent(currentId));
              if (!aborted) setDetail({ session: result.session, items: result.items || [] });
            } catch { /* Host 也不可达时保持现状 */ }
            attempt = Math.min(attempt + 1, 5);
            const delay = Math.min(8000, 400 * (2 ** attempt));
            await new Promise((resolve) => { retryTimer = setTimeout(resolve, delay); });
          }
          }
        };
        connect();
        return () => { aborted = true; if (retryTimer) clearTimeout(retryTimer); controller.abort(); };
      }, [currentId, loadTree, refreshSessions]);

      const currentSessionRef = useRef(null);
      currentSessionRef.current = detail && detail.session ? detail.session : sessions.find((session) => session.id === currentId) || null;

      useEffect(() => {
        setPreview(null);
        setHighlight('');
        if (currentId) loadTree(currentId);
        else setTree(null);
      }, [currentId, loadTree]);

      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          const target = event.target;
          const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return;
          // Overlay order: new-session dialog → settings → context menu → popovers.
          if (confirmBox) { setConfirmBox(null); return; }
          if (renameBox) { setRenameBox(null); return; }
          if (wsRename) { setWsRename(null); return; }
          if (groupMenu) { setGroupMenu(null); return; }
          if (showNew) { setShowNew(false); return; }
          if (showSettings) { setShowSettings(false); return; }
          if (ctxMenu) { setCtxMenu(null); return; }
          if (picker) { setPicker(null); return; }
          if (menu) { setMenu(null); return; }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [ctxMenu, showNew, showSettings, picker, menu, confirmBox, renameBox, wsRename, groupMenu]);

      const selectedSession = detail && detail.session ? detail.session : sessions.find((session) => session.id === currentId) || null;
      /* 会话只看属于当前助手的；切助手后列表里挑"最近那个会话"，没有就停在空态。 */
      const scopedActive = sessions
        .filter((session) => !session.archived && (session.provider || 'claude') === topProvider)
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
      const scopedCurrent = selectedSession && (selectedSession.provider || 'claude') === topProvider ? selectedSession : null;
      const viewSession = scopedCurrent || (scopedActive.find((session) => session.id === currentId) || null);
      const viewItems = scopedCurrent && detail && detail.session && detail.session.id === scopedCurrent.id ? (detail.items || []) : [];
      const items = viewItems;
      const currentProvider = topProvider;
      const pending = scopedCurrent ? scopedCurrent.pending : null;
      const status = statusOf(scopedCurrent);
      const narrow = width < 1180;
      const compact = width < 980;
      const lastItemText = items.length ? String(items[items.length - 1].text || '').length : 0;

      /**
       * 「现在离底部有多远」。切会话、切回面板、发消息都要用它决定是否跟随最新内容；
       * 同时驱动右下角的「回到最新」按钮。
       */
      const [awayFromBottom, setAwayFromBottom] = useState(false);
      /* pinned：是否跟随最新内容。用户自己往上翻就松开，新消息不再拽他回去。 */
      const pinnedRef = useRef(true);
      const stickToBottom = () => {
        const element = scrollRef.current;
        if (!element) return;
        element.scrollTop = element.scrollHeight;
        pinnedRef.current = true;
        setAwayFromBottom(false);
      };
      const measureDistance = () => {
        const element = scrollRef.current;
        if (!element) return;
        const away = element.scrollHeight - element.scrollTop - element.clientHeight > 240;
        pinnedRef.current = !away;
        setAwayFromBottom(away);
      };
      /**
       * 打开一个会话（切会话、从别的面板切回来、甚至退出插件再进来）都落在最新一条。
       *
       * 关键：`detail` 是异步到的——退出插件再进来时 `currentId` 早就从本地存储恢复了，
       * 第一次渲染时 `detail` 还是 null，只监听 `currentId` 的那版 effect 直接返回、
       * 再也不会重跑，于是停在这段对话最早一屏（用户看到的现象）。
       * 现在把「历史真的到齐了」也写进依赖：会话 id 一致但内容从无到有时同样要钉到底。
       */
      const hydratedSession = detail && detail.session ? detail.session.id : '';
      useEffect(() => {
        if (!hydratedSession) return undefined;
        const element = scrollRef.current;
        if (!element) return undefined;
        if (!pinnedRef.current) return undefined;
        let frames = 0;
        let raf = 0;
        const settle = () => {
          const box = scrollRef.current;
          if (!box) return;
          box.scrollTop = box.scrollHeight;
          frames += 1;
          // 内容高度会随 markdown/图片渲染变化，多铺几帧再收手
          if (frames < 8) raf = requestAnimationFrame(settle);
          else measureDistance();
        };
        raf = requestAnimationFrame(settle);
        return () => { if (raf) cancelAnimationFrame(raf); };
      }, [currentId, hydratedSession]);

      /* 切会话时重新开始跟随：新会话本来就该看最新一条。 */
      useEffect(() => {
        pinnedRef.current = true;
        setAwayFromBottom(false);
        const element = scrollRef.current;
        if (element) element.scrollTop = element.scrollHeight;
      }, [currentId]);

      // Follow the tail while streaming, and always reveal a new approval card.
      useEffect(() => {
        if (!items.length) return;
        const element = scrollRef.current;
        if (!element) return;
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 220;
        if (nearBottom || pinnedRef.current) element.scrollTop = element.scrollHeight;
        measureDistance();
      }, [items.length, lastItemText, status.key]);

      useEffect(() => {
        if (!pending) return;
        const element = scrollRef.current;
        if (element) element.scrollTop = element.scrollHeight;
      }, [pending && pending.requestId]);

      const selectSession = (id) => {
        setCurrentId(id);
        /* 右栏默认回到「文件」——跟 DSH 一样先看文件树。只有这个会话正在等审批时
           才自动翻到「运行状态」，因为那时审批卡是关键信息。 */
        const next = sessions.find((session) => session.id === id);
        setInspTab(next && next.pending ? 'run' : 'files');
        setRailOpen(false);
        setCtxMenu(null);
        setApprovalResult(null);
      };

      /**
       * 切换顶部助手：范围整个换掉——左栏只剩它的会话与工作区，当前会话改成
       * 它最近的那个（没有就清空成空态，不等于「新建会话」）。
       */
      const switchProvider = (provider) => {
        if (provider === topProvider) {
          const here = sessions.find((session) => !session.archived && (session.provider || 'claude') === provider);
          if (here && here.id !== currentId) selectSession(here.id);
          return;
        }
        setTopProvider(provider);
        setRailOpen(false);
        setQuery('');
        setBatch(false);
        setSelected(new Set());
        setCtxMenu(null);
        setApprovalResult(null);
        setInspTab('files');
        setPreview(null);
        setHighlight('');
        const next = sessions
          .filter((session) => !session.archived && (session.provider || 'claude') === provider)
          .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
        setCurrentId(next ? next.id : null);
        setDetail(null);
        setNewInitial({ provider, cwd: next ? next.cwd : (boot ? boot.defaultCwd : '') });
      };

      const startNew = (provider, cwd, prompt) => {
        // 新建会话永远跟随顶部选中的助手；目录沿用当前会话 / 默认目录。
        setNewInitial({ provider: provider || topProvider, cwd: cwd || (scopedCurrent ? scopedCurrent.cwd : (scopedActive[0] ? scopedActive[0].cwd : (boot ? boot.defaultCwd : ''))) });
        // 空态任务卡会先 setPendingPrompt(text) 再调这里；无条件清空会把刚写入的
        // 首条消息抹掉，导致「选一个任务开始」永远不发消息。带 prompt 时保留它。
        setPendingPrompt(prompt || '');
        setShowNew(true);
      };

      const createSession = async (provider, cwd, options) => {
        try {
          const result = await api('/sessions', { method: 'POST', body: JSON.stringify({ provider, cwd }) });
          setSessions((list) => [result.session, ...list]);
          if (result.workspaces) applyWorkspaces(result.workspaces);
          setTopProvider(result.session.provider || provider);
          setCurrentId(result.session.id);
          setDetail({ session: result.session, items: [] });
          setShowNew(false);
          /* 首条消息必须走参数传进来：不能读 pendingPrompt 状态。
             React 的 setState 在同一个事件 tick 里不生效，send() 先 setPendingPrompt
             再同步调到这里时，闭包里的 pendingPrompt 还是上一轮的旧值——
             表现就是「空态直接发送，会话建了但消息没发出去」。 */
          const prompt = options && typeof options.prompt === 'string' ? options.prompt : pendingPrompt;
          const promptAttachments = options && Array.isArray(options.attachments) ? options.attachments : [];
          setPendingPrompt('');
          if (prompt || promptAttachments.length) {
            try {
              await api('/sessions/' + result.session.id + '/message', {
                method: 'POST',
                body: JSON.stringify({ text: prompt, attachments: wireAttachments(promptAttachments) }),
              });
            } catch (error) {
              /* 会话建好了但首条消息没发出去：把文字与附件落到**这个新会话**的草稿位。
                 以前写回 setDraft（旧 draftKey = 新建态），界面已经切到新会话，用户看到的是
                 空白输入框——文字和附件都像被吞了。 */
              setDraftFor(result.session.id, prompt);
              setAttachMap((current) => ({ ...current, [result.session.id]: promptAttachments }));
              showToast('首条消息未发出，文字与附件已放回输入框：' + error.message);
            }
          }
          return true;
        } catch (error) {
          showToast(error.message);
          return false;
        }
      };

      /**
       * DSH 式「在工作区里直接开新会话」：不弹创建对话框，用顶部选中的助手在
       * 该工作区目录下新建一个空白会话并切过去。
       */
      const createInWorkspace = async (cwd) => {
        if (!cwd) return;
        const provider = topProvider;
        try {
          const result = await api('/sessions', { method: 'POST', body: JSON.stringify({ provider, cwd }) });
          setSessions((list) => [result.session, ...list]);
          if (result.workspaces) applyWorkspaces(result.workspaces);
          setTopProvider(provider);
          setCurrentId(result.session.id);
          setDetail({ session: result.session, items: [] });
          setRailOpen(false);
          showToast('已在「' + (basename(cwd) || cwd) + '」新建 ' + providerMeta(provider).label + ' 会话');
        } catch (error) {
          showToast(error.message);
        }
      };

      /**
       * 工作区是「目录」级的登记，同一个目录可能同时有 Claude 与 Codex 的会话。
       * 所以删除确认框里额外显示「这个目录里另一个助手还有几个会话」，用户在
       * 只看到 Codex 列表时也能知道删掉工作区会不会顺手让 Claude 那边的会话掉进
       * 未分组（答案：会，因为登记表按目录存）。
       */
      /**
       * 工作区行的菜单：右键或行尾「⋯」都能打开。工作区的增删改集中在这里，
       * 行上只留一个「+」和一个「⋯」，不再长期占两个图标。
       */
      const askGroupMenu = (group, x, y) => setGroupMenu({ group, x, y });

      const groupAction = async (action) => {
        const group = groupMenu ? groupMenu.group : null;
        setGroupMenu(null);
        if (!group) return;
        if (action === 'new') createInWorkspace(group.cwd);
        else if (action === 'rename') setWsRename({ group, value: group.title, busy: false, error: '' });
        else if (action === 'openfolder') {
          try { await api('/open', { method: 'POST', body: JSON.stringify({ target: group.cwd }) }); } catch (error) { showToast(error.message); }
        } else if (action === 'delete') askDeleteWorkspace(group);
      };

      const submitWsRename = async () => {
        if (!wsRename || wsRename.busy) return;
        const title = String(wsRename.value || '').trim();
        if (!title) { setWsRename({ ...wsRename, error: '名字不能为空' }); return; }
        setWsRename({ ...wsRename, busy: true, error: '' });
        try {
          const result = await api('/workspaces', {
            method: 'PATCH',
            body: JSON.stringify({ cwd: wsRename.group.cwd, title }),
          });
          if (result.workspaces) applyWorkspaces(result.workspaces);
          setWsRename(null);
          showToast('已重命名为「' + title + '」');
        } catch (error) {
          setWsRename({ ...wsRename, busy: false, error: error.message });
        }
      };

      const askDeleteWorkspace = (group) => {
        setWsDeleteError('');
        const others = sessions.filter((session) => !session.archived
          && String(session.cwd || '').toLowerCase() === String(group.cwd || '').toLowerCase()
          && (session.provider || 'claude') !== topProvider).length;
        setWsDelete({ cwd: group.cwd, title: group.title, provider: topProvider, others });
      };

      const restoreWorkspace = async (cwd, title, provider) => {
        try {
          const body = { cwd, title };
          // 撤销 / 手动添加都只对当前助手生效：把这一侧从 hiddenFor 里放出来。
          if (provider) body.provider = provider;
          const result = await api('/workspaces', { method: 'POST', body: JSON.stringify(body) });
          if (result.workspaces) applyWorkspaces(result.workspaces);
          showToast('已恢复工作区');
        } catch (error) {
          showToast('恢复失败：' + error.message);
        }
      };

      const addWorkspace = async () => {
        /* 先请 DSH 弹系统选择器；没有这个能力时回落到内建目录列表。 */
        try {
          if (workspaceApi && typeof workspaceApi.pickDirectory === 'function') {
            const picked = await workspaceApi.pickDirectory();
            if (picked) { await restoreWorkspace(picked, undefined, topProvider); return; }
            return;
          }
        } catch { /* 没有 native 选择器，走下面的内建列表 */ }
        setWsPickerOpen(true);
      };

      const confirmDeleteWorkspace = async () => {
        if (!wsDelete || wsDeleting) return;
        setWsDeleting(true);
        setWsDeleteError('');
        try {
          const result = await api('/workspaces?cwd=' + encodeURIComponent(wsDelete.cwd)
            + '&provider=' + encodeURIComponent(wsDelete.provider), { method: 'DELETE' });
          if (result.workspaces) applyWorkspaces(result.workspaces);
          // 不轻信单个响应：再拉一次两个列表，保证左栏与服务端一致
          // （删完工作区后，原来的会话要立刻显示在「未分组」下）。
          const [spaces, list] = await Promise.all([
            api('/workspaces').catch(() => null),
            api('/sessions').catch(() => null),
          ]);
          if (spaces && spaces.workspaces) applyWorkspaces(spaces.workspaces);
          if (list && list.sessions) setSessions(list.sessions);
          // 删工作区不像归档可以随时再归档一次：给一条「撤销」，用原名字把它加回来。
          const removed = wsDelete;
          const who = providerMeta(removed.provider).label;
          showToast(result.hidden
            ? '已从 ' + who + ' 侧移除「' + removed.title + '」；另一侧仍按工作区分组'
            : '已从工作台移除「' + removed.title + '」', {
            label: '撤销',
            onClick: () => restoreWorkspace(removed.cwd, removed.title, removed.provider),
          });
          setWsDelete(null);
        } catch (error) {
          setWsDeleteError(error.message);
        } finally {
          setWsDeleting(false);
        }
      };

      /**
       * 计划模式的前缀：两个 CLI 都是靠 prompt 驱动的（Claude 另有 permission-mode，
       * Codex 没有 plan flag），所以这里是「指令」而不是「开关」，界面上也这么写。
       */
      const planPrefix = (provider) => (provider === 'codex'
        ? '【计划模式】这一轮只做计划和调研：不要修改任何文件、不要执行会改变状态的命令。\n'
          + '先读相关代码，再给出分步骤的实施计划（要改哪些文件、每步做什么、风险与回滚方式），'
          + '结尾列出需要我确认的问题；我确认后再按计划执行。\n\n'
        : '【计划模式】先别动手：列出一份分步骤计划（要改哪些文件、每步做什么、风险），'
          + '等我确认后再执行；这一轮不要修改文件。\n\n');

      /**
       * 把浏览器里的 File 读成 base64（不带 data: 前缀）；图片顺手留一份 data URL
       * 给草稿里的缩略图。读失败要说明原因，不能静默丢。
       */
      const readAttachment = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读不到「' + (file.name || '附件') + '」'));
        reader.onload = () => {
          const result = String(reader.result || '');
          const comma = result.indexOf(',');
          resolve({ data: comma >= 0 ? result.slice(comma + 1) : result, dataUrl: result });
        };
        reader.readAsDataURL(file);
      });

      /**
       * 桌面端才拿得到真实绝对路径：DSH 的 preload 暴露了
       * `window.__DSH_HOST_PATHS__.pathFor(file)`（Electron 的
       * webUtils.getPathForFile）。浏览器里没有它，返回空串——
       * 文件夹在浏览器里添不了，跟 DSH 自己的限制一致。
       */
      const hostPathFor = (file) => {
        try {
          const bridge = window.__DSH_HOST_PATHS__;
          if (!bridge || typeof bridge.pathFor !== 'function') return '';
          return String(bridge.pathFor(file) || '');
        } catch { return ''; }
      };

      /**
       * 从一次拖放/粘贴里取出文件和「哪些是文件夹」。
       * 浏览器只在 DataTransferItem 上暴露 entry API，`files` 里认不出来。
       */
      const transferFiles = (dataTransfer) => {
        const files = [];
        const directories = new Set();
        if (!dataTransfer) return { files, directories };
        if (dataTransfer.items) {
          for (const item of dataTransfer.items) {
            if (item.kind !== 'file') continue;
            const file = item.getAsFile();
            if (!file) continue;
            files.push(file);
            try {
              if (typeof item.webkitGetAsEntry === 'function' && item.webkitGetAsEntry()?.isDirectory === true) {
                directories.add(file);
              }
            } catch { /* entry API 不可用就当普通文件 */ }
          }
        }
        if (!files.length && dataTransfer.files) {
          for (const file of dataTransfer.files) files.push(file);
        }
        return { files, directories };
      };

      /**
       * 添加附件：图片上传字节（要内联给 Claude）；桌面端拖进来的普通文件与
       * 文件夹**只带绝对路径**，不复制内容——大文件不用等上传，CLI 自己读。
       * 浏览器里粘贴/选择（拿不到路径）的普通文件才退回上传。
       */
      const addFiles = async (fileList, directories) => {
        const files = Array.from(fileList || []).filter(Boolean);
        if (!files.length) return;
        const accepted = [];
        let imageCount = attachments.filter((item) => item.kind === 'image').length;
        /* 条目数与上传体积（与服务端同一套）：添加时就拦住，别等下一条消息发出去才报错。 */
        let count = attachments.length;
        let uploadedBytes = attachments
          .filter((item) => item.data)
          .reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        const nextId = () => 'att_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
        for (const file of files) {
          if (count >= ATTACH_MAX_ITEMS) {
            showToast('一次最多附 ' + ATTACH_MAX_ITEMS + ' 个附件（图片与文件合计）');
            break;
          }
          const mediaType = String(file.type || '').toLowerCase();
          const isImage = ATTACH_IMAGE_TYPES.has(mediaType);
          const isDirectory = Boolean(directories && directories.has(file));
          if (isDirectory) {
            const path = hostPathFor(file);
            if (!path) {
              showToast('文件夹只能在桌面应用里拖入；浏览器里请添加里面的单个文件');
              continue;
            }
            accepted.push({
              id: nextId(), kind: 'dir', name: file.name || '文件夹',
              mediaType: '', size: 0, path, previewUrl: '',
            });
            count += 1;
            continue;
          }
          if (isImage && imageCount >= ATTACH_MAX_IMAGES) {
            showToast('一次最多附 ' + ATTACH_MAX_IMAGES + ' 张图片');
            break;
          }
          if (isImage) {
            if (file.size > ATTACH_MAX_IMAGE_BYTES) {
              showToast('「' + (file.name || '图片') + '」超过 ' + Math.round(ATTACH_MAX_IMAGE_BYTES / 1024 / 1024) + 'MB，没有添加');
              continue;
            }
          }
          /* 能拿到真实路径的普通文件：只记路径，由 CLI 直接读原文件。 */
          const path = isImage ? '' : hostPathFor(file);
          if (path) {
            accepted.push({
              id: nextId(), kind: 'file', name: file.name || '附件',
              mediaType: mediaType || 'application/octet-stream',
              size: file.size, path, previewUrl: '',
            });
            count += 1;
            continue;
          }
          if (file.size > ATTACH_MAX_FILE_BYTES) {
            showToast('「' + (file.name || '附件') + '」超过 ' + Math.round(ATTACH_MAX_FILE_BYTES / 1024 / 1024) + 'MB，没有添加');
            continue;
          }
          /* 只有真正要上传字节的才占合计额度；超了就别读了，先把话说清楚。 */
          if (uploadedBytes + file.size > ATTACH_MAX_TOTAL_BYTES) {
            showToast('上传的附件合计不能超过 ' + Math.round(ATTACH_MAX_TOTAL_BYTES / 1024 / 1024) + 'MB，请分批发送');
            break;
          }
          try {
            const read = await readAttachment(file);
            uploadedBytes += file.size;
            count += 1;
            accepted.push({
              id: nextId(),
              kind: isImage ? 'image' : 'file',
              name: file.name || (isImage ? '图片' : '附件'),
              mediaType: isImage ? mediaType : (mediaType || 'application/octet-stream'),
              size: file.size,
              data: read.data,
              previewUrl: isImage ? read.dataUrl : '',
            });
            if (isImage) imageCount += 1;
          } catch (error) {
            showToast(error.message);
          }
        }
        if (accepted.length) setAttachments((current) => [...current, ...accepted]);
      };

      const removeAttachment = (id) => setAttachments((current) => current.filter((item) => item.id !== id));

      /* ------------------------------------------------------ 引用选中的文字 */

      /* 只留「选区 + 浮动按钮」这一步；点下去就把原文内联插进草稿。 */
      const [quoteSel, setQuoteSel] = useState(null);

      /**
       * 选区 → 浮动按钮的数据。只认落在**同一条消息**（`.cw-msg`）里的选区：
       * 跨条引用没法归属到某个气泡，CLI 那边也读不出是哪一条。
       * 位置用视口坐标（按钮是 fixed），所以滚动时必须关掉，见下面的 effect。
       */
      const captureQuote = () => {
        const selection = window.getSelection ? window.getSelection() : null;
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) { setQuoteSel(null); return; }
        const text = String(selection.toString() || '').trim();
        if (!text) { setQuoteSel(null); return; }
        const range = selection.getRangeAt(0);
        const elementOf = (node) => (node && node.nodeType === 1 ? node : (node && node.parentElement));
        const startEl = elementOf(range.startContainer);
        const endEl = elementOf(range.endContainer);
        const startMsg = startEl && startEl.closest ? startEl.closest('.cw-msg') : null;
        const endMsg = endEl && endEl.closest ? endEl.closest('.cw-msg') : null;
        if (!startMsg || startMsg !== endMsg) { setQuoteSel(null); return; }
        /* 逐行矩形：包围盒中心会落到空白处，按钮就离文字很远（见 quoteButtonBox） */
        const rects = typeof range.getClientRects === 'function'
          ? Array.from(range.getClientRects())
          : [range.getBoundingClientRect()];
        const box = scrollRef.current && scrollRef.current.getBoundingClientRect
          ? scrollRef.current.getBoundingClientRect()
          : null;
        const spot = quoteButtonBox(rects, box, window.innerWidth);
        if (!spot) { setQuoteSel(null); return; }
        const clipped = text.length > QUOTE_MAX_CHARS;
        setQuoteSel({
          text: clipped ? text.slice(0, QUOTE_MAX_CHARS) : text,
          clipped,
          role: startMsg.classList.contains('cw-msg-user') ? 'user' : 'assistant',
          itemId: startMsg.getAttribute('data-msg') || '',
          x: spot.x,
          y: spot.y,
        });
      };

      /**
       * 引用落地：插到**光标处**（输入框没焦点过就接在末尾），形如
       * `【被引用的原文】`，跟正文一起可编辑、可删除——不再往输入框上方堆 chip。
       */
      /* ------------------------------------------------- 输入框：contenteditable */

      /**
       * 把草稿画进编辑器：`【原文】` 变成内联引用块（“ + 单行截断的原文），
       * 其余是普通文字。**只在草稿和编辑器内容不一致时才重画**——用户打字时
       * onEditorInput 已经把 DOM 同步成同一份文本，重画会把光标顶走。
       */
      const syncEditor = (value) => {
        const editor = editorRef.current;
        /* 没有 DOM（比如测试里的 shim）就什么都不做：草稿本身仍是唯一真相。 */
        if (!editor || typeof document === 'undefined') return;
        if (serializeEditor(editor) === value) return;
        editor.textContent = '';
        for (const segment of parseDraft(value)) {
          if (segment.type === 'quote') editor.appendChild(createQuoteChip(segment.text));
          else if (segment.text) editor.appendChild(document.createTextNode(segment.text));
        }
        syncEditorHeight(editor);
        setCaretToEnd(editor);
      };

      const syncEditorHeight = (editor) => {
        if (!editor || !editor.style) return;
        editor.style.height = 'auto';
        editor.style.height = Math.min(336, editor.scrollHeight || 0) + 'px';
      };

      const setCaretToEnd = (editor) => {
        if (!editor || typeof window === 'undefined' || !window.getSelection || !document.createRange) return;
        try {
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          editorCaretRef.current = range.cloneRange();
        } catch { /* 编辑器不在文档里就跳过 */ }
      };

      /** 记住编辑器里的光标位置（输入、点击、方向键之后都调一次）。 */
      const rememberCaret = () => {
        const editor = editorRef.current;
        const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
        if (!editor || !selection || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (range && editor.contains(range.commonAncestorContainer)) {
          try { editorCaretRef.current = range.cloneRange(); } catch { /* ignore */ }
        }
      };

      /* 草稿被别处改掉（清空、回填、删技能令牌）时同步编辑器 */
      useEffect(() => { syncEditor(draft); }, [draft]);

      const onEditorInput = (event) => {
        const editor = event && event.currentTarget ? event.currentTarget : editorRef.current;
        if (!editor) return;
        setDraft(serializeEditor(editor));
        syncEditorHeight(editor);
        rememberCaret();
      };

      /** 无格式粘贴：优先用浏览器自己的 insertText（保留撤销栈），不行再手动插。 */
      const insertPlainText = (text) => {
        const editor = editorRef.current;
        if (!editor || !text || typeof document === 'undefined') return;
        let inserted = false;
        if (document.execCommand) {
          try { inserted = document.execCommand('insertText', false, text); } catch { inserted = false; }
        }
        if (!inserted) {
          const node = document.createTextNode(text);
          const selection = window.getSelection ? window.getSelection() : null;
          const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
          if (range && editor.contains(range.commonAncestorContainer)) {
            range.deleteContents();
            range.insertNode(node);
            range.setStartAfter(node);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          } else {
            editor.appendChild(node);
            setCaretToEnd(editor);
          }
        }
        setDraft(serializeEditor(editor));
        syncEditorHeight(editor);
      };

      /**
       * 在光标处插一枚引用块 + 一个空格，光标落到空格后面——跟 DSH 一样，
       * 引用嵌在正文流里，接着说自己的话。
       */
      const insertQuoteAtCaret = (text) => {
        const editor = editorRef.current;
        const fallback = () => {
          const next = insertQuoteText(draft, text, draft.length);
          setDraft(next.text);
        };
        if (!editor || typeof document === 'undefined') { fallback(); return; }
        const chip = createQuoteChip(text);
        const space = document.createTextNode(' ');
        /* 点「引用」时焦点/选区其实在消息那边（按钮用 mousedown preventDefault 保住的
           是消息选区）。所以优先用**编辑器里最后一次的光标位置**，没有才接末尾。 */
        const selection = window.getSelection ? window.getSelection() : null;
        const live = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
        let range = null;
        if (live && editor.contains(live.commonAncestorContainer)) range = live;
        else if (editorCaretRef.current && editor.contains(editorCaretRef.current.commonAncestorContainer)) {
          try { range = editorCaretRef.current.cloneRange(); } catch { range = null; }
        }
        if (range) {
          range.deleteContents();
          range.insertNode(space);
          range.insertNode(chip);
          range.setStartAfter(space);
          range.collapse(true);
          if (selection) { selection.removeAllRanges(); selection.addRange(range); }
          try { editorCaretRef.current = range.cloneRange(); } catch { /* ignore */ }
        } else {
          editor.appendChild(chip);
          editor.appendChild(space);
          setCaretToEnd(editor);
        }
        setDraft(serializeEditor(editor));
        syncEditorHeight(editor);
        editor.focus();
      };

      const addQuote = () => {
        if (!quoteSel) return;
        insertQuoteAtCaret(quoteSel.text);
        setQuoteSel(null);
        if (quoteSel.clipped) showToast('引用超过 ' + QUOTE_MAX_CHARS + ' 字，已截断');
      };

      /* 点别处 / Esc / 滚动：浮动按钮立刻消失（fixed 定位不会跟着选区走）。 */
      useEffect(() => {
        if (!quoteSel) return undefined;
        const onDown = (event) => {
          const target = event.target;
          if (target && target.closest && target.closest('.cw-quotebtn')) return;
          setQuoteSel(null);
        };
        const onKey = (event) => { if (event.key === 'Escape') setQuoteSel(null); };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [quoteSel]);

      /**
       * 发给 Host 的线上形态：带字节的上传，或带绝对路径的引用（文件夹/拖入的文件）。
       * kind 只作提示，Host 会按字节和文件系统重新核一遍。
       */
      const wireAttachments = (list) => (list || []).map((item) => ({
        name: item.name,
        mediaType: item.mediaType,
        kind: item.kind,
        ...(item.path ? { path: item.path } : {}),
        ...(item.data ? { data: item.data } : {}),
      }));

      const send = async (override) => {
        /* 附件上限在添加时已经拦过一次，这里再兜一层：路径引用的条目也在 10 个之内，
           而上传体积要等真正发出去才算得准。宁可现在说清楚，也别让请求撞上 40MB 的
           body 上限、只回一句「请求体过大」。 */
        if (attachments.length > ATTACH_MAX_ITEMS) {
          showToast('一次最多发 ' + ATTACH_MAX_ITEMS + ' 个附件（图片与文件合计）');
          return;
        }
        const uploadBytes = attachments
          .filter((item) => item.data)
          .reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        if (uploadBytes > ATTACH_MAX_TOTAL_BYTES) {
          showToast('上传的附件合计不能超过 ' + Math.round(ATTACH_MAX_TOTAL_BYTES / 1024 / 1024) + 'MB，请分批发送');
          return;
        }
        // 没有会话时直接发 = 用顶部选中的助手建一个会话，并把这句话作为第一句：
        // 不再跳一层「先新建会话」对话框（那正是「点新建却建出另一个 CLI」的来源）。
        if (!currentId || !viewSession) {
          const body = (override == null ? draft : override).trim();
          if (!body && !attachments.length) return;
          const plan = planMode ? planPrefix(topProvider) : '';
          const composed = plan + (fileRef ? '@' + fileRef + ' ' : '') + body;
          /* 图片/文件先跟着首条消息走：会话建好之后才有附件目录，
             所以这里把内容一起交给 createSession，由它在建好后发出去。 */
          const pendingAttachments = attachments;
          setPendingPrompt(composed);
          setDraft('');
          setFileRef('');
          setSkillRefs([]);
          setAttachments([]);
          setPlanMode(false);
          const created = await createSession(topProvider, (scopedActive[0] && scopedActive[0].cwd) || (boot ? boot.defaultCwd : ''), {
            prompt: composed,
            attachments: pendingAttachments,
          });
          // 建会话失败时把原文和附件放回去：原来草稿已经清空，长文本就此静默丢失。
          if (!created) {
            setDraft(composed);
            setAttachments(pendingAttachments);
          }
          return;
        }
        const body = (override == null ? draft : override).trim();
        if (!body && !attachments.length) return;
        const plan = planMode ? planPrefix(topProvider) : '';
        const content = plan + (fileRef ? '@' + fileRef + ' ' : '') + body;
        try {
          await api('/sessions/' + currentId + '/message', {
            method: 'POST',
            body: JSON.stringify({ text: content, attachments: wireAttachments(attachments) }),
          });
          if (override == null) { setDraft(''); setFileRef(''); setSkillRefs([]); setAttachments([]); }
          // 计划只对下一条消息有效：发出去就复位，免得下一条还带着旧指令
          if (planMode) { setPlanMode(false); showToast('计划指令已随这条消息发出，计划模式已关'); }
          refreshSessions();
        } catch (error) {
          showToast(error.message);
        }
      };

      const stop = async () => {
        if (!currentId) return;
        try { await api('/sessions/' + currentId + '/stop', { method: 'POST' }); refreshSessions(); } catch (error) { showToast(error.message); }
      };

      const patchSession = async (id, body, options) => {
        try {
          const result = await api('/sessions/' + id, { method: 'PATCH', body: JSON.stringify(body) });
          setSessions((list) => mergeSession(list, result.session));
          // 置顶/归档这类只在左栏体现的改动，不要去替换 detail.session：
          // 那会让整个对话重新渲染一遍（长会话里就是一次明显卡顿）。
          if (!(options && options.railOnly)) {
            setDetail((current) => {
              if (!current || !current.session || current.session.id !== id) return current;
              return { ...current, session: result.session };
            });
          }
          return result.session;
        } catch (error) {
          showToast(error.message);
          return null;
        }
      };

      const archive = async (id) => {
        const session = sessions.find((item) => item.id === id);
        const result = await patchSession(id, { archived: true });
        if (!result) return;
        if (id === currentId) {
          // 回退指针必须按当前助手的范围找：原来不分 provider，
          // 归档一个 Codex 会话后可能跳到 Claude 会话，导致中栏落进空态。
          const next = sessions.find((item) => item.id !== id && !item.archived
            && (item.provider || 'claude') === topProvider);
          if (next) selectSession(next.id); else setCurrentId(null);
        }
        showToast('已归档「' + (session ? session.title : '会话') + '」', { label: '撤销', onClick: () => restore(id) });
      };

      const restore = async (id) => {
        await patchSession(id, { archived: false });
        showToast('已取消归档');
      };

      /**
       * 删除会话：走插件自己的确认框（浅色遮罩 + 12 圆角行按钮 + 红色主按钮），
       * 不再用 Electron 的 window.confirm —— 那个原生框是浅灰 Win32 样式，和
       * 工作台完全不是一个世界。批量删除复用同一套文案。
       */
      const askDeleteSessions = (list) => {
        const ids = list.map((item) => item.id);
        if (!ids.length) return;
        /* 只报数量，不列标题：批量删十几条时列表既列不全（下面还要写「还有 N 个」），
           又会把确认框撑得老高，真正要看的「删几条」反而被埋了。 */
        setConfirmBox({
          kind: 'delete',
          ids,
          title: ids.length > 1 ? '删除 ' + ids.length + ' 个会话' : '删除会话',
          busy: false,
          error: '',
        });
      };

      const remove = async (id) => {
        const session = sessions.find((item) => item.id === id);
        if (!session) return;
        askDeleteSessions([session]);
      };

      const doConfirmDelete = async () => {
        if (!confirmBox || confirmBox.kind !== 'delete' || confirmBox.busy) return;
        const ids = confirmBox.ids.slice();
        setConfirmBox({ ...confirmBox, busy: true, error: '' });
        // 逐条删、逐条记失败：整批 try 的话，中间一条失败会留下「前面已删、后面没删」
        // 的半成品状态，而重试又从第一条开始，必然再撞到已删除的 id，永远删不完。
        const failed = [];
        for (const id of ids) {
          try { await api('/sessions/' + id, { method: 'DELETE' }); }
          catch (error) { failed.push({ id, message: error.message }); }
        }
        const doneIds = ids.filter((id) => !failed.some((entry) => entry.id === id));
        setSessions((list) => list.filter((item) => !doneIds.includes(item.id)));
        if (doneIds.includes(currentId)) {
          const next = sessions.find((item) => !doneIds.includes(item.id) && !item.archived
            && (item.provider || 'claude') === topProvider);
          setCurrentId(next ? next.id : null);
          setDetail(null);
        }
        setSelected(new Set());
        setBatch(false);
        if (failed.length) {
          // 确认框只留失败的那些，重试是幂等的（Host 对不存在的 id 返回 404，
          // 计入失败但不阻塞其它条目）。标题跟着剩余数量更新，否则重试框还写着
          // 「删除 5 个会话」，实际只剩 1 条要重试。
          setConfirmBox({
            ...confirmBox,
            ids: failed.map((entry) => entry.id),
            title: failed.length > 1 ? '删除 ' + failed.length + ' 个会话（重试）' : '删除会话（重试）',
            busy: false,
            error: '有 ' + failed.length + ' 个删除失败：' + failed[0].message,
          });
          return;
        }
        setConfirmBox(null);
        showToast(ids.length > 1 ? '已删除 ' + ids.length + ' 个会话' : '已删除会话');
      };

      const ctxAction = async (action) => {
        const session = ctxMenu ? ctxMenu.session : null;
        setCtxMenu(null);
        if (!session) return;
        if (action === 'pin') await patchSession(session.id, { pinned: !session.pinned }, { railOnly: true });
        else if (action === 'rename') {
          // 重命名也用插件自己的输入框（原生 prompt 同样和界面对不上）
          setRenameBox({ session, value: session.title, busy: false, error: '' });
        } else if (action === 'openfolder') {
          // 这里原来没有 try/catch：请求失败会变成未处理的 rejection，右键菜单
          // 看起来「点了没反应」。失败必须说出来。
          try { await api('/open', { method: 'POST', body: JSON.stringify({ target: session.cwd, session: session.id }) }); }
          catch (error) { showToast('打开文件夹失败：' + error.message); }
        } else if (action === 'copyid') {
          /* 复制哪一段是明说的事：工作台自己的会话 id 永远在最前，其后是 CLI 的原生
             id（Claude 的 session_id / Codex 的 thread_id）——排查问题时两者都要。 */
          const lines = ['CLI 工作台: ' + session.id];
          if (session.provider === 'claude') lines.push('Claude session_id: ' + (session.claudeSessionId || '（尚未建立，发第一句话后才有）'));
          else lines.push('Codex thread_id: ' + (session.codexThreadId || '（尚未建立，发第一句话后才有）'));
          copyText(lines.join('\n'), '已复制 Session ID：' + session.id);
        } else if (action === 'batch') {
          setBatch(true);
        } else if (action === 'archive') {
          await archive(session.id);
        } else if (action === 'delete') {
          await remove(session.id);
        }
      };

      const submitRename = async () => {
        if (!renameBox || renameBox.busy) return;
        const name = String(renameBox.value || '').trim();
        if (!name) { setRenameBox({ ...renameBox, error: '名字不能为空' }); return; }
        setRenameBox({ ...renameBox, busy: true, error: '' });
        const result = await patchSession(renameBox.session.id, { title: name });
        if (result) { setRenameBox(null); showToast('已重命名'); }
        else setRenameBox({ ...renameBox, busy: false, error: '保存失败，请重试' });
      };

      const toggleSelect = (id) => {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      };
      const selectAll = (list) => {
        setSelected(new Set(list.map((session) => session.id)));
      };

      const batchArchive = async () => {
        const ids = [...selected];
        if (!ids.length) { showToast('请先勾选会话'); return; }
        for (const id of ids) await patchSession(id, { archived: true });
        setSelected(new Set());
        setBatch(false);
        if (ids.includes(currentId)) {
          // 同 archive()：回退要守住当前助手的作用域
          const next = sessions.find((item) => !ids.includes(item.id) && !item.archived
            && (item.provider || 'claude') === topProvider);
          if (next) selectSession(next.id); else setCurrentId(null);
        }
        showToast('已归档 ' + ids.length + ' 个会话');
      };

      const batchDelete = async () => {
        const ids = [...selected];
        if (!ids.length) { showToast('请先勾选会话'); return; }
        askDeleteSessions(sessions.filter((item) => ids.includes(item.id)));
      };

      const retryLast = async () => {
        if (!currentId) return;
        const lastUser = [...items].reverse().find((item) => item.kind === 'user');
        if (!lastUser || !lastUser.text) { showToast('没有可重试的用户消息'); return; }
        try {
          await api('/sessions/' + currentId + '/message', { method: 'POST', body: JSON.stringify({ text: lastUser.text }) });
          refreshSessions();
        } catch (error) { showToast(error.message); }
      };

      const revokeTool = async (name) => {
        if (!viewSession) return;
        const next = (viewSession.allowedTools || []).filter((tool) => tool !== name);
        await patchSession(viewSession.id, { allowedTools: next });
        showToast('已撤销「' + name + '」的会话放行');
      };

      const copyPageUrl = () => {
        if (!preview) return;
        const url = 'file:///' + String(preview.path).replace(/\\/g, '/');
        copyText(url, '已复制文件地址');
      };

      /**
       * 复制文本到剪贴板：先试 navigator.clipboard，不行回退到隐藏 textarea +
       * execCommand（DSH 窗口里个别情况下剪贴板 API 会被拦）。两条都失败才报错，
       * 不假装成功。
       */
      const copyText = (value, okText) => {
        const fallback = () => {
          try {
            const area = document.createElement('textarea');
            area.value = value;
            area.setAttribute('readonly', '');
            area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand && document.execCommand('copy');
            document.body.removeChild(area);
            showToast(ok ? okText : '复制失败，请手动选择文本');
          } catch { showToast('复制失败，请手动选择文本'); }
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value).then(() => showToast(okText), fallback);
          } else fallback();
        } catch { fallback(); }
      };

      const decide = async (decision, reason) => {
        if (!pending) return;
        const toolName = pending.toolName;
        try {
          await api('/sessions/' + currentId + '/approve', {
            method: 'POST',
            body: JSON.stringify({ requestId: pending.requestId, decision, reason }),
          });
          setApprovalResult(decision === 'deny' ? ('已拒绝：' + toolName) : ('已允许：' + toolName));
          setTimeout(() => setApprovalResult(null), 5000);
        } catch (error) { showToast(error.message); }
      };

      const setMode = async (id) => {
        if (!viewSession) return;
        const key = viewSession.provider === 'codex' ? 'sandboxMode' : 'permissionMode';
        const result = await patchSession(viewSession.id, { [key]: id });
        setMenu(null);
        if (result) showToast('已切换为「' + (modeOptions(viewSession).find((mode) => mode.id === id) || {}).label + '」');
      };

      const setModel = async (value) => {
        if (!viewSession) return;
        const result = await patchSession(viewSession.id, { model: value });
        setMenu(null);
        if (result) showToast('模型已保存，将在下次启动 CLI 进程时生效');
      };

      const openPreview = async (filePath) => {
        if (!currentId) return;
        // 传 null 表示关掉当前预览（关闭文档页签 / 点 ×）
        if (!filePath) {
          setPreview(null);
          setHighlight('');
          if (inspTab === 'preview' || inspTab === 'page') setInspTab('files');
          return;
        }
        try {
          const result = await api('/fs/file?session=' + encodeURIComponent(currentId) + '&path=' + encodeURIComponent(filePath));
          setPreview(result);
          setInspTab('preview');
          setInspOpen(true);
        } catch (error) { showToast(error.message); }
      };

      /**
       * 右侧的「文件 / 预览 / 运行状态」必须跟着当前会话走——会话绑定哪个 CLI，
       * 右栏就是那个 CLI 的产物。切会话时：清掉上一个会话的预览，若它属于另一个
       * CLI，顺手刷新文件树；同一个 CLI 内切换则只重读自己那份文件树。
       */
      const lastPreviewSession = useRef('');
      useEffect(() => {
        if (!currentId) { setPreview(null); return; }
        const session = sessions.find((entry) => entry.id === currentId) || (detail && detail.session) || null;
        if (!session) return;
        if (lastPreviewSession.current && lastPreviewSession.current !== currentId) {
          setPreview(null);
          setHighlight('');
        }
        lastPreviewSession.current = currentId;
        loadTree(currentId);
      }, [currentId, loadTree]);

      /** 任务产出的文件被改过：如果右侧正在预览同一文件，自动重读，不显示旧内容。 */
      useEffect(() => {
        if (!preview || !preview.path || !currentId) return undefined;
        const changed = (items || []).some((item) => item.kind === 'filechange'
          ? (item.files || []).some((file) => pathEq(file, preview.path))
          : item.kind === 'tool' && item.diff && pathEq(item.diff.path, preview.path));
        if (!changed) return undefined;
        let alive = true;
        const timer = setTimeout(() => {
          api('/preview?path=' + encodeURIComponent(preview.path))
            .then((next) => { if (alive && next && !next.error) setPreview((current) => ({ ...current, ...next })); })
            .catch(() => {});
        }, 400);
        return () => { alive = false; clearTimeout(timer); };
      }, [items, preview && preview.path, currentId]);

      /**
       * 右栏拖宽：按下把手后整窗跟随，松手写进 localStorage。
       * 宽度限制在 240 ~ (窗口宽度 - 520) 之间，保证中间对话区不会被挤没。
       */
      const beginInspResize = (event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = inspWidth;
        const maxWidth = Math.max(320, width - 520);
        inspDrag.current = { startX, startWidth, maxWidth };
        const onMove = (moveEvent) => {
          if (!inspDrag.current) return;
          const next = Math.max(240, Math.min(inspDrag.current.maxWidth, inspDrag.current.startWidth - (moveEvent.clientX - inspDrag.current.startX)));
          setInspWidth(Math.round(next));
        };
        const onUp = () => {
          inspDrag.current = null;
          dragCleanupRef.current = null;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          setInspWidth((value) => {
            try { window.localStorage && window.localStorage.setItem('cw.inspWidth', String(value)); } catch { /* ignore */ }
            return value;
          });
        };
        dragCleanupRef.current = onUp;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      };

      const openExternal = async (target) => {
        try { await api('/open', { method: 'POST', body: JSON.stringify({ target, session: currentId }) }); } catch (error) { showToast(error.message); }
      };

      const savePreview = () => {
        if (!preview) return;
        const anchor = document.createElement('a');
        anchor.download = preview.name || 'preview';
        if (preview.dataUrl) anchor.href = preview.dataUrl;
        else {
          const blob = new Blob([String(preview.text || '')], { type: 'text/plain;charset=utf-8' });
          anchor.href = URL.createObjectURL(blob);
        }
        anchor.click();
      };

      const openPicker = async (kind) => {
        if (kind === 'file' && !currentId) { showToast('先新建会话'); return; }
        if (kind === 'slash') {
          const commands = currentProvider === 'codex'
            ? [
              { label: '/compact', desc: 'Codex 也支持上下文压缩', value: '/compact ' },
              { label: '/model', desc: '切换模型（也可以直接点下面的模型）', value: '/model ' },
            ]
            : [
              { label: '/goal', desc: '设定长期目标（Claude 原生）', value: '/goal ' },
              { label: '/compact', desc: '压缩上下文', value: '/compact ' },
              { label: '/model', desc: '切换模型', value: '/model ' },
              { label: '/clear', desc: '清空会话', value: '/clear ' },
            ];
          setPicker({ kind, items: commands });
          return;
        }
        if (kind === 'skill') {
          // 只在本地读 SKILL.md 清单；发不发、怎么用，交回 CLI 自己决定
          const cwd = viewSession ? viewSession.cwd : (boot ? boot.defaultCwd : '');
          try {
            const result = await api('/skills?cwd=' + encodeURIComponent(cwd || ''));
            const all = result.skills || [];
            const own = all.filter((skill) => skill.provider === currentProvider);
            const other = all.filter((skill) => skill.provider !== currentProvider);
            const ownDirs = (result.dirs || []).filter((dir) => dir.provider === currentProvider);
            setPicker({
              kind: 'skill',
              skills: own,
              otherCount: other.length,
              otherLabel: providerMeta(currentProvider === 'codex' ? 'claude' : 'codex').label,
              ownDirs,
              missingDirs: ownDirs.filter((dir) => !dir.exists).map((dir) => dir.label),
              items: own.map((skill) => ({
                label: skill.name,
                desc: [
                  skill.scope === 'workspace' ? '工作区' : (skill.builtin ? '内置' : '用户级'),
                  skill.link ? '链接' : '',
                  skill.hasDescription ? '' : '无描述',
                ].filter(Boolean).join(' · ') + (skill.description ? ' · ' + skill.description : ''),
                value: skill.path,
                skill,
              })),
            });
          } catch (error) { showToast(error.message); }
          return;
        }
        if (!currentId) { showToast('先新建会话'); return; }
        try {
          const result = await api('/fs/tree?session=' + encodeURIComponent(currentId) + '&depth=2');
          const files = (result.entries || []).filter((entry) => entry.type === 'file').slice(0, 60);
          setPicker({
            kind: 'file',
            /* 文件名一列、所在目录一列——不再把整条相对路径塞进一个会被截断的格子，
               所以「文件名都不全」这件事没有了。悬停还能看到完整路径。 */
            items: files.map((entry) => {
              const relative = String(entry.relative || '');
              const cut = relative.lastIndexOf('/');
              return {
                label: cut >= 0 ? relative.slice(cut + 1) : relative,
                desc: cut >= 0 ? relative.slice(0, cut) : '',
                descIsPath: cut >= 0,
                title: relative,
                value: relative,
              };
            }),
          });
        } catch (error) { showToast(error.message); }
      };

      const pickValue = (value) => {
        if (!picker) return;
        if (picker.kind === 'file') setFileRef(value);
        else if (picker.kind === 'skill') {
          const skill = (picker.items || []).find((item) => item.value === value);
          if (skill && skill.skill) applySkill(skill.skill);
        } else setDraft((current) => (current ? current + '\n' : '') + value);
        setPicker(null);
      };

      /**
       * 选了一个技能：把「使用技能 X + 技能说明」插进输入框（不直接发送）。
       * 用户可以在后面补任务描述再回车——这样既看得见发了什么，也留得住控制权。
       */
      const applySkill = (skill) => {
        /* 跟 DSH 一样：输入框里只放 `/技能名 ` 这个短令牌（渲染成技能卡片），
           技能的说明与路径由 Host 在发送时补进去——不是把几千字塞进输入框。
           Host 那边对「/名字」前缀有对应的展开逻辑（见 index.js 的 skillMessage）。 */
        setSkillRefs((current) => (current.includes('/' + skill.name) ? current : [...current, '/' + skill.name]));
        setDraft((current) => {
          const body = current.replace(/\s+$/, '');
          return (body ? body + ' ' : '') + '/' + skill.name + ' ';
        });
        showToast('已引用技能「' + skill.name + '」，补上任务后回车发送');
        setTimeout(() => { if (editorRef.current) editorRef.current.focus(); }, 0);
      };

      /** 从草稿里认领仍然是「/名字」的已选技能；用户删掉令牌就不再随消息带上。 */
      const activeSkills = () => skillRefs.filter((ref) => new RegExp('(^|\\s)' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)').test(draft));

      const providerBadge = (id) => sessions.filter((session) => !session.archived && session.provider === id && session.pendingCount).reduce((sum, session) => sum + (session.pendingCount || 0), 0);

      /**
       * 模型菜单：挂在输入卡左下的模型按钮上（左对齐按钮中心），弹层贴着输入卡
       * 上沿 6px，和统计浮层同一套材质与间距。
       */
      /**
       * 技能 / 文件 / 斜杠命令的选择浮层。
       * 宽度跟着输入卡走（DSH 的 trigger menu 就是 left:0 / right:0 贴在输入卡上），
       * 所以它挂在 .cw-inputbox 里，不是挂在 28px 的小按钮上。
       */
      /* 这两个是「渲染函数」而不是组件：直接调用得到元素，不能当组件类型去渲染。
         写成组件的话每次 App 渲染都会产生新的函数类型，React 视为不同组件整体重挂，
         会话运行中每秒一次的 tick 会让浮层每秒重建（滚动位置、hover 全丢）。 */
      const renderPickerPop = () => !picker ? null : h('div', { className: 'cw-pop cw-picker-pop', role: 'menu', 'aria-label': '选择器' },
        h('div', { className: 'cw-pop-title' }, picker.kind === 'file' ? '引用项目文件' : picker.kind === 'skill' ? '技能（' + providerMeta(currentProvider).label + '）' : 'CLI 斜杠命令'),
        picker.kind === 'skill' && picker.items.length === 0
          ? h('div', { className: 'cw-pop-note' },
            '没有找到技能（需含 SKILL.md 的目录），扫描位置：'
            + ((picker.ownDirs || []).map((dir) => dir.label + (dir.exists ? '（存在，' + dir.count + ' 个）' : '（不存在）')).join(' / ')
              || (picker.missingDirs || []).join(' / ')))
          : null,
        picker.kind === 'skill' && picker.items.some((item) => item.skill && !item.skill.hasDescription)
          ? h('div', { className: 'cw-pop-note' }, '不影响使用。')
          : null,
        picker.kind !== 'skill' && picker.items.length === 0 ? h('div', { className: 'cw-pop-title' }, '没有可选项') : null,
        picker.items.map((item) => h('button', {
          key: item.label + '|' + (item.value || ''),
          className: 'cw-pop-item',
          title: item.title || (item.desc ? item.label + ' — ' + item.desc : item.label),
          onClick: () => pickValue(item.value),
        },
          h(Icon, { name: picker.kind === 'file' ? 'file' : picker.kind === 'skill' ? 'skill' : 'slash' }),
          /* 文件名单独一列、按整卡宽度的 40% 给足空间（旧版 340px 小窗里只留 42%，
             文件名必被截断）。目录放在右边一列，从尾部开始省略。 */
          /* 斜杠命令前面的图标本身就是一条「/」，标签再带一个就变成「//clear」。
             这里把标签的前导斜杠去掉，斜杠只由图标表达。 */
          h('span', { className: 'cw-picker-name' }, picker.kind === 'slash' ? String(item.label).replace(/^\//, '') : item.label),
          item.desc ? h('span', { className: 'tail' + (item.descIsPath ? ' is-path' : '') }, item.desc) : null,
        )),
        picker.kind === 'skill' && picker.otherCount
          ? h('div', { className: 'cw-pop-note' }, picker.otherLabel + ' 还有 ' + picker.otherCount + ' 个技能，切到顶部那个助手才能用。')
          : null,
      );
      /* 浮层都挂在**被点的那个按钮**上（不再锚到整条 dock）：
         锚点元素自己就是 position: relative，弹层贴着按钮上沿展开。 */
      /* 可选模型清单由 Host 提供：
         - Claude：从 settings.json 的 env 读「别名 → 具体模型」；
         - Codex：从 config.toml 的 model_catalog_json 读模型目录（slug → 显示名）。
         读不到时 Claude 退回官方别名，Codex 只剩「默认」。 */
      const aliasEntries = () => {
        const info = models && models[currentProvider];
        const list = info && Array.isArray(info.aliases) ? info.aliases : [];
        if (list.length) return list;
        return currentProvider === 'claude'
          ? ['sonnet', 'opus', 'fable'].map((alias) => ({ alias, model: '' }))
          : [];
      };
      const renderModelMenu = () => h('div', {
        ref: modelMenuRef,
        className: 'cw-pop cw-model-pop' + (aliasEntries().length ? '' : ' is-narrow'),
        role: 'menu',
        'aria-label': '模型',
        style: { bottom: 'calc(100% + 6px)', left: '0' },
      },
        h('div', { className: 'cw-pop-title' }, '模型'),
        /* 「默认」是不覆盖 CLI 配置的选项，它到底是什么由 CLI 自己的配置决定。
           右侧直接写当前配置里的模型——同一个模型不再另起一行。
           否则配置写 sonnet 时会出现「默认 / sonnet / sonnet」三行说一件事。 */
        h('button', { className: 'cw-pop-item' + (viewSession && !viewSession.model ? ' is-current' : ''), onClick: () => setModel('') },
          h(Icon, { name: 'brain' }), '默认',
          h('span', { className: 'tail' }, (() => {
            const info = (models && models[currentProvider]) || {};
            const name = info.model || '';
            if (!name) return viewSession && !viewSession.model ? '当前' : null;
            return viewSession && !viewSession.model ? name + ' · 当前' : name;
          })())),
        /* 两个 CLI 都没有「列出可用模型」的稳定接口，但 Claude 的别名映射写在
           ~/.claude/settings.json 的 env 里（ANTHROPIC_DEFAULT_<别名>_MODEL），
           Host 已经把这份对应关系读出来了：菜单里别名在左、它指向的具体模型在右。
           读不到映射时退回官方别名，只显示名字。 */
        (aliasEntries()).map((entry) => h('button', {
          key: 'alias-' + entry.alias,
          className: 'cw-pop-item' + (viewSession && viewSession.model === entry.alias ? ' is-current' : ''),
          title: entry.model ? entry.alias + ' → ' + entry.model : entry.alias,
          onClick: () => setModel(entry.alias),
        },
        h(Icon, { name: 'brain' }), entry.alias,
        /* 选中项只写「当前」：具体模型名可能很长（scnet/DeepSeek-V4.1-Flash-1017-Event），
           拼上「· 当前」会被省略号截掉后半截，反而看不出是不是当前。 */
        h('span', { className: 'tail' }, (Boolean(viewSession && viewSession.model === entry.alias)
          ? '当前'
          : (entry.model || '别名'))),
        )),
      );
      const otherPending = sessions.find((session) => !session.archived && session.id !== currentId && session.pending);
      const hasPendingForOther = Boolean(otherPending) && !noticeClosed;
      const hasUpdate = updates && updates.entries && boot
        ? Object.keys(updates.entries).some((id) => {
          const entry = updates.entries[id];
          const info = boot.providers ? boot.providers[id] : null;
          return entry && entry.latest && info && info.version && entry.latest !== info.version;
        })
        : false;
      const ready = boot && boot.providers ? boot.providers[currentProvider] : null;
      const readyState = !boot ? 'starting' : ready && ready.installed ? 'ready' : 'offline';
      const modeList = modeOptions(viewSession);
      /* 任务清单：CLI 自己输出的 todo（TodoWrite / markdown 清单）才算数，读不到就不画 */
      const dockTodos = viewSession ? todosOf(items) : null;

      /**
       * 修改已发出的消息：CLI 的转录只追加、不能改写，所以「修改」不是真的改历史——
       * 把文字放回输入框、光标落到末尾，改完发出去的是新的一条（原消息保留）。
       * 附件不跟着重发：旧的已经喂给过 CLI 了，重发一份只会让它读两遍。
       */
      const editUserMessage = (item) => {
        const text = String((item && item.text) || '');
        if (!text) { showToast('这条消息只有附件，没有可修改的文字'); return; }
        setDraft(text);
        /* 回填后光标落到末尾：同步在下一拍做，等 syncEditor 把内容画进编辑器 */
        setTimeout(() => {
          const element = editorRef.current;
          if (!element) return;
          element.focus();
          if (typeof window !== 'undefined' && window.getSelection && document.createRange) {
            try {
              const range = document.createRange();
              range.selectNodeContents(element);
              range.collapse(false);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            } catch { /* 只读态忽略 */ }
          }
        }, 0);
        showToast('已放回输入框，改完发送是新消息');
      };

      /**
       * 用户气泡的正文：
       *   - 内联引用 `【原文】` 渲染成弱化的小块（和草稿里看到的形状一致）；
       *   - 老消息里的 `> ` 行仍按引用块渲染（1.0.46 发出去的会留在历史里）。
       * 其余一律纯文本——不给用户气泡上完整 Markdown，用户写的 `*`、`_` 不该变斜体。
       */
      const renderInlineQuotes = (line) => {
        const nodes = [];
        const pattern = /【([^】]*)】/g;
        let cursor = 0;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          if (match.index > cursor) nodes.push(line.slice(cursor, match.index));
          nodes.push(h('span', { key: 'qi' + nodes.length, className: 'cw-quote-inline' }, match[1]));
          cursor = match.index + match[0].length;
        }
        if (cursor < line.length) nodes.push(line.slice(cursor));
        return nodes;
      };

      const renderUserText = (value) => {
        const lines = String(value || '').split(/\r?\n/);
        const nodes = [];
        let plain = [];
        let quote = [];
        const flushQuote = () => {
          if (!quote.length) return;
          nodes.push(h('div', { key: 'q' + nodes.length, className: 'cw-quote-block' },
            quote.map((line, lineIndex) => h('div', { key: lineIndex, className: 'cw-quote-line' }, line))));
          quote = [];
        };
        const flushPlain = () => {
          if (!plain.length) return;
          /* 一行一行拼：行间补真实换行符，行内再切出内联引用 */
          const children = [];
          plain.forEach((line, lineIndex) => {
            if (lineIndex) children.push('\n');
            children.push(...renderInlineQuotes(line));
          });
          nodes.push(h('div', { key: 'p' + nodes.length, className: 'cw-plain-block' }, children));
          plain = [];
        };
        for (const line of lines) {
          if (line === '>' || line.startsWith('> ')) {
            flushPlain();
            quote.push(line === '>' ? '' : line.slice(2));
          } else {
            flushQuote();
            plain.push(line);
          }
        }
        /* 草稿末尾的换行别渲染成气泡底部的一行空白 */
        while (plain.length && plain[plain.length - 1] === '') plain.pop();
        flushQuote();
        flushPlain();
        return nodes;
      };

      const renderItems = () => {
        if (!viewSession) return h(EmptyState, { provider: currentProvider, onPick: (text) => startNew(currentProvider, undefined, text) });
        if (!items.length) return h(EmptyState, { provider: viewSession.provider, onPick: (text) => send(text) });
        const nodes = [];
        let index = 0;
        while (index < items.length) {
          const item = items[index];
          if (!item || !item.kind) { index += 1; continue; }
          if (item.kind === 'user') {
            // data-msg 是右侧轮次条的锚点：点刻度就滚到这里
            const atts = Array.isArray(item.attachments) ? item.attachments : [];
            const attSession = viewSession ? viewSession.id : '';
            nodes.push(h('div', { key: item.id || index, className: 'cw-msg cw-msg-user', 'data-msg': item.id || '' },
              h('div', { className: 'cw-msg-label' },
                item.text ? h('span', { className: 'cw-msg-acts' },
                  h('button', {
                    type: 'button', title: '复制这条消息', 'aria-label': '复制这条消息',
                    onClick: () => copyText(item.text, '已复制这条消息'),
                  }, h(Icon, { name: 'copy', size: 12 })),
                  h('button', {
                    type: 'button', title: '修改这条消息（放回输入框重发）', 'aria-label': '修改这条消息',
                    onClick: () => editUserMessage(item),
                  }, h(Icon, { name: 'edit', size: 12 })),
                ) : null,
                h('span', null, '你 · ' + (timeAgo(item.at) || '刚刚')),
              ),
              atts.length ? h('div', { className: 'cw-msg-atts' }, atts.map((att, attIndex) => (
                att.kind === 'image' && att.file
                  ? h('img', {
                    key: att.file || attIndex,
                    className: 'cw-msg-att-img',
                    /* 图片由 Host 的 /attachment 端点回放：路径在数据目录里，
                       /fs/file 的边界只放行会话工作目录，读不到这里。 */
                    src: API + '/attachment?session=' + encodeURIComponent(attSession) + '&file=' + encodeURIComponent(att.file),
                    alt: att.name || '图片',
                    title: att.name || '图片',
                  })
                  : h('span', { key: att.file || att.name || attIndex, className: 'cw-msg-att-file', title: att.name || '' },
                    h(Icon, { name: att.kind === 'dir' ? 'folder' : 'file', size: 14 }),
                    h('span', { className: 'cw-attach-name' }, att.name || '附件'))
              ))) : null,
              item.text ? h('div', { className: 'cw-bubble-user' }, renderUserText(item.text)) : null,
            ));
            index += 1;
            continue;
          }
          if (item.kind === 'assistant') {
            nodes.push(h('div', { key: item.id || index, className: 'cw-msg' },
              h('div', { className: 'cw-msg-label' },
                h('span', null, viewSession.provider === 'codex' ? 'Codex' : 'Claude Code'),
                item.text ? h('span', { className: 'cw-msg-acts' },
                  h('button', {
                    type: 'button', title: '复制这条回复', 'aria-label': '复制这条回复',
                    onClick: () => copyText(item.text, '已复制这条回复'),
                  }, h(Icon, { name: 'copy', size: 12 })),
                ) : null,
              ),
              h(Markdown, { text: item.text || '' }),
              item.streaming ? h('span', { className: 'cw-cursor' }) : null,
            ));
            index += 1;
            continue;
          }
          if (item.kind === 'thinking') {
            nodes.push(h(ThinkLine, { key: item.id || index, item, tick }));
            index += 1;
            continue;
          }
          if (item.kind === 'tool') {
            if (viewSession.provider === 'codex' || item.audit) {
              nodes.push(h(AuditCard, { key: item.id || index, item }));
              index += 1;
              continue;
            }
            const tools = [];
            while (index < items.length && items[index].kind === 'tool' && !items[index].audit) {
              tools.push(items[index]);
              index += 1;
            }
            nodes.push(h(ProcCard, { key: 'proc-' + (tools[0] && tools[0].id), tools, tick }));
            continue;
          }
          if (item.kind === 'filechange') {
            nodes.push(h(FileChangeCard, { key: item.id || index, item }));
            index += 1;
            continue;
          }
          if (item.kind === 'error') {
            nodes.push(h(ErrorCard, { key: item.id || index, item, onRetry: retryLast }));
            index += 1;
            continue;
          }
          if (item.kind === 'notice') {
            nodes.push(h('div', { key: item.id || index, className: 'cw-notice-line' }, item.text || ''));
            index += 1;
            continue;
          }
          index += 1;
        }
        if (pending) {
          nodes.push(h(ApprovalCard, {
            key: 'approval-' + pending.requestId,
            session: viewSession,
            pending,
            tick,
            result: approvalResult,
            onDecide: decide,
          }));
        } else if (approvalResult) {
          nodes.push(h('div', { key: 'approval-result', className: 'cw-approval' },
            h('div', { className: 'cw-ap-head' }, h(Icon, { name: 'shield', size: 15 }), h('span', { className: 'cw-ap-title' }, '审批已处理')),
            h('div', { className: 'cw-ap-body' }, h('div', { className: 'cw-ap-resolved' }, approvalResult)),
          ));
        }
        /* 任务清单不再画在正文末尾：它现在钉在输入卡上方（TodoCard 在 .cw-dock 里），
           正文末尾那个位置留给「正在执行的工具」状态行。 */
        /* items 只保留最近 MAX_ITEMS 条（600），超长会话会丢掉开头。
           不能让界面看起来像是从中间凭空开始的——模型续聊时看到的是 CLI 的完整记录，
           界面显示的并不是全部，这一点必须说出来。 */
        if (viewSession.omittedItems > 0) {
          nodes.unshift(h('div', { key: 'omitted', className: 'cw-omitted' },
            h(Icon, { name: 'alert', size: 12 }),
            h('span', null, '更早的 ' + viewSession.omittedItems + ' 条未在界面显示（对话本体仍在 CLI 记录里，模型续聊时仍能看到）'),
          ));
        }
        return nodes;
      };

      return h('div', {
        ref: rootRef,
        className: 'cw-root' + (narrow && inspOpen ? ' cw-insp-open' : '') + (compact && railOpen ? ' cw-rail-open' : ''),
        'data-provider': currentProvider,
        // Claude 蓝 / Codex 紫：计划开关和「计划中」标签跟随当前助手的色相
        style: { '--cw-accent-ink': currentProvider === 'codex' ? 'var(--cw-codex)' : 'var(--cw-running)' },
        'data-narrow': narrow ? '1' : undefined,
        'data-compact': compact ? '1' : undefined,
      },
        h('style', null, CSS),
        h('div', { className: 'cw-top' },
          compact ? h('button', { className: 'cw-iconbtn cw-railbtn', onClick: () => setRailOpen(!railOpen), title: '会话栏', 'aria-label': '会话栏' }, h(Icon, { name: 'sidebar' })) : null,
          h('div', { className: 'cw-brand' }, h('span', { className: 'cw-logo' }, h(Icon, { name: 'grid', size: 13 })), 'CLI 工作台'),
          h('span', { className: 'cw-sep' }),
          h('div', { className: 'cw-providers', role: 'tablist', 'aria-label': '选择助手' },
            PROVIDERS.map((provider) => {
              const badge = providerBadge(provider.id);
              return h('button', {
                key: provider.id,
                className: 'cw-prov is-' + provider.id + (currentProvider === provider.id ? ' is-active' : '') + (badge ? ' has-alert' : ''),
                role: 'tab',
                'aria-selected': currentProvider === provider.id,
                title: '只看 ' + provider.label + ' 的会话与工作区',
                onClick: () => switchProvider(provider.id),
              },
              h(Icon, { name: provider.id === 'claude' ? 'brain' : 'terminal', size: 13 }),
              provider.label,
              badge ? h('span', { className: 'cw-badge' }, badge) : null,
              );
            }),
          ),
          h('div', { className: 'cw-top-right' },
            h('button', {
              className: 'cw-path cw-project',
              title: viewSession ? viewSession.cwd : (boot ? boot.defaultCwd : ''),
              onClick: () => startNew(currentProvider, viewSession ? viewSession.cwd : undefined),
            },
            h(Icon, { name: 'folder', size: 13 }),
            h('span', null, fmtPath(viewSession ? viewSession.cwd : (boot ? boot.defaultCwd : ''))),
            h(Icon, { name: 'chevDown', size: 11 }),
            ),
            h('span', { className: 'cw-sep' }),
            h('span', { className: 'cw-ready', 'data-state': readyState },
              h('i', { className: 'cw-dot' }),
              (ready ? ready.label + ' ' : '') + (readyState === 'ready' ? '已就绪' : readyState === 'starting' ? '启动中…' : '未连接'),
            ),
            h('button', { className: 'cw-iconbtn' + (hasUpdate ? ' has-update' : ''), title: hasUpdate ? '设置 · 有 CLI 新版本可用' : '设置', onClick: () => setShowSettings(true) },
              h(Icon, { name: 'settings' }), hasUpdate ? h('i', { className: 'cw-update-dot' }) : null,
            ),
            h('button', { className: 'cw-iconbtn' + (inspOpen ? ' is-on' : ''), title: '检查器', onClick: toggleInspector }, h(Icon, { name: 'panel' })),
          ),
        ),
        hasPendingForOther ? h('div', { className: 'cw-notice' },
          h(Icon, { name: 'alert', size: 14 }),
          h('span', { className: 'cw-nt-text' },
            h('b', null, providerMeta(otherPending.provider).label),
            ' 有 ' + (otherPending.pendingCount || 1) + ' 个会话等你确认：' + otherPending.title + ' · 等待审批',
          ),
          h('button', { onClick: () => { const id = otherPending.id; setTopProvider(otherPending.provider || 'claude'); setQuery(''); selectSession(id); } }, '切过去处理'),
          h('button', { className: 'cw-close', onClick: () => setNoticeClosed(true), 'aria-label': '关闭提醒' }, h(Icon, { name: 'x', size: 13 })),
        ) : null,
        h('div', { className: 'cw-main' },
          h(Rail, {
            sessions, workspaces, registryReady, currentId, provider: currentProvider, query, setQuery, fold,
            toggleFold: (key) => setFold((current) => ({ ...current, [key]: current[key] === 'collapsed' ? 'open' : current[key] === 'open' ? 'fold' : 'collapsed' })),
            // 「展开剩余 N 个会话」专用：无论当前处于默认档还是折叠档，都直接铺开全部
            expandGroup: (key) => setFold((current) => ({ ...current, [key]: 'open' })),
            batch, selected, toggleSelect, selectAll,
            // 批量模式下点整行打钩；平时 Ctrl/⌘ 点或 Shift 点可以顺手多选并进入批量
            onToggleSelect: (id) => toggleSelect(id),
            onNew: () => startNew(currentProvider),
            onAddWorkspace: addWorkspace,
            onNewIn: createInWorkspace,
            onOpen: (id, extend) => {
              if (extend) {
                if (!batch) { setBatch(true); setSelected(new Set([currentId, id].filter(Boolean))); }
                else toggleSelect(id);
                return;
              }
              selectSession(id);
            },
            onMenu: (session, x, y) => setCtxMenu({ session, x, y }),
            onGroupMenu: askGroupMenu,
            onArchiveSelected: batchArchive,
            onDeleteSelected: batchDelete,
            onExitBatch: () => { setBatch(false); setSelected(new Set()); },
          }),
          compact && railOpen ? h('div', { className: 'cw-backdrop', onClick: () => setRailOpen(false) }) : null,
          h('main', { className: 'cw-conv' },
            h('div', { className: 'cw-conv-head' },
              h('span', { className: 'cw-conv-title', title: viewSession ? viewSession.title : '新会话' }, viewSession ? viewSession.title : '新会话'),
              planMode ? h('button', {
                className: 'cw-planchip',
                title: '计划模式已开：下一条消息只出计划、不改文件。点一下关掉',
                onClick: () => setPlanMode(false),
              }, h(Icon, { name: 'plan', size: 12 }), '计划中') : null,
              viewSession ? h(ProviderTag, { provider: viewSession.provider }) : null,
              viewSession ? h('button', {
                className: 'cw-mode' + (menu === 'mode' ? ' is-open' : ''),
                onClick: () => setMenu(menu === 'mode' ? null : 'mode'),
                title: '切换权限 / 沙箱档位',
                'aria-haspopup': 'menu',
                'aria-expanded': menu === 'mode',
              }, h(Icon, { name: 'shield', size: 13 }), h('span', null, permissionLabel(viewSession)), h(Icon, { name: 'chevDown', size: 11 })) : null,
              viewSession && menu === 'mode' ? h('div', {
                className: 'cw-pop cw-mode-pop',
                style: { top: 'calc(100% + 6px)', right: '14px', position: 'absolute' },
                role: 'menu',
                'aria-label': viewSession.provider === 'codex' ? '沙箱档位' : '权限模式',
              },
                h('div', { className: 'cw-pop-title' }, viewSession.provider === 'codex' ? '沙箱档位（Codex 无审批通道）' : '权限模式'),
                modeList.map((mode) => {
                  const dead = unusableMode(viewSession.provider, mode.id);
                  return h('button', {
                    key: mode.id,
                    className: 'cw-pop-item' + (dead ? ' is-dead' : ''),
                    onClick: () => (dead ? showToast(sandboxDeadReason()) : setMode(mode.id)),
                    'aria-disabled': dead ? 'true' : undefined,
                    title: dead ? sandboxDeadReason() : undefined,
                  }, h(Icon, { name: mode.id === 'plan' ? 'task' : mode.id === 'bypassPermissions' || mode.id === 'bypass' ? 'alert' : 'shield' }),
                  h('span', null, mode.label),
                  h('span', { className: 'tail' }, dead ? '本机不可用' : sandboxHint(mode)));
                }),
              ) : null,
            ),
            pending ? h('div', { className: 'cw-await', role: 'status' },
              h(Icon, { name: 'clock', size: 13 }),
              h('span', null, '等待你批准：' + pending.toolName + '（' + Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)) + ' 秒后自动拒绝）'),
              h('button', {
                onClick: () => { const element = scrollRef.current; if (element) element.scrollTop = element.scrollHeight; },
              }, '跳到审批卡'),
            ) : null,
            streamState === 'retrying'
              ? h('div', { className: 'cw-offline', role: 'status' },
                h('span', { className: 'cw-pulse', 'aria-hidden': 'true' }),
                '连接中断，正在重连…')
              : null,
            /* 外层只负责定位（不滚动），滚动在里面的 .cw-scroll 里。
   原因：「回到最新」和轮次条如果用 absolute 挂在滚动容器内部，它们会跟着内容一起
   滚走（用户看到的「按钮被页面带着从右下角跑到中间」就是这么来的）。 */
            h('div', { className: 'cw-viewport' },
              h('div', {
                className: 'cw-scroll',
                ref: scrollRef,
                /* 选区浮动按钮用视口坐标定位，滚动后位置就不对了：直接收起来。 */
                onScroll: (event) => { measureDistance(event); if (quoteSel) setQuoteSel(null); },
                /* 松开鼠标时看选区：落在同一条消息里才浮出「引用」按钮。
                   放在滚动容器上而不是 document 上：侧栏/输入框里的选择不该触发。 */
                onMouseUp: captureQuote,
              },
                h('div', { className: 'cw-page' }, renderItems(),
                  /* 正在干什么写在正文最后一行（DSH 的 RunningStatus 就在这里） */
                  h(RunningLine, { session: viewSession, items, tick }),
                ),
              ),
              viewSession ? h(TurnRail, {
                items,
                scrollRef,
                provider: viewSession.provider,
              }) : null,
              /* 「回到底部」钉在会话内容右下角，不随内容滚动；只有一个箭头 */
              awayFromBottom ? h('button', {
                className: 'cw-tolatest',
                title: '回到最新消息',
                'aria-label': '回到最新消息',
                onClick: stickToBottom,
              }, h(Icon, { name: 'chevDown', size: 15 })) : null,
            ),
            h('div', { className: 'cw-dock' },
              /* 任务清单在输入卡上方——DSH 的 conversation.input.dock 就是这个地方 */
              viewSession && dockTodos ? h(TodoCard, { todos: dockTodos }) : null,
              h('div', {
                className: 'cw-inputbox' + (dragging ? ' is-drag' : ''),
                /* 拖文件进来：与 DSH 的 drop 目标同一套语义，只是范围收在输入卡上 */
                onDragOver: (event) => {
                  const types = event.dataTransfer && event.dataTransfer.types;
                  if (!types || Array.from(types).indexOf('Files') < 0) return;
                  event.preventDefault();
                  if (!dragging) setDragging(true);
                },
                onDragLeave: (event) => {
                  if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
                  setDragging(false);
                },
                onDrop: (event) => {
                  if (!event.dataTransfer) return;
                  event.preventDefault();
                  setDragging(false);
                  const picked = transferFiles(event.dataTransfer);
                  addFiles(picked.files, picked.directories);
                },
              },
                attachments.length ? h('div', { className: 'cw-attachrail' }, attachments.map((item) => (
                  item.kind === 'image'
                    ? h('div', { key: item.id, className: 'cw-attach-img' },
                      h('img', { src: item.previewUrl, alt: item.name, title: item.name }),
                      h('button', {
                        type: 'button',
                        className: 'cw-attach-x',
                        title: '移除这张图片',
                        'aria-label': '移除 ' + item.name,
                        onClick: () => removeAttachment(item.id),
                      }, h(Icon, { name: 'x', size: 10 })))
                    : h('div', { key: item.id, className: 'cw-attach-file' },
                      h(Icon, { name: item.kind === 'dir' ? 'folder' : 'file', size: 16 }),
                      h('span', { className: 'cw-attach-name', title: item.path || item.name }, item.name),
                      h('span', { className: 'cw-attach-size' }, item.kind === 'dir' ? '文件夹' : fmtBytes(item.size)),
                      h('button', {
                        type: 'button',
                        className: 'cw-attach-x',
                        title: '移除这个文件',
                        'aria-label': '移除 ' + item.name,
                        onClick: () => removeAttachment(item.id),
                      }, h(Icon, { name: 'x', size: 10 })))
                ))) : null,
                /* 输入区：contenteditable（不是 textarea）——这样内联引用才能画成一枚
                   真正的「块」，嵌在正文流里，跟 DSH 的 composer 一样。
                   正文由 syncEditor 按 draft 画进来，React 不管它的子节点。 */
                h('div', {
                  className: 'cw-editor',
                  ref: editorRef,
                  contentEditable: true,
                  suppressContentEditableWarning: true,
                  role: 'textbox',
                  'aria-multiline': 'true',
                  'aria-label': '任务输入',
                  'data-placeholder': currentId ? '描述任务…' : ('描述任务，Enter 会新建一个 ' + providerMeta(currentProvider).label + ' 会话'),
                  onInput: onEditorInput,
                  onKeyUp: rememberCaret,
                  onMouseUp: rememberCaret,
                  /* 截图/复制的图片直接贴进输入框：把剪贴板里的 file item 变成附件，
                     不让它退化成一段乱码文本（DSH 的 composer 也是这么接的）。
                     纯文本粘贴则强制走无格式插入，别把网页的 HTML 带进来。 */
                  onPaste: (event) => {
                    const data = event.clipboardData;
                    if (!data) return;
                    const picked = transferFiles(data);
                    if (picked.files.length) {
                      event.preventDefault();
                      addFiles(picked.files, picked.directories);
                      return;
                    }
                    const plain = data.getData ? data.getData('text/plain') : '';
                    if (!plain) return;
                    event.preventDefault();
                    insertPlainText(plain);
                  },
                  onKeyDown: (event) => {
                    // 中文输入法按 Enter 是「确认候选词」，此时 keydown 仍会到这里。
                    // 不判 isComposing 就会把半句话发出去，草稿也随之清空。
                    if (event.nativeEvent && event.nativeEvent.isComposing) return;
                    if (event.keyCode === 229) return;
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      send();
                    }
                  },
                }),
                h('div', { className: 'cw-input-foot' },
                  h('div', { className: 'cw-input-tools' },
                    /* 附件：系统文件选择器。样式跟 DSH 的加号一致（28px 圆、selector 底）。 */
                    h('input', {
                      ref: fileInputRef,
                      type: 'file',
                      multiple: true,
                      hidden: true,
                      onChange: (event) => {
                        /* 必须先拷成数组再清空：`input.value = ''` 会同步清掉
                           FileList（它是活对象），直接传 event.target.files 会变成空列表，
                           表现就是「对话框选了文件但输入框里什么都没出现」。 */
                        const list = Array.from(event.target.files || []);
                        event.target.value = '';
                        addFiles(list);
                      },
                    }),
                    h('button', {
                      type: 'button',
                      className: 'cw-add',
                      title: '添加图片或文件（也可以直接粘贴、拖进来）',
                      'aria-label': '添加图片或文件',
                      onClick: () => { if (fileInputRef.current) fileInputRef.current.click(); },
                    }, h(Icon, { name: 'plus', size: 14 })),
                    /* 文件 / 斜杠命令：各自一个锚点容器，浮层贴在按钮上沿。
                       没有会话时置灰：引用文件要跟着一个工作目录走，必须先有会话。
                       title 说明原因——灰按钮没解释会被当成「坏了」。 */
                    h('span', { className: 'cw-anchor' },
                      h('button', {
                        type: 'button',
                        className: 'cw-tool',
                        title: currentId ? '引用项目文件（· 或 @ 键）' : '先新建会话，才能引用该会话工作目录里的文件',
                        'aria-label': '引用项目文件',
                        onClick: () => openPicker('file'),
                        disabled: !currentId,
                      }, h(Icon, { name: 'at' })),
                    ),
                    h('span', { className: 'cw-anchor' },
                      h('button', {
                        type: 'button',
                        className: 'cw-tool',
                        title: currentId ? 'CLI 斜杠命令（/ 键）' : '先新建会话，命令发给会话才有意义',
                        'aria-label': 'CLI 斜杠命令',
                        onClick: () => openPicker('slash'),
                        disabled: !currentId,
                      }, h(Icon, { name: 'slash' })),
                    ),
                    h('span', { className: 'cw-tool-sep' }),
                    h('span', { className: 'cw-anchor' },
                      h('button', {
                        type: 'button',
                        className: 'cw-pillbtn' + (picker && picker.kind === 'skill' ? ' is-open' : ''),
                        title: '技能（本地与工作区的 skills）',
                        'aria-label': '选择技能',
                        onClick: () => openPicker('skill'),
                      }, h(Icon, { name: 'skill' }), h('span', { className: 'cw-pill-text' }, '技能')),
                    ),
                    h('button', {
                      type: 'button',
                      className: 'cw-pillbtn' + (planMode ? ' is-on' : ''),
                      title: planMode ? '计划模式已开：下一条消息只出计划、不动文件' : '计划模式：先出计划再执行',
                      'aria-label': '计划模式',
                      onClick: () => {
                        setPlanMode(!planMode);
                        showToast(planMode ? '计划模式已关' : (currentProvider === 'codex'
                          ? '计划模式已开：下一条消息会带上「只做计划、不改文件」的指令'
                          : '计划模式已开：下一条消息会要求先出方案'));
                      },
                    }, h(Icon, { name: 'clipboard' }), h('span', { className: 'cw-pill-text' }, '计划')),
                    /* 模型选择器自带锚点容器：浮层贴着按钮上沿，不再跑到输入卡右边 */
                    h('span', { className: 'cw-anchor' },
                      h('button', {
                        type: 'button',
                        className: 'cw-picker' + (menu === 'model' ? ' is-open' : ''),
                        title: '模型：' + (viewSession && viewSession.model ? viewSession.model : '默认'),
                        onClick: () => setMenu(menu === 'model' ? null : 'model'),
                      },
                      h(Icon, { name: 'brain', size: 14 }),
                      h('span', { className: 'cw-picker-label' }, (viewSession && viewSession.model ? viewSession.model.split('/').pop() : '默认模型')),
                      h(Icon, { name: 'chevDown', size: 11 }),
                      ),
                      menu === 'model' ? renderModelMenu() : null,
                    ),
                    fileRef ? h('span', { className: 'cw-ref' },
                      h(Icon, { name: 'file', size: 12 }),
                      h('span', { className: 'cw-ref-name' }, basename(fileRef)),
                      h('button', { type: 'button', className: 'x', onClick: () => setFileRef(''), 'aria-label': '移除文件引用' }, h(Icon, { name: 'x', size: 11 })),
                    ) : null,
                    /* 已引用的技能：一颗小卡片，只有名字（跟 DSH 的 skill 卡片一致）。
                       点 × 会同时从草稿里删掉那个 /名字 令牌。 */
                    activeSkills().map((ref) => h('span', { key: ref, className: 'cw-ref cw-ref-skill' },
                      h(Icon, { name: 'skill', size: 12 }),
                      h('span', { className: 'cw-ref-name' }, ref.slice(1)),
                      h('button', {
                        type: 'button',
                        className: 'x',
                        'aria-label': '移除技能 ' + ref.slice(1),
                        onClick: () => {
                          setSkillRefs((current) => current.filter((entry) => entry !== ref));
                          setDraft((current) => current
                            .replace(new RegExp('(^|\\s)' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)', 'g'), '$1')
                            .replace(/\s{2,}/g, ' ')
                            .trim());
                        },
                      }, h(Icon, { name: 'x', size: 11 })),
                    )),
                  ),
                  viewSession && (viewSession.status === 'running' || viewSession.status === 'waiting')
                    ? h('button', { className: 'cw-send stop', onClick: stop, title: '停止', 'aria-label': '停止' }, h(StopGlyph, { size: 16 }))
                    : h('button', {
                      className: 'cw-send',
                      onClick: () => send(),
                      disabled: !draft.trim() && attachments.length === 0,
                      title: ['发送（Enter）', ...(draft.trim() || attachments.length ? [] : [' · 先写任务或加个附件'])].join(''),
                      'aria-label': '发送',
                    }, h(Icon, { name: 'send', size: 16 })),
                ),
                /* 选择浮层挂在输入卡上（不是挂在 28px 的小按钮上）：宽度跟输入卡一致，
                   这正是 DSH trigger menu 的做法（left:0 / right:0 贴着输入卡）。 */
                picker ? renderPickerPop() : null,
              ),
              h(StatsRow, { session: viewSession, items }),
            ),
          ),
          inspOpen ? h('aside', {
            className: 'cw-insp',
            style: { width: narrow ? undefined : inspWidth + 'px' },
          },
            h('div', {
              className: 'cw-insp-grip',
              role: 'separator',
              'aria-orientation': 'vertical',
              'aria-label': '拖动调整右栏宽度，双击复位',
              title: '拖动调整宽度，双击复位',
              onPointerDown: beginInspResize,
              onDoubleClick: () => {
                setInspWidth(272);
                try { window.localStorage && window.localStorage.setItem('cw.inspWidth', '272'); } catch { /* ignore */ }
              },
            }),
            h(Inspector, {
              session: viewSession, items, tick, tab: inspTab, setTab: setInspTab,
              tree, treeLoading, preview, highlight,
              onOpenFile: openPreview,
              onRefreshTree: () => loadTree(currentId),
              onSave: savePreview,
              onOpen: () => preview && openExternal(preview.path),
              onLocate: () => { if (preview) { setInspTab('files'); setHighlight(preview.path); } },
              onRevokeTool: revokeTool,
              onCopyPage: copyPageUrl,
              onEditRules: () => setRulesOpen(true),
              onClose: () => setInspOpen(false),
            }),
          ) : null,
          narrow && inspOpen ? h('div', { className: 'cw-backdrop', onClick: () => setInspOpen(false) }) : null,
        ),
        ctxMenu ? h(ContextMenu, { menu: ctxMenu, onClose: () => setCtxMenu(null), onAction: ctxAction }) : null,
        showNew ? h(NewSessionDialog, {
          boot, initial: newInitial, defaults,
          onClose: () => setShowNew(false),
          onCreate: createSession,
        }) : null,
        wsDelete ? h(WorkspaceDeleteDialog, {
          target: wsDelete,
          busy: wsDeleting,
          error: wsDeleteError,
          onClose: () => { if (!wsDeleting) setWsDelete(null); },
          onConfirm: confirmDeleteWorkspace,
        }) : null,
        wsPickerOpen ? h(DirPicker, {
          initial: '',
          onClose: () => setWsPickerOpen(false),
          onPick: (picked) => { setWsPickerOpen(false); restoreWorkspace(picked, undefined, topProvider); },
        }) : null,
        rulesOpen ? h(RulesDialog, {
          cwd: viewSession ? viewSession.cwd : (boot ? boot.defaultCwd : ''),
          provider: viewSession ? viewSession.provider : currentProvider,
          onClose: () => setRulesOpen(false),
          onToast: (text) => showToast(text),
        }) : null,
        showSettings ? h(SettingsDialog, {          sessions, updates, boot, upgrading, defaultSettings: defaults, onCopy: copyText,
          onClose: () => setShowSettings(false),
          onSaveDefaults: async (next) => {
            try {
              const saved = await api('/settings', { method: 'POST', body: JSON.stringify(next) });
              setDefaults(saved);
              const backend = { auto: '自动', unelevated: 'unelevated', elevated: 'elevated' }[saved.codexSandboxBackend] || '自动';
              showToast('默认权限已保存：Claude ' + (CLAUDE_MODES.find((m) => m.id === saved.claudeMode) || {}).label
                + ' / Codex ' + (CODEX_MODES.find((m) => m.id === saved.codexMode) || {}).label
                + ' / 沙箱后端 ' + backend);
              // Changing the backend re-probes the machine, so pull a fresh status.
              const status = await api('/status');
              setBoot(status);
              codexSandboxState = (status && status.providers && status.providers.codex && status.providers.codex.sandbox) || null;
            } catch (error) { showToast(error.message); }
          },
          onClose: () => setShowSettings(false),
          onRestore: restore,
          onRestoreAll: async () => {
            for (const session of sessions.filter((item) => item.archived)) await patchSession(session.id, { archived: false });
            showToast('已全部取消归档');
          },
          onUpgrade: async (id) => {
            setUpgrading(id);
            try {
              const result = await api('/upgrade', { method: 'POST', body: JSON.stringify({ provider: id }) });
              if (result && result.ok) {
                showToast('已升级，重启 CLI 进程后生效');
                const next = await api('/status');
                setBoot(next);
                codexSandboxState = (next && next.providers && next.providers.codex && next.providers.codex.sandbox) || null;
                await refreshUpdates(true);
              } else {
                showToast('升级失败：' + (result && result.output ? result.output : '未知错误'));
              }
            } catch (error) { showToast(error.message); } finally { setUpgrading(''); }
          },
          onRefreshUpdates: () => refreshUpdates(true),
        }) : null,
        groupMenu ? h('div', {
          className: 'cw-menu cw-groupmenu',
          role: 'menu',
          'aria-label': '工作区操作',
          style: {
            left: Math.min(groupMenu.x, Math.max(12, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 200)) + 'px',
            top: Math.min(groupMenu.y, Math.max(12, (typeof window !== 'undefined' ? window.innerHeight : 800) - 200)) + 'px',
            zIndex: 92,
          },
          onClick: (event) => event.stopPropagation(),
        },
          h('button', { onClick: () => groupAction('new') }, h(Icon, { name: 'plus' }), '新建会话'),
          h('button', { onClick: () => groupAction('rename') }, h(Icon, { name: 'edit' }), '重命名工作区'),
          h('button', { onClick: () => groupAction('openfolder') }, h(Icon, { name: 'folder' }), '打开文件夹'),
          h('div', { className: 'cw-menu-sep' }),
          h('button', { className: 'danger', onClick: () => groupAction('delete') }, h(Icon, { name: 'trash' }), '移除工作区'),
        ) : null,
        groupMenu ? h('div', { style: { position: 'absolute', inset: 0, zIndex: 91 }, onClick: () => setGroupMenu(null) }) : null,
        confirmBox ? h(ConfirmDialog, {
          title: confirmBox.title,
          /* 这句不能照抄 DSH 的「转录与改动记录」：我们删的是工作台记录、附件和
             CLI 那边的会话文件，项目目录里的文件（包括 CLI 改过的代码）一个都不动。
             写成「改动记录会删」会让人以为代码改动被回滚了。 */
          body: confirmBox.ids.length > 1
            ? '这些会话的聊天记录、附件，以及 CLI 那边的会话文件都会删掉，无法恢复；项目文件不受影响。'
            : '这个会话的聊天记录、附件，以及 CLI 那边的会话文件都会删掉，无法恢复；项目文件不受影响。',
          okLabel: confirmBox.ids.length > 1 ? '删除 ' + confirmBox.ids.length + ' 个' : '删除',
          danger: true,
          busy: confirmBox.busy,
          error: confirmBox.error,
          onCancel: () => { if (!confirmBox.busy) setConfirmBox(null); },
          onConfirm: doConfirmDelete,
        }) : null,
        renameBox ? h(RenameDialog, {
          title: '重命名会话',
          label: '会话名称',
          value: renameBox.value,
          busy: renameBox.busy,
          error: renameBox.error,
          onChange: (value) => setRenameBox({ ...renameBox, value, error: '' }),
          onCancel: () => { if (!renameBox.busy) setRenameBox(null); },
          onConfirm: submitRename,
        }) : null,
        wsRename ? h(RenameDialog, {          title: '重命名工作区',
          label: '工作区名称（只改左栏显示，不改磁盘目录）',
          value: wsRename.value,
          busy: wsRename.busy,
          error: wsRename.error,
          onChange: (value) => setWsRename({ ...wsRename, value, error: '' }),
          onCancel: () => { if (!wsRename.busy) setWsRename(null); },
          onConfirm: submitWsRename,
        }) : null,
        /* 选中正文后浮出的「引用」：点一下变成输入框上方的一颗 chip。
           onMouseDown 里 preventDefault 保住选区（虽然按钮只读已存下的文字），
           视觉上也不会闪一下就把选中态清掉。 */
        quoteSel ? h('button', {
          type: 'button',
          className: 'cw-quotebtn',
          style: { left: quoteSel.x + 'px', top: quoteSel.y + 'px' },
          title: '引用这段文字',
          'aria-label': '引用这段文字',
          onMouseDown: (event) => event.preventDefault(),
          onClick: addQuote,
        }, h(Icon, { name: 'quote', size: 12 }), '引用') : null,
        toast ? h('div', { className: 'cw-toast' },
          h('span', null, toast.text),
          toast.action ? h('button', { onClick: () => { toast.action.onClick(); setToast(null); } }, toast.action.label) : null,
        ) : null,
        menu || picker || ctxMenu ? h('div', { style: { position: 'absolute', inset: 0, zIndex: 55 }, onClick: () => { setMenu(null); setPicker(null); setCtxMenu(null); } }) : null,
      );
    }

    function mergeSession(list, session) {
      if (!session || !session.id) return list;
      const index = list.findIndex((item) => item.id === session.id);
      if (index < 0) return [session, ...list];
      const next = list.slice();
      next[index] = { ...next[index], ...session };
      return next;
    }

    /**
     * 侧栏「CLI 工作台」图标。DSH 用 <span class="panelGlyph" aria-hidden> 包住它，
     * 展开栏 16px、收起成 56px 轨道时 18px，描边跟着 DSH 自家图标走 1.5px。
     * 旧版是一个空窗口框（只有两个竖线），16px 下缩成一个小方块，什么也看不出；
     * 现在换成终端提示符 `>_`：右边一条光标块，一眼能认出这是命令行入口。
     * 描边取 1.7，与「插件 / 自动化任务 / 工作台 / 更多」这些 16 网格 SVG 的视觉
     * 粗细对齐（它们在 16px 下描边会落在 1.7 左右），免得本图标显得比邻居细。
     */
    function WorkbenchIcon({ size = 16, active }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.7',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block', opacity: active ? 1 : 0.9 },
      },
        h('path', { d: 'M3.2 4.6 6.6 8 3.2 11.4' }),
        h('path', { d: 'M8.2 11.4h4.6' }),
      );
    }

    /**
     * 兜底错误边界。App 是一棵手写 h() 的大树，任何一处数据形状异常（Host 版本不一致、
     * 第三方数据畸形）都会让整块面板白屏，而且没有任何恢复入口——只能切走再切回。
     * 这里降级成「出错了 + 重新加载」，至少用户能自救。
     */
    class WorkbenchBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        try { console.error('[cli-workbench]', error); } catch { /* ignore */ }
      }

      render() {
        if (!this.state.error) return this.props.children;
        const message = String((this.state.error && this.state.error.message) || this.state.error);
        return h('div', { className: 'cw-fatal', role: 'alert' },
          h(Icon, { name: 'alert', size: 20 }),
          h('div', { className: 'cw-fatal-title' }, '工作台出错了'),
          h('div', { className: 'cw-fatal-note' }, message),
          h('button', {
            className: 'cw-btn',
            onClick: () => { try { window.location.reload(); } catch { /* ignore */ } },
          }, '重新加载'),
        );
      }
    }

    const GuardedApp = () => h(WorkbenchBoundary, null, h(App));

    return {
      inject: ['slots'],
      // 预览脚本（.dev/preview.mjs）要单独渲染这些局部组件，顺手挂出来；运行时不使用。
      __parts: { TurnRail, TodoCard, RulesDialog, todosOf, Icon, PreviewPanel, StatsRow, RunningLine, StopGlyph },
      apply(ctx) {
                try { layoutApi = ctx.get ? ctx.get('layout') : null; } catch { layoutApi = null; }
        try { workspaceApi = ctx.get ? ctx.get('uiWorkspace') : null; } catch { workspaceApi = null; }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'cli-workbench',
        }, GuardedApp));
        // 返回 undefined 的注入函数不会被回收，所以图标组件跟着面板一起注册。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'cli-workbench',
          order: 30,
          label: () => 'CLI 工作台',
        }, WorkbenchIcon));
      },
    };
  },
});