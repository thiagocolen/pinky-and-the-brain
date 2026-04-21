import React from 'react';
import { Box, Text, Static } from 'ink';
import { type Message } from '../hooks/useGeminiServer.js';

interface ChatHistoryProps {
    messages: Message[];
}

const MessageItem: React.FC<{ msg: Message }> = ({ msg }) => (
    <Box flexDirection="column" marginBottom={1}>
        <Box>
            <Text bold color={
                msg.role === 'user' ? 'green' : 
                (msg.role === 'thought' ? 'gray' : 
                (msg.role === 'system' ? 'yellow' : 'blue'))
            }>
                {
                    msg.role === 'user' ? 'PINKY > ' : 
                    (msg.role === 'thought' ? '[ THOUGHT ] ' : 
                    (msg.role === 'system' ? '[ SYSTEM ] ' : 'BRAIN > '))
                }
            </Text>
            <Text color={msg.role === 'thought' ? 'gray' : 'white'}>
                {msg.text}
            </Text>
        </Box>
    </Box>
);

export const ChatHistory: React.FC<ChatHistoryProps> = ({ messages }) => {
    // We use Static for completed history items to ensure efficient rendering.
    // The last message is rendered outside Static to allow for streaming updates.
    const completedMessages = messages.slice(0, -1);
    const lastMessage = messages[messages.length - 1];

    return (
        <Box flexDirection="column">
            <Static items={completedMessages}>
                {(msg, index) => <MessageItem key={index} msg={msg} />}
            </Static>
            {lastMessage && <MessageItem msg={lastMessage} />}
        </Box>
    );
};
