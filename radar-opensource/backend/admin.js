// admin.js - 从 admin.html 拆出 (god file 拆分)
// 包含 admin 后台全部业务逻辑: API 调用 / token 管理 / dashboard / tabs / charts

const API = location.origin;
const PAGE_SIZE = 100;
let token = localStorage.getItem('admin_token') || '';
let currentTab = 'rooms';
let refreshTimer = null;

// ── 美化 Toast / Confirm（角色状态图标 + 玻璃） ──
let _toastTimer = null;

function normalizePromptType(type) {
  const map = {
    success: 'ok', ok: 'ok',
    error: 'error', err: 'error', fail: 'error', danger: 'danger',
    warn: 'warn', warning: 'warn',
    info: 'info', prompt: 'info',
  };
  return map[String(type || '').toLowerCase()] || 'info';
}

function inferConfirmType(msg) {
  const s = String(msg || '');
  if (/不可恢复|清空全部|Clear ALL|cannot be undone|删除此录制|Delete this recording|确定删除|Delete announcement/i.test(s)) {
    return 'danger';
  }
  if (/关闭房间|解封|移除|Enable room whitelist|Disable room whitelist|开启房间白名单|关闭房间白名单|保留最近|Keep only/i.test(s)) {
    return 'warn';
  }
  return 'warn';
}

function promptTitleFor(type) {
  const key = ({
    ok: 'prompt_title_ok',
    error: 'prompt_title_error',
    danger: 'prompt_title_danger',
    warn: 'prompt_title_warn',
    info: 'prompt_title_info',
  })[type] || 'prompt_title_info';
  return t(key);
}

function setConfirmChrome(type, title) {
  const box = document.getElementById('confirmBox');
  const titleEl = document.getElementById('confirmTitle');
  const tType = normalizePromptType(type);
  if (box) box.setAttribute('data-type', tType === 'error' ? 'error' : tType);
  if (titleEl) titleEl.textContent = title || promptTitleFor(tType);
}

function showAlert(msg, type) {
  const tType = normalizePromptType(type || 'error');
  let el = document.getElementById('adminToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'adminToast';
    el.className = 'admin-toast';
    document.body.appendChild(el);
  }
  el.className = 'admin-toast is-' + (tType === 'danger' ? 'error' : tType);
  el.innerHTML =
    '<div class="prompt-avatar sm">' +
      '<img src="/assets/about-icon.png" alt="" width="44" height="44">' +
      '<span class="prompt-badge" aria-hidden="true"></span>' +
    '</div>' +
    '<div class="admin-toast-body">' +
      '<div class="admin-toast-title">' + esc(promptTitleFor(tType === 'danger' ? 'error' : tType)) + '</div>' +
      '<div class="admin-toast-msg">' + esc(String(msg || '')) + '</div>' +
    '</div>';
  el.onclick = () => { el.classList.remove('show'); };
  requestAnimationFrame(() => { el.classList.add('show'); });
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove('show'); }, 4200);
}

// ── State ──
let _allRooms = [], _allBans = [];
let roomPage = 0, banPage = 0;

// ── Auth ──
async function doLogin() {
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  const err = document.getElementById('loginErr');
  err.textContent = '';
  try {
    const res = await fetch(API + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass })
    });
    const data = await res.json();
    if (data.ok) { token = data.token; localStorage.setItem('admin_token', token); showDashboard(); }
    else { err.textContent = data.remain > 0 ? t('login_err_frozen').replace('{n}', data.remain) : (data.error || t('login_err_failed')); }
  } catch (e) { err.textContent = t('login_err_network'); }
}
function doLogout() { token = ''; localStorage.removeItem('admin_token'); document.getElementById('loginView').style.display = 'flex'; document.getElementById('dashView').classList.remove('show'); if (refreshTimer) clearInterval(refreshTimer); }
async function showDashboard() {
  document.getElementById('loginView').style.display = 'none';
  const hash = location.hash.replace('#', '');
  const validViews = ['dashboard','theme','announcement','security','about','recordings'];
  if (hash && validViews.includes(hash)) {
    const viewId = 'view' + hash.charAt(0).toUpperCase() + hash.slice(1);
    document.querySelectorAll('.app-nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === hash));
    document.querySelectorAll('.app-view').forEach(v => v.classList.toggle('active', v.id === viewId));
  }
  document.getElementById('dashView').classList.add('show');
  await loadFrontendAccess(); await refreshData(); loadTheme(); bindFrontendLinks(); loadMe();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshData, 3000);
  if (hash && validViews.includes(hash)) {
    if (hash === 'theme') { loadPreviewMaster(); loadThemeNames(); }
    if (hash === 'security') loadSecurityView();
    if (hash === 'about') renderChangelog();
    if (hash === 'announcement') loadAnnouncements();
    if (hash === 'recordings') loadRecordingsView();
  }
}

