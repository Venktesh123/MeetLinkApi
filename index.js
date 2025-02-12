const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Constants
const PORT = process.env.PORT || 3000;
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// MongoDB setup
const mongoUrl = process.env.MONGODB_URI;
let db;

async function connectToMongo() {
  try {
    const client = await MongoClient.connect(mongoUrl);
    db = client.db("googleAuth");
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("MongoDB connection error:", error);
  }
}

connectToMongo();

// Initialize OAuth2 client
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI ||
    "https://meet-link-api.vercel.app/api/oauth2callback"
);

// Helper function to check token expiration
function isTokenExpired(tokens) {
  return Date.now() >= tokens.expiry_date - 5 * 60 * 1000; // 5 minutes buffer
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

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "Server is running",
    mongoStatus: db ? "Connected" : "Not Connected",
  });
});

// OAuth2 login endpoint
app.get("/api/login", (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    expiry_date: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
  });
  res.redirect(authUrl);
});

// OAuth2 callback endpoint with MongoDB storage
app.get("/api/oauth2callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: "Authorization code is required" });
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    tokens.expiry_date = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days expiry

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

    oAuth2Client.setCredentials(tokens);
    res.send(
      "Authentication successful! Token stored in database. You can close this window."
    );
  } catch (error) {
    console.error("Error retrieving access token:", error);
    res.status(500).json({
      error: "Failed to retrieve access token",
      details: error.message,
    });
  }
});

// Create meeting endpoint with MongoDB token retrieval
app.post("/api/create-meeting", async (req, res) => {
  const { summary, description, startTime, endTime, attendees } = req.body;

  if (!summary || !startTime || !endTime || !attendees) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["summary", "startTime", "endTime", "attendees"],
    });
  }

  try {
    // Get tokens from MongoDB
    const tokenDoc = await db
      .collection("tokens")
      .findOne({ userId: "default-user" });

    if (!tokenDoc || !tokenDoc.tokens) {
      return res.status(401).json({
        error: "Not authenticated",
        message: "Please login first",
        loginUrl: "/api/login",
      });
    }

    const tokens = tokenDoc.tokens;

    // Check if token is expired
    if (isTokenExpired(tokens)) {
      if (tokens.refresh_token) {
        // Refresh the token
        const { credentials } = await oAuth2Client.refreshToken(
          tokens.refresh_token
        );
        const newTokens = {
          ...tokens,
          access_token: credentials.access_token,
          expiry_date: Date.now() + 30 * 24 * 60 * 60 * 1000,
        };

        // Update tokens in MongoDB
        await db.collection("tokens").updateOne(
          { userId: "default-user" },
          {
            $set: {
              tokens: newTokens,
              lastUpdated: new Date(),
            },
          }
        );

        oAuth2Client.setCredentials(newTokens);
      } else {
        return res.status(401).json({
          error: "Token expired",
          message: "No refresh token available. Please login again.",
          loginUrl: "/api/login",
        });
      }
    } else {
      oAuth2Client.setCredentials(tokens);
    }

    const meetingLink = await createGoogleMeet(
      summary,
      description,
      startTime,
      endTime,
      attendees
    );

    res.json({
      meetingLink,
      tokenStatus: {
        expiresAt: new Date(tokens.expiry_date).toISOString(),
        isExpired: isTokenExpired(tokens),
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

// Token status endpoint
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: "Something went wrong!",
    details: err.message,
  });
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
    console.log("- GET  /api/token-status   : Check token status");
  });
}

// Export for Vercel
module.exports = app;
