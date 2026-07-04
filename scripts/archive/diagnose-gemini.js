import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("❌ GOOGLE_API_KEY environment variable is not set.");
  process.exit(1);
}

async function diagnose() {
  console.log("Starting diagnosis for GOOGLE_API_KEY...");
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const response = await axios.get(url);
    const models = response.data.models || [];
    console.log(`\n✅ API Call Successful! Found ${models.length} models:`);
    
    const generateModels = models.filter(m => 
      m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")
    );
    
    console.log("\nModels supporting 'generateContent':");
    generateModels.forEach(m => {
      console.log(` - Name: ${m.name} (${m.displayName})`);
    });
  } catch (error) {
    console.error("❌ API Call Failed!");
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error("Data:", JSON.stringify(error.response.data, null, 2));
    } else {
      console.error("Error:", error.message);
    }
  }
}

diagnose();
