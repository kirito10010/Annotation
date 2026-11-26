/* Label Auto 看板 前端逻辑 */
'use strict';

const state = {
  user: null,
  projects: [],
  projectIds: '',        // 项目 id 集合签名：没变就不重建下拉（静默刷新用）
  currentProjectId: null,
  categories: [],
  colors: {},
  queryResults: [],
  queryRuleCount: 0,
  searchResults: [],
  rules: [],             // 缺失校验规则：[{ parent: 属性名, children: [属性名...] }]
  qcOwners: [],
  qcReviewers: [],
};

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2200);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function api(path, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  if (opts.body && typeof opts.body === 'object') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, opts);
  const ct = r.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    return await r.json();
  }
  return r;
}

/* ============ 项目 ============ */
async function loadProjects(opts) {
  const silent = !!(opts && opts.silent);
  const r = await api('/api/projects');
  if (!r || !r.ok) { if (!silent) toast((r && r.error) || '加载项目失败'); return; }
  const list = r.projects || [];
  const ids = list.map(p => p.id).join(',');
  if (silent && ids === state.projectIds) return;   // 集合没变 → 什么都不做（不打断当前操作）
  state.projectIds = ids;
  state.projects = list;
  const sel = $('projectSel');
  const keep = silent ? state.currentProjectId : null;
  sel.innerHTML = '';
  list.forEach(p => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  });
  if (silent && list.some(p => p.id === keep)) {    // 当前项目还在 → 只多出新选项，不动现状
    sel.value = keep;
    return;
  }
  if (list.length) {
    state.currentProjectId = list[0].id;
    await onProjectChange();
  }
  if (silent) toast('项目列表已更新');
}

/* 静默刷新项目列表：后台新建的项目不用刷新页面也能出现（10s 一次；后台标签页不刷） */
let projectTimer = null;
function startProjectAuto() {
  if (projectTimer) return;
  projectTimer = setInterval(() => {
    if (document.hidden) return;
    loadProjects({ silent: true });
  }, 10000);
}

async function onProjectChange() {
  state.currentProjectId = $('projectSel').value;
  const p = state.projects.find(x => x.id === state.currentProjectId);
  if (!p) return;
  state.categories = p.categories || [];
  state.colors = p.colors || {};
  // 渲染标签多选下拉（切项目后清空已选标签）
  selectedLabels.clear();
  renderLabelPicker();
  // 缺失校验规则引用的是上一个项目的属性名，切项目后清空
  state.rules = [];
  renderRules();
  // 渲染质检员下拉（来自 monitoring）
  await loadMonitoring();
  // 项目切换后，若当前在「标签分布」页，重新渲染分布
  if (!$('tab-dist').classList.contains('hidden')) doDist();
  // 后台预加载该项目的质检时间，加速后续「按时间排序」
  api('/api/projects/' + state.currentProjectId + '/preload');
}

/* ============ 质检看板数据 ============ */
async function loadMonitoring(force) {
  const r = await api('/api/monitoring' + (force ? '?force=1' : ''));
  if (!r || !r.ok) return;
  state.qcOwners = [];
  state.qcReviewers = [];
  const owners = new Set();
  (r.projects || []).forEach(p => {
    if (p.id === state.currentProjectId) {
      (p.qc_assignees || []).forEach(a => {
        if (a && a.name) owners.add(a.name);
        if (a && a.uid) state.qcReviewers.push({ uid: a.uid, name: a.name || a.uid });
      });
    }
  });
  state.qcOwners = Array.from(owners);
  const osel = $('queryOwner');
  const cur = osel.value;
  osel.innerHTML = '<option value="">全部</option>';
  state.qcOwners.forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; osel.appendChild(o);
  });
  osel.value = cur;
  renderFixOwner();
  const t = $('monitorTime');
  if (t) t.textContent = '快照时间：' + (r.generated_at || '未知');
  renderMonitor(r);
}

let monitorTimer = null;
function startMonitorAuto() {
  stopMonitorAuto();
  monitorTimer = setInterval(() => {
    if (!$('tab-monitor').classList.contains('hidden')) loadMonitoring();
  }, 30000);
}
function stopMonitorAuto() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
}

