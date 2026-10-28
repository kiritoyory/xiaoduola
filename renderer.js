const STORAGE_KEYS = {
  tasks: 'lanlan.tasks.v1',
  courses: 'lanlan.courses.v1',
  notes: 'lanlan.notes.v1',
  fired: 'lanlan.fired.v1'
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
if (window.companion) {
  window.companion.onWindowModeChanged((mode) => {
    if (['compact', 'menu', 'app'].includes(mode)) document.body.dataset.mode = mode;
  });
}
let selectedFolder = null;
let toastTimer;
let bubbleTimer;
let speechEnabled = localStorage.getItem('lanlan.speech.enabled.v1') === 'true';
let speechVoices = [];
let speechQueueToken = 0;
let gameTimer;
let gameScore = 0;
let gameSeconds = 20;
let lastQuestion = '';
let lastAnswer = '';
let interactionAudio = null;
let activeInteractionAudio = null;
let petActionIndex = 0;

function readList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(value)) throw new Error('Stored data is not a list');
    return value;
  } catch (error) {
    console.error(`Unable to read ${key} from local storage`, error);
    toast('本地数据读取失败，请检查应用存储。');
    return [];
  }
}

function saveList(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Unable to save ${key} to local storage`, error);
    toast('保存失败，可能是本机存储空间不足。');
  }
}

let tasks = readList(STORAGE_KEYS.tasks);
let courses = readList(STORAGE_KEYS.courses);
let notes = readList(STORAGE_KEYS.notes);
let fired = new Set(readList(STORAGE_KEYS.fired));

function toast(message) {
  const element = $('#toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2800);
}

function speak(text, force = false) {
  if ((!speechEnabled && !force) || !('speechSynthesis' in window)) return false;
  const selectedVoice = speechVoices.find((voice) => voice.name === $('#speech-voice').value);
  const token = ++speechQueueToken;
  window.speechSynthesis.cancel();
  const chunks = splitSpeechText(text);
  const speakNext = () => {
    if (token !== speechQueueToken || !chunks.length) return;
    const utterance = new SpeechSynthesisUtterance(chunks.shift());
    utterance.lang = 'zh-CN';
    utterance.rate = 1.04;
    utterance.pitch = 1.2;
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.onend = () => setTimeout(speakNext, 260);
    utterance.onerror = (event) => {
      if (event.error === 'canceled' || event.error === 'interrupted') return;
      console.error('Speech synthesis failed', event.error);
      ++speechQueueToken;
      toast('语音播放失败，请检查 Windows 音量和已安装的中文语音。');
    };
    window.speechSynthesis.speak(utterance);
  };
  speakNext();
  return true;
}

function splitSpeechText(text, maxLength = 180) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const punctuation = [...candidate.matchAll(/[。！？；.!?;\n]/g)].at(-1);
    const splitAt = punctuation && punctuation.index >= maxLength / 2 ? punctuation.index + 1 : maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function loadSpeechVoices() {
  if (!('speechSynthesis' in window)) {
    $('#speech-voice').replaceChildren(new Option('此设备不支持语音合成', ''));
    $('#speech-voice').disabled = true;
    $('#speech-toggle').disabled = true;
    $('#speech-test').disabled = true;
    return;
  }
  speechVoices = window.speechSynthesis.getVoices();
  const chineseVoices = speechVoices.filter((voice) => voice.lang.toLowerCase().startsWith('zh'));
  const select = $('#speech-voice');
  const savedVoice = localStorage.getItem('lanlan.speech.voice.v1') || '';
  const options = chineseVoices.map((voice) => new Option(`${voice.name} · ${voice.lang}`, voice.name));
  if (!options.length) options.push(new Option('系统默认语音（未检测到中文语音）', ''));
  select.replaceChildren(...options);
  if (chineseVoices.some((voice) => voice.name === savedVoice)) select.value = savedVoice;
  else {
    const livelyFemale = chineseVoices.find((voice) => /yaoyao|yao.?yao/i.test(voice.name));
    if (livelyFemale) select.value = livelyFemale.name;
  }
  select.disabled = !chineseVoices.length;
}

function setBubble(text, shouldSpeak = false) {
  $('#speech-bubble').textContent = text;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    $('#speech-bubble').textContent = '点点我，看看今天能帮你做什么！';
  }, 6200);
  if (shouldSpeak) speak(text);
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间无效';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function notify(title, body, key) {
  if (key && fired.has(key)) return;
  if (key) {
    fired.add(key);
    saveList(STORAGE_KEYS.fired, [...fired].slice(-500));
  }
  window.companion.notify({ title, body }).catch((error) => {
    console.error('Desktop notification failed', error);
    toast(error.message || '桌面通知发送失败。');
  });
  setBubble(body, true);
}

function updateClock() {
  const now = new Date();
  $('#clock').textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  $('#date-label').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now);
  const hour = now.getHours();
  $('#greeting').textContent = hour < 6 ? '夜深啦，早点休息！' : hour < 11 ? '早上好，我是小哆啦！' : hour < 14 ? '中午好，一起充充电！' : hour < 19 ? '下午好，继续加油！' : '晚上好，今天辛苦啦！';
}

function updateSummary() {
  $('#task-count').textContent = tasks.filter((task) => !task.done).length;
  $('#course-count').textContent = courses.length;
  $('#note-count').textContent = notes.length;
}

function renderTasks() {
  const list = $('#task-list');
  const ordered = [...tasks].sort((a, b) => Number(a.due) - Number(b.due));
  $('#task-list-count').textContent = ordered.filter((task) => !task.done).length;
  if (!ordered.length) {
    list.innerHTML = '<p class="empty-state">还没有计划，添加一件小事开始吧。</p>';
  } else {
    list.replaceChildren(...ordered.map((task) => {
      const article = document.createElement('article');
      article.className = `task-item${task.done ? ' completed' : ''}`;
      const check = document.createElement('button');
      check.className = `task-check${task.done ? ' done' : ''}`;
      check.textContent = task.done ? '✓' : '';
      check.setAttribute('aria-label', task.done ? '标记为未完成' : '标记为完成');
      check.addEventListener('click', () => {
        tasks = tasks.map((item) => item.id === task.id ? { ...item, done: !item.done } : item);
        saveList(STORAGE_KEYS.tasks, tasks);
        renderTasks();
        updateSummary();
      });
      const copy = document.createElement('div');
      copy.className = 'task-copy';
      const title = document.createElement('b');
      title.textContent = task.title;
      const due = document.createElement('small');
      due.textContent = formatDateTime(task.due);
      copy.append(title, due);
      const remove = document.createElement('button');
      remove.className = 'item-delete';
      remove.textContent = '×';
      remove.setAttribute('aria-label', '删除提醒');
      remove.addEventListener('click', () => {
        tasks = tasks.filter((item) => item.id !== task.id);
        saveList(STORAGE_KEYS.tasks, tasks);
        renderTasks();
        updateSummary();
      });
      article.append(check, copy, remove);
      return article;
    }));
  }
  updateSummary();
}

function renderCourses() {
  const list = $('#course-list');
  if (!courses.length) {
    list.innerHTML = '<p class="empty-state">导入课表后，可提前 10 分钟收到提醒。</p>';
  } else {
    const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    list.replaceChildren(...courses.map((course) => {
      const row = document.createElement('div');
      row.className = 'course-item';
      const info = document.createElement('span');
      info.textContent = `${dayNames[course.day] || '周' + course.day} ${course.time} · ${course.title}`;
      const location = document.createElement('small');
      location.textContent = course.location || '';
      const remove = document.createElement('button');
      remove.className = 'item-delete';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `删除课程 ${course.title}`);
      remove.addEventListener('click', () => {
        courses = courses.filter((item) => item.id !== course.id);
        saveList(STORAGE_KEYS.courses, courses);
        renderCourses();
      });
      row.append(info, location, remove);
      return row;
    }));
  }
  updateSummary();
}

function renderNotes() {
  const list = $('#note-list');
  $('#note-list-count').textContent = notes.length;
  if (!notes.length) {
    list.innerHTML = '<p class="empty-state">还没有备忘，随时可以记下来。</p>';
  } else {
    list.replaceChildren(...[...notes].reverse().map((note) => {
      const article = document.createElement('article');
      article.className = 'note-item';
      const copy = document.createElement('div');
      copy.className = 'note-copy';
      const title = document.createElement('b');
      title.textContent = note.title;
      const date = document.createElement('small');
      date.textContent = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(note.createdAt));
      const content = document.createElement('p');
      content.className = 'note-content';
      content.textContent = note.content || '（没有补充内容）';
      copy.append(title, date, content);
      const remove = document.createElement('button');
      remove.className = 'item-delete';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `删除备忘 ${note.title}`);
      remove.addEventListener('click', () => {
        notes = notes.filter((item) => item.id !== note.id);
        saveList(STORAGE_KEYS.notes, notes);
        renderNotes();
        updateSummary();
      });
      article.append(copy, remove);
      return article;
    }));
  }
  updateSummary();
}

function showPage(name) {
  $$('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.page === name));
  $('#home-button').hidden = name === 'home';
}

async function setDisplayMode(mode) {
  document.body.dataset.mode = mode;
  if (!window.companion) return;
  try {
    await window.companion.setWindowMode(mode);
  } catch (error) {
    console.error('Unable to resize desktop pet window', error);
    toast(error.message || '桌宠窗口切换失败。');
  }
}

async function openFeature(name) {
  showPage(name);
  await setDisplayMode('app');
  if (name === 'home') {
    setTimeout(() => $('#chat-input').focus(), 150);
  } else if (name === 'study') {
    setTimeout(() => $('#question-input').focus(), 150);
  } else if (name === 'notes') {
    setTimeout(() => $('#note-title').focus(), 150);
  } else if (name === 'reach') {
    loadReachChannels();
    setTimeout(() => $('#reach-query').focus(), 150);
  }
}

function makeId() {
  return globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error('CSV 至少需要一行表头和一行课程数据。');
  const headers = rows[0].map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, '') : header).toLowerCase());
  const findColumn = (...names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0);
  const titleIndex = findColumn('课程名', '课程', 'title', 'name');
  const dayIndex = findColumn('星期', 'day', 'weekday');
  const timeIndex = findColumn('时间', 'time');
  const locationIndex = findColumn('地点', 'location', 'place');
  if ([titleIndex, dayIndex, timeIndex].some((index) => index === undefined)) {
    throw new Error('CSV 表头需要包含：课程名、星期、时间；地点为可选。');
  }
  return rows.slice(1).map((cells) => ({
    title: cells[titleIndex],
    day: cells[dayIndex],
    time: cells[timeIndex],
    location: locationIndex === undefined ? '' : cells[locationIndex]
  }));
}

function normalizeCourse(course) {
  const dayNames = { '周一': 1, '星期一': 1, '周二': 2, '星期二': 2, '周三': 3, '星期三': 3, '周四': 4, '星期四': 4, '周五': 5, '星期五': 5, '周六': 6, '星期六': 6, '周日': 7, '星期日': 7, '星期天': 7 };
  const title = String(course.title || course.name || course['课程名'] || '').trim();
  const dayText = String(course.day ?? course.weekday ?? course['星期'] ?? '').trim();
  const day = Number(dayText) || dayNames[dayText];
  const time = String(course.time || course['时间'] || '').trim();
  const location = String(course.location || course.place || course['地点'] || '').trim();
  if (!title || !Number.isInteger(day) || day < 1 || day > 7 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`课程信息无效：「${title || '未命名课程'}」。星期须为 1-7，时间格式为 HH:mm。`);
  }
  return { id: makeId(), title, day, time, location };
}

function nextCourseDate(course, now = new Date()) {
  const today = now.getDay() || 7;
  let daysUntil = (course.day - today + 7) % 7;
  const [hours, minutes] = course.time.split(':').map(Number);
  const date = new Date(now);
  date.setDate(now.getDate() + daysUntil);
  date.setHours(hours, minutes, 0, 0);
  if (date <= now) {
    daysUntil = daysUntil === 0 ? 7 : daysUntil;
    date.setDate(now.getDate() + daysUntil);
  }
  return date;
}

function checkReminders() {
  const now = new Date();
  tasks.forEach((task) => {
    if (task.done || !task.due) return;
    const due = new Date(task.due);
    if (!Number.isNaN(due.getTime()) && now >= due) notify('待办提醒', task.title, `task:${task.id}`);
  });
  courses.forEach((course) => {
    const [hours, minutes] = course.time.split(':').map(Number);
    const today = now.getDay() || 7;
    if (today !== course.day) return;
    const start = new Date(now);
    start.setHours(hours, minutes, 0, 0);
    const reminder = new Date(start.getTime() - 10 * 60 * 1000);
    if (now >= reminder && now < start) {
      notify('课程即将开始', `${course.title}${course.location ? ` · ${course.location}` : ''}，10 分钟后开始。`, `course:${course.id}:${localDateKey(now)}`);
    }
  });
}

async function askAssistant(prompt, outputElement) {
  if (!prompt.trim()) {
    toast('先写下你想问的问题吧。');
    return '';
  }
  outputElement.hidden = false;
  outputElement.textContent = '小哆啦正在认真思考…';
  try {
    const answer = await window.companion.ask(prompt);
    outputElement.textContent = answer;
    lastQuestion = prompt;
    lastAnswer = answer;
    setBubble('解答已经准备好啦！');
    return answer;
  } catch (error) {
    console.error('Assistant request failed', error);
    outputElement.textContent = error.message || '请求 AI 服务失败，请检查设置或网络。';
    toast(error.message || 'AI 服务暂时不可用。');
    return '';
  }
}

function appendChat(text, isUser) {
  const line = document.createElement('p');
  line.className = `chat-line ${isUser ? 'user-line' : 'bot-line'}`;
  line.textContent = text;
  $('#chat-log').append(line);
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
}

function nextCoursesText() {
  if (!courses.length) return '你还没有导入课表，可以在「学习」页导入 CSV 或 JSON 课表。';
  const now = new Date();
  const upcoming = courses.map((course) => ({ course, date: nextCourseDate(course, now) })).sort((a, b) => a.date - b.date).slice(0, 4);
  return `接下来几节课：\n${upcoming.map(({ course, date }) => `${formatDateTime(date)} ${course.title}${course.location ? `（${course.location}）` : ''}`).join('\n')}`;
}

async function handleChat(message) {
  const text = message.trim();
  if (!text) return;
  appendChat(text, true);
  const lower = text.toLowerCase();
  if (text.includes('课表') || text.includes('上课')) {
    const reply = nextCoursesText();
    appendChat(reply, false);
    setBubble('我把接下来的课程找出来啦。', true);
  } else if (text.includes('待办') || text.includes('提醒') || text.includes('计划')) {
    const active = tasks.filter((task) => !task.done).sort((a, b) => Number(a.due) - Number(b.due)).slice(0, 5);
    const reply = active.length ? `你的待办有：\n${active.map((task) => `${formatDateTime(task.due)} ${task.title}`).join('\n')}` : '目前没有待办事项，要不要去「学习」页安排一个？';
    appendChat(reply, false);
    setBubble(reply);
  } else if (text.includes('收纳') || text.includes('整理文件')) {
    showPage('files');
    appendChat('我打开文件收纳啦。选择一个文件夹后可以预览分类，再确认整理。', false);
  } else if (/^(读取|读一下|读取网页)\s+https?:\/\//i.test(text) || /^https?:\/\//i.test(text)) {
    const url = text.replace(/^(读取|读一下|读取网页)\s+/i, '').trim();
    try {
      const result = await window.companion.queryReach({ query: url, channel: 'web' });
      appendChat(formatReachSummary(result), false);
      setBubble('网页内容已经读好啦。');
    } catch (error) {
      console.error('Agent Reach read failed', error);
      appendChat(error.message || '网页读取失败。', false);
      toast(error.message || '网页读取失败。');
    }
  } else if (/^(联网搜索|网上搜索|帮我搜|搜索|搜一下)\s*/i.test(text)) {
    const query = text.replace(/^(联网搜索|网上搜索|帮我搜|搜索|搜一下)\s*/i, '').trim();
    if (!query) {
      appendChat('告诉我关键词，或者直接发送一个网页链接，我就能帮你查找。', false);
      return;
    }
    try {
      const result = await window.companion.queryReach({ query, channel: 'web' });
      appendChat(formatReachSummary(result), false);
      setBubble('我找到一些相关内容啦。');
    } catch (error) {
      console.error('Agent Reach search failed', error);
      appendChat(error.message || '联网搜索失败。', false);
      toast(error.message || '联网搜索失败。');
    }
  } else if (/^(你好|嗨|早上好|晚上好|在吗|hello|hi)/i.test(lower)) {
    const reply = '我在呀！可以让我帮你看课表、记待办，或者在「学习」页问一道题。';
    appendChat(reply, false);
    setBubble('我在这里陪你学习～', true);
  } else {
    const answer = await window.companion.ask(text).catch((error) => {
      console.error('Chat request failed', error);
      return `我还不能回答这个问题：${error.message || 'AI 服务暂不可用。请先配置 AI 接口。'}`;
    });
    appendChat(answer, false);
    setBubble(answer.slice(0, 72));
  }
}

const reachChannelLabels = {
  web: '网页',
  github: 'GitHub',
  youtube: 'YouTube',
  bilibili: '哔哩哔哩',
  xiaohongshu: '小红书',
  xueqiu: '雪球',
  boss: 'BOSS直聘',
  reddit: 'Reddit',
  twitter: 'X / Twitter',
  facebook: 'Facebook',
  instagram: 'Instagram'
};

function formatReachSummary(result) {
  const items = result.items || [];
  if (!items.length) return '没有找到可显示的内容。';
  return items.slice(0, 5).map((item, index) => {
    const title = item.title || '未命名内容';
    const text = item.text || '';
    const url = item.url ? `\n${item.url}` : '';
    return `${index + 1}. ${title}${text ? `\n${text.slice(0, 360)}` : ''}${url}`;
  }).join('\n\n');
}

async function loadReachChannels() {
  const select = $('#reach-channel');
  if (!select) return;
  if (!window.companion || typeof window.companion.getReachChannels !== 'function') {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '请在桌宠应用中使用';
    select.replaceChildren(option);
    $('#reach-hint').textContent = '联网查询需要在已安装 Agent Reach 的桌宠应用中运行。';
    return;
  }
  const selected = select.value;
  try {
    const channels = await window.companion.getReachChannels();
    select.replaceChildren(...channels.map((channel) => {
      const option = document.createElement('option');
      option.value = channel.name;
      option.textContent = `${reachChannelLabels[channel.name] || channel.name}${channel.level === 'optional' ? ' · 可选' : ''}`;
      return option;
    }));
    if (!channels.length) {
      const option = document.createElement('option');
      option.textContent = '暂无已安装的搜索渠道';
      option.value = '';
      select.append(option);
    } else if (channels.some((channel) => channel.name === selected)) {
      select.value = selected;
    } else if (channels.some((channel) => channel.name === 'web')) {
      select.value = 'web';
    }
  } catch (error) {
    console.error('Unable to load Agent Reach channels', error);
    const option = document.createElement('option');
    option.textContent = '读取渠道失败';
    option.value = '';
    select.replaceChildren(option);
    toast(error.message || '无法读取 Agent Reach 渠道。');
  }
}

function renderReachResults(items) {
  const results = $('#reach-results');
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '没有找到可显示的结果。';
    results.replaceChildren(empty);
    return;
  }
  results.replaceChildren(...items.slice(0, 10).map((item) => {
    const article = document.createElement('article');
    article.className = 'reach-result';
    const title = document.createElement('h3');
    title.textContent = item.title || '未命名内容';
    article.append(title);
    if (item.text) {
      const summary = document.createElement('p');
      summary.textContent = item.text.slice(0, 1800);
      article.append(summary);
    }
    const meta = document.createElement('div');
    meta.className = 'reach-result-meta';
    const source = document.createElement('span');
    source.className = 'reach-result-url';
    source.textContent = [item.author, item.published_at, item.url].filter(Boolean).join(' · ');
    meta.append(source);
    if (item.url && /^https?:\/\//i.test(item.url)) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = '打开来源';
      open.addEventListener('click', async () => {
        try {
          await window.companion.openReachUrl(item.url);
        } catch (error) {
          console.error('Unable to open Agent Reach result URL', error);
          toast(error.message || '无法打开来源链接。');
        }
      });
      meta.append(open);
    }
    article.append(meta);
    return article;
  }));
}

async function submitReachQuery(query, channel) {
  const results = $('#reach-results');
  const submit = $('#reach-form button[type="submit"]');
  submit.disabled = true;
  const loading = document.createElement('p');
  loading.className = 'empty-state';
  loading.textContent = '正在查找，请稍候…';
  results.replaceChildren(loading);
  try {
    const result = await window.companion.queryReach({ query, channel });
    renderReachResults(result.items);
    $('#reach-hint').textContent = `完成：${reachChannelLabels[result.channel] || result.channel} · ${result.action === 'read' ? '网页读取' : '搜索'}`;
    if (!result.items.length) toast('查询完成，但没有找到可显示的内容。');
  } catch (error) {
    console.error('Agent Reach query failed', error);
    const message = error.message || 'Agent Reach 查询失败。';
    const failure = document.createElement('p');
    failure.className = 'empty-state';
    failure.textContent = message;
    results.replaceChildren(failure);
    $('#reach-hint').textContent = '查询失败；可检查渠道状态或稍后重试。';
    toast(message);
  } finally {
    submit.disabled = false;
  }
}

function openModal(id) {
  $(`#${id}`).hidden = false;
}
function closeModal(id) {
  $(`#${id}`).hidden = true;
}

