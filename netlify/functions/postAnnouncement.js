const { google } = require('googleapis');

exports.handler = async (event, context) => {
    // 1. Check for authenticated user (SECURITY)
    const user = context.clientContext && context.clientContext.user;
    if (!user) {
        return { statusCode: 401, body: JSON.stringify({ error: 'You must be logged in to perform this action.' }) };
    }

    // 2. Check if the request method is POST
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const userEmail = user.email.toLowerCase();

        // 3. Setup Google Sheets API client
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'], // Allows writing
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

        // 4. Verify the user has the 'HR' role (AUTHORIZATION)
        const agentSheetResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sales_Agents!A:C',
        });
        const allAgentsRaw = (agentSheetResponse.data.values || []).slice(1);
        const currentUserInfo = allAgentsRaw.find(agent => agent[1] && agent[1].toLowerCase() === userEmail);

        if (!currentUserInfo || currentUserInfo[2] !== 'HR') {
            return { statusCode: 403, body: JSON.stringify({ error: 'You do not have permission to post announcements.' }) };
        }

        // 5. Get the title and message from the incoming request
        const { title, message } = JSON.parse(event.body);
        if (!title || !message) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Title and message are required.' }) };
        }

        // 6. Append the new row to the HR_Announcements sheet
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'HR_Announcements!A:E', // Corrected range to include Audience
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [
                    // THE FIX IS HERE: Use new Date() directly
                    [new Date(), userEmail, title, message, 'All']
                ],
            },
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Announcement posted successfully.' }),
        };

    } catch (error) {
        console.error('Error in postAnnouncement function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to post announcement.', details: error.message }),
        };
    }
};
