const $ = (id) => document.getElementById(id);
let forms = [];
let selectedId = null;

function status(text, type='info'){ $('statusPill').textContent = `● ${text}`; }
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function typeName(item){const t=item.itemId?'題目':'';return t || '表單項目';}

async function loadForms(){
  try{
    status('正在讀取 Google 表單…');
    forms = await window.formLotteryAPI.listForms();
    $('formCount').textContent = `${forms.length} 個表單`;
    $('forms').innerHTML = forms.length ? forms.map(f=>`<button class="form-item ${f.id===selectedId?'active':''}" data-id="${esc(f.id)}"><div class="form-name">${esc(f.name||'未命名表單')}</div><div class="form-meta">更新：${esc(f.modifiedTime||'')} · Form ID：${esc(f.id)}</div></button>`).join('') : '<div class="empty">目前帳號沒有可讀取的 Google 表單。</div>';
    document.querySelectorAll('.form-item').forEach(b=>b.addEventListener('click',()=>selectForm(b.dataset.id)));
    status('Google 帳號已連線');
  }catch(e){status('讀取失敗'); $('forms').innerHTML=`<div class="empty">${esc(e.message||String(e))}</div>`;}
}

async function selectForm(id){
  selectedId=id; $('responsesBtn').disabled=false; $('detailSub').textContent='讀取中…'; $('detail').innerHTML='<div class="empty">正在讀取表單內容…</div>';
  document.querySelectorAll('.form-item').forEach(b=>b.classList.toggle('active',b.dataset.id===id));
  try{
    const form=await window.formLotteryAPI.readForm(id);
    $('detailSub').textContent=form.info?.title?.text || form.info?.title || 'Google 表單';
    const items=form.items||[];
    $('detail').innerHTML=items.length?items.map((item,i)=>`<div class="question"><div class="q-title">${i+1}. ${esc(item.title||item.description||'未命名題目')}</div><div class="q-type">${esc(typeName(item))}</div></div>`).join(''):'<div class="empty">這份表單目前沒有可顯示的題目。</div>';
  }catch(e){$('detailSub').textContent='讀取失敗';$('detail').innerHTML=`<div class="empty">${esc(e.message||String(e))}</div>`;}
}

async function readResponses(){
  if(!selectedId)return;
  try{const rows=await window.formLotteryAPI.readResponses(selectedId); $('detail').insertAdjacentHTML('beforeend',`<div class="response-box">目前讀到 ${rows.length} 筆回覆。\n\n${esc(JSON.stringify(rows.slice(0,3),null,2))}</div>`);}catch(e){$('detail').insertAdjacentHTML('beforeend',`<div class="response-box">讀取回覆失敗：${esc(e.message||String(e))}</div>`);}
}

$('loginBtn').onclick=async()=>{try{await window.formLotteryAPI.login();await loadForms();}catch(e){status('登入失敗');alert(e.message||String(e));}};
$('logoutBtn').onclick=async()=>{await window.formLotteryAPI.logout();forms=[];selectedId=null;$('forms').innerHTML='<div class="empty">已登出 Google 帳號。</div>';$('detail').innerHTML='<div class="empty">重新登入後選擇表單。</div>';status('尚未登入');};
$('refreshBtn').onclick=loadForms;$('refreshSmall').onclick=loadForms;$('responsesBtn').onclick=readResponses;$('openV138Btn').onclick=()=>window.formLotteryAPI.openV138Reference();
window.formLotteryAPI.onStatus((p)=>status(p.message||'狀態更新'));
(async()=>{try{if(await window.formLotteryAPI.hasToken()) await loadForms();}catch(e){status('尚未登入');}})();