async function loadSettings() {
  try {
    const settings = await window.companion.getSettings();
    $('#setting-server-url').value = settings.serverUrl || '';
    $('#account-email').value = settings.user ? settings.user.email : $('#account-email').value;
    $('#account-password').value = '';
    $('#account-password').required = !settings.user;
    $('#account-login').hidden = Boolean(settings.user);
    $('#account-register').hidden = Boolean(settings.user);
    $('#account-logout').hidden = !settings.user;
    $('#account-status').textContent = settings.user
      ? `已登录：${settings.user.email}${settings.user.is_admin ? '（中央服务器管理员）' : ''}`
      : '未登录。普通账号需要管理员提供的一次性邀请码。';
    $('#admin-settings').hidden = !settings.user || !settings.user.is_admin;
    $('#invite-code-label').hidden = true;
    if (settings.sharedSettings) {
      $('#setting-api-url').value = settings.sharedSettings.apiUrl;
      $('#setting-model').value = settings.sharedSettings.model;
    }
  } catch (error) {
    console.error('Unable to load settings', error);
    toast(error.message || '读取设置失败。');
  }
}

async function loadInteractionVoice() {
  try {
    interactionAudio = await window.companion.getInteractionVoice();
    $('#interaction-audio-status').textContent = interactionAudio ? interactionAudio.name : '尚未导入声音';
    $('#remove-interaction-audio').hidden = !interactionAudio;
  } catch (error) {
    console.error('Unable to load interaction voice', error);
    toast(error.message || '读取互动语音失败。');
  }
}

