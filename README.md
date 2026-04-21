# Pinky and the Brain - Gemini CLI Wrapper

Welcome to the digital conquest of the world! **Pinky and the Brain** is a specialized agent interface built on top of the [Gemini CLI](https://github.com/google/gemini-cli). It provides a unique, themed environment where "The Brain" (your tactical AI leader) and "Pinky" (his enthusiastic assistant) help you navigate complex tasks using advanced agents, skills, and tools.

> "Gee, Brain, what do you want to do tonight?"  
> "The same thing we do every night, Pinky - try to take over the world!"

---

## 🧠 What is this project?

This project is a secure, interactive wrapper for the Gemini CLI. It transforms the standard CLI experience into a collaborative mission.

- **The Brain**: A highly capable agent with access to a specialized knowledge base. He understands the architecture, the mission objectives, and how to utilize every tool at his disposal.
- **Pinky**: (Working through the Gemini CLI interface) Assists in the execution of tasks, often with a unique flair.

The application uses the **Agent Client Protocol (ACP)** to communicate with the Gemini CLI, allowing for a seamless integration of thought processes, tool usage, and terminal interactions.

---

## 🛠 Features

### Agents & Skills

- **The Brain Agent**: Automatically initialized with deep knowledge of the system.
- **Specialized Skills**: Custom logic sets (located in the `the-brain` folder) that extend the AI's capabilities for specific domains.
- **Thought Visualization**: See "The Brain"'s internal reasoning as he plans his next move.

### Tools & Commands

- **Filesystem Access**: Read and write files securely within your workspace.
- **Terminal Integration**: Execute commands and see real-time output within the themed dashboard.
- **ACP Support**: Fully compliant with the latest Gemini CLI protocols.

---

## 🚀 How to Use

### 1. Prerequisites

You must have the **Gemini CLI** installed and configured on your system.

```bash
npm install -g @google/gemini-cli
# or download the latest binary from their repository
```

Ensure you have run `gemini --login` to authenticate.

### 2. Installation

Since this is a standalone release, no source code installation is required:

1. **Download** the `brain-win.exe` file from the releases page.
2. **Add to PATH**:
   - Move the `.exe` to a folder of your choice (e.g., `C:\tools\brain`).
   - Add this folder to your System Environment Variables under the `Path` variable.
3. **Open Terminal**: Open PowerShell, Command Prompt, or any modern terminal.

### 3. Launching the Mission

Run the following command to start the application:

```bash
brain-win
```

### 4. Interacting with The Brain

Once the dashboard opens, you can talk directly to The Brain. To understand the full extent of his power, try asking:

- _"What are your available skills?"_
- _"List the agents you can deploy."_
- _"Show me the tools I can use for this project."_
- _"What prompts are available in your knowledge base?"_

The Brain will use his filesystem tools to explore his internal `the-brain` folder and provide you with a detailed report of everything he knows.

---

## 📂 The Knowledge Base

When running the `.exe`, the application includes a built-in knowledge base. "The Brain" is specifically instructed to use this data to help you. It contains:

- **Agents**: Definitions for specialized sub-agents.
- **Skills**: Advanced workflows for specific tasks.
- **Tools**: Descriptions of what the system can do.
- **Prompts**: Pre-defined templates for high-quality AI results.

---

## ⚠️ Important Note

This is a standalone release. To ensure security, the application uses a secure wrapper around the Gemini CLI. Your API keys and credentials are never stored or transmitted by this wrapper; they remain safely managed by your local Gemini CLI configuration.