// ══════════════════════════════════════════════════════════
// i18n (简体中文 / English) - 默认 zh, localStorage 记忆
// ══════════════════════════════════════════════════════════
const I18N = {
  zh: {
    // 通用
    confirm: '确定', cancel: '取消', submit: '提交', close: '关闭', delete: '删除',
    loading: '加载中...', empty: '暂无数据', refresh: '刷新',
    prompt_title_ok: '成功', prompt_title_error: '失败', prompt_title_danger: '危险操作',
    prompt_title_warn: '请确认', prompt_title_info: '提示', prompt_title_input: '请输入',
    // 顶栏 / 用户菜单
    uptime: '运行', logged_in_as: '当前账号',
    change_account: '修改账号', change_password: '修改密码', logout: '退出登录',
    // 侧栏
    sidebar_logo: 'Relay 后台', sidebar_foot: 'Relay v1.8.0',
    nav_dashboard: '总览', nav_theme: '主题', nav_announcement: '公告', nav_security: '安全', nav_about: '关于',
    // 公告 (Announcement)
    view_announcement: '公告', announcement_subtitle: '向前端用户推送通知 · 实时生效',
    ann_add: '+ 新建公告', ann_search_ph: '搜索标题或内容...',
    ann_empty: '暂无公告 · 点上方"新建公告"开始',
    ann_no_title: '(无标题)',
    ann_modal_title_new: '新建公告', ann_modal_title_edit: '编辑公告',
    ann_field_title: '标题', ann_field_type: '类型',
    ann_field_content: '内容（支持换行）',
    ann_field_enabled: '启用', ann_field_pinned: '置顶',
    ann_type_info: '提示', ann_type_warn: '警告',
    ann_type_error: '错误', ann_type_success: '成功',
    ann_field_display: '展示样式',
    ann_display_panel:  '面板',  ann_display_modal:  '弹窗',
    ann_display_banner: '横幅',  ann_display_toast: '提示',
    ann_display_hint_panel:  '仅在右下角铃铛面板出现（默认）',
    ann_display_hint_modal:  '用户首次进入页面会居中弹出（关闭后不再弹）',
    ann_display_hint_banner: '页面顶部长期横幅（直到用户主动关闭）',
    ann_display_hint_toast:  '右上角悬浮 4 秒自动消失（关闭后不再弹）',
    ann_badge_enabled: '已启用', ann_badge_disabled: '已禁用', ann_badge_pinned: '置顶',
    ann_action_edit: '编辑', ann_action_enable: '启用', ann_action_disable: '禁用',
    ann_action_delete: '删除',
    ann_meta_created: '创建', ann_meta_updated: '更新',
    ann_confirm_delete: '确定删除公告"{title}"？',
    ann_err_empty: '标题和内容至少填一项',
    ann_save_failed: '保存失败',
    // About
    view_about: '关于', about_subtitle: '产品信息 · 更新日志',
    about_product_name: 'Relay 后台',
    about_product_desc: 'WSRadar Web 系统的管理后台 · WS 中继 + 主题切换 + 实时统计',
    about_changelog: '更新日志',
    about_latest: '最新', about_upstream: '原作者',
    tag_add: '新增', tag_fix: '修复', tag_improve: '优化', tag_del: '删除',
    // Dashboard view header
    view_dashboard: '总览', dashboard_subtitle: '实时数据 · 3s 自动刷新',
    // 统计卡
    stat_rooms: '房间数', stat_pubs: 'DLL 连接', stat_subs: '观看者', stat_bans: '封禁 IP',
    stat_dl_sec: '⬇ 下载速率 (DLL→服务器)', stat_ul_sec: '⬆ 上传速率 (服务器→观看者)',
    stat_dl_total: '⬇ 下载总量', stat_ul_total: '⬆ 上传总量',
    // Tabs
    tab_rooms: '房间列表', tab_bans: '封禁列表', tab_room_events: '房间记录', tab_ban_events: '封禁记录',
    th_role: '角色', th_event: '事件', th_time_col: '时间', th_duration_col: '时长',
    evt_connect: '连接', evt_disconnect: '断开', evt_ban: '封禁', evt_unban: '解封',
    role_pub: 'DLL', role_sub: '观看者',
    ph_search_room: '搜索房间号...', filter_dll_all: 'DLL: 全部', filter_dll_on: '在线', filter_dll_off: '离线',
    filter_map_all: '地图: 全部', filter_map_in: '游戏中', filter_map_out: '未在游戏',
    // 封禁筛选
    ph_search_ban: '搜索封禁IP...', filter_ban_all: '来源: 全部', filter_ban_relay: 'Relay(WS)', filter_ban_admin: '管理后台',
    // 房间表头
    th_room: '房间号', th_dll: 'DLL', th_view: '观看', th_map: '地图', th_dll_ip: 'DLL IP',
    th_dll_online: 'DLL 在线', th_room_uptime: '房间存活', th_msg_sec: 'msg/s',
    th_bw_sec: '带宽/s', th_total: '总流量', th_action: '操作',
    // 封禁表头
    th_ip: 'IP 地址', th_source: '来源', th_reason: '封禁原因', th_level: '封禁等级', th_remain: '剩余时间',
    // 空状态 / 分页
    empty_rooms: '暂无活跃房间', empty_bans: '暂无封禁', empty_history: '暂无历史数据',
    total_count: '共 {n} 条', page_prev: '上一页', page_next: '下一页', per_page: '条/页',
    // Theme view
    view_theme: '前端主题', current_theme: '当前',
    preview_master: '预览总开关', preview_master_disabled: '关闭时所有 /_white/ /_black/ 路径不连 WS',
    preview_master_enabled: '预览模式已启用 · 任何人访问 /_white/ /_black/?preview=1 都会连 WS',
    preview_master_off: '已停止 (点击启动)', preview_master_on: '已启动 (点击停止)',
    whitelist_master: '房间白名单', whitelist_master_on: '白名单: 开', whitelist_master_off: '白名单: 关',
    whitelist_master_enforced: '已开启 · 仅白名单房间号可 pub 连入',
    whitelist_master_open: '已关闭 · 任意合法房间号均可连入',
    whitelist_master_hint: '开启后仅白名单内房间号可连入 DLL',
    whitelist_count: '名单 {n} 个', whitelist_not_ready: '名单未就绪',
    whitelist_enable_confirm: '开启房间白名单？未在名单内的房间号将无法 pub 连入。',
    whitelist_disable_confirm: '关闭房间白名单？任意合法房间号均可连入，请确认这是你想要的。',
    view_security: '安全', security_subtitle: '房间白名单 · pub 鉴权 · 实时生效',
    frontend_access_title: '前端访问端口',
    frontend_access_hint: '管理后台「进入房间」、主题预览等链接使用此端口。默认 80；云厂商封 80 时可改为 1366 等（需在 nginx / 安全组放行）。',
    frontend_access_port_label: 'HTTP 端口',
    frontend_access_preview: '示例: {url}',
    frontend_access_saved: '端口已保存',
    frontend_access_invalid: '端口须为 1–65535 的整数',
    frontend_access_conflict_admin: '不能与后台端口 1377 相同',
    frontend_access_conflict_ws: '不能与 WS 端口 5000 相同',
    whitelist_room_list: '授权房间号', ph_whitelist_add: '输入房间号后回车或点添加',
    whitelist_add_btn: '添加', whitelist_bulk_label: '批量编辑（竖线分隔）',
    whitelist_bulk_load: '从名单载入', whitelist_bulk_save: '保存名单',
    whitelist_empty: '暂无授权房间号', whitelist_saved: '名单已保存',
    whitelist_pull_notice: '当前为拉取模式 (ROOMS_API_URL)，名单由外部 API 每 10 秒同步，此处只读。',
    privacy_mode_title: '隐私模式', privacy_mode_hint: '开启后前端玩家名字只显示首尾字符（你是45我 → 你***我），避免泄露真实 ID。',
    privacy_mode_label: '名字脱敏', privacy_mode_on: '已开启', privacy_mode_off: '已关闭',
    privacy_mode_status_on: '已开启，名字已脱敏', privacy_mode_status_off: '已关闭，显示完整名字',
    privacy_mode_save_fail: '保存失败',
    sec_tab_port: '端口设置', sec_tab_whitelist: '房间白名单', sec_tab_privacy: '隐私模式',
    ext_api_title: '外部 API 同步', ext_api_hint: '填写外部 API 地址后系统将定期拉取房间号列表（JSON 格式：数组 ["1000","2000"] 或对象 {rooms:[...]}），自动同步到白名单。已连接但不在名单中的房间将被踢出。',
    ext_api_url_label: 'API 地址', ext_api_interval_label: '轮询间隔',
    unit_seconds: '秒', unit_minutes: '分钟', unit_hours: '小时', unit_sec_short: '秒',
    ext_api_stop: '停止同步', ext_api_idle: '未配置', ext_api_running: '同步中',
    ext_api_stopped: '已停止', ext_api_every: '每', ext_api_last_fetch: '上次拉取',
    ext_api_ago: '前', ext_api_keys: '个房间号',
    ext_api_url_required: '请输入 API 地址', ext_api_url_invalid: 'URL 格式无效',
    ext_api_saved: '已保存并开始同步', ext_api_save_fail: '保存失败',
    ext_api_test: '测试预览', ext_api_testing: '正在拉取...', ext_api_test_ok: '拉取成功 ·',
    ext_api_test_fail: '拉取失败', ext_api_preview_title: '预览房间号', ext_api_more: '还有',
    ext_api_synced_keys: '已同步房间号',
    whitelist_meta_ready: '名单就绪', whitelist_meta_not_ready: '名单未就绪',
    whitelist_meta_push: '推送模式', whitelist_meta_pull: '拉取模式',
    whitelist_remove_confirm: '从白名单移除房间 {key}？',
    whitelist_invalid_key: '房间号格式无效',
    whitelist_duplicate: '房间号已在名单中',
    preview_room_id: '预览房间号', ph_preview_room: '输入房间号',
    preview_room_hint: '不输入则只预览入场页',
    white_version: '白色版', black_version: '黑色版',
    white_desc: '极简白底配黑色高光,玻璃磨砂质感。带 landing 入场页和中英双语切换。',
    black_desc: '全黑底配 iOS 蓝高光,工业暗黑风。无入场页直接进雷达,单一中文。',
    switch_to_this: '切换到此', preview_landing: '预览入场页', preview_room_btn: '预览房间',
    current_in_use: '当前使用中', notify_users_f5: '通知用户 F5',
    // 房间操作
    action_kick: '踢', action_history: '历史', action_unban: '解封',
    rec_start: '录制', rec_stop: '停止', rec_replay: '回放', rec_share: '分享', rec_shared: '已分享', rec_unshare: '取消分享', rec_copy: '复制',
    rec_copied: '已复制到剪贴板', rec_confirm_delete: '确定删除此录制？',
    rec_download: '下载', rec_import: '导入录制', rec_import_title: '从 URL 导入录制',
    rec_import_url_ph: '输入录制文件的直链 URL', rec_importing: '正在导入...', rec_import_ok: '导入成功',
    rec_import_test: '测试预览', rec_import_test_ok: '数据有效，可以导入', rec_import_url_label: '录制文件 URL',
    rec_downloading: '正在下载...', rec_download_done: '下载完成', rec_use_external: '使用外链回放（不占本服务器带宽）',
    rec_th_type: '类型', rec_type_local: '本地', rec_type_external: '外链',
    rec_empty: '暂无录制记录', rec_permanent: '永久保存', rec_set_permanent: '设为永久',
    rec_active: '正在录制', rec_history: '对局回放记录', rec_total: '共',
    rec_th_room: '房间号', rec_th_map: '地图', rec_th_msgs: '消息数',
    rec_th_duration: '时长', rec_th_size: '大小', rec_th_time: '录制时间', rec_th_expires: '到期',
    ph_rec_search: '搜索房间号 / 地图...', rec_per_page: '条/页',
    rec_dur_all: '全部时长', rec_dur_1m: '< 1 分钟', rec_dur_5m: '< 5 分钟', rec_dur_10m: '< 10 分钟', rec_dur_30m: '< 30 分钟', rec_dur_30m_plus: '> 30 分钟',
    rec_share_title: '分享回放', rec_share_link: '回放链接',
    nav_recordings: '回放', view_recordings: '对局回放',
    recordings_subtitle: '录制管理 · 分享回放链接',
    confirm_kick: '确认关闭房间 [{key}]？', confirm_unban: '确认解封 {ip}？',
    // 历史弹窗
    daily_stats: '每日峰值统计', clear_all: '清空全部', keep_recent: '保留最近',
    days: '天', metric_users: '指标: 用户活跃 (房间/DLL/观看/封禁)',
    metric_bw_peak: '指标: 带宽峰值/s (下载/上传)',
    metric_bw_total: '指标: 当日总流量 (下载/上传)',
    chart_area: '图表: 堆叠区域', chart_line: '图表: 折线', chart_bar: '图表: 柱状',
    // 图表 series 名 (legend)
    chart_room_peak: '房间峰值', chart_dll_peak: 'DLL 峰值', chart_view_peak: '观看峰值', chart_ban_peak: '封禁峰值',
    chart_dl_peak: '下载峰值/s', chart_ul_peak: '上传峰值/s',
    chart_dl_day: '当日下载', chart_ul_day: '当日上传',
    // 图表 tooltip
    chart_daily_detail: '每日详细', chart_total: '合计',
    // 历史表头
    hist_th_date: '日期', hist_th_room_peak: '房间峰值', hist_th_dll_peak: 'DLL峰值',
    hist_th_view_peak: '观看峰值', hist_th_ban_peak: '封禁峰值',
    hist_th_dl_peak: '下载峰值/s', hist_th_ul_peak: '上传峰值/s',
    hist_th_dl_day: '当日下载', hist_th_ul_day: '当日上传',
    // 操作
    today_mark: '(今天)', action_delete: '删除',
    // 清理按钮
    keep_7d: '7 天', keep_30d: '30 天', keep_60d: '60 天',
    // 表单
    form_old_pass: '原密码', form_new_pass: '新密码 (≥4 位)', form_confirm_pass: '确认新密码',
    form_new_user: '新账号 (2-32 字符)', form_current_pass: '当前密码 (校验)',
    pass_mismatch: '两次密码不一致', pass_too_short: '新密码至少 4 位',
    user_too_short: '账号至少 2 字符', user_too_long: '账号最长 32 字符',
    operation_success: '操作成功, 请重新登录',
    // Login
    login_title: 'Relay 管理后台', login_user_ph: '账号', login_pass_ph: '密码', login_btn: '登录',
    login_err_frozen: 'IP 已冻结, 请等待 {n} 秒', login_err_failed: '登录失败', login_err_network: '网络错误或 IP 被封禁',
    range_7d: '最近 7 天', range_15d: '最近 15 天', range_30d: '最近 30 天', range_all: '全部记录',
    hist_field_metric: '指标', hist_field_chart: '图表', hist_field_range: '范围',
    hist_seg_users: '用户活跃', hist_seg_bw_peak: '带宽峰值', hist_seg_bw_total: '当日流量',
    hist_seg_area: '区域', hist_seg_line: '折线', hist_seg_bar: '柱状',
    hist_seg_7d: '7 天', hist_seg_15d: '15 天', hist_seg_30d: '30 天', hist_seg_all: '全部',
    // Tooltips (title 属性)
    title_uptime: '服务运行时间', title_lang: '切换语言 / Language',
    title_theme: '切换深/浅主题', title_user_menu: '账号菜单',
    // Theme view 提示
    theme_tip_title: '提示',
    theme_tip_html: '<b style="color:var(--text)">提示</b><br>● <b>切换到此</b>: 所有访问 <code style="color:var(--accent)">/</code> 主路径的用户都切到该主题, 用户 F5 即生效<br>● <b>预览入场页</b>: 新窗口打开 <code style="color:var(--accent)">/_white/</code> 或 <code style="color:var(--accent)">/_black/</code>, 看 landing 登录页效果<br>● <b>预览房间</b>: 用上面的房间号直接进入雷达地图, 看实际数据画面',
    // 修改账号/密码 hint
    cred_change_error: '请填写完整',
    // === 完整 i18n 大补丁 (一次性) ===
    title_admin: 'Relay 管理后台',
    room_history_title: '房间历史统计',
    rh_th_view_peak: '观看峰值', rh_th_msg_peak: 'msg/s 峰值', rh_th_bw_peak: '带宽峰值/s',
    rh_th_day_traffic: '当日流量', rh_th_dll_active: 'DLL活跃',
    badge_online: '在线', badge_offline: '离线',
    action_enter: '进入',
    page_prev_btn: '上一页', page_next_btn: '下一页',
    pager_total_pages: '共 {n} 条，第 {cur}/{pages} 页',
    ban_src_admin: '管理后台', ban_src_relay: 'Relay(WS)',
    ban_lv_1m: '1分钟', ban_lv_10m: '10分钟', ban_lv_30m: '30分钟', ban_lv_1h: '1小时',
    ban_reason_auth_flood: '认证刷屏', ban_reason_pub_flood: '发布刷屏',
    ban_reason_msg_too_large: '消息过大', ban_reason_admin_manual: '手动封禁',
    ban_reason_admin_rate_burst: '后台访问过快', ban_reason_admin_flood_1h: '后台反复刷屏', ban_reason_login_fail_5x: '登录失败 5 次',
    theme_current_label: '当前',
    theme_white_label: '白色版', theme_black_label: '黑色版', theme_unknown_label: '未知',
    theme_switched_to: '已切换到 {theme} · 通知用户 F5',
    theme_switch_failed: '切换失败', theme_unknown_val: '未知',
    api_request_failed: '请求失败',
    ip_limited: 'IP 被限制，剩余 {n} 秒',
    preview_off_confirm: '预览功能当前已关闭。\n关闭状态下所有人访问 /_white/ /_black/ 都不连 WS（省带宽）。\n\n是否立即启动预览，然后打开新窗口？',
    preview_room_required: '请先在上方输入要预览的房间号',
    confirm_clear_date: '确定删除 {date} 的数据？',
    confirm_clear_all: '确定清空全部历史数据？此操作不可恢复！',
    confirm_clear_keep: '确定只保留最近 {n} 天数据？',
    today_brackets: '(今天)',
    upstream_title_tip: '跳转到原作者项目',

    title_default_favicon: '默认 favicon',
    // 主题浏览器标题
    tnb_title: '浏览器标题', save: '保存', saved: '已保存',
    tnb_hint: '设置浏览器标签和图标 · 用户 F5 后生效',
    tnb_saving: '保存中...', tnb_save_failed: '保存失败',
    tnb_icon: '图标', ph_icon_url: '输入图标地址或留空',
    tag_day_friendly: '白天友好', tag_bilingual: '中英双语', tag_frosted: '毛玻璃',
    tag_night_friendly: '夜间友好', tag_power_save: '省电模式', tag_github: 'GitHub 风',
    title_upload_icon: '上传图标 (PNG/JPG/SVG, ≤120KB)', title_clear_icon: '清除恢复默认',
    title_theme_settings: '设置标题 / 图标',
    icon_too_large: '图标太大, 最大 120 KB', icon_invalid: '不支持的图标格式',
    tsp_default: '默认', tsp_icon_default_text: '清空后使用前端自带 favicon',
    reset_to_default: '重置默认',
  },
  en: {
    confirm: 'OK', cancel: 'Cancel', submit: 'Submit', close: 'Close', delete: 'Delete',
    loading: 'Loading...', empty: 'No data', refresh: 'Refresh',
    prompt_title_ok: 'Success', prompt_title_error: 'Failed', prompt_title_danger: 'Dangerous',
    prompt_title_warn: 'Confirm', prompt_title_info: 'Notice', prompt_title_input: 'Input',
    uptime: 'Uptime', logged_in_as: 'Logged in as',
    change_account: 'Change Username', change_password: 'Change Password', logout: 'Logout',
    sidebar_logo: 'Relay Admin', sidebar_foot: 'Relay v1.8.0',
    nav_dashboard: 'Dashboard', nav_theme: 'Theme', nav_announcement: 'Announcement', nav_security: 'Security', nav_about: 'About',
    view_announcement: 'Announcement', announcement_subtitle: 'Push notifications to users · Real-time',
    ann_add: '+ New Announcement', ann_search_ph: 'Search title or content...',
    ann_empty: 'No announcements · click "+ New Announcement" above to start',
    ann_no_title: '(no title)',
    ann_modal_title_new: 'New Announcement', ann_modal_title_edit: 'Edit Announcement',
    ann_field_title: 'Title', ann_field_type: 'Type',
    ann_field_content: 'Content (newlines supported)',
    ann_field_enabled: 'Enabled', ann_field_pinned: 'Pinned',
    ann_type_info: 'Info', ann_type_warn: 'Warning',
    ann_type_error: 'Error', ann_type_success: 'Success',
    ann_field_display: 'Display Style',
    ann_display_panel:  'Panel',  ann_display_modal:  'Modal',
    ann_display_banner: 'Banner', ann_display_toast: 'Toast',
    ann_display_hint_panel:  'Only shows in the bell panel (default)',
    ann_display_hint_modal:  'Pops up centered on first page visit (dismissed = no more popup)',
    ann_display_hint_banner: 'Sticky banner at top until user dismisses',
    ann_display_hint_toast:  'Top-right toast auto-dismisses in 4s (dismissed = no more toast)',
    ann_badge_enabled: 'Enabled', ann_badge_disabled: 'Disabled', ann_badge_pinned: 'Pinned',
    ann_action_edit: 'Edit', ann_action_enable: 'Enable', ann_action_disable: 'Disable',
    ann_action_delete: 'Delete',
    ann_meta_created: 'Created', ann_meta_updated: 'Updated',
    ann_confirm_delete: 'Delete announcement "{title}"?',
    ann_err_empty: 'Either title or content is required',
    ann_save_failed: 'Save failed',
    view_about: 'About', about_subtitle: 'Product info · Changelog',
    about_product_name: 'Relay Admin',
    about_product_desc: 'WSRadar Web management · WS Relay + Theme Switch + Live Stats',
    about_changelog: 'Changelog',
    about_latest: 'LATEST', about_upstream: 'UPSTREAM',
    tag_add: 'NEW', tag_fix: 'FIX', tag_improve: 'IMP', tag_del: 'DEL',
    view_dashboard: 'Dashboard', dashboard_subtitle: 'Live data · 3s auto refresh',
    stat_rooms: 'Rooms', stat_pubs: 'DLL Connected', stat_subs: 'Viewers', stat_bans: 'Banned IPs',
    stat_dl_sec: '⬇ Download Rate (DLL→Server)', stat_ul_sec: '⬆ Upload Rate (Server→Viewer)',
    stat_dl_total: '⬇ Total Download', stat_ul_total: '⬆ Total Upload',
    tab_rooms: 'Rooms', tab_bans: 'Bans', tab_room_events: 'Room Log', tab_ban_events: 'Ban Log',
    th_role: 'Role', th_event: 'Event', th_time_col: 'Time', th_duration_col: 'Duration',
    evt_connect: 'Connect', evt_disconnect: 'Disconnect', evt_ban: 'Ban', evt_unban: 'Unban',
    role_pub: 'DLL', role_sub: 'Viewer',
    ph_search_room: 'Search room key...', filter_dll_all: 'DLL: All', filter_dll_on: 'Online', filter_dll_off: 'Offline',
    filter_map_all: 'Map: All', filter_map_in: 'In-game', filter_map_out: 'Lobby',
    ph_search_ban: 'Search banned IP...', filter_ban_all: 'Source: All', filter_ban_relay: 'Relay(WS)', filter_ban_admin: 'Admin',
    th_room: 'Room', th_dll: 'DLL', th_view: 'Views', th_map: 'Map', th_dll_ip: 'DLL IP',
    th_dll_online: 'DLL Online', th_room_uptime: 'Uptime', th_msg_sec: 'msg/s',
    th_bw_sec: 'BW/s', th_total: 'Total', th_action: 'Action',
    th_ip: 'IP', th_source: 'Source', th_reason: 'Reason', th_level: 'Level', th_remain: 'Remaining',
    empty_rooms: 'No active rooms', empty_bans: 'No bans', empty_history: 'No history',
    total_count: 'Total {n}', page_prev: 'Prev', page_next: 'Next', per_page: 'per page',
    view_theme: 'Frontend Theme', current_theme: 'Current',
    preview_master: 'Preview Master', preview_master_disabled: 'Off: all /_white/ /_black/ skip WS connection',
    preview_master_enabled: 'Preview enabled: /_white/ /_black/?preview=1 will connect WS',
    preview_master_off: 'Off (click to enable)', preview_master_on: 'On (click to disable)',
    whitelist_master: 'Room Whitelist', whitelist_master_on: 'Whitelist: ON', whitelist_master_off: 'Whitelist: OFF',
    whitelist_master_enforced: 'Enabled · only whitelisted room keys can pub',
    whitelist_master_open: 'Disabled · any valid room key can pub',
    whitelist_master_hint: 'When ON, only whitelisted room keys can pub',
    whitelist_count: '{n} keys in list', whitelist_not_ready: 'List not ready',
    whitelist_enable_confirm: 'Enable room whitelist? Non-listed room keys will be rejected for pub.',
    whitelist_disable_confirm: 'Disable room whitelist? Any valid room key can pub. Confirm this is intended.',
    view_security: 'Security', security_subtitle: 'Room whitelist · pub auth · live',
    frontend_access_title: 'Frontend HTTP port',
    frontend_access_hint: 'Used by Enter room, theme preview links, etc. Default 80; use 1366 if your cloud blocks 80 (open the port in nginx / security group).',
    frontend_access_port_label: 'HTTP port',
    frontend_access_preview: 'Example: {url}',
    frontend_access_saved: 'Port saved',
    frontend_access_invalid: 'Port must be an integer 1–65535',
    frontend_access_conflict_admin: 'Cannot match admin port 1377',
    frontend_access_conflict_ws: 'Cannot match WS port 5000',
    whitelist_room_list: 'Authorized Room Keys', ph_whitelist_add: 'Enter room key, Enter or Add',
    whitelist_add_btn: 'Add', whitelist_bulk_label: 'Bulk edit (pipe-separated)',
    whitelist_bulk_load: 'Load from list', whitelist_bulk_save: 'Save list',
    whitelist_empty: 'No authorized room keys', whitelist_saved: 'List saved',
    whitelist_pull_notice: 'Pull mode (ROOMS_API_URL): list syncs from external API every 10s. Read-only here.',
    privacy_mode_title: 'Privacy Mode', privacy_mode_hint: 'When enabled, player names show only first & last characters on the frontend (e.g. Player1 → P*****1) to hide real IDs.',
    privacy_mode_label: 'Name masking', privacy_mode_on: 'Enabled', privacy_mode_off: 'Disabled',
    privacy_mode_status_on: 'Enabled, names are masked', privacy_mode_status_off: 'Disabled, showing full names',
    privacy_mode_save_fail: 'Save failed',
    sec_tab_port: 'Port', sec_tab_whitelist: 'Room Whitelist', sec_tab_privacy: 'Privacy',
    ext_api_title: 'External API Sync', ext_api_hint: 'Enter an external API URL to periodically fetch room IDs (JSON format: array ["1000","2000"] or object {rooms:[...]}). Rooms not in the list will be kicked.',
    ext_api_url_label: 'API URL', ext_api_interval_label: 'Poll interval',
    unit_seconds: 'sec', unit_minutes: 'min', unit_hours: 'hour', unit_sec_short: 's',
    ext_api_stop: 'Stop sync', ext_api_idle: 'Not configured', ext_api_running: 'Syncing',
    ext_api_stopped: 'Stopped', ext_api_every: 'Every', ext_api_last_fetch: 'Last fetch',
    ext_api_ago: ' ago', ext_api_keys: 'keys',
    ext_api_url_required: 'API URL is required', ext_api_url_invalid: 'Invalid URL format',
    ext_api_saved: 'Saved, sync started', ext_api_save_fail: 'Save failed',
    ext_api_test: 'Test Preview', ext_api_testing: 'Fetching...', ext_api_test_ok: 'Fetched ·',
    ext_api_test_fail: 'Fetch failed', ext_api_preview_title: 'Preview room IDs', ext_api_more: 'more',
    ext_api_synced_keys: 'Synced room IDs',
    whitelist_meta_ready: 'List ready', whitelist_meta_not_ready: 'List not ready',
    whitelist_meta_push: 'Push mode', whitelist_meta_pull: 'Pull mode',
    whitelist_remove_confirm: 'Remove room {key} from whitelist?',
    whitelist_invalid_key: 'Invalid room key format',
    whitelist_duplicate: 'Room key already in list',
    preview_room_id: 'Preview Room ID', ph_preview_room: 'Enter Room ID',
    preview_room_hint: 'Empty = preview landing only',
    white_version: 'White Theme', black_version: 'Dark Theme',
    white_desc: 'Minimal white with black highlights, frosted glass. Landing page + bilingual.',
    black_desc: 'Pure dark with iOS-blue highlights, GitHub industrial. No landing, direct to radar.',
    switch_to_this: 'Switch to this', preview_landing: 'Preview Landing', preview_room_btn: 'Preview Room',
    current_in_use: 'In Use', notify_users_f5: 'Notify users F5',
    action_kick: 'Kick', action_history: 'History', action_unban: 'Unban',
    rec_start: 'Record', rec_stop: 'Stop', rec_replay: 'Replay', rec_share: 'Share', rec_shared: 'Shared', rec_unshare: 'Unshare', rec_copy: 'Copy',
    rec_copied: 'Copied to clipboard', rec_confirm_delete: 'Delete this recording?',
    rec_download: 'Download', rec_import: 'Import', rec_import_title: 'Import Recording from URL',
    rec_import_url_ph: 'Direct URL to recording file', rec_importing: 'Importing...', rec_import_ok: 'Import successful',
    rec_import_test: 'Test Preview', rec_import_test_ok: 'Data valid, ready to import', rec_import_url_label: 'Recording File URL',
    rec_downloading: 'Downloading...', rec_download_done: 'Download complete', rec_use_external: 'Use external link for replay (saves server bandwidth)',
    rec_th_type: 'Type', rec_type_local: 'Local', rec_type_external: 'External',
    rec_empty: 'No recordings yet', rec_permanent: 'Permanent', rec_set_permanent: 'Keep forever',
    rec_active: 'Recording', rec_history: 'Replay History', rec_total: 'Total',
    rec_th_room: 'Room', rec_th_map: 'Map', rec_th_msgs: 'Messages',
    rec_th_duration: 'Duration', rec_th_size: 'Size', rec_th_time: 'Recorded At', rec_th_expires: 'Expires',
    ph_rec_search: 'Search room / map...', rec_per_page: 'per page',
    rec_dur_all: 'All durations', rec_dur_1m: '< 1 min', rec_dur_5m: '< 5 min', rec_dur_10m: '< 10 min', rec_dur_30m: '< 30 min', rec_dur_30m_plus: '> 30 min',
    rec_share_title: 'Share Replay', rec_share_link: 'Replay Link',
    nav_recordings: 'Replays', view_recordings: 'Game Replays',
    recordings_subtitle: 'Recording management · Share replay links',
    confirm_kick: 'Close room [{key}]?', confirm_unban: 'Unban {ip}?',
    daily_stats: 'Daily Peak Stats', clear_all: 'Clear All', keep_recent: 'Keep Last',
    days: 'days', metric_users: 'Metric: User Activity (Rooms/DLL/Viewers/Bans)',
    metric_bw_peak: 'Metric: BW Peak/s (Down/Up)',
    metric_bw_total: 'Metric: Daily Total (Down/Up)',
    chart_area: 'Chart: Stacked Area', chart_line: 'Chart: Line', chart_bar: 'Chart: Bar',
    chart_room_peak: 'Rooms Peak', chart_dll_peak: 'DLL Peak', chart_view_peak: 'Viewers Peak', chart_ban_peak: 'Bans Peak',
    chart_dl_peak: 'Download Peak/s', chart_ul_peak: 'Upload Peak/s',
    chart_dl_day: 'Daily Download', chart_ul_day: 'Daily Upload',
    chart_daily_detail: 'Daily detail', chart_total: 'Total',
    hist_th_date: 'Date', hist_th_room_peak: 'Rooms Peak', hist_th_dll_peak: 'DLL Peak',
    hist_th_view_peak: 'Views Peak', hist_th_ban_peak: 'Bans Peak',
    hist_th_dl_peak: 'Download Peak/s', hist_th_ul_peak: 'Upload Peak/s',
    hist_th_dl_day: 'Daily Download', hist_th_ul_day: 'Daily Upload',
    today_mark: '(today)', action_delete: 'Delete',
    keep_7d: '7 days', keep_30d: '30 days', keep_60d: '60 days',
    form_old_pass: 'Old Password', form_new_pass: 'New Password (≥4 chars)', form_confirm_pass: 'Confirm New Password',
    form_new_user: 'New Username (2-32 chars)', form_current_pass: 'Current Password (verify)',
    pass_mismatch: 'Passwords do not match', pass_too_short: 'Min 4 chars',
    user_too_short: 'Min 2 chars', user_too_long: 'Max 32 chars',
    operation_success: 'Done, please login again',
    login_title: 'Relay Admin', login_user_ph: 'Username', login_pass_ph: 'Password', login_btn: 'Login',
    login_err_frozen: 'IP frozen, wait {n}s', login_err_failed: 'Login failed', login_err_network: 'Network error or IP banned',
    range_7d: 'Last 7 Days', range_15d: 'Last 15 Days', range_30d: 'Last 30 Days', range_all: 'All History',
    hist_field_metric: 'Metric', hist_field_chart: 'Chart', hist_field_range: 'Range',
    hist_seg_users: 'Activity', hist_seg_bw_peak: 'BW Peak', hist_seg_bw_total: 'Day Traffic',
    hist_seg_area: 'Area', hist_seg_line: 'Line', hist_seg_bar: 'Bar',
    hist_seg_7d: '7d', hist_seg_15d: '15d', hist_seg_30d: '30d', hist_seg_all: 'All',
    title_uptime: 'Server uptime', title_lang: 'Switch language / 切换语言',
    title_theme: 'Toggle dark/light theme', title_user_menu: 'Account menu',
    theme_tip_title: 'Tips',
    theme_tip_html: '<b style="color:var(--text)">Tips</b><br>● <b>Switch to this</b>: All users on <code style="color:var(--accent)">/</code> main path will switch, takes effect after F5<br>● <b>Preview Landing</b>: Open <code style="color:var(--accent)">/_white/</code> or <code style="color:var(--accent)">/_black/</code> in new window to view landing page<br>● <b>Preview Room</b>: Enter room ID above, directly enter radar map to see actual data',
    cred_change_error: 'Please fill in all fields',
    // === 完整 i18n 大补丁 ===
    title_admin: 'Relay Admin',
    room_history_title: 'Room History',
    rh_th_view_peak: 'Views Peak', rh_th_msg_peak: 'msg/s Peak', rh_th_bw_peak: 'BW Peak/s',
    rh_th_day_traffic: 'Daily Traffic', rh_th_dll_active: 'DLL Active',
    badge_online: 'Online', badge_offline: 'Offline',
    action_enter: 'Enter',
    page_prev_btn: 'Prev', page_next_btn: 'Next',
    pager_total_pages: 'Total {n}, page {cur}/{pages}',
    ban_src_admin: 'Admin', ban_src_relay: 'Relay(WS)',
    ban_lv_1m: '1 min', ban_lv_10m: '10 min', ban_lv_30m: '30 min', ban_lv_1h: '1 hour',
    ban_reason_auth_flood: 'Auth flood', ban_reason_pub_flood: 'Pub flood',
    ban_reason_msg_too_large: 'Msg too large', ban_reason_admin_manual: 'Manual ban',
    ban_reason_admin_rate_burst: 'Rate burst', ban_reason_admin_flood_1h: 'Admin flood (1h)', ban_reason_login_fail_5x: 'Login failed 5x',
    theme_current_label: 'Current',
    theme_white_label: 'White', theme_black_label: 'Black', theme_unknown_label: 'Unknown',
    theme_switched_to: 'Switched to {theme} · users press F5',
    theme_switch_failed: 'Switch failed', theme_unknown_val: 'unknown',
    api_request_failed: 'Request failed',
    ip_limited: 'IP throttled, wait {n}s',
    preview_off_confirm: 'Preview is currently disabled.\nWhen off, /_white/ /_black/ skip WS (saves bandwidth).\n\nEnable preview now and open new window?',
    preview_room_required: 'Please enter a room ID above first',
    confirm_clear_date: 'Delete data for {date}?',
    confirm_clear_all: 'Clear ALL history? This cannot be undone!',
    confirm_clear_keep: 'Keep only last {n} days of data?',
    today_brackets: '(today)',
    upstream_title_tip: 'Open upstream project',

    title_default_favicon: 'Default favicon',
    tnb_title: 'Browser Title', save: 'Save', saved: 'Saved',
    tnb_hint: 'Browser tab title and icon · takes effect after user F5',
    tnb_saving: 'Saving...', tnb_save_failed: 'Save failed',
    tnb_icon: 'Icon', ph_icon_url: 'Icon address or leave empty',
    tag_day_friendly: 'Day-friendly', tag_bilingual: 'Bilingual', tag_frosted: 'Frosted glass',
    tag_night_friendly: 'Night-friendly', tag_power_save: 'Power-saving', tag_github: 'GitHub style',
    title_upload_icon: 'Upload icon (PNG/JPG/SVG, ≤120KB)', title_clear_icon: 'Clear / reset to default',
    title_theme_settings: 'Settings: title / icon',
    icon_too_large: 'Icon too large, max 120 KB', icon_invalid: 'Unsupported icon format',
    tsp_default: 'Default', tsp_icon_default_text: 'Clear to use built-in favicon',
    reset_to_default: 'Reset to default',
  },
};
let _curLang = 'zh';
function t(key) { return (I18N[_curLang] || I18N.zh)[key] || key; }
function setLang(lang) {
  if (!I18N[lang]) lang = 'zh';
  _curLang = lang;
  try { localStorage.setItem('admin_lang', lang); } catch(e) {}
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  // 更新所有 data-i18n
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  // title 属性 (鼠标悬停 tooltip)
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  // 含 HTML 元素的长文本 (整段替换)
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  // 语言按钮 active
  document.querySelectorAll('.topbar-lang button').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
  // 重渲染已缓存的动态内容 (不重新请求 API, 避免触发限流)
  try {
    if (typeof _renderRecPage === 'function' && typeof _recAllData !== 'undefined' && _recAllData.length) _renderRecPage();
    // changelog: 无条件渲染 (后台先准备好新语言, 用户切到 about 时直接是新语言)
    if (typeof renderChangelog === 'function') renderChangelog();
    // 历史 modal 若打开: 重渲染图表 + 表格
    if (document.getElementById('historyModal') &&
        document.getElementById('historyModal').classList.contains('show')) {
      if (typeof renderHistTable === 'function') renderHistTable();
      if (typeof renderHistChart === 'function') {
        if (typeof _histChart !== 'undefined' && _histChart) { _histChart.dispose(); _histChart = null; }
        setTimeout(renderHistChart, 50);
      }
    }
  } catch(e) { /* ignore during init */ }
}
(function loadLang() {
  let saved = 'zh';
  try { saved = localStorage.getItem('admin_lang') || 'zh'; } catch(e) {}
  setLang(saved);
})();