async function handleAccountAction(action) {
  const input = {
    serverUrl: $('#setting-server-url').value.trim(),
    email: $('#account-email').value.trim(),
    password: $('#account-password').value
  };
  if (!input.serverUrl || !input.email || !input.password) {
    toast('请填写中央服务地址、邮箱和密码。');
    return;
  }
  if (action === 'register') {
    input.inviteCode = $('#account-invite').value.trim();
    if (!input.inviteCode) {
      toast('请先输入管理员提供的邀请码。');
      return;
    }
  }
  $('#account-login').disabled = true;
  $('#account-register').disabled = true;
  try {
    if (action === 'register') await window.companion.register(input);
    else await window.companion.login(input);
    $('#account-password').value = '';
    $('#account-invite').value = '';
    await loadSettings();
    toast(action === 'register' ? '账号注册成功并已登录。' : '登录成功。');
  } catch (error) {
    console.error('Central account action failed', error);
    toast(error.message || '账号操作失败。');
  } finally {
    $('#account-login').disabled = false;
    $('#account-register').disabled = false;
  }
}

function runGame() {
  clearInterval(gameTimer);
  gameScore = 0;
  gameSeconds = 20;
  $('#game-score').textContent = '0 分';
  $('#game-time').textContent = '20';
  const arena = $('#game-arena');
  arena.replaceChildren();
  gameTimer = setInterval(() => {
    gameSeconds -= 1;
    $('#game-time').textContent = String(gameSeconds);
    if (gameSeconds <= 0) {
      clearInterval(gameTimer);
      arena.replaceChildren();
      const result = document.createElement('div');
      result.className = 'game-start';
      result.textContent = `时间到！你接住了 ${gameScore} 颗星星 ✨`;
      arena.append(result);
      setBubble(`你接住了 ${gameScore} 颗星星，真棒！`, true);
    } else if (!arena.querySelector('.bubble')) {
      spawnBubble();
    }
  }, 1000);
  spawnBubble();
}

