import React from 'react';
import { Box, Text } from 'ink';
import { useGeminiServer } from '../hooks/useGeminiServer.js';
import { StatusDashboard } from './StatusDashboard.js';
import { ChatHistory } from './ChatHistory.js';
import { ChatInput } from './ChatInput.js';
import { BrainAnimation } from './BrainAnimation.js';
import { FooterStatus } from './FooterStatus.js';

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AppProps {
    initialCommand?: string;
}

export const App: React.FC<AppProps> = ({ initialCommand }) => {
    const { status, messages, error, sendMessage } = useGeminiServer();
    const hasSentInitialCommand = React.useRef(false);

    React.useEffect(() => {
        if (status === 'ready' && !hasSentInitialCommand.current) {
            hasSentInitialCommand.current = true;
            if (initialCommand) {
                sendMessage(initialCommand);
            } else {
                sendMessage("/help");
            }
        }
    }, [initialCommand, status, sendMessage]);

    // Auto-exit after initial command is processed
    React.useEffect(() => {
        if (initialCommand && hasSentInitialCommand.current && status === 'ready') {
            // Wait a bit for the last chunk to be rendered
            const timer = setTimeout(() => {
                process.exit(0);
            }, 2000);
            return () => clearTimeout(timer);
        }
    }, [initialCommand, status]);

    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;

    const isTTY = process.stdin.isTTY;

    const workspace = process.cwd();
    const branch = 'feature/layout-fix'; // Mocked for now
    const sandbox = 'no sandbox';
    const model = 'Auto (The Brain 1.0-mini)';

    const version = React.useMemo(() => {
        try {
            const pkgPath = (process as any).pkg 
                ? path.resolve(__dirname, '..', 'package.json')
                : path.resolve(process.cwd(), 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                return pkg.version;
            }
        } catch (e) {
            // silent fail
        }
        return '0.0.0';
    }, []);

    return (
        <Box flexDirection="column" minHeight={rows}>
            {/* Header */}
            <Box paddingX={1} marginBottom={1}>
                <StatusDashboard status={status} error={error} version={version} />
            </Box>

            {/* Chat History / Content area */}
            <Box flexDirection="column" flexGrow={1} paddingX={1}>
                <ChatHistory messages={messages} />
                {status === 'processing' && <BrainAnimation />}
            </Box>

            {/* Footer Area */}
            <Box flexDirection="column">
                <Text dimColor>{"─".repeat(cols)}</Text>
                
                <Box justifyContent="space-between" paddingX={1}>
                    <Text dimColor>auto-accept edits Shift+Tab to plan</Text>
                    <Text dimColor>1 GEMINI.md file</Text>
                </Box>

                <Text>{"▀".repeat(cols)}</Text>
                
                <Box paddingX={1}>
                    <Text color="green"> {'>'} </Text>
                    {isTTY ? (
                        <ChatInput isDisabled={status !== 'ready'} onSendMessage={sendMessage} />
                    ) : (
                        <Text dimColor italic>{initialCommand ? `Executing: ${initialCommand}` : "Interactive mode requires a TTY."}</Text>
                    )}
                </Box>

                <Text>{"▄".repeat(cols)}</Text>

                <FooterStatus 
                    workspace={workspace}
                    branch={branch}
                    sandbox={sandbox}
                    model={model}
                />
            </Box>
        </Box>
    );
};
