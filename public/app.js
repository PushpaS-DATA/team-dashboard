/* ── State ─────────────────────────────────────────────────────────────── */
let currentUser = null;
let allUsers = [];
let goalsFilter = 'all';
let highlightsFilter = 'all';

/* ── Helpers ────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const api = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Server error (${res.status})`); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
};

function fmtDate(str) {
  if (!str) return '';
  return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtMonth(str) {
  if (!str) return '';
  const [y, m] = str.split('-');
  return new Date(y, m - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function isOverdue(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr) < new Date();
}
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function timeAgo(str) {
  const diff = Date.now() - new Date(str).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
function highlightIcon(type) {
  return { employee_month: '🏆', activity_month: '🎯', shoutout: '👏' }[type] || '⭐';
}
function highlightLabel(type) {
  return { employee_month: 'Employee of the Month', activity_month: 'Activity of the Month', shoutout: 'Shoutout' }[type] || type;
}
function statusLabel(s) {
  return { not_started: 'Not Started', in_progress: 'In Progress', completed: 'Completed' }[s] || s;
}

/* ── Navigation ─────────────────────────────────────────────────────────── */
function showPage(name) {
  ['dashboard', 'goals', 'highlights', 'team', 'mygoals', 'teamrating'].forEach(p => {
    $(`${p}-section`).classList.toggle('hidden', p !== name);
  });
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.page === name);
  });
  if (name === 'dashboard') loadDashboard();
  if (name === 'goals') loadGoals();
  if (name === 'highlights') loadHighlights();
  if (name === 'team') loadTeam();
  if (name === 'mygoals') loadMyGoals();
  if (name === 'teamrating') loadTeamRating();
}

document.querySelectorAll('[data-page]').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); showPage(el.dataset.page); });
});

// Event delegation for dynamically-injected data-page links
document.addEventListener('click', e => {
  const el = e.target.closest('[data-page]');
  if (el && !el.classList.contains('nav-link') && !el.closest('.nav-links')) {
    e.preventDefault();
    showPage(el.dataset.page);
  }
});

/* ── Auth ───────────────────────────────────────────────────────────────── */
function switchAuthTab(tab) {
  $('login-form').classList.toggle('hidden', tab !== 'signin');
  $('signup-form').classList.toggle('hidden', tab !== 'signup');
  $('tab-signin').classList.toggle('active', tab === 'signin');
  $('tab-signup').classList.toggle('active', tab === 'signup');
}