function spawnBubble() {
  const arena = $('#game-arena');
  if (gameSeconds <= 0) return;
  const bubble = document.createElement('button');
  bubble.className = 'bubble';
  bubble.textContent = '✦';
  bubble.setAttribute('aria-label', '接住星星泡泡');
  bubble.style.left = `${Math.max(3, Math.random() * 85)}%`;
  bubble.style.top = `${Math.max(3, Math.random() * 78)}%`;
  bubble.addEventListener('click', () => {
    gameScore += 1;
    $('#game-score').textContent = `${gameScore} 分`;
    bubble.remove();
    if (gameSeconds > 0) setTimeout(spawnBubble, 180);
  }, { once: true });
  arena.append(bubble);
}

$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  showPage(tab.dataset.page);
  if (tab.dataset.page === 'reach') loadReachChannels();
}));
$('#home-button').addEventListener('click', () => openFeature('home'));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => openFeature(button.dataset.go)));
$$('[data-launch]').forEach((button) => button.addEventListener('click', () => openFeature(button.dataset.launch)));
$('#settings-open').addEventListener('click', () => {
  setDisplayMode('app');
  loadSettings();
  loadInteractionVoice();
  openModal('settings-modal');
});
$('#launcher-settings').addEventListener('click', () => {
  setDisplayMode('app');
  loadSettings();
  loadInteractionVoice();
  openModal('settings-modal');
});
$('#collapse-window').addEventListener('click', () => setDisplayMode('compact'));
$('#menu-collapse').addEventListener('click', () => setDisplayMode('compact'));
$$('[data-close]').forEach((button) => button.addEventListener('click', () => {
  closeModal(button.dataset.close);
  if (button.dataset.close === 'settings-modal') setDisplayMode('compact');
}));
$$('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => {
  if (event.target === backdrop) {
    closeModal(backdrop.id);
    if (backdrop.id === 'settings-modal') setDisplayMode('compact');
  }
}));
const contextMenu = $('#pet-context-menu');
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  contextMenu.hidden = false;
  contextMenu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - 138))}px`;
  contextMenu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - contextMenu.offsetHeight - 4))}px`;
});
document.addEventListener('click', (event) => {
  if (!contextMenu.contains(event.target)) contextMenu.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    contextMenu.hidden = true;
    if (!$('#settings-modal').hidden) { closeModal('settings-modal'); setDisplayMode('compact'); }
  }
});
$('#context-hide').addEventListener('click', () => {
  contextMenu.hidden = true;
  window.companion.hideWindow();
});
$('#account-login').addEventListener('click', () => handleAccountAction('login'));
$('#account-register').addEventListener('click', () => {
  $('#invite-code-label').hidden = false;
  handleAccountAction('register');
});
$('#account-logout').addEventListener('click', async () => {
  try {
    await window.companion.logout();
    await loadSettings();
    toast('已退出中央服务账号。');
  } catch (error) {
    console.error('Central logout failed', error);
    toast(error.message || '退出登录失败。');
  }
});
function reactToPetClick() {
  const phrase = localStorage.getItem('xiaoduola.interaction.phrase.v1') || '嗨！今天也一起加油吧！';
  setBubble(phrase, false);
  if (activeInteractionAudio) activeInteractionAudio.pause();
  window.speechSynthesis?.cancel();
  if (interactionAudio) {
    activeInteractionAudio = new Audio(interactionAudio.dataUrl);
    activeInteractionAudio.play().catch(() => toast('声音无法播放，请重新导入音频。'));
  } else {
    if (!speak(phrase, true)) toast('当前没有可用语音，请右键导入 WAV 或 MP3。');
  }
  const mascot = $('#mascot');
  const actions = [
    { name: 'original', source: '' },
    { name: 'jump', source: 'assets/pet-actions/rain-transparent.png' },
    { name: 'float', source: 'assets/pet-actions/meditate-transparent.png' },
    { name: 'reading', source: 'assets/pet-actions/reading-transparent.png' },
    { name: 'noodles', source: 'assets/pet-actions/noodles-transparent.png' },
    { name: 'onsen', source: 'assets/pet-actions/onsen-transparent.png' },
    { name: 'picnic', source: 'assets/pet-actions/picnic-transparent.png' },
    { name: 'hat', source: 'assets/pet-actions/hat-transparent.png' },
    { name: 'flowers', source: 'assets/pet-actions/flowers-transparent.png' }
  ];
  const action = actions[petActionIndex = (petActionIndex + 1) % actions.length];
  mascot.dataset.action = action.name;
  if (action.source) $('#pet-action-image').src = action.source;
  mascot.classList.remove('pet-reacting');
  void mascot.offsetWidth;
  mascot.classList.add('pet-reacting');
}