// ══════════════════════════════════════════════════════════
// 用户菜单 (右上角 dropdown)
// ══════════════════════════════════════════════════════════
function toggleUserMenu(e) {
  e && e.stopPropagation();
  const menu = document.getElementById('userMenu');
  const btn  = document.getElementById('userBtn');
  const isOpen = menu.classList.contains('show');
  menu.classList.toggle('show', !isOpen);
  btn.classList.toggle('open', !isOpen);
}
// 点外面关闭
document.addEventListener('click', (e) => {
  const user = document.querySelector('.topbar-user');
  if (user && !user.contains(e.target)) {
    document.getElementById('userMenu').classList.remove('show');
    document.getElementById('userBtn').classList.remove('open');
  }
});

async function loadMe() {
  try {
    const data = await api('/api/me');
    if (data.ok) {
      const u = data.user || 'admin';
      document.getElementById('userName').textContent = u;
      document.getElementById('userNameFull').textContent = u;
      const av = document.getElementById('userAvatar');
      if (av && av.tagName === 'IMG') {
        av.alt = u;
      } else if (av) {
        av.textContent = u.charAt(0).toUpperCase();
      }    }
  } catch(e) {}
}

// ══════════════════════════════════════════════════════════
// 修改密码 / 修改账号
// ══════════════════════════════════════════════════════════
function openChangePassword() {
  document.getElementById('userMenu').classList.remove('show');
  document.getElementById('userBtn').classList.remove('open');
  document.getElementById('cpOldPass').value = '';
  document.getElementById('cpNewPass').value = '';
  document.getElementById('cpConfirmPass').value = '';
  const msg = document.getElementById('cpMsg');
  msg.textContent = ''; msg.className = 'form-msg';
  document.getElementById('changePassModal').classList.add('show');
  setTimeout(() => document.getElementById('cpOldPass').focus(), 50);
}
function closeChangePass() { document.getElementById('changePassModal').classList.remove('show'); }

async function submitChangePass() {
  const oldPass = document.getElementById('cpOldPass').value;
  const newPass = document.getElementById('cpNewPass').value;
  const confirmPass = document.getElementById('cpConfirmPass').value;
  const msg = document.getElementById('cpMsg');
  if (!oldPass || !newPass) { msg.className = 'form-msg err'; msg.textContent = t('cancel') + ' / ' + t('form_new_pass'); return; }
  if (newPass.length < 4) { msg.className = 'form-msg err'; msg.textContent = t('pass_too_short'); return; }
  if (newPass !== confirmPass) { msg.className = 'form-msg err'; msg.textContent = t('pass_mismatch'); return; }
  try {
    const data = await api('/api/change_password', 'POST', { oldPass, newPass });
    if (data.ok) {
      msg.className = 'form-msg ok';
      msg.textContent = t('operation_success');
      setTimeout(() => { closeChangePass(); doLogout(); }, 1200);
    } else {
      msg.className = 'form-msg err';
      msg.textContent = data.error || 'Unknown error';
    }
  } catch(e) {
    msg.className = 'form-msg err';
    msg.textContent = e.message;
  }
}

function openChangeAccount() {
  document.getElementById('userMenu').classList.remove('show');
  document.getElementById('userBtn').classList.remove('open');
  document.getElementById('caNewUser').value = '';
  document.getElementById('caPass').value = '';
  const msg = document.getElementById('caMsg');
  msg.textContent = ''; msg.className = 'form-msg';
  document.getElementById('changeAccountModal').classList.add('show');
  setTimeout(() => document.getElementById('caNewUser').focus(), 50);
}
function closeChangeAccount() { document.getElementById('changeAccountModal').classList.remove('show'); }

async function submitChangeAccount() {
  const newUser = document.getElementById('caNewUser').value.trim();
  const pass = document.getElementById('caPass').value;
  const msg = document.getElementById('caMsg');
  if (!newUser || !pass) { msg.className = 'form-msg err'; msg.textContent = t('cancel'); return; }
  if (newUser.length < 2) { msg.className = 'form-msg err'; msg.textContent = t('user_too_short'); return; }
  if (newUser.length > 32) { msg.className = 'form-msg err'; msg.textContent = t('user_too_long'); return; }
  try {
    const data = await api('/api/change_account', 'POST', { newUser, pass });
    if (data.ok) {
      msg.className = 'form-msg ok';
      msg.textContent = t('operation_success');
      setTimeout(() => { closeChangeAccount(); doLogout(); }, 1200);
    } else {
      msg.className = 'form-msg err';
      msg.textContent = data.error || 'Unknown error';
    }
  } catch(e) {
    msg.className = 'form-msg err';
    msg.textContent = e.message;
  }
}

// ── 后台主题切换 (深/浅, localStorage 记忆) ──
function setAdminTheme(theme) {
  if (theme === 'deepblue') theme = 'dark'; // 旧深蓝版并入深色
  document.body.classList.remove('theme-light', 'theme-deepblue');
  if (theme === 'light') document.body.classList.add('theme-light');
  try { localStorage.setItem('admin_ui_theme', theme === 'light' ? 'light' : 'dark'); } catch(e) {}
  // ECharts 跟着重绘（_histChart 是后面的 let，启动时可能还在 TDZ）
  try {
    if (_histChart) {
      _histChart.dispose();
      _histChart = null;
      if (document.getElementById('historyModal') && document.getElementById('historyModal').classList.contains('show')) {
        setTimeout(renderHistChart, 60);
      }
    }
  } catch (e) { /* chart not ready yet */ }
}
function toggleAdminTheme() {
  const cur = document.body.classList.contains('theme-light') ? 'light' : 'dark';
  setAdminTheme(cur === 'light' ? 'dark' : 'light');
}
// 启动时恢复主题（仅 light / dark）
(function loadAdminTheme() {
  try {
    let saved = localStorage.getItem('admin_ui_theme') || 'light';
    if (saved === 'deepblue') saved = 'dark';
    setAdminTheme(saved === 'light' ? 'light' : 'dark');
  } catch(e) {
    setAdminTheme('light');
  }
})();

// 滚动时给 topbar 加底线 + 毛玻璃 (有层次感)
window.addEventListener('scroll', () => {
  const tb = document.querySelector('.app-topbar');
  if (!tb) return;
  tb.classList.toggle('scrolled', (window.scrollY || document.documentElement.scrollTop) > 4);
}, { passive: true });
document.querySelectorAll('.app-content').forEach(el => {
  el.addEventListener('scroll', () => {
    const tb = document.querySelector('.app-topbar');
    if (!tb) return;
    tb.classList.toggle('scrolled', el.scrollTop > 4);
  }, { passive: true });
});