$('signup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('signup-error');
  err.classList.add('hidden');
  const password = $('signup-password').value;
  const confirm = $('signup-confirm').value;
  const email = $('signup-email').value.trim().toLowerCase();
  if (!email.endsWith('@penguin-international.com')) {
    err.textContent = 'Only @penguin-international.com email addresses are allowed';
    err.classList.remove('hidden');
    return;
  }
  if (password !== confirm) {
    err.textContent = 'Passwords do not match';
    err.classList.remove('hidden');
    return;
  }
  try {
    const user = await api('POST', '/api/auth/register', {
      name: $('signup-name').value,
      email,
      password,
      role: 'employee',
    });
    await onLogin(user);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('login-error');
  err.classList.add('hidden');
  try {
    const user = await api('POST', '/api/auth/login', {
      email: $('login-email').value,
      password: $('login-password').value
    });
    await onLogin(user);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  currentUser = null;
  $('app-page').classList.add('hidden');
  $('login-page').classList.remove('hidden');
});

async function onLogin(user) {
  currentUser = user;
  $('nav-avatar').textContent = user.avatar_initials || user.name[0];
  $('nav-name').textContent = user.name;
  $('nav-role').textContent = user.is_admin ? 'Admin' : user.role === 'manager' ? 'Manager' : 'Employee';
  if (user.is_admin) $('nav-role').style.background = '#7c3aed';

  allUsers = await api('GET', '/api/users');

  if (user.role === 'manager' || user.is_admin) {
    document.querySelectorAll('.manager-only').forEach(el => el.classList.remove('hidden'));
    // these buttons only show on their respective tabs
    $('new-announce-btn').style.display = 'none';
    $('new-poll-btn').style.display = 'none';
  }
  if (user.is_admin) {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  }

  // reset nav visibility first (handles switching accounts)
  const teamNavItem = document.querySelector('[data-page="team"]')?.closest('li');
  const goalsNavItem = document.querySelector('[data-page="goals"]')?.closest('li');
  if (teamNavItem) teamNavItem.classList.remove('hidden');
  if (goalsNavItem) goalsNavItem.classList.remove('hidden');

  // set rating nav label per role
  const ratingLabel = $('nav-rating-label');
  if (ratingLabel) ratingLabel.textContent = (user.role === 'employee' && !user.is_admin) ? 'My Rating' : 'Team Rating';

  // employees: hide Team + Goals nav (they only need My Goals), make sidebar clickable for own profile
  if (user.role === 'employee') {
    if (teamNavItem) teamNavItem.classList.add('hidden');
    if (goalsNavItem) goalsNavItem.classList.add('hidden');
    $('nav-name').style.cursor = 'pointer';
    $('nav-name').title = 'View my profile';
    $('nav-avatar').style.cursor = 'pointer';
    $('nav-avatar').title = 'View my profile';
    $('nav-name').onclick = () => openProfile(user.id);
    $('nav-avatar').onclick = () => openProfile(user.id);
  }

  $('login-page').classList.add('hidden');
  $('app-page').classList.remove('hidden');
  showPage('dashboard');
}

/* ── Dashboard ──────────────────────────────────────────────────────────── */
async function loadDashboard() {
  if (currentUser.role === 'employee') {
    await loadEmployeeDashboard();
  } else {
    await loadManagerDashboard();
  }
}

async function loadEmployeeDashboard() {
  const [goals, highlights, announcements, latestEvals, polls] = await Promise.all([
    api('GET', '/api/goals'),
    api('GET', '/api/highlights'),
    api('GET', '/api/announcements').catch(() => []),
    api('GET', `/api/evaluations/${currentUser.id}`).catch(() => []),
    api('GET', '/api/polls').catch(() => []),
  ]);

  const now = new Date();
  const total = goals.length;
  const done = goals.filter(g => g.status === 'completed').length;
  const inProgress = goals.filter(g => g.status === 'in_progress').length;
  const avgP = total ? Math.round(goals.reduce((s, g) => s + g.progress, 0) / total) : 0;
  const overdue = goals.filter(g => g.due_date && g.status !== 'completed' && new Date(g.due_date) < now);
  const upcoming = goals.filter(g => g.due_date && g.status !== 'completed' && new Date(g.due_date) >= now)
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  const myHighlights = highlights.filter(h => h.employee_id === currentUser.id);
  const firstName = currentUser.name.split(' ')[0];
  const nextDue = upcoming[0] ? fmtDate(upcoming[0].due_date) : '—';
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const latestEval = latestEvals[0] || null;
  const netC = v => v >= 8.5 ? '#059669' : v >= 7 ? '#d97706' : v >= 5 ? '#dc2626' : '#9ca3af';
  const netBg = v => v >= 8.5 ? '#d1fae5' : v >= 7 ? '#fef3c7' : v >= 5 ? '#fee2e2' : '#f3f4f6';
  const netLbl = v => v >= 8.5 ? 'Excellent' : v >= 7 ? 'Good' : v >= 5 ? 'Needs Improvement' : '—';

  const announcementTicker = announcements.length ? `
    <div class="ann-ticker">
      <span class="ann-label">📢 Announcements</span>
      <div class="ann-track-wrap">
        <div class="ann-track">
          ${[...announcements, ...announcements].map(a =>
            `<span class="ann-item"><strong>${a.title}</strong> — ${a.message}</span>`
          ).join('<span class="ann-sep">·</span>')}
        </div>
      </div>
    </div>` : '';

  $('dashboard-root').innerHTML = `
    ${announcementTicker}
    <div class="ca-hero">
      <div class="ca-top">
        <div>
          <div class="ca-greeting">${greeting}, ${firstName} 👋</div>
          <div class="ca-date">${now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</div>
        </div>
        <a href="#" data-page="mygoals" class="ca-view-all">View all goals →</a>
      </div>
      <div class="ca-pills">
        <div class="ca-pill"><div class="ca-pv">${total}</div><div class="ca-pl">My Goals</div></div>
        <div class="ca-pill"><div class="ca-pv">${avgP}%</div><div class="ca-pl">Avg Progress</div></div>
        <div class="ca-pill"><div class="ca-pv">${done}</div><div class="ca-pl">Completed</div></div>
        <div class="ca-pill"><div class="ca-pv">${inProgress}</div><div class="ca-pl">In Progress</div></div>
        <div class="ca-pill ${overdue.length ? 'ca-pill-red' : ''}"><div class="ca-pv">${overdue.length}</div><div class="ca-pl">Overdue</div></div>
        <div class="ca-pill"><div class="ca-pv">${nextDue}</div><div class="ca-pl">Next Due</div></div>
      </div>
    </div>

    <div class="ca-body">
      <div class="ca-left">
        <div class="ca-section-title">My Goals</div>
        ${goals.length ? goals.map(g => {
          const od = isOverdue(g.due_date) && g.status !== 'completed';
          return `<div class="ca-goal">
            <div class="ca-goal-top">
              <span class="ca-goal-name">${g.title}</span>
              <span class="ca-goal-pct ${g.progress === 100 ? 'done' : ''}">${g.progress}%</span>
            </div>
            <div class="ca-bar-bg"><div class="ca-bar ${g.progress===100?'ca-bar-done':''}" style="width:${Math.max(g.progress,0)}%"></div></div>
            <div class="ca-goal-meta">
              <span class="badge badge-${g.status}">${statusLabel(g.status)}</span>
              ${g.due_date ? `<span style="font-size:11px;color:${od?'#ef4444':'#8fafa5'};font-weight:${od?'600':'400'}">📅 ${od?'Overdue · ':''}${fmtDate(g.due_date)}</span>` : ''}
            </div>
          </div>`;
        }).join('') : '<div class="empty-state">No goals assigned yet.</div>'}
      </div>

      <div class="ca-right">
        <div class="ca-section-title">Deadlines</div>
        ${overdue.length ? overdue.map(g => `
          <div class="ca-titem">
            <div class="ca-tdot" style="background:#ef4444"></div>
            <div class="ca-ttext"><strong>${g.title}</strong><span style="color:#ef4444">Overdue · ${fmtDate(g.due_date)}</span></div>
          </div>`).join('') : ''}
        ${upcoming.slice(0,5).map(g => {
          const days = Math.ceil((new Date(g.due_date) - now) / 86400000);
          const col = days <= 7 ? '#f59e0b' : '#4a9e7f';
          return `<div class="ca-titem">
            <div class="ca-tdot" style="background:${col}"></div>
            <div class="ca-ttext"><strong>${g.title}</strong><span>${days}d left · ${fmtDate(g.due_date)}</span></div>
          </div>`;
        }).join('')}
        ${!overdue.length && !upcoming.length ? '<div class="empty-state">No upcoming deadlines.</div>' : ''}

        ${myHighlights.length ? `
        <div class="ca-section-title" style="margin-top:20px">My Recognitions</div>
        ${myHighlights.map(h => `
          <div class="ca-titem">
            <div class="ca-tdot" style="background:#f59e0b;font-size:10px">${highlightIcon(h.type)}</div>
            <div class="ca-ttext"><strong>${h.title}</strong><span>${fmtMonth(h.month)}</span></div>
          </div>`).join('')}` : ''}

        ${latestEval ? `
        <div class="ca-section-title" style="margin-top:20px">Latest Rating</div>
        <div style="background:linear-gradient(135deg,#1a3c2e,#2d6a4f);border-radius:14px;padding:18px 20px;color:#fff;margin-top:8px">
          <div style="font-size:.7rem;opacity:.6;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px">${latestEval.period || 'Annual'} ${latestEval.year} · Performance</div>
          <div style="display:flex;align-items:center;gap:14px">
            <div style="text-align:center">
              <div style="font-size:2.4rem;font-weight:800;line-height:1;color:${netC(latestEval.net_rating)}">${latestEval.net_rating ? latestEval.net_rating.toFixed(2) : '—'}</div>
              <div style="font-size:.65rem;opacity:.6;margin-top:3px">out of 10</div>
            </div>
            <div style="flex:1">
              <div style="background:rgba(255,255,255,.15);border-radius:99px;height:8px;overflow:hidden;margin-bottom:8px">
                <div style="width:${latestEval.net_rating ? Math.round((latestEval.net_rating/10)*100) : 0}%;height:100%;background:${netC(latestEval.net_rating)};border-radius:99px"></div>
              </div>
              <div style="display:inline-block;background:${netBg(latestEval.net_rating)};color:${netC(latestEval.net_rating)};font-size:.72rem;font-weight:700;padding:2px 10px;border-radius:99px">${netLbl(latestEval.net_rating)}</div>
            </div>
          </div>
          <div style="margin-top:12px;text-align:right">
            <a href="#" data-page="teamrating" style="font-size:.75rem;opacity:.7;color:#fff;text-decoration:none">View full rating →</a>
          </div>
        </div>` : ''}

        ${(() => {
          const activePolls = (polls || []).filter(p => p.is_active);
          if (!activePolls.length) return '';
          const MOODS = ['😊','😐','😟'];
          const MOOD_LABEL = {'😊':'Happy','😐':'Neutral','😟':'Unhappy'};
          return `<div class="ca-section-title" style="margin-top:20px">🎯 Team Mood</div>
          ${activePolls.map(p => `
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px;margin-top:8px">
              <div style="font-size:.85rem;font-weight:600;margin-bottom:10px">${p.question}</div>
              <div style="display:flex;gap:8px">
                ${MOODS.map(m => `
                  <button onclick="empSubmitMoodVote(${p.id},'${m}')"
                    style="flex:1;padding:10px 4px;border-radius:10px;border:2px solid ${p.my_response===m?'var(--primary)':'var(--border)'};background:${p.my_response===m?'var(--primary-light, #e8f4ef)':'var(--bg)'};cursor:pointer;font-size:1.4rem;display:flex;flex-direction:column;align-items:center;gap:3px;transition:all .15s">
                    <span>${m}</span>
                    <span style="font-size:.6rem;color:var(--text-muted);font-weight:600">${MOOD_LABEL[m]}</span>
                  </button>`).join('')}
              </div>
              ${p.my_response ? `<div style="font-size:.72rem;color:var(--text-muted);margin-top:8px;text-align:center">You voted ${p.my_response} — tap another to change</div>` : ''}
            </div>`).join('')}`;
        })()}
      </div>
    </div>
  `;
}

async function empSubmitMoodVote(pollId, response) {
  try {
    await api('POST', `/api/polls/${pollId}/respond`, { response });
    await loadEmployeeDashboard();
  } catch(e) { alert(e.message); }
}

async function loadManagerDashboard() {
  const [stats, goals, highlights, members, skillsSummary, announcements, polls, activity] = await Promise.all([
    api('GET', '/api/stats'),
    api('GET', '/api/goals'),
    api('GET', '/api/highlights'),
    api('GET', '/api/members'),
    api('GET', '/api/skills/summary').catch(() => null),
    api('GET', '/api/announcements/all').catch(() => []),
    api('GET', '/api/polls').catch(() => []),
    api('GET', '/api/activity?limit=12').catch(() => []),
  ]);

  const now = new Date();
  const mon = currentMonth();
  const teamGoals = goals.filter(g => g.type === 'team');
  const indGoals = goals.filter(g => g.type === 'individual');
  const overdueAll = goals.filter(g => g.due_date && g.status !== 'completed' && new Date(g.due_date) < now);
  const monHighlights = highlights.filter(h => h.month === mon);
  const avgP = stats.teamAvgProgress || 0;
  const circumference = 2 * Math.PI * 32;
  const offset = circumference - (avgP / 100) * circumference;

  const activAnn = announcements.filter(a => a.is_active);
  const mgrTicker = activAnn.length ? `
    <div class="ann-ticker" style="margin-bottom:22px">
      <span class="ann-label">📢 Announcements</span>
      <div class="ann-track-wrap">
        <div class="ann-track">
          ${[...activAnn, ...activAnn].map(a =>
            `<span class="ann-item"><strong>${a.title}</strong> — ${a.message}</span>`
          ).join('<span class="ann-sep">·</span>')}
        </div>
      </div>
    </div>` : '';

  $('dashboard-root').innerHTML = `
    ${mgrTicker}
    <div class="cb-wrap">

      <!-- Greeting -->
      <div class="cb-tile cb-accent" style="grid-column:span 1">
        <div class="cb-tile-label">Welcome</div>
        <div class="cb-big-name">${currentUser.name.split(' ')[0]} 👋</div>
        <div class="cb-tile-sub">${now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}</div>
      </div>

      <!-- Team progress ring -->
      <div class="cb-tile" style="grid-column:span 1">
        <div class="cb-tile-label">Team Progress</div>
        <div class="cb-ring-wrap">
          <div class="cb-ring">
            <svg width="80" height="80" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r="32" fill="none" stroke="#e8f4ef" stroke-width="8"/>
              <circle cx="40" cy="40" r="32" fill="none" stroke="#4a9e7f" stroke-width="8"
                stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
                stroke-linecap="round" transform="rotate(-90 40 40)"/>
            </svg>
            <div class="cb-ring-pct">${avgP}%</div>
          </div>
          <div>
            <div class="cb-ring-stat">${stats.teamGoals} goals</div>
            <div class="cb-ring-sub">${stats.teamCompleted} completed</div>
            ${overdueAll.length ? `<div class="cb-ring-sub" style="color:#ef4444;margin-top:2px">⚠️ ${overdueAll.length} overdue</div>` : ''}
          </div>
        </div>
      </div>

      <!-- Quick stats -->
      <div class="cb-tile cb-blue" style="grid-column:span 1">
        <div class="cb-tile-label">Members</div>
        <div class="cb-big-num">${members.length}</div>
        <div class="cb-tile-sub">${members.filter(m=>m.role==='employee').length} employees · ${members.filter(m=>m.role==='manager').length} managers</div>
      </div>

      <!-- Team goals (wide) -->
      <div class="cb-tile" style="grid-column:span 2">
        <div class="cb-tile-header">
          <div class="cb-tile-label">Team Goals</div>
          <a href="#" data-page="goals" class="link-sm">View all</a>
        </div>
        ${teamGoals.slice(0,4).map(g => `
          <div class="cb-goal-item">
            <div class="cb-check ${g.status==='completed'?'cb-check-done':g.status==='in_progress'?'cb-check-ip':''}">
              ${g.status==='completed'?'✓':''}
            </div>
            <span class="cb-goal-name ${g.status==='completed'?'cb-done-text':''}">${g.title}</span>
            <div class="cb-goal-right">
              <div class="cb-mini-bar"><div class="cb-mini-fill" style="width:${g.progress}%"></div></div>
              <span class="cb-goal-pct">${g.progress}%</span>
            </div>
          </div>`).join('') || '<div class="empty-state">No team goals yet.</div>'}
      </div>

      <!-- Highlights this month -->
      <div class="cb-tile cb-accent" style="grid-column:span 1">
        <div class="cb-tile-label">This Month's Highlights</div>
        ${monHighlights.slice(0,3).map(h => `
          <div class="cb-hl-item">
            <span>${highlightIcon(h.type)}</span>
            <span class="cb-hl-name">${h.title}</span>
          </div>`).join('') || '<div style="font-size:12px;opacity:.6;margin-top:8px">No highlights yet.</div>'}
        <a href="#" data-page="highlights" class="cb-tile-link">View all →</a>
      </div>

      <!-- Individual goals by person -->
      <div class="cb-tile" style="grid-column:span 2">
        <div class="cb-tile-header">
          <div class="cb-tile-label">Individual Goals by Member</div>
          <a href="#" data-page="goals" class="link-sm">View all</a>
        </div>
        ${members.filter(m=>m.role==='employee'&&m.goal_total>0).slice(0,5).map(m => `
          <div class="cb-member-row">
            <div class="avatar" style="width:28px;height:28px;font-size:10px;flex-shrink:0">${m.avatar_initials||m.name[0]}</div>
            <span class="cb-member-name">${m.name}</span>
            <div class="cb-mini-bar" style="width:100px"><div class="cb-mini-fill" style="width:${m.goal_avg_progress}%"></div></div>
            <span class="cb-goal-pct">${m.goal_avg_progress}%</span>
            <span class="cb-member-goals">${m.goal_done}/${m.goal_total}</span>
          </div>`).join('') || '<div class="empty-state">No individual goals assigned.</div>'}
      </div>

      <!-- Team Skills Summary -->
      <div class="cb-tile" style="grid-column:span 3">
        <div class="cb-tile-header">
          <div class="cb-tile-label">🛠 Team Skills Overview</div>
          <a href="#" onclick="event.preventDefault();window.location.href='/api/skills/export'" class="link-sm">↓ Export</a>
        </div>
        ${skillsSummary && skillsSummary.topSkills.length ? `
          <div class="skills-stats-row">
            <div class="skills-stat"><span class="skills-stat-val">${skillsSummary.totalUnique}</span><span class="skills-stat-lbl">Unique Skills</span></div>
            <div class="skills-stat"><span class="skills-stat-val">${skillsSummary.withSkills}</span><span class="skills-stat-lbl">Members with Skills</span></div>
            ${skillsSummary.noSkills > 0 ? `<div class="skills-stat"><span class="skills-stat-val" style="color:var(--warning)">${skillsSummary.noSkills}</span><span class="skills-stat-lbl">No Skills Added</span></div>` : ''}
          </div>
          <div class="skills-cloud">
            ${skillsSummary.topSkills.map(s => {
              const maxCount = skillsSummary.topSkills[0].count;
              const size = s.count === maxCount ? 'lg' : s.count >= maxCount * 0.6 ? 'md' : 'sm';
              return `<span class="skill-cloud-tag skill-cloud-${size}" title="${s.count} member${s.count>1?'s':''}">${s.skill} <sup>${s.count}</sup></span>`;
            }).join('')}
          </div>
        ` : `<div style="color:var(--text-muted);font-size:13px;padding:16px 0">No skills added yet. Open a member profile → 🛠 Skills to add.</div>`}
      </div>

    </div>

    <!-- Bottom row: Team Mood + Recent Activity -->
    <div class="dash-bottom-row">

      <!-- Team Mood -->
      <div class="dash-card dash-mood-card">
        <div class="dash-card-header">
          <span class="dash-card-title">🎯 Team Mood</span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary" style="font-size:12px;padding:5px 12px" onclick="showPage('highlights');setTimeout(()=>document.querySelector('[data-hfilter=\\'mood\\']')?.click(),300)">View all</button>
            <button class="btn btn-primary" style="font-size:12px;padding:5px 12px" onclick="document.getElementById('new-poll-btn').click();showPage('highlights');setTimeout(()=>document.querySelector('[data-hfilter=\\'mood\\']')?.click(),100)">+ New Poll</button>
          </div>
        </div>
        ${(() => {
          const MOODS = ['😊','😐','😟'];
          const MOOD_LABEL = {'😊':'Happy','😐':'Neutral','😟':'Unhappy'};
          const MOOD_COLOR = {'😊':'#059669','😐':'#d97706','😟':'#dc2626'};
          const activePolls = polls.filter(p => p.is_active);
          if (!activePolls.length) return `<div style="color:var(--text-muted);font-size:13px;padding:20px 0;text-align:center">No active polls. Click "+ New Poll" to check in with your team.</div>`;
          return activePolls.slice(0,2).map(p => {
            const total = p.response_count || 0;
            const counts = (p.results||[]).reduce((o,r)=>{o[r.response]=r.n;return o},{});
            return `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border)">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                <div style="font-weight:600;font-size:.88rem">${p.question}</div>
                <button onclick="dashDeletePoll(${p.id})" title="Delete poll" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:1rem;padding:2px 4px;border-radius:4px;line-height:1" onmouseover="this.style.color='#dc2626'" onmouseout="this.style.color='var(--text-muted)'">🗑</button>
              </div>
              ${MOODS.map(m => {
                const n = counts[m]||0;
                const pct = total ? Math.round((n/total)*100) : 0;
                return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                  <span style="font-size:1rem;width:22px;text-align:center">${m}</span>
                  <span style="font-size:.75rem;min-width:52px;color:var(--text-muted)">${MOOD_LABEL[m]}</span>
                  <div style="flex:1;height:7px;background:var(--bg);border-radius:99px;overflow:hidden">
                    <div style="width:${pct}%;height:100%;background:${MOOD_COLOR[m]};border-radius:99px"></div>
                  </div>
                  <span style="font-size:.78rem;font-weight:700;min-width:18px;color:${MOOD_COLOR[m]}">${n}</span>
                </div>`;
              }).join('')}
              <div style="font-size:.7rem;color:var(--text-muted);margin-top:4px">${total} response${total!==1?'s':''}</div>
            </div>`;
          }).join('');
        })()}
      </div>

      <!-- Recent Activity -->
      <div class="dash-card dash-activity-card">
        <div class="dash-card-header">
          <span class="dash-card-title">⚡ Recent Activity</span>
          <button class="btn btn-secondary" style="font-size:12px;padding:5px 12px" onclick="showPage('highlights');setTimeout(()=>document.querySelector('[data-hfilter=\\'activity\\']')?.click(),300)">View all</button>
        </div>
        ${(() => {
          if (!activity.length) return `<div style="color:var(--text-muted);font-size:13px;padding:20px 0;text-align:center">No recent activity yet.</div>`;
          const typeIcon  = t => ({goal_completed:'✅',goal_updated:'✏️',goal_created:'🎯',rating_added:'⭐'}[t]||'📌');
          const typeLabel = t => ({goal_completed:'completed',goal_updated:'updated',goal_created:'created',rating_added:'got rated'}[t]||t);
          const typeColor = t => t==='goal_completed'?'#059669':t==='rating_added'?'#7c3aed':'#2563eb';
          return activity.slice(0,8).map(r => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
              <span style="width:8px;height:8px;border-radius:50%;background:${typeColor(r.type)};flex-shrink:0;display:inline-block"></span>
              <span style="font-size:.82rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                <strong>${r.actor.split(' ')[0]}</strong>
                <span style="color:var(--text-muted)"> ${typeLabel(r.type)} </span>
                <em>"${r.subject}"</em>
              </span>
              <span style="font-size:1rem;flex-shrink:0">${typeIcon(r.type)}</span>
            </div>`).join('');
        })()}
      </div>

    </div>

    <div style="display:none">

    </div>
  `;
}

async function openNewAnnouncement() {
  $('modal-title').textContent = '📢 New Announcement';
  $('modal-body').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px">Title</label>
        <input id="ann-title" type="text" placeholder="e.g. Holiday Schedule" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box" />
      </div>
      <div>
        <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px">Message</label>
        <textarea id="ann-msg" placeholder="Type your announcement..." rows="3" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;resize:vertical;box-sizing:border-box"></textarea>
      </div>
    </div>
    <div class="modal-actions" style="margin-top:16px">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitAnnouncement()">Post Announcement</button>
    </div>
  `;
  openModal();
}

async function submitAnnouncement() {
  const title = $('ann-title').value.trim();
  const message = $('ann-msg').value.trim();
  if (!title || !message) return alert('Please fill in both fields.');
  try {
    await api('POST', '/api/announcements', { title, message });
    closeModal();
    if (highlightsFilter === 'announcements') await loadHighlightsAnnouncements();
    else loadDashboard();
  } catch (ex) { alert(ex.message); }
}

async function toggleAnnouncement(id, btn) {
  try {
    await api('PATCH', `/api/announcements/${id}/toggle`);
    if (highlightsFilter === 'announcements') await loadHighlightsAnnouncements();
    else loadDashboard();
  } catch (ex) { alert(ex.message); }
}

async function deleteAnnouncement(id, btn) {
  if (!confirm('Delete this announcement?')) return;
  try {
    await api('DELETE', `/api/announcements/${id}`);
    if (highlightsFilter === 'announcements') await loadHighlightsAnnouncements();
    else loadDashboard();
  } catch (ex) { alert(ex.message); }
}

/* ── Goals ──────────────────────────────────────────────────────────────── */
let cachedGoals = [];

async function loadGoals() {
  cachedGoals = await api('GET', '/api/goals');
  renderGoals();
}

// live search
document.addEventListener('input', e => {
  if (e.target.id === 'goals-search') renderGoals();
  if (e.target.id === 'team-search') renderTeam();
});

function renderGoals() {
  const f = goalsFilter;
  const q = ($('goals-search')?.value || '').toLowerCase().trim();

  const filtered = cachedGoals.filter(g => {
    const matchFilter =
      f === 'all' ? true :
      f === 'team' ? g.type === 'team' :
      f === 'individual' ? g.type === 'individual' :
      f === 'in_progress' ? g.status === 'in_progress' :
      f === 'completed' ? g.status === 'completed' : true;
    const matchSearch = !q ||
      (g.assigned_name || '').toLowerCase().includes(q) ||
      g.title.toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });

  if (!filtered.length) {
    $('goals-list').innerHTML = '<div class="empty-state" style="padding:40px">No goals found.</div>';
    return;
  }

  // group: team goals first, then by person
  const teamGoals = filtered.filter(g => g.type === 'team');
  const individualGoals = filtered.filter(g => g.type === 'individual');

  // group individual goals by assigned person
  const byPerson = {};
  for (const g of individualGoals) {
    const key = g.assigned_to || '__unassigned__';
    if (!byPerson[key]) byPerson[key] = { name: g.assigned_name || 'Unassigned', initials: g.avatar_initials || '?', goals: [] };
    byPerson[key].goals.push(g);
  }

  let html = '';

  // Team goals group
  if (teamGoals.length) {
    html += `<div class="goal-group">
      <div class="goal-group-header">
        <div class="goal-group-avatar" style="background:var(--primary)">🎯</div>
        <div class="goal-group-info">
          <span class="goal-group-name">Team Goals</span>
          <span class="goal-group-sub">${teamGoals.length} goal${teamGoals.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <div class="goal-group-rows">
        ${teamGoals.map(g => goalRow(g)).join('')}
      </div>
    </div>`;
  }

  // Individual goals grouped by person
  for (const [, person] of Object.entries(byPerson)) {
    const done = person.goals.filter(g => g.status === 'completed').length;
    const avgP = Math.round(person.goals.reduce((s, g) => s + g.progress, 0) / person.goals.length);
    html += `<div class="goal-group">
      <div class="goal-group-header">
        <div class="goal-group-avatar">${person.initials}</div>
        <div class="goal-group-info">
          <span class="goal-group-name">${person.name}</span>
          <span class="goal-group-sub">${person.goals.length} goal${person.goals.length !== 1 ? 's' : ''} · ${done} completed · ${avgP}% avg</span>
        </div>
      </div>
      <div class="goal-group-rows">
        ${person.goals.map(g => goalRow(g)).join('')}
      </div>
    </div>`;
  }

  $('goals-list').innerHTML = html;
}

function goalRow(g) {
  const isManager = currentUser.role === 'manager';
  const isAssignee = g.assigned_to === currentUser.id;
  const canEdit = isManager || isAssignee;
  const overdue = isOverdue(g.due_date) && g.status !== 'completed';
  return `
    <div class="goal-row-item">
      <div class="goal-row-main">
        <div class="goal-row-title">${g.title}</div>
        ${g.description ? `<div class="goal-row-desc">${g.description}</div>` : ''}
        <div class="goal-row-meta">
          <span class="badge badge-${g.status}">${statusLabel(g.status)}</span>
          ${g.due_date ? `<span class="goal-due ${overdue ? 'overdue' : ''}">📅 ${overdue ? 'Overdue · ' : ''}${fmtDate(g.due_date)}</span>` : ''}
        </div>
      </div>
      <div class="goal-row-progress">
        <div class="progress-bar-bg"><div class="progress-bar ${g.progress === 100 ? 'green' : ''}" style="width:${g.progress}%"></div></div>
        <span class="mt-pct">${g.progress}%</span>
      </div>
      <div class="goal-actions">
        <button class="btn btn-secondary btn-sm comment-btn" onclick="openCommentsModal(${g.id}, ${JSON.stringify(g.title).replace(/'/g, "&#39;")})">
          💬 ${g.comment_count || 0}
        </button>
        ${canEdit ? `<button class="btn btn-secondary btn-sm" onclick="openEditGoal(${g.id})">Edit</button>` : ''}
        ${canEdit ? `<button class="btn-icon" onclick="deleteGoal(${g.id})" title="Delete"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#ef4444"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>` : ''}
      </div>
    </div>
  `;
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn[data-filter]');
  if (btn) {
    document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    goalsFilter = btn.dataset.filter;
    renderGoals();
  }

});

$('new-goal-btn').addEventListener('click', () => openGoalModal());

$('upload-goals-btn').addEventListener('click', openUploadGoals);

function openUploadGoals() {
  $('modal-title').textContent = 'Upload Goals';
  $('modal-body').innerHTML = `
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
      Upload a CSV file with multiple goals at once.
    </p>

    <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px;font-size:12px;color:var(--text-muted)">
      <div style="font-weight:600;color:var(--text);margin-bottom:6px">Required CSV columns:</div>
      <code style="font-size:11px">title, type, description, assigned_email, status, progress, due_date</code>
      <div style="margin-top:8px">
        <b>type:</b> team / individual &nbsp;|&nbsp;
        <b>status:</b> not_started / in_progress / completed<br/>
        <b>assigned_email:</b> only needed for individual goals<br/>
        <b>due_date:</b> YYYY-MM-DD format
      </div>
    </div>

    <div style="margin-bottom:16px">
      <button class="btn btn-secondary btn-sm" onclick="downloadCsvTemplate()">↓ Download Template</button>
    </div>

    <div class="form-group">
      <label>Choose CSV File</label>
      <input type="file" id="csv-file-input" accept=".csv" style="padding:6px" />
    </div>

    <div id="csv-preview" class="hidden" style="margin-top:12px"></div>

    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button id="csv-upload-btn" class="btn btn-primary hidden" onclick="submitBulkGoals()">Upload Goals</button>
    </div>
  `;

  $('csv-file-input').addEventListener('change', previewCsv);
  openModal();
}

function downloadCsvTemplate() {
  const rows = [
    ['title','type','description','assigned_email','status','progress','due_date'],
    ['Launch new feature','team','Ship the redesigned dashboard','','in_progress','40','2026-06-30'],
    ['Complete certification','individual','AWS Solutions Architect exam','bob@company.com','in_progress','60','2026-05-31'],
    ['Write Q2 report','individual','Summary of Q2 results','carol@company.com','not_started','0','2026-07-15'],
  ];
  const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'goals_template.csv';
  a.click();
}

let parsedGoals = [];

function previewCsv(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const lines = ev.target.result.trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      $('csv-preview').innerHTML = '<div class="error-msg">File is empty or has no data rows.</div>';
      $('csv-preview').classList.remove('hidden');
      return;
    }

    const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
    const required = ['title', 'type'];
    const missing = required.filter(r => !headers.includes(r));
    if (missing.length) {
      $('csv-preview').innerHTML = `<div class="error-msg">Missing required columns: ${missing.join(', ')}</div>`;
      $('csv-preview').classList.remove('hidden');
      return;
    }

    parsedGoals = [];
    const errors = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map(v => v.replace(/^"|"$/g, '').trim());
      const row = {};
      headers.forEach((h, idx) => row[h] = vals[idx] || '');
      if (!row.title) { errors.push(`Row ${i}: title is empty`); continue; }
      if (!['team','individual'].includes(row.type)) { errors.push(`Row ${i}: type must be "team" or "individual"`); continue; }
      parsedGoals.push(row);
    }

    let html = `<div style="font-size:13px;font-weight:600;margin-bottom:8px">
      Preview: ${parsedGoals.length} goal${parsedGoals.length !== 1 ? 's' : ''} ready to import
      ${errors.length ? `<span style="color:var(--danger);margin-left:8px">(${errors.length} row${errors.length>1?'s':''} skipped)</span>` : ''}
    </div>`;

    if (errors.length) {
      html += `<div class="error-msg" style="margin-bottom:10px;font-size:12px">${errors.join('<br/>')}</div>`;
    }

    if (parsedGoals.length) {
      html += `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:var(--bg)">
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border)">Title</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border)">Type</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border)">Assigned To</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border)">Status</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border)">Due</th>
        </tr></thead><tbody>
        ${parsedGoals.map(g => `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:6px 8px">${g.title}</td>
          <td style="padding:6px 8px"><span class="badge badge-${g.type}">${g.type}</span></td>
          <td style="padding:6px 8px">${g.assigned_email || '—'}</td>
          <td style="padding:6px 8px">${g.status || 'not_started'}</td>
          <td style="padding:6px 8px">${g.due_date || '—'}</td>
        </tr>`).join('')}
        </tbody></table></div>`;
    }

    $('csv-preview').innerHTML = html;
    $('csv-preview').classList.remove('hidden');
    $('csv-upload-btn').classList.toggle('hidden', parsedGoals.length === 0);
  };
  reader.readAsText(file);
}

async function submitBulkGoals() {
  if (!parsedGoals.length) return;
  try {
    const result = await api('POST', '/api/goals/bulk', { goals: parsedGoals });
    closeModal();
    await loadGoals();
    const msg = `${result.inserted} goal${result.inserted !== 1 ? 's' : ''} uploaded successfully!` +
      (result.errors.length ? `\n\nSkipped:\n${result.errors.join('\n')}` : '');
    alert(msg);
  } catch (ex) { alert(ex.message); }
}

function openGoalModal(goal = null) {
  const employees = allUsers.filter(u => u.role === 'employee');
  const employeeOpts = employees.map(u => `<option value="${u.id}">${u.name}</option>`).join('');

  if (goal) {
    // edit mode — single goal form
    const isEmp = currentUser.role === 'employee';
    $('modal-title').textContent = 'Edit Goal';
    $('modal-body').innerHTML = `
      <form id="goal-form">
        <div class="form-group">
          <label>Title *</label>
          <input name="title" value="${goal.title}" placeholder="Goal title" required />
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea name="description" placeholder="What does success look like?">${goal.description || ''}</textarea>
        </div>
        ${!isEmp ? `
        <div class="form-row">
          <div class="form-group">
            <label>Type *</label>
            <select name="type" id="goal-type-sel">
              <option value="team" ${goal.type === 'team' ? 'selected' : ''}>Team</option>
              <option value="individual" ${goal.type === 'individual' ? 'selected' : ''}>Individual</option>
            </select>
          </div>
          <div class="form-group" id="assignee-group" style="${goal.type !== 'individual' ? 'display:none' : ''}">
            <label>Assign to</label>
            <select name="assigned_to">
              <option value="">— Select employee —</option>
              ${employees.map(u => `<option value="${u.id}" ${goal.assigned_to == u.id ? 'selected' : ''}>${u.name}</option>`).join('')}
            </select>
          </div>
        </div>` : ''}
        <div class="form-row">
          <div class="form-group">
            <label>Status</label>
            <select name="status">
              <option value="not_started" ${goal.status === 'not_started' ? 'selected' : ''}>Not Started</option>
              <option value="in_progress" ${goal.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
              <option value="completed" ${goal.status === 'completed' ? 'selected' : ''}>Completed</option>
            </select>
          </div>
          <div class="form-group">
            <label>Due Date</label>
            <input type="date" name="due_date" value="${goal.due_date || ''}" />
          </div>
        </div>
        <div class="form-group">
          <label>Progress: <span id="prog-display">${goal.progress}%</span></label>
          <div class="progress-edit">
            <input type="range" name="progress" min="0" max="100" value="${goal.progress}"
              oninput="$('prog-display').textContent=this.value+'%'" />
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    `;
    document.getElementById('goal-type-sel').addEventListener('change', function() {
      document.getElementById('assignee-group').style.display = this.value === 'individual' ? '' : 'none';
    });
    document.getElementById('goal-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = Object.fromEntries(fd.entries());
      body.progress = parseInt(body.progress);
      if (!body.assigned_to) body.assigned_to = null;
      try {
        await api('PATCH', `/api/goals/${goal.id}`, body);
        closeModal(); loadGoals();
      } catch (ex) { alert(ex.message); }
    });
    openModal();
    return;
  }

  // ── Create mode: multi-goal form ──────────────────────────────────────────
  $('modal-title').textContent = 'New Goal';
  $('modal-body').innerHTML = `
    <form id="goal-form">
      <div class="form-row" style="margin-bottom:16px">
        <div class="form-group" style="margin-bottom:0">
          <label>Type *</label>
          <select id="shared-type">
            <option value="team">Team</option>
            <option value="individual">Individual</option>
          </select>
        </div>
        <div class="form-group" id="shared-assignee-group" style="display:none;margin-bottom:0">
          <label>Assign all to</label>
          <select id="shared-assignee">
            <option value="">— Select person —</option>
            ${employeeOpts}
          </select>
        </div>
      </div>

      <div id="goal-rows"></div>

      <button type="button" class="btn btn-secondary btn-sm" id="add-row-btn" style="margin-bottom:16px">
        + Add Another Goal
      </button>

      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Goals</button>
      </div>
    </form>
  `;

  // show/hide person picker based on type
  document.getElementById('shared-type').addEventListener('change', function() {
    const isInd = this.value === 'individual';
    document.getElementById('shared-assignee-group').style.display = isInd ? '' : 'none';
  });

  // render initial row
  renderGoalRows();

  document.getElementById('add-row-btn').addEventListener('click', () => {
    addGoalRow(); updateRowNumbers();
  });

  document.getElementById('goal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const type = document.getElementById('shared-type').value;
    const assignedTo = type === 'individual' ? (document.getElementById('shared-assignee').value || null) : null;
    const rows = document.querySelectorAll('.goal-row');
    const goals = [];
    for (const row of rows) {
      const title = row.querySelector('[name=title]').value.trim();
      if (!title) continue;
      goals.push({
        title,
        description: row.querySelector('[name=description]').value.trim() || null,
        type,
        assigned_to: assignedTo,
        status: row.querySelector('[name=status]').value,
        due_date: row.querySelector('[name=due_date]').value || null,
        progress: parseInt(row.querySelector('[name=progress]').value) || 0,
      });
    }
    if (!goals.length) return alert('Add at least one goal title.');
    try {
      await api('POST', '/api/goals/bulk', { goals: goals.map(g => ({
        ...g,
        assigned_email: null,
        assigned_to: g.assigned_to,
      })) });
      closeModal(); loadGoals();
    } catch (ex) { alert(ex.message); }
  });

  openModal();
}

let goalRowCount = 0;

function renderGoalRows() {
  goalRowCount = 0;
  document.getElementById('goal-rows').innerHTML = '';
  addGoalRow();
}

function addGoalRow() {
  goalRowCount++;
  const idx = goalRowCount;
  const div = document.createElement('div');
  div.className = 'goal-row';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="goal-row-header">
      <span class="goal-row-num">Goal ${idx}</span>
      ${idx > 1 ? `<button type="button" class="btn-icon remove-row-btn" onclick="removeGoalRow(this)" title="Remove">
        <svg viewBox="0 0 24 24" style="fill:#ef4444"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>` : ''}
    </div>
    <div class="form-group">
      <input name="title" placeholder="Goal title *" required />
    </div>
    <div class="form-group">
      <textarea name="description" placeholder="Description (optional)" style="min-height:56px"></textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <select name="status">
          <option value="not_started">Not Started</option>
          <option value="in_progress" selected>In Progress</option>
          <option value="completed">Completed</option>
        </select>
      </div>
      <div class="form-group">
        <input type="date" name="due_date" placeholder="Due date" />
      </div>
    </div>
    <div class="form-group" style="margin-bottom:20px">
      <label style="font-size:12px">Progress: <span class="pval">0%</span></label>
      <input type="range" name="progress" min="0" max="100" value="0"
        oninput="this.closest('.goal-row').querySelector('.pval').textContent=this.value+'%'" />
    </div>
  `;
  document.getElementById('goal-rows').appendChild(div);
}

function removeGoalRow(btn) {
  btn.closest('.goal-row').remove();
  updateRowNumbers();
}

function updateRowNumbers() {
  document.querySelectorAll('.goal-row').forEach((row, i) => {
    row.querySelector('.goal-row-num').textContent = `Goal ${i + 1}`;
  });
}

async function openEditGoal(id) {
  const goals = await api('GET', '/api/goals');
  const goal = goals.find(g => g.id === id);
  if (!goal) return;
  openGoalModal(goal);
}

function openProgressModal(goal) {
  $('modal-title').textContent = 'Update Progress';
  $('modal-body').innerHTML = `
    <p style="font-size:14px;color:var(--text-muted);margin-bottom:16px">${goal.title}</p>
    <form id="progress-form">
      <div class="form-group">
        <label>Progress: <span id="prog-display2">${goal.progress}%</span></label>
        <div class="progress-edit">
          <input type="range" name="progress" min="0" max="100" value="${goal.progress}"
            oninput="$('prog-display2').textContent=this.value+'%'" />
        </div>
      </div>
      <div class="form-group">
        <label>Status</label>
        <select name="status">
          <option value="not_started" ${goal.status === 'not_started' ? 'selected' : ''}>Not Started</option>
          <option value="in_progress" ${goal.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
          <option value="completed" ${goal.status === 'completed' ? 'selected' : ''}>Completed</option>
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Update</button>
      </div>
    </form>
  `;
  document.getElementById('progress-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { progress: parseInt(fd.get('progress')), status: fd.get('status') };
    try {
      await api('PATCH', `/api/goals/${goal.id}`, body);
      closeModal();
      loadGoals();
    } catch (ex) { alert(ex.message); }
  });
  openModal();
}

async function deleteGoal(id) {
  if (!confirm('Delete this goal?')) return;
  await api('DELETE', `/api/goals/${id}`);
  loadGoals();
}

/* ── My Goals (personal, private to each user) ──────────────────────────── */
let cachedMyGoals = [];

async function loadMyGoals() {
  cachedMyGoals = await api('GET', '/api/my-goals');
  renderMyGoals();
}

function renderMyGoals() {
  const goals = cachedMyGoals;
  const total = goals.length;
  const done = goals.filter(g => g.status === 'completed').length;
  const inProgress = goals.filter(g => g.status === 'in_progress').length;
  const avgP = total ? Math.round(goals.reduce((s, g) => s + g.progress, 0) / total) : 0;
  const overdue = goals.filter(g => g.due_date && g.status !== 'completed' && new Date(g.due_date) < new Date());

  // Summary bar
  $('mygoals-summary').innerHTML = total ? `
    <div class="mg-stats">
      <div class="mg-stat"><div class="mg-sv">${total}</div><div class="mg-sl">Total Goals</div></div>
      <div class="mg-stat"><div class="mg-sv">${avgP}%</div><div class="mg-sl">Avg Progress</div></div>
      <div class="mg-stat mg-stat-done"><div class="mg-sv">${done}</div><div class="mg-sl">Completed</div></div>
      <div class="mg-stat mg-stat-ip"><div class="mg-sv">${inProgress}</div><div class="mg-sl">In Progress</div></div>
      ${overdue.length ? `<div class="mg-stat mg-stat-red"><div class="mg-sv">${overdue.length}</div><div class="mg-sl">Overdue</div></div>` : ''}
    </div>
  ` : '';

  if (!total) {
    $('mygoals-list').innerHTML = `
      <div class="empty-state" style="padding:60px 40px;text-align:center">
        <div style="font-size:40px;margin-bottom:12px">🎯</div>
        <h3 style="margin-bottom:8px">No personal goals yet</h3>
        <p style="color:var(--text-muted)">Add your first goal to start tracking your personal progress.</p>
      </div>`;
    return;
  }

  $('mygoals-list').innerHTML = goals.map(g => myGoalRow(g)).join('');
}

function myGoalRow(g) {
  const overdue = isOverdue(g.due_date) && g.status !== 'completed';
  return `
    <div class="goal-row-item mg-row">
      <div class="goal-row-main">
        <div class="goal-row-title">${g.title}</div>
        ${g.description ? `<div class="goal-row-desc">${g.description}</div>` : ''}
        <div class="goal-row-meta">
          <span class="badge badge-${g.status}">${statusLabel(g.status)}</span>
          ${g.due_date ? `<span class="goal-due ${overdue ? 'overdue' : ''}">📅 ${overdue ? 'Overdue · ' : ''}${fmtDate(g.due_date)}</span>` : ''}
        </div>
      </div>
      <div class="goal-row-progress">
        <div class="progress-bar-bg"><div class="progress-bar ${g.progress === 100 ? 'green' : ''}" style="width:${g.progress}%"></div></div>
        <span class="mt-pct">${g.progress}%</span>
      </div>
      <div class="goal-actions">
        <button class="btn btn-secondary btn-sm comment-btn" onclick="openCommentsModal(${g.id}, ${JSON.stringify(g.title).replace(/'/g, "&#39;")})">
          💬 ${g.comment_count || 0}
        </button>
        <button class="btn btn-secondary btn-sm" onclick="openMyGoalModal(${g.id})">Edit</button>
        <button class="btn-icon" onclick="deleteMyGoal(${g.id})" title="Delete">
          <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#ef4444"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    </div>`;
}

function openMyGoalModal(goalId = null) {
  const goal = goalId ? cachedMyGoals.find(g => g.id === goalId) : null;
  $('modal-title').textContent = goal ? 'Edit My Goal' : 'Add My Goal';
  $('modal-body').innerHTML = `
    <form id="my-goal-form">
      <div class="form-group">
        <label>Goal Title *</label>
        <input name="title" value="${goal ? goal.title : ''}" placeholder="What do you want to achieve?" required />
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea name="description" placeholder="What does success look like?">${goal ? (goal.description || '') : ''}</textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Status</label>
          <select name="status">
            <option value="not_started" ${!goal || goal.status === 'not_started' ? 'selected' : ''}>Not Started</option>
            <option value="in_progress" ${goal?.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
            <option value="completed" ${goal?.status === 'completed' ? 'selected' : ''}>Completed</option>
          </select>
        </div>
        <div class="form-group">
          <label>Due Date</label>
          <input type="date" name="due_date" value="${goal?.due_date || ''}" />
        </div>
      </div>
      <div class="form-group">
        <label>Progress: <span id="mg-prog-display">${goal ? goal.progress : 0}%</span></label>
        <div class="progress-edit">
          <input type="range" name="progress" min="0" max="100" value="${goal ? goal.progress : 0}"
            oninput="$('mg-prog-display').textContent=this.value+'%'" />
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">${goal ? 'Save Changes' : 'Add Goal'}</button>
      </div>
    </form>`;
  document.getElementById('my-goal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.progress = parseInt(body.progress);
    if (!body.due_date) delete body.due_date;
    try {
      if (goal) {
        await api('PATCH', `/api/goals/${goal.id}`, body);
      } else {
        await api('POST', '/api/my-goals', body);
      }
      closeModal();
      loadMyGoals();
    } catch (ex) { alert(ex.message); }
  });
  openModal();
}

