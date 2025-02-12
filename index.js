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
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}

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
    res.status(500).json({
      error: "Database connection error",
      message: "Could not connect to database",
    });
  }
}

// Apply database middleware to all routes except health check
app.use(/^(?!\/api\/health).*$/, ensureDbConnection);

// Initialize OAuth2 client
let oAuth2Client;
try {
  const requiredEnvVars = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "REDIRECT_URI",
  ];

  const missingVars = requiredEnvVars.filter(
    (varName) => !process.env[varName]
  );
  if (missingVars.length > 0) {
    console.error("Missing required environment variables:", missingVars);
    process.exit(1);
  }

  oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
} catch (error) {
  console.error("Error initializing OAuth2 client:", error);
  process.exit(1);
}

function isTokenExpired(tokens) {
  if (!tokens || !tokens.expiry_date) {
    return true;
  }
  return Date.now() >= tokens.expiry_date - 5 * 60 * 1000;
}

// Input validation middleware
function validateMeetingInput(req, res, next) {
  const { summary, startTime, endTime, attendees } = req.body;

  if (!summary || !startTime || !endTime || !attendees) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["summary", "startTime", "endTime", "attendees"],
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
  attendees,
  auth
) {
  try {
    const calendar = google.calendar({ version: "v3", auth });
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
            .substring(2)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
      attendees: attendees.map((email) => ({ email })),
      reminders: {
        useDefault: true,
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
    throw error;
  }
}

// Session storage for state verification
const stateStore = new Map();

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
  });
});

app.get("/api/login", (req, res) => {
  const state = Math.random().toString(36).substring(2);
  stateStore.set(state, Date.now());

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state: state,
    prompt: "consent",
  });

  res.redirect(authUrl);
});

app.get("/api/oauth2callback", async (req, res) => {
  const { code, state } = req.query;

  if (!state || !stateStore.has(state)) {
    return res.status(400).json({ error: "Invalid state parameter" });
  }

  stateStore.delete(state);

  if (!code) {
    return res.status(400).json({ error: "Authorization code is missing" });
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);

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

    res.redirect("/api/auth-success");
  } catch (error) {
    console.error("Token retrieval error:", error);
    res.redirect("/api/auth-error");
  }
});

app.get("/api/auth-success", (req, res) => {
  res.send("Authentication successful! You can now close this window.");
});

app.get("/api/auth-error", (req, res) => {
  res.status(400).send("Authentication failed. Please try again.");
});

app.post("/api/create-meeting", validateMeetingInput, async (req, res) => {
  const { summary, description, startTime, endTime, attendees } = req.body;

  try {
    const tokenDoc = await db
      .collection("tokens")
      .findOne({ userId: "default-user" });

    if (!tokenDoc || !tokenDoc.tokens) {
      return res
        .status(401)
        .json({ meetLink: null, error: "Authentication required" });
    }

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.REDIRECT_URI
    );

    if (isTokenExpired(tokenDoc.tokens)) {
      try {
        const { credentials } = await auth.refreshToken(
          tokenDoc.tokens.refresh_token
        );
        await db
          .collection("tokens")
          .updateOne(
            { userId: "default-user" },
            { $set: { tokens: credentials, lastUpdated: new Date() } }
          );
        auth.setCredentials(credentials);
      } catch (refreshError) {
        return res
          .status(401)
          .json({ meetLink: null, error: "Session expired" });
      }
    } else {
      auth.setCredentials(tokenDoc.tokens);
    }

    const now = new Date();
    const start = new Date(startTime);
    const minimumStartTime = new Date(now.getTime() + 2 * 60 * 1000);

    if (start < minimumStartTime) {
      return res.status(400).json({
        meetLink: null,
        error: "Start time must be at least 2 minutes from now",
        currentTime: now.toISOString(),
        earliestPossibleStart: minimumStartTime.toISOString(),
      });
    }

    const meetLink = await createGoogleMeet(
      summary,
      description,
      startTime,
      endTime,
      attendees,
      auth
    );

    res.json({ meetLink });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      meetLink: null,
      error: "Failed to create meeting",
      details: error.message,
    });
  }
});

// Cleanup expired states
setInterval(() => {
  const now = Date.now();
  for (const [state, timestamp] of stateStore.entries()) {
    if (now - timestamp > 10 * 60 * 1000) {
      stateStore.delete(state);
    }
  }
}, 5 * 60 * 1000);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message || "Something went wrong",
  });
});

// Start server
if (process.env.NODE_ENV !== "test") {
  connectToMongo()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
      });
    })
    .catch((error) => {
      console.error("Failed to start server:", error);
      process.exit(1);
    });
}

module.exports = app;
