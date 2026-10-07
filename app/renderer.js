const $ = (id) => document.getElementById(id);
const loginBtn = $('loginBtn'), refreshBtn = $('refreshBtn'), logoutBtn = $('logoutBtn');
const formsList = $('formsList'), statusText = $('statusText'), accountPill = $('accountPill');
let currentFormId = '';

function setStatus(text, type='normal') {
  statusText.textContent = text;
  statusText.style.color = type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--green)' : '';
}

function setLoggedIn(email) {
  accountPill.textContent = email || '已登入';
  loginBtn.textContent = '✓ Google 已登入';
  loginBtn.disabled = true;
  refreshBtn.disabled = false;
  logoutBtn.disabled = false;
}

function resetLogin() {
  accountPill.textContent = '尚未登入';
  loginBtn.textContent = '🔵 使用 Google 帳號登入';
  loginBtn.disabled = false;
  refreshBtn.disabled = true;
  logoutBtn.disabled = true;
  formsList.className = 'forms-list empty';
  formsList.innerHTML = '<div><div class="empty-icon">📋</div><div>尚未載入表單</div></div>';
  $('detailPanel').hidden = true;
  currentFormId = '';
  setStatus('登入後會在這裡顯示你可以使用的 Google Forms。');
}

async function loadForms() {
  setStatus('正在讀取你的 Google 表單…');
  refreshBtn.disabled = true;
  try {
    const result = await window.formLotteryAPI.listForms();
    const forms = result.forms || [];
    formsList.className = forms.length ? 'forms-list' : 'forms-list empty';
    if (!forms.length) {
      formsList.innerHTML = '<div><div class="empty-icon">📭</div><div>目前沒有找到可用的 Google Form</div></div>';
      setStatus('目前沒有找到 Google Form。');
      return;
    }
    formsList.innerHTML = forms.map(f => `<button class="form-card" data-id="${escapeAttr(f.id)}"><div><div class="form-name">${escapeHtml(f.name || '未命名表單')}</div><div class="form-meta">${f.modifiedTime ? `最後修改：${new Date(f.modifiedTime).toLocaleString('zh-TW')}` : 'Google Form'}<br><span>Form ID：${escapeHtml(f.id)}</span></div></div><span class="open-dot"></span></button>`).join('');
    formsList.querySelectorAll('.form-card').forEach(card => card.addEventListener('click', () => loadForm(card.dataset.id)));
    setStatus(`✓ 找到 ${forms.length} 份 Google Form。`, 'success');
  } catch (err) {
    if (/unauthorized|invalid_grant|invalid authentication credentials|invalid_token/i.test(err.message || '')) {
      resetLogin();
      setStatus('登入狀態已失效，請重新登入 Google。', 'error');
    } else {
      setStatus(err.message || '讀取表單失敗。', 'error');
    }
  } finally {
    refreshBtn.disabled = false;
  }
}

async function loadForm(id) {
  currentFormId = id;
  $('detailPanel').hidden = false;
  $('formTitle').textContent = '讀取表單中…';
  $('formMeta').textContent = '';
  $('questionList').innerHTML = '<div class="question">正在向 Google Forms API 取得資料…</div>';
  try {
    const result = await window.formLotteryAPI.readForm(id);
    const form = result.form || {};
    $('formTitle').textContent = form.info?.title || '未命名表單';
    const items = form.items || [];
    $('formMeta').textContent = `Form ID：${id}｜題目/項目：${items.length}`;
    $('questionList').innerHTML = items.map((item, i) => `<div class="question"><div class="q-title">${i + 1}. ${escapeHtml(item.title || '未命名項目')}</div><div class="q-type">${escapeHtml(item.itemId || '')} ${item.questionItem ? '｜Question' : ''}</div></div>`).join('') || '<div class="question">這份表單目前沒有可顯示的項目。</div>';
    setStatus('✓ 表單內容讀取成功。', 'success');
    await loadResponses(id);
  } catch (err) {
    $('formTitle').textContent = '讀取失敗';
    $('questionList').innerHTML = `<div class="question">${escapeHtml(err.message || '無法讀取表單。')}</div>`;
    setStatus(err.message || '讀取表單失敗。', 'error');
  }
}

async function loadResponses(id) {
  try {
    const result = await window.formLotteryAPI.readResponses(id);
    const responses = result.responses || [];
    const box = document.createElement('div');
    box.className = 'question response-summary';
    box.innerHTML = `<div class="q-title">目前讀到 ${responses.length} 筆回覆。</div><button type="button" class="secondary" id="showResponsesBtn">讀取回覆</button><pre id="responseJson" hidden></pre>`;
    $('questionList').appendChild(box);
    const pre = box.querySelector('#responseJson');
    pre.textContent = JSON.stringify(responses, null, 2);
    box.querySelector('#showResponsesBtn').addEventListener('click', (e) => {
      const hidden = pre.hidden;
      pre.hidden = !hidden;
      e.currentTarget.textContent = hidden ? '收起回覆' : '讀取回覆';
    });
  } catch (err) {
    const box = document.createElement('div');
    box.className = 'question';
    box.textContent = `回覆讀取失敗：${err.message || err}`;
    $('questionList').appendChild(box);
  }
}

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function escapeAttr(s) { return escapeHtml(s); }

loginBtn.addEventListener('click', async () => {
  loginBtn.disabled = true;
  setStatus('正在開啟 Google 登入…');
  try { await window.formLotteryAPI.login(); }
  catch (err) { setStatus(err.message || 'Google 登入失敗。', 'error'); loginBtn.disabled = false; }
});

refreshBtn.addEventListener('click', loadForms);
logoutBtn.addEventListener('click', async () => { await window.formLotteryAPI.logout(); resetLogin(); });

window.formLotteryAPI.onStatus(async (payload) => {
  if (payload.type === 'logged-in' || payload.type === 'restored') {
    setLoggedIn(payload.data?.email || payload.data?.email || '已登入');
    setStatus(payload.type === 'restored' ? '✓ 已恢復 Google 登入狀態，正在載入表單…' : '✓ Google 登入成功，正在載入你的表單…', 'success');
    await loadForms();
  } else if (payload.type === 'logged-out') {
    resetLogin();
  } else if (payload.type === 'error') {
    setStatus(payload.message, 'error');
    loginBtn.disabled = false;
  }
});

(async () => {
  try {
    const state = await window.formLotteryAPI.restoreAuth();
    if (state.loggedIn) {
      setLoggedIn(state.account?.email || '已登入');
      await loadForms();
    } else {
      resetLogin();
    }
  } catch (_) {
    resetLogin();
  }
})();