/* ============ 归属修复 ============ */
function renderFixOwner() {
  const sel = $('fixOwner');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">请选择质检员</option>';
  state.qcReviewers.forEach(r => {
    const o = document.createElement('option');
    o.value = r.uid;
    o.textContent = r.name;
    sel.appendChild(o);
  });
  if (cur && state.qcReviewers.some(r => r.uid === cur)) sel.value = cur;
}
async function doFix() {
  if (!state.currentProjectId) { toast('请先选择项目'); return; }
  const uid = $('fixOwner').value;
  if (!uid) { toast('请先选择质检员'); return; }
  const btn = $('fixBtn');
  btn.disabled = true;
  $('fixSummary').textContent = '正在恢复归属…';
  let r;
  try {
    r = await api('/api/qc/fix', { method: 'POST', body: { pid: state.currentProjectId, uid } });
  } catch (e) {
    btn.disabled = false;
    $('fixSummary').textContent = '操作失败（网络或服务异常）';
    return;
  }
  btn.disabled = false;
  if (r && r.ok) {
    $('fixSummary').textContent = '共 ' + r.total + ' 张，成功 ' + r.succeeded + '，失败 ' + (r.failed || []).length;
  } else {
    $('fixSummary').textContent = (r && r.error) || '操作失败';
  }
}

/* ============ 标签页切换 ============ */
document.querySelectorAll('#tabs button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    $('tab-' + tab).classList.remove('hidden');
    if (tab === 'monitor') { loadMonitoring(); startMonitorAuto(); }
    else stopMonitorAuto();
    if (tab === 'dist') doDist();
  };
});

/* ============ 标签巡检 ============ */
const selectedLabels = new Set();

function renderLabelPicker() {
  const dd = $('labelPickerDropdown');
  dd.innerHTML = '';
  (state.categories || []).forEach(c => {
    const lab = document.createElement('label');
    lab.className = 'label-picker-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c;
    cb.checked = selectedLabels.has(c);
    cb.onchange = () => { cb.checked ? selectedLabels.add(c) : selectedLabels.delete(c); updateLabelPickerField(); };
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(c));
    dd.appendChild(lab);
  });
  updateLabelPickerField();
}

function updateLabelPickerField() {
  const el = $('labelPickerField');
  const labels = Array.from(selectedLabels);
  el.innerHTML = labels.length
    ? labels.map(l => `<span class="label-picker-tag">${escapeHtml(l)}</span>`).join('')
    : '<span class="placeholder">选择标签（可多选，留空查全部）</span>';
}

/* ============ 缺失校验规则 ============ */

// 通用分类多选下拉（规则里的子属性多选用）
function createCatPicker(initial, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'cat-picker';
  const field = document.createElement('div');
  field.className = 'cat-picker-field';
  const dd = document.createElement('div');
  dd.className = 'cat-picker-dropdown hidden';
  const set = new Set(initial || []);

  function renderField() {
    field.innerHTML = set.size
      ? Array.from(set).map(c => `<span class="label-picker-tag">${escapeHtml(c)}</span>`).join('')
      : '<span class="placeholder">选择子属性（可多选）</span>';
  }
  function renderDropdown() {
    dd.innerHTML = '';
    (state.categories || []).forEach(c => {
      const lab = document.createElement('label');
      lab.className = 'label-picker-option';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = set.has(c);
      cb.onchange = () => {
        cb.checked ? set.add(c) : set.delete(c);
        renderField();
        if (onChange) onChange(Array.from(set));
      };
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(c));
      dd.appendChild(lab);
    });
  }

  field.onclick = e => {
    e.stopPropagation();
    if (dd.classList.contains('hidden')) renderDropdown();
    dd.classList.toggle('hidden');
  };
  dd.onclick = e => e.stopPropagation();
  wrap.appendChild(field);
  wrap.appendChild(dd);
  renderField();
  return { el: wrap, getSelected: () => Array.from(set) };
}

function renderRules() {
  const list = $('ruleList');
  if (!list) return;
  list.innerHTML = '';
  if (!state.rules.length) {
    list.innerHTML = '<div class="rule-empty">未添加规则；点击「+ 添加规则」按父属性做缺失校验。</div>';
    return;
  }
  state.rules.forEach((rule, idx) => {
    const card = document.createElement('div');
    card.className = 'rule-card';

    const no = document.createElement('span');
    no.className = 'rule-no';
    no.textContent = '规则 ' + (idx + 1);

    const sel = document.createElement('select');
    sel.className = 'rule-parent';
    sel.innerHTML = '<option value="">选择父属性</option>' +
      (state.categories || []).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    sel.value = rule.parent || '';
    sel.onchange = () => { rule.parent = sel.value; };

    const must = document.createElement('span');
    must.className = 'rule-label';
    must.textContent = '框内必须包含任一：';

    const picker = createCatPicker(rule.children, selected => { rule.children = selected; });

    const del = document.createElement('button');
    del.className = 'btn rule-del';
    del.title = '删除规则';
    del.textContent = '×';
    del.onclick = () => { state.rules.splice(idx, 1); renderRules(); };

    card.appendChild(no);
    card.appendChild(sel);
    card.appendChild(must);
    card.appendChild(picker.el);
    card.appendChild(del);
    list.appendChild(card);
  });
}

