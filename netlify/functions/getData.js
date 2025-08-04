const { google } = require('googleapis');

// Main function that Netlify will run
exports.handler = async (event) => {
    try {
        // Authenticate with Google Sheets API
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        // Get the spreadsheet ID from environment variables
        const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

        // Get user email from the request URL (e.g., /api/getData?user=john@evokia.com)
        const userEmail = event.queryStringParameters.user?.toLowerCase();
        if (!userEmail) {
            throw new Error("User email is required.");
        }

        // --- Fetch all data from sheets in parallel ---
        const ranges = [
            'Sales_Agents!A:F', 'Sales_Log!A:F', 'Gamification_Tasks!A:E',
            'Agent_Activity_Log!A:D', 'Sales_Pipeline!A:F'
        ];
        const response = await sheets.spreadsheets.values.batchGet({
            spreadsheetId: SPREADSHEET_ID,
            ranges: ranges,
        });

        const [
            agentsData, salesLogData, tasksData,
            activityLogData, pipelineData
        ] = response.data.valueRanges.map(range => range.values ? range.values.slice(1) : []); // .slice(1) to skip headers
        
        // --- Process the data (logic copied from our old Code.gs) ---
        const allAgents = agentsData.map(row => [row[0], row[1], row[2], row[3], Number(row[4] || 0), Number(row[5] || 0)]);
        const currentUserInfo = allAgents.find(agent => agent[1] && agent[1].toLowerCase() === userEmail);
        if (!currentUserInfo) {
            throw new Error("User not found in agent list.");
        }

        const salesLog = salesLogData.map(r => [new Date(r[0]), r[1], r[2], r[3], Number(r[4]), Number(r[5])]);
        const pipeline = pipelineData.map(r => [r[0], r[1], r[2], Number(r[3]), r[4], new Date(r[5])]);
        const activityLog = activityLogData.map(r => [new Date(r[0]), r[1], r[2], Number(r[3])]);
        
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const mySalesThisMonth = salesLog.filter(sale => sale[1] && sale[1].toLowerCase() === userEmail && sale[0] >= startOfMonth);
        const myRevenue = mySalesThisMonth.reduce((sum, sale) => sum + sale[4], 0);
        const myCommission = mySalesThisMonth.reduce((sum, sale) => sum + (sale[4] * sale[5]), 0);
        const dealsClosed = mySalesThisMonth.length;
        const avgDealSize = dealsClosed > 0 ? myRevenue / dealsClosed : 0;
        const myQuota = currentUserInfo[4] || 0;
        const quotaProgress = myQuota > 0 ? (myRevenue / myQuota) * 100 : 0;

        const leaderboard = allAgents.filter(a => a[2] === 'Agent').map(a => ({ name: a[0], team: a[3], points: a[5] || 0 })).sort((a,b) => b.points - a.points).map((a,i) => ({...a, rank: i+1}));
        const myRankInfo = leaderboard.find(agent => agent.name === currentUserInfo[0]);

        // ... Add logic for tasks, history, chartData here if needed, simplified for clarity ...
        
        // --- Package the final data object ---
        const finalData = {
             header: { name: currentUserInfo[0], points: currentUserInfo[5] || 0, rank: myRankInfo ? myRankInfo.rank : 'N/A', totalAgents: leaderboard.length },
             kpis: { myRevenue: myRevenue.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), myCommission: myCommission.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), avgDealSize: avgDealSize.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }), quotaProgress: quotaProgress.toFixed(1) },
             leaderboard: leaderboard,
             // ... Add other data pieces (tasks, history, chartData) here ...
        };

        return {
            statusCode: 200,
            body: JSON.stringify(finalData),
        };

    } catch (error) {
        console.error('Error fetching sheet data:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to retrieve dashboard data.', details: error.message }),
        };
    }
};