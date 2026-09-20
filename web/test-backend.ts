import { evaluateRisk } from "./src/api/guardian.js";
import { connectDatabases } from "./src/memory/db.js";
import { verifyAnsIdentity } from "./src/ans/godaddy.js";
import { config } from "./src/config.js";

async function runTests() {
  console.log("=== Testing Backend Integrations ===");
  
  console.log("\n--- Phase 3: DB Connections ---");
  try {
    await connectDatabases();
  } catch (err) {
    console.error("DB Connection Error:", err);
  }

  console.log("\n--- Phase 1: GoDaddy ANS ---");
  const testAns = `ans://v1.0.0.test.${config.ansTeamDomain}`;
  const result1 = await verifyAnsIdentity(testAns);
  console.log(`ANS Verification Result for ${testAns}: ${result1.status}`);
  
  // Test cache
  const result2 = await verifyAnsIdentity(testAns);
  console.log(`ANS Cached Verification Result: ${result2.status}`);

  console.log("\n--- Phase 2: Guardian Twilio Alert ---");
  console.log("Triggering simulated emergency...");
  const result = await evaluateRisk(
    { timestampMs: Date.now(), impactScore: 95 }, 
    { sceneDescription: "Living room, user on floor", hasPeople: false },
    testAns
  );
  
  console.log("Guardian Result:", result);
  
  console.log("\n=== Test Complete ===");
}

runTests().catch(console.error);