async function deleteMyGoal(id) {
  if (!confirm('Delete this goal?')) return;
  await api('DELETE', `/api/goals/${id}`);
  loadMyGoals();
}

$('new-my-goal-btn').addEventListener('click', () => openMyGoalModal());

/* ── Export ─────────────────────────────────────────────────────────────── */
$('export-goals-btn').addEventListener('click', () => {
  window.location.href = '/api/goals/export';
});
$('export-my-goals-btn').addEventListener('click', () => {
  window.location.href = '/api/my-goals/export';
});

/* ── Comments ───────────────────────────────────────────────────────────── */
async function openCommentsModal(goalId, goalTitle) {
  $('modal-title').textContent = `💬 Comments`;
  $('modal-body').innerHTML = `<div style="font-size:13px;color:var(--text-muted);margin-bottom:16px">${goalTitle}</div>
    <div id="comments-list" style="max-height:320px;overflow-y:auto;margin-bottom:16px"></div>
    <form id="comment-form" style="display:flex;gap:8px;align-items:flex-end">
      <div class="form-group" style="flex:1;margin-bottom:0">
        <textarea id="comment-input" placeholder="Write a comment…" style="min-height:60px;resize:none" required></textarea>
      </div>
      <button type="submit" class="btn btn-primary" style="flex-shrink:0">Send</button>
    </form>`;
  openModal();

  async function loadComments() {
    const comments = await api('GET', `/api/goals/${goalId}/comments`);
    const list = $('comments-list');
    if (!comments.length) {
      list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px">No comments yet. Be the first!</div>';
      return;
    }
    list.innerHTML = comments.map(c => {
      const isMe = c.user_id === currentUser.id;
      const isManager = currentUser.role === 'manager';
      return `<div class="comment-item ${isMe ? 'comment-me' : ''}">
        <div class="comment-avatar">${c.avatar_initials || c.author_name[0]}</div>
        <div class="comment-body">
          <div class="comment-meta">
            <strong>${c.author_name}</strong>
            <span class="role-badge" style="font-size:10px">${c.author_role}</span>
            <span style="color:var(--text-light);font-size:11px">${timeAgo(c.created_at)}</span>
            ${(isMe || isManager) ? `<button class="btn-icon" onclick="deleteComment(${c.id}, ${goalId}, '${goalTitle.replace(/'/g,"\\'")}')">
              <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:var(--text-light)"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>` : ''}
          </div>
          <div class="comment-text">${c.content}</div>
        </div>
      </div>`;
    }).join('');
    list.scrollTop = list.scrollHeight;
  }

  await loadComments();

  document.getElementById('comment-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('comment-input');
    const content = input.value.trim();
    if (!content) return;
    input.disabled = true;
    try {
      await api('POST', `/api/goals/${goalId}/comments`, { content });
      input.value = '';
      // refresh both the comment modal and the goals list in background
      await loadComments();
      if (document.getElementById('goals-list')) loadGoals();
      if (document.getElementById('mygoals-list')?.children.length) loadMyGoals();
    } catch (ex) { alert(ex.message); }
    input.disabled = false;
    input.focus();
  });
}

async function deleteComment(commentId, goalId, goalTitle) {
  if (!confirm('Delete this comment?')) return;
  await api('DELETE', `/api/comments/${commentId}`);
  openCommentsModal(goalId, goalTitle);
}

/* ── Highlights ─────────────────────────────────────────────────────────── */
async function loadHighlights() {
  const special = ['announcements','activity','mood'];
  if (special.includes(highlightsFilter)) {
    highlightsFilter = 'all';
    document.querySelectorAll('.filter-btn[data-hfilter]').forEach(b => {
      b.classList.toggle('active', b.dataset.hfilter === 'all');
    });
    applyHighlightsHeaderState('all');
  }
  const highlights = await api('GET', '/api/highlights');
  renderHighlights(highlights);
}

function applyHighlightsHeaderState(filter) {
  const isMgr = currentUser.role === 'manager' || currentUser.is_admin;
  $('highlights-heading').textContent =
    filter === 'announcements' ? 'Announcements' :
    filter === 'activity'      ? 'Recent Activity' :
    filter === 'mood'          ? 'Team Mood' : 'Highlights';
  $('highlights-list').className =
    filter === 'announcements' ? 'ann-mgr-list' :
    ['activity','mood'].includes(filter) ? 'hl-full-list' : 'highlights-grid';
  if (isMgr) {
    $('new-highlight-btn').style.display  = ['all','current'].includes(filter) ? '' : 'none';
    $('new-announce-btn').style.display   = filter === 'announcements' ? '' : 'none';
    $('new-poll-btn').style.display       = filter === 'mood' ? '' : 'none';
  }
}

function renderHighlights(highlights) {
  const filtered = highlightsFilter === 'current'
    ? highlights.filter(h => h.month === currentMonth())
    : highlights;

  $('highlights-list').innerHTML = filtered.length ? filtered.map(h => `
    <div class="highlight-card ${h.type}">
      ${currentUser.role === 'manager' ? `
      <div class="card-actions">
        <button class="btn-icon" onclick="deleteHighlight(${h.id})" title="Delete">
          <svg viewBox="0 0 24 24" style="fill:#ef4444"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>` : ''}
      <div class="highlight-type-icon">${highlightIcon(h.type)}</div>
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">${highlightLabel(h.type)}</div>
      <h3>${h.title}</h3>
      ${h.description ? `<p>${h.description}</p>` : ''}
      <div class="month-tag">📅 ${fmtMonth(h.month)}</div>
    </div>
  `).join('') : '<div class="empty-state" style="padding:60px;grid-column:1/-1">No highlights yet.</div>';
}

document.querySelectorAll('.filter-btn[data-hfilter]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.filter-btn[data-hfilter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    highlightsFilter = btn.dataset.hfilter;
    applyHighlightsHeaderState(highlightsFilter);

    if (highlightsFilter === 'announcements') {
      await loadHighlightsAnnouncements();
    } else if (highlightsFilter === 'activity') {
      await loadHighlightsActivity();
    } else if (highlightsFilter === 'mood') {
      await loadHighlightsMood();
    } else {
      const highlights = await api('GET', '/api/highlights');
      renderHighlights(highlights);
    }
  });
});

async function loadHighlightsAnnouncements() {
  const announcements = await api('GET', '/api/announcements/all').catch(() => []);
  const list = $('highlights-list');
  list.innerHTML = announcements.length ? `<div class="ann-row-list">${announcements.map(a => `
    <div class="ann-row">
      <span class="ann-row-dot ${a.is_active ? 'ann-dot-on' : 'ann-dot-off'}"></span>
      <div class="ann-row-content">
        <span class="ann-row-title">${a.title}</span>
        <span class="ann-row-msg">${a.message}</span>
      </div>
      <span class="ann-row-date">${fmtDate(a.created_at)}</span>
      <div class="ann-row-actions">
        <button onclick="toggleAnnouncement(${a.id},this)" class="ann-row-btn">${a.is_active ? 'Hide' : 'Show'}</button>
        <button onclick="deleteAnnouncement(${a.id},this)" class="ann-row-btn ann-row-btn-del">Delete</button>
      </div>
    </div>`).join('')}</div>`
    : '<div class="empty-state" style="padding:60px;text-align:center"><div style="font-size:36px;margin-bottom:12px">📭</div><p>No announcements yet.</p></div>';
}

async function loadHighlightsActivity() {
  const list = $('highlights-list');
  list.innerHTML = '<div style="padding:24px;color:var(--text-muted)">Loading…</div>';
  const rows = await api('GET', '/api/activity').catch(() => []);

  const typeIcon  = t => ({ goal_completed:'✅', goal_updated:'✏️', goal_created:'🎯', rating_added:'⭐' }[t] || '📌');
  const typeLabel = t => ({ goal_completed:'completed a goal', goal_updated:'updated a goal', goal_created:'created a goal', rating_added:'received a rating' }[t] || t);
  const typeColor = t => t === 'goal_completed' ? '#059669' : t === 'rating_added' ? '#7c3aed' : '#2563eb';

  if (!rows.length) {
    list.innerHTML = '<div class="empty-state" style="padding:60px;text-align:center"><div style="font-size:36px;margin-bottom:12px">📭</div><p>No recent activity yet.</p></div>';
    return;
  }

  // Group by date
  const grouped = {};
  for (const r of rows) {
    const d = r.ts ? r.ts.substring(0,10) : 'Unknown';
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(r);
  }

  list.innerHTML = `<div class="act-feed">${Object.entries(grouped).map(([date, items]) => `
    <div class="act-date-group">
      <div class="act-date-label">${fmtDate(date + 'T00:00:00')}</div>
      ${items.map(r => `
        <div class="act-row">
          <div class="act-dot" style="background:${typeColor(r.type)}"></div>
          <div class="act-body">
            <span class="act-actor">${r.actor}</span>
            <span class="act-verb">${typeLabel(r.type)}</span>
            <span class="act-subject">"${r.subject}"</span>
          </div>
          <span class="act-icon">${typeIcon(r.type)}</span>
        </div>`).join('')}
    </div>`).join('')}
  </div>`;
}

async function loadHighlightsMood() {
  const list = $('highlights-list');
  list.innerHTML = '<div style="padding:24px;color:var(--text-muted)">Loading…</div>';
  const polls = await api('GET', '/api/polls').catch(() => []);
  const isMgr = currentUser.role === 'manager' || currentUser.is_admin;
  const MOODS = ['😊','😐','😟'];
  const MOOD_LABEL = { '😊':'Happy', '😐':'Neutral', '😟':'Unhappy' };
  const MOOD_COLOR = { '😊':'#059669', '😐':'#d97706', '😟':'#dc2626' };

  if (!polls.length) {
    list.innerHTML = `<div class="empty-state" style="padding:60px;text-align:center">
      <div style="font-size:36px;margin-bottom:12px">🎯</div>
      <p>${isMgr ? 'No polls yet. Click "+ New Poll" to create one.' : 'No active polls right now.'}</p>
    </div>`;
    return;
  }

  list.innerHTML = `<div class="mood-feed">${polls.map(p => {
    const total = p.response_count || 0;
    const myCounts = (p.results || []).reduce((o, r) => { o[r.response] = r.n; return o; }, {});

    const resultsHtml = isMgr ? `
      <div class="mood-results">
        ${MOODS.map(m => {
          const n = myCounts[m] || 0;
          const pct = total ? Math.round((n/total)*100) : 0;
          return `<div class="mood-result-row">
            <span class="mood-emoji">${m}</span>
            <span class="mood-result-label">${MOOD_LABEL[m]}</span>
            <div class="mood-bar-wrap"><div class="mood-bar" style="width:${pct}%;background:${MOOD_COLOR[m]}"></div></div>
            <span class="mood-result-n" style="color:${MOOD_COLOR[m]}">${n}</span>
          </div>`;
        }).join('')}
        <div class="mood-total">${total} response${total!==1?'s':''}</div>
        ${p.respondents?.length ? `<details class="mood-who">
          <summary>${total} ${total===1?'person':'people'} responded</summary>
          <div class="mood-who-list">${p.respondents.map(r =>
            `<span class="mood-who-item">${r.name} <span style="font-size:16px">${r.response}</span></span>`
          ).join('')}</div>
        </details>` : ''}
      </div>` : '';

    const voteHtml = !isMgr && p.is_active ? `
      <div class="mood-vote">
        ${MOODS.map(m => `
          <button onclick="submitMoodVote(${p.id},'${m}',this)" class="mood-vote-btn ${p.my_response===m?'mood-voted':''}" title="${MOOD_LABEL[m]}">${m}</button>
        `).join('')}
        ${p.my_response ? `<span class="mood-my-pick">Your pick: ${p.my_response}</span>` : ''}
      </div>` : '';

    return `<div class="mood-card ${p.is_active?'':'mood-card-off'}">
      <div class="mood-card-header">
        <div>
          <div class="mood-q">${p.question}</div>
          <div class="mood-meta">${fmtDate(p.created_at)} · by ${p.author_name}${!p.is_active?' · <span style="color:#9ca3af">Closed</span>':''}</div>
        </div>
        ${isMgr ? `<div style="display:flex;gap:6px;flex-shrink:0">
          <button onclick="togglePoll(${p.id})" class="ann-row-btn">${p.is_active?'Close':'Reopen'}</button>
          <button onclick="deletePoll(${p.id})" class="ann-row-btn ann-row-btn-del">Delete</button>
        </div>` : ''}
      </div>
      ${resultsHtml}
      ${voteHtml}
    </div>`;
  }).join('')}</div>`;
}

async function submitMoodVote(pollId, response, btn) {
  try {
    await api('POST', `/api/polls/${pollId}/respond`, { response });
    await loadHighlightsMood();
  } catch (ex) { alert(ex.message); }
}

async function togglePoll(id) {
  await api('PATCH', `/api/polls/${id}/toggle`).catch(e => alert(e.message));
  await loadHighlightsMood();
}

async function deletePoll(id) {
  if (!confirm('Delete this poll?')) return;
  await api('DELETE', `/api/polls/${id}`).catch(e => alert(e.message));
  await loadHighlightsMood();
}

async function dashDeletePoll(id) {
  if (!confirm('Delete this poll?')) return;
  try {
    await api('DELETE', `/api/polls/${id}`);
    // Remove from DOM immediately
    const btn = document.querySelector(`button[onclick="dashDeletePoll(${id})"]`);
    if (btn) {
      const pollCard = btn.closest('[style*="border-bottom"]');
      if (pollCard) pollCard.remove();
    }
    // Then full refresh in background
    loadManagerDashboard();
  } catch(e) { alert('Delete failed: ' + e.message); }
}

$('new-announce-btn').addEventListener('click', openNewAnnouncement);

$('new-poll-btn').addEventListener('click', () => {
  $('modal-title').textContent = 'New Team Mood Poll';
  $('modal-body').innerHTML = `
    <form id="poll-form">
      <div class="form-group">
        <label>Question *</label>
        <input type="text" id="poll-question" placeholder="e.g. How are you feeling this week?" style="width:100%" required />
      </div>
      <div style="background:var(--bg);border-radius:8px;padding:12px;margin-top:4px">
        <div style="font-size:.78rem;color:var(--text-muted);margin-bottom:8px">Team members will respond with:</div>
        <div style="display:flex;gap:16px;font-size:1.5rem">😊 Happy &nbsp; 😐 Neutral &nbsp; 😟 Unhappy</div>
      </div>
      <div id="poll-error" class="error-msg hidden"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Poll</button>
      </div>
    </form>`;
  openModal();
  document.getElementById('poll-form').addEventListener('submit', async e => {
    e.preventDefault();
    const question = document.getElementById('poll-question').value.trim();
    if (!question) return;
    try {
      await api('POST', '/api/polls', { question });
      closeModal();
      await loadHighlightsMood();
    } catch (ex) { document.getElementById('poll-error').textContent = ex.message; document.getElementById('poll-error').classList.remove('hidden'); }
  });
});

$('new-highlight-btn').addEventListener('click', () => {
  const employees = allUsers.filter(u => u.role === 'employee');
  $('modal-title').textContent = 'Add Highlight';
  $('modal-body').innerHTML = `
    <form id="highlight-form">
      <div class="form-row">
        <div class="form-group">
          <label>Type *</label>
          <select name="type" id="hl-type-sel">
            <option value="employee_month">🏆 Employee of the Month</option>
            <option value="activity_month">🎯 Activity of the Month</option>
            <option value="shoutout">👏 Shoutout</option>
          </select>
        </div>
        <div class="form-group">
          <label>Month *</label>
          <input type="month" name="month" value="${currentMonth()}" required />
        </div>
      </div>
      <div class="form-group">
        <label>Title *</label>
        <input name="title" placeholder="e.g. Employee of the Month: Alice" required />
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea name="description" placeholder="What did they do? Why are we celebrating?"></textarea>
      </div>
      <div class="form-group" id="hl-employee-group">
        <label>Employee (optional)</label>
        <select name="employee_id">
          <option value="">— Select employee —</option>
          ${employees.map(u => `<option value="${u.id}">${u.name}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Add Highlight</button>
      </div>
    </form>
  `;
  document.getElementById('highlight-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    if (!body.employee_id) body.employee_id = null;
    try {
      await api('POST', '/api/highlights', body);
      closeModal();
      loadHighlights();
    } catch (ex) { alert(ex.message); }
  });
  openModal();
});

async function deleteHighlight(id) {
  if (!confirm('Delete this highlight?')) return;
  await api('DELETE', `/api/highlights/${id}`);
  loadHighlights();
}

/* ── Modal ──────────────────────────────────────────────────────────────── */
function openModal() { $('modal-overlay').classList.remove('hidden'); }
function closeModal() { $('modal-overlay').classList.add('hidden'); }
$('modal-close').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', e => { if (e.target === $('modal-overlay')) closeModal(); });

/* ── Team ───────────────────────────────────────────────────────────────── */
let cachedMembers = [];

async function loadTeam() {
  cachedMembers = await api('GET', '/api/members');
  renderTeam();
}

function renderTeam() {
  const q = ($('team-search')?.value || '').toLowerCase().trim();
  const filtered = cachedMembers.filter(m =>
    !q || m.name.toLowerCase().includes(q)
  );

  $('team-count').textContent = `${filtered.length} of ${cachedMembers.length} members`;
  $('team-empty').classList.toggle('hidden', filtered.length > 0);

  if (!filtered.length) { $('team-grid').innerHTML = ''; return; }

  const isAdmin = currentUser.is_admin;
  $('team-grid').innerHTML = `
    ${isAdmin ? `<div class="bulk-actions" id="bulk-actions" style="display:none">
      <span id="bulk-count" style="font-size:13px;font-weight:600;color:var(--text)">0 selected</span>
      <button class="btn btn-danger" onclick="deleteSelectedMembers()">🗑 Delete Selected</button>
      <button class="btn btn-secondary" onclick="clearSelection()">Cancel</button>
    </div>` : ''}
    <table class="members-table">
      <thead>
        <tr>
          ${isAdmin ? `<th style="width:36px"><input type="checkbox" id="select-all-members" onchange="toggleSelectAll(this)" /></th>` : ''}
          <th>Name</th>
          <th>Goals Progress</th>
          <th>Goals</th>
          <th>Awards</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map(m => {
          const pct = m.goal_avg_progress || 0;
          return `
          <tr class="member-row" id="member-row-${m.id}" onclick="openProfile(${m.id})">
            ${isAdmin ? `<td onclick="event.stopPropagation()">
              <input type="checkbox" class="member-cb" data-id="${m.id}" data-name="${m.name.replace(/"/g,'&quot;')}" onchange="onMemberCheck()" />
            </td>` : ''}
            <td>
              <div class="mt-name-cell">
                <div class="avatar">${m.avatar_initials || m.name[0]}</div>
                <div>
                  <div class="mt-name">${m.name}</div>
                  <div class="mt-title">${m.job_title || '—'}</div>
                </div>
              </div>
            </td>
            <td>
              <div class="mt-progress">
                <div class="progress-bar-bg" style="width:120px">
                  <div class="progress-bar ${pct === 100 ? 'green' : ''}" style="width:${pct}%"></div>
                </div>
                <span class="mt-pct">${pct}%</span>
              </div>
            </td>
            <td><span class="mt-stat">${m.goal_done} / ${m.goal_total}</span></td>
            <td><span class="mt-stat">🏅 ${m.award_count}</span></td>
            <td><span class="mt-arrow">›</span></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

function onMemberCheck() {
  const checked = document.querySelectorAll('.member-cb:checked');
  const bar = $('bulk-actions');
  if (!bar) return;
  bar.style.display = checked.length ? 'flex' : 'none';
  $('bulk-count').textContent = `${checked.length} selected`;
  const all = document.querySelectorAll('.member-cb');
  const selectAll = $('select-all-members');
  if (selectAll) selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  if (selectAll) selectAll.checked = checked.length === all.length;
  // highlight selected rows
  document.querySelectorAll('.member-cb').forEach(cb => {
    document.getElementById('member-row-' + cb.dataset.id)?.classList.toggle('row-selected', cb.checked);
  });
}

function toggleSelectAll(chk) {
  document.querySelectorAll('.member-cb').forEach(cb => { cb.checked = chk.checked; });
  onMemberCheck();
}

function clearSelection() {
  document.querySelectorAll('.member-cb').forEach(cb => { cb.checked = false; });
  const sa = $('select-all-members');
  if (sa) { sa.checked = false; sa.indeterminate = false; }
  onMemberCheck();
}

async function deleteSelectedMembers() {
  const checked = Array.from(document.querySelectorAll('.member-cb:checked'));
  if (!checked.length) return;
  const names = checked.map(cb => cb.dataset.name).join(', ');
  if (!confirm(`Delete ${checked.length} member(s)?\n\n${names}\n\nThis cannot be undone.`)) return;
  for (const cb of checked) {
    try {
      await api('DELETE', `/api/members/${cb.dataset.id}`);
      cachedMembers = cachedMembers.filter(m => m.id !== parseInt(cb.dataset.id));
    } catch (ex) { alert(`Failed to delete ${cb.dataset.name}: ${ex.message}`); }
  }
  renderTeam();
  alert(`✅ ${checked.length} member(s) deleted.`);
}

async function deleteMember(memberId, name) {
  if (!confirm(`Delete ${name} and all their data (goals, ratings, skills)? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/members/${memberId}`);
    cachedMembers = cachedMembers.filter(m => m.id !== memberId);
    renderTeam();
    alert(`✅ ${name} has been removed.`);
  } catch (ex) { alert(ex.message); }
}

async function openProfile(memberId) {
  const [m, evals, skills] = await Promise.all([
    api('GET', `/api/members/${memberId}`),
    api('GET', `/api/evaluations/${memberId}`).catch(() => []),
    api('GET', `/api/users/${memberId}/skills`).catch(() => [])
  ]);
  const isManager = currentUser.role === 'manager';

  const joinedAgo = m.joined_at ? yearsMonthsAgo(m.joined_at) : '—';

  $('profile-content').innerHTML = `
    <div class="profile-header">
      <button class="btn-icon profile-close" onclick="closeProfile()">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
      <div class="profile-hero">
        <div class="avatar xl">${m.avatar_initials || m.name[0]}</div>
        <div class="profile-hero-info">
          <h2>${m.name}</h2>
          <div class="profile-title">${m.job_title || 'No title set'}</div>
          ${m.department ? `<span class="profile-dept">${m.department}</span>` : ''}
        </div>
      </div>
      ${m.bio ? `<p class="profile-bio">${m.bio}</p>` : ''}
    </div>

    <div class="profile-meta-row">
      <div class="profile-meta-item">
        <div class="meta-label">Joined</div>
        <div class="meta-value">${m.joined_at ? fmtDate(m.joined_at) : '—'}</div>
        <div class="meta-sub">${joinedAgo}</div>
      </div>
      <div class="profile-meta-item">
        <div class="meta-label">Last Promotion</div>
        <div class="meta-value">${m.last_promotion_date ? fmtDate(m.last_promotion_date) : '—'}</div>
        <div class="meta-sub">${m.promotion_title || ''}</div>
      </div>
      <div class="profile-meta-item">
        <div class="meta-label">Goals</div>
        <div class="meta-value">${m.goals.length}</div>
        <div class="meta-sub">${m.goals.filter(g => g.status === 'completed').length} completed</div>
      </div>
      <div class="profile-meta-item">
        <div class="meta-label">Awards</div>
        <div class="meta-value">${m.awards.length + m.highlights.length}</div>
        <div class="meta-sub">recognitions</div>
      </div>
    </div>

    ${skills.length ? `
    <div class="profile-skills-bar">
      ${skills.map(s => `<span class="skill-tag skill-tag-sm">${s.skill}</span>`).join('')}
    </div>` : `
    <div class="profile-skills-bar profile-skills-empty">
      <span>No skills added yet</span>
      <a href="#" onclick="event.preventDefault();document.querySelector('.profile-tab[data-tab=skills]').click()">+ Add skills →</a>
    </div>`}

    <div class="profile-tabs">
      <button class="profile-tab active" data-tab="goals">Goals (${m.goals.length})</button>
      <button class="profile-tab" data-tab="skills">🛠 Skills (${skills.length})</button>
      <button class="profile-tab" data-tab="awards">Awards & Highlights (${m.awards.length + m.highlights.length})</button>
      <button class="profile-tab" data-tab="ratings">⭐ Ratings (${evals.length})</button>
      ${isManager ? `<button class="profile-tab" data-tab="edit">Edit Profile</button>` : ''}
    </div>

    <div class="profile-tab-content">
      <div class="profile-tab-pane active" id="ptab-goals">
        ${m.goals.length ? m.goals.map(g => `
          <div class="profile-goal-item">
            <div class="profile-goal-title">
              ${g.title}
              <span class="badge badge-${g.status}">${statusLabel(g.status)}</span>
              <span class="badge badge-${g.type}">${g.type}</span>
            </div>
            ${g.description ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${g.description}</div>` : ''}
            <div class="progress-wrap">
              <div class="progress-label"><span>${g.due_date ? '📅 ' + fmtDate(g.due_date) : ''}</span><span>${g.progress}%</span></div>
              <div class="progress-bar-bg"><div class="progress-bar ${g.progress === 100 ? 'green' : ''}" style="width:${g.progress}%"></div></div>
            </div>
          </div>
        `).join('') : '<div class="empty-state">No individual goals assigned.</div>'}
      </div>

      <div class="profile-tab-pane" id="ptab-skills">
        <div class="skills-section">
          <div class="skills-tags" id="skills-tags-${m.id}">
            ${skills.length ? skills.map(s => `
              <span class="skill-tag">
                ${s.skill}
                <button class="skill-remove" onclick="removeSkill(${s.id}, ${m.id})" title="Remove">×</button>
              </span>`).join('') : '<span style="color:var(--text-muted);font-size:13px">No skills added yet.</span>'}
          </div>
          <div class="skills-add-row">
            <div class="skills-input-wrap">
              <input type="text" id="skill-input-${m.id}" class="skills-input" placeholder="Add a skill…"
                list="skill-suggestions-${m.id}"
                onkeydown="if(event.key==='Enter'){addSkill(${m.id});event.preventDefault()}" />
              <datalist id="skill-suggestions-${m.id}">
                ${SKILL_SUGGESTIONS.map(s => `<option value="${s}">`).join('')}
              </datalist>
            </div>
            <button class="btn btn-primary" onclick="addSkill(${m.id})">+ Add</button>
          </div>
        </div>
      </div>

      <div class="profile-tab-pane" id="ptab-awards">
        ${isManager ? `
        <div style="margin-bottom:16px">
          <button class="btn btn-primary btn-sm" onclick="openAddAward(${m.id})">+ Add Award</button>
        </div>` : ''}
        <div class="awards-list">
          ${m.awards.map(a => `
            <div class="award-card">
              <div class="award-icon">🏅</div>
              <div class="award-info">
                <h4>${a.title}</h4>
                ${a.description ? `<p>${a.description}</p>` : ''}
                <div class="award-meta">Awarded ${fmtDate(a.awarded_at)} · by ${a.given_by}</div>
              </div>
              ${isManager ? `<button class="btn-icon del-btn" onclick="deleteAward(${a.id}, ${m.id})" title="Remove">
                <svg viewBox="0 0 24 24" style="fill:#ef4444"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              </button>` : ''}
            </div>
          `).join('')}
        </div>
        ${m.highlights.length ? `
        <div style="margin-top:20px">
          <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Team Highlights</div>
          <div class="profile-hl-list">
            ${m.highlights.map(h => `
              <div class="profile-hl-item">
                <div class="hl-icon">${highlightIcon(h.type)}</div>
                <div>
                  <h4>${h.title}</h4>
                  ${h.description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:3px">${h.description}</div>` : ''}
                  <div class="month">${highlightLabel(h.type)} · ${fmtMonth(h.month)}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>` : ''}
        ${!m.awards.length && !m.highlights.length ? '<div class="empty-state">No awards or highlights yet.</div>' : ''}
      </div>

      <div class="profile-tab-pane" id="ptab-ratings">
        ${evals.length ? evals.map(ev => `
          <div class="eval-card">
            <div class="eval-header">
              <div>
                <div class="eval-year">${ev.year} Evaluation</div>
                ${ev.tl_name ? `<div class="eval-meta">TL: ${ev.tl_name}</div>` : ''}
                ${ev.type_of_work ? `<div class="eval-meta">Work Type: ${ev.type_of_work}</div>` : ''}
              </div>
              <div style="text-align:center">
                <div class="eval-net-rating" style="color:${ev.net_rating >= 8 ? 'var(--success)' : ev.net_rating >= 6 ? 'var(--warning)' : 'var(--danger)'}">${ev.net_rating ? ev.net_rating.toFixed(2) : '—'}</div>
                <div class="eval-net-label">Net Rating</div>
              </div>
              ${isManager ? `<button class="btn-icon" onclick="deleteEval(${ev.id}, ${m.id})" title="Delete">
                <svg viewBox="0 0 24 24" style="fill:#ef4444;width:16px;height:16px"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              </button>` : ''}
            </div>
            ${ev.x_factor ? `<div class="eval-xfactor"><span style="font-weight:600">X-Factor:</span> ${ev.x_factor}</div>` : ''}
            <div class="eval-scores">
              ${(ev.eval_type === 'member' ? [
                ['Complexity of Work',    ev.complexity_of_work,    20],
                ['Avg Feedback Rating',   ev.avg_feedback_rating,   35],
                ['Attitude Towards Work', ev.attitude_towards_work, 15],
                ['Communication',         ev.communication,         10],
                ['Learning Curve',        ev.learning_curve,        10],
                ['Engagement',            ev.engagement,            10],
              ] : [
                ['Problem Solving',           ev.problem_solving,      5],
                ['Project Scoping',           ev.project_scoping,      15],
                ['Communication',             ev.communication,        15],
                ['Attention to Detail',       ev.attention_to_detail,  10],
                ['Attitude Towards Work',     ev.attitude_towards_work,10],
                ['Compliance',               ev.compliance,            10],
                ['Client Management',         ev.client_management,    10],
                ['360° Feedback',             ev.feedback_360,         10],
                ['PIEX / Internal Initiative',ev.piex_internal,        5],
                ['Engagement',               ev.engagement,            10],
              ]).filter(([,val]) => val !== null && val !== undefined).map(([label, val, weight]) => `
                <div class="eval-score-row">
                  <div class="eval-score-label">${label} <span class="eval-weight">(${weight}%)</span></div>
                  <div class="eval-bar-wrap">
                    <div class="eval-bar-bg"><div class="eval-bar" style="width:${val * 10}%;background:${val >= 8 ? 'var(--success)' : val >= 6 ? 'var(--warning)' : 'var(--danger)'}"></div></div>
                    <span class="eval-score-val">${val}/10</span>
                  </div>
                </div>`).join('')}
            </div>
            ${ev.comments ? `<div class="eval-comments"><strong>Strengths / Comments:</strong> ${ev.comments}</div>` : ''}
            ${ev.area_of_improvement ? `<div class="eval-comments" style="margin-top:10px;border-left-color:#f59e0b"><strong>Areas of Improvement:</strong> ${ev.area_of_improvement}</div>` : ''}
          </div>
        `).join('') : `
          <div class="empty-state" style="padding:48px;text-align:center">
            <div style="font-size:36px;margin-bottom:12px">⭐</div>
            <h3 style="margin-bottom:6px">No evaluations yet</h3>
            <p style="color:var(--text-muted)">Use "Upload Ratings" on the Team page to add evaluation data.</p>
          </div>`}
      </div>

      ${isManager ? `
      <div class="profile-tab-pane" id="ptab-edit">
        <form id="edit-profile-form">
          <input type="hidden" name="memberId" value="${m.id}" />
          <div class="edit-profile-grid">
            <div class="form-group">
              <label>Full Name</label>
              <input name="name" value="${m.name}" />
            </div>
            <div class="form-group">
              <label>Job Title</label>
              <input name="job_title" value="${m.job_title || ''}" placeholder="e.g. Software Engineer" />
            </div>
            <div class="form-group">
              <label>Department</label>
              <input name="department" value="${m.department || ''}" placeholder="e.g. Engineering" />
            </div>
            <div class="form-group">
              <label>Joined Date</label>
              <input type="date" name="joined_at" value="${m.joined_at || ''}" />
            </div>
            <div class="form-group">
              <label>Last Promotion Date</label>
              <input type="date" name="last_promotion_date" value="${m.last_promotion_date || ''}" />
            </div>
            <div class="form-group">
              <label>Promoted To (Title)</label>
              <input name="promotion_title" value="${m.promotion_title || ''}" placeholder="e.g. Senior Engineer" />
            </div>
          </div>
          <div class="form-group">
            <label>Bio</label>
            <textarea name="bio" placeholder="Short description about this person…">${m.bio || ''}</textarea>
          </div>
          <div style="display:flex;gap:10px;margin-top:4px">
            <button type="submit" class="btn btn-primary">Save Changes</button>
          </div>
        </form>
      </div>` : ''}
    </div>
  `;

  // tab switching
  $('profile-content').querySelectorAll('.profile-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $('profile-content').querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
      $('profile-content').querySelectorAll('.profile-tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(`ptab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // edit profile form
  const editForm = document.getElementById('edit-profile-form');
  if (editForm) {
    editForm.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const id = fd.get('memberId');
      const body = {};
      for (const [k, v] of fd.entries()) { if (k !== 'memberId') body[k] = v || null; }
      try {
        await api('PATCH', `/api/members/${id}`, body);
        await loadTeam();
        openProfile(parseInt(id));
      } catch (ex) { alert(ex.message); }
    });
  }

  $('profile-panel').classList.remove('hidden');
  $('profile-backdrop').classList.remove('hidden');
}

function closeProfile() {
  $('profile-panel').classList.add('hidden');
  $('profile-backdrop').classList.add('hidden');
}

function yearsMonthsAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const months = Math.floor(diff / (1000 * 60 * 60 * 24 * 30.44));
  if (months < 1) return 'Just joined';
  if (months < 12) return `${months} month${months > 1 ? 's' : ''}`;
  const yrs = Math.floor(months / 12);
  const rem = months % 12;
  return rem ? `${yrs}y ${rem}m` : `${yrs} year${yrs > 1 ? 's' : ''}`;
}

$('profile-backdrop').addEventListener('click', closeProfile);

function openAddAward(memberId) {
  $('modal-title').textContent = 'Add Award';
  $('modal-body').innerHTML = `
    <form id="award-form">
      <div class="form-group">
        <label>Award Title *</label>
        <input name="title" placeholder="e.g. Best Performer Q1" required />
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea name="description" placeholder="What did they do to earn this?"></textarea>
      </div>
      <div class="form-group">
        <label>Date Awarded *</label>
        <input type="date" name="awarded_at" value="${new Date().toISOString().slice(0,10)}" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Add Award</button>
      </div>
    </form>
  `;
  document.getElementById('award-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', `/api/members/${memberId}/awards`, {
        title: fd.get('title'), description: fd.get('description') || null, awarded_at: fd.get('awarded_at')
      });
      closeModal();
      openProfile(memberId);
    } catch (ex) { alert(ex.message); }
  });
  openModal();
}

