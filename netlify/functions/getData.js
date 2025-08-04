const { google } = require('googleapis');

// Main function that Netlify will run
exports.handler = async (event, context) => {
    try {
        // --- SECURE AUTHENTICATION ---
        const user = context.clientContext && context.clientContext.user;
        if (!user) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required.' }) };
        }
        const userEmail = user.email.toLowerCase();

        // --- GOOGLE SHEETS SETUP ---
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'], // Read-only is safer
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

        // --- AUTHORIZATION: CHECK USER ROLE ---
        const agentSheetResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sales_Agents!A:C',
        });
        const allAgentsRaw = (agentSheetResponse.data.values || []).slice(1);
        const currentUserInfo = allAgentsRaw.find(agent => agent[1] && agent[1].toLowerCase() === userEmail);
        
        if (!currentUserInfo) {
            throw new Error("Your email is not authorized to view this dashboard.");
        }

        const userRole = currentUserInfo[2];
        let finalData = {};

        // --- ROUTER: CALL THE CORRECT DATA FUNCTION BASED ON ROLE ---
        if (userRole === "Agent") {
            finalData = await getAgentDashboardData({ sheets, SPREADSHEET_ID, userEmail, currentUserInfo });
        } else if (userRole === "Manager") {
            finalData = await getManagerDashboardData({ sheets, SPREADSHEET_ID, currentUserInfo });
        } else if (userRole === "HR") {
            finalData = await getHRDashboardData({ sheets, SPREADSHEET_ID, currentUserInfo });
        } else {
            throw new Error("Unknown user role.");
        }

        return {
            statusCode: 200,
            body: JSON.stringify(finalData),
        };

    } catch (error) {
        console.error('Error in Netlify function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to retrieve dashboard data.', details: error.message }),
        };
    }
};

// --- HELPER: Safely parse numbers from sheet data ---
const parseNumber = (value) => {
    if (value === null || value === undefined) return 0;
    const cleaned = String(value).replace(/[^0-9.-]/g, '');
    return parseFloat(cleaned) || 0;
};

// --- DATA LOGIC FOR AGENT ---
async function getAgentDashboardData({ sheets, SPREADSHEET_ID, userEmail, currentUserInfo }) {
    const ranges = ['Sales_Log!A2:F', 'Gamification_Tasks!A2:E', 'Agent_Activity_Log!A2:D', 'Sales_Pipeline!A2:F', 'Sales_Agents!A2:F'];
    const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges });
    const [salesLogData=[], tasksData=[], activityLogData=[], pipelineData=[], agentsData=[]] = response.data.valueRanges.map(r => r.values || []);
    
    const allAgents = agentsData.map(row => [row[0], row[1], row[2], row[3], parseNumber(row[4]), parseNumber(row[5])]);
    const salesLog = salesLogData.map(r => [new Date(r[0]), r[1], r[2], r[3], parseNumber(r[4]), parseNumber(r[5])]);
    const pipeline = pipelineData.map(r => [r[0], r[1], r[2], parseNumber(r[3]), r[4], new Date(r[5])]);
    const activityLog = activityLogData.map(r => [new Date(r[0]), r[1], r[2], parseNumber(r[3])]).sort((a,b) => b[0] - a[0]);

    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);
    const mySalesThisMonth = salesLog.filter(sale => sale[1] && sale[1].toLowerCase() === userEmail && sale[0] >= startOfMonth);

    const myRevenue = mySalesThisMonth.reduce((sum, sale) => sum + sale[4], 0);
    const myCommission = mySalesThisMonth.reduce((sum, sale) => sum + (sale[4] * sale[5]), 0);
    const dealsClosed = mySalesThisMonth.length;
    const avgDealSize = dealsClosed > 0 ? myRevenue / dealsClosed : 0;
    const myQuota = parseNumber(currentUserInfo[4]);
    const quotaProgress = myQuota > 0 ? (myRevenue / myQuota) * 100 : 0;

    const leaderboard = allAgents.filter(a => a[2] === 'Agent').map(a => ({ name: a[0], team: a[3], points: a[5] || 0 })).sort((a,b) => b.points - a.points).map((a,i) => ({...a, rank: i+1}));
    const myRankInfo = leaderboard.find(agent => agent.name === currentUserInfo[0]);

    const now = new Date(); const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay())); startOfWeek.setHours(0,0,0,0);
    const userActivitiesThisWeek = activityLog.filter(log => log[1] && log[1].toLowerCase() === userEmail && log[0] >= startOfWeek);
    const tasks = tasksData.filter(task => task[2] === 'Manual').map(task => { const taskId = task[0]; const isCompleted = userActivitiesThisWeek.some(activity => (activity[2] && activity[2].includes(taskId)) || (activity[2] && activity[2].includes(task[1]))); return { id: taskId, description: task[1], points: parseNumber(task[3]), status: isCompleted ? 'Completed' : 'Pending' }; });

    const history = activityLog.filter(log => log[1] && log[1].toLowerCase() === userEmail).map(log => ({ date: log[0].toLocaleDateString(), action: log[2], points: `+${log[3]}` })).slice(0, 20);

    const myPipelineDeals = pipeline.filter(deal => deal[1] && deal[1].toLowerCase() === userEmail);
    const pipelineStages = { 'Prospecting': 0, 'Qualification': 0, 'Demo': 0, 'Negotiation': 0 };
    myPipelineDeals.forEach(deal => { if (pipelineStages.hasOwnProperty(deal[4])) { pipelineStages[deal[4]] += deal[3]; } });
    const revenueByProduct = mySalesThisMonth.reduce((acc, sale) => { const product = sale[3] || 'Unknown'; acc[product] = (acc[product] || 0) + sale[4]; return acc; }, {});
    const chartData = { pipelineFunnel: { labels: Object.keys(pipelineStages), data: Object.values(pipelineStages) }, revenueByProduct: { labels: Object.keys(revenueByProduct), data: Object.values(revenueByProduct) } };
    
    return {
        view: 'Agent',
        header: { name: currentUserInfo[0], points: parseNumber(currentUserInfo[5]), rank: myRankInfo ? myRankInfo.rank : 'N/A', totalAgents: leaderboard.length },
        kpis: { myRevenue: myRevenue.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), myCommission: myCommission.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), avgDealSize: avgDealSize.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), quotaProgress: quotaProgress.toFixed(1) },
        tasks: tasks,
        history: history,
        chartData: chartData,
        leaderboard: leaderboard
    };
}

