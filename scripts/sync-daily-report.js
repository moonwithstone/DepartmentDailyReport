/**
 * 日报同步脚本
 * 每天北京时间 8:15 由 GitHub Actions 触发
 * 流程：登录云之家 → 拉取昨日日报 → 过滤转换 → 写入 Supabase → 飞书通知
 */

// ========== 配置（从环境变量读取） ==========
const YZJ_ACCOUNT = process.env.YZJ_ACCOUNT;       // 云之家账号
const YZJ_PASSWORD = process.env.YZJ_PASSWORD;     // 云之家密码（加密后的）
const SUPABASE_URL = process.env.SUPABASE_URL;     // Supabase URL
const SUPABASE_KEY = process.env.SUPABASE_KEY;     // Supabase anon key
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK; // 飞书机器人 Webhook

const DEPT_NAME = '产业数智中心';

// ========== 工具函数 ==========
function getYesterdayRange() {
    // 获取北京时间昨天 00:00:00 ~ 23:59:59 的时间戳（毫秒）
    const now = new Date();
    // 转为北京时间
    const bjNow = new Date(now.getTime() + (8 * 60 * 60 * 1000 - now.getTimezoneOffset() * 60 * 1000));
    const yesterday = new Date(bjNow);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const start = yesterday.getTime() - (8 * 60 * 60 * 1000) + yesterday.getTimezoneOffset() * 60 * 1000;
    const end = start + 24 * 60 * 60 * 1000 - 1000;

    // 返回格式化的日期字符串（YYYY-MM-DD）和时间戳
    const dateStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    return { start, end, dateStr };
}

function formatDate(dateStr) {
    // 用于飞书通知显示
    return dateStr;
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
        throw new Error(`云之家登录失败: ${data.errorMessage || JSON.stringify(data)}`);
    }

    // 从响应头获取 cookie
    const cookies = res.headers.getSetCookie?.() || [];
    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

    // 也可能 token 在响应体里
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
    const result = await res.json();

    if (!result.success && !result.data) {
        throw new Error(`拉取日报失败: ${JSON.stringify(result)}`);
    }

    const reports = result.data || [];
    console.log(`获取到 ${reports.length} 条原始日报`);
    return { reports, dateStr };
}

// ========== 第三步：过滤与转换 ==========
function transformReports(reports, dateStr) {
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

        // 过滤规则2：王翠洁只保留包含"项目"的行
        // 过滤规则3：王越排除包含"学习"的行
        const tasks = [];
        for (const line of lines) {
            const content = line.trim();
            if (!content) continue;

            if (name === '王翠洁' && !content.includes('项目')) {
                continue;
            }
            if (name === '王越' && content.includes('学习')) {
                continue;
            }

            tasks.push({
                content: content,
                status: 'done'
            });
        }

        // 如果过滤后没有任何任务，跳过该人
        if (tasks.length === 0) continue;

        members.push({
            name,
            role: dept,
            submitTime,
            tasks
        });
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

    // 使用 upsert（如果当天已有数据则覆盖）
    const res = await fetch(`${SUPABASE_URL}/rest/v1/daily_reports`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'  // upsert
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
        content = `❌ 云之家日报同步失败\n📅 日期：${dateStr}\n⚠️ 错误：${detail.error}\n🔗 请检查 GitHub Actions 日志`;
    }

    await fetch(FEISHU_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            msg_type: 'text',
            content: { text: content }
        })
    });

    console.log('飞书通知已发送');
}

// ========== 主流程 ==========
async function main() {
    const { dateStr } = getYesterdayRange();
    let members = [];

    try {
        // 1. 登录
        const { cookieStr, token } = await loginYunzhijia();

        // 2. 拉取数据
        const { reports } = await fetchDailyReports(cookieStr, token);

        // 3. 过滤转换
        members = transformReports(reports, dateStr);

        // 4. 写入数据库
        const { memberCount } = await writeToSupabase(members, dateStr);

        // 5. 飞书通知（成功）
        await notifyFeishu(true, dateStr, {
            memberCount,
            names: members.map(m => m.name)
        });

        console.log('=== 同步完成 ===');
    } catch (error) {
        console.error('同步失败:', error.message);

        // 飞书通知（失败）
        await notifyFeishu(false, dateStr, { error: error.message });

        process.exit(1);
    }
}

main();