async function deleteAward(awardId, memberId) {
  if (!confirm('Remove this award?')) return;
  await api('DELETE', `/api/awards/${awardId}`);
  openProfile(memberId);
}

async function deleteEval(evalId, memberId) {
  if (!confirm('Delete this evaluation?')) return;
  await api('DELETE', `/api/evaluations/${evalId}`);
  openProfile(memberId);
}

/* ── Upload Ratings ─────────────────────────────────────────────────────── */
document.getElementById('upload-ratings-btn').addEventListener('click', () => openUploadRatings());
document.getElementById('tr-upload-btn').addEventListener('click', () => openUploadRatings(activeRatingTab));
document.getElementById('export-skills-btn').addEventListener('click', () => {
  window.location.href = '/api/skills/export';
});

function openUploadRatings(defaultType) {
  $('modal-title').textContent = '↑ Upload Evaluation Ratings';

  const pmCols = `<code>Name</code> or <code>Email</code> &nbsp;·&nbsp; <code>Year</code> &nbsp;·&nbsp;
      <code>X-Factor</code> &nbsp;·&nbsp; <code>Problem Solving</code> &nbsp;·&nbsp; <code>Project Scoping</code> &nbsp;·&nbsp;
      <code>Communication</code> &nbsp;·&nbsp; <code>Attention to Detail</code> &nbsp;·&nbsp;
      <code>Attitude Towards Work</code> &nbsp;·&nbsp; <code>Compliance</code> &nbsp;·&nbsp;
      <code>Client Management</code> &nbsp;·&nbsp; <code>360 Feedback</code> &nbsp;·&nbsp;
      <code>PIEX Internal</code> &nbsp;·&nbsp; <code>Engagement</code> &nbsp;·&nbsp;
      <code>Net Rating</code> &nbsp;·&nbsp; <code>Comments</code>`;

  const tmCols = `<code>Name</code> or <code>Email</code> &nbsp;·&nbsp; <code>Year</code> &nbsp;·&nbsp;
      <code>DOJ</code> &nbsp;·&nbsp; <code>Type of Work</code> &nbsp;·&nbsp; <code>X-Factor</code> &nbsp;·&nbsp;
      <code>Complexity of Work</code> &nbsp;·&nbsp; <code>Average Feedback Rating</code> &nbsp;·&nbsp;
      <code>Attitude Towards Work</code> &nbsp;·&nbsp; <code>Communication</code> &nbsp;·&nbsp;
      <code>Learning Curve</code> &nbsp;·&nbsp; <code>Engagement</code> &nbsp;·&nbsp;
      <code>Net Rating</code> &nbsp;·&nbsp; <code>Comment</code> &nbsp;·&nbsp; <code>Area of Improvement</code>`;

  $('modal-body').innerHTML = `
    <div class="tr-upload-type-row">
      <span style="font-size:13px;font-weight:600;color:var(--text)">Upload for:</span>
      <label class="tr-upload-type-lbl"><input type="radio" name="upload-type" value="pm" ${defaultType !== 'member' ? 'checked' : ''} /> 📋 Project Managers</label>
      <label class="tr-upload-type-lbl"><input type="radio" name="upload-type" value="member" ${defaultType === 'member' ? 'checked' : ''} /> 👥 Team Members</label>
    </div>
    <div class="tr-upload-type-row" style="margin-top:8px">
      <span style="font-size:13px;font-weight:600;color:var(--text)">Period:</span>
      <select id="upload-period" style="font-size:13px;padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface)">
        <option value="H1">H1 (Jan–Jun)</option>
        <option value="H2">H2 (Jul–Dec)</option>
        <option value="Annual" selected>Annual</option>
        <option value="Q1">Q1</option>
        <option value="Q2">Q2</option>
        <option value="Q3">Q3</option>
        <option value="Q4">Q4</option>
      </select>
    </div>
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Required columns (in any order):</p>
    <div class="eval-col-list" id="upload-col-hint">${defaultType === 'member' ? tmCols : pmCols}</div>
    <div style="margin:16px 0">
      <label class="btn btn-secondary" style="cursor:pointer">
        📂 Choose File
        <input type="file" id="ratings-file" accept=".xlsx,.xls,.csv" style="display:none" />
      </label>
      <span id="ratings-filename" style="font-size:13px;margin-left:10px;color:var(--text-muted)">No file chosen</span>
    </div>
    <div id="ratings-preview"></div>
    <div class="modal-actions" id="ratings-actions" style="display:none">
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn btn-primary" id="ratings-submit-btn">Upload Ratings</button>
    </div>
  `;

  // update column hint when type changes
  document.querySelectorAll('input[name="upload-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      $('upload-col-hint').innerHTML = radio.value === 'member' ? tmCols : pmCols;
      parsedRows = [];
      $('ratings-preview').innerHTML = '';
      $('ratings-actions').style.display = 'none';
      $('ratings-filename').textContent = 'No file chosen';
    });
  });

  let parsedRows = [];

  const pmColMap = {
    'name': 'name', 'email': 'email', 'year': 'year',
    'x-factor': 'x_factor', 'xfactor': 'x_factor', 'x factor': 'x_factor',
    'problem solving': 'problem_solving',
    'project scoping': 'project_scoping',
    'communication': 'communication',
    'attention to detail': 'attention_to_detail',
    'attitude towards work': 'attitude_towards_work', 'attitude toward work': 'attitude_towards_work',
    'compliance': 'compliance',
    'client management': 'client_management',
    '360 feedback': 'feedback_360', '360 degree': 'feedback_360', '360degree': 'feedback_360',
    '360 degree average feedback from team': 'feedback_360',
    'piex internal': 'piex_internal', 'piex / internal initiative': 'piex_internal', 'piex/internal initiative': 'piex_internal',
    'engagement': 'engagement',
    'net rating': 'net_rating', 'netrating': 'net_rating',
    'comments': 'comments', 'comment': 'comments',
  };

  const tmColMap = {
    'name': 'name', 'email': 'email', 'year': 'year',
    'doj': 'tl_name',  // reusing tl_name field for DOJ storage or just ignoring
    'type of work': 'type_of_work', 'typeofwork': 'type_of_work',
    'x-factor': 'x_factor', 'xfactor': 'x_factor', 'x factor': 'x_factor',
    'complexity of work': 'complexity_of_work',
    'average feedback rating': 'avg_feedback_rating', 'avg feedback rating': 'avg_feedback_rating',
    'average feedback  rating': 'avg_feedback_rating',
    'attitude towards work': 'attitude_towards_work', 'attitude toward work': 'attitude_towards_work',
    'communication': 'communication',
    'learning curve': 'learning_curve', 'learningcurve': 'learning_curve',
    'engagement': 'engagement',
    'net rating': 'net_rating', 'netrating': 'net_rating',
    'comments': 'comments', 'comment': 'comments',
    'area of improvement': 'area_of_improvement', 'area of improvements': 'area_of_improvement',
  };

  document.getElementById('ratings-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    $('ratings-filename').textContent = file.name;
    $('ratings-preview').innerHTML = '<div style="color:var(--text-muted);font-size:13px">Parsing…</div>';

    const uploadType = document.querySelector('input[name="upload-type"]:checked').value;
    const colMap = uploadType === 'member' ? tmColMap : pmColMap;
    const scoreKeys = uploadType === 'member'
      ? ['complexity_of_work','avg_feedback_rating','attitude_towards_work','communication','learning_curve','engagement']
      : ['problem_solving','project_scoping','communication','attention_to_detail','attitude_towards_work','compliance','client_management','feedback_360','piex_internal','engagement'];

    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });

      parsedRows = raw.map(row => {
        const out = {};
        for (const [k, v] of Object.entries(row)) {
          const mapped = colMap[k.toLowerCase().trim()];
          if (mapped) out[mapped] = v;
        }
        return out;
      }).filter(r => r.name || r.email);

      if (!parsedRows.length) {
        $('ratings-preview').innerHTML = '<div class="error-msg">No valid rows found. Check column names match the required format.</div>';
        return;
      }

      $('ratings-preview').innerHTML = `
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">${parsedRows.length} row${parsedRows.length!==1?'s':''} ready to upload</div>
        <div style="overflow-x:auto;max-height:220px;border:1px solid var(--border);border-radius:8px">
          <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:600px">
            <thead><tr style="background:var(--bg);position:sticky;top:0">
              <th style="padding:7px 10px;text-align:left;border-bottom:1px solid var(--border)">Name</th>
              <th style="padding:7px 10px;text-align:left;border-bottom:1px solid var(--border)">Year</th>
              ${scoreKeys.map(k => `<th style="padding:7px 10px;text-align:center;border-bottom:1px solid var(--border)">${k.replace(/_/g,' ')}</th>`).join('')}
              <th style="padding:7px 10px;text-align:center;border-bottom:1px solid var(--border)">Net</th>
            </tr></thead>
            <tbody>
              ${parsedRows.map(r => `<tr style="border-bottom:1px solid var(--border)">
                <td style="padding:6px 10px;white-space:nowrap">${r.name || r.email || '—'}</td>
                <td style="padding:6px 10px">${r.year || '—'}</td>
                ${scoreKeys.map(k => `<td style="padding:6px 10px;text-align:center">${r[k] !== undefined && r[k] !== '' ? r[k] : '—'}</td>`).join('')}
                <td style="padding:6px 10px;text-align:center;font-weight:700;color:var(--primary)">${r.net_rating || '—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
      $('ratings-actions').style.display = 'flex';
    } catch (ex) {
      $('ratings-preview').innerHTML = `<div class="error-msg">Error reading file: ${ex.message}</div>`;
    }
  });

  document.getElementById('ratings-submit-btn').addEventListener('click', async () => {
    if (!parsedRows.length) return;
    const uploadType = document.querySelector('input[name="upload-type"]:checked').value;
    const uploadPeriod = $('upload-period').value;
    try {
      const result = await api('POST', '/api/evaluations/bulk', { rows: parsedRows, eval_type: uploadType, period: uploadPeriod });
      const msg = `✅ Uploaded ${result.upserted} evaluation${result.upserted !== 1 ? 's' : ''}.` +
        (result.errors.length ? `\n\nSkipped:\n${result.errors.join('\n')}` : '');
      alert(msg);
      closeModal();
    } catch (ex) { alert(ex.message); }
  });

  openModal();
}

