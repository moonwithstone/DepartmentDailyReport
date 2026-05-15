/**
 * 腾讯云函数 SCF - 日报同步
 * 每天北京时间 8:15 由定时触发器触发
 * 流程：登录云之家 → 拉取昨日日报 → 过滤转换 → 写入 Supabase → 飞书通知
 */

'use strict';

// ========== 配置（在云函数环境变量中设置） ==========
const YZJ_ACCOUNT = process.env.YZJ_ACCOUNT;
const YZJ_PASSWORD = process.env.YZJ_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK;

const DEPT_NAME = '产业数智中心';

// ========== 工具函数 ==========
function getYesterdayRange() {
    const now = new Date();
    // 北京时间 = UTC+8
    const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const yesterday = new Date(bjNow);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);

    // 昨天 00:00:00 北京时间对应的 UTC 时间戳
    const start = yesterday.getTime() - 8 * 60 * 60 * 1000;
    const end = start + 24 * 60 * 60 * 1000 - 1000;

    const y = yesterday.getUTCFullYear();
    const m = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
    const d = String(yesterday.getUTCDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    return { start, end, dateStr };
}

// ========== 第一步：登录云之家 ==========
async function loginYunzhijia() {
    console.log('正在登录云之家...');
    const res = await fetch('https://www.yunzhijia.com/space/c/rest/user/v2/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Origin': 'https://www.yunzhijia.com',
            'Referer': 'https://www.yunzhijia.com/',
            'x-requested-with': 'XMLHttpRequest'
        },
        body: `email=${encodeURIComponent(YZJ_ACCOUNT)}&password=${encodeURIComponent(YZJ_PASSWORD)}&remember=false&forceToNetwork=false`
    });

    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error(`云之家登录返回非JSON: ${text.substring(0, 200)}`);
    }

    if (!data.success) {
        throw new Error(`云之家登录失败: ${data.errormsg || JSON.stringify(data)}`);
    }

    // 从响应头获取 cookie
    const cookies = res.headers.getSetCookie?.() || [];
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    const token = data.data?.token || '';

    console.log('云之家登录成功');
    return { cookieStr, token };
}

// ========== 第二步：拉取日报数据 ==========
async function fetchDailyReports(cookieStr, token) {
    const { start, end, dateStr } = getYesterdayRange();
    console.log(`正在拉取 ${dateStr} 的日报数据...`);

    const url = new URL('https://www.yunzhijia.com/workflow/api/v1/workreport/pro/listnotifyworkreport');
    url.searchParams.set('openId', '');
    url.searchParams.set('eid', '');
    url.searchParams.set('dateFilter', '1');
    url.searchParams.set('startTime', start.toString());
    url.searchParams.set('endTime', end.toString());
    url.searchParams.set('lastId', '');
    url.searchParams.set('count', '50');

    const headers = {
        'Cookie': cookieStr,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': 'https://www.yunzhijia.com/'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url.toString(), { method: 'GET', headers });
    const text = await res.text();
    let result;
    try {
        result = JSON.parse(text);
    } catch (e) {
        throw new Error(`拉取日报返回非JSON: ${text.substring(0, 200)}`);
    }

    if (!result.success && !result.data) {
        throw new Error(`拉取日报失败: ${JSON.stringify(result)}`);
    }

    const reports = result.data || [];
    console.log(`获取到 ${reports.length} 条原始日报`);
    return { reports, dateStr };
}

// ========== 第三步：过滤与转换 ==========
function transformReports(reports) {
    console.log('正在过滤转换数据...');
    const members = [];

    for (const item of reports) {
        const name = item.creator?.name || '';
        const dept = item.creator?.department || '';
        const submitTime = item.createTime ? new Date(item.createTime).toISOString() : null;

        // 过滤规则1：运营部只保留史振坤
        if (dept.includes('运营') && name !== '史振坤') {
            continue;
        }

        // 获取今日工作内容
        const todayWork = item.widgetValue?._S_INT_DAILY_TODAY?.value || '';
        if (!todayWork.trim()) continue;

        // 按换行拆分任务
        const lines = todayWork.split('\n').filter(line => line.trim());

        const tasks = [];
        for (const line of lines) {
            const content = line.trim();
            if (!content) continue;

            // 过滤规则2：王翠洁只保留包含"项目"的行
            if (name === '王翠洁' && !content.includes('项目')) {
                continue;
            }
            // 过滤规则3：王越排除包含"学习"的行
            if (name === '王越' && content.includes('学习')) {
                continue;
            }

            tasks.push({ content, status: 'done' });
        }

        if (tasks.length === 0) continue;

        members.push({ name, role: dept, submitTime, tasks });
    }

    console.log(`过滤后保留 ${members.length} 人数据`);
    return members;
}

// ========== 第四步：写入 Supabase ==========
async function writeToSupabase(members, dateStr) {
    console.log(`正在写入 Supabase (${dateStr})...`);

    const noData = members.length === 0;
    const body = {
        report_date: dateStr,
        dept_name: DEPT_NAME,
        no_data: noData,
        message: noData ? '当天没有符合条件的日报记录' : null,
        members: noData ? [] : members,
        summary: [],
        updated_at: new Date().toISOString()
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/daily_reports?on_conflict=report_date`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`写入 Supabase 失败 ${res.status}: ${errText}`);
    }

    console.log('写入 Supabase 成功');
    return { noData, memberCount: members.length };
}

// ========== 第五步：飞书通知 ==========
async function notifyFeishu(success, dateStr, detail) {
    if (!FEISHU_WEBHOOK) {
        console.log('未配置飞书 Webhook，跳过通知');
        return;
    }

    let content;
    if (success) {
        const names = detail.names || [];
        content = `✅ 云之家日报同步成功\n📅 日期：${dateStr}\n👥 写入 ${detail.memberCount} 人数据\n📝 成员：${names.join('、') || '无'}`;
    } else {
        content = `❌ 云之家日报同步失败\n📅 日期：${dateStr}\n⚠️ 错误：${detail.error}`;
    }

    await fetch(FEISHU_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text: content } })
    });

    console.log('飞书通知已发送');
}

// ========== 云函数入口 ==========
exports.main_handler = async (event, context) => {
    const { dateStr } = getYesterdayRange();
    let members = [];

    try {
        const { cookieStr, token } = await loginYunzhijia();
        const { reports } = await fetchDailyReports(cookieStr, token);
        members = transformReports(reports);
        const { memberCount } = await writeToSupabase(members, dateStr);

        await notifyFeishu(true, dateStr, {
            memberCount,
            names: members.map(m => m.name)
        });

        return { code: 0, message: '同步成功', date: dateStr, memberCount };
    } catch (error) {
        console.error('同步失败:', error.message);
        await notifyFeishu(false, dateStr, { error: error.message });
        return { code: 1, message: error.message, date: dateStr };
    }
};