function collectRules() {
  for (let i = 0; i < state.rules.length; i++) {
    const r = state.rules[i];
    if (!r.parent) return { ok: false, error: `规则 ${i + 1} 还没选父属性` };
    if (!r.children.length) return { ok: false, error: `规则 ${i + 1} 还没选子属性` };
  }
  return {
    ok: true,
    rules: state.rules.map(r => ({ parent: r.parent, children: r.children.slice() })),
  };
}

let _progressTimer = null;
function startQueryProgress() {
  const summary = $('querySummary');
  const update = async () => {
    try {
      const r = await api('/api/query_progress');
      if (r && r.ok && r.progress) {
        const p = r.progress;
        if (p.phase === 'export') {
          summary.textContent = '正在下载导出数据…';
        } else if (p.phase === 'annotation' && p.total) {
          summary.textContent = '正在拉取质检时间 ' + p.done + '/' + p.total + '…';
        }
      }
    } catch (e) { /* 忽略轮询错误 */ }
  };
  update();
  _progressTimer = setInterval(update, 1500);
}
function stopQueryProgress() {
  if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
}

async function doQuery() {
  if (!state.currentProjectId) return toast('请先选择项目');
  const cat = Array.from(selectedLabels).join(',');
  const sort = $('querySort').value;
  const pm = $('queryPassedMinutes').value;
  const rc = collectRules();
  if (!rc.ok) return toast(rc.error);
  state.queryRuleCount = rc.rules.length;
  const params = [];
  if (cat) params.push('cat=' + encodeURIComponent(cat));
  if (sort) params.push('sort=' + sort);
  if (pm) params.push('passed_minutes=' + pm);
  if (rc.rules.length) params.push('rules=' + encodeURIComponent(JSON.stringify({ rules: rc.rules })));
  const url = '/api/projects/' + state.currentProjectId + '/query' + (params.length ? '?' + params.join('&') : '');
  toast(rc.rules.length
    ? `缺失校验 ${rc.rules.length} 条规则，查询中…`
    : (pm ? '查询最近通过的数据…' : (sort ? '按质检时间排序中，请稍候…' : (cat ? '查询中，请稍候…' : '加载全部图片中…'))));
  startQueryProgress();
  let r;
  try {
    r = await api(url);
  } finally {
    stopQueryProgress();
  }
  if (!r || !r.ok) { $('querySummary').textContent = ''; toast((r && r.error) || '查询失败'); return; }
  state.queryResults = r.results || [];
  renderQuery(state.queryResults);
}

function renderQuery(results) {
  const status = $('queryStatus').value;
  const owner = $('queryOwner').value;
  let rows = results;
  if (status) rows = rows.filter(r => r.qc_status === status);
  if (owner) rows = rows.filter(r => r.qc_owner === owner);

  const totalBoxes = rows.reduce((s, r) => s + (r.box_count != null ? r.box_count : r.boxes.length), 0);
  const unannotated = results.filter(r => r.qc_status === 'unannotated').length;
  const ruleInfo = state.queryRuleCount
    ? `，缺失校验 <strong>${state.queryRuleCount}</strong> 条规则`
    : '';
  $('querySummary').innerHTML =
    `命中 <strong>${results.length}</strong> 张图` +
    (unannotated ? `（未作业 ${unannotated}）` : '') +
    ruleInfo +
    `，筛选后 <strong>${rows.length}</strong> 张（框数 ${totalBoxes}）`;
  // 未作业的图没有任何人工标注，选标签时必然查不到，说明原因而不是让人以为坏了
  if (status === 'unannotated' && selectedLabels.size && rows.length === 0) {
    $('querySummary').innerHTML += '<div class="hint">未作业的图还没有人工标注，无法命中标签；清空标签后可查看本项目全部未作业图。</div>';
  }

  const tbody = $('queryTable').querySelector('tbody');
  tbody.innerHTML = '';
  $('queryTable').classList.toggle('hidden', rows.length === 0);
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.onclick = () => openPreview(r.image_id);
    tr.innerHTML = `<td class="ck"><input type="checkbox" class="rowCheck" data-id="${escapeHtml(r.image_id)}"></td>` +
      `<td>${escapeHtml(r.image_id)}</td><td>${escapeHtml(boxesText(r))}</td>` +
      `<td><span class="badge ${escapeHtml(r.qc_status || 'unknown')}">${statusText(r.qc_status)}</span></td>` +
      `<td>${escapeHtml(r.qc_owner || '-')}</td>` +
      `<td>${submitIdentityBadge(r)}</td>` +
      `<td>${escapeHtml(r.reviewed_at || '-')}</td>`;
    tr.querySelector('.rowCheck').onclick = e => { e.stopPropagation(); updateQueryCount(); };
    tbody.appendChild(tr);
  });
  $('querySelectAll').checked = false;
  updateQueryCount();
}