// ── View 切换 (左侧栏导航) ──
function switchView(name) {
  document.querySelectorAll('.app-nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  const viewId = 'view' + name.charAt(0).toUpperCase() + name.slice(1);
  document.querySelectorAll('.app-view').forEach(v => v.classList.toggle('active', v.id === viewId));
  if (name === 'theme') { loadTheme(); loadPreviewMaster(); loadThemeNames(); }
  if (name === 'security') loadSecurityView();
  if (name === 'about') renderChangelog();
  if (name === 'announcement') loadAnnouncements();
  if (name === 'recordings') loadRecordingsView();
  try { history.replaceState(null, '', '#' + name); } catch {}
}

// ══════════════════════════════════════════════════════════
// 公告 (Announcements)
// ══════════════════════════════════════════════════════════
let _anns = [];
let _annEditId = null;
let _annCurType = 'info';
let _annCurDisplay = 'panel';

async function loadAnnouncements() {
  try {
    const data = await api('/api/announcements');
    _anns = data.list || [];
  } catch (e) { _anns = []; }
  renderAnnList();
}

function renderAnnList() {
  const wrap = document.getElementById('annList');
  const cnt  = document.getElementById('annCount');
  if (!wrap) return;
  const q = (document.getElementById('annSearch')?.value || '').trim().toLowerCase();
  const list = q ? _anns.filter(a =>
    (a.title || '').toLowerCase().includes(q) ||
    (a.content || '').toLowerCase().includes(q)
  ) : _anns;
  if (cnt) cnt.textContent = t('total_count').replace('{n}', list.length);
  if (list.length === 0) {
    wrap.innerHTML = '<div class="ann-empty">' + t('ann_empty') + '</div>';
    return;
  }
  const fmt = ts => {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
  wrap.innerHTML = list.map(a => {
    const typeLabel    = t('ann_type_'    + (a.type || 'info'));
    const displayLabel = t('ann_display_' + (a.displayMode || 'panel'));
    return `
    <div class="ann-card type-${esc(a.type || 'info')} ${a.enabled ? '' : 'disabled'}">
      <div class="ann-stripe"></div>
      <div class="ann-main">
        <div class="ann-head">
          <div class="ann-title">${esc(a.title) || '<span style="color:var(--dim);font-weight:400">'+t('ann_no_title')+'</span>'}</div>
          <span class="ann-badge type-${esc(a.type || 'info')}">${esc(typeLabel)}</span>
          <span class="ann-badge display">${esc(displayLabel)}</span>
          ${a.pinned ? '<span class="ann-badge pin">' + t('ann_badge_pinned') + '</span>' : ''}
          <span class="ann-badge ${a.enabled ? 'on' : 'off'}">${a.enabled ? t('ann_badge_enabled') : t('ann_badge_disabled')}</span>
        </div>
        ${a.content ? '<div class="ann-body">' + esc(a.content) + '</div>' : ''}
        <div class="ann-meta">
          <span>${t('ann_meta_updated')}: ${fmt(a.updatedAt)}</span>
          ${a.createdAt !== a.updatedAt ? '<span class="dot">·</span><span>'+t('ann_meta_created')+': '+fmt(a.createdAt)+'</span>' : ''}
        </div>
      </div>
      <div class="ann-actions">
        <button class="ann-act" data-ann-act="toggle" data-id="${escAttr(a.id)}">${a.enabled ? t('ann_action_disable') : t('ann_action_enable')}</button>
        <button class="ann-act" data-ann-act="edit" data-id="${escAttr(a.id)}">${t('ann_action_edit')}</button>
        <button class="ann-act danger" data-ann-act="delete" data-id="${escAttr(a.id)}">${t('ann_action_delete')}</button>
      </div>
    </div>`;
  }).join('');
}

function setAnnType(type) {
  _annCurType = type;
  document.querySelectorAll('#annModal .ann-type-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type));
}
function setAnnDisplay(display) {
  _annCurDisplay = display;
  document.querySelectorAll('#annModal .ann-display-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.display === display));
  const hint = document.getElementById('annDisplayHint');
  if (hint) hint.textContent = t('ann_display_hint_' + display);
}

function openAnnEdit(id) {
  _annEditId = id || null;
  const titleEl = document.getElementById('annModalTitle');
  titleEl.textContent = id ? t('ann_modal_title_edit') : t('ann_modal_title_new');
  const a = id ? _anns.find(x => x.id === id) : null;
  document.getElementById('annFTitle').value   = a ? a.title : '';
  document.getElementById('annFContent').value = a ? a.content : '';
  document.getElementById('annFEnabled').checked = a ? a.enabled : true;
  document.getElementById('annFPinned').checked  = a ? a.pinned  : false;
  setAnnType(a ? (a.type || 'info') : 'info');
  setAnnDisplay(a ? (a.displayMode || 'panel') : 'panel');
  document.getElementById('annFMsg').textContent = '';
  document.getElementById('annModal').classList.add('show');
  setTimeout(() => document.getElementById('annFTitle').focus(), 50);
}
function closeAnnModal() {
  document.getElementById('annModal').classList.remove('show');
  _annEditId = null;
}
async function submitAnn() {
  const msg = document.getElementById('annFMsg');
  msg.className = 'form-msg';
  const body = {
    title:       document.getElementById('annFTitle').value.trim(),
    content:     document.getElementById('annFContent').value.trim(),
    type:        _annCurType,
    enabled:     document.getElementById('annFEnabled').checked,
    pinned:      document.getElementById('annFPinned').checked,
    displayMode: _annCurDisplay,
  };
  if (!body.title && !body.content) {
    msg.className = 'form-msg err';
    msg.textContent = t('ann_err_empty');
    return;
  }
  try {
    if (_annEditId) {
      await api('/api/announcements', 'PUT', { id: _annEditId, ...body });
    } else {
      await api('/api/announcements', 'POST', body);
    }
    closeAnnModal();
    await loadAnnouncements();
  } catch (e) {
    msg.className = 'form-msg err';
    msg.textContent = t('ann_save_failed') + ': ' + (e.message || e);
  }
}
async function toggleAnnEnabled(id) {
  const a = _anns.find(x => x.id === id);
  if (!a) return;
  try {
    await api('/api/announcements', 'PUT', {
      id, title: a.title, content: a.content, type: a.type,
      enabled: !a.enabled, pinned: a.pinned, displayMode: a.displayMode || 'panel'
    });
    await loadAnnouncements();
  } catch (e) { showAlert(t('ann_save_failed') + ': ' + e.message); }
}
async function deleteAnn(id) {
  const a = _anns.find(x => x.id === id);
  if (!a) return;
  const title = a.title || t('ann_no_title');
  if (!await customConfirm(t('ann_confirm_delete').replace('{title}', title))) return;
  try {
    await api('/api/announcements', 'DELETE', { id });
    await loadAnnouncements();
  } catch (e) { showAlert(t('ann_save_failed') + ': ' + e.message); }
}

// ══════════════════════════════════════════════════════════
// 更新日志数据 (新版本加在数组顶部, 自动获得 LATEST 标记)
// type: add (新增) / fix (修复) / improve (优化) / del (删除)
// ══════════════════════════════════════════════════════════
const APP_VERSION = 'v1.8.0';
const APP_DATE    = '2026-06-26';

const CHANGELOG = [
  {
    version: 'v1.8.0',
    date: '2026-06-26',
    items: [
      { type: 'add', zh: 'AZ3 核电站地图 · 官方 map_az3.js 参数 + 13 个区域标签 · 瓦片 map_az3', en: 'AZ3 nuclear plant map: official map_az3.js params, 13 region labels, map_az3 tiles' },
      { type: 'add', zh: 'AZ-5_Level 进图自动识别切图 · MAP_PREFIX_TABLE 映射 az3', en: 'Auto map switch on AZ-5_Level via MAP_PREFIX_TABLE → az3' },
      { type: 'add', zh: 'preview=1 坐标校准模式 · 悬停显示官方 Map 坐标 · 本人圆点下显示 DLL 原始坐标', en: 'preview=1 calibration: hover shows official Map coords, raw DLL coords under self marker' },
      { type: 'fix', zh: 'AZ3 rotate=-90 坐标转换 · mapEngine 独立 rotate<0 分支', en: 'AZ3 rotate=-90 coordinate transform: dedicated rotate<0 branch in mapEngine' },
      { type: 'fix', zh: 'AZ3 玩家朝向偏 180° · rotate<0 地图 yawOff=0（与 +90 图镜像）', en: 'AZ3 facing 180° off: yawOff=0 for rotate<0 maps (mirror of +90 branch)' },
      { type: 'fix', zh: 'preview 悬停坐标改为官方 wx/wy · 不再误显示减 origin 后的值', en: 'Preview hover now shows official wx/wy instead of origin-subtracted values' },
    ],
  },
  {
    version: 'v1.7.0',
    date: '2026-06-21',
    items: [
      { type: 'add', zh: '深蓝版前端主题 · 深灰+冷蓝配色 · 左右分栏 landing · 噪点纹理', en: 'Deep Blue frontend theme: charcoal + cold blue, split-screen landing, grain texture' },
      { type: 'add', zh: '管理后台深蓝版 UI 主题 · 右上角切换按钮支持 3 种主题循环', en: 'Admin Deep Blue UI theme, 3-theme cycle via top-right toggle' },
      { type: 'add', zh: 'Landing 文案后台可编辑 · 每个主题可独立设置中英文标题和描述', en: 'Landing page text editable in admin per-theme (zh/en title + description)' },
      { type: 'add', zh: '房间记录 / 封禁记录清理按钮 · 支持全部 / 7天前 / 30天前', en: 'Event log cleanup buttons: all / older than 7d / older than 30d' },
      { type: 'add', zh: 'IP 地址隐私遮罩 · 默认脱敏显示 · 点击查看完整 IP', en: 'IP address privacy mask: click to reveal full address' },
      { type: 'add', zh: '录制分享自定义 ID · 可设置固定别名 · 更换内容 URL 不变', en: 'Custom share slug for recordings: set permanent alias, URL stays when content changes' },
      { type: 'add', zh: '编辑分享 ID 按钮 · 已分享录制可修改自定义别名', en: 'Edit share slug button in recording dropdown' },
      { type: 'add', zh: '自定义 UI 输入弹窗 (customPrompt) · 跟随主题', en: 'Custom UI prompt dialog (customPrompt) matching admin theme' },
      { type: 'add', zh: '默认 favicon 图标 · 三个主题统一设置', en: 'Default favicon icon set for all three themes' },
      { type: 'fix', zh: '公告铃铛被 landing overlay 遮挡无法点击', en: 'Announcement bell blocked by landing overlay z-index' },
      { type: 'fix', zh: '深蓝版主题识别错误 · getCurrent() 路径匹配修复', en: 'Deep Blue theme detection fix in getCurrent() path matching' },
      { type: 'fix', zh: '切换语言不再触发限流 · setLang 不重新请求 API', en: 'Language switch no longer triggers rate limit (setLang skips API calls)' },
      { type: 'fix', zh: '封禁记录时间戳显示 Invalid Date · BIGINT 解析修复', en: 'Ban event timestamp Invalid Date fix for BIGINT parsing' },
      { type: 'fix', zh: 'IP 遮罩 CSP 违规 · onclick 改为事件委托', en: 'IP mask CSP violation fix: onclick changed to event delegation' },
      { type: 'fix', zh: '分享状态 API 路由冲突 404 · 排除 /api/recording/share/', en: 'Share status API 404 fix: excluded /api/recording/share/ from catch-all route' },
      { type: 'del', zh: '移除房间记录 tab 和数据写入 · 减少数据库增长', en: 'Removed room events tab and database writes to reduce DB growth' },
    ],
  },
  {
    version: 'v1.6.0',
    date: '2026-06-20',
    items: [
      { type: 'add', zh: '安全页面拆分 Tab 子页面（端口设置 / 房间白名单 / 隐私模式）', en: 'Security page split into tabs: Port / Whitelist / Privacy' },
      { type: 'add', zh: '外部 API 白名单同步 · 填入 URL 定期拉取房间号 · 支持秒/分/时间隔', en: 'External API whitelist sync with configurable URL and polling interval (sec/min/hour)' },
      { type: 'add', zh: '回放列表分页 · 默认 20 条/页 · 可选 20/50/100/1000/10000', en: 'Replay list pagination with 20/50/100/1000/10000 per page selector' },
      { type: 'add', zh: '回放列表搜索 · 支持房间号和地图名实时搜索', en: 'Replay list search by room key and map name' },
      { type: 'add', zh: '回放列表时长筛选 · <1m / <5m / <10m / <30m / >30m', en: 'Replay list duration filter with 6 range options' },
      { type: 'improve', zh: 'F5 刷新保持当前页面 · URL hash 记忆视图 · 无感跳转', en: 'F5 refresh preserves current view via URL hash, no flash' },
      { type: 'fix', zh: '分享按钮点击后立即刷新列表状态 · 无需手动 F5', en: 'Share button now instantly refreshes recording list status' },
      { type: 'fix', zh: '分享弹窗黑色主题适配 · 按钮背景透明', en: 'Share modal dark theme fix: transparent button background' },
      { type: 'fix', zh: '登录页不再闪现 · token 验证前页面空白等待', en: 'Login page no longer flashes on F5 with valid token' },
    ],
  },
  {
    version: 'v1.5.0',
    date: '2026-06-20',
    items: [
      { type: 'add', zh: '对局录制与回放系统 · 实时录制房间数据 · 支持暂停/恢复 · 回放播放器含进度条与倍速', en: 'Match recording & replay system with real-time capture, pause/resume, progress bar and speed control' },
      { type: 'add', zh: '回放分享功能 · 生成分享链接供观众无需登录直接观看', en: 'Replay sharing with public links for unauthenticated viewing' },
      { type: 'add', zh: '隐私模式 · 安全设置开关 · 前端玩家名字脱敏（你是45我 → 你*我）', en: 'Privacy mode toggle in security settings, masks player names on frontend' },
      { type: 'add', zh: '录制永久保存 · 可标记重要录制免被自动清理', en: 'Permanent recording flag to protect important replays from auto-cleanup' },
      { type: 'add', zh: '回放列表显示过期日期 · 快到期标红 · 永久保存显示蓝色标记', en: 'Expiration date column in replay list with red warning and blue permanent badge' },
      { type: 'improve', zh: '操作按钮全部换用 SVG 线条图标 · stroke:currentColor 自动适配主题', en: 'All action buttons now use SVG stroke icons that auto-adapt to theme colors' },
      { type: 'fix', zh: '回放进度条与公告/跟随/观战 UI 自动避让 · 收起时恢复原位', en: 'Replay bar auto-adjusts announcement, spectate and follow panels to avoid overlap' },
      { type: 'fix', zh: '回放加载进度条正确显示已下载字节数', en: 'Replay loading progress bar now correctly shows downloaded bytes' },
      { type: 'fix', zh: '跟随面板队友名字隐私脱敏', en: 'Spectate float panel teammate names now respect privacy mode' },
    ],
  },
  {
    version: 'v1.4.0',
    date: '2026-06-12',
    items: [
      { type: 'improve', zh: 'i18n 完美适配 · 221 个翻译键完全对偶 · 修补 28+ 处遗漏', en: 'Perfect i18n: 221 keys aligned zh/en, 28+ gaps patched' },
      { type: 'add', zh: 'data-i18n-title 翻译 tooltip · data-i18n-html 翻译含元素长文本', en: 'data-i18n-title for tooltips, data-i18n-html for HTML rich text' },
      { type: 'fix', zh: '所有 alert / confirm / 动态生成 HTML 全部 t() 函数化', en: 'All alert/confirm/dynamically-generated HTML now use t()' },
      { type: 'fix', zh: 'setLang 11 项级联刷新 (含 document.title / 历史 modal / changelog)', en: 'setLang now cascades 11 refresh items (incl. title / history modal / changelog)' },
      { type: 'add', zh: '封禁原因/等级 / 分页/操作按钮 全 i18n', en: 'Ban reasons/levels/pagination/action buttons fully i18n' },
    ],
  },
  {
    version: 'v1.3.0',
    date: '2026-06-12',
    items: [
      { type: 'fix', zh: '原 favicon.ico 实际是 JPEG 格式 → 转为标准 PNG/ICO (高保真不模糊)', en: 'Original favicon.ico was actually JPEG → converted to standard PNG/ICO (sharp)' },
      { type: 'add', zh: 'HTML <link> 内嵌 base64 PNG dataUrl (0 HTTP 请求 · 0 闪烁)', en: 'HTML <link> embed base64 PNG dataUrl (0 HTTP, 0 flicker)' },
      { type: 'add', zh: 'localStorage 缓存 title/icon · F5 0 闪烁 (来自缓存立刻渲染)', en: 'localStorage cache title/icon, F5 zero-flicker (instant render)' },
      { type: 'fix', zh: 'main.js 写回缓存 · admin 改完用户 F5 立刻同步', en: 'main.js writes cache, admin changes propagate on user F5' },
    ],
  },
  {
    version: 'v1.2.0',
    date: '2026-06-12',
    items: [
      { type: 'add', zh: '主题设置卡片化 · 每张卡片加 ⚙ 按钮展开折叠设置面板', en: 'Theme settings card-ized: each card has ⚙ button with collapsible panel' },
      { type: 'add', zh: '设置面板含"默认值显示" · 用户看到当前 vs 默认对比', en: 'Settings panel shows "Default" reference: current vs default comparison' },
      { type: 'add', zh: '每张卡片独立保存 · 后端 API 支持子集更新 (互不影响)', en: 'Per-card independent save, backend API supports subset updates' },
      { type: 'add', zh: '[重置默认] 按钮 · 一键恢复出厂设置', en: '[Reset to default] button: one-click factory reset' },
    ],
  },
  {
    version: 'v1.1.0',
    date: '2026-06-12',
    items: [
      { type: 'add', zh: '浏览器标题 admin 后台可改 · 持久化 theme_names.json', en: 'Browser title editable in admin, persisted to theme_names.json' },
      { type: 'add', zh: '浏览器图标支持 URL 外链 + 本地文件上传 (base64 嵌入)', en: 'Browser icon: URL link + local file upload (base64 inline)' },
      { type: 'add', zh: '前端 main.js 启动时拉 API 设 document.title + <link rel=icon>', en: 'Frontend main.js fetches API on load to set document.title + favicon' },
      { type: 'add', zh: 'admin API: GET/POST /api/theme_names 支持名字+图标', en: 'admin API: GET/POST /api/theme_names supports names+icons' },
    ],
  },
  {
    version: 'v1.0.0',
    date: '2026-06-12',
    items: [
      { type: 'add', zh: '新增"关于"页面 · 含版本号 + 日期 + 完整更新日志', en: 'New "About" page with version, date and full changelog' },
      { type: 'del', zh: '移除左下角 "Relay v1.0" 显示, UI 更干净', en: 'Removed left-bottom "Relay v1.0" footer for cleaner UI' },
    ],
  },
  {
    version: 'v0.9.0',
    date: '2026-06-12',
    items: [
      { type: 'add', zh: '中英双语 i18n 系统 · 95 个翻译键 · localStorage 记忆', en: 'i18n system (zh/en) with 95 keys, localStorage persistence' },
      { type: 'add', zh: '右上角浮动顶栏 · 运行时间 + 语言 + 主题 + 用户菜单', en: 'Floating top-right bar: uptime + language + theme + user menu' },
      { type: 'add', zh: '用户菜单下拉 · 修改账号 / 修改密码 / 退出登录', en: 'User dropdown menu: change account / password / logout' },
      { type: 'add', zh: '修改密码 API + 弹窗 (原密验证 + 最低 4 位)', en: 'Change password API + modal (old-pass verify + min 4 chars)' },
      { type: 'add', zh: '修改账号 API + 弹窗 (密码二次确认)', en: 'Change username API + modal (password re-verify)' },
      { type: 'add', zh: '凭据持久化 credentials.json · 优先级 > env 默认', en: 'Credentials persistence via credentials.json (overrides env)' },
    ],
  },
  {
    version: 'v0.8.0',
    date: '2026-06-12',
    items: [
      { type: 'add', zh: '后台双主题切换 · 深色 (默认) + 浅色', en: 'Backend dual theme: Dark (default) + Light' },
      { type: 'add', zh: 'CSS 变量驱动主题 · 平滑 transition .3s', en: 'CSS variables-driven theming, smooth transition .3s' },
      { type: 'add', zh: 'ECharts 跟随主题自动重绘 (读 CSS 变量)', en: 'ECharts auto-recolor on theme switch (reads CSS variables)' },
    ],
  },
  {
    version: 'v0.7.0',
    date: '2026-06-12',
    items: [
      { type: 'add', zh: '每日峰值统计升级 ECharts 堆叠区域图 (跟 Cursor 后台同款风格)', en: 'Daily stats upgraded to ECharts stacked area chart (Cursor-style)' },
      { type: 'add', zh: '3 种指标 · 3 种图表类型 · 悬停 tooltip + Today 虚线标记', en: '3 metrics × 3 chart types, hover tooltip + Today marker' },
      { type: 'fix', zh: 'ECharts CDN 双备份 (jsdelivr + bootcdn)', en: 'ECharts CDN dual fallback (jsdelivr + bootcdn)' },
    ],
  },
  {
    version: 'v0.6.0',
    date: '2026-06-12',
    items: [
      { type: 'add', zh: '预览总开关 · admin 启动后才能访问 /_white/ /_black/', en: 'Preview master switch: /_white/ /_black/ requires admin enable' },
      { type: 'add', zh: 'nginx if -f flag 检测, 关闭时直接 404 (省带宽)', en: 'nginx if -f flag check, returns 404 when off (saves bandwidth)' },
      { type: 'add', zh: '预览房间功能 · 房间号输入 + &preview=1 跳过 landing', en: 'Preview room: room key input + &preview=1 skip landing' },
    ],
  },
  {
    version: 'v0.5.0',
    date: '2026-06-12',
    items: [
      { type: 'add', zh: '前端主题切换系统 · admin 一键切黑/白', en: 'Frontend theme switch: admin one-click black/white' },
      { type: 'add', zh: '主题预览卡片 · CSS 静态模拟缩略图', en: 'Theme preview cards with CSS static thumbnails' },
      { type: 'add', zh: 'left sidebar 导航 (总览/主题) · SVG 图标', en: 'Left sidebar navigation (Dashboard/Theme), SVG icons' },
    ],
  },
  {
    version: 'v0.4.0',
    date: '2026-06-11',
    items: [
      { type: 'fix', zh: '修复 HTML 中文/emoji 字符 PowerShell 编码破坏', en: 'Fix HTML encoding corruption by PowerShell Get/Set-Content' },
      { type: 'fix', zh: 'main.js goRadarNew 兜底 addEventListener', en: 'main.js goRadarNew fallback via addEventListener' },
      { type: 'improve', zh: 'nginx 缓存策略 · HTML no-cache, JS/CSS ETag 校验', en: 'nginx caching: HTML no-cache, JS/CSS ETag validation' },
    ],
  },
  {
    version: 'v0.3.0',
    date: '2026-06-11',
    items: [
      { type: 'add', zh: 'landing 半透明遮罩 · pub 失败时透看地图', en: 'landing semi-transparent overlay when pub fails' },
      { type: 'improve', zh: 'WSRadar_Ext 双 burst loop · 真人 10Hz / AI 5Hz 独立轮询', en: 'WSRadar_Ext dual burst loops: Humans 10Hz / AI 5Hz' },
      { type: 'fix', zh: 'ScanEntities 跳过 g_selfPawn 防本人重复显示', en: 'ScanEntities skip g_selfPawn to prevent duplicate self' },
    ],
  },
  {
    version: 'v0.2.0',
    date: '2026-06-11',
    items: [
      { type: 'add', zh: 'WSRadar 改造为外部 EXE · 内核驱动 R0 读内存', en: 'WSRadar refactored to external EXE with R0 kernel driver' },
      { type: 'add', zh: 'K2_GetActorLocation hook + cache 同步 SJZ_Radar', en: 'K2_GetActorLocation hook + cache, synced with SJZ_Radar' },
      { type: 'add', zh: 'NexusAuth 替代 previous authentication service (AES-256-GCM + HMAC)', en: 'NexusAuth replaces previous authentication service (AES-256-GCM + HMAC)' },
    ],
  },
  {
    version: 'v0.1.0',
    date: '2026-06-10',
    items: [
      { type: 'add', zh: '本地搭建完成 · 服务器部署 + 域名', en: 'Local deploy complete: server + nginx' },
      { type: 'add', zh: '集成 WSRadar_Ext 外部 EXE · 提供真实游戏数据源', en: 'Integrated WSRadar_Ext external EXE as real game data source' },
    ],
  },
  // ─── 上游 (原作者 yifengxinma/DeltaForce-WebRadar-REpro) ───
  {
    version: 'v0.0.2',
    date: '2026-04-11',
    upstream: true,
    url: '',
    items: [
      { type: 'add', zh: '添加 WebSocket 协议说明 (连接认证, 数据格式, 时序图)', en: 'WebSocket protocol docs (auth, data format, timing diagram)' },
      { type: 'add', zh: '添加 WebSocket 测试客户端 (C++ 源码, 可编译为 exe 发送假数据)', en: 'WebSocket test client (C++ source, compilable to exe with fake data)' },
      { type: 'add', zh: '添加测试客户端使用说明 (编译、运行、模拟数据频率表)', en: 'Test client usage docs (compile, run, data frequency table)' },
    ],
  },
  {
    version: 'v0.0.1',
    date: '2026-04-08',
    upstream: true,
    url: '',
    items: [
      { type: 'add', zh: '首次提交 · 三角洲行动 Web 雷达 (黑白双主题)', en: 'Initial commit: Delta Force web radar (dark/light themes)' },
      { type: 'add', zh: '添加截图 + 更新 README (含预览图)', en: 'Added screenshots and README preview images' },
      { type: 'add', zh: '添加 admin 后台截图 + 所有图压成 JPEG', en: 'Added admin screenshots + compressed all images to JPEG' },
      { type: 'del', zh: '删除 push_rooms.sh (开源版不需要)', en: 'Removed push_rooms.sh (unnecessary for open source)' },
    ],
  },
];

// 上游项目主页 (UPSTREAM 徽章默认跳这里)
const UPSTREAM_REPO_URL = '';

function renderChangelog() {
  // 更新顶部版本号 / 日期
  const v = document.getElementById('aboutVersion');
  const d = document.getElementById('aboutDate');
  if (v) v.textContent = APP_VERSION;
  if (d) d.textContent = APP_DATE;

  const wrap = document.getElementById('changelog');
  if (!wrap) return;
  wrap.innerHTML = CHANGELOG.map((entry, idx) => {
    const itemsHtml = entry.items.map(it => {
      const text = (_curLang === 'en' && it.en) ? it.en : it.zh;
      const tagText = t('tag_' + it.type) || it.type;
      return `<li class="cl-item ${it.type}">
        <span class="cl-tag ${it.type}">${tagText}</span>
        <span>${esc(text)}</span>
      </li>`;
    }).join('');
    let badge = '';
    let versionTag = `<span class="cl-version">${esc(entry.version)}</span>`;
    if (idx === 0) {
      badge = `<span class="cl-badge">${t('about_latest')}</span>`;
    } else if (entry.upstream) {
      badge = `<span class="cl-badge upstream">${t('about_upstream')}</span>`;
    }
    return `<div class="cl-entry${entry.upstream ? ' upstream' : ''}">
      <div class="cl-header">
        ${versionTag}
        <span class="cl-date">${esc(entry.date)}</span>
        ${badge}
      </div>
      <ul class="cl-items">${itemsHtml}</ul>
    </div>`;
  }).join('');
}

// ── 前端访问 URL (端口可在安全页配置, 默认 80) ──
let _frontendPort = 8080;

function getFrontendHost() {
  return new URLSearchParams(location.search).get('front_host') || location.hostname;
}

function getFrontendBase() {
  const host = getFrontendHost();
  const port = _frontendPort;
  const proto = location.protocol;
  const isDefault = (proto === 'http:' && port === 80) || (proto === 'https:' && port === 443);
  return isDefault ? `${proto}//${host}` : `${proto}//${host}:${port}`;
}

function updateFrontendAccessPreview() {
  const el = document.getElementById('frontendAccessPreview');
  if (!el) return;
  const sample = getFrontendBase() + '/?key=';
  el.textContent = t('frontend_access_preview').replace('{url}', sample);
}

function bindFrontendLinks() {
  const base = getFrontendBase();
  document.querySelectorAll('[data-preview]').forEach(a => {
    const theme = a.dataset.preview;
    a.href = base + '/_' + theme + '/';
  });
  // 预览房间号: 恢复上次输入
  const inp = document.getElementById('previewRoomKey');
  if (inp) {
    try { inp.value = localStorage.getItem('admin_preview_room') || ''; } catch (e) {}
    inp.addEventListener('input', () => {
      try { localStorage.setItem('admin_preview_room', inp.value.trim()); } catch (e) {}
    });
  }
}

// ══════════════════════════════════════════════════════════
// 主题浏览器标题 (管理员设置每个主题的 document.title)
// ══════════════════════════════════════════════════════════
// 主题默认值 (与前端 HTML 原 <title> 一致)
const THEME_DEFAULTS = {
  white:  { title: 'Holo Tactical Radar', icon: '/favicon.ico' },
  black:  { title: 'Divine Lock',         icon: '/favicon.ico' },
};
let _themeOrig = {
  white:  { title: '', icon: '' },
  black:  { title: '', icon: '' },
};
function _cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function setIf(id, val) { const el = document.getElementById(id); if (el) el.value = val; }

async function loadThemeNames() {
  try {
    const r = await fetch(API + '/api/theme_names');
    const j = await r.json();
    if (!j.ok) return;
    _themeOrig.white = { title: j.white || '', icon: j.iconWhite || '' };
    _themeOrig.black = { title: j.black || '', icon: j.iconBlack || '' };
    const ld = j.landing || {};
    for (const th of ['white', 'black']) {
      const cap = _cap(th);
      const lt = (ld[th] && ld[th].zh) || {};
      const le = (ld[th] && ld[th].en) || {};
      _themeOrig[th].landingTitleZh = lt.title || '';
      _themeOrig[th].landingDescZh  = lt.desc  || '';
      _themeOrig[th].landingTitleEn = le.title || '';
      _themeOrig[th].landingDescEn  = le.desc  || '';
      setIf('landingTitleZh' + cap, lt.title || '');
      setIf('landingDescZh'  + cap, lt.desc  || '');
      setIf('landingTitleEn' + cap, le.title || '');
      setIf('landingDescEn'  + cap, le.desc  || '');
    }
    setIf('titleInputWhite', _themeOrig.white.title);
    setIf('iconInputWhite',  _themeOrig.white.icon);
    setIf('titleInputBlack', _themeOrig.black.title);
    setIf('iconInputBlack',  _themeOrig.black.icon);
    const dw = document.getElementById('titleDefaultWhite');
    if (dw) dw.textContent = THEME_DEFAULTS.white.title;
    const db = document.getElementById('titleDefaultBlack');
    if (db) db.textContent = THEME_DEFAULTS.black.title;
    updateIconPreview('white');
    updateIconPreview('black');
    onSettingsDirty('white');
    onSettingsDirty('black');
    _bindDefaultIcons();
  } catch(e) { console.error('[ThemeNames]', e); }
}

function toggleThemeSettings(theme) {
  const panel = document.getElementById('settings' + _cap(theme));
  const gear  = document.querySelector(`.theme-card[data-theme="${theme}"] .tcb-gear`);
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (gear) gear.classList.toggle('active', isOpen);
}
// 兼容旧入口 (HTML 之前用 openThemeSettings)
function openThemeSettings(theme) { toggleThemeSettings(theme); }

function _settingsDirty(theme) {
  const cap = _cap(theme);
  const ti = document.getElementById('titleInput' + cap);
  const ii = document.getElementById('iconInput'  + cap);
  if (!ti || !ii) return false;
  const orig = _themeOrig[theme];
  if (ti.value.trim() !== orig.title.trim()) return true;
  if (ii.value !== orig.icon) return true;
  const fields = ['landingTitleZh', 'landingDescZh', 'landingTitleEn', 'landingDescEn'];
  for (const f of fields) {
    const el = document.getElementById(f + cap);
    if (el && el.value.trim() !== (orig[f] || '').trim()) return true;
  }
  return false;
}
function onSettingsDirty(theme) {
  const btn = document.getElementById('saveBtn' + _cap(theme));
  if (btn) btn.disabled = !_settingsDirty(theme);
}

function updateIconPreview(theme) {
  const inp = document.getElementById('iconInput' + _cap(theme));
  const img = document.getElementById('iconPreview' + _cap(theme));
  if (!inp || !img) return;
  const hasCustom = !!(inp.value && inp.value.trim());
  if (hasCustom) {
    img.src = inp.value.trim();
  } else {
    img.src = _defaultFaviconUrl(theme);
  }
  const tip = document.querySelector('[data-icon-fallback="' + theme + '"]');
  if (tip) tip.style.display = hasCustom ? 'none' : '';
}
function _defaultFaviconUrl(theme) {
  return '/favicon.ico';
}
function _bindDefaultIcons() {
  ['white', 'black'].forEach(updateIconPreview);
}
function onIconUrlInput(theme) { updateIconPreview(theme); }
function clearIcon(theme) {
  const inp = document.getElementById('iconInput' + _cap(theme));
  if (inp) inp.value = '';
  updateIconPreview(theme);
}
function onIconFileSelect(theme) {
  const f = document.getElementById('iconFile' + _cap(theme)).files[0];
  if (!f) return;
  if (f.size > 120 * 1024) { showAlert(t('icon_too_large')); return; }
  if (!f.type.startsWith('image/')) { showAlert(t('icon_invalid')); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const inp = document.getElementById('iconInput' + _cap(theme));
    if (inp) inp.value = e.target.result;
    updateIconPreview(theme);
    onSettingsDirty(theme);
  };
  reader.readAsDataURL(f);
}

function resetSettings(theme) {
  const cap = _cap(theme);
  setIf('titleInput' + cap, THEME_DEFAULTS[theme].title);
  setIf('iconInput'  + cap, THEME_DEFAULTS[theme].icon);
  setIf('landingTitleZh' + cap, '');
  setIf('landingDescZh'  + cap, '');
  setIf('landingTitleEn' + cap, '');
  setIf('landingDescEn'  + cap, '');
  updateIconPreview(theme);
  onSettingsDirty(theme);
}

async function saveOneTheme(theme) {
  const ti = document.getElementById('titleInput' + _cap(theme));
  const ii = document.getElementById('iconInput' + _cap(theme));
  const msg = document.getElementById('msg' + _cap(theme));
  const btn = document.getElementById('saveBtn' + _cap(theme));
  if (!ti || !ii) return;
  const cap = _cap(theme);
  const payload = {};
  payload[theme] = ti.value.trim();
  payload['icon' + cap] = ii.value;
  const ltz = document.getElementById('landingTitleZh' + cap);
  const ldz = document.getElementById('landingDescZh'  + cap);
  const lte = document.getElementById('landingTitleEn' + cap);
  const lde = document.getElementById('landingDescEn'  + cap);
  payload.landing = {};
  payload.landing[theme] = {
    zh: { title: ltz ? ltz.value.trim() : '', desc: ldz ? ldz.value.trim() : '' },
    en: { title: lte ? lte.value.trim() : '', desc: lde ? lde.value.trim() : '' },
  };
  if (msg) { msg.textContent = t('tnb_saving'); msg.className = 'tsp-msg'; }
  if (btn) btn.disabled = true;
  try {
    const data = await api('/api/theme_names', 'POST', payload);
    if (data.ok) {
      const ld = data.landing || {};
      const lzh = (ld[theme] && ld[theme].zh) || {};
      const len = (ld[theme] && ld[theme].en) || {};
      _themeOrig[theme] = {
        title: data[theme] || ti.value,
        icon:  data['icon' + cap] || '',
        landingTitleZh: lzh.title || '', landingDescZh: lzh.desc || '',
        landingTitleEn: len.title || '', landingDescEn: len.desc || '',
      };
      if (msg) { msg.textContent = t('saved') + ' ✓'; msg.className = 'tsp-msg ok'; }
      setTimeout(() => {
        if (msg) { msg.textContent = ''; msg.className = 'tsp-msg'; }
        onSettingsDirty(theme);
      }, 2500);
    } else {
      if (msg) { msg.textContent = t('tnb_save_failed') + ': ' + (data.error || ''); msg.className = 'tsp-msg err'; }
      if (btn) btn.disabled = false;
    }
  } catch(e) {
    if (msg) { msg.textContent = t('tnb_save_failed') + ': ' + e.message; msg.className = 'tsp-msg err'; }
    if (btn) btn.disabled = false;
  }
}


// ── 预览房间 (在指定主题下打开 /_<theme>/?key=<房间号>&preview=1) ──
// 加 preview=1 让前端跳过 landing 错误提示, 直接显示空地图等待数据
async function previewRoom(theme) {
  // 先检查预览总开关
  try {
    const r = await fetch(API + '/api/preview_status');
    const j = await r.json();
    if (!j.enabled) {
      if (await customConfirm(t('preview_off_confirm'))) {
        await api('/api/preview_status', 'POST', { enabled: true });
        loadPreviewMaster();
      } else {
        return;
      }
    }
  } catch (e) {}

  const inp = document.getElementById('previewRoomKey');
  const key = (inp && inp.value || '').trim();
  if (!key) {
    showAlert(t('preview_room_required'), 'warn');
    if (inp) inp.focus();
    return;
  }
  const url = getFrontendBase() + '/_' + theme + '/?key=' + encodeURIComponent(key) + '&preview=1';
  window.open(url, '_blank');
}

// ── 预览总开关 ──
async function loadPreviewMaster() {
  try {
    const r = await fetch(API + '/api/preview_status');
    const j = await r.json();
    const btn = document.getElementById('previewMasterBtn');
    const hint = document.getElementById('previewMasterHint');
    if (!btn) return;
    if (j.enabled) {
      btn.textContent = t('preview_master_on');
      btn.className = 'tcb primary';
      btn.dataset.enabled = '1';
      if (hint) hint.textContent = t('preview_master_enabled');
    } else {
      btn.textContent = t('preview_master_off');
      btn.className = 'tcb secondary';
      btn.dataset.enabled = '0';
      if (hint) hint.textContent = t('preview_master_disabled');
    }
  } catch (e) { console.error('[PreviewMaster]', e); }
}
async function togglePreviewMaster() {
  const btn = document.getElementById('previewMasterBtn');
  if (!btn) return;
  const newEnabled = btn.dataset.enabled !== '1';
  try {
    const data = await api('/api/preview_status', 'POST', { enabled: newEnabled });
    if (data.ok) loadPreviewMaster();
  } catch (e) { showAlert(t('theme_switch_failed') + ': ' + e.message); }
}

// ── 房间白名单 enforcement 开关 + 安全页 ──
let _whitelistKeys = [];
let _whitelistPullMode = false;

function renderWhitelistMeta(j) {
  const meta = document.getElementById('whitelistMeta');
  if (!meta) return;
  const readyCls = j.ready ? 'ok' : 'warn';
  const readyTxt = j.ready ? t('whitelist_meta_ready') : t('whitelist_meta_not_ready');
  const modeTxt = j.pullMode ? t('whitelist_meta_pull') : t('whitelist_meta_push');
  meta.innerHTML = `<span class="badge ${readyCls}">${esc(readyTxt)}</span>`
    + `<span class="badge">${esc(modeTxt)}</span>`
    + `<span>${t('whitelist_count').replace('{n}', j.count || 0)}</span>`;
}

function renderWhitelistRooms(keys) {
  _whitelistKeys = keys.slice();
  const box = document.getElementById('whitelistRoomList');
  if (!box) return;
  if (!keys.length) {
    box.innerHTML = `<div class="wl-empty">${t('whitelist_empty')}</div>`;
    return;
  }
  box.innerHTML = keys.map(k =>
    `<span class="wl-room-chip">${esc(k)}`
    + `<button type="button" data-admin-action="removeWhitelistRoom" data-admin-arg="${escAttr(k)}" title="${escAttr(t('delete'))}">×</button></span>`
  ).join('');
}

async function loadSecurityView() {
  try {
    await loadFrontendAccess(true);
    const j = await api('/api/whitelist');
    if (!j.ok) return;
    _whitelistPullMode = !!j.pullMode;
    renderWhitelistMeta(j);
    renderWhitelistRooms(j.keys || []);
    loadWhitelistMaster(j);
    const edit = document.getElementById('whitelistEditCard');
    const notice = document.getElementById('whitelistPullNotice');
    if (edit) edit.style.display = j.pullMode ? 'none' : '';
    if (notice) notice.style.display = j.pullMode ? '' : 'none';
    loadPrivacyMode();
    loadExtApi();
  } catch (e) { console.error('[SecurityView]', e); }
}

// ── Security 子 Tab 切换 ──
(function initSecTabs() {
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.sec-tab');
    if (!tab) return;
    const target = tab.dataset.secTab;
    if (!target) return;
    document.querySelectorAll('.sec-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.sec-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.secPane === target));
  });
})();

async function loadFrontendAccess(updateForm) {
  try {
    const j = await api('/api/frontend_access');
    if (!j.ok) return;
    _frontendPort = j.port || 80;
    if (updateForm) {
      const inp = document.getElementById('frontendPortInput');
      if (inp) inp.value = String(_frontendPort);
      updateFrontendAccessPreview();
    }
    bindFrontendLinks();
  } catch (e) { console.error('[FrontendAccess]', e); }
}

async function saveFrontendPort() {
  const inp = document.getElementById('frontendPortInput');
  const msg = document.getElementById('frontendAccessMsg');
  if (!inp) return;
  const port = parseInt(inp.value, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    if (msg) { msg.textContent = t('frontend_access_invalid'); msg.style.color = 'var(--red)'; }
    return;
  }
  if (msg) msg.textContent = '';
  try {
    const data = await api('/api/frontend_access', 'POST', { port });
    if (!data.ok) throw new Error(data.error || 'save failed');
    _frontendPort = data.port;
    updateFrontendAccessPreview();
    bindFrontendLinks();
    if (msg) { msg.textContent = t('frontend_access_saved'); msg.style.color = 'var(--green)'; }
  } catch (e) {
    let text = e.message || 'save failed';
    if (text === 'conflicts_with_admin_port') text = t('frontend_access_conflict_admin');
    else if (text === 'conflicts_with_ws_port') text = t('frontend_access_conflict_ws');
    else if (text === 'invalid_port') text = t('frontend_access_invalid');
    if (msg) { msg.textContent = text; msg.style.color = 'var(--red)'; }
  }
}

async function loadWhitelistMaster(cached) {
  const btn = document.getElementById('whitelistMasterBtn');
  const hint = document.getElementById('whitelistMasterHint');
  if (!btn) return;

  function render(j) {
    if (j.enabled) {
      btn.textContent = t('whitelist_master_on');
      btn.className = 'tcb primary';
      btn.dataset.enabled = '1';
      if (hint) hint.textContent = t('whitelist_master_enforced');
    } else {
      btn.textContent = t('whitelist_master_off');
      btn.className = 'tcb secondary';
      btn.dataset.enabled = '0';
      if (hint) hint.textContent = t('whitelist_master_open');
    }
  }

  if (cached) { render(cached); return; }

  try {
    const j = await api('/api/whitelist');
    if (j.ok) render(j);
  } catch (e) {
    try {
      const r = await fetch(API + '/api/rooms_status');
      const j = await r.json();
      if (j.ok) render({ enabled: !!j.enforced });
    } catch (err) { console.error('[WhitelistMaster]', err); }
  }
}

async function saveWhitelistKeys(keys) {
  const msg = document.getElementById('whitelistMsg');
  if (msg) msg.textContent = '';
  if (_whitelistPullMode) return;
  const data = await api('/api/whitelist', 'POST', { keys: keys.join('|') });
  if (!data.ok) throw new Error(data.error || 'save failed');
  renderWhitelistMeta(data);
  renderWhitelistRooms(data.keys || []);
  if (msg) { msg.textContent = t('whitelist_saved'); msg.style.color = 'var(--green)'; }
}

async function addWhitelistRoom() {
  if (_whitelistPullMode) return;
  const inp = document.getElementById('whitelistAddInput');
  const msg = document.getElementById('whitelistMsg');
  if (!inp) return;
  const key = inp.value.trim();
  if (!key) { inp.focus(); return; }
  if (!/^[\w.\-|]{1,64}$/.test(key)) {
    if (msg) { msg.textContent = t('whitelist_invalid_key'); msg.style.color = 'var(--red)'; }
    return;
  }
  if (_whitelistKeys.includes(key)) {
    if (msg) { msg.textContent = t('whitelist_duplicate'); msg.style.color = 'var(--yellow)'; }
    return;
  }
  try {
    await saveWhitelistKeys([..._whitelistKeys, key]);
    inp.value = '';
  } catch (e) {
    if (msg) { msg.textContent = e.message; msg.style.color = 'var(--red)'; }
  }
}

async function removeWhitelistRoom(key) {
  if (_whitelistPullMode) return;
  if (!await customConfirm(t('whitelist_remove_confirm').replace('{key}', key))) return;
  try {
    await saveWhitelistKeys(_whitelistKeys.filter(k => k !== key));
  } catch (e) {
    const msg = document.getElementById('whitelistMsg');
    if (msg) { msg.textContent = e.message; msg.style.color = 'var(--red)'; }
  }
}

function loadWhitelistBulk() {
  const ta = document.getElementById('whitelistBulkInput');
  if (ta) ta.value = _whitelistKeys.join('|');
}

async function saveWhitelistBulk() {
  const ta = document.getElementById('whitelistBulkInput');
  if (!ta || _whitelistPullMode) return;
  const keys = ta.value.split('|').map(k => k.trim()).filter(Boolean);
  try {
    await saveWhitelistKeys(keys);
  } catch (e) {
    const msg = document.getElementById('whitelistMsg');
    if (msg) { msg.textContent = e.message; msg.style.color = 'var(--red)'; }
  }
}

async function toggleWhitelistMaster() {
  const btn = document.getElementById('whitelistMasterBtn');
  if (!btn) return;
  const newEnabled = btn.dataset.enabled !== '1';
  const msg = newEnabled ? t('whitelist_enable_confirm') : t('whitelist_disable_confirm');
  if (!await customConfirm(msg)) return;
  try {
    const data = await api('/api/whitelist', 'POST', { enabled: newEnabled });
    if (data.ok) loadSecurityView();
  } catch (e) { showAlert(t('theme_switch_failed') + ': ' + e.message); }
}

// ── Privacy Mode ──
async function loadPrivacyMode() {
  try {
    const j = await api('/api/privacy_mode');
    if (!j.ok) return;
    const btn = document.getElementById('privacyModeBtn');
    const hint = document.getElementById('privacyModeHint');
    if (btn) {
      btn.dataset.enabled = j.enabled ? '1' : '0';
      btn.textContent = j.enabled ? t('privacy_mode_on') : t('privacy_mode_off');
      btn.classList.toggle('danger', j.enabled);
    }
    if (hint) hint.textContent = j.enabled ? t('privacy_mode_status_on') : t('privacy_mode_status_off');
  } catch (e) { console.error('[PrivacyMode]', e); }
}

async function togglePrivacyMode() {
  const btn = document.getElementById('privacyModeBtn');
  if (!btn) return;
  const newEnabled = btn.dataset.enabled !== '1';
  try {
    const data = await api('/api/privacy_mode', 'POST', { enabled: newEnabled });
    if (data.ok) loadPrivacyMode();
  } catch (e) { showAlert(t('privacy_mode_save_fail') + ': ' + e.message); }
}

// ── External API Sync ──
async function loadExtApi() {
  try {
    const j = await api('/api/ext_api');
    if (!j.ok) return;
    const urlInp = document.getElementById('extApiUrlInput');
    const intInp = document.getElementById('extApiIntervalInput');
    const unitSel = document.getElementById('extApiUnitSelect');
    const stopBtn = document.getElementById('extApiStopBtn');
    const statusEl = document.getElementById('extApiStatus');
    if (urlInp) urlInp.value = j.url || '';
    if (intInp) intInp.value = j.interval || 10;
    if (unitSel) unitSel.value = j.unit || 'm';
    if (stopBtn) stopBtn.style.display = j.active ? '' : 'none';
    if (statusEl) {
      if (!j.url) {
        statusEl.innerHTML = `<span class="badge">${t('ext_api_idle')}</span>`;
      } else if (j.active && j.running) {
        const unitLabel = j.unit === 's' ? t('unit_seconds') : j.unit === 'h' ? t('unit_hours') : t('unit_minutes');
        let html = `<span class="badge ok">${t('ext_api_running')}</span> <span>${t('ext_api_every')} ${j.interval} ${unitLabel}</span>`;
        if (j.lastFetchAt) {
          const ago = Math.round((Date.now() - j.lastFetchAt) / 1000);
          const statusIcon = j.lastStatus === 'ok' ? '✓' : '✗';
          const statusColor = j.lastStatus === 'ok' ? 'var(--green)' : 'var(--red)';
          html += ` · <span style="color:${statusColor}">${statusIcon} ${j.lastStatus}</span>`;
          html += ` · ${t('ext_api_last_fetch')} ${ago}${t('unit_sec_short')}${t('ext_api_ago')}`;
          if (j.lastStatus === 'ok') html += ` · ${j.lastCount} ${t('ext_api_keys')}`;
        }
        statusEl.innerHTML = html;
      } else {
        statusEl.innerHTML = `<span class="badge">${t('ext_api_stopped')}</span>`;
      }
    }
    if (j.lastKeys && j.lastKeys.length > 0) {
      _renderExtApiKeys(j.lastKeys, t('ext_api_synced_keys'));
    } else {
      _renderExtApiKeys([]);
    }
  } catch (e) { console.error('[ExtApi]', e); }
}

async function saveExtApi() {
  const urlInp = document.getElementById('extApiUrlInput');
  const intInp = document.getElementById('extApiIntervalInput');
  const unitSel = document.getElementById('extApiUnitSelect');
  const msg = document.getElementById('extApiMsg');
  if (!urlInp) return;
  const url = urlInp.value.trim();
  if (!url) {
    if (msg) { msg.textContent = t('ext_api_url_required'); msg.style.color = 'var(--red)'; }
    return;
  }
  try { new URL(url); } catch {
    if (msg) { msg.textContent = t('ext_api_url_invalid'); msg.style.color = 'var(--red)'; }
    return;
  }
  const interval = parseInt(intInp?.value) || 10;
  const unit = unitSel?.value || 'm';
  if (msg) msg.textContent = '';
  try {
    const data = await api('/api/ext_api', 'POST', { url, interval, unit });
    if (!data.ok) throw new Error(data.error || 'save failed');
    if (msg) { msg.textContent = t('ext_api_saved'); msg.style.color = 'var(--green)'; }
    loadExtApi();
  } catch (e) {
    if (msg) { msg.textContent = t('ext_api_save_fail') + ': ' + e.message; msg.style.color = 'var(--red)'; }
  }
}

let _extApiKeysData = [];
let _extApiKeysPage = 0;
const _EXT_KEYS_PER_PAGE = 50;

function _renderExtApiKeys(keys, title) {
  _extApiKeysData = keys || [];
  _extApiKeysPage = 0;
  _renderExtApiKeysPage(title);
}

function _renderExtApiKeysPage(title) {
  const listEl = document.getElementById('extApiKeysList');
  if (!listEl) return;
  if (!_extApiKeysData.length) { listEl.style.display = 'none'; return; }
  listEl.style.display = '';
  const total = _extApiKeysData.length;
  const totalPages = Math.ceil(total / _EXT_KEYS_PER_PAGE);
  if (_extApiKeysPage >= totalPages) _extApiKeysPage = totalPages - 1;
  if (_extApiKeysPage < 0) _extApiKeysPage = 0;
  const start = _extApiKeysPage * _EXT_KEYS_PER_PAGE;
  const page = _extApiKeysData.slice(start, start + _EXT_KEYS_PER_PAGE);
  const ttl = title || t('ext_api_synced_keys');
  let html = `<div style="margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;font-family:inherit"><span style="font-weight:600;color:var(--dim)">${ttl} (${total})</span>`;
  if (totalPages > 1) {
    html += `<span style="font-size:11px;color:var(--dim)">${_extApiKeysPage + 1}/${totalPages}</span>`;
  }
  html += '</div>';
  html += page.map(k => `<span style="display:inline-block;padding:2px 8px;margin:2px;border-radius:4px;background:rgba(74,158,255,0.1);color:var(--accent,#4a9eff)">${esc(k)}</span>`).join('');
  if (totalPages > 1) {
    html += `<div style="margin-top:8px;display:flex;gap:4px;justify-content:center">`;
    html += `<button class="action-btn" ${_extApiKeysPage <= 0 ? 'disabled' : ''} data-admin-action="extApiKeysNav" data-admin-arg="prev">‹ ${t('page_prev')}</button>`;
    html += `<button class="action-btn" ${_extApiKeysPage >= totalPages - 1 ? 'disabled' : ''} data-admin-action="extApiKeysNav" data-admin-arg="next">${t('page_next')} ›</button>`;
    html += `</div>`;
  }
  listEl.innerHTML = html;
}

function extApiKeysNav(dir) {
  if (dir === 'prev') _extApiKeysPage--;
  else _extApiKeysPage++;
  _renderExtApiKeysPage();
}

async function testExtApi() {
  const urlInp = document.getElementById('extApiUrlInput');
  const msg = document.getElementById('extApiMsg');
  const listEl = document.getElementById('extApiKeysList');
  if (!urlInp) return;
  const url = urlInp.value.trim();
  if (!url) {
    if (msg) { msg.textContent = t('ext_api_url_required'); msg.style.color = 'var(--red)'; }
    return;
  }
  if (msg) { msg.textContent = t('ext_api_testing'); msg.style.color = 'var(--dim)'; }
  try {
    const data = await api('/api/ext_api/test', 'POST', { url });
    if (data.ok) {
      if (msg) { msg.textContent = `${t('ext_api_test_ok')} ${data.total} ${t('ext_api_keys')}`; msg.style.color = 'var(--green)'; }
      if (data.keys) _renderExtApiKeys(data.keys, t('ext_api_preview_title'));
    } else {
      if (msg) { msg.textContent = `${t('ext_api_test_fail')}: ${data.error}`; msg.style.color = 'var(--red)'; }
      if (listEl) listEl.style.display = 'none';
    }
  } catch (e) {
    if (msg) { msg.textContent = `${t('ext_api_test_fail')}: ${e.message}`; msg.style.color = 'var(--red)'; }
  }
}

async function stopExtApi() {
  try {
    const data = await api('/api/ext_api/stop', 'POST', {});
    if (data.ok) loadExtApi();
  } catch (e) { console.error('[ExtApi] stop error:', e); }
}

// ── Theme switch (新版 卡片样式) ──
async function loadTheme() {
  try {
    const r = await fetch(API + '/api/theme');
    const j = await r.json();
    if (!j.ok) return;
    const cur = j.theme;
    document.querySelectorAll('.theme-card').forEach(card => {
      const isCur = card.dataset.theme === cur;
      card.classList.toggle('active', isCur);
      const btn = card.querySelector('.tcb.primary');
      if (btn) {
        btn.classList.toggle('done', isCur);
        btn.textContent = isCur ? t('current_in_use') : t('switch_to_this');
      }
    });
    const hint = document.getElementById('themeHint');
    if (hint) {
      const name = cur === 'white' ? t('theme_white_label') : cur === 'black' ? t('theme_black_label') : (t('theme_unknown_label') + ' (' + cur + ')');
      hint.textContent = t('theme_current_label') + ': ' + name;
      hint.style.color = '';
    }
  } catch (e) { console.error('[Theme] load:', e); }
}
async function switchTheme(theme) {
  try {
    const data = await api('/api/theme', 'POST', { theme });
    if (data.ok) {
      loadTheme();
      const hint = document.getElementById('themeHint');
      if (hint) {
        hint.textContent = t('theme_switched_to').replace('{theme}', theme === 'white' ? t('theme_white_label') : t('theme_black_label'));
        hint.style.color = 'var(--green)';
      }
      showAlert(t('theme_switched_to').replace('{theme}', theme === 'white' ? t('theme_white_label') : t('theme_black_label')) + ' · F5', 'ok');
    } else {
      showAlert(t('theme_switch_failed') + ': ' + (data.error || t('theme_unknown_val')));
    }
  } catch (e) { showAlert(t('theme_switch_failed') + ': ' + e.message); }
}

// ── API ──
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Authorization': 'Bearer ' + token } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(API + path, opts);
  if (res.status === 401) { doLogout(); throw new Error('Unauthorized'); }
  if (res.status === 403 || res.status === 429) { const d = await res.json(); if (d.remain > 0) showAlert(t('ip_limited').replace('{n}', d.remain), 'warn'); throw new Error(d.error); }
  return res.json();
}

// ── Data refresh ──
async function refreshData() {
  try {
    const q = document.getElementById('searchInput').value.trim();
    const [data] = await Promise.all([
      api('/api/rooms?q=' + encodeURIComponent(q)),
      refreshActiveRecordings(),
    ]);
    if (!data.ok) return;
    renderStats(data.stats);
    _allRooms = data.rooms || [];
    applyRoomFilters();
    if (currentTab === 'bans') {
      const bData = await api('/api/bans');
      if (bData.ok) { buildBanList(bData.bans || [], bData.adminBans || []); applyBanFilters(); }
    }
  } catch (e) { console.error(e); }
}

function renderStats(s) {
  document.getElementById('sRooms').textContent = s.rooms;
  document.getElementById('sPubs').textContent = s.pubs;
  document.getElementById('sSubs').textContent = s.subs;
  document.getElementById('sBans').textContent = s.bans;
  document.getElementById('uptime').textContent = s.uptime;
  document.getElementById('sDlSec').textContent = s.dlPerSecStr || '0 B/s';
  document.getElementById('sUlSec').textContent = s.ulPerSecStr || '0 B/s';
  document.getElementById('sDlTotal').textContent = s.dlTotalStr || '0 B';
  document.getElementById('sUlTotal').textContent = s.ulTotalStr || '0 B';
}

// ── Room filtering + pagination ──
function applyRoomFilters() {
  const dllF = document.getElementById('filterDLL').value;
  const gameF = document.getElementById('filterGame').value;
  let list = _allRooms;
  if (dllF === 'on') list = list.filter(r => r.hasPub);
  else if (dllF === 'off') list = list.filter(r => !r.hasPub);
  if (gameF === 'in') list = list.filter(r => r.inGame);
  else if (gameF === 'out') list = list.filter(r => !r.inGame);
  renderPagedRooms(list);
}
function _roomsPerPage() { return parseInt(document.getElementById('roomsPerPage')?.value) || 100; }
function _bansPerPage() { return parseInt(document.getElementById('bansPerPage')?.value) || 100; }

function renderPagedRooms(list) {
  const total = list.length;
  const ps = _roomsPerPage();
  const pages = Math.max(1, Math.ceil(total / ps));
  if (roomPage >= pages) roomPage = pages - 1;
  const start = roomPage * ps;
  const slice = list.slice(start, start + ps);
  const tbody = document.getElementById('roomsBody');
  if (!slice.length) { tbody.innerHTML = `<tr><td colspan="11" class="empty">${t('empty_rooms')}</td></tr>`; }
  else {
    tbody.innerHTML = slice.map(r => `<tr>
      <td class="mono" style="cursor:pointer;text-decoration:underline" data-admin-action="showRoomHist" data-admin-arg="${escAttr(r.key)}">${esc(r.key)}</td>
      <td>${r.hasPub ? `<span class="badge badge-green">${t('badge_online')}</span>` : `<span class="badge badge-dim">${t('badge_offline')}</span>`}</td>
      <td><b>${r.subs}</b><span style="color:var(--dim)"> / 4</span></td>
      <td>${r.inGame ? '<span class="badge badge-green">' + esc(shortMap(r.mapName)) + '</span>' : '<span class="badge badge-dim">' + esc(r.mapName) + '</span>'}</td>
      <td class="ip">${maskIP(r.pubIP)}</td>
      <td>${r.pubUptime}</td>
      <td>${r.createdAgo}</td>
      <td style="color:var(--yellow)">${r.msgPerSec || 0}</td>
      <td style="color:var(--accent)">${r.bwStr || '0 B/s'}</td>
      <td style="color:var(--dim)">${r.totalBytesStr || '0B'}</td>
      <td>
        <button class="action-btn enter" data-admin-action="openRoom" data-admin-arg="${escAttr(r.key)}">${t('action_enter')}</button>
        <button class="action-btn rec-btn ${_activeRecKeys.has(r.key) ? 'recording' : ''}" data-admin-action="toggleRecording" data-admin-arg="${escAttr(r.key)}">${_activeRecKeys.has(r.key) ? '■ ' + t('rec_stop') : '● ' + t('rec_start')}</button>
        <button class="action-btn" data-admin-action="kickRoom" data-admin-arg="${escAttr(r.key)}" data-admin-arg2="all">${t('action_kick')}</button>
      </td>
    </tr>`).join('');
  }
  renderPager('roomsPager', total, pages, roomPage, p => { roomPage = p; applyRoomFilters(); });
}

// ── Ban filtering + pagination ──
let _mergedBans = [];
function buildBanList(relay, admin) {
  _mergedBans = [];
  relay.forEach(b => _mergedBans.push({...b, src: 'Relay(WS)', srcKey: 'relay'}));
  admin.forEach(b => _mergedBans.push({...b, src: t('ban_src_admin'), srcKey: 'admin'}));
  _mergedBans.sort((a,b) => (b.remainMs||0) - (a.remainMs||0));
}
function applyBanFilters() {
  const q = (document.getElementById('banSearchInput')?.value || '').trim();
  const srcF = document.getElementById('filterBanSrc').value;
  let list = _mergedBans;
  if (q) list = list.filter(b => b.ip.includes(q));
  if (srcF) list = list.filter(b => b.srcKey === srcF);
  renderPagedBans(list);
}
function renderPagedBans(list) {
  const total = list.length;
  const ps = _bansPerPage();
  const pages = Math.max(1, Math.ceil(total / ps));
  if (banPage >= pages) banPage = pages - 1;
  const start = banPage * ps;
  const slice = list.slice(start, start + ps);
  const tbody = document.getElementById('bansBody');
  const lvNames = ['', t('ban_lv_1m'), t('ban_lv_10m'), t('ban_lv_30m'), t('ban_lv_1h')];
  if (!slice.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty">${t('empty_bans')}</td></tr>`; }
  else {
    tbody.innerHTML = slice.map(b => {
      const lvText = b.level != null ? `Lv${b.level} (${lvNames[b.level]||'?'})` : '-';
      const reasonMap = {'auth_flood':t('ban_reason_auth_flood'),'pub_flood':t('ban_reason_pub_flood'),'msg_too_large':t('ban_reason_msg_too_large'),'admin_manual':t('ban_reason_admin_manual'),'admin_rate_burst':t('ban_reason_admin_rate_burst'),'admin_rate_flood_1h':t('ban_reason_admin_flood_1h'),'admin_login_fail_5x':t('ban_reason_login_fail_5x')};
      const reason = b.reason ? (reasonMap[b.reason] || b.reason) : '-';
      return `<tr>
      <td class="ip">${maskIP(b.ip)}</td>
      <td><span class="badge ${b.srcKey==='admin'?'badge-yellow':'badge-red'}">${esc(b.src)}</span></td>
      <td>${esc(reason)}</td>
      <td>${b.level != null ? '<span class="badge badge-red">'+lvText+'</span>' : '-'}</td>
      <td>${b.remain}</td>
      <td><button class="action-btn unban" data-admin-action="unbanIP" data-admin-arg="${escAttr(b.ip)}">${t('action_unban')}</button></td>
    </tr>`;
    }).join('');
  }
  renderPager('bansPager', total, pages, banPage, p => { banPage = p; applyBanFilters(); });
}

// ── Pager ──
function _fmtTotal(n) {
  const tpl = t('total_count') || '共 {n} 条';
  return tpl.replace('{n}', n);
}

function renderPager(id, total, pages, current, onPage) {
  const el = document.getElementById(id);
  if (pages <= 1) { el.innerHTML = `<span>${_fmtTotal(total)}</span><span></span>`; return; }
  el.innerHTML = `<span>${_fmtTotal(total)}, ${current+1}/${pages}</span>
    <div class="pager-btns">
      <button class="pager-btn ${current<=0?'disabled':''}" id="${id}_prev">${t('page_prev_btn')}</button>
      <button class="pager-btn ${current>=pages-1?'disabled':''}" id="${id}_next">${t('page_next_btn')}</button>
    </div>`;
  document.getElementById(id+'_prev').onclick = () => { if (current > 0) onPage(current - 1); };
  document.getElementById(id+'_next').onclick = () => { if (current < pages - 1) onPage(current + 1); };
}

// ── Actions ──
function openRoom(key) {
  const url = getFrontendBase() + '/?key=' + encodeURIComponent(key);
  window.open(url, '_blank');
}
async function kickRoom(key, target) { if (!await customConfirm(t('confirm_kick').replace('{key}', key))) return; await api('/api/kick','POST',{key,target}); refreshData(); }
async function unbanIP(ip) { if (!await customConfirm(t('confirm_unban').replace('{ip}', ip))) return; await api('/api/ban','POST',{unban:ip}); refreshData(); }

// ── Tab ──
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => { if (t.dataset.tab === tab) t.classList.add('active'); });
  const tabs = ['Rooms','Bans','RoomEvents','BanEvents'];
  tabs.forEach(n => { const el = document.getElementById('tab'+n); if (el) el.style.display = n.toLowerCase() === tab.toLowerCase() || (n === 'Rooms' && tab === 'rooms') || (n === 'Bans' && tab === 'bans') || (n === 'RoomEvents' && tab === 'roomEvents') || (n === 'BanEvents' && tab === 'banEvents') ? '' : 'none'; });
  if (tab === 'roomEvents') loadRoomEvents();
  else if (tab === 'banEvents') loadBanEvents();
  else refreshData();
}

function onRoomFilter() { roomPage = 0; refreshData(); }

// ── History Modal (ECharts + 表格双展示) ──
let _histData = [];
let _histChart = null;

async function showHistory() {
  document.getElementById('historyModal').classList.add('show');
  try {
    const data = await api('/api/history');
    if (!data.ok || !data.history) return;
    _histData = data.history || [];

    // 表格
    renderHistTable();
    // 全屏布局需要稍等再量宽高
    setTimeout(() => {
      renderHistChart();
      if (_histChart) _histChart.resize();
    }, 80);
  } catch(e) { console.error(e); }
}
function closeHistory() {
  document.getElementById('historyModal').classList.remove('show');
  // 图表不要 dispose, 下次 show 直接 setOption 复用
}

function renderHistTable() {
  const tbody = document.getElementById('historyBody');
  if (!_histData.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty">${t('empty_history')}</td></tr>`;
    return;
  }
  tbody.innerHTML = _histData.map((d, i) => {
    const isToday = i === 0;
    return `<tr class="${isToday ? 'is-today' : ''}">
      <td class="hist-td is-accent">${esc(d.date)}${isToday ? ' ' + t('today_mark') : ''}</td>
      <td class="hist-td">${d.peakRooms}</td>
      <td class="hist-td is-ok">${d.peakPubs}</td>
      <td class="hist-td is-warn">${d.peakSubs}</td>
      <td class="hist-td is-danger">${d.peakBans}</td>
      <td class="hist-td is-ok">${esc(d.peakDlSecStr)}</td>
      <td class="hist-td is-accent">${esc(d.peakUlSecStr)}</td>
      <td class="hist-td is-muted">${esc(d.dlDayStr)}</td>
      <td class="hist-td is-muted">${esc(d.ulDayStr)}</td>
      <td><button class="action-btn" data-admin-action="clearHistDate" data-admin-arg="${escAttr(d.date)}" style="color:var(--red);font-size:11px">${t('action_delete')}</button></td>
    </tr>`;
  }).join('');
}

// 字节简短格式
function fmtBytesShort(b) {
  if (!b) return '0';
  if (b < 1024)        return b + ' B';
  if (b < 1048576)     return (b / 1024).toFixed(1) + ' K';
  if (b < 1073741824)  return (b / 1048576).toFixed(1) + ' M';
  return (b / 1073741824).toFixed(2) + ' G';
}

function renderHistChart() {
  if (typeof echarts === 'undefined') {
    console.error('[Hist] ECharts 没加载');
    return;
  }
  const metric = (document.getElementById('histMetric') || {}).value || 'users';
  const type   = (document.getElementById('histType')   || {}).value || 'area';
  const range  = (document.getElementById('histRange')  || {}).value || '30';
  if (!_histData.length) return;

  // 数据按时间正序 (后端默认倒序, 倒过来)
  let ordered = _histData.slice().reverse();
  
  // 按照筛选范围裁剪天数，避免图表太拥挤
  if (range !== 'all') {
    const days = parseInt(range, 10);
    if (ordered.length > days) {
      ordered = ordered.slice(-days);
    }
  }
  
  const dates = ordered.map(d => d.date.slice(5)); // MM-DD

  let series = [];
  let isBytes = false;
  if (metric === 'users') {
    series = [
      { name: t('chart_room_peak'), data: ordered.map(d => d.peakRooms), color: '#64b5ff' },
      { name: t('chart_dll_peak'),  data: ordered.map(d => d.peakPubs),  color: '#6bcf8e' },
      { name: t('chart_view_peak'), data: ordered.map(d => d.peakSubs),  color: '#e0b35a' },
      { name: t('chart_ban_peak'),  data: ordered.map(d => d.peakBans),  color: '#ff8a80' },
    ];
  } else if (metric === 'bw_peak') {
    isBytes = true;
    series = [
      { name: t('chart_dl_peak'), data: ordered.map(d => d.peakDlSec), color: '#6bcf8e' },
      { name: t('chart_ul_peak'), data: ordered.map(d => d.peakUlSec), color: '#64b5ff' },
    ];
  } else { // bw_total
    isBytes = true;
    series = [
      { name: t('chart_dl_day'), data: ordered.map(d => d.dlDay), color: '#6bcf8e' },
      { name: t('chart_ul_day'), data: ordered.map(d => d.ulDay), color: '#64b5ff' },
    ];
  }

  const isStack = (type === 'area'); // 只有 area 走堆叠，折线和柱状图不堆叠
  const eType   = (type === 'bar') ? 'bar' : 'line';
  const isArea  = (type === 'area');
  const fmt     = isBytes ? fmtBytesShort : (v) => v;

  // 今天的索引 (用 markLine 画虚线)
  const todayIdx = ordered.length - 1;

  // 读 CSS 主题变量, 让图表跟着深/浅主题变色
  const cs = getComputedStyle(document.body);
  const C = {
    axisText: cs.getPropertyValue('--dim').trim()    || '#8b949e',
    axisLine: cs.getPropertyValue('--border').trim() || '#30363d',
    tipBg:    cs.getPropertyValue('--tooltip-bg').trim()     || 'rgba(22,27,34,0.96)',
    tipBd:    cs.getPropertyValue('--tooltip-border').trim() || 'rgba(255,255,255,0.08)',
    tipText:  cs.getPropertyValue('--tooltip-text').trim()   || '#e6edf3',
    accent:   cs.getPropertyValue('--accent').trim() || '#58a6ff',
  };

  const option = {
    backgroundColor: 'transparent',
    grid: { left: 52, right: 20, top: 28, bottom: 64, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: C.tipBg,
      borderColor: C.tipBd,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: C.tipText, fontSize: 12 },
      extraCssText: 'box-shadow:0 12px 32px rgba(0,0,0,0.22);border-radius:12px;backdrop-filter:blur(12px);',
      formatter: (params) => {
        if (!params || !params.length) return '';
        const date = params[0].axisValue;
        let html = `<div style="font-weight:600;margin-bottom:4px;color:${C.tipText}">${date}</div>`;
        html += `<div style="font-size:10px;color:${C.axisText};margin-bottom:6px">${t('chart_daily_detail')}</div>`;
        let total = 0;
        params.forEach(p => {
          html += `<div style="display:flex;justify-content:space-between;gap:14px;margin-bottom:2px;align-items:center">
            <span style="color:${C.axisText};font-size:11px;display:flex;align-items:center;gap:5px">
              <span style="color:${p.color};font-size:10px">●</span>${p.seriesName}
            </span>
            <span style="font-weight:600;color:${C.tipText};font-variant-numeric:tabular-nums">${fmt(p.value)}</span>
          </div>`;
          total += Number(p.value) || 0;
        });
        if (isStack && series.length > 1) {
          html += `<div style="border-top:1px solid ${C.tipBd};margin-top:6px;padding-top:5px;display:flex;justify-content:space-between">
            <b style="color:${C.tipText};font-size:11px">${t('chart_total')}</b>
            <b style="color:${C.tipText};font-variant-numeric:tabular-nums">${fmt(total)}</b>
          </div>`;
        }
        return html;
      },
    },
    legend: {
      data: series.map(s => s.name),
      bottom: 4,
      textStyle: { color: C.axisText, fontSize: 11 },
      itemWidth: 14,
      itemHeight: 8,
      itemGap: 16,
      icon: 'roundRect',
    },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: true,
      axisLabel: { color: C.axisText, fontSize: 11, rotate: -40, margin: 12 },
      axisLine:  { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
      axisTick:  { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: C.axisText, fontSize: 10,
        formatter: (v) => isBytes ? fmtBytesShort(v) : v,
      },
      axisLine:  { show: false },
      axisTick:  { show: false },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)', type: 'dashed' } },
      splitArea: { show: false },
    },
    series: series.map(s => ({
      name: s.name,
      type: eType,
      stack: isStack ? 'total' : undefined,
      smooth: eType === 'line',
      symbol: 'circle',
      symbolSize: 5,
      showSymbol: ordered.length <= 14,
      data: s.data,
      lineStyle: { width: 2.2 },
      itemStyle: {
        color: s.color,
        borderColor: s.color,
        borderRadius: eType === 'bar' ? [4, 4, 0, 0] : 0
      },
      barWidth: eType === 'bar' ? '30%' : undefined,
      barMaxWidth: 24,
      showBackground: false,
      areaStyle: isArea ? {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: s.color + '44' },
            { offset: 1, color: s.color + '00' },
          ],
        },
      } : undefined,
      ...(eType === 'bar' ? {
        itemStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: s.color },
              { offset: 1, color: s.color + '33' }
            ]
          },
          borderRadius: [5, 5, 0, 0]
        }
      } : {}),
      markLine: (todayIdx >= 0) ? {
        silent: true,
        symbol: 'none',
        lineStyle: { color: C.accent, type: 'dashed', width: 1, opacity: 0.45 },
        label: {
          formatter: 'Today', position: 'insideEndTop',
          color: C.accent, fontSize: 10, distance: 4,
        },
        data: [{ xAxis: dates[todayIdx] }],
      } : undefined,
    })),
    animationDuration: 520,
    animationEasing: 'cubicOut',
  };

  if (!_histChart) {
    _histChart = echarts.init(document.getElementById('histChart'), null, { renderer: 'svg' });
    window.addEventListener('resize', () => _histChart && _histChart.resize());
  }
  _histChart.setOption(option, true);
  _histChart.resize();
}
// ── Custom Confirm ──
function customConfirm(msg, opts) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  const type = normalizePromptType(options.type || inferConfirmType(msg));
  return new Promise(resolve => {
    const overlay = document.getElementById('confirmOverlay');
    setConfirmChrome(type, options.title);
    document.getElementById('confirmMsg').textContent = msg;
    overlay.classList.add('show');
    const yes = document.getElementById('confirmYes');
    const no = document.getElementById('confirmNo');
    function cleanup(val) { overlay.classList.remove('show'); yes.onclick = null; no.onclick = null; resolve(val); }
    yes.onclick = () => cleanup(true);
    no.onclick = () => cleanup(false);
  });
}
function customPrompt(msg, defaultVal, opts) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  return new Promise(resolve => {
    const overlay = document.getElementById('confirmOverlay');
    setConfirmChrome(options.type || 'info', options.title || t('prompt_title_input'));
    const msgEl = document.getElementById('confirmMsg');
    msgEl.innerHTML = esc(msg) + '<br><input type="text" id="promptInput" value="' + esc(defaultVal || '') + '" autocomplete="off" spellcheck="false">';
    overlay.classList.add('show');
    setTimeout(() => { const inp = document.getElementById('promptInput'); if (inp) { inp.focus(); inp.select(); } }, 100);
    const yes = document.getElementById('confirmYes');
    const no = document.getElementById('confirmNo');
    function cleanup(val) { overlay.classList.remove('show'); yes.onclick = null; no.onclick = null; resolve(val); }
    yes.onclick = () => { const inp = document.getElementById('promptInput'); cleanup(inp ? inp.value : null); };
    no.onclick = () => cleanup(null);
  });
}