/* ── Skills ─────────────────────────────────────────────────────────────── */
const SKILL_SUGGESTIONS = [
  'Project Management','Client Communication','Research','Data Analysis',
  'Report Writing','Presentation','Excel / Sheets','PowerPoint','Team Leadership',
  'Problem Solving','Critical Thinking','Time Management','Stakeholder Management',
  'Business Development','Financial Analysis','Marketing','Content Writing',
  'SEO / SEM','Social Media','Graphic Design','UI/UX Design','Video Editing',
  'Python','JavaScript','SQL','Tableau','Power BI','AutoCAD','Revit',
  'Negotiation','Compliance','Risk Management','Procurement','Vendor Management',
  'Quality Assurance','Training & Development','HR Management','Recruitment',
  'Accounting','Budgeting','Forecasting',
];

async function addSkill(userId) {
  const input = document.getElementById('skill-input-' + userId);
  const skill = input.value.trim();
  if (!skill) return;
  try {
    const s = await api('POST', `/api/users/${userId}/skills`, { skill });
    const container = document.getElementById('skills-tags-' + userId);
    // remove "no skills" placeholder if present
    const placeholder = container.querySelector('span[style]');
    if (placeholder) placeholder.remove();
    const tag = document.createElement('span');
    tag.className = 'skill-tag';
    tag.innerHTML = `${s.skill}<button class="skill-remove" onclick="removeSkill(${s.id},${userId})" title="Remove">×</button>`;
    container.appendChild(tag);
    input.value = '';
    // update tab count
    const tabBtn = document.querySelector('.profile-tab[data-tab="skills"]');
    if (tabBtn) {
      const count = container.querySelectorAll('.skill-tag').length;
      tabBtn.textContent = `🛠 Skills (${count})`;
    }
  } catch (ex) { alert(ex.message); }
}