/* 框列文案：缺失校验优先展示违规父框；未作业行没有人工框，显示模型预标注框数 */
function boxesText(r) {
  if (r.violations && r.violations.length) {
    return r.violations.map(v =>
      `${v.parent}(${v.x},${v.y},${v.w},${v.h}) 缺 ${(v.expected || []).join('/')}`
    ).join('；');
  }
  if (r.qc_status === 'unannotated') {
    return r.box_count > 0 ? `预标注 ${r.box_count} 框` : '无标注';
  }
  if (r.boxes && r.boxes.length) {
    return r.boxes.map(b => `(${b.x},${b.y},${b.w},${b.h})`).join('；');
  }
  return `${r.box_count != null ? r.box_count : r.boxes.length} 框`;
}

/* 缺失子属性列：违规父框缺哪些子属性（无违规则为空） */
function violationsText(r) {
  if (!r.violations || !r.violations.length) return '';
  return r.violations.map(v => `${v.parent} 缺 ${(v.expected || []).join('/')}`).join('；');
}

/* 提交身份：这张图批量通过/打回时会用谁的权限 */
function submitIdentityText(r) {
  if (!r.submit_as) return '-';
  if (!r.qc_uid) return `${r.submit_by}（回退·未分配）`;
  return r.submit_as === 'reviewer' ? `${r.submit_by}（本人）` : `${r.submit_by}（回退）`;
}

function submitIdentityBadge(r) {
  if (!r.submit_as) return '-';
  const cls = !r.qc_uid ? 'submit-none'
    : (r.submit_as === 'reviewer' ? 'submit-reviewer' : 'submit-owner');
  return `<span class="badge ${cls}" title="${escapeHtml(r.submit_note || '')}">` +
    `${escapeHtml(submitIdentityText(r))}</span>`;
}

/* 选中项里有多少张会以管理员（回退）身份提交 */
function countOwnerFallback(scope, ids) {
  const src = scope === '#searchTable' ? state.searchResults : state.queryResults;
  const set = new Set(ids);
  return (src || []).filter(r => set.has(r.image_id) && r.submit_as && r.submit_as !== 'reviewer').length;
}

function getSelectedIds(scope) {
  return Array.from(document.querySelectorAll((scope || '#queryTable') + ' .rowCheck:checked'))
    .map(c => c.dataset.id);
}

function updateSelectedCount(scope, btn, label) {
  const n = getSelectedIds(scope).length;
  btn.textContent = n > 0 ? `${label} (${n})` : label;
}

async function batchQc(scope, verdict, afterFn) {
  const ids = getSelectedIds(scope);
  if (!ids.length) return toast('请先勾选图片');
  if (!state.currentProjectId) return toast('请先选择项目');
  const act = verdict === 'pass' ? '通过' : '打回';
  const fallbackN = countOwnerFallback(scope, ids);
  const extra = fallbackN
    ? `\n其中 ${fallbackN} 张会以管理员身份提交（归属不会算在质检员名下）`
    : '';
  if (!confirm(`确定将 ${ids.length} 张图${act}吗？${extra}`)) return;
  toast(`批量${act}中…`);
  let r;
  try {
    r = await api('/api/projects/' + state.currentProjectId + '/batch_qc', {
      method: 'POST', body: { image_ids: ids, verdict, reason: '' }
    });
  } catch (e) {
    // 以前这里没有 try/catch，网络异常会静默无提示，看着像成功了
    toast(`批量${act}失败：网络异常，请重试`);
    return;
  }
  if (!r || !r.ok) { toast((r && r.error) || `批量${act}失败`); return; }
  const failedN = (r.failed && r.failed.length) || 0;
  const unassignedN = (r.unassigned && r.unassigned.length) || 0;
  const noCredN = (r.no_cred && r.no_cred.length) || 0;
  const asOwnerN = r.as_owner || 0;
  const warn = [];
  if (failedN) warn.push(`失败 ${failedN} 张`);
  if (asOwnerN) warn.push(`以管理员身份提交 ${asOwnerN} 张`);
  if (unassignedN) warn.push(`${unassignedN} 张未分配质检员（质检平台看不到）`);
  if (noCredN) warn.push(`${noCredN} 张的质检员未内置登录（平台归属可能不对）`);
  toast(`${act}成功 ${r.succeeded} 张` + (warn.length ? `；${warn.join('；')}` : ''));
  if (afterFn) afterFn();
}

