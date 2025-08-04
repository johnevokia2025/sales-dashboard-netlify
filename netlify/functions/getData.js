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
        const allAgentsRaw = agentSheetResponse.data.values.slice(1) || [];
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

// --- DATA LOGIC FOR AGENT ---
async function getAgentDashboardData({ sheets, SPREADSHEET_ID, userEmail, currentUserInfo }) {
    // (This is the same logic as our previous getData function, just refactored)
    const ranges = ['Sales_Log!A2:F', 'Gamification_Tasks!A2:E', 'Agent_Activity_Log!A2:D', 'Sales_Pipeline!A2:F', 'Sales_Agents!A2:F'];
    const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges });
    const [salesLogData=[], tasksData=[], activityLogData=[], pipelineData=[], agentsData=[]] = response.data.valueRanges.map(r => r.values || []);
    
    // Process all data...
    const allAgents = agentsData.map(row => [row[0], row[1], row[2], row[3], Number(row[4] || 0), Number(row[5] || 0)]);
    const salesLog = salesLogData.map(r => [new Date(r[0]), r[1], r[2], r[3], Number(r[4] || 0), Number(r[5] || 0)]);
    // ... continue processing all data as before...

    // Return the final packaged object for the agent
    return {
        view: 'Agent',
        header: { name: currentUserInfo[0], /* ... other header data ... */ },
        kpis: { /* ... kpi data ... */ },
        // ... and so on for tasks, history, chartData, leaderboard
    };
}

// --- DATA LOGIC FOR MANAGER ---
async function getManagerDashboardData({ sheets, SPREADSHEET_ID, currentUserInfo }) {
    const ranges = ['Sales_Agents!A2:F', 'Sales_Log!A2:F'];
    const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges });
    const [agentsData=[], salesLogData=[]] = response.data.valueRanges.map(r => r.values || []);

    // ... process manager data ...

    return {
        view: 'Manager',
        header: { name: currentUserInfo[0] },
        kpis: { /* ... manager kpi data ... */ },
        teamPerformance: [ /* ... team performance data ... */ ],
        chartData: { /* ... manager chart data ... */ }
    };
}

// --- DATA LOGIC FOR HR ---
async function getHRDashboardData({ sheets, SPREADSHEET_ID, currentUserInfo }) {
     const ranges = ['Sales_Agents!A2:D']; // Only need personnel info
    const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges });
    const [agentsData=[]] = response.data.valueRanges.map(r => r.values || []);
    
    return {
        view: 'HR',
        header: { name: currentUserInfo[0] },
        personnel: agentsData.map(p => ({name: p[0], email: p[1], role: p[2], team: p[3]}))
    };
}