async function removeSkill(skillId, userId) {
  if (!confirm('Remove this skill?')) return;
  await api('DELETE', `/api/user-skills/${skillId}`);
  const tag = document.querySelector(`.skill-tag button[onclick="removeSkill(${skillId},${userId})"]`)?.parentElement;
  if (tag) tag.remove();
  const container = document.getElementById('skills-tags-' + userId);
  if (container && !container.querySelector('.skill-tag')) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:13px">No skills added yet.</span>';
  }
  const tabBtn = document.querySelector('.profile-tab[data-tab="skills"]');
  if (tabBtn) {
    const count = container ? container.querySelectorAll('.skill-tag').length : 0;
    tabBtn.textContent = `🛠 Skills (${count})`;
  }
}

/* ── Team Rating ────────────────────────────────────────────────────────── */
let activeRatingTab = 'pm';
let activeRatingView = 'table'; // 'table' | 'analysis'

const PM_SCORE_COLS = [
  { key: 'problem_solving',      label: 'Problem\nSolving',      weight: 5  },
  { key: 'project_scoping',      label: 'Project\nScoping',      weight: 15 },
  { key: 'communication',        label: 'Communication',          weight: 15 },
  { key: 'attention_to_detail',  label: 'Attention\nto Detail',  weight: 10 },
  { key: 'attitude_towards_work',label: 'Attitude\nTo Work',     weight: 10 },
  { key: 'compliance',           label: 'Compliance',             weight: 10 },
  { key: 'client_management',    label: 'Client\nMgmt',          weight: 10 },
  { key: 'feedback_360',         label: '360°\nFeedback',         weight: 10 },
  { key: 'piex_internal',        label: 'PIEX /\nInternal',      weight: 5  },
  { key: 'engagement',           label: 'Engagement',             weight: 10 },
];