function updateQueryCount() {
  updateSelectedCount('#queryTable', $('batchRejectBtn'), '批量打回');
  updateSelectedCount('#queryTable', $('batchPassBtn'), '批量通过');
}

function updateSearchCount() {
  updateSelectedCount('#searchTable', $('searchBatchRejectBtn'), '批量打回');
  updateSelectedCount('#searchTable', $('searchBatchPassBtn'), '批量通过');
}

function statusText(s) {
  return { unannotated: '未作业', passed: '已通过', pending: '待质检', rejected: '已打回' }[s] || s || '未知';
}

/* ============ 质检看板 ============ */
function renderMonitor(data) {
  if (!data || !data.projects) return;
  const p = data.projects.find(x => x.id === state.currentProjectId) || data.projects[0];
  if (!p) return;

  $('monitorSummary').innerHTML =
    `项目「${escapeHtml(p.name)}」：总图 ${p.total_images}，已标注 ${p.total_annotated}，` +
    `质检通过 <strong>${p.total_qc_passed}</strong>，打回 <strong>${p.total_qc_rejected}</strong>，` +
    `标注进度 ${(p.progress || 0).toFixed(1)}%，质检进度 ${(p.qc_progress || 0).toFixed(1)}%`;

  let html = '<div class="panel"><h3>质检员统计</h3><div class="table-wrap"><table>' +
    '<thead><tr><th>质检员</th><th>分配</th><th>已通过</th><th>已打回</th><th>进度</th></tr></thead><tbody>';
  (p.qc_assignees || []).forEach(a => {
    const passed = a.passed || 0, rejected = a.rejected || 0, assigned = a.assigned || 0;
    html += `<tr><td>${escapeHtml(a.name || a.email || a.uid)}</td><td>${assigned}</td>` +
      `<td>${passed}</td><td>${rejected}</td><td>${(a.progress || 0).toFixed(1)}%</td></tr>`;
  });
  html += '</tbody></table></div></div>';

  html += '<div class="panel"><h3>标注员统计</h3><div class="table-wrap"><table>' +
    '<thead><tr><th>标注员</th><th>分配</th><th>已标注</th><th>进度</th><th>质检通过</th><th>打回</th><th>有效率</th></tr></thead><tbody>';
  (p.assignees || []).forEach(a => {
    html += `<tr><td>${escapeHtml(a.name || a.email || a.uid)}</td><td>${a.assigned || 0}</td>` +
      `<td>${a.annotated || 0}</td><td>${(a.progress != null ? a.progress.toFixed(1) : '-')}%</td>` +
      `<td>${a.qc_passed || 0}</td><td>${a.qc_rejected || 0}</td>` +
      `<td>${(a.valid_rate != null ? a.valid_rate.toFixed(1) : '-')}%</td></tr>`;
  });
  html += '</tbody></table></div></div>';

  $('monitorContent').innerHTML = html;
}

