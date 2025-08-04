const { google } = require('googleapis');

// Helper function to get the start of the current month
function getStartOfMonth() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
}

// Main function that Netlify will run
exports.handler = async (event) => {
    try {
        console.log("--- [DEBUG] Starting Netlify function ---");

        // Authenticate with Google Sheets API
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
        console.log(`--- [DEBUG] User email identified as: ${userEmail}`);

        // --- Fetch all data from sheets in parallel ---
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
        
        console.log(`--- [DEBUG] Fetched ${salesLogData.length} rows from Sales_Log.`);
        // Log the first raw row from the sales log to see the date format
        if (salesLogData.length > 0) {
            console.log(`--- [DEBUG] First raw sales log row: ${JSON.stringify(salesLogData[0])}`);
        }

        // --- Process the data ---
        const salesLog = salesLogData.map(r => [new Date(r[0]), r[1], r[2], r[3], Number(r[4] || 0), Number(r[5] || 0)]);
        
        // Log the first PARSED date to see if it's valid
        if (salesLog.length > 0) {
            console.log(`--- [DEBUG] First PARSED sales log date object: ${salesLog[0][0]}`);
        }

        const startOfMonth = getStartOfMonth();
        console.log(`--- [DEBUG] Calculated startOfMonth as: ${startOfMonth}`);

        const mySalesThisMonth = salesLog.filter(sale => {
            const isCorrectUser = sale[1] && sale[1].toLowerCase() === userEmail;
            const isAfterStartOfMonth = sale[0] >= startOfMonth;
            return isCorrectUser && isAfterStartOfMonth;
        });

        console.log(`--- [DEBUG] Found ${mySalesThisMonth.length} sales for this user this month.`);

        if (mySalesThisMonth.length === 0) {
             console.log("--- [DEBUG] WARNING: No sales found for the current month. This will likely cause NaN results.");
        }
        
        const myRevenue = mySalesThisMonth.reduce((sum, sale) => sum + sale[4], 0);
        const dealsClosed = mySalesThisMonth.length;
        // Add a check to prevent division by zero, which causes NaN
        const avgDealSize = dealsClosed > 0 ? myRevenue / dealsClosed : 0;
        
        console.log(`--- [DEBUG] Calculated myRevenue: ${myRevenue}, dealsClosed: ${dealsClosed}, avgDealSize: ${avgDealSize}`);

        // (The rest of the function remains the same)
        const allAgents = agentsData.map(row => [row[0], row[1], row[2], row[3], Number(row[4] || 0), Number(row[5] || 0)]);
        const currentUserInfo = allAgents.find(agent => agent[1] && agent[1].toLowerCase() === userEmail);
        if (!currentUserInfo) throw new Error("User not found in agent list.");
        const myCommission = mySalesThisMonth.reduce((sum, sale) => sum + (sale[4] * sale[5]), 0);
        const myQuota = currentUserInfo[4] || 0;
        const quotaProgress = myQuota > 0 ? (myRevenue / myQuota) * 100 : 0;
        const leaderboard = allAgents.filter(a => a[2] === 'Agent').map(a => ({ name: a[0], team: a[3], points: a[5] || 0 })).sort((a,b) => b.points - a.points).map((a,i) => ({...a, rank: i+1}));
        const myRankInfo = leaderboard.find(agent => agent.name === currentUserInfo[0]);
        const activityLog = activityLogData.map(r => [new Date(r[0]), r[1], r[2], Number(r[3] || 0)]).sort((a,b) => b[0] - a[0]);
        const now = new Date();
        const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
        startOfWeek.setHours(0,0,0,0);
        const userActivitiesThisWeek = activityLog.filter(log => log[1] && log[1].toLowerCase() === userEmail && log[0] >= startOfWeek);
        const tasks = tasksData.filter(task => task[2] === 'Manual').map(task => { const taskId = task[0]; const isCompleted = userActivitiesThisWeek.some(activity => activity[2].includes(taskId) || activity[2].includes(task[1])); return { id: taskId, description: task[1], points: Number(task[3]), status: isCompleted ? 'Completed' : 'Pending' }; });
        const history = activityLog.filter(log => log[1] && log[1].toLowerCase() === userEmail).map(log => ({ date: log[0].toLocaleDateString(), action: log[2], points: `+${log[3]}` })).slice(0, 20);
        const pipeline = pipelineData.map(r => [r[0], r[1], r[2], Number(r[3] || 0), r[4], new Date(r[5])]);
        const myPipelineDeals = pipeline.filter(deal => deal[1] && deal[1].toLowerCase() === userEmail);
        const pipelineStages = { 'Prospecting': 0, 'Qualification': 0, 'Demo': 0, 'Negotiation': 0 };
        myPipelineDeals.forEach(deal => { if (pipelineStages.hasOwnProperty(deal[4])) { pipelineStages[deal[4]] += deal[3]; } });
        const revenueByProduct = mySalesThisMonth.reduce((acc, sale) => { const product = sale[3] || 'Unknown'; acc[product] = (acc[product] || 0) + sale[4]; return acc; }, {});
        const chartData = { pipelineFunnel: { labels: Object.keys(pipelineStages), data: Object.values(pipelineStages) }, revenueByProduct: { labels: Object.keys(revenueByProduct), data: Object.values(revenueByProduct) } };
        const finalData = { header: { name: currentUserInfo[0], points: currentUserInfo[5] || 0, rank: myRankInfo ? myRankInfo.rank : 'N/A', totalAgents: leaderboard.length }, kpis: { myRevenue: myRevenue.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), myCommission: myCommission.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), avgDealSize: avgDealSize.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), quotaProgress: quotaProgress.toFixed(1) }, tasks: tasks, history: history, chartData: chartData, leaderboard: leaderboard };

        return { statusCode: 200, body: JSON.stringify(finalData) };

    } catch (error) {
        console.error('--- [DEBUG] CRITICAL ERROR IN FUNCTION ---:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to retrieve dashboard data.', details: error.message }) };
    }
};