// --- DATA LOGIC FOR MANAGER ---
async function getManagerDashboardData({ sheets, SPREADSHEET_ID, currentUserInfo }) {
    const ranges = ['Sales_Agents!A2:F', 'Sales_Log!A2:F', 'Sales_Pipeline!A2:F'];
    const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges });
    const [agentsData=[], salesLogData=[], pipelineData=[]] = response.data.valueRanges.map(r => r.values || []);

    const salesLog = salesLogData.map(r => [new Date(r[0]), r[1], r[2], r[3], parseNumber(r[4]), parseNumber(r[5])]);
    const agents = agentsData.map(row => [row[0], row[1], row[2], row[3], parseNumber(row[4]), parseNumber(row[5])]).filter(agent => agent[2] === 'Agent');
    const pipeline = pipelineData.map(r => [r[0], r[1], r[2], parseNumber(r[3]), r[4], new Date(r[5])]);

    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);
    const salesThisMonth = salesLog.filter(sale => sale[0] >= startOfMonth);
    const totalRevenue = salesThisMonth.reduce((sum, sale) => sum + sale[4], 0);
    const dealsClosed = salesThisMonth.length;
    const avgDealSize = dealsClosed > 0 ? totalRevenue / dealsClosed : 0;
    const totalQuota = agents.reduce((sum, agent) => sum + agent[4], 0);
    const quotaAttainment = totalQuota > 0 ? (totalRevenue / totalQuota) * 100 : 0;

    const teamPerformance = agents.map(agent => { const agentSales = salesThisMonth.filter(sale => sale[1].toLowerCase() === agent[1].toLowerCase()); const achieved = agentSales.reduce((sum, sale) => sum + sale[4], 0); return { name: agent[0], team: agent[3], quota: agent[4], achieved, progress: agent[4] > 0 ? (achieved / agent[4]) * 100 : 0 }; }).sort((a,b) => b.achieved - a.achieved);

    const pointsLeaderboard = agents.sort((a, b) => b[5] - a[5]).slice(0, 5).map(agent => ({ name: agent[0], points: agent[5] }));

    const pipelineStages = { 'Prospecting': 0, 'Qualification': 0, 'Demo': 0, 'Negotiation': 0 };
    pipeline.forEach(deal => { if (pipelineStages.hasOwnProperty(deal[4])) { pipelineStages[deal[4]] += deal[3]; } });

    const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const recentSales = salesLog.filter(sale => sale[0] >= sixMonthsAgo);
    const monthlyRevenue = {};
    recentSales.forEach(sale => { const month = sale[0].toLocaleString('default', { month: 'short', year: '2-digit' }); monthlyRevenue[month] = (monthlyRevenue[month] || 0) + sale[4]; });
    const sortedMonths = Object.keys(monthlyRevenue).sort((a,b) => new Date(a) - new Date(b));
    const revenueTrend = { labels: sortedMonths, data: sortedMonths.map(month => monthlyRevenue[month]) };

    return {
        view: 'Manager',
        header: { name: currentUserInfo[0] },
        kpis: { totalRevenue: totalRevenue.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), dealsClosed, avgDealSize: avgDealSize.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), quotaAttainment: quotaAttainment.toFixed(1) + '%' },
        teamPerformance: teamPerformance.map(p => ({...p, quota: p.quota.toLocaleString(), achieved: p.achieved.toLocaleString()})),
        pointsLeaderboard,
        chartData: {
            pipelineFunnel: { labels: Object.keys(pipelineStages), data: Object.values(pipelineStages) },
            revenueTrend
        }
    };
}

// --- DATA LOGIC FOR HR ---
async function getHRDashboardData({ sheets, SPREADSHEET_ID, currentUserInfo }) {
     const ranges = ['Sales_Agents!A2:D'];
    const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges });
    const [agentsData=[]] = response.data.valueRanges.map(r => r.values || []);
    
    return {
        view: 'HR',
        header: { name: currentUserInfo[0] },
        personnel: agentsData.map(p => ({name: p[0], email: p[1], role: p[2], team: p[3]}))
    };
}
