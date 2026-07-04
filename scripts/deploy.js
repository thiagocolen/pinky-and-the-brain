import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const terraformDir = path.join(projectRoot, "terraform");

// Load environment variables from .env if present
const envPath = path.join(projectRoot, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

console.log("🚀 Starting App Runner Deployment Process...");

try {
  // 1. Initialize Terraform
  console.log("\n1. Initializing Terraform...");
  execSync("terraform init", { cwd: terraformDir, stdio: "inherit" });

  // 2. Provision ECR Repository first (Targeted Apply for Bootstrapping)
  console.log("\n2. Provisioning ECR Repository...");
  let baseVars = "";
  if (process.env.LANGCHAIN_TRACING_V2) {
    baseVars += ` -var="langchain_tracing_v2=${process.env.LANGCHAIN_TRACING_V2}"`;
  }
  if (process.env.LANGCHAIN_API_KEY) {
    baseVars += ` -var="langchain_api_key=${process.env.LANGCHAIN_API_KEY}"`;
  }
  if (process.env.LANGCHAIN_PROJECT) {
    baseVars += ` -var="langchain_project=${process.env.LANGCHAIN_PROJECT}"`;
  }

  execSync(`terraform apply -target=aws_ecr_repository.agent_server -auto-approve${baseVars}`, {
    cwd: terraformDir,
    stdio: "inherit"
  });

  // 3. Retrieve ECR URL from Terraform output
  console.log("\n3. Retrieving ECR URL...");
  const ecrUrlBuffer = execSync("terraform output -raw ecr_repository_url", { cwd: terraformDir });
  const ecrUrl = ecrUrlBuffer.toString().trim();
  if (!ecrUrl) {
    throw new Error("Could not retrieve ECR repository URL from Terraform outputs.");
  }
  console.log(`ECR Repository URL: ${ecrUrl}`);

  // 4. Build TypeScript and Docker Image
  console.log("\n4. Compiling TS files...");
  execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });

  console.log("\n5. Building Docker Image...");
  execSync("docker build -t pinky-and-the-brain-agents-server .", { cwd: projectRoot, stdio: "inherit" });

  // 5. Authenticate with ECR and push image
  console.log("\n6. Logging in to AWS ECR...");
  
  // Extract region and registry domain dynamically from ECR URL
  // ecrUrl format: <account-id>.dkr.ecr.<region>.amazonaws.com/<repository-name>
  const ecrMatch = ecrUrl.match(/^([^.]+)\.dkr\.ecr\.([^.]+)\.amazonaws\.com/);
  if (!ecrMatch) {
    throw new Error(`Failed to parse region and registry from ECR URL: ${ecrUrl}`);
  }
  const registry = `${ecrMatch[1]}.dkr.ecr.${ecrMatch[2]}.amazonaws.com`;
  const region = ecrMatch[2];

  execSync(`aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`, {
    stdio: "inherit"
  });

  console.log("\n7. Pushing image to ECR...");
  execSync(`docker tag pinky-and-the-brain-agents-server:latest ${ecrUrl}:latest`, { stdio: "inherit" });
  execSync(`docker push ${ecrUrl}:latest`, { stdio: "inherit" });

  // 6. Complete Terraform Apply (Provision App Runner Service)
  console.log("\n8. Provisioning App Runner Service...");
  execSync(`terraform apply -auto-approve${baseVars}`, { cwd: terraformDir, stdio: "inherit" });

  console.log("\n✔ App Runner Deployment completed successfully!");
} catch (error) {
  console.error("\n❌ Deployment failed:", error.message);
  process.exit(1);
}
