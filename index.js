const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Constants
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];
const TOKEN_PATH = "token.json";
const PORT = process.env.PORT || 3000;

// Initialize OAuth2 client
let oAuth2Client;

try {
  const credentials = JSON.parse(fs.readFileSync("credentials.json"));
  const { client_secret, client_id } = credentials;

  oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    "http://localhost:3000/oauth2callback"
  );

  // Load existing token if it exists
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);
  }
} catch (error) {
  console.error("Error loading credentials:", error);
  process.exit(1);
}

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

// Routes
app.get("/login", (req, res) => {
  if (!oAuth2Client) {
    return res.status(500).send("OAuth2 client not initialized");
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  res.redirect(authUrl);
});

app.get("/oauth2callback", async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("No authorization code received");
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Save token for future use
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));

    res.send("Authentication successful! You can close this window.");
  } catch (error) {
    console.error("Error retrieving access token:", error);
    res.status(500).send("Error retrieving access token");
  }
});

app.post("/create-meeting", async (req, res) => {
  const { summary, description, startTime, endTime, attendees } = req.body;

  if (!summary || !startTime || !endTime || !attendees) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["summary", "startTime", "endTime", "attendees"],
    });
  }

  try {
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

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log("Available endpoints:");
  console.log("- GET  /login           : Start OAuth2 flow");
  console.log("- GET  /oauth2callback   : OAuth2 callback URL");
  console.log("- POST /create-meeting   : Create a new Google Meet");
});
