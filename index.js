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
if (!mongoUrl) {
  throw new Error("MONGODB_URI environment variable is required");
}

let db;

async function connectToMongo() {
  try {
    const client = await MongoClient.connect(mongoUrl, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
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
    res.status(500).json({
      error: "Database connection error",
      message: "Could not connect to database",
      details: error.message,
    });
  }
}

// Apply database middleware to all routes except health check
app.use(/^(?!\/api\/health).*$/, ensureDbConnection);

// Validate required environment variables
const requiredEnvVars = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "REDIRECT_URI",
];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    throw new Error(`${varName} environment variable is required`);
  }
});

// Initialize OAuth2 client
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

function isTokenExpired(tokens) {
  if (!tokens || !tokens.expiry_date) {
    return true;
  }
  return Date.now() >= tokens.expiry_date - 5 * 60 * 1000;
}

// Input validation middleware
function validateMeetingInput(req, res, next) {
  const { summary, startTime, endTime, attendees, authCode } = req.body;

  if (!summary || !startTime || !endTime || !attendees || !authCode) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["summary", "startTime", "endTime", "attendees", "authCode"],
    });
  }

  // Validate date formats
  if (!Date.parse(startTime) || !Date.parse(endTime)) {
    return res.status(400).json({
      error: "Invalid date format",
      message: "startTime and endTime must be valid dates",
    });
  }

  // Validate attendees is an array of email addresses
  if (
    !Array.isArray(attendees) ||
    !attendees.every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  ) {
    return res.status(400).json({
      error: "Invalid attendees format",
      message: "attendees must be an array of valid email addresses",
    });
  }

  next();
}

async function createGoogleMeet(
  summary,
  description,
  startTime,
  endTime,
  attendees
) {
  try {
    const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const event = {
      summary,
      description,
      start: {
        dateTime: new Date(startTime).toISOString(),
        timeZone,
      },
      end: {
        dateTime: new Date(endTime).toISOString(),
        timeZone,
      },
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}-${Math.random()
            .toString(36)
            .substr(2, 9)}`,
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

    if (!response.data.hangoutLink) {
      throw new Error("Failed to generate Google Meet link");
    }

    return response.data.hangoutLink;
  } catch (error) {
    console.error("Error creating meeting:", error);
    throw new Error(`Failed to create meeting: ${error.message}`);
  }
}

// Routes
app.get("/", (req, res) => {
  res.send("<h1>Google Calendar API Integration Service</h1>");
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "Server is running",
    mongoStatus: db ? "Connected" : "Not Connected",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || "1.0.0",
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

    // Store tokens in MongoDB
    await db.collection("tokens").updateOne(
      { userId: "default-user" },
      {
        $set: {
          tokens,
          lastUpdated: new Date(),
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.send("Authentication successful! You can now create meetings.");
  } catch (error) {
    console.error("Error retrieving access token:", error);
    res.status(500).json({
      error: "Failed to retrieve access token",
      details: error.message,
    });
  }
});

app.post("/api/create-meeting", validateMeetingInput, async (req, res) => {
  const { summary, description, startTime, endTime, attendees, authCode } =
    req.body;

  try {
    const { tokens } = await oAuth2Client.getToken(authCode);
    oAuth2Client.setCredentials(tokens);

    const meetLink = await createGoogleMeet(
      summary,
      description,
      startTime,
      endTime,
      attendees
    );

    res.json({
      success: true,
      meetLink,
      meeting: {
        summary,
        startTime,
        endTime,
        attendees,
      },
    });
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
    console.error("Error checking token status:", error);
    res.status(500).json({
      error: "Failed to check token status",
      details: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// Initial database connection
if (process.env.NODE_ENV !== "test") {
  connectToMongo()
    .then(() => {
      console.log("Initial database connection established");
      if (process.env.NODE_ENV !== "production") {
        app.listen(PORT, () => {
          console.log(`Server running on http://localhost:${PORT}`);
        });
      }
    })
    .catch((error) => {
      console.error("Failed to establish initial database connection:", error);
      process.exit(1);
    });
}

module.exports = app;