let petPointer = null;
$('#mascot').addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || document.body.dataset.mode !== 'compact') return;
  petPointer = { id: event.pointerId, x: event.screenX, y: event.screenY, dragged: false };
  event.currentTarget.setPointerCapture(event.pointerId);
  window.companion.beginPetDrag();
});
$('#mascot').addEventListener('pointermove', (event) => {
  if (!petPointer || petPointer.id !== event.pointerId) return;
  if (Math.hypot(event.screenX - petPointer.x, event.screenY - petPointer.y) > 5) petPointer.dragged = true;
  if (petPointer.dragged) window.companion.movePetDrag();
});
function finishPetPointer(event) {
  if (!petPointer || petPointer.id !== event.pointerId) return;
  const clicked = !petPointer.dragged && event.type === 'pointerup';
  petPointer = null;
  window.companion.endPetDrag();
  if (clicked) reactToPetClick();
}
$('#mascot').addEventListener('pointerup', finishPetPointer);
$('#mascot').addEventListener('pointercancel', finishPetPointer);
$('#mascot').addEventListener('lostpointercapture', finishPetPointer);
$('#mascot').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    reactToPetClick();
  }
});
$('#context-audio').addEventListener('click', async () => {
  contextMenu.hidden = true;
  await setDisplayMode('app');
  await loadInteractionVoice();
  openModal('settings-modal');
});
$('#context-functions').addEventListener('click', () => {
  contextMenu.hidden = true;
  setDisplayMode('menu');
});
$('#context-remove-audio').addEventListener('click', () => {
  contextMenu.hidden = true;
  $('#remove-interaction-audio').click();
});
$('#pet-menu-button').addEventListener('click', () => {
  setDisplayMode('menu');
  setBubble('点一下功能，小哆啦马上帮你！');
});


