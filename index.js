const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Constants
const PORT = process.env.PORT || 3000;
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// Initialize OAuth2 client
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI ||
    "https://meet-link-api.vercel.app/api/oauth2callback"
);

// Helper function to create Google Meet event
async function createGoogleMeet(
  summary,
  description,
  startTime,
  endTime,
  attendees
) {
  const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

  const event = {
    summary,
    description,
    start: {
      dateTime: new Date(startTime).toISOString(),
      timeZone: "UTC",
    },
    end: {
      dateTime: new Date(endTime).toISOString(),
      timeZone: "UTC",
    },
    conferenceData: {
      createRequest: {
        requestId: `meet-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
    attendees: attendees.map((email) => ({ email })),
  };

  try {
    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
      conferenceDataVersion: 1,
    });
    return response.data.hangoutLink;
  } catch (error) {
    console.error("Error creating meeting:", error);
    throw new Error(`Error creating meeting: ${error.message}`);
  }
}

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "OK", message: "Server is running" });
});

// OAuth2 login endpoint
app.get("/api/login", (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
  res.redirect(authUrl);
});

// OAuth2 callback endpoint
app.get("/api/oauth2callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: "Authorization code is required" });
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Store tokens in environment variable
    process.env.GOOGLE_TOKENS = JSON.stringify(tokens);

    res.send("Authentication successful! You can close this window.");
  } catch (error) {
    console.error("Error retrieving access token:", error);
    res.status(500).json({ error: "Failed to retrieve access token" });
  }
});

// Create meeting endpoint
app.post("/api/create-meeting", async (req, res) => {
  const { summary, description, startTime, endTime, attendees } = req.body;

  // Validate required fields
  if (!summary || !startTime || !endTime || !attendees) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["summary", "startTime", "endTime", "attendees"],
    });
  }

  // Check authentication
  const tokens = process.env.GOOGLE_TOKENS;
  if (!tokens) {
    return res
      .status(401)
      .json({ error: "Not authenticated. Please login first." });
  }

  try {
    // Set credentials from environment variable
    oAuth2Client.setCredentials(JSON.parse(tokens));

    const meetingLink = await createGoogleMeet(
      summary,
      description,
      startTime,
      endTime,
      attendees
    );

    res.json({ meetingLink });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// Start server only in development
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("Available endpoints:");
    console.log("- GET  /api/health         : Health check");
    console.log("- GET  /api/login          : Start OAuth2 flow");
    console.log("- GET  /api/oauth2callback  : OAuth2 callback URL");
    console.log("- POST /api/create-meeting  : Create a new Google Meet");
  });
}

// Export for Vercel
module.exports = app;
