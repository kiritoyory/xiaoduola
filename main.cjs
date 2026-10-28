const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, shell, Tray } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

let mainWindow;
let tray;
let selectedFolder = null;
let windowMode = 'compact';
let agentReachChannels;
const configPath = () => path.join(app.getPath('userData'), 'settings.json');

function runAgentReach(args) {
  const executable = path.join(app.getPath('home'), '.local', 'bin', 'agent-reach.exe');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(reject, new Error('Agent Reach 查询超时，请稍后重试。'));
    }, 90000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) {
        child.kill();
        finish(reject, new Error('Agent Reach 返回内容过大，已停止读取。'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', (error) => {
      const message = error.code === 'ENOENT'
        ? '找不到 Agent Reach 命令。请确认已完成安装，并将 %USERPROFILE%\\.local\\bin 加入 PATH 后重启桌宠。'
        : `无法启动 Agent Reach：${error.message}`;
      finish(reject, new Error(message));
    });
    child.on('close', (code) => {
      if (settled) return;
      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch {
        finish(reject, new Error(stderr.trim() || 'Agent Reach 返回了无法识别的结果。'));
        return;
      }
      if (!result.ok) {
        const detail = result.error && (result.error.hint || result.error.message);
        finish(reject, new Error(detail || 'Agent Reach 请求失败。'));
        return;
      }
      if (code !== 0) {
        finish(reject, new Error(stderr.trim() || `Agent Reach 以状态码 ${code} 退出。`));
        return;
      }
      finish(resolve, result);
    });
  });
}

async function getAgentReachChannels() {
  if (!agentReachChannels) {
    const result = await runAgentReach(['channels']);
    if (!Array.isArray(result.channels)) throw new Error('Agent Reach 没有返回可用渠道列表。');
    agentReachChannels = result.channels;
  }
  return agentReachChannels;
}

function validateReachUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('请输入有效的网址，或选择渠道进行搜索。');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('只支持不含账号信息的 HTTP 或 HTTPS 网页链接。');
  }
  return url.href;
}

function setWindowMode(mode) {
  const sizes = {
    compact: { width: 150, height: 174 },
    menu: { width: 326, height: 294 },
    app: { width: 440, height: 690 }
  };
  const size = sizes[mode];
  if (!size || !mainWindow || mainWindow.isDestroyed()) return;
  windowMode = mode;
  const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
  const [currentWidth, currentHeight] = mainWindow.getSize();
  const [currentX, currentY] = mainWindow.getPosition();
  const x = Math.max(workArea.x, Math.min(currentX, workArea.x + workArea.width - size.width));
  const y = Math.max(workArea.y, Math.min(currentY + currentHeight - size.height, workArea.y + workArea.height - size.height));
  mainWindow.setBounds({
    ...size,
    x: currentWidth === size.width ? currentX : x,
    y: currentHeight === size.height ? currentY : y
  });
  mainWindow.setAlwaysOnTop(true);
  mainWindow.webContents.send('window:mode-changed', mode);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  setWindowMode(windowMode);
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  mainWindow = new BrowserWindow({
    width: 150,
    height: 174,
    x: workArea.x + workArea.width - 168,
    y: workArea.y + workArea.height - 192,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', showWindow);
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      setWindowMode('compact');
      mainWindow.hide();
    }
  });
}

function categorize(filename) {
  const ext = path.extname(filename).toLowerCase();
  const groups = {
    图片: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.heic'],
    文档: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.md', '.wps'],
    表格: ['.xls', '.xlsx', '.csv', '.numbers'],
    演示: ['.ppt', '.pptx', '.key'],
    音频: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg'],
    视频: ['.mp4', '.mov', '.mkv', '.avi', '.webm'],
    压缩包: ['.zip', '.rar', '.7z', '.tar', '.gz'],
    程序: ['.exe', '.msi', '.dmg', '.apk', '.deb']
  };
  for (const [group, extensions] of Object.entries(groups)) {
    if (extensions.includes(ext)) return group;
  }
  return '其他';
}

async function getSelectedFiles() {
  if (!selectedFolder) throw new Error('请先选择一个文件夹。');
  const entries = await fs.readdir(selectedFolder, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => ({
    name: entry.name,
    category: categorize(entry.name)
  }));
}

