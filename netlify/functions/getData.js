const { google } = require('googleapis');

// Helper function to get the start of the current month
function getStartOfMonth() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
}

// Helper function to safely clean and parse numbers
const parseNumber = (value) => {
    if (value === null || value === undefined) return 0;
    const cleaned = String(value).replace(/[^0-9.-]/g, ''); // Allow negative sign for robustness
    return parseFloat(cleaned) || 0;
};

// Main function that Netlify will run
exports.handler = async (event) => {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
        const userEmail = event.queryStringParameters.user?.toLowerCase();
        if (!userEmail) {
            throw new Error("User email is required.");
        }

        const ranges = [
            'Sales_Agents!A2:F', 'Sales_Log!A2:F', 'Gamification_Tasks!A2:E',
            'Agent_Activity_Log!A2:D', 'Sales_Pipeline!A2:F'
        ];
        const response = await sheets.spreadsheets.values.batchGet({
            spreadsheetId: SPREADSHEET_ID,
            ranges: ranges,
        });

        const [
            agentsData = [], salesLogData = [], tasksData = [],
            activityLogData = [], pipelineData = []
        ] = response.data.valueRanges.map(range => range.values || []);
        
        // --- Process the data with robust parsing ---
        const allAgents = agentsData.map(row => [row[0], row[1], row[2], row[3], parseNumber(row[4]), parseNumber(row[5])]);
        const salesLog = salesLogData.map(r => [new Date(r[0]), r[1], r[2], r[3], parseNumber(r[4]), parseNumber(r[5])]);
        const pipeline = pipelineData.map(r => [r[0], r[1], r[2], parseNumber(r[3]), r[4], new Date(r[5])]);
        const activityLog = activityLogData.map(r => [new Date(r[0]), r[1], r[2], parseNumber(r[3])]).sort((a,b) => b[0] - a[0]);

        const currentUserInfo = allAgents.find(agent => agent[1] && agent[1].toLowerCase() === userEmail);
        if (!currentUserInfo) throw new Error("User not found in agent list.");
        
        const startOfMonth = getStartOfMonth();
        const mySalesThisMonth = salesLog.filter(sale => sale[1] && sale[1].toLowerCase() === userEmail && sale[0] >= startOfMonth);

        const myRevenue = mySalesThisMonth.reduce((sum, sale) => sum + sale[4], 0);
        const myCommission = mySalesThisMonth.reduce((sum, sale) => sum + (sale[4] * sale[5]), 0);
        const dealsClosed = mySalesThisMonth.length;
        const avgDealSize = dealsClosed > 0 ? myRevenue / dealsClosed : 0;
        const myQuota = currentUserInfo[4] || 0;
        const quotaProgress = myQuota > 0 ? (myRevenue / myQuota) * 100 : 0;
        
        const leaderboard = allAgents.filter(a => a[2] === 'Agent').map(a => ({ name: a[0], team: a[3], points: a[5] || 0 })).sort((a,b) => b.points - a.points).map((a,i) => ({...a, rank: i+1}));
        const myRankInfo = leaderboard.find(agent => agent.name === currentUserInfo[0]);

        // --- Robust Task Calculation ---
        const now = new Date();
        const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
        startOfWeek.setHours(0,0,0,0);
        const userActivitiesThisWeek = activityLog.filter(log => log[1] && log[1].toLowerCase() === userEmail && log[0] >= startOfWeek);
        const tasks = tasksData.filter(task => task[2] === 'Manual').map(task => {
            const taskId = task[0];
            // THE FIX IS HERE: We check if activity[2] exists before calling .includes()
            const isCompleted = userActivitiesThisWeek.some(activity => 
                (activity[2] && activity[2].includes(taskId)) || 
                (activity[2] && activity[2].includes(task[1]))
            );
            return { id: taskId, description: task[1], points: parseNumber(task[3]), status: isCompleted ? 'Completed' : 'Pending' };
        });

        const history = activityLog.filter(log => log[1] && log[1].toLowerCase() === userEmail)
                                 .map(log => ({ date: log[0].toLocaleDateString(), action: log[2], points: `+${log[3]}` }))
                                 .slice(0, 20);

        const myPipelineDeals = pipeline.filter(deal => deal[1] && deal[1].toLowerCase() === userEmail);
        const pipelineStages = { 'Prospecting': 0, 'Qualification': 0, 'Demo': 0, 'Negotiation': 0 };
        myPipelineDeals.forEach(deal => { if (pipelineStages.hasOwnProperty(deal[4])) { pipelineStages[deal[4]] += deal[3]; } });
        const revenueByProduct = mySalesThisMonth.reduce((acc, sale) => { const product = sale[3] || 'Unknown'; acc[product] = (acc[product] || 0) + sale[4]; return acc; }, {});
        const chartData = {
            pipelineFunnel: { labels: Object.keys(pipelineStages), data: Object.values(pipelineStages) },
            revenueByProduct: { labels: Object.keys(revenueByProduct), data: Object.values(revenueByProduct) }
        };
        
        const finalData = {
             header: { name: currentUserInfo[0], points: currentUserInfo[5] || 0, rank: myRankInfo ? myRankInfo.rank : 'N/A', totalAgents: leaderboard.length },
             kpis: { myRevenue: myRevenue.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), myCommission: myCommission.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), avgDealSize: avgDealSize.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), quotaProgress: quotaProgress.toFixed(1) },
             tasks: tasks,
             history: history,
             chartData: chartData,
             leaderboard: leaderboard
        };

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