const TM_SCORE_COLS = [
  { key: 'complexity_of_work',    label: 'Complexity\nof Work',   weight: 20 },
  { key: 'avg_feedback_rating',   label: 'Avg Feedback\nRating',  weight: 35 },
  { key: 'attitude_towards_work', label: 'Attitude\nTo Work',     weight: 15 },
  { key: 'communication',         label: 'Communication',          weight: 10 },
  { key: 'learning_curve',        label: 'Learning\nCurve',       weight: 10 },
  { key: 'engagement',            label: 'Engagement',             weight: 10 },
];

async function loadTeamRating() {
  const isEmployee = currentUser.role === 'employee' && !currentUser.is_admin;

  // update page title
  const h2 = document.querySelector('#teamrating-section h2');
  if (h2) h2.textContent = isEmployee ? 'My Rating' : 'Team Rating';

  // show/hide manager controls
  $('tr-year-filter').closest('div').style.display = isEmployee ? 'none' : '';
  $('tr-export-btn').style.display = isEmployee ? 'none' : '';

  if (isEmployee) {
    $('tr-tabs-bar').innerHTML = '';
    await renderMyRating();
    return;
  }

  // manager view: PM / Team Member sub-tabs
  const tabsBar = $('tr-tabs-bar');
  tabsBar.innerHTML = `
    <button class="tr-subtab ${activeRatingTab==='pm'&&activeRatingView!=='analysis'?'active':''}" onclick="switchRatingTab('pm')">📋 Project Managers</button>
    <button class="tr-subtab ${activeRatingTab==='member'&&activeRatingView!=='analysis'?'active':''}" onclick="switchRatingTab('member')">👥 Team Members</button>
    <button class="tr-subtab tr-subtab-analysis ${activeRatingView==='analysis'?'active':''}" onclick="switchRatingView('analysis')">📊 Analysis</button>
  `;

  // year filter only (period tabs are rendered per-year inside accordion)
  const years = await api('GET', '/api/evaluations/years').catch(() => []);
  const sel = $('tr-year-filter');
  sel.innerHTML = '<option value="">All Years</option>' +
    years.map(y => `<option value="${y}">${y}</option>`).join('');
  $('tr-period-filter').style.display = 'none'; // periods shown as tabs inside each year

  await renderTeamRating();

  sel.onchange = () => renderTeamRating();
  $('tr-export-btn').onclick = () => {
    const y = $('tr-year-filter').value;
    const params = new URLSearchParams({ type: activeRatingTab });
    if (y) params.set('year', y);
    window.location.href = `/api/evaluations/export?${params}`;
  };
}

async function renderMyRating() {
  const root = $('teamrating-root');
  const evals = await api('GET', `/api/evaluations/${currentUser.id}`).catch(() => []);

  if (!evals.length) {
    root.innerHTML = `<div class="empty-state" style="padding:80px;text-align:center">
      <div style="font-size:40px;margin-bottom:12px">📊</div>
      <h3 style="margin-bottom:8px">No ratings yet</h3>
      <p style="color:var(--text-muted)">Your performance ratings will appear here once uploaded by your manager.</p>
    </div>`;
    return;
  }

  const netColor  = v => v >= 8.5 ? '#059669' : v >= 7 ? '#d97706' : v >= 5 ? '#dc2626' : '#9ca3af';
  const netBg     = v => v >= 8.5 ? '#d1fae5' : v >= 7 ? '#fef3c7' : v >= 5 ? '#fee2e2' : '#f3f4f6';
  const netLabel  = v => v >= 8.5 ? 'Excellent' : v >= 7 ? 'Good' : v >= 5 ? 'Needs Improvement' : '—';
  const barColor  = v => v >= 8 ? '#22c55e' : v >= 6 ? '#f59e0b' : v ? '#ef4444' : '#e5e7eb';
  const textColor = v => v >= 8 ? '#15803d' : v >= 6 ? '#b45309' : v ? '#b91c1c' : '#9ca3af';
  const PERIOD_ORDER = ['H1','H2','Q1','Q2','Q3','Q4','Annual'];

  // group by year → sorted periods
  const grouped = {};
  for (const e of evals) {
    if (!grouped[e.year]) grouped[e.year] = [];
    grouped[e.year].push(e);
  }

  const buildBreakdown = (ev, uid) => {
    const COLS = ev.eval_type === 'member' ? TM_SCORE_COLS : PM_SCORE_COLS;
    const rows = COLS.map(col => {
      const v = ev[col.key];
      const pct = v ? Math.round((v/10)*100) : 0;
      return '<div>' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">' +
          '<span style="font-size:.87rem;font-weight:600;color:#374151">' + col.label.replace(/\n/g,' ') + '</span>' +
          '<span style="font-size:1rem;font-weight:700;color:' + textColor(v) + '">' + (v != null ? v : '—') +
            ' <span style="font-size:.7rem;font-weight:400;color:#9ca3af">/10 · ' + col.weight + '%</span></span>' +
        '</div>' +
        '<div style="background:#f3f4f6;border-radius:99px;height:7px;overflow:hidden">' +
          '<div style="width:' + pct + '%;height:100%;background:' + barColor(v) + ';border-radius:99px"></div>' +
        '</div></div>';
    }).join('');
    const aoi = ev.area_of_improvement
      ? '<div style="margin-top:20px;background:#f8fafc;border-left:3px solid #94a3b8;padding:10px 14px;border-radius:0 6px 6px 0;font-size:.85rem;color:#475569"><strong>Area of Improvement:</strong> ' + ev.area_of_improvement + '</div>'
      : '';
    return '<div id="detail-' + uid + '" style="display:none;padding:24px 28px;border-top:1px solid #f0f0f0">' +
      '<div style="font-size:.7rem;font-weight:700;color:#9ca3af;letter-spacing:.08em;text-transform:uppercase;margin-bottom:18px">Score Breakdown</div>' +
      '<div style="display:flex;flex-direction:column;gap:16px">' + rows + '</div>' + aoi + '</div>';
  };

  let html = '<div style="max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:32px">';

  for (const [yr, periods] of Object.entries(grouped).sort((a,b) => Number(b[0])-Number(a[0]))) {
    const sorted = periods.slice().sort((a,b) =>
      PERIOD_ORDER.indexOf(a.period||'Annual') - PERIOD_ORDER.indexOf(b.period||'Annual'));

    html += '<div>' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">' +
        '<div style="background:linear-gradient(135deg,#1a3c2e,#2d6a4f);color:#fff;font-size:1rem;font-weight:800;padding:6px 18px;border-radius:99px;letter-spacing:.03em">' + yr + '</div>' +
        '<div style="flex:1;height:1px;background:linear-gradient(to right,#d1fae5,transparent)"></div>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px">';

    for (const ev of sorted) {
      const net = ev.net_rating;
      const period = ev.period || 'Annual';
      const uid = yr + '-' + period;
      const COLS = ev.eval_type === 'member' ? TM_SCORE_COLS : PM_SCORE_COLS;
      const barW = net ? Math.round((net/10)*100) : 0;

      html +=
        '<div style="background:#fff;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.07);overflow:hidden">' +
          '<div onclick="toggleMyRatingDetail(\'' + uid + '\')" style="display:flex;align-items:center;gap:20px;padding:20px 24px;cursor:pointer;user-select:none">' +
            '<div style="background:#1a3c2e;color:#fff;border-radius:10px;padding:10px 18px;text-align:center;min-width:72px;flex-shrink:0">' +
              '<div style="font-size:1.1rem;font-weight:800;line-height:1">' + period + '</div>' +
              '<div style="font-size:.65rem;opacity:.65;margin-top:3px">' + yr + '</div>' +
            '</div>' +
            '<div style="flex:1">' +
              '<div style="font-size:.75rem;color:#9ca3af;margin-bottom:6px">' + COLS.length + ' parameters · Weighted score</div>' +
              '<div style="background:#f3f4f6;border-radius:99px;height:10px;overflow:hidden">' +
                '<div style="width:' + barW + '%;height:100%;background:' + netColor(net) + ';border-radius:99px"></div>' +
              '</div>' +
            '</div>' +
            '<div style="text-align:right;flex-shrink:0">' +
              '<div style="font-size:1.6rem;font-weight:800;color:' + netColor(net) + '">' + (net ? net.toFixed(2) : '—') + '</div>' +
              '<div style="font-size:.72rem;background:' + netBg(net) + ';color:' + netColor(net) + ';padding:2px 10px;border-radius:99px;font-weight:600;display:inline-block">' + netLabel(net) + '</div>' +
            '</div>' +
            '<div id="chevron-' + uid + '" style="font-size:.9rem;color:#9ca3af;transition:transform .25s;flex-shrink:0">▼</div>' +
          '</div>' +
          buildBreakdown(ev, uid) +
        '</div>';
    }
    html += '</div></div>';
  }
  html += '</div>';
  root.innerHTML = html;
}

function toggleMyRatingDetail(uid) {
  const detail = document.getElementById('detail-' + uid);
  const chevron = document.getElementById('chevron-' + uid);
  const open = detail.style.display === 'none';
  detail.style.display = open ? 'block' : 'none';
  chevron.style.transform = open ? 'rotate(180deg)' : '';
}

function switchRatingTab(tab) {
  activeRatingTab = tab;
  activeRatingView = 'table';
  document.querySelectorAll('.tr-subtab').forEach(b => {
    if (b.classList.contains('tr-subtab-analysis')) { b.classList.remove('active'); return; }
    b.classList.toggle('active', b.textContent.includes('Manager') ? tab === 'pm' : tab === 'member');
  });
  renderTeamRating();
}

function switchRatingView(view) {
  activeRatingView = view;
  document.querySelectorAll('.tr-subtab').forEach(b => {
    if (b.classList.contains('tr-subtab-analysis')) { b.classList.toggle('active', view === 'analysis'); return; }
    if (view === 'analysis') { b.classList.remove('active'); return; }
    b.classList.toggle('active', b.textContent.includes('Manager') ? activeRatingTab === 'pm' : activeRatingTab === 'member');
  });
  if (view === 'analysis') renderRatingAnalysis();
  else renderTeamRating();
}