async function loadSettings() {
  try {
    const stored = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    const token = stored.encryptedToken && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(stored.encryptedToken, 'base64'))
      : '';
    return { serverUrl: stored.serverUrl || '', token };
  } catch (error) {
    if (error.code === 'ENOENT') return { serverUrl: '', token: '' };
    throw error;
  }
}

async function saveLocalSettings(settings) {
  if (settings.token && !safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储暂不可用，无法安全保存登录状态。');
  }
  const stored = {
    serverUrl: settings.serverUrl,
    encryptedToken: settings.token ? safeStorage.encryptString(settings.token).toString('base64') : ''
  };
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function validateServerUrl(value) {
  const url = validateHttpUrl(value, '中央服务地址');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error('中央服务必须使用 HTTPS；仅本机测试允许 HTTP。');
  }
  return parsed.href.replace(/\/+$/, '');
}

async function centralRequest(serverUrl, endpoint, { method = 'GET', token = '', body } = {}) {
  const settings = await loadSettings();
  const baseUrl = validateServerUrl(serverUrl || settings.serverUrl);
  const headers = { Accept: 'application/json' };
  if (token || settings.token) headers.Authorization = `Bearer ${token || settings.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(endpoint, `${baseUrl}/`), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
    redirect: 'error'
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`中央服务返回了无法识别的响应（HTTP ${response.status}）。`);
  }
  if (!response.ok) throw new Error(result.error || `中央服务请求失败（HTTP ${response.status}）。`);
  return result;
}

function interactionVoiceDirectory() {
  return path.join(app.getPath('userData'), 'voice');
}

function validateHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}必须是有效的 HTTP 或 HTTPS 地址。`);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label}必须是有效的 HTTP 或 HTTPS 地址。`);
  }
  return url.href;
}

ipcMain.handle('window:hide', () => {
  setWindowMode('compact');
  if (mainWindow) mainWindow.hide();
});
ipcMain.handle('window:set-mode', (_event, mode) => setWindowMode(mode));
ipcMain.handle('window:toggle', () => {
  if (mainWindow && mainWindow.isVisible()) {
    setWindowMode('compact');
    mainWindow.hide();
  }
  else {
    windowMode = 'compact';
    showWindow();
  }
});

ipcMain.handle('agent-reach:channels', async () => {
  const channels = await getAgentReachChannels();
  return channels
    .filter((channel) => channel.actions.some((action) => action.name === 'search'))
    .map((channel) => ({ name: channel.name, level: channel.level }));
});

ipcMain.handle('agent-reach:query', async (_event, input) => {
  const query = String(input && input.query || '').trim();
  if (!query) throw new Error('请输入搜索内容或网页链接。');
  if (query.length > 1200) throw new Error('搜索内容不能超过 1200 个字符。');

  let result;
  if (/^https?:\/\//i.test(query)) {
    result = await runAgentReach(['read', validateReachUrl(query)]);
  } else {
    const channelName = String(input && input.channel || 'web');
    if (!/^[a-z][a-z0-9_-]{0,30}$/.test(channelName)) throw new Error('搜索渠道无效。');
    const channels = await getAgentReachChannels();
    const channel = channels.find((item) => item.name === channelName);
    if (!channel || !channel.actions.some((action) => action.name === 'search')) {
      throw new Error('该渠道当前未安装搜索功能。可在终端运行 agent-reach add <channel> 添加渠道。');
    }
    result = await runAgentReach([channelName, 'search', query, '--limit', '5']);
  }
  return {
    channel: result.channel || (result.action === 'read' ? 'read' : input.channel || 'web'),
    action: result.action || 'search',
    items: Array.isArray(result.items) ? result.items : []
  };
});

ipcMain.handle('agent-reach:open-url', async (_event, value) => {
  await shell.openExternal(validateReachUrl(String(value || '')));
});

ipcMain.handle('organizer:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择要整理的文件夹'
  });
  if (result.canceled || !result.filePaths[0]) return null;
  selectedFolder = result.filePaths[0];
  return selectedFolder;
});

ipcMain.handle('organizer:scan', async () => {
  const files = await getSelectedFiles();
  const counts = files.reduce((result, file) => {
    result[file.category] = (result[file.category] || 0) + 1;
    return result;
  }, {});
  return { files, counts };
});

ipcMain.handle('organizer:run', async () => {
  const files = await getSelectedFiles();
  const moved = [];
  for (const file of files) {
    const destinationFolder = path.join(selectedFolder, file.category);
    await fs.mkdir(destinationFolder, { recursive: true });
    const originalPath = path.join(selectedFolder, file.name);
    const extension = path.extname(file.name);
    const basename = path.basename(file.name, extension);
    let destinationPath = path.join(destinationFolder, file.name);
    let suffix = 1;
    while (true) {
      try {
        await fs.access(destinationPath);
        destinationPath = path.join(destinationFolder, `${basename} (${suffix})${extension}`);
        suffix += 1;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        break;
      }
    }
    await fs.rename(originalPath, destinationPath);
    moved.push(file.name);
  }
  return { moved: moved.length };
});

ipcMain.handle('settings:get', async () => {
  const settings = await loadSettings();
  if (!settings.serverUrl || !settings.token) return { serverUrl: settings.serverUrl, user: null, sharedSettings: null };
  try {
    const result = await centralRequest(settings.serverUrl, '/v1/me');
    let sharedSettings = null;
    if (result.user.is_admin) sharedSettings = await centralRequest(settings.serverUrl, '/v1/admin/settings');
    return { serverUrl: settings.serverUrl, user: result.user, sharedSettings };
  } catch (error) {
    if (/401|登录已过期|请先登录/.test(error.message)) {
      await saveLocalSettings({ serverUrl: settings.serverUrl, token: '' });
      return { serverUrl: settings.serverUrl, user: null, sharedSettings: null };
    }
    throw error;
  }
});

ipcMain.handle('account:login', async (_event, input) => {
  const serverUrl = validateServerUrl(String(input.serverUrl || '').trim());
  const result = await centralRequest(serverUrl, '/v1/auth/login', {
    method: 'POST',
    body: { email: input.email, password: input.password }
  });
  await saveLocalSettings({ serverUrl, token: result.token });
  return result.user;
});

ipcMain.handle('account:register', async (_event, input) => {
  const serverUrl = validateServerUrl(String(input.serverUrl || '').trim());
  const result = await centralRequest(serverUrl, '/v1/auth/register', {
    method: 'POST',
    body: { email: input.email, password: input.password, inviteCode: input.inviteCode }
  });
  await saveLocalSettings({ serverUrl, token: result.token });
  return result.user;
});

ipcMain.handle('account:logout', async () => {
  const settings = await loadSettings();
  if (settings.serverUrl && settings.token) {
    try {
      await centralRequest(settings.serverUrl, '/v1/auth/logout', { method: 'POST' });
    } finally {
      await saveLocalSettings({ serverUrl: settings.serverUrl, token: '' });
    }
  }
});

ipcMain.handle('admin:save-settings', async (_event, input) => centralRequest('', '/v1/admin/settings', {
  method: 'PUT',
  body: {
    apiUrl: String(input.apiUrl || '').trim(),
    model: String(input.model || '').trim()
  }
}));

ipcMain.handle('admin:create-invite', async () => centralRequest('', '/v1/admin/invites', { method: 'POST', body: {} }));

ipcMain.handle('assistant:ask', async (_event, prompt) => {
  const result = await centralRequest('', '/v1/chat', {
    method: 'POST',
    body: { prompt: String(prompt).slice(0, 12000) }
  });
  if (typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('中央服务没有返回可显示的答案。');
  return result.answer.trim();
});

ipcMain.handle('voice:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入小哆啦互动声音',
    properties: ['openFile'],
    filters: [{ name: 'WAV 或 MP3 音频', extensions: ['wav', 'mp3'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  const source = result.filePaths[0];
  const stat = await fs.stat(source);
  if (stat.size > 20 * 1024 * 1024) throw new Error('声音文件不能超过 20 MB。');
  const extension = path.extname(source).toLowerCase();
  if (!['.wav', '.mp3'].includes(extension)) throw new Error('只支持 WAV 或 MP3 格式。');
  const directory = interactionVoiceDirectory();
  await fs.mkdir(directory, { recursive: true });
  for (const oldExtension of ['.wav', '.mp3']) {
    try { await fs.unlink(path.join(directory, `interaction${oldExtension}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.copyFile(source, path.join(directory, `interaction${extension}`));
  await fs.writeFile(path.join(directory, 'voice.json'), JSON.stringify({ name: path.basename(source), extension }), 'utf8');
  return { name: path.basename(source) };
});

