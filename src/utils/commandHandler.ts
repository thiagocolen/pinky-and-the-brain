import fs from 'fs';
import path from 'path';
import { log } from './logger.js';

export interface CommandResponse {
    role: 'system' | 'agent';
    text: string;
}

export const handleCommand = (text: string, brainPath: string): CommandResponse | null => {
    const parts = text.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (command) {
        case '/help':
            return getHelp(brainPath);
        case '/agents':
            return getItems(brainPath, 'agents', args[0]);
        case '/skills':
            return getItems(brainPath, 'skills', args[0]);
        case '/run':
            if (args.length === 0) {
                return { role: 'system', text: 'Usage: /run <skill/agent> [args...]' };
            }
            // /run is special; it returns null here so the hook knows to send a prompt to the AI
            return null;
        default:
            if (command.startsWith('/')) {
                return { role: 'system', text: `Unknown command: ${command}. Type /help for available commands.` };
            }
            return null;
    }
};

const getHelp = (brainPath: string): CommandResponse => {
    let helpText = '\n';
    helpText += '/help - show this help message\n';
    helpText += '/agents - list all agents\n';
    helpText += '/skills - list all skills\n';
    helpText += '/agents <agent> - show agent details\n';
    helpText += '/skills <skill> - show skill details\n';
    helpText += '/run <skill/agent> [args...] - run skill or agent with arguments\n';

    return { role: 'system', text: helpText };
};

const getItems = (brainPath: string, type: 'agents' | 'skills', target?: string): CommandResponse => {
    const dirPath = path.join(brainPath, type);

    if (!fs.existsSync(dirPath)) {
        return { role: 'system', text: `Knowledge base directory not found: ${type}` };
    }

    if (target) {
        const itemDir = path.join(dirPath, target);
        const fileName = type === 'agents' ? 'AGENT.md' : 'SKILL.md';
        const filePath = path.join(itemDir, fileName);

        if (fs.existsSync(filePath)) {
            return { role: 'agent', text: fs.readFileSync(filePath, 'utf8') };
        } else {
            return { role: 'system', text: `${type.slice(0, -1)} "${target}" not found or missing ${fileName}.` };
        }
    }

    const items = fs.readdirSync(dirPath).filter(f => fs.lstatSync(path.join(dirPath, f)).isDirectory());
    if (items.length === 0) {
        return { role: 'system', text: `No ${type} found in knowledge base.` };
    }

    let listText = `### Available ${type.charAt(0).toUpperCase() + type.slice(1)}:\n\n`;
    items.forEach(item => {
        const fileName = type === 'agents' ? 'AGENT.md' : 'SKILL.md';
        const filePath = path.join(dirPath, item, fileName);
        let description = '';

        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            // Try to extract the first non-header line as a description
            const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
            if (lines.length > 0) {
                description = ` - ${lines[0]}`;
            }
        }
        listText += `* **${item}**${description}\n`;
    });

    return { role: 'system', text: listText };
};