$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#chat-input');
  const message = input.value;
  input.value = '';
  await handleChat(message);
});
$('#reach-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('#reach-query').value.trim();
  if (!query) return toast('请输入搜索内容或网页链接。');
  await submitReachQuery(query, $('#reach-channel').value);
});
$('#task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('#task-title').value.trim();
  const due = new Date($('#task-due').value);
  if (!title || Number.isNaN(due.getTime())) return toast('请填写有效的提醒名称和时间。');
  if (due <= new Date()) return toast('提醒时间需要设置在未来。');
  tasks.push({ id: makeId(), title, due: due.toISOString(), done: false });
  saveList(STORAGE_KEYS.tasks, tasks);
  event.target.reset();
  renderTasks();
  toast('计划已添加，到点我会提醒你。');
  setBubble('新计划收好啦，我会记得提醒你。');
});
$('#note-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('#note-title').value.trim();
  if (!title) return toast('先给这条备忘起个标题吧。');
  notes.push({ id: makeId(), title, content: $('#note-content').value.trim(), createdAt: new Date().toISOString() });
  saveList(STORAGE_KEYS.notes, notes);
  event.target.reset();
  renderNotes();
  toast('已经收进小本本。');
});
$('#choose-folder').addEventListener('click', async () => {
  try {
    selectedFolder = await window.companion.chooseFolder();
    if (!selectedFolder) return;
    $('#folder-path').textContent = selectedFolder;
    const result = await window.companion.scanFolder();
    const preview = $('#organize-preview');
    const categories = Object.entries(result.counts);
    if (!categories.length) {
      preview.innerHTML = '<p class="empty-state">这个文件夹里没有可整理的文件。</p>';
      $('#organize-button').disabled = true;
      return;
    }
    preview.replaceChildren(...categories.map(([category, count]) => {
      const line = document.createElement('div');
      line.className = 'preview-line';
      const name = document.createElement('span');
      name.textContent = `${category} 文件夹`;
      const total = document.createElement('b');
      total.textContent = `${count} 个`;
      line.append(name, total);
      return line;
    }));
    $('#organize-button').disabled = false;
  } catch (error) {
    console.error('Folder scan failed', error);
    toast(error.message || '读取文件夹失败。');
  }
});
$('#organize-button').addEventListener('click', async () => {
  if (!selectedFolder || !window.confirm('确定按文件类型移动当前文件夹中的文件吗？此操作会将文件移入分类子文件夹。')) return;
  try {
    const result = await window.companion.organizeFolder();
    toast(`整理完成，共移动 ${result.moved} 个文件。`);
    const scan = await window.companion.scanFolder();
    const preview = $('#organize-preview');
    if (!Object.keys(scan.counts).length) {
      preview.innerHTML = '<p class="empty-state">整理完成，当前没有剩余文件。</p>';
      $('#organize-button').disabled = true;
    } else {
      preview.replaceChildren(...Object.entries(scan.counts).map(([category, count]) => {
        const line = document.createElement('div');
        line.className = 'preview-line';
        line.textContent = `${category} 文件夹 · ${count} 个`;
        return line;
      }));
    }
  } catch (error) {
    console.error('File organization failed', error);
    toast(error.message || '文件整理失败。');
  }
});
$('#import-timetable').addEventListener('click', () => $('#timetable-file').click());
$('#timetable-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const content = await file.text();
    const parsed = file.name.toLowerCase().endsWith('.json') ? JSON.parse(content) : parseCsv(content);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('课表文件需要包含至少一条课程记录。');
    const imported = parsed.map(normalizeCourse);
    courses = [...courses, ...imported];
    saveList(STORAGE_KEYS.courses, courses);
    renderCourses();
    toast(`已导入 ${imported.length} 门课程。`);
  } catch (error) {
    console.error('Timetable import failed', error);
    toast(error.message || '课表文件导入失败。');
  } finally {
    event.target.value = '';
  }
});
$('#solve-button').addEventListener('click', async () => {
  const question = $('#question-input').value.trim();
  if (!question) return toast('先写下需要解答的问题。');
  await askAssistant(question, $('#answer-box'));
});
$('#feedback-open').addEventListener('click', () => {
  const context = lastQuestion ? `问题：${lastQuestion}\n\n已有解答：${lastAnswer}\n\n` : '';
  $('#feedback-content').value = context;
  openModal('feedback-modal');
});
$('#copy-feedback').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#feedback-content').value);
    toast('反馈内容已复制。');
  } catch (error) {
    console.error('Clipboard copy failed', error);
    toast('复制失败，请手动选择反馈内容。');
  }
});
$('#send-feedback').addEventListener('click', async () => {
  const content = $('#feedback-content').value.trim();
  if (!content) return toast('请先写下反馈内容。');
  try {
    await window.companion.sendFeedback(content);
    toast('已打开邮件草稿，请选择收件人后发送。');
    closeModal('feedback-modal');
  } catch (error) {
    console.error('Unable to open feedback email', error);
    toast(error.message || '无法打开邮件应用。');
  }
});
$('#account-form').addEventListener('submit', (event) => {
  event.preventDefault();
  handleAccountAction('login');
});
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const settings = await window.companion.saveSharedSettings({
      apiUrl: $('#setting-api-url').value,
      model: $('#setting-model').value
    });
    $('#setting-api-url').value = settings.apiUrl;
    $('#setting-model').value = settings.model;
    toast('全员共享设置已保存到中央服务。');
  } catch (error) {
    console.error('Settings save failed', error);
    toast(error.message || '保存设置失败。');
  } finally {
    button.disabled = false;
  }
});
$('#create-invite').addEventListener('click', async () => {
  const button = $('#create-invite');
  button.disabled = true;
  try {
    const result = await window.companion.createInvite();
    const output = $('#invite-result');
    output.hidden = false;
    output.textContent = `一次性邀请码：${result.code}（24 小时内有效，仅显示一次）`;
  } catch (error) {
    console.error('Unable to create invite', error);
    toast(error.message || '生成邀请码失败。');
  } finally {
    button.disabled = false;
  }
});
$('#interaction-phrase').value = localStorage.getItem('xiaoduola.interaction.phrase.v1') || $('#interaction-phrase').value;
$('#interaction-phrase').addEventListener('input', (event) => {
  localStorage.setItem('xiaoduola.interaction.phrase.v1', event.currentTarget.value);
});
$('#import-interaction-audio').addEventListener('click', async () => {
  try {
    const result = await window.companion.importInteractionVoice();
    if (!result) return;
    await loadInteractionVoice();
    toast(`已导入互动声音：${result.name}`);
  } catch (error) {
    console.error('Interaction voice import failed', error);
    toast(error.message || '导入互动声音失败。');
  }
});
$('#remove-interaction-audio').addEventListener('click', async () => {
  try {
    await window.companion.removeInteractionVoice();
    if (activeInteractionAudio) activeInteractionAudio.pause();
    activeInteractionAudio = null;
    interactionAudio = null;
    await loadInteractionVoice();
    toast('已移除导入的互动声音。');
  } catch (error) {
    console.error('Interaction voice removal failed', error);
    toast(error.message || '移除互动声音失败。');
  }
});
$('#speech-toggle').addEventListener('click', () => {
  speechEnabled = !speechEnabled;
  localStorage.setItem('lanlan.speech.enabled.v1', String(speechEnabled));
  $('#speech-toggle').textContent = speechEnabled ? '关闭语音播报' : '开启语音播报';
  if (speechEnabled) setBubble('语音播报已经开启啦！', true);
  else if ('speechSynthesis' in window) window.speechSynthesis.cancel();
});
$('#speech-voice').addEventListener('change', (event) => {
  localStorage.setItem('lanlan.speech.voice.v1', event.currentTarget.value);
});
$('#speech-test').addEventListener('click', () => {
  if (!speak('你好呀，我是你的学习小助手。今天也一起加油吧！', true)) {
    toast('当前设备无法播放语音，请检查 Windows 语音设置。');
  }
});
$('#game-start').addEventListener('click', runGame);
$('#game-restart').addEventListener('click', runGame);

if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', loadSpeechVoices);
loadSpeechVoices();
loadInteractionVoice();
loadSettings();
$('#speech-toggle').textContent = speechEnabled ? '关闭语音播报' : '开启语音播报';
updateClock();
setInterval(updateClock, 1000);
renderTasks();
renderCourses();
renderNotes();
checkReminders();
setInterval(checkReminders, 30000);