async function renderTeamRating() {
  const yearFilter = $('tr-year-filter').value;
  const SCORE_COLS = activeRatingTab === 'member' ? TM_SCORE_COLS : PM_SCORE_COLS;
  const PERIOD_ORDER = ['H1','H2','Q1','Q2','Q3','Q4','Annual'];

  const params = new URLSearchParams({ type: activeRatingTab });
  if (yearFilter) params.set('year', yearFilter);
  const rows = await api('GET', `/api/evaluations?${params}`).catch(() => []);
  const root = $('teamrating-root');

  if (!rows.length) {
    root.innerHTML = `<div class="empty-state" style="padding:80px;text-align:center">
      <div style="font-size:40px;margin-bottom:12px">📊</div>
      <h3 style="margin-bottom:8px">No ratings uploaded yet</h3>
      <p style="color:var(--text-muted)">Use "Upload Ratings" on the Team page to add evaluation data.</p>
    </div>`;
    return;
  }

  // Group: year → period → members[]
  const byYear = {};
  for (const r of rows) {
    const p = r.period || 'Annual';
    if (!byYear[r.year]) byYear[r.year] = {};
    if (!byYear[r.year][p]) byYear[r.year][p] = [];
    byYear[r.year][p].push(r);
  }

  const netColor = v => v >= 8.5 ? '#059669' : v >= 7 ? '#d97706' : v >= 5 ? '#dc2626' : '#9ca3af';
  const netBg    = v => v >= 8.5 ? '#d1fae5' : v >= 7 ? '#fef3c7' : v >= 5 ? '#fee2e2' : '#f3f4f6';
  const medal    = i => ['🥇','🥈','🥉'][i] || `#${i+1}`;

  const miniCard = (m, isTop) => {
    const net = m.net_rating || 0;
    const barPct = Math.round(net / 10 * 100);
    const color = isTop ? '#059669' : '#dc2626';
    const bg    = isTop ? 'linear-gradient(135deg,#ecfdf5,#d1fae5)' : 'linear-gradient(135deg,#fff5f5,#fee2e2)';
    return `<div class="tr-mini-card" style="background:${bg};border:1px solid ${isTop?'#a7f3d0':'#fecaca'}" onclick="openProfile(${m.user_id})">
      <div class="avatar" style="width:34px;height:34px;font-size:11px;flex-shrink:0">${m.avatar_initials||m.member_name[0]}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.member_name.split(' ')[0]}</div>
        <div style="background:rgba(0,0,0,.08);border-radius:99px;height:5px;margin-top:5px;overflow:hidden">
          <div style="width:${barPct}%;height:100%;background:${color};border-radius:99px"></div>
        </div>
      </div>
      <div style="font-size:1.25rem;font-weight:800;color:${color};flex-shrink:0">${net.toFixed(1)}</div>
    </div>`;
  };

  const scoreHeaders = SCORE_COLS.map(c =>
    `<th class="tr-th-score" title="${c.label.replace('\n',' ')} — ${c.weight}%">${c.label.replace('\n','<br>')}<br><span class="tr-weight">${c.weight}%</span></th>`
  ).join('');

  const buildTable = (members, periodId) => {
    const tableId = `tr-tbl-${periodId}`;
    const sorted  = [...members].sort((a,b) => (b.net_rating||0)-(a.net_rating||0));
    const scoreCells = m => SCORE_COLS.map(c => {
      const v=m[c.key], bg=v>=8?'#d1fae5':v>=6?'#fef3c7':v!=null?'#fee2e2':'#f3f4f6',
            col=v>=8?'#065f46':v>=6?'#92400e':v!=null?'#991b1b':'#9ca3af';
      return `<td style="text-align:center"><span class="tr-score-badge" style="background:${bg};color:${col}">${v!=null?v:'—'}</span></td>`;
    }).join('');
    const aoi = m => activeRatingTab==='member'
      ? `<td class="tr-td-muted">${m.area_of_improvement?(m.area_of_improvement.substring(0,55)+(m.area_of_improvement.length>55?'…':'')):'—'}</td>` : '';

    return `
    <div class="tr-table-controls">
      <div class="search-wrap" style="max-width:240px">
        <svg class="search-icon" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <input type="text" placeholder="Search by name…" oninput="filterRatingTable('${tableId}',this.value)" />
      </div>
      <div class="tr-sort-btns">
        <span style="font-size:12px;color:var(--text-muted)">Sort:</span>
        <button class="tr-sort-btn active" data-tid="${tableId}" data-col="net" data-dir="desc" onclick="handleRatingSort(this)">Highest ↓</button>
        <button class="tr-sort-btn" data-tid="${tableId}" data-col="net" data-dir="asc" onclick="handleRatingSort(this)">Lowest ↑</button>
        <button class="tr-sort-btn" data-tid="${tableId}" data-col="name" data-dir="asc" onclick="handleRatingSort(this)">A → Z</button>
      </div>
    </div>
    <div class="tr-table-wrap">
      <table class="tr-table" id="${tableId}">
        <colgroup>
          <col style="width:32px"><col style="width:130px">
          ${SCORE_COLS.map(()=>'<col style="width:66px">').join('')}
          <col style="width:70px">
          ${activeRatingTab==='member'?'<col style="width:120px">':''}
          <col style="width:36px">
        </colgroup>
        <thead><tr>
          <th>#</th><th class="tr-th-left">Name</th>
          ${scoreHeaders}
          <th>Net<br>Rating</th>
          ${activeRatingTab==='member'?'<th class="tr-th-left">Area of Improvement</th>':''}
          <th></th>
        </tr></thead>
        <tbody>
          ${sorted.map((m,i) => {
            const net=m.net_rating;
            return `<tr class="tr-row" data-name="${m.member_name.toLowerCase()}" data-net="${net||0}" onclick="openProfile(${m.user_id})">
              <td style="text-align:center;font-size:14px">${medal(i)}</td>
              <td><div style="display:flex;align-items:center;gap:7px">
                <div class="avatar" style="width:28px;height:28px;font-size:10px;flex-shrink:0">${m.avatar_initials||m.member_name[0]}</div>
                <span style="font-weight:600;font-size:12px">${m.member_name}</span>
              </div></td>
              ${scoreCells(m)}
              <td style="text-align:center"><span class="tr-net-chip" style="background:${netBg(net||0)};color:${netColor(net||0)}">${net!=null?net.toFixed(2):'—'}</span></td>
              ${aoi(m)}
              <td style="text-align:center" onclick="event.stopPropagation()">
                <button onclick="deleteEvalRow(${m.id})" class="tr-del-btn" title="Delete rating">
                  <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:#ef4444"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  };

  const years = Object.keys(byYear).sort((a,b) => Number(b)-Number(a));
  let html = '<div style="display:flex;flex-direction:column;gap:12px">';

  years.forEach((yr, yi) => {
    const periods    = byYear[yr];
    const allRows    = Object.values(periods).flat();
    const rated      = allRows.filter(r=>r.net_rating);
    const yrAvg      = rated.length ? rated.reduce((s,r)=>s+r.net_rating,0)/rated.length : 0;
    const allSorted  = [...allRows].sort((a,b)=>(b.net_rating||0)-(a.net_rating||0));
    const topScore   = allSorted[0]?.net_rating;
    const lowScore   = allSorted[allSorted.length-1]?.net_rating;
    const memberCnt  = new Set(allRows.map(r=>r.user_id)).size;
    const isExpanded = yi === 0;
    const sortedPeriods = Object.keys(periods).sort((a,b) =>
      PERIOD_ORDER.indexOf(a) - PERIOD_ORDER.indexOf(b));
    const defaultPeriod = sortedPeriods.includes('Annual') ? 'Annual' : sortedPeriods[0];

    html += `
    <div class="tr-yr-accordion">
      <div class="tr-yr-acc-header" onclick="toggleYrAccordion('${yr}')">
        <div class="tr-yr-acc-pill">${yr}</div>
        <div class="tr-yr-acc-meta">
          <span>${memberCnt} member${memberCnt!==1?'s':''} · ${allRows.length} evaluation${allRows.length!==1?'s':''}</span>
          <span>Avg <strong style="color:${netColor(yrAvg)}">${yrAvg.toFixed(2)}</strong></span>
          <span style="color:#059669;font-weight:600">▲ ${topScore?.toFixed(2)||'—'}</span>
          <span style="color:#dc2626;font-weight:600">▼ ${lowScore?.toFixed(2)||'—'}</span>
        </div>
        <div class="tr-yr-acc-chev" id="yracc-chev-${yr}">${isExpanded?'▲':'▼'}</div>
      </div>

      <div class="tr-yr-acc-body" id="yracc-body-${yr}" style="${isExpanded?'':'display:none'}">
        ${sortedPeriods.length > 1 ? `
        <div class="tr-period-tabs" id="ptabs-${yr}">
          ${sortedPeriods.map(p=>`
            <button class="tr-period-tab${p===defaultPeriod?' active':''}"
              onclick="switchYrPeriod('${yr}','${p}',this)">${p}</button>
          `).join('')}
        </div>` : ''}

        ${sortedPeriods.map(p => {
          const members  = [...periods[p]].sort((a,b)=>(b.net_rating||0)-(a.net_rating||0));
          const top2     = members.slice(0,2);
          const bot2     = members.slice(-2).filter(m=>!top2.find(t=>t.user_id===m.user_id));
          const avg      = members.filter(m=>m.net_rating).reduce((s,m)=>s+m.net_rating,0)/(members.filter(m=>m.net_rating).length||1);
          const periodId = `${yr}-${p}`;

          return `
          <div class="tr-period-panel" id="ppanel-${periodId}" style="${p===defaultPeriod?'':'display:none'}">
            <div class="tr-period-stats">
              <span class="tr-ps-pill">${members.length} evaluated</span>
              <span class="tr-ps-pill" style="color:${netColor(avg)}">Avg ${avg.toFixed(2)}</span>
            </div>
            <div class="tr-top-bot-strip">
              <div class="tr-top-bot-half">
                <div class="tr-top-bot-label">🏆 Top Performers</div>
                ${top2.map(m=>miniCard(m,true)).join('')}
              </div>
              ${bot2.length ? `
              <div class="tr-top-bot-half">
                <div class="tr-top-bot-label">📈 Needs Improvement</div>
                ${bot2.map(m=>miniCard(m,false)).join('')}
              </div>` : ''}
            </div>
            ${buildTable(members, periodId)}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  });

  html += '</div>';
  root.innerHTML = html;
}

async function renderRatingAnalysis() {
  const SCORE_COLS = activeRatingTab === 'member' ? TM_SCORE_COLS : PM_SCORE_COLS;
  const yearFilter = $('tr-year-filter').value;
  const root = $('teamrating-root');
  root.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">Crunching numbers…</div>';

  const allRows = await api('GET', `/api/evaluations?type=${activeRatingTab}`).catch(() => []);
  if (!allRows.length) {
    root.innerHTML = `<div class="empty-state" style="padding:80px;text-align:center"><div style="font-size:40px;margin-bottom:12px">📊</div><h3 style="margin-bottom:8px">No data to analyse</h3><p style="color:var(--text-muted)">Upload some ratings first.</p></div>`;
    return;
  }
  const rows = yearFilter ? allRows.filter(r => String(r.year) === yearFilter) : allRows;

  const netColor = v => v >= 8.5 ? '#059669' : v >= 7.5 ? '#16a34a' : v >= 7 ? '#d97706' : '#dc2626';
  const medal = i => ['🥇','🥈','🥉','4️⃣','5️⃣'][i] || `#${i+1}`;

  // === Panel 1: Leaderboard ===
  const byUser = {};
  for (const r of rows) {
    if (!byUser[r.user_id]) byUser[r.user_id] = { name: r.member_name, ini: r.avatar_initials || r.member_name[0], vals: [], uid: r.user_id };
    if (r.net_rating != null) byUser[r.user_id].vals.push(r.net_rating);
  }
  const ranked = Object.values(byUser)
    .filter(u => u.vals.length)
    .map(u => ({ ...u, avg: u.vals.reduce((s,v)=>s+v,0)/u.vals.length }))
    .sort((a,b) => b.avg - a.avg);
  const top5 = ranked.slice(0, 5);
  const bot5 = [...ranked].reverse().slice(0, 5).filter(u => !top5.find(t => t.uid === u.uid));

  const lbRow = (u, i, isTop) => {
    const pct = Math.round((u.avg / 10) * 100);
    const col = isTop ? '#059669' : '#dc2626';
    return `<div class="an-lb-row" onclick="openProfile(${u.uid})">
      <span class="an-lb-rank">${isTop ? medal(i) : ''}</span>
      <div class="avatar" style="width:26px;height:26px;font-size:9px;flex-shrink:0">${u.ini}</div>
      <span class="an-lb-name">${u.name}</span>
      <div class="an-bar-wrap"><div class="an-bar" style="width:${pct}%;background:${col}"></div></div>
      <span class="an-lb-score" style="color:${col}">${u.avg.toFixed(2)}</span>
      <span class="an-lb-cnt">${u.vals.length} eval${u.vals.length!==1?'s':''}</span>
    </div>`;
  };

  // === Panel 2: Parameter Breakdown ===
  const paramData = SCORE_COLS.map(col => {
    const vals = rows.map(r => r[col.key]).filter(v => v != null);
    return { ...col, avg: vals.length ? vals.reduce((s,v)=>s+v,0)/vals.length : 0 };
  }).sort((a,b) => b.avg - a.avg);

  const paramRow = (p, i) => {
    const pct = Math.round((p.avg / 10) * 100);
    const col = p.avg >= 8.5 ? '#059669' : p.avg >= 7.5 ? '#16a34a' : p.avg >= 7 ? '#d97706' : '#dc2626';
    const badge = i === 0 ? ' 🏆' : i === paramData.length - 1 ? ' ⚠️' : '';
    return `<div class="an-param-row">
      <span class="an-param-label">${p.label.replace('\n',' ')}${badge} <span class="an-param-wt">${p.weight}%</span></span>
      <div class="an-bar-wrap" style="flex:1"><div class="an-bar" style="width:${pct}%;background:${col}"></div></div>
      <span class="an-param-score" style="color:${col}">${p.avg ? p.avg.toFixed(2) : '—'}</span>
    </div>`;
  };

  // === Panel 3: Score Distribution ===
  const buckets = [
    { label: '9 – 10', sub: 'Excellent',    min: 9, max: 11, color: '#059669' },
    { label: '8 – 9',  sub: 'Good+',        min: 8, max: 9,  color: '#16a34a' },
    { label: '7 – 8',  sub: 'Good',         min: 7, max: 8,  color: '#d97706' },
    { label: '6 – 7',  sub: 'Average',      min: 6, max: 7,  color: '#f59e0b' },
    { label: '< 6',    sub: 'Needs Work',   min: 0, max: 6,  color: '#dc2626' },
  ];
  const netVals = rows.filter(r => r.net_rating != null).map(r => r.net_rating);
  const bktData = buckets.map(b => ({ ...b, n: netVals.filter(v => v >= b.min && v < b.max).length }));
  const maxBkt = Math.max(...bktData.map(b => b.n), 1);

  const distRow = b => {
    const pct = Math.round((b.n / maxBkt) * 100);
    return `<div class="an-bucket-row">
      <div class="an-bkt-label">
        <span class="an-bkt-range" style="color:${b.color}">${b.label}</span>
        <span class="an-bkt-sub">${b.sub}</span>
      </div>
      <div class="an-bar-wrap" style="flex:1"><div class="an-bar" style="width:${pct}%;background:${b.color}"></div></div>
      <span class="an-bkt-n" style="color:${b.color}">${b.n}</span>
    </div>`;
  };

  // === Panel 4: YOY Trend (SVG line chart) ===
  const byYr = {};
  for (const r of allRows) {
    if (r.net_rating == null) continue;
    if (!byYr[r.year]) byYr[r.year] = [];
    byYr[r.year].push(r.net_rating);
  }
  const trendPts = Object.keys(byYr).sort().map(yr => ({
    yr, avg: byYr[yr].reduce((s,v)=>s+v,0)/byYr[yr].length, n: byYr[yr].length
  }));

  const trendSvg = () => {
    if (trendPts.length < 2) {
      const pt = trendPts[0];
      if (!pt) return `<div style="text-align:center;padding:40px;color:var(--text-muted)">No trend data yet</div>`;
      return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:140px;gap:8px">
        <div style="font-size:2.5rem;font-weight:800;color:${netColor(pt.avg)}">${pt.avg.toFixed(2)}</div>
        <div style="font-size:13px;color:var(--text-muted)">${pt.yr} · ${pt.n} evaluation${pt.n!==1?'s':''}</div>
        <div style="font-size:11px;color:var(--text-muted)">Add ratings from more years to see a trend</div>
      </div>`;
    }
    const W=520, H=150, PL=36, PR=16, PT=18, PB=34;
    const cW=W-PL-PR, cH=H-PT-PB;
    const allAvgs = trendPts.map(p=>p.avg);
    const minV = Math.max(0, Math.min(...allAvgs)-0.8);
    const maxV = Math.min(10, Math.max(...allAvgs)+0.8);
    const xStep = trendPts.length > 1 ? cW/(trendPts.length-1) : cW;
    const xOf = i => PL + i * xStep;
    const yOf = v => PT + cH - ((v-minV)/(maxV-minV||1))*cH;

    const pts = trendPts.map((p,i) => ({ ...p, x: xOf(i), y: yOf(p.avg) }));
    const line = pts.map((p,i)=>`${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L${pts.at(-1).x.toFixed(1)},${(PT+cH).toFixed(1)} L${pts[0].x.toFixed(1)},${(PT+cH).toFixed(1)} Z`;

    const yTicks = [minV, (minV+maxV)/2, maxV];

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px">
      <defs>
        <linearGradient id="an-tg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#059669" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="#059669" stop-opacity="0.01"/>
        </linearGradient>
      </defs>
      ${yTicks.map(v=>`
        <line x1="${PL}" y1="${yOf(v).toFixed(1)}" x2="${W-PR}" y2="${yOf(v).toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>
        <text x="${PL-4}" y="${(yOf(v)+4).toFixed(1)}" text-anchor="end" font-size="9" fill="#9ca3af">${v.toFixed(1)}</text>
      `).join('')}
      <path d="${area}" fill="url(#an-tg)"/>
      <path d="${line}" fill="none" stroke="#059669" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map(p=>`
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="#059669" stroke="#fff" stroke-width="2"/>
        <text x="${p.x.toFixed(1)}" y="${(p.y-10).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="#059669">${p.avg.toFixed(2)}</text>
        <text x="${p.x.toFixed(1)}" y="${(PT+cH+14).toFixed(1)}" text-anchor="middle" font-size="10" fill="#6b7280">${p.yr}</text>
        <text x="${p.x.toFixed(1)}" y="${(PT+cH+25).toFixed(1)}" text-anchor="middle" font-size="9" fill="#9ca3af">${p.n} eval${p.n!==1?'s':''}</text>
      `).join('')}
    </svg>`;
  };

  root.innerHTML = `
  <div class="an-group-toggle">
    <span class="an-group-label">Analysing:</span>
    <button class="an-group-btn ${activeRatingTab==='pm'?'active':''}" onclick="activeRatingTab='pm';renderRatingAnalysis()">📋 Project Managers</button>
    <button class="an-group-btn ${activeRatingTab==='member'?'active':''}" onclick="activeRatingTab='member';renderRatingAnalysis()">👥 Team Members</button>
  </div>
  <div class="an-grid">
    <div class="an-panel">
      <div class="an-panel-title">🏆 Leaderboard</div>
      <div class="an-panel-sub">${yearFilter ? `${yearFilter} · ` : 'All time · '}avg net rating</div>
      <div class="an-section-label">Top ${top5.length}</div>
      ${top5.map((u,i) => lbRow(u,i,true)).join('')}
      ${bot5.length ? `<div class="an-section-label" style="margin-top:14px">Bottom ${bot5.length}</div>${bot5.map((u,i) => lbRow(u,i,false)).join('')}` : ''}
      ${ranked.length === 0 ? '<div style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:20px">No rated members yet</div>' : ''}
    </div>

    <div class="an-panel">
      <div class="an-panel-title">📊 Parameter Breakdown</div>
      <div class="an-panel-sub">Team avg per parameter · sorted by score</div>
      ${paramData.map((p,i) => paramRow(p,i)).join('')}
    </div>

    <div class="an-panel">
      <div class="an-panel-title">📈 Score Distribution</div>
      <div class="an-panel-sub">${netVals.length} rating${netVals.length!==1?'s':''} · net score buckets</div>
      ${bktData.map(b => distRow(b)).join('')}
    </div>

    <div class="an-panel">
      <div class="an-panel-title">📅 Year-over-Year Trend</div>
      <div class="an-panel-sub">Team avg net rating per year${yearFilter ? ' (all years shown)' : ''}</div>
      ${trendSvg()}
    </div>
  </div>`;
}

async function deleteEvalRow(evalId) {
  if (!confirm('Delete this rating? This cannot be undone.')) return;
  try {
    await api('DELETE', `/api/evaluations/${evalId}`);
    await renderTeamRating();
  } catch (ex) { alert(ex.message); }
}

function toggleYrAccordion(yr) {
  const body = document.getElementById('yracc-body-' + yr);
  const chev = document.getElementById('yracc-chev-' + yr);
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  chev.textContent = open ? '▼' : '▲';
}

function switchYrPeriod(yr, period, btn) {
  document.querySelectorAll(`#ptabs-${yr} .tr-period-tab`).forEach(b => b.classList.toggle('active', b===btn));
  document.querySelectorAll(`[id^="ppanel-${yr}-"]`).forEach(p => {
    p.style.display = p.id === `ppanel-${yr}-${period}` ? '' : 'none';
  });
}

function filterRatingTable(tableId, q) {
  const tbody = document.querySelector('#' + tableId + ' tbody');
  if (!tbody) return;
  const term = q.toLowerCase().trim();
  tbody.querySelectorAll('tr').forEach(row => {
    row.style.display = (!term || row.dataset.name.includes(term)) ? '' : 'none';
  });
}

function handleRatingSort(btn) {
  const tableId = btn.dataset.tid;
  const col = btn.dataset.col;
  const dir = btn.dataset.dir;
  // update active button
  btn.closest('.tr-sort-btns').querySelectorAll('.tr-sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  sortRatingTable(tableId, col, dir);
}

function sortRatingTable(tableId, col, dir) {
  const tbody = document.querySelector('#' + tableId + ' tbody');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr'));
  rows.sort((a, b) => {
    if (col === 'name') {
      return dir === 'asc'
        ? a.dataset.name.localeCompare(b.dataset.name)
        : b.dataset.name.localeCompare(a.dataset.name);
    }
    const av = parseFloat(a.dataset.net) || 0;
    const bv = parseFloat(b.dataset.net) || 0;
    return dir === 'asc' ? av - bv : bv - av;
  });
  rows.forEach(r => tbody.appendChild(r));
}

/* ── Init ───────────────────────────────────────────────────────────────── */
(async () => {
  try {
    const user = await api('GET', '/api/auth/me');
    await onLogin(user);
  } catch {
    // not logged in — show login page
  }
})();