/* ============ 标签分布 ============ */
async function doDist() {
  const el = $('distContent');
  if (!state.currentProjectId) {
    el.innerHTML = '<div class="hint">请先登录并选择项目。</div>';
    return;
  }
  el.innerHTML = '<div class="hint">加载中…</div>';
  const r = await api('/api/projects/' + state.currentProjectId + '/distribution');
  if (!r || !r.ok) {
    el.innerHTML = '<div class="hint">加载失败：' + escapeHtml((r && r.error) || '未知错误') + '</div>';
    return;
  }
  const dist = r.distribution || [];
  const max = Math.max(1, ...dist.map(d => d.count));
  let html = '<div class="panel"><h3>标签分布</h3>';
  dist.forEach(d => {
    const w = (d.count / max * 100).toFixed(1);
    html += `<div class="bar-row"><div class="cat">${escapeHtml(d.category)}</div>` +
      `<div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>` +
      `<div class="cnt">${d.count}</div></div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

/* ============ 图片搜索 ============ */
async function doSearch() {
  const q = $('searchInput').value.trim();
  if (!q) return toast('请输入文件名');
  if (!state.currentProjectId) return toast('请先选择项目');
  const r = await api('/api/projects/' + state.currentProjectId + '/search?q=' + encodeURIComponent(q));
  if (!r || !r.ok) { toast((r && r.error) || '搜索失败'); return; }
  const results = r.results || [];
  state.searchResults = results;
  $('searchSummary').innerHTML = `匹配 <strong>${results.length}</strong> 张图`;
  const tbody = $('searchTable').querySelector('tbody');
  tbody.innerHTML = '';
  $('searchTable').classList.toggle('hidden', results.length === 0);
  results.forEach(x => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.onclick = () => openPreview(x.image_id);
    tr.innerHTML = `<td class="ck"><input type="checkbox" class="rowCheck" data-id="${escapeHtml(x.image_id)}"></td>` +
      `<td>${escapeHtml(x.image_id)}</td><td>${x.box_count ?? '-'}</td>` +
      `<td><span class="badge ${escapeHtml(x.qc_status || 'unknown')}">${statusText(x.qc_status)}</span></td>` +
      `<td>${escapeHtml(x.qc_owner || '-')}</td>` +
      `<td>${submitIdentityBadge(x)}</td>`;
    tr.querySelector('.rowCheck').onclick = e => { e.stopPropagation(); updateSearchCount(); };
    tbody.appendChild(tr);
  });
  $('searchSelectAll').checked = false;
  updateSearchCount();
}

/* ============ 照片详情面板 ============ */
let detailToken = 0;

// 预览区缩放/平移状态（transform: translate(x,y) scale(s)）
// baseW/baseH：图片适配 wrap 后的 1× 显示尺寸；boxes：当前图标注（供覆盖层重绘）
const previewView = {
  scale: 1, x: 0, y: 0, dragging: false,
  startX: 0, startY: 0, baseX: 0, baseY: 0,
  baseW: 0, baseH: 0, boxes: [],
};

function applyPreviewTransform() {
  const stage = $('previewStage');
  if (!stage) return;
  stage.style.transform =
    `translate(${previewView.x}px, ${previewView.y}px) scale(${previewView.scale})`;
  drawPreviewOverlay();   // 覆盖层不参与缩放，按当前变换重绘，保证线宽/字号恒定清晰
}

function resetPreviewView() {
  previewView.scale = 1;
  previewView.x = 0;
  previewView.y = 0;
  previewView.dragging = false;
  const wrap = $('previewImageWrap');
  if (wrap) wrap.classList.remove('dragging');
  applyPreviewTransform();
}

// 滚轮缩放：以鼠标位置为锚点（stage 在 wrap 内 flex 居中，偏移按 wrap 中心计算）
function onPreviewWheel(e) {
  e.preventDefault();
  const wrap = $('previewImageWrap');
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const cx = e.clientX - rect.left - rect.width / 2;
  const cy = e.clientY - rect.top - rect.height / 2;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const next = Math.min(8, Math.max(0.5, previewView.scale * factor));
  if (next === previewView.scale) return;
  // 保持鼠标下的画面点不动：p = (c - offset) / scale
  previewView.x = cx - (cx - previewView.x) * (next / previewView.scale);
  previewView.y = cy - (cy - previewView.y) * (next / previewView.scale);
  previewView.scale = next;
  applyPreviewTransform();
}

// 拖动平移：mousemove/mouseup 挂在 window，鼠标移出弹窗也不丢
function onPreviewMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  previewView.dragging = true;
  previewView.startX = e.clientX;
  previewView.startY = e.clientY;
  previewView.baseX = previewView.x;
  previewView.baseY = previewView.y;
  $('previewImageWrap').classList.add('dragging');
}

function onPreviewMouseMove(e) {
  if (!previewView.dragging) return;
  previewView.x = previewView.baseX + (e.clientX - previewView.startX);
  previewView.y = previewView.baseY + (e.clientY - previewView.startY);
  applyPreviewTransform();
}

function onPreviewMouseUp() {
  if (!previewView.dragging) return;
  previewView.dragging = false;
  $('previewImageWrap').classList.remove('dragging');
}

async function openPreview(imageId) {
  const myToken = ++detailToken;
  const modal = $('previewModal');
  modal.classList.remove('hidden');
  resetPreviewView();
  clearPreviewOverlay();
  $('previewTitle').textContent = imageId;
  $('previewInfo').innerHTML = '<div class="row">加载中…</div>';

  const img = $('previewImg');
  img.onload = async () => {
    if (myToken !== detailToken) return;
    drawBoxes(img, []);
    try {
      const ann = await api('/api/projects/' + state.currentProjectId + '/annotation?image_id=' + encodeURIComponent(imageId));
      if (myToken !== detailToken) return;
      if (ann && ann.ok && ann.boxes) {
        drawBoxes(img, ann.boxes);
        const chips = ann.boxes.map(b => {
          const cat = b.category || '';
          const pre = b.source === 'pre' ? '[预]' : '';
          return `<span class="label-chip"><span class="dot" style="background:${colorFor(cat)}"></span>` +
            `<span class="txt">${escapeHtml(cat)}${escapeHtml(pre)}</span></span>`;
        }).join('');
        $('previewInfo').innerHTML =
          `<div class="detail-line"><span class="detail-k">状态</span>` +
          `<span class="badge ${escapeHtml(ann.qc_status || 'unknown')}">${statusText(ann.qc_status)}</span>` +
          `<span class="detail-k">框数</span><span class="detail-v">${ann.boxes.length}</span></div>` +
          `<div class="detail-line"><span class="detail-k">标签</span>` +
          `<div class="label-chips">${chips || '<span class="detail-v">无</span>'}</div></div>`;
      }
    } catch (e) { /* 忽略 */ }
  };
  img.onerror = () => { if (myToken === detailToken) $('previewInfo').innerHTML = '<div class="row">图片加载失败</div>'; };
  img.src = '/api/projects/' + state.currentProjectId + '/image?image_id=' + encodeURIComponent(imageId);
}

function colorFor(cat) {
  if (state.colors && state.colors[cat]) return state.colors[cat];
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) % 360;
  return `hsl(${h},70%,45%)`;
}

function closePreview() {
  detailToken++;
  resetPreviewView();
  clearPreviewOverlay();
  $('previewTitle').textContent = '照片详情';
  const img = $('previewImg');
  img.onload = img.onerror = null;
  img.removeAttribute('src');
  $('previewInfo').textContent = '点击图片查看详情';
  $('previewModal').classList.add('hidden');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function clearSvg(svg) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function clearPreviewOverlay() {
  previewView.boxes = [];
  previewView.baseW = 0;
  previewView.baseH = 0;
  clearSvg($('previewSvg'));
}

/* 覆盖层文字宽度估算（SVG 无法直接 measureText，CJK 按全角、ASCII 按半角） */
function previewTextWidth(s, fontSize) {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) > 255 ? fontSize : fontSize * 0.55;
  return w;
}

/* 按当前缩放/位移重绘标注框。覆盖层固定在 wrap 上、不做 CSS 缩放，
   因此线宽 2px、字号 13px 恒定，放大后依然锐利（与作业/质检平台一致）。 */
function drawPreviewOverlay() {
  const wrap = $('previewImageWrap');
  const svg = $('previewSvg');
  if (!wrap || !svg) return;
  const Wc = wrap.clientWidth;
  const Hc = wrap.clientHeight;
  if (!Wc || !Hc) return;
  svg.setAttribute('viewBox', `0 0 ${Wc} ${Hc}`);
  svg.setAttribute('width', Wc);
  svg.setAttribute('height', Hc);
  clearSvg(svg);
  const { baseW: dw, baseH: dh, scale, x, y, boxes } = previewView;
  if (!dw || !dh || !boxes || !boxes.length) return;
  // stage 在 wrap 内居中，缩放原点为中心：屏幕坐标 = 中心 + 位移 + (归一化坐标 - 0.5) * 显示尺寸 * 缩放
  const ox = Wc / 2 + x - (dw / 2) * scale;
  const oy = Hc / 2 + y - (dh / 2) * scale;
  const fontSize = 13;
  boxes.forEach(b => {
    const bb = b.bbox || {};
    if (bb.x1 == null) return;
    const bx = ox + bb.x1 * dw * scale;
    const by = oy + bb.y1 * dh * scale;
    const bw = (bb.x2 - bb.x1) * dw * scale;
    const bh = (bb.y2 - bb.y1) * dh * scale;
    if (bx + bw < 0 || by + bh < 0 || bx > Wc || by > Hc) return;   // 屏幕外裁剪
    const color = colorFor(b.category || '');

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', bx);
    rect.setAttribute('y', by);
    rect.setAttribute('width', Math.max(0, bw));
    rect.setAttribute('height', Math.max(0, bh));
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', color);
    rect.setAttribute('stroke-width', '2');
    svg.appendChild(rect);

    const label = `${b.category || ''}${b.source === 'pre' ? ' [预]' : ''}`;
    const tw = previewTextWidth(label, fontSize);
    let bgY = by - 4 - fontSize;
    let textY = by - 4;
    if (bgY < 0) { bgY = by; textY = by + fontSize; }
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('x', bx);
    bg.setAttribute('y', bgY);
    bg.setAttribute('width', tw + 6);
    bg.setAttribute('height', fontSize + 2);
    bg.setAttribute('fill', color);
    svg.appendChild(bg);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', bx + 3);
    text.setAttribute('y', textY);
    text.setAttribute('font-size', fontSize);
    text.setAttribute('fill', '#fff');
    text.textContent = label;
    svg.appendChild(text);
  });
}

/* 计算 stage 尺寸并保存基础数据，随后由覆盖层按当前变换绘制 */
function drawBoxes(img, boxes) {
  const wrap = $('previewImageWrap');
  const stage = $('previewStage');
  const Wc = wrap.clientWidth;
  const Hc = wrap.clientHeight;
  const Wi = img.naturalWidth;
  const Hi = img.naturalHeight;
  if (!Wi || !Hi || !Wc || !Hc) return;
  const s = Math.min(Wc / Wi, Hc / Hi);
  const dw = Math.round(Wi * s);
  const dh = Math.round(Hi * s);
  stage.style.width = dw + 'px';
  stage.style.height = dh + 'px';
  previewView.baseW = dw;
  previewView.baseH = dh;
  previewView.boxes = boxes || [];
  drawPreviewOverlay();
}

/* ============ CSV 导出 ============ */
function exportQueryCsv() {
  if (!state.queryResults.length) return toast('没有可导出的结果');
  const rows = [['图片', '框坐标', '缺失子属性', '状态', '质检员', '提交身份']];
  state.queryResults.forEach(r => {
    rows.push([r.image_id, boxesText(r), violationsText(r), statusText(r.qc_status),
      r.qc_owner || '', submitIdentityText(r)]);
  });
  const csv = '\uFEFF' + rows.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '标签巡检结果.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ============ 事件绑定 ============ */
$('projectSel').onchange = onProjectChange;
$('refreshBtn').onclick = () => { loadProjects(); loadMonitoring(); };
$('monitorRefreshBtn').onclick = () => loadMonitoring(true);
$('searchBtn').onclick = doSearch;
$('searchInput').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
$('searchSelectAll').onchange = e => {
  document.querySelectorAll('#searchTable .rowCheck').forEach(c => { c.checked = e.target.checked; });
  updateSearchCount();
};
$('searchBatchRejectBtn').onclick = () => batchQc('#searchTable', 'reject', doSearch);
$('searchBatchPassBtn').onclick = () => batchQc('#searchTable', 'pass', doSearch);
$('queryBtn').onclick = doQuery;
$('ruleAddBtn').onclick = () => { state.rules.push({ parent: '', children: [] }); renderRules(); };
$('ruleClearBtn').onclick = () => { state.rules = []; renderRules(); };
$('labelPickerField').onclick = e => { e.stopPropagation(); $('labelPickerDropdown').classList.toggle('hidden'); };
document.addEventListener('click', e => {
  if (!$('labelPicker').contains(e.target)) $('labelPickerDropdown').classList.add('hidden');
  document.querySelectorAll('.cat-picker-dropdown').forEach(dd => {
    if (!dd.parentElement.contains(e.target)) dd.classList.add('hidden');
  });
});
$('queryStatus').onchange = () => renderQuery(state.queryResults);
$('queryOwner').onchange = () => renderQuery(state.queryResults);
$('queryExportBtn').onclick = exportQueryCsv;
$('querySelectAll').onchange = e => {
  document.querySelectorAll('#queryTable .rowCheck').forEach(c => { c.checked = e.target.checked; });
  updateQueryCount();
};
$('batchRejectBtn').onclick = () => batchQc('#queryTable', 'reject', () => { if (state.queryResults.length) doQuery(); });
$('batchPassBtn').onclick = () => batchQc('#queryTable', 'pass', () => { if (state.queryResults.length) doQuery(); });
$('fixBtn').onclick = doFix;
$('previewClose').onclick = closePreview;
$('previewModal').onclick = e => { if (e.target === $('previewModal')) closePreview(); };
// 预览图片缩放 / 拖动
$('previewImageWrap').addEventListener('wheel', onPreviewWheel, { passive: false });
$('previewImageWrap').addEventListener('mousedown', onPreviewMouseDown);
$('previewImageWrap').addEventListener('dblclick', resetPreviewView);
window.addEventListener('mousemove', onPreviewMouseMove);
window.addEventListener('mouseup', onPreviewMouseUp);

/* ============ 启动 ============ */
(async function boot() {
  let me = await api('/api/me');
  if (me && me.user) {
    state.user = me.user;
  } else {
    // 未登录则自动登录（于荣华）
    const r = await api('/api/autologin');
    if (r && r.ok) state.user = r.user;
  }
  $('projectBar').classList.remove('hidden');
  await loadProjects();
  renderRules();
  startProjectAuto();   // 每 60s 静默刷新项目列表（新项目不用刷页面就能出现）
})();