ipcMain.handle('voice:get', async () => {
  const directory = interactionVoiceDirectory();
  for (const [extension, mime] of [['.wav', 'audio/wav'], ['.mp3', 'audio/mpeg']]) {
    try {
      const content = await fs.readFile(path.join(directory, `interaction${extension}`));
      let name = `interaction${extension}`;
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(directory, 'voice.json'), 'utf8'));
        if (metadata.extension === extension && typeof metadata.name === 'string') name = metadata.name;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      return { dataUrl: `data:${mime};base64,${content.toString('base64')}`, name };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
});

ipcMain.handle('voice:remove', async () => {
  const directory = interactionVoiceDirectory();
  for (const file of ['interaction.wav', 'interaction.mp3', 'voice.json']) {
    try { await fs.unlink(path.join(directory, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
});

ipcMain.handle('legacy:assistant:ask', async (_event, prompt) => {
  const settings = await loadSettings();
  if (!settings.apiUrl || !settings.model || !settings.apiKey) {
    throw new Error('请先在「设置」中配置兼容 OpenAI Chat Completions 的 AI 接口、模型和密钥。');
  }
  const url = validateHttpUrl(settings.apiUrl, 'AI 接口地址');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: '你是亲切、严谨的中文学习助手。解题时展示关键步骤，并在不确定时明确说明。' },
        { role: 'user', content: String(prompt).slice(0, 12000) }
      ],
      temperature: 0.4
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`AI 服务返回 HTTP ${response.status}：${(await response.text()).slice(0, 400)}`);
  const result = await response.json();
  const answer = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('AI 服务没有返回可显示的答案。');
  return answer.trim();
});

ipcMain.handle('notification:show', (_event, payload) => {
  if (!Notification.isSupported()) throw new Error('当前系统不支持桌面通知。');
  const title = String(payload.title || '学习提醒').slice(0, 80);
  const body = String(payload.body || '').slice(0, 240);
  new Notification({ title, body }).show();
});

ipcMain.handle('feedback:email', async (_event, feedback) => {
  const subject = encodeURIComponent('小哆啦学习助手反馈');
  const body = encodeURIComponent(String(feedback || '').slice(0, 3000));
  await shell.openExternal(`mailto:?subject=${subject}&body=${body}`);
});

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    createWindow();
    const traySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="10" fill="#39a9d8"/><text x="16" y="22" text-anchor="middle" font-size="18" font-family="sans-serif" font-weight="700" fill="#fff">哆</text></svg>';
    tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(traySvg)}`));
    tray.setToolTip('学习小助手');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏桌宠', click: () => {
        if (mainWindow && mainWindow.isVisible()) {
          setWindowMode('compact');
          mainWindow.hide();
        }
        else showWindow();
      } },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
    ]));
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible()) {
        setWindowMode('compact');
        mainWindow.hide();
      }
      else {
        windowMode = 'compact';
        showWindow();
      }
    });
  });
} else app.quit();

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => {});

let petDragOrigin = null;
ipcMain.on('pet:drag-start', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || windowMode !== 'compact') return;
  petDragOrigin = { cursor: screen.getCursorScreenPoint(), bounds: mainWindow.getBounds() };
});
ipcMain.on('pet:drag-move', (event) => {
  if (!petDragOrigin || !mainWindow || event.sender !== mainWindow.webContents) return;
  const cursor = screen.getCursorScreenPoint();
  mainWindow.setPosition(
    petDragOrigin.bounds.x + cursor.x - petDragOrigin.cursor.x,
    petDragOrigin.bounds.y + cursor.y - petDragOrigin.cursor.y
  );
});
ipcMain.on('pet:drag-end', (event) => {
  if (mainWindow && event.sender === mainWindow.webContents) petDragOrigin = null;
});
