import dotenv from "dotenv";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage } from "@langchain/core/messages";

dotenv.config();

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("❌ GOOGLE_API_KEY environment variable is not set.");
  process.exit(1);
}

async function testModel() {
  console.log("Testing ChatGoogleGenerativeAI with gemini-2.5-flash...");
  try {
    const model = new ChatGoogleGenerativeAI({
      apiKey: apiKey,
      model: "gemini-2.5-flash",
      temperature: 0.5,
    });

    const response = await model.invoke([
      new HumanMessage("Hello! Say 'Gemini 2.5 Flash is working!' if you read this.")
    ]);

    console.log("\n✅ Response received successfully:");
    console.log(response.content);
  } catch (error) {
    console.error("❌ Model invocation failed!");
    console.error("Error message:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

testModel();