async function clearHistDate(date) {
  if (!await customConfirm(t('confirm_clear_date').replace('{date}', date))) return;
  await api('/api/clear_history', 'POST', { mode:'date', date });
  showHistory();
}
async function clearHistAll() {
  if (!await customConfirm(t('confirm_clear_all'))) return;
  await api('/api/clear_history', 'POST', { mode:'all' });
  showHistory();
}
async function clearHistKeep(days) {
  if (!await customConfirm(t('confirm_clear_keep').replace('{n}', days))) return;
  await api('/api/clear_history', 'POST', { mode:'days', days });
  showHistory();
}

async function showRoomHist(key) {
  document.getElementById('roomHistKey').textContent = key;
  document.getElementById('roomHistModal').classList.add('show');
  try {
    const data = await api('/api/room_history?key=' + encodeURIComponent(key));
    if (!data.ok || !data.history) return;
    const tbody = document.getElementById('roomHistBody');
    if (!data.history.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty">${t('empty_history')}</td></tr>`; return; }
    tbody.innerHTML = data.history.map((d,i) => {
      const isToday = i === 0;
      const rs = isToday ? ' style="background:rgba(88,166,255,0.06)"' : '';
      return `<tr${rs}>
        <td style="color:var(--accent);font-weight:600">${esc(d.date)}${isToday ? ' ' + t('today_brackets') : ''}</td>
        <td style="color:var(--yellow)">${d.peakSubs}</td>
        <td>${d.peakMsgSec}</td>
        <td style="color:var(--green)">${esc(d.peakBwSecStr)}</td>
        <td style="color:var(--dim)">${esc(d.totalBytesStr)}</td>
        <td>${esc(d.activeStr)}</td>
      </tr>`;
    }).join('');
  } catch(e) { console.error(e); }
}
function closeRoomHist() { document.getElementById('roomHistModal').classList.remove('show'); }
function onBanFilter() { banPage = 0; applyBanFilters(); }

// ── Room Events (房间记录) ──
let _roomEvtPage = 0;
function _roomEvtPerPage() { return parseInt(document.getElementById('roomEvtPerPage')?.value) || 50; }

async function loadRoomEvents() {
  const ps = _roomEvtPerPage();
  const search = (document.getElementById('roomEvtSearch')?.value || '').trim();
  const qs = `limit=${ps}&offset=${_roomEvtPage * ps}${search ? '&search=' + encodeURIComponent(search) : ''}`;
  try {
    const d = await api(`/api/room_events?${qs}`);
    const body = document.getElementById('roomEvtBody');
    const L = I18N[_curLang] || I18N.zh;
    if (!d.events || d.events.length === 0) {
      body.innerHTML = `<tr><td colspan="5" class="empty">${L.empty_history || '暂无记录'}</td></tr>`;
    } else {
      body.innerHTML = d.events.map(e => {
        const evtLabel = e.event === 'connect' ? (L.evt_connect||'连接') : (L.evt_disconnect||'断开');
        const roleLabel = e.role === 'pub' ? (L.role_pub||'DLL') : (L.role_sub||'观看者');
        const evtClass = e.event === 'connect' ? 'color:#22c55e' : 'color:#ef4444';
        const tsNum = Number(e.ts) || Date.parse(e.ts) || 0;
        const timeStr = tsNum > 0 ? new Date(tsNum).toLocaleString() : '-';
        return `<tr><td>${esc(e.room_key)}</td><td>${roleLabel}</td><td style="${evtClass};font-weight:600">${evtLabel}</td><td>${maskIP(e.ip)}</td><td>${timeStr}</td></tr>`;
      }).join('');
    }
    const total = d.total || 0;
    const pages = Math.max(1, Math.ceil(total / ps));
    renderPager('roomEvtPager', total, pages, _roomEvtPage, p => { _roomEvtPage = p; loadRoomEvents(); });
  } catch (e) { console.error('[RoomEvents]', e); }
}

// ── Ban Events (封禁记录) ──
let _banEvtPage = 0;
function _banEvtPerPage() { return parseInt(document.getElementById('banEvtPerPage')?.value) || 50; }

async function loadBanEvents() {
  const ps = _banEvtPerPage();
  const search = (document.getElementById('banEvtSearch')?.value || '').trim();
  const qs = `limit=${ps}&offset=${_banEvtPage * ps}${search ? '&search=' + encodeURIComponent(search) : ''}`;
  try {
    const d = await api(`/api/ban_events?${qs}`);
    const body = document.getElementById('banEvtBody');
    const L = I18N[_curLang] || I18N.zh;
    if (!d.events || d.events.length === 0) {
      body.innerHTML = `<tr><td colspan="6" class="empty">${L.empty_history || '暂无记录'}</td></tr>`;
    } else {
      const reasonMap = {'auth_flood':t('ban_reason_auth_flood'),'pub_flood':t('ban_reason_pub_flood'),'msg_too_large':t('ban_reason_msg_too_large'),'admin_manual':t('ban_reason_admin_manual'),'admin_rate_burst':t('ban_reason_admin_rate_burst'),'admin_rate_flood_1h':t('ban_reason_admin_flood_1h'),'admin_login_fail_5x':t('ban_reason_login_fail_5x')};
      const srcMap = {'relay': 'WS Relay', 'admin': t('nav_security') || '管理后台'};
      body.innerHTML = d.events.map(e => {
        const evtLabel = e.event === 'ban' ? (L.evt_ban||'封禁') : (L.evt_unban||'解封');
        const evtClass = e.event === 'ban' ? 'color:#ef4444' : 'color:#22c55e';
        const dur = e.duration_ms > 0 ? fmtDuration(e.duration_ms) : '-';
        const reason = reasonMap[e.reason] || e.reason || '-';
        const source = srcMap[e.source] || e.source || '-';
        const tsNum = Number(e.ts) || Date.parse(e.ts) || 0;
        const timeStr = tsNum > 0 ? new Date(tsNum).toLocaleString() : '-';
        return `<tr><td>${maskIP(e.ip)}</td><td style="${evtClass};font-weight:600">${evtLabel}</td><td>${esc(source)}</td><td>${esc(reason)}</td><td>${dur}</td><td>${timeStr}</td></tr>`;
      }).join('');
    }
    const total = d.total || 0;
    const pages = Math.max(1, Math.ceil(total / ps));
    renderPager('banEvtPager', total, pages, _banEvtPage, p => { _banEvtPage = p; loadBanEvents(); });
  } catch (e) { console.error('[BanEvents]', e); }
}

function fmtDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

async function clearEvents(target) {
  const modeEl = target === 'room' ? document.getElementById('clearRoomEvtMode') : document.getElementById('clearBanEvtMode');
  const mode = modeEl ? modeEl.value : 'all';
  const labels = { all: '全部记录', '7d': '7天前的记录', '30d': '30天前的记录' };
  if (!await customConfirm(`确定清理${target === 'room' ? '房间' : '封禁'}的${labels[mode] || '全部记录'}？`)) return;
  try {
    const d = await api('/api/clear_events', 'POST', { target, mode });
    if (d.ok) {
      showAlert(`已清理: 房间${d.deleted.room || 0}条, 封禁${d.deleted.ban || 0}条`, 'success');
      if (target === 'room') loadRoomEvents();
      else loadBanEvents();
    }
  } catch (e) { showAlert('清理失败: ' + e.message); }
}

function shortMap(m) { if (!m||m==='-') return '-'; const p = m.indexOf('_'); return p > 0 ? m.substring(0, p) : m; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return esc(s).replace(/'/g,"\\'"); }
function maskIP(ip) {
  if (!ip || ip === '-') return '-';
  const full = esc(ip);
  const parts = ip.split('.');
  const masked = parts.length === 4 ? parts[0] + '.*.*.' + parts[3] : '***';
  return `<span class="ip-mask" title="点击查看" data-ip="${full}">${esc(masked)}</span>`;
}
document.addEventListener('click', function(e) {
  if (e.target.classList.contains('ip-mask')) {
    e.target.textContent = e.target.dataset.ip;
    e.target.className = 'ip-shown';
  }
});

// ══════════════════════════════════════════════════════════
// 录制回放 (Recordings)
// ══════════════════════════════════════════════════════════
let _activeRecKeys = new Set();

function _fmtDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
}
function _fmtSize(b) {
  if (!b) return '0 B';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}
function _fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function refreshActiveRecordings() {
  try {
    const data = await api('/api/recording/active');
    if (!data.ok) return;
    _activeRecKeys = new Set(data.active.map(a => a.roomKey));
  } catch (e) {}
}

async function toggleRecording(key) {
  if (_activeRecKeys.has(key)) {
    const data = await api('/api/recording/pause', 'POST', { key });
    if (data.ok) {
      _activeRecKeys.delete(key);
      refreshData();
    }
  } else {
    const data = await api('/api/recording/start', 'POST', { key });
    if (data.ok) {
      _activeRecKeys.add(key);
      refreshData();
    }
  }
}

let _recAllData = [];
let _recPage = 0;

const _svgPlay = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const _svgShare = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
const _svgShared = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const _svgUnshare = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const _svgLock = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const _svgUnlock = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
const _svgTrash = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const _svgDownload = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const _svgImport = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const _svgCheck = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const CLEANUP_DAYS = 7;

function _getRecFiltered() {
  let list = _recAllData;
  const q = (document.getElementById('recSearchInput')?.value || '').trim().toLowerCase();
  if (q) list = list.filter(r => (r.roomKey || '').toLowerCase().includes(q) || (r.mapName || '').toLowerCase().includes(q));
  const dur = document.getElementById('recDurationFilter')?.value || '';
  if (dur === '1800+') list = list.filter(r => (r.duration || 0) >= 1800000);
  else if (dur) { const ms = parseInt(dur) * 1000; list = list.filter(r => (r.duration || 0) < ms); }
  return list;
}

function _renderRecPage() {
  if (typeof _closeRecMenus === 'function') _closeRecMenus();
  const tbody = document.getElementById('recordingsBody');
  const pager = document.getElementById('recPager');
  const totalEl = document.getElementById('recTotal');
  const filtered = _getRecFiltered();
  const perPage = parseInt(document.getElementById('recPerPage')?.value) || 20;
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  if (_recPage >= totalPages) _recPage = totalPages - 1;
  if (_recPage < 0) _recPage = 0;
  const start = _recPage * perPage;
  const page = filtered.slice(start, start + perPage);

  if (totalEl) totalEl.textContent = `${t('rec_total')} ${filtered.length}`;

  if (!page.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty">${t('rec_empty')}</td></tr>`;
    if (pager) pager.innerHTML = '';
    return;
  }

  tbody.innerHTML = page.map(r => {
    const expiresAt = r.permanent ? null : (r.createdAt + CLEANUP_DAYS * 86400000);
    const expiresStr = r.permanent ? t('rec_permanent') : _fmtTime(expiresAt);
    const expiresStyle = r.permanent ? 'color:var(--accent,#4a9eff)' : (expiresAt < Date.now() + 86400000 ? 'color:var(--red)' : '');
    return `<tr>
    <td class="mono">${esc(r.roomKey)}</td>
    <td>${esc(r.mapName || '-')}</td>
    <td>${r.messageCount}</td>
    <td>${_fmtDuration(r.duration)}</td>
    <td>${_fmtSize(r.fileSize)}</td>
    <td>${_fmtTime(r.createdAt)}</td>
    <td>${r.externalUrl ? `<span class="badge-green" style="font-size:11px;padding:2px 8px;border-radius:999px">${t('rec_type_external')}</span>` : `<span class="badge-dim" style="font-size:11px;padding:2px 8px;border-radius:999px">${t('rec_type_local')}</span>`}</td>
    <td style="${expiresStyle}">${expiresStr}</td>
    <td>
      <button class="action-btn enter" data-admin-action="openReplay" data-admin-arg="${esc(r.id)}">${_svgPlay} ${t('rec_replay')}</button>
      <button class="action-btn" data-admin-action="downloadRecording" data-admin-arg="${esc(r.id)}">${_svgDownload} ${t('rec_download')}</button>
      <span class="rec-more-wrap">
        <button class="action-btn" data-admin-action="toggleRecMore" data-admin-arg="${esc(r.id)}">⋯</button>
        <div class="rec-more-menu" id="recMore_${esc(r.id)}" style="display:none">
        ${r.shared
          ? `<div class="rec-more-item" style="color:var(--green,#30a14e)" data-admin-action="shareRecording" data-admin-arg="${esc(r.id)}">${_svgShared} ${t('rec_shared')}${r.shareSlug ? ' <span style="opacity:.7;font-size:11px">(' + esc(r.shareSlug) + ')</span>' : ''}</div>
             <div class="rec-more-item" style="color:var(--orange,#d29922)" data-admin-action="unshareRecording" data-admin-arg="${esc(r.id)}">${_svgUnshare} ${t('rec_unshare')}</div>`
          : `<div class="rec-more-item" data-admin-action="shareRecording" data-admin-arg="${esc(r.id)}">${_svgShare} ${t('rec_share')}</div>`}
        ${r.permanent
          ? ''
          : `<div class="rec-more-item" data-admin-action="togglePermanent" data-admin-arg="${esc(r.id)}" data-admin-arg2="1">${_svgUnlock} ${t('rec_set_permanent')}</div>`}
        <div class="rec-more-item" style="color:var(--red)" data-admin-action="deleteRecording" data-admin-arg="${esc(r.id)}">${_svgTrash} ${t('delete')}</div>
        </div>
      </span>
    </td>
  </tr>`;}).join('');

  if (pager && totalPages > 1) {
    let html = `<button ${_recPage === 0 ? 'disabled' : ''} data-admin-action="recPageNav" data-admin-arg="prev">‹ ${t('page_prev')}</button>`;
    const maxBtns = 7;
    let s = Math.max(0, _recPage - Math.floor(maxBtns / 2));
    let e = Math.min(totalPages, s + maxBtns);
    if (e - s < maxBtns) s = Math.max(0, e - maxBtns);
    if (s > 0) html += `<button data-admin-action="recPageNav" data-admin-arg="0">1</button><span>…</span>`;
    for (let i = s; i < e; i++) html += `<button class="${i === _recPage ? 'active' : ''}" data-admin-action="recPageNav" data-admin-arg="${i}">${i + 1}</button>`;
    if (e < totalPages) html += `<span>…</span><button data-admin-action="recPageNav" data-admin-arg="${totalPages - 1}">${totalPages}</button>`;
    html += `<button ${_recPage >= totalPages - 1 ? 'disabled' : ''} data-admin-action="recPageNav" data-admin-arg="next">${t('page_next')} ›</button>`;
    pager.innerHTML = html;
  } else if (pager) {
    pager.innerHTML = '';
  }
}

function recPageNav(arg) {
  if (arg === 'prev') _recPage = Math.max(0, _recPage - 1);
  else if (arg === 'next') _recPage++;
  else _recPage = parseInt(arg) || 0;
  _renderRecPage();
}

async function loadRecordingsView() {
  await refreshActiveRecordings();
  const activeCard = document.getElementById('activeRecordingsCard');
  const activeList = document.getElementById('activeRecordingsList');
  if (_activeRecKeys.size > 0) {
    activeCard.style.display = '';
    activeList.innerHTML = [..._activeRecKeys].map(k =>
      `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
        <span class="rec-pulse"></span>
        <span class="mono" style="flex:1">${esc(k)}</span>
        <button class="action-btn" style="color:var(--red)" data-admin-action="toggleRecording" data-admin-arg="${escAttr(k)}">■ ${t('rec_stop')}</button>
      </div>`
    ).join('');
  } else {
    activeCard.style.display = 'none';
  }

  try {
    const data = await api('/api/recordings?limit=50000');
    if (!data.ok || !data.recordings) { _recAllData = []; }
    else { _recAllData = data.recordings; }
    _renderRecPage();
  } catch (e) { _recAllData = []; _renderRecPage(); }
}

async function openReplay(id) {
  try {
    const data = await api('/api/recording/share', 'POST', { id });
    if (!data.ok) return;
    const base = getFrontendBase();
    window.open(base + '/?share=' + encodeURIComponent(data.token), '_blank');
  } catch (e) { console.error('openReplay:', e); }
}

let _shareCurrentId = '';
let _shareCurrentToken = '';

async function shareRecording(id) {
  try {
    const data = await api('/api/recording/share', 'POST', { id });
    if (!data.ok) return;
    _shareCurrentId = id;
    _shareCurrentToken = data.token;
    const base = getFrontendBase();
    const shareUrl = base + '/?share=' + data.token;
    document.getElementById('shareUrlInput').value = shareUrl;
    document.getElementById('shareMsg').textContent = '';
    document.getElementById('shareRevokeBtn').style.display = '';
    const slug = data.slug || '';
    document.getElementById('shareSlugInput').value = slug;
    const slugUrlRow = document.getElementById('shareSlugUrlRow');
    if (slug) {
      slugUrlRow.style.display = '';
      document.getElementById('shareSlugUrlInput').value = base + '/?share=' + slug;
    } else {
      slugUrlRow.style.display = 'none';
    }
    document.getElementById('shareModal').classList.add('show');
    loadRecordingsView();
  } catch (e) {}
}

async function revokeShare() {
  if (!_shareCurrentId) return;
  try {
    await api('/api/recording/share/revoke', 'POST', { id: _shareCurrentId });
    closeShareModal();
    loadRecordingsView();
  } catch (e) {}
}

async function unshareRecording(id) {
  try {
    await api('/api/recording/share/revoke', 'POST', { id });
    loadRecordingsView();
  } catch (e) {}
}

async function editShareSlug(token, recId) {
  if (!token) {
    const st = await api('/api/recording/share/status?id=' + encodeURIComponent(recId));
    if (st.ok && st.token) token = st.token;
    else { showAlert('分享信息获取失败'); return; }
  }
  const currentSlug = await (async () => {
    try { const s = await api('/api/recording/share/status?id=' + encodeURIComponent(recId)); return s.slug || ''; } catch(e) { return ''; }
  })();
  const slug = await customPrompt('设置自定义分享 ID（仅字母数字下划线，留空清除）\n当前: ' + (currentSlug || '(无)'), currentSlug);
  if (slug === null) return;
  const clean = slug.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  try {
    const d = await api('/api/recording/share/slug', 'POST', { token, slug: clean });
    if (d.ok) {
      showAlert(clean ? '分享 ID 已设置为: ' + clean : '分享 ID 已清除', 'success');
      loadRecordingsView();
    } else {
      showAlert('设置失败: ' + (d.error || ''), 'warn');
    }
  } catch (e) {
    showAlert('设置失败: ' + e.message);
  }
}

function copyShareUrl() {
  const input = document.getElementById('shareUrlInput');
  input.select();
  try {
    navigator.clipboard.writeText(input.value);
    const msg = document.getElementById('shareMsg');
    msg.className = 'form-msg ok';
    msg.textContent = t('rec_copied');
    setTimeout(() => { msg.textContent = ''; msg.className = 'form-msg'; }, 2000);
  } catch (e) {}
}

async function saveShareSlug() {
  if (!_shareCurrentToken) return;
  const raw = document.getElementById('shareSlugInput').value || '';
  const slug = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  document.getElementById('shareSlugInput').value = slug;
  try {
    const d = await api('/api/recording/share/slug', 'POST', { token: _shareCurrentToken, slug });
    const msg = document.getElementById('shareMsg');
    if (d.ok) {
      msg.className = 'form-msg ok';
      msg.textContent = slug ? '分享 ID 已设置为: ' + slug : '分享 ID 已清除';
      const slugUrlRow = document.getElementById('shareSlugUrlRow');
      if (slug) {
        slugUrlRow.style.display = '';
        document.getElementById('shareSlugUrlInput').value = getFrontendBase() + '/?share=' + slug;
      } else {
        slugUrlRow.style.display = 'none';
      }
      setTimeout(() => { msg.textContent = ''; msg.className = 'form-msg'; }, 3000);
      loadRecordingsView();
    } else {
      msg.className = 'form-msg warn';
      msg.textContent = d.error || '设置失败';
      setTimeout(() => { msg.textContent = ''; msg.className = 'form-msg'; }, 3000);
    }
  } catch (e) {
    const msg = document.getElementById('shareMsg');
    msg.className = 'form-msg warn';
    msg.textContent = e.message || '设置失败';
    setTimeout(() => { msg.textContent = ''; msg.className = 'form-msg'; }, 3000);
  }
}

function copyShareSlugUrl() {
  const input = document.getElementById('shareSlugUrlInput');
  input.select();
  try {
    navigator.clipboard.writeText(input.value);
    const msg = document.getElementById('shareMsg');
    msg.className = 'form-msg ok';
    msg.textContent = t('rec_copied');
    setTimeout(() => { msg.textContent = ''; msg.className = 'form-msg'; }, 2000);
  } catch (e) {}
}

function closeShareModal() { document.getElementById('shareModal').classList.remove('show'); _shareCurrentId = ''; _shareCurrentToken = ''; }

async function togglePermanent(id, val) {
  try {
    await api('/api/recording/permanent', 'POST', { id, permanent: val === '1' || val === 1 });
    loadRecordingsView();
  } catch (e) { showAlert(t('save_failed') + ': ' + e.message); }
}

async function downloadRecording(id) {
  const overlay = document.getElementById('dlProgressOverlay');
  const bar = document.getElementById('dlProgressBar');
  const text = document.getElementById('dlProgressText');
  const pct = document.getElementById('dlProgressPct');
  overlay.style.display = 'flex';
  bar.style.width = '0%';
  text.textContent = t('rec_downloading');
  pct.textContent = '0%';

  try {
    const resp = await fetch(API + '/api/recording/download/' + encodeURIComponent(id), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const total = parseInt(resp.headers.get('Content-Length')) || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total > 0) {
        const p = Math.min(100, Math.round(loaded / total * 100));
        bar.style.width = p + '%';
        pct.textContent = p + '%';
      }
      text.textContent = `${_fmtSize(loaded)}` + (total > 0 ? ` / ${_fmtSize(total)}` : '');
    }

    bar.style.width = '100%';
    pct.textContent = '100%';
    text.textContent = t('rec_download_done') + ` (${_fmtSize(loaded)})`;

    const blob = new Blob(chunks);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = id + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    setTimeout(() => { overlay.style.display = 'none'; }, 1200);
  } catch (e) {
    text.textContent = '❌ ' + e.message;
    bar.style.width = '100%';
    bar.style.background = 'var(--red)';
    pct.textContent = '';
    setTimeout(() => { overlay.style.display = 'none'; bar.style.background = ''; }, 3000);
  }
}

function importRecording() {
  document.getElementById('importUrlInput').value = '';
  document.getElementById('importPreview').style.display = 'none';
  document.getElementById('importMsg').textContent = '';
  document.getElementById('importModal').classList.add('show');
}
function closeImportModal() { document.getElementById('importModal').classList.remove('show'); }

async function testImportUrl() {
  const url = (document.getElementById('importUrlInput').value || '').trim();
  const msg = document.getElementById('importMsg');
  const preview = document.getElementById('importPreview');
  const body = document.getElementById('importPreviewBody');
  if (!url) { msg.textContent = t('rec_import_url_ph'); msg.style.color = 'var(--red)'; return; }
  msg.textContent = t('rec_importing'); msg.style.color = 'var(--dim)';
  preview.style.display = 'none';
  try {
    const data = await api('/api/recording/import', 'POST', { url, dryRun: true });
    if (data.ok) {
      body.innerHTML = `<tr>
        <td class="mono">${esc(data.roomKey || '-')}</td>
        <td>${esc(data.mapName || '-')}</td>
        <td>${data.messages || 0}</td>
        <td>${_fmtDuration(data.duration || 0)}</td>
        <td>${_fmtSize(data.fileSize || 0)}</td>
      </tr>`;
      preview.style.display = '';
      msg.innerHTML = _svgCheck + ' ' + t('rec_import_test_ok'); msg.style.color = 'var(--green,#30a14e)';
    } else {
      throw new Error(data.error || 'failed');
    }
  } catch (e) { msg.textContent = '❌ ' + e.message; msg.style.color = 'var(--red)'; preview.style.display = 'none'; }
}

async function doImportRecording() {
  const url = (document.getElementById('importUrlInput').value || '').trim();
  const msg = document.getElementById('importMsg');
  if (!url) { msg.textContent = t('rec_import_url_ph'); msg.style.color = 'var(--red)'; return; }
  msg.textContent = t('rec_importing'); msg.style.color = 'var(--dim)';
  try {
    const useExternal = document.getElementById('importUseExternal')?.checked || false;
    const data = await api('/api/recording/import', 'POST', { url, useExternal });
    if (data.ok) {
      msg.innerHTML = _svgCheck + ' ' + t('rec_import_ok') + ` (${data.messages} msgs, ${_fmtSize(data.fileSize)})`;
      msg.style.color = 'var(--green,#30a14e)';
      loadRecordingsView();
      setTimeout(closeImportModal, 1500);
    } else {
      msg.textContent = '❌ ' + (data.error || 'failed'); msg.style.color = 'var(--red)';
    }
  } catch (e) { msg.textContent = '❌ ' + e.message; msg.style.color = 'var(--red)'; }
}

function _restoreRecMenu(menu) {
  menu.style.display = 'none';
  menu.classList.remove('is-open');
  if (menu._home && menu.parentNode !== menu._home) menu._home.appendChild(menu);
}
function _closeRecMenus() {
  document.querySelectorAll('.rec-more-menu').forEach(_restoreRecMenu);
}
function _placeRecMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  menu.style.display = 'block';
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = r.right - mw;
  if (left < margin) left = margin;
  if (left + mw > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - mw);
  let top = r.bottom + gap;
  if (top + mh > window.innerHeight - margin && r.top - gap - mh >= margin) top = r.top - gap - mh;
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}
function toggleRecMore(id) {
  const menu = document.getElementById('recMore_' + id);
  const opening = !!(menu && menu.style.display === 'none');
  _closeRecMenus();
  if (!opening || !menu) return;
  const btn = menu.parentElement && menu.parentElement.querySelector('[data-admin-action="toggleRecMore"]');
  if (!btn) return;
  menu._home = menu.parentElement;
  document.body.appendChild(menu);
  menu.classList.add('is-open');
  _placeRecMenu(menu, btn);
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.rec-more-menu') && !e.target.closest('[data-admin-action="toggleRecMore"]')) {
    _closeRecMenus();
  }
});
document.addEventListener('scroll', () => _closeRecMenus(), true);
window.addEventListener('resize', () => _closeRecMenus());

async function deleteRecording(id) {
  if (!await customConfirm(t('rec_confirm_delete'))) return;
  await api('/api/recording/' + encodeURIComponent(id), 'DELETE');
  loadRecordingsView();
}

// ── Init ──
(async () => {
  if (token) { try { const r = await api('/api/stats'); if (r.ok) { showDashboard(); return; } } catch {} }
  document.getElementById('loginView').style.display = 'flex';
})();
document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key==='Enter') doLogin(); });
document.getElementById('loginUser').addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('loginPass').focus(); });