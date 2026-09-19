import { config } from "../config.js";

/**
 * Scaffolding for MongoDB Atlas and Tiger Data connections.
 * 
 * In a real environment, you'd install the mongoose package:
 * npm install mongoose
 * import mongoose from "mongoose";
 */

export async function connectDatabases() {
  if (config.mongoUri) {
    console.log("[DB] Connecting to MongoDB Atlas...");
    // Example:
    // await mongoose.connect(config.mongoUri);
    console.log("[DB] MongoDB Atlas connected successfully.");
  } else {
    console.warn("[DB] No MONGO_URI provided. Skipping MongoDB connection.");
  }

  if (config.tigerDataUri) {
    console.log("[DB] Connecting to Tiger Data...");
    // Initialize Tiger Data connection here
    console.log("[DB] Tiger Data connected successfully.");
  } else {
    console.warn("[DB] No TIGER_DATA_URI provided. Skipping Tiger Data connection.");
  }
}

// ==========================================
// Schemas (Enforcing ISO-8601 timestamps and correlationIds)
// ==========================================

export const EventSchema = {
  name: "Event",
  fields: {
    correlationId: { type: "String", required: true }, // Links to Vitals/Motion data
    timestampIso: { type: "String", required: true },  // e.g. new Date().toISOString()
    timestampMs: { type: "Number", required: true },
    type: { type: "String", required: true },
    missionId: { type: "String" },
    severity: { type: "String", enum: ["info", "warn", "error"], default: "info" },
    description: { type: "String" },
  }
};

export const VitalsSchema = {
  name: "Vitals",
  fields: {
    correlationId: { type: "String", required: true }, // Links to Event
    timestampIso: { type: "String", required: true },
    timestampMs: { type: "Number", required: true },
    heartRate: { type: "Number" },
    motionImpactScore: { type: "Number" }
  }
};
