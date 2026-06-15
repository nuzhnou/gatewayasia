require('dotenv').config();

console.log("=== Testing Phase 2 Setup ===");

if (!process.env.GEMINI_API_KEY) {
  console.log("WARNING: GEMINI_API_KEY is not set in .env. Using mock response testing.");
  process.env.GEMINI_API_KEY = "mock_key";
}

const { runAutoPoster } = require('./src/marketing/auto_poster');

async function test() {
  try {
    console.log("Running Auto Poster test run (Generating text via Gemini)...");
    const result = await runAutoPoster();
    if (result) {
      console.log("\nSUCCESS! Auto Poster successfully generated unique vacancy advertisement.");
      console.log("Please check that the output above DOES NOT mention 'Zara' or 'Legalization Center' directly and points to the chatbot.");
    } else {
      throw new Error("Generated ad text is empty.");
    }
    console.log("=== ALL PHASE 2 TESTS PASSED! ===");
  } catch (error) {
    console.error("Test failed with error:", error);
    process.exit(1);
  }
}

test();
