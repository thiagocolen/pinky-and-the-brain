import React from 'react';
import { Box, Text } from 'ink';
import { useGeminiServer } from '../hooks/useGeminiServer.js';
import { StatusDashboard } from './StatusDashboard.js';
import { ChatHistory } from './ChatHistory.js';
import { ChatInput } from './ChatInput.js';
import { BrainAnimation } from './BrainAnimation.js';
import { FooterStatus } from './FooterStatus.js';

interface AppProps {
    initialCommand?: string;
}

export const App: React.FC<AppProps> = ({ initialCommand }) => {
    const { status, messages, error, sendMessage } = useGeminiServer();
    const hasSentInitialCommand = React.useRef(false);

    React.useEffect(() => {
        if (initialCommand && status === 'ready' && !hasSentInitialCommand.current) {
            hasSentInitialCommand.current = true;
            sendMessage(initialCommand);
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

    return (
        <Box flexDirection="column" minHeight={rows}>
            {/* Header */}
            <Box paddingX={1} marginBottom={1}>
                <StatusDashboard status={status} error={error} />
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
