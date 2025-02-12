const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Constants
const PORT = process.env.PORT || 3000;
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

// MongoDB setup
const mongoUrl = process.env.MONGODB_URI;
let db;

async function connectToMongo() {
  try {
    const client = await MongoClient.connect(mongoUrl);
    db = client.db("googleAuth");
    console.log("Connected to MongoDB");
    return db;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw error;
  }
}

// Middleware to ensure database connection
async function ensureDbConnection(req, res, next) {
  try {
    if (!db) {
      await connectToMongo();
    }
    next();
  } catch (error) {
    console.error("Database connection error:", error);
    return res.status(500).json({
      error: "Database connection error",
      message: "Could not connect to database",
      details: error.message,
    });
  }
}

app.use(/^(?!\/api\/health).*$/, ensureDbConnection);

// Initialize OAuth2 client
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI ||
    "https://meet-link-api.vercel.app/api/oauth2callback"
);

function isTokenExpired(tokens) {
  return Date.now() >= tokens.expiry_date - 5 * 60 * 1000;
}

// Helper function to create Google Meet event
async function createGoogleMeet(
  summary,
  description,
  startTime,
  endTime,
  attendees
) {
  try {
    const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

    const event = {
      summary,
      description,
      start: {
        dateTime: new Date(startTime).toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      end: {
        dateTime: new Date(endTime).toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
      attendees: attendees.map((email) => ({ email })),
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 24 * 60 },
          { method: "popup", minutes: 10 },
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: "all",
    });

    return response.data.hangoutLink;
  } catch (error) {
    console.error("Error creating meeting:", error);
    throw new Error(`Failed to create meeting: ${error.message}`);
  }
}

app.get("/", (req, res) => {
  res.send("<h1>Working</h1>");
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "Server is running",
    mongoStatus: db ? "Connected" : "Not Connected",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/login", (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
  res.redirect(authUrl);
});

app.get("/api/oauth2callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: "Authorization code is required" });
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    res.send("Authentication successful! You can now create meetings.");
  } catch (error) {
    console.error("Error retrieving access token:", error);
    res.status(500).json({
      error: "Failed to retrieve access token",
      details: error.message,
    });
  }
});

app.post("/api/create-meeting", async (req, res) => {
  const { summary, description, startTime, endTime, attendees, authCode } =
    req.body;

  if (!summary || !startTime || !endTime || !attendees || !authCode) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["summary", "startTime", "endTime", "attendees", "authCode"],
    });
  }

  try {
    // Fetch a new token using the authorization code
    const { tokens } = await oAuth2Client.getToken(authCode);
    oAuth2Client.setCredentials(tokens);

    // Create Google Meet meeting
    const meetLink = await createGoogleMeet(
      summary,
      description,
      startTime,
      endTime,
      attendees
    );

    res.json({ meetLink });
  } catch (error) {
    console.error("Error creating meeting:", error);
    res.status(500).json({
      error: "Failed to create meeting",
      details: error.message,
    });
  }
});

app.get("/api/token-status", async (req, res) => {
  try {
    const tokenDoc = await db
      .collection("tokens")
      .findOne({ userId: "default-user" });
    if (!tokenDoc || !tokenDoc.tokens) {
      return res.json({
        isAuthenticated: false,
        message: "No token found",
        loginUrl: "/api/login",
      });
    }

    const tokens = tokenDoc.tokens;
    res.json({
      isAuthenticated: true,
      isExpired: isTokenExpired(tokens),
      expiresAt: new Date(tokens.expiry_date).toISOString(),
      lastUpdated: tokenDoc.lastUpdated,
      createdAt: tokenDoc.createdAt,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to check token status",
      details: error.message,
    });
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: "Something went wrong!",
    details: err.message,
  });
});

// Initial database connection
connectToMongo()
  .then(() => {
    console.log("Initial database connection established");
    if (process.env.NODE_ENV !== "production") {
      app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
      });
    }
  })
  .catch(console.error);

module.exports = app;
